// Cliente del servicio CDN (CloudFront) + reglas para varios clientes con UNA sola clave de la tienda.
//
// ⚠ FORMATO ASUMIDO: sandbox.json lista los endpoints pero NO los campos de las peticiones/respuestas.
//   Todo lo que depende de nombres de campo está en CAMPOS y en los "pick(...)" de mapService():
//   si tu API usa otros nombres, se corrige SOLO aquí.
import crypto from "node:crypto";

const BASE = () => (process.env.CDN_API_BASE || "https://api-cdn.h4x.site").replace(/\/$/, "");
export const MAX_POR_CLIENTE = () => Math.max(1, parseInt(process.env.CDN_MAX_POR_CLIENTE || "2", 10) || 2);

/** Cuerpos de las peticiones (ajusta los nombres si tu API los pide distintos). */
// La API pide el origen en "domain" (si es un dominio) o en "ip" (si es una IP), nunca los dos.
const esIp = (o) => /^\d{1,3}(\.\d{1,3}){3}$/.test(o);
const origenApi = (o) => (esIp(o) ? { ip: o } : { domain: o });
export const CAMPOS = {
  crear: (origin, path) => ({ ...origenApi(origin), path: String(path).replace(/^\/+/, "") }), // la API quiere la ruta sin "/"
  origen: (origin) => origenApi(origin),
};

export const pick = (o, ...ks) => { for (const k of ks) if (o && o[k] != null && o[k] !== "") return o[k]; return undefined; };

// ---------- errores ----------
const MENSAJES = {
  INVALID_DOMAIN: "El dominio de origen no es válido.",
  INVALID_IP: "La IP de origen no es válida. Usa una IPv4 pública.",
  INVALID_INPUT: "Los datos del servicio no son válidos. Revisa el origen y la ruta.",
  INVALID_PATH: "La ruta no es válida. Usa solo letras minúsculas y números, sin guiones (2 a 20 caracteres).",
  ORIGIN_DNS_ERROR: "El dominio de origen no resuelve. Revisa que tenga su registro DNS apuntando a tu servidor.",
  PATH_TAKEN: "Esa ruta ya está en uso. Elige otra.",
  SHARED_ORIGIN: "Ese origen ya lo usa otro servicio.",
  IDEMPOTENCY_CONFLICT: "Ya enviaste una solicitud parecida. Espera unos segundos.",
  SERVICE_BUSY: "El servicio está procesando otra operación. Inténtalo en unos segundos.",
  SERVICE_EXPIRED: "El servicio venció. Crea uno nuevo.",
  RATE_LIMITED: "Demasiadas solicitudes. Espera un momento.",
  NO_CAPACITY: "No hay capacidad disponible ahora. Inténtalo más tarde.",
  INSUFFICIENT_CREDITS: "El servicio CDN no está disponible por ahora. Avísanos por Telegram.",
  UNAUTHORIZED: "El servicio CDN no está disponible por ahora. Avísanos por Telegram.",
  NOT_CONFIGURED: "El servicio CDN todavía no está activado en esta tienda.",
  UNREACHABLE: "No se pudo contactar con el servicio CDN. Inténtalo de nuevo en un momento.",
};
export const mensaje = (c) => MENSAJES[c] || "No se pudo completar la operación. Inténtalo de nuevo.";
export const estadoHttp = (c) => ({ INVALID_INPUT: 400, INVALID_DOMAIN: 400, INVALID_IP: 400, INVALID_PATH: 400, ORIGIN_DNS_ERROR: 400, PATH_TAKEN: 409, SHARED_ORIGIN: 409,
  IDEMPOTENCY_CONFLICT: 409, SERVICE_BUSY: 409, SERVICE_EXPIRED: 410, RATE_LIMITED: 429, NO_CAPACITY: 503, INSUFFICIENT_CREDITS: 503, UNAUTHORIZED: 503, NOT_CONFIGURED: 503 }[c] || 502);
const errorCdn = (codigo, detalle = "", status = 502) => Object.assign(new Error(detalle || codigo), { codigo, status });

