// POST /api/checkout {items:[ids]} -> crea la preferencia de Mercado Pago y devuelve su URL.
import { requireUser } from "../lib/fbverify.js";
import { limit } from "../lib/ratelimit.js";
import { clean } from "../lib/cf.js";
import { MONEDA, pagados } from "../lib/precios.js";

import { cors } from "../lib/cors.js";
export default async function handler(req, res) {
  if (cors(req, res)) return;
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

  // Tipos de pago a ocultar. Valores de MP: ticket, atm, bank_transfer, account_money, credit_card, debit_card, prepaid_card
  const excluidos = (clean(process.env.MP_EXCLUIR) || "ticket,atm").split(",").map((x) => x.trim()).filter(Boolean).map((id) => ({ id }));
  const base = clean(process.env.SITE_URL) || `https://${req.headers.host}`;
  try {
    const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({
        items: items.map((c) => ({ id: c.id, title: c.nombre, quantity: 1, currency_id: MONEDA, unit_price: c.precio })),
        payer: user.email ? { email: user.email } : undefined,
        external_reference: `${user.uid}:${items.map((c) => c.id).join(",")}`,
        notification_url: `https://${req.headers.host}/api/mp-webhook`,
        back_urls: { success: `${base}/?pago=ok`, failure: `${base}/?pago=error`, pending: `${base}/?pago=pendiente` },
        auto_return: "approved",
        // Solo medios de acción inmediata: excluye efectivo/cajero (tardan horas). Editable con MP_EXCLUIR.
        payment_methods: { excluded_payment_types: excluidos },
        binary_mode: true, // aprobado o rechazado al instante (sin "pendiente")
        statement_descriptor: "JITTERX",
      }),
    });
    const d = await r.json();
    if (!r.ok || !d.init_point) return res.status(502).json({ error: "Mercado Pago rechazó la operación: " + (d.message || r.status) });
    res.status(200).json({ ok: true, init_point: d.init_point });
  } catch (e) { res.status(502).json({ error: "No se pudo contactar con Mercado Pago." }); }
}
