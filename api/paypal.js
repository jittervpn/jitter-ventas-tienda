// POST /api/paypal
//   {accion:"crear", cdn:{origen,ruta}|{renovar:id}} -> valida el pedido y crea la orden de PayPal (USD). Devuelve {id}.
//   {accion:"capturar", id}                         -> cobra la orden aprobada y entrega el CDN. Se puede repetir sin cobrar dos veces.
// El pedido se guarda en Blob ligado a la orden y a la cuenta: el navegador no puede cambiar qué se entrega ni el importe.
import { requireUser } from "../lib/auth.js";
import { limit } from "../lib/ratelimit.js";
import { cors } from "../lib/cors.js";
import { prepararCdn, entregarCdn } from "../lib/cdnventa.js";
import { mensaje, estadoHttp } from "../lib/cdn.js";
import { leer, actualizar } from "../lib/kv.js";
import { pp, ppActivo, ppPrecio, ppDevolver, PP_MONEDA } from "../lib/paypal.js";

const ORDEN_RE = /^[A-Z0-9]{8,40}$/;
const doc = (id) => "paypal/" + id + ".json";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  if (limit(req, { max: 10, windowMs: 60000 })) return res.status(429).json({ error: "Demasiadas peticiones. Espera un minuto." });
  const user = await requireUser(req, res); if (!user) return;
  if (!ppActivo()) return res.status(503).json({ error: "PayPal no está disponible ahora mismo." });
  if (limit(req, { max: 15, windowMs: 3600000, key: "pp:" + user.uid })) return res.status(429).json({ error: "Hiciste demasiados intentos de pago. Espera una hora o escríbenos por Telegram." });

  let b = {};
  try { b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; } catch { return res.status(400).json({ error: "Datos inválidos." }); }

  try {
    if (b.accion === "crear") {
      let ped;
      try { ped = await prepararCdn(user, b.cdn); }
      catch (e) { const c = e.codigo || "INTERNAL_ERROR"; return res.status(estadoHttp(c)).json({ error: mensaje(c), codigo: c }); }
      if (ped.error) return res.status(ped.status).json({ error: ped.error, codigo: ped.codigo });
      const monto = ppPrecio().toFixed(2);
      const o = await pp("POST", "/v2/checkout/orders", {
        intent: "CAPTURE",
        purchase_units: [{ reference_id: "cdn30", description: ped.descripcion.slice(0, 127), amount: { currency_code: PP_MONEDA, value: monto } }],
        payment_source: { paypal: { experience_context: { brand_name: "Jitterx Panel Cloud", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW", locale: "es-AR" } } },
      });
      await actualizar(doc(o.id), () => ({ data: { uid: user.uid, ref: ped.ref, monto, creada: Date.now() } }));
      return res.status(200).json({ id: o.id });
    }

    if (b.accion === "capturar") {
      const id = String(b.id || "");
      if (!ORDEN_RE.test(id)) return res.status(400).json({ error: "Orden inválida." });
      const g = await leer(doc(id));
      const ped = g?.data;
      if (!ped || ped.uid !== user.uid) return res.status(404).json({ error: "No encontramos esa orden en tu cuenta." });

      let o;
      try { o = await pp("POST", `/v2/checkout/orders/${id}/capture`, {}, { "PayPal-Request-Id": "cap-" + id }); }
      catch (e) {
        if (e.detalle === "ORDER_ALREADY_CAPTURED") o = await pp("GET", `/v2/checkout/orders/${id}`);
        else if (e.detalle === "INSTRUMENT_DECLINED") return res.status(402).json({ error: "PayPal rechazó ese medio de pago. Prueba con otro.", reintentar: true });
        else throw e;
      }
      const cap = o.purchase_units?.[0]?.payments?.captures?.[0];
      if (o.status !== "COMPLETED" || !cap || cap.status !== "COMPLETED") {
        return res.status(200).json({ status: (cap?.status || o.status || "PENDIENTE").toLowerCase() });
      }
      if (cap.amount?.currency_code !== PP_MONEDA || cap.amount?.value !== ped.monto) {
        console.error("PayPal: importe no coincide", id, cap.amount);
        await ppDevolver(cap.id, "IMPORTE");
        return res.status(400).json({ error: "El importe no coincide. Te devolvimos el dinero." });
      }
      const pay = { id: "pp-" + cap.id, status: "approved", external_reference: ped.ref, devolver: (m) => ppDevolver(cap.id, m) };
      const e = await entregarCdn(pay);
      return res.status(200).json({ status: "approved", entregada: !!e.ok, op: e.op || null, devuelto: !!e.devuelto, error: e.ok ? undefined : e.error });
    }
    return res.status(400).json({ error: "Acción no válida." });
  } catch (e) {
    console.error("api/paypal:", e.message);
    return res.status(502).json({ error: "No se pudo completar el pago con PayPal. Inténtalo de nuevo o escríbenos por Telegram." });
  }
}
