// Entrega de cuentas tras un pago aprobado. Compartido por /api/pagar y /api/mp-webhook.
// Valida importe y moneda contra el catálogo del servidor; idempotente por pago (ref).
import { agentFetch } from "./agent.js";
import { MONEDA, pagados } from "./precios.js";

export async function entregar(pay) {
  const [uid, lista] = String(pay.external_reference || "").split(":");
  const items = pagados((lista || "").split(","));
  const esperado = items.reduce((a, c) => a + (c?.precio || 0), 0);
  if (!uid || !items.length || items.includes(undefined) || Math.abs(pay.transaction_amount - esperado) > 0.01 || pay.currency_id !== MONEDA) {
    console.error("MP: pago aprobado que no coincide", pay.id, pay.transaction_amount, pay.currency_id);
    return { ok: false, ignorado: true };
  }
  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    const r = await agentFetch("/create", { method: "POST", body: { device: uid, paid: true, username: "", days: c.days, max_login: c.maxLogin, ref: `${pay.id}-${i}` } });
    if (r.status >= 300) { console.error("MP: el agente no pudo crear la cuenta", pay.id, r.status, r.data); return { ok: false, error: true }; }
  }
  return { ok: true };
}
