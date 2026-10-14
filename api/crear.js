// POST /api/pagos/crear   body: { plan: "ssh_30" }  -> { ok, init_point }
import crypto from "node:crypto";
import { requireUser } from "../../lib/fbverify.js";
import { limit } from "../../lib/ratelimit.js";
import { getDb, admin } from "../../lib/firestore.js";
import { PLANES } from "../../lib/planes.js";

const BASE_URL = process.env.PUBLIC_URL || "https://jitter-ventas-tienda.vercel.app";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  const over = limit(req, { max: 10, windowMs: 60000 });
  if (over) return res.status(429).json({ error: over });

  const u = await requireUser(req, res);
  if (!u) return;

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const plan = PLANES[body.plan];
  if (!plan) return res.status(400).json({ error: "Plan inválido" });

  try {
    const orderId = crypto.randomUUID();
    const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + process.env.MP_ACCESS_TOKEN },
      body: JSON.stringify({
        items: [{ id: body.plan, title: plan.titulo, quantity: 1, unit_price: plan.precio, currency_id: "ARS" }],
        external_reference: orderId,
        payer: u.email ? { email: u.email } : undefined,
        notification_url: BASE_URL + "/api/pagos/webhook",
        back_urls: {
          success: BASE_URL + "/?pago=ok#perfil",
          pending: BASE_URL + "/?pago=pendiente#perfil",
          failure: BASE_URL + "/?pago=error#perfil",
        },
        auto_return: "approved",
      }),
    });
    const pref = await r.json();
    if (!r.ok || !pref.init_point) {
      console.error("MP preferencia", r.status, pref);
      return res.status(502).json({ error: "No se pudo iniciar el pago. Inténtalo de nuevo." });
    }
    await getDb().collection("pagos").doc(orderId).set({
      uid: u.uid, plan: body.plan, monto: plan.precio, estado: "pendiente",
      preferenceId: pref.id, creado: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.status(200).json({ ok: true, init_point: pref.init_point });
  } catch (e) {
    console.error("pagos/crear", e);
    res.status(502).json({ error: "No se pudo iniciar el pago." });
  }
}