/** Llamada al servicio CDN con la clave de la tienda (variable CDN_API_KEY en Vercel). */
export async function cdn(method, path, body, extra = {}) {
  const key = (process.env.CDN_API_KEY || "").trim();
  if (!key) throw errorCdn("NOT_CONFIGURED", "Falta CDN_API_KEY", 503);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
  let r;
  try {
    r = await fetch(BASE() + path, { method, signal: ctl.signal, body: body ? JSON.stringify(body) : undefined,
      headers: { authorization: "Bearer " + key, "x-api-key": key, "content-type": "application/json", accept: "application/json", ...extra } });
  } catch (e) { throw errorCdn("UNREACHABLE", e.message, 502); } finally { clearTimeout(t); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = j.error ?? j;
    const codigo = String(pick(typeof e === "string" ? { code: e } : e, "code", "error_code", "type") || (r.status === 401 ? "UNAUTHORIZED" : r.status === 429 ? "RATE_LIMITED" : "INTERNAL_ERROR")).toUpperCase();
    const msg = pick(e, "message", "detail");
    // Detalle completo de la respuesta (solo se muestra a administradores y en los registros de Vercel)
    throw errorCdn(codigo, `HTTP ${r.status} ${method} ${path}: ` + (typeof msg === "string" ? msg : JSON.stringify(j)).slice(0, 400), r.status);
  }
  return j;
}

// ---------- datos del servicio ----------
const aMs = (v) => { if (v == null) return null; if (typeof v === "number") return v < 1e12 ? v * 1000 : v; const t = Date.parse(v); return Number.isNaN(t) ? null : t; };
// El dominio de CloudFront del servicio: primero por nombres conocidos y, si no, cualquier valor que termine en
// .cloudfront.net (la API puede llamarlo de otra forma o anidarlo, p. ej. distribution.domain_name).
function hostCdn(o) {
  const directo = pick(o, "cdn_domain", "cloudfront_domain", "distribution_domain", "domain_name", "cdn_host", "cdn_url", "cdn", "endpoint", "url", "hostname", "host");
  const limpio = (v) => String(v).replace(/^[a-z]+:\/\//i, "").replace(/[/:].*$/, "");
  if (typeof directo === "string" && /\.cloudfront\.net/i.test(directo)) return limpio(directo);
  let hallado = "";
  const buscar = (v, prof) => {
    if (hallado || prof > 4 || v == null) return;
    if (typeof v === "string") { const m = v.match(/[a-z0-9.-]+\.cloudfront\.net/i); if (m) hallado = m[0].toLowerCase(); return; }
    if (typeof v === "object") for (const k of Object.keys(v)) buscar(v[k], prof + 1);
  };
  buscar(o, 0);
  return hallado || (typeof directo === "string" ? limpio(directo) : "");
}
export function mapService(s) {
  const o = (s && s.service) || s || {};
  const org = pick(o, "origin", "origin_domain", "origin_host", "origin_ip", "domain", "ip");
  return {
    id: pick(o, "id", "service_id"),
    path: (() => { const p = String(pick(o, "path", "origin_path", "url_path") || "").replace(/^\/+/, ""); return p ? "/" + p : ""; })(), // siempre con "/" delante
    host: hostCdn(o),
    origin: typeof org === "object" && org ? (org.domain || org.host || org.ip || "") : (org || ""),
    estado: String(pick(o, "status", "state") || "").toLowerCase(),
    expira: aMs(pick(o, "expires_at", "expiration", "expires")),
  };
}
export const listaServicios = (j) => (Array.isArray(j) ? j : pick(j, "services", "items", "data") || []).map(mapService);
export const operacionId = (j) => pick(j, "operation_id", "operationId") || pick(j && j.operation, "id") || (typeof (j && j.operation) === "string" ? j.operation : undefined);

// ---------- reglas por cliente (sin base de datos) ----------
// Cada cliente solo puede crear rutas que empiecen por su prefijo; así se sabe de quién es cada servicio.
export const prefijo = (uid) => "c" + crypto.createHash("sha256").update("cdn:" + uid).digest("hex").slice(0, 6);
// La API acepta rutas de 3 a 30 letras minúsculas o números (sin guiones): ruta = prefijo (7) + nombre (2 a 20).
export const esMio = (uid, s) => String(s.path || "").startsWith("/" + prefijo(uid));
export const SLUG_RE = /^[a-z0-9]{2,20}$/;
export const limpiarSlug = (uid, ruta) => String(ruta || "").trim().toLowerCase().replace(/^\/+/, "").replace(new RegExp("^" + prefijo(uid) + "-?"), "");
export const rutaDe = (uid, slug) => "/" + prefijo(uid) + slug;

const isPublicIPv4 = (ip) => {
  const [a, b] = ip.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)));
};
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const DOMINIO = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
/** Devuelve el origen normalizado (dominio o IPv4 pública) o null si no es válido. */
export function origenValido(o) {
  const v = String(o || "").trim().toLowerCase();
  if (IPV4.test(v)) return isPublicIPv4(v) ? v : null;
  return DOMINIO.test(v) ? v : null;
}
