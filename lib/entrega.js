// Entrega tras un pago aprobado. Compartido por /api/pagar, /api/confirmar y /api/mp-webhook.
// Valida importe y moneda contra el catálogo del servidor; idempotente por pago.
// external_reference: ver lib/cdnventa.js  (uid:cdn30:...)
import { MONEDA, CATALOGO, PLAN_CDN, cargarPrecios, importeValido } from "./precios.js";
import { entregarCdn } from "./cdnventa.js";
import { importeConCupon, marcarUsado } from "./cupones.js";

export async function entregar(pay) {
  const [uid, plan] = String(pay.external_reference || "").split(":");
  await cargarPrecios();
  const item = CATALOGO.find((c) => c.id === plan);
  const normal = importeValido(pay.transaction_amount, MONEDA);
  const cupon = !normal && uid ? await importeConCupon(uid, pay.transaction_amount, MONEDA) : false;
  if (!uid || !item || !(normal || cupon) || pay.currency_id !== MONEDA) {
    console.error("MP: pago aprobado que no coincide", pay.id, pay.transaction_amount, pay.currency_id);
    return { ok: false, ignorado: true };
  }
  if (plan === PLAN_CDN) {
    const r = await entregarCdn(pay);
    if (r.ok && cupon) await marcarUsado(uid, pay.id);
    return r;
  }
  return { ok: false, ignorado: true };
}
