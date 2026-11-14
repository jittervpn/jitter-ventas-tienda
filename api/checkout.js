// POST /api/checkout {cdn:{origen,ruta} | cdn:{renovar:id}} -> valida el pedido, crea la preferencia de Mercado Pago y devuelve su URL.
import { requireUser } from "../lib/auth.js";
import { limit } from "../lib/ratelimit.js";
import { clean } from "../lib/cf.js";
import { MONEDA, CATALOGO, PLAN_CDN } from "../lib/precios.js";
import { prepararCdn } from "../lib/cdnventa.js";
import { mensaje, estadoHttp } from "../lib/cdn.js";

import { cors } from "../lib/cors.js";
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  const over = limit(req, { max: 6, windowMs: 60000 });
  if (over) return res.status(429).json({ error: over });
  const user = await requireUser(req, res); if (!user) return;
  if (limit(req, { max: 15, windowMs: 3600000, key: "chk:" + user.uid })) return res.status(429).json({ error: "Demasiados intentos de pago. Espera una hora." });
  const token = clean(process.env.MP_ACCESS_TOKEN);
  if (!token) return res.status(500).json({ error: "Falta MP_ACCESS_TOKEN en Vercel." });

  let b = {};
  try { b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; }
  catch { return res.status(400).json({ error: "Datos inválidos." }); }
  const item = CATALOGO.find((c) => c.id === PLAN_CDN);
  let ped;
  try { ped = await prepararCdn(user, b.cdn); }
  catch (e) { const c = e.codigo || "INTERNAL_ERROR"; return res.status(estadoHttp(c)).json({ error: mensaje(c), codigo: c }); }
  if (ped.error) return res.status(ped.status).json({ error: ped.error, codigo: ped.codigo });

  // Tipos de pago a ocultar. Valores de MP: ticket, atm, bank_transfer, account_money, credit_card, debit_card, prepaid_card
  const excluidos = (clean(process.env.MP_EXCLUIR) || "ticket,atm").split(",").map((x) => x.trim()).filter(Boolean).map((id) => ({ id }));
  const base = clean(process.env.SITE_URL) || `https://${req.headers.host}`;
  try {
    const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ id: item.id, title: ped.descripcion, quantity: 1, currency_id: MONEDA, unit_price: item.precio }],
        payer: user.email ? { email: user.email } : undefined,
        external_reference: ped.ref,
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
