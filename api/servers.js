// GET /api/servers -> lista pública de VPS y dominios desde el panel
const PANEL = "https://paneladminjitterx.lovable.app/api/public/catalog";

export default async function handler(req, res) {
  try {
    const r = await fetch(PANEL, { cache: "no-store" });
    const data = await r.json();
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(data); // sin IP ni contraseñas
  } catch (e) {
    res.status(500).json({ error: "No se pudo leer el panel" });
  }
}