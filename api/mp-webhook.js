// Webhook de Mercado Pago. Nunca se fía de lo que recibe: consulta el pago a la API de MP,
// exige estado "approved", importe y moneda correctos, y crea la cuenta (idempotente por pago).
import crypto from "node:crypto";
import { clean } from "../lib/cf.js";
import { entregar } from "../lib/entrega.js";

function firmaOk(req, dataId) {
  const secret = clean(process.env.MP_WEBHOOK_SECRET);
  if (!secret) return true; // opcional; aun así el pago se verifica contra la API de MP
  const sig = String(req.headers["x-signature"] || "");
  const ts = (sig.match(/ts=([^,]+)/) || [])[1], v1 = (sig.match(/v1=([^,]+)/) || [])[1];
  if (!ts || !v1) return false;
  const h = crypto.createHmac("sha256", secret).update(`id:${String(dataId).toLowerCase()};request-id:${req.headers["x-request-id"] || ""};ts:${ts};`).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(v1)); } catch { return false; }
}

export default async function handler(req, res) {
  const q = req.query || {}, body = typeof req.body === "object" && req.body ? req.body : {};
  const tipo = q.type || body.type || q.topic;
  const id = q["data.id"] || body?.data?.id || (q.topic === "payment" ? q.id : null);
  if (tipo !== "payment" || !id) return res.status(200).json({ ignored: true });
  if (!firmaOk(req, id)) return res.status(401).json({ error: "Firma inválida" });

  const token = clean(process.env.MP_ACCESS_TOKEN);
  if (!token) return res.status(500).json({ error: "Falta MP_ACCESS_TOKEN" });
  try {
    const pay = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(id)}`, { headers: { authorization: "Bearer " + token } }).then((r) => r.json());
    if (pay.status !== "approved") return res.status(200).json({ ignored: pay.status || "sin estado" });

    const e = await entregar(pay);
    if (e.ignorado) return res.status(200).json({ ignored: "no coincide" });
    if (!e.ok) return res.status(500).json({ error: "Entrega pendiente, MP reintentará." });
    res.status(200).json({ ok: true });
  } catch (e) { console.error("MP webhook", e.message); res.status(500).json({ error: "Error procesando el pago" }); }
}
