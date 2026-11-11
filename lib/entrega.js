// Entrega tras un pago aprobado. Compartido por /api/pagar, /api/confirmar y /api/mp-webhook.
// Valida importe y moneda contra el catálogo del servidor; idempotente por pago.
// external_reference: ver lib/cdnventa.js  (uid:cdn30:...)
import { MONEDA, CATALOGO, PLAN_CDN } from "./precios.js";
import { entregarCdn } from "./cdnventa.js";

export async function entregar(pay) {
  const [uid, plan] = String(pay.external_reference || "").split(":");
  const item = CATALOGO.find((c) => c.id === plan);
  if (!uid || !item || Math.abs(pay.transaction_amount - item.precio) > 0.01 || pay.currency_id !== MONEDA) {
    console.error("MP: pago aprobado que no coincide", pay.id, pay.transaction_amount, pay.currency_id);
    return { ok: false, ignorado: true };
  }
  if (plan === PLAN_CDN) return entregarCdn(pay);
  return { ok: false, ignorado: true };
}
