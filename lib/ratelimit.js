// Límite de peticiones en memoria (por instancia serverless): frena scripts y inundaciones básicas.
// Además del límite por ruta hay un tope global por IP. Para topes persistentes (p. ej. cuentas gratis
// por IP al día) se usa el agente del VPS, que guarda su estado en disco.
const buckets = new Map();
const MSG = "Demasiadas peticiones. Espera un minuto e inténtalo de nuevo.";
const GLOBAL_MAX = 90; // peticiones por minuto y por IP, sumando todas las rutas

export const clientIp = (req) =>
  (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "0.0.0.0";

function hit(id, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(id) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  buckets.set(id, hits);
  return hits.length;
}

function prune() {
  if (buckets.size <= 5000) return;
  const now = Date.now();
  for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > 120000) buckets.delete(k);
  if (buckets.size > 20000) buckets.clear();
}

/** Devuelve un mensaje de error si se supera el límite, o null. `key` permite limitar por usuario en vez de por IP. */
export function limit(req, { max = 10, windowMs = 60000, key } = {}) {
  prune();
  const ip = clientIp(req);
  if (hit("g|" + ip, 60000) > GLOBAL_MAX) return MSG;
  const ruta = String(req.url || "").split("?")[0];
  return hit(ruta + "|" + (key || ip), windowMs) <= max ? null : MSG;
}
