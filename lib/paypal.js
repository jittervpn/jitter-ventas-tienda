// PayPal (Orders v2). PayPal no admite ARS: el CDN se cobra en USD con un precio propio.
// Variables en Vercel:
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET  -> de developer.paypal.com (App & Credentials)
//   PAYPAL_ENV = sandbox | live             -> por defecto sandbox
//   El precio en USD se cambia desde /admin (por defecto PAYPAL_PRECIO_USD o 15)
export const PP_MONEDA = "USD";
export { precioUsd as ppPrecio } from "./precios.js"; // se cambia desde /admin (llama antes a cargarPrecios())
export const ppClientId = () => (process.env.PAYPAL_CLIENT_ID || "").trim();
export const ppActivo = () => !!(ppClientId() && (process.env.PAYPAL_CLIENT_SECRET || "").trim());
const base = () => ((process.env.PAYPAL_ENV || "sandbox").trim().toLowerCase() === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");

const st = (globalThis.__jxPaypal ||= { token: null, vence: 0 });
async function token() {
  if (st.token && Date.now() < st.vence) return st.token;
  const cred = Buffer.from(ppClientId() + ":" + (process.env.PAYPAL_CLIENT_SECRET || "").trim()).toString("base64");
  const r = await fetch(base() + "/v1/oauth2/token", {
    method: "POST", headers: { authorization: "Basic " + cred, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("PayPal no aceptó las credenciales (" + r.status + ")");
  st.token = j.access_token; st.vence = Date.now() + Math.max(60, (j.expires_in || 3000) - 120) * 1000;
  return st.token;
}

/** Llamada a la API de PayPal. Lanza un error con .status y .detalle (nombre del error de PayPal). */
export async function pp(method, path, body, extra = {}) {
  const r = await fetch(base() + path, {
    method,
    headers: { authorization: "Bearer " + (await token()), "content-type": "application/json", ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const det = j.details?.[0]?.issue || j.name || "ERROR";
    throw Object.assign(new Error("PayPal " + r.status + " " + det), { status: r.status, detalle: det });
  }
  return j;
}

/** Devuelve el dinero de una captura (idempotente). */
export async function ppDevolver(captureId, motivo) {
  try {
    await pp("POST", `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {}, { "PayPal-Request-Id": "refund-" + captureId });
    console.error("PayPal: captura", captureId, "devuelta (", motivo, ")");
    return true;
  } catch (e) { console.error("PayPal: no se pudo devolver", captureId, e.message); return false; }
}
