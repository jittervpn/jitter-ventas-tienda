// GET /api/pagos/estado -> beneficios pagos del usuario logueado
import { requireUser } from "../../lib/fbverify.js";
import { beneficios } from "../../lib/firestore.js";

export default async function handler(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;
  try { res.status(200).json(await beneficios(u.uid)); }
  catch (e) { res.status(502).json({ error: "No se pudo leer el plan." }); }
}
