import { MONEDA, CATALOGO } from "../lib/precios.js";
import { vencerPruebas } from "../lib/pruebas.js";
import { contadorCdn } from "../lib/contador.js";
import { cors } from "../lib/cors.js";
import { limit } from "../lib/ratelimit.js";
import { checkEnv, clean, listActive, getTotal } from "../lib/cf.js";
import { ppActivo, ppClientId, ppPrecio, PP_MONEDA } from "../lib/paypal.js";

// Contador de subdominios (antes /api/stats; vercel.json reenvía /api/stats aquí con ?que=stats).
async function stats(req, res) {
  res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");
  const err = checkEnv();
  if (err) return res.status(500).json({ error: err });
  try {
    const [active, { total }] = await Promise.all([listActive(), getTotal()]);
    return res.status(200).json({ total, active: active.length, max: parseInt(process.env.MAX_USERS || "100", 10), zone: clean(process.env.ZONE_NAME) });
  } catch (e) {
    console.error("api/stats:", e.message);
    return res.status(502).json({ error: "El servicio de subdominios no responde." });
  }
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const over = limit(req, { max: 40, windowMs: 60000 });
  if (over) return res.status(429).json({ error: over });
  if (req.query && req.query.que === "stats") return stats(req, res);
  await vencerPruebas(); // cada visita (o un cron externo) cierra las pruebas de 1 hora que ya vencieron
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    moneda: MONEDA,
    publicKey: (process.env.MP_PUBLIC_KEY || "").trim(),
    items: CATALOGO.map(({ id, tag, nombre, desc, precio, ir }) => ({ id, tag, nombre, desc, precio, ir })),
    paypal: ppActivo() ? { clientId: ppClientId(), precio: ppPrecio(), moneda: PP_MONEDA } : null,
    cdn: await contadorCdn(), // { clientes, activos } o null si la API no responde
  });
}
