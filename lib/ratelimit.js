// Límite de peticiones por IP en memoria (por instancia serverless).
// No es perfecto en un entorno distribuido, pero frena scripts básicos.
const buckets = new Map();

export function limit(req, { max = 10, windowMs = 60000 } = {}) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "0.0.0.0";
  const now = Date.now();
  const hits = (buckets.get(ip) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  buckets.set(ip, hits);
  if (buckets.size > 5000) buckets.clear();
  return hits.length <= max ? null : "Demasiadas peticiones. Espera un minuto e inténtalo de nuevo.";
}

export const clientIp = (req) =>
  (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "0.0.0.0";
