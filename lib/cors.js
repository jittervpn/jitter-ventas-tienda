// CORS: permite que la web alojada en otro dominio (cPanel) use esta API. Variable opcional ALLOWED_ORIGINS (separada por comas).
const DEFAULT = ["https://jitterxcloud.shop", "https://www.jitterxcloud.shop", "https://jitter-ventas-tienda.vercel.app"];

// Devuelve true si ya respondió (petición OPTIONS de comprobación previa).
export function cors(req, res) {
  const env = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = env.length ? env : DEFAULT;
  const o = req.headers.origin;
  if (o && ok.includes(o)) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-jx-device");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}
