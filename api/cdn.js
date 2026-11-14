// /api/cdn — servicios CDN (CloudFront) para los clientes de la tienda.
//   GET  /api/cdn            -> mis servicios
//   GET  /api/cdn?op=ID      -> estado de una operación (crear/renovar/cambiar origen)
//   POST /api/cdn {accion:'crear',origen,ruta} | {accion:'renovar',id} | {accion:'origen',id,origen}
// La clave del servicio CDN vive solo en Vercel (CDN_API_KEY); el cliente nunca la ve.
import crypto from "node:crypto";
import { cors } from "../lib/cors.js";
import { limit } from "../lib/ratelimit.js";
import { requireUser } from "../lib/auth.js";
import { CATALOGO, MONEDA, PLAN_CDN } from "../lib/precios.js";
import { cdn, CAMPOS, pick, mensaje, estadoHttp, listaServicios, mapService, operacionId, prefijo, esMio, SLUG_RE, origenValido, MAX_POR_CLIENTE, limpiarSlug, rutaDe } from "../lib/cdn.js";

// Los clientes compran el CDN con Mercado Pago (/api/pagar y /api/checkout). Crear o renovar SIN pagar desde aquí
// solo lo pueden los correos de CDN_PERMITIDOS (separados por comas): pensado para el dueño y para pruebas.
const permitidos = () => String(process.env.CDN_PERMITIDOS || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
// (CDN_ABIERTO ya no se usa: con la venta activa habría regalado servicios y mostrado tu saldo a todos los clientes)
const puedeCrear = (u) => !!u.email && permitidos().includes(String(u.email).toLowerCase());

const fallo = (res, e, admin) => {
  const codigo = e.codigo || "INTERNAL_ERROR";
  console.error("cdn:", codigo, e.message);
  // Al administrador se le muestra la respuesta real de la API para poder diagnosticar.
  return res.status(estadoHttp(codigo)).json({ error: mensaje(codigo), codigo, detalle: admin ? codigo + " · " + e.message : undefined });
};

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const u = await requireUser(req, res); if (!u) return;
  const over = limit(req, { max: req.method === "POST" ? 12 : 60, windowMs: 60000, key: "u:" + u.uid + ":" + req.method }); if (over) return res.status(429).json({ error: over });

  try {
    if (req.method === "GET") {
      const op = req.query && req.query.op;
      if (op) {
        if (!/^[\w.-]{3,80}$/.test(String(op))) return res.status(400).json({ error: "Operación inválida." });
        const j = await cdn("GET", "/v1/operations/" + encodeURIComponent(String(op)));
        const o = j.operation || j;
        const err = pick(o, "error", "error_code");
        return res.json({ estado: String(pick(o, "status", "state") || "").toLowerCase(), error: err ? mensaje(String(pick(typeof err === "object" ? err : { code: err }, "code") || err).toUpperCase()) : undefined });
      }
      const mios = listaServicios(await cdn("GET", "/v1/services")).filter((s) => esMio(u.uid, s));
      if (req.query && req.query.debug === "1") {
        if (!puedeCrear(u)) return res.status(403).json({ error: "Solo para administradores." });
        const leer = async (p) => { try { return await cdn("GET", p); } catch (e) { return { error: e.message }; } };
        const [servicios, movimientos, saldo] = await Promise.all([leer("/v1/services"), leer("/v1/transactions"), leer("/v1/balance")]);
        return res.json({ servicios, movimientos, saldo });
      }
      const precio = (CATALOGO.find((c) => c.id === PLAN_CDN) || {}).precio || 0;
      let saldo; // solo para el administrador: saldo de la cuenta del CDN
      if (puedeCrear(u)) { try { saldo = await cdn("GET", "/v1/balance"); } catch (e) { saldo = { error: e.message }; } }
      return res.json({ saldo, services: mios, prefijo: prefijo(u.uid), max: MAX_POR_CLIENTE(), admin: puedeCrear(u), precio, moneda: MONEDA, dias: 30 });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });

    let b = {};
    try { b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; } catch { return res.status(400).json({ error: "Datos inválidos." }); }

    const gratis = b.accion === "crear" || b.accion === "renovar";
    if (gratis && !puedeCrear(u)) return res.status(402).json({ error: "Para crear o renovar un servicio CDN hay que pagarlo.", codigo: "PAGO" });

    if (b.accion === "crear") {
      const slug = limpiarSlug(u.uid, b.ruta);
      const origen = origenValido(b.origen);
      if (!SLUG_RE.test(slug)) return res.status(400).json({ error: mensaje("INVALID_PATH"), codigo: "INVALID_PATH" });
      if (!origen) return res.status(400).json({ error: "El origen debe ser un dominio válido o una IPv4 pública.", codigo: "INVALID_DOMAIN" });
      const mios = listaServicios(await cdn("GET", "/v1/services")).filter((s) => esMio(u.uid, s));
      if (mios.length >= MAX_POR_CLIENTE()) return res.status(409).json({ error: `Ya tienes el máximo de servicios CDN (${MAX_POR_CLIENTE()}).`, codigo: "LIMITE" });
      const path = rutaDe(u.uid, slug);
      const idem = crypto.createHash("sha256").update(u.uid + "|" + origen + "|" + path).digest("hex").slice(0, 40);
      const j = await cdn("POST", "/v1/services", CAMPOS.crear(origen, path), { "idempotency-key": idem });
      const op = operacionId(j);
      return res.status(202).json({ ok: true, op: op || null, service: op ? undefined : mapService(j), path });
    }

    if (b.accion === "renovar" || b.accion === "origen") {
      const id = String(b.id || "");
      if (!/^[\w.-]{3,80}$/.test(id)) return res.status(400).json({ error: "Servicio inválido." });
      const s = mapService(await cdn("GET", "/v1/services/" + encodeURIComponent(id)));
      if (!esMio(u.uid, s)) return res.status(404).json({ error: "No encontramos ese servicio." });
      let j;
      if (b.accion === "renovar") j = await cdn("POST", "/v1/services/" + encodeURIComponent(id) + "/renew", {}, { "idempotency-key": "adm-" + id + "-" + Math.floor(Date.now() / 120000) });
      else {
        const origen = origenValido(b.origen);
        if (!origen) return res.status(400).json({ error: "El origen debe ser un dominio válido o una IPv4 pública.", codigo: "INVALID_DOMAIN" });
        j = await cdn("PATCH", "/v1/services/" + encodeURIComponent(id) + "/origin", CAMPOS.origen(origen));
      }
      return res.status(202).json({ ok: true, op: operacionId(j) || null });
    }
    return res.status(400).json({ error: "Acción no válida." });
  } catch (e) { return fallo(res, e, puedeCrear(u)); }
}
