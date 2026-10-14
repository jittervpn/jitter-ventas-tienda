// POST /api/pagos/webhook  (lo llama Mercado Pago)
// Valida firma -> consulta el pago real -> activa el plan una sola vez.
import crypto from "node:crypto";
import { getDb, admin } from "../../lib/firestore.js";
import { PLANES } from "../../lib/planes.js";

function firmaValida(req, dataId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return false;
  const sig = req.headers["x-signature"] || "";
  const reqId = req.headers["x-request-id"] || "";
  const ts = (sig.match(/ts=([^,]+)/) || [])[1];
  const v1 = (sig.match(/v1=([^,]+)/) || [])[1];
  if (!ts || !v1) return false;
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${reqId};ts:${ts};`;
  const esperado = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(v1)); } catch { return false; }
}

export default async function handler(req, res) {
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const tipo = req.query?.type || req.query?.topic || body.type;
  const dataId = req.query?.["data.id"] || body.data?.id;

  if (tipo !== "payment" || !dataId) return res.status(200).end();
  if (!firmaValida(req, dataId)) return res.status(401).json({ error: "Firma inválida" });

  // No confiamos en el aviso: consultamos el pago a Mercado Pago.
  const r = await fetch("https://api.mercadopago.com/v1/payments/" + encodeURIComponent(dataId), {
    headers: { authorization: "Bearer " + process.env.MP_ACCESS_TOKEN },
  });
  if (!r.ok) return res.status(502).end(); // MP reintenta solo
  const pago = await r.json();
  if (pago.status !== "approved") return res.status(200).end();

  try {
    const db = getDb();
    const ref = db.collection("pagos").doc(String(pago.external_reference || "_"));
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("orden desconocida");
      const orden = snap.data();
      if (orden.estado === "pagado") return; // aviso repetido: ya aplicado
      const plan = PLANES[orden.plan];
      if (!plan) throw new Error("plan desconocido");
      if (Number(pago.transaction_amount) !== Number(orden.monto) || pago.currency_id !== "ARS")
        throw new Error("monto no coincide");

      const uRef = db.collection("usuarios").doc(orden.uid);
      const uSnap = await tx.get(uRef);
      const actual = (uSnap.exists && uSnap.data()[plan.campo]) || 0;
      const nuevo = Math.max(Date.now(), actual) + plan.dias * 864e5; // se suma al vencimiento vigente

      tx.set(uRef, { [plan.campo]: nuevo }, { merge: true });
      tx.update(ref, { estado: "pagado", paymentId: String(pago.id), pagado: admin.firestore.FieldValue.serverTimestamp() });
    });
  } catch (e) {
    console.error("webhook", e.message);
  }
  res.status(200).end();
}
