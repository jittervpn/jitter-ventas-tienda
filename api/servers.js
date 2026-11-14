import { limit } from "../lib/ratelimit.js";
import { cors } from "../lib/cors.js";

// GET /api/servers -> ahora lista desde TU panel jitterxcloud.shop
const PANEL = "https://jitterxcloud.shop/auth/api_servidores.php";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const over = limit(req, { max: 20, windowMs: 60000 });
  if (over) return res.status(429).json({ error: over });
  try {
    const r = await fetch(PANEL, { cache: "no-store" });
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error("respuesta inesperada");

    // Convertimos tu tabla `servidores` al formato que usa tu frontend
    const formatted = data.map(s => ({
      id: s.id,
      nombre: s.nombre || `${s.pais} - ${s.ciudad}`,
      host: s.host_dominio,
      ip: s.host_dominio, // tu IP o dominio
      pais: s.pais,
      ciudad: s.ciudad,
      estado: s.estado,
      activo: s.estado === 'activo',
      tipo: s.tipo_conexion || 'ssh',
      online: true
    }));

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(formatted);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo leer jitterxcloud.shop" });
  }
}
