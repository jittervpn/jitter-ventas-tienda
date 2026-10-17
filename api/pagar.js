// POST /api/pagar {items, formData, key} -> cobra con el token de tarjeta del Brick y entrega la cuenta.
import crypto from "node:crypto";
import { requireUser } from "../lib/fbverify.js";
import { limit } from "../lib/ratelimit.js";
import { clean } from "../lib/cf.js";
import { pagados } from "../lib/precios.js";
import { entregar } from "../lib/entrega.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  const over = limit(req, { max: 6, windowMs: 60000 });
  if (over) return res.status(429).json({ error: over });
  const user = await requireUser(req, res); if (!user) return;
  const token = clean(process.env.MP_ACCESS_TOKEN);
  if (!token) return res.status(500).json({ error: "Falta MP_ACCESS_TOKEN en Vercel." });

  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const ids = Array.isArray(b.items) ? b.items.slice(0, 5).map(String) : [];
  const items = pagados(ids);
  if (!items.length || items.includes(undefined)) return res.status(400).json({ error: "Carrito inválido." });
  const fd = b.formData || {};
  if (!fd.token || !fd.payment_method_id) return res.status(400).json({ error: "Datos de tarjeta incompletos." });
  const total = items.reduce((a, c) => a + c.precio, 0); // el importe lo fija el servidor, nunca el cliente
  const key = /^[\w-]{8,64}$/.test(String(b.key || "")) ? b.key : crypto.randomUUID();
  const base = clean(process.env.SITE_URL) || `https://${req.headers.host}`;

  try {
    const r = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json", "X-Idempotency-Key": key },
      body: JSON.stringify({
        transaction_amount: total, token: fd.token, installments: 1,
        description: items.map((c) => c.nombre).join(", "),
        payment_method_id: fd.payment_method_id, issuer_id: fd.issuer_id,
        payer: { email: fd.payer?.email || user.email, identification: fd.payer?.identification },
        external_reference: `${user.uid}:${items.map((c) => c.id).join(",")}`,
        notification_url: `${base}/api/mp-webhook`, binary_mode: true, statement_descriptor: "JITTERX",
      }),
    });
    const pay = await r.json();
    if (!r.ok) return res.status(400).json({ error: "Mercado Pago rechazó la operación: " + (pay.message || r.status) });
    if (pay.status === "approved") {
      const e = await entregar(pay);
      return res.status(200).json({ status: "approved", entregada: !!e.ok });
    }
    res.status(200).json({ status: pay.status, detalle: pay.status_detail });
  } catch (e) { res.status(502).json({ error: "No se pudo contactar con Mercado Pago." }); }
}
