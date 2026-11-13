import { MONEDA, CATALOGO } from "../lib/precios.js";
import { cdn, listaServicios } from "../lib/cdn.js";
import { cors } from "../lib/cors.js";

// Contador público de clientes del CDN: personas distintas (cada cliente tiene su prefijo /cXXXXXX en la ruta).
// Se guarda 2 minutos en memoria para no consultar la API del CDN en cada visita.
let cache = { t: 0, v: null };
async function contadorCdn() {
  if (cache.v && Date.now() - cache.t < 120000) return cache.v;
  try {
    const sv = listaServicios(await cdn("GET", "/v1/services"));
    const pref = (s) => (String(s.path || "").match(/^\/(c[0-9a-f]{6})/) || [])[1];
    const activo = (s) => /^(active|activo|deployed|ready|enabled|online)$/.test(s.estado);
    const todos = new Set(sv.map(pref).filter(Boolean));
    const activos = new Set(sv.filter(activo).map(pref).filter(Boolean));
    cache = { t: Date.now(), v: { clientes: todos.size, activos: activos.size } };
  } catch (e) {
    console.error("planes: contador CDN", e.codigo || "", e.message);
    if (!cache.v) return null;
  }
  return cache.v;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    moneda: MONEDA,
    publicKey: (process.env.MP_PUBLIC_KEY || "").trim(),
    items: CATALOGO.map(({ id, tag, nombre, desc, precio, ir }) => ({ id, tag, nombre, desc, precio, ir })),
    cdn: await contadorCdn(), // { clientes, activos } o null si la API no responde
  });
}
