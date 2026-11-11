// /api/cdn — servicios CDN (CloudFront) para los clientes de la tienda.
//   GET  /api/cdn            -> mis servicios
//   GET  /api/cdn?op=ID      -> estado de una operación (crear/renovar/cambiar origen)
//   POST /api/cdn {accion:'crear',origen,ruta} | {accion:'renovar',id} | {accion:'origen',id,origen}
// La clave del servicio CDN vive solo en Vercel (CDN_API_KEY); el cliente nunca la ve.
import crypto from "node:crypto";
import { cors } from "../lib/cors.js";
import { limit } from "../lib/ratelimit.js";
import { requireUser } from "../lib/auth.js";
import { cdn, CAMPOS, pick, mensaje, estadoHttp, listaServicios, mapService, operacionId, prefijo, esMio, SLUG_RE, origenValido, MAX_POR_CLIENTE } from "../lib/cdn.js";

// Con la API oficial cada servicio gasta saldo REAL. Por defecto solo pueden crear/renovar los correos de CDN_PERMITIDOS
// (separados por comas). Cuando quieras abrirlo a todos los clientes: CDN_ABIERTO=1.
const permitidos = () => String(process.env.CDN_PERMITIDOS || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
const puedeCrear = (u) => process.env.CDN_ABIERTO === "1" || permitidos().includes(String(u.email || "").toLowerCase());

const fallo = (res, e) => {
  const codigo = e.codigo || "INTERNAL_ERROR";
  console.error("cdn:", codigo, e.message);
  return res.status(estadoHttp(codigo)).json({ error: mensaje(codigo), codigo });
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
      return res.json({ services: mios, prefijo: prefijo(u.uid), max: MAX_POR_CLIENTE(), puedeCrear: puedeCrear(u) });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });

    if (!puedeCrear(u)) return res.status(403).json({ error: "El CDN está en pruebas y todavía no está disponible para tu cuenta.", codigo: "EN_PRUEBAS" });
    let b = {};
    try { b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; } catch { return res.status(400).json({ error: "Datos inválidos." }); }

    if (b.accion === "crear") {
      const slug = String(b.ruta || "").trim().toLowerCase().replace(/^\/+/, "").replace(new RegExp("^" + prefijo(u.uid) + "-"), "");
      const origen = origenValido(b.origen);
      if (!SLUG_RE.test(slug)) return res.status(400).json({ error: mensaje("INVALID_PATH"), codigo: "INVALID_PATH" });
      if (!origen) return res.status(400).json({ error: "El origen debe ser un dominio válido o una IPv4 pública.", codigo: "INVALID_DOMAIN" });
      const mios = listaServicios(await cdn("GET", "/v1/services")).filter((s) => esMio(u.uid, s));
      if (mios.length >= MAX_POR_CLIENTE()) return res.status(409).json({ error: `Ya tienes el máximo de servicios CDN (${MAX_POR_CLIENTE()}).`, codigo: "LIMITE" });
      const path = "/" + prefijo(u.uid) + "-" + slug;
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
      if (b.accion === "renovar") j = await cdn("POST", "/v1/services/" + encodeURIComponent(id) + "/renew", {});
      else {
        const origen = origenValido(b.origen);
        if (!origen) return res.status(400).json({ error: "El origen debe ser un dominio válido o una IPv4 pública.", codigo: "INVALID_DOMAIN" });
        j = await cdn("PATCH", "/v1/services/" + encodeURIComponent(id) + "/origin", CAMPOS.origen(origen));
      }
      return res.status(202).json({ ok: true, op: operacionId(j) || null });
    }
    return res.status(400).json({ error: "Acción no válida." });
  } catch (e) { return fallo(res, e); }
}
