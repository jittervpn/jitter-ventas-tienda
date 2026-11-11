// Venta del CDN: se valida el pedido ANTES de cobrar y se crea/renueva el servicio DESPUÉS del pago aprobado.
// El pedido viaja en external_reference del pago de Mercado Pago (lo fija el servidor, el cliente no puede cambiarlo):
//   uid:cdn30:n:origen:ruta   -> servicio nuevo
//   uid:cdn30:r:idServicio    -> renovación
import { lookup } from "node:dns/promises";
import { cdn, CAMPOS, listaServicios, mapService, limpiarSlug, rutaDe, esMio, SLUG_RE, origenValido, MAX_POR_CLIENTE, mensaje, operacionId } from "./cdn.js";
import { PLAN_CDN } from "./precios.js";

const ID_RE = /^[\w.-]{3,80}$/;
const err = (status, error, codigo) => ({ status, error, codigo });

async function resuelve(dominio) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(dominio)) return true;
  try { await Promise.race([lookup(dominio), new Promise((_, ko) => setTimeout(() => ko(new Error("timeout")), 4000))]); return true; }
  catch (e) { return e.message === "timeout"; } // si el DNS tarda, no se bloquea la compra (lo valida la API del CDN)
}

/** Valida lo que el cliente quiere comprar. Devuelve {ref, descripcion} o {status, error, codigo}. */
export async function prepararCdn(u, pedido) {
  if (!u || !u.uid || String(u.uid).includes(":")) return err(400, "Cuenta inválida.");
  const p = pedido || {};
  const todos = listaServicios(await cdn("GET", "/v1/services"));
  const mios = todos.filter((s) => esMio(u.uid, s));

  if (p.renovar) {
    const id = String(p.renovar);
    if (!ID_RE.test(id)) return err(400, "Servicio inválido.");
    const s = mios.find((x) => String(x.id) === id);
    if (!s) return err(404, "No encontramos ese servicio en tu cuenta.");
    return { ref: `${u.uid}:${PLAN_CDN}:r:${id}`, descripcion: "Renovación CDN " + s.path };
  }

  const slug = limpiarSlug(u.uid, p.ruta);
  const origen = origenValido(p.origen);
  if (!SLUG_RE.test(slug)) return err(400, mensaje("INVALID_PATH"), "INVALID_PATH");
  if (!origen || origen.length > 120) return err(400, "El origen debe ser un dominio válido o una IPv4 pública.", "INVALID_DOMAIN");
  const path = rutaDe(u.uid, slug);
  if (todos.some((s) => s.path === path)) return err(409, "Ya tienes un servicio con esa ruta. Elige otro nombre.", "PATH_TAKEN");
  if (mios.length >= MAX_POR_CLIENTE()) return err(409, `Ya tienes el máximo de servicios CDN (${MAX_POR_CLIENTE()}). Renueva uno de los que tienes.`, "LIMITE");
  if (!(await resuelve(origen))) return err(400, mensaje("ORIGIN_DNS_ERROR"), "ORIGIN_DNS_ERROR");
  return { ref: `${u.uid}:${PLAN_CDN}:n:${origen}:${slug}`, descripcion: "CDN " + path };
}

// Errores que no se arreglan reintentando: se devuelve el dinero automáticamente.
const PERMANENTES = new Set(["INVALID_INPUT", "INVALID_DOMAIN", "INVALID_IP", "INVALID_PATH", "ORIGIN_DNS_ERROR", "PATH_TAKEN", "SHARED_ORIGIN", "SERVICE_EXPIRED", "LIMITE", "NO_ES_TUYO"]);

async function devolver(pay, motivo) {
  const token = (process.env.MP_ACCESS_TOKEN || "").trim();
  if (!token || pay.status !== "approved") return false;
  try {
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${pay.id}/refunds`, {
      method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", "X-Idempotency-Key": "refund-" + pay.id }, body: "{}",
    });
    console.error("CDN: pago", pay.id, "devuelto (", motivo, ") ->", r.status);
    return r.ok;
  } catch (e) { console.error("CDN: no se pudo devolver el pago", pay.id, e.message); return false; }
}

/** Crea o renueva el servicio de un pago aprobado. Idempotente: se puede llamar varias veces con el mismo pago. */
export async function entregarCdn(pay) {
  const [uid, , tipo, a, b] = String(pay.external_reference || "").split(":");
  const idem = { "idempotency-key": "mp-" + pay.id };
  try {
    if (tipo === "r") {
      const s = mapService(await cdn("GET", "/v1/services/" + encodeURIComponent(a)));
      if (!esMio(uid, s)) throw Object.assign(new Error("servicio ajeno"), { codigo: "NO_ES_TUYO" });
      try { const j = await cdn("POST", "/v1/services/" + encodeURIComponent(a) + "/renew", {}, idem); return { ok: true, op: operacionId(j) || null }; }
      catch (e) { if (e.codigo === "IDEMPOTENCY_CONFLICT") return { ok: true }; throw e; }
    }
    if (tipo === "n") {
      const origen = origenValido(a), path = rutaDe(uid, b);
      if (!origen || !SLUG_RE.test(String(b || ""))) throw Object.assign(new Error("pedido inválido"), { codigo: "INVALID_PATH" });
      const mios = listaServicios(await cdn("GET", "/v1/services")).filter((s) => esMio(uid, s));
      if (mios.some((s) => s.path === path)) return { ok: true }; // ya entregado (webhook y confirmación llegan los dos)
      if (mios.length >= MAX_POR_CLIENTE()) throw Object.assign(new Error("máximo alcanzado"), { codigo: "LIMITE" });
      try { const j = await cdn("POST", "/v1/services", CAMPOS.crear(origen, path), idem); return { ok: true, op: operacionId(j) || null }; }
      catch (e) { if (e.codigo === "IDEMPOTENCY_CONFLICT") return { ok: true }; throw e; }
    }
    console.error("CDN: referencia de pago desconocida", pay.id);
    return { ok: false, ignorado: true };
  } catch (e) {
    const codigo = e.codigo || "INTERNAL_ERROR";
    console.error("CDN: no se pudo entregar el pago", pay.id, codigo, e.message);
    if (PERMANENTES.has(codigo)) { const dev = await devolver(pay, codigo); return { ok: false, ignorado: true, devuelto: dev, error: mensaje(codigo) }; }
    return { ok: false, error: mensaje(codigo) }; // temporal: Mercado Pago reintenta el webhook
  }
}
