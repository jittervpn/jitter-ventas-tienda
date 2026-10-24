// POST /api/pagar {items, formData, key} -> cobra con el token de tarjeta del Brick y entrega la cuenta.
// Autocontenido: solo usa archivos que ya existen en el repo (auth, ratelimit, cf, precios, agent).
import { randomUUID } from "node:crypto";
import { requireUser } from "../lib/auth.js";
import { limit } from "../lib/ratelimit.js";
import { clean } from "../lib/cf.js";
import { pagados } from "../lib/precios.js";
import { serverValido } from "../lib/agent.js";
import { entregar } from "../lib/entrega.js";

import { cors } from "../lib/cors.js";
export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
    const over = limit(req, { max: 6, windowMs: 60000 });
    if (over) return res.status(429).json({ error: over });
    const user = await requireUser(req, res);
    if (!user) return;
    const token = clean(process.env.MP_ACCESS_TOKEN);
    if (!token) return res.status(500).json({ error: "Falta MP_ACCESS_TOKEN en Vercel." });

    let b = {};
    try { b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; }
    catch { return res.status(400).json({ error: "Datos inválidos." }); }

    const ids = Array.isArray(b.items) ? b.items.slice(0, 5).map(String) : [];
    const items = pagados(ids);
    if (!items.length || items.includes(undefined)) return res.status(400).json({ error: "Carrito inválido." });
    const fd = b.formData || {};
    if (!fd.token || !fd.payment_method_id) return res.status(400).json({ error: "Datos de tarjeta incompletos." });

    const total = items.reduce((a, c) => a + c.precio, 0); // el importe lo fija el servidor
    const key = /^[\w-]{8,64}$/.test(String(b.key || "")) ? b.key : randomUUID();
    const base = clean(process.env.SITE_URL) || `https://${req.headers.host}`;

    const r = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json", "X-Idempotency-Key": key },
      body: JSON.stringify({
        transaction_amount: total, token: fd.token, installments: 1,
        description: items.map((c) => c.nombre).join(", "),
        payment_method_id: fd.payment_method_id, issuer_id: fd.issuer_id,
        payer: { email: fd.payer?.email || user.email, identification: fd.payer?.identification },
        external_reference: `${user.uid}:${items.map((c) => c.id).join(",")}:${serverValido(b.server)}`,
        notification_url: `https://${req.headers.host}/api/mp-webhook`, binary_mode: true, statement_descriptor: "JITTERX",
      }),
    });
    const pay = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("MP pagar rechazó", r.status, JSON.stringify(pay).slice(0, 500));
      return res.status(400).json({ error: "Mercado Pago rechazó la operación: " + (pay.message || r.status) });
    }
    if (pay.status === "approved") {
      let e = { ok: false };
      try { e = await entregar(pay); } catch (err) { console.error("MP entrega falló", pay.id, err.message); }
      return res.status(200).json({ status: "approved", entregada: !!e.ok });
    }
    return res.status(200).json({ status: pay.status, detalle: pay.status_detail });
  } catch (e) {
    console.error("api/pagar error:", e.message);
    return res.status(502).json({ error: "No se pudo procesar el pago: " + e.message });
  }
}
