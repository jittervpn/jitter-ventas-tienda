// FUENTE ÚNICA de planes y precios (el servidor decide cuánto se cobra).
// Los precios se cambian desde jitterxcloud.shop/admin y se guardan en Blob (config/precios.json).
// Si no hay nada guardado, se usan las variables CDN_PRECIO (moneda de MP) y PAYPAL_PRECIO_USD, o 17000 / 15.
// MP cobra en la moneda de tu cuenta: MP_CURRENCY (ARS, MXN, BRL, CLP, COP, UYU, PEN).
import { leer, actualizar } from "./kv.js";

export const MONEDA = (process.env.MP_CURRENCY || "ARS").trim();
const DOC = "config/precios.json";
const GRACIA_MS = 48 * 3600 * 1000; // un precio anterior se sigue aceptando 48 h (pagos que ya estaban en curso)
const st = (globalThis.__jxPrecios ||= { t: 0, cfg: null });

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const porDefecto = () => ({ ars: num(process.env.CDN_PRECIO) || 17000, usd: num(process.env.PAYPAL_PRECIO_USD) || 15, historial: [] });

/** Lee los precios guardados (caché de 30 s). Llamar antes de usar precioCdn()/precioUsd(). */
export async function cargarPrecios({ forzar = false } = {}) {
  if (!forzar && st.cfg && Date.now() - st.t < 30000) return st.cfg;
  try {
    const r = await leer(DOC);
    const d = r?.data || {};
    st.cfg = { ...porDefecto(), ...(num(d.ars) ? { ars: num(d.ars) } : {}), ...(num(d.usd) ? { usd: num(d.usd) } : {}), historial: Array.isArray(d.historial) ? d.historial : [], actualizado: d.actualizado || null, por: d.por || null };
  } catch (e) {
    console.error("precios: no se pudo leer la configuración", e.message);
    if (!st.cfg) st.cfg = porDefecto();
  }
  st.t = Date.now();
  return st.cfg;
}
const cfg = () => st.cfg || porDefecto();
export const precioCdn = () => cfg().ars;
export const precioUsd = () => Math.round(cfg().usd * 100) / 100;

/** ¿Este importe es válido para el plan? Acepta el precio actual y los anteriores durante 48 h. */
export function importeValido(monto, moneda) {
  const c = cfg(), campo = moneda === "USD" ? "usd" : "ars";
  const ok = (p) => p != null && Math.abs(Number(monto) - Number(p)) <= 0.01;
  if (ok(c[campo])) return true;
  return (c.historial || []).some((h) => h.hasta > Date.now() - GRACIA_MS && ok(h[campo]));
}

/** Guarda precios nuevos (solo desde /api/admin). */
export async function guardarPrecios({ ars, usd }, email) {
  const a = Math.round(Number(ars)), u = Math.round(Number(usd) * 100) / 100;
  if (!(a >= 100 && a <= 10000000)) throw Object.assign(new Error("El precio en " + MONEDA + " debe estar entre 100 y 10.000.000."), { status: 400 });
  if (!(u >= 1 && u <= 1000)) throw Object.assign(new Error("El precio en USD debe estar entre 1 y 1000."), { status: 400 });
  await actualizar(DOC, (act) => {
    const prev = { ...porDefecto(), ...(act || {}) };
    const historial = [{ ars: prev.ars, usd: prev.usd, hasta: Date.now() }, ...(prev.historial || [])].filter((h) => h.hasta > Date.now() - 30 * 864e5).slice(0, 20);
    return { data: { ars: a, usd: u, historial, actualizado: Date.now(), por: email || null } };
  });
  return cargarPrecios({ forzar: true });
}

export const CATALOGO = [
  { id: "cdn30", tag: "CDN", nombre: "CDN CloudFront 30 días", desc: "Tu propio punto de conexión por CloudFront hacia tu servidor.", get precio() { return precioCdn(); }, ir: "cdn" },
];
export const PLAN_CDN = "cdn30";
