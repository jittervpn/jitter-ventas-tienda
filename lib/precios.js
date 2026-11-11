// FUENTE ÚNICA de planes y precios (el servidor decide cuánto se cobra).
// MP cobra en la moneda de tu cuenta: pon MP_CURRENCY (ARS, MXN, BRL, CLP, COP, UYU, PEN).
// El precio del CDN se puede cambiar sin tocar código con la variable CDN_PRECIO en Vercel.
export const MONEDA = (process.env.MP_CURRENCY || "ARS").trim();
const precioCdn = () => { const n = Number(process.env.CDN_PRECIO); return Number.isFinite(n) && n > 0 ? n : 17000; };
export const CATALOGO = [
  { id: "cdn30", tag: "CDN", nombre: "CDN CloudFront 30 días", desc: "Tu propio punto de conexión por CloudFront hacia tu servidor.", get precio() { return precioCdn(); }, ir: "cdn" },
];
export const PLAN_CDN = "cdn30";
export const pagados = (ids) => ids.map((id) => CATALOGO.find((c) => c.id === id && c.precio > 0));
