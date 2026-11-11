// GET /api/me -> el subdominio activo de la cuenta con sesión iniciada (o null).
import { checkEnv, listActive, identity, isMine } from "../lib/cf.js";
import { currentUser } from "../lib/auth.js";
import { limit } from "../lib/ratelimit.js";
import { cors } from "../lib/cors.js";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  const over = limit(req, { max: 30, windowMs: 60000 });
  if (over) return res.status(429).json({ error: over });
  const u = await currentUser(req);
  if (!u) return res.status(200).json({ record: null }); // sin sesión no se muestra ningún registro
  const err = checkEnv();
  if (err) return res.status(500).json({ error: err });
  try {
    // Misma identidad que usa /api/create: la cuenta, nunca la cabecera del navegador ni la IP.
    const id = identity({ ...req, headers: { ...req.headers, "x-jx-device": "u:" + u.uid } });
    const rec = (await listActive()).find((r) => isMine(r, id)) || null;
    res.status(200).json({ record: rec && { id: rec.id, name: rec.name, ip: rec.ip, expiresAt: rec.expiresAt } });
  } catch (e) {
    console.error("api/me:", e.message);
    res.status(502).json({ error: "El servicio de subdominios no responde." });
  }
}
