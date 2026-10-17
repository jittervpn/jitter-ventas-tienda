// POST /api/confirmar {payment_id} -> el cliente vuelve de Mercado Pago: se consulta el pago a la API de MP
// y, si está aprobado y es suyo, se entrega la cuenta sin depender del webhook. Idempotente (ref = id de pago).
import { requireUser } from "../lib/fbverify.js";
import { limit } from "../lib/ratelimit.js";
import { clean } from "../lib/cf.js";
import { entregar } from "../lib/entrega.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
    const over = limit(req, { max: 12, windowMs: 60000 });
    if (over) return res.status(429).json({ error: over });
    const user = await requireUser(req, res);
    if (!user) return;
    const token = clean(process.env.MP_ACCESS_TOKEN);
    if (!token) return res.status(500).json({ error: "Falta MP_ACCESS_TOKEN en Vercel." });

    let b = {};
    try { b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; }
    catch { return res.status(400).json({ error: "Datos inválidos." }); }
    const id = String(b.payment_id || "");
    if (!/^\d{4,20}$/.test(id)) return res.status(400).json({ error: "Pago inválido." });

    const r = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, { headers: { authorization: "Bearer " + token } });
    const pay = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(404).json({ error: "No se encontró ese pago." });
    if (String(pay.external_reference || "").split(":")[0] !== user.uid) return res.status(403).json({ error: "Ese pago no es de tu cuenta." });
    if (pay.status !== "approved") return res.status(200).json({ status: pay.status, entregada: false });

    const e = await entregar(pay);
    return res.status(200).json({ status: "approved", entregada: !!e.ok });
  } catch (e) {
    console.error("api/confirmar error:", e.message);
    return res.status(502).json({ error: "No se pudo confirmar el pago." });
  }
}
