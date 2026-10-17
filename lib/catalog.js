// FUENTE ÚNICA de planes y precios (el servidor decide cuánto se cobra).
// MP cobra en la moneda de tu cuenta: pon MP_CURRENCY (ARS, MXN, BRL, CLP, COP, UYU, PEN).
export const MONEDA = (process.env.MP_CURRENCY || "ARS").trim();
export const CATALOGO = [ // EDITA precios (valores de ejemplo)
  { id: "ssh2",    tag: "Gratis",  nombre: "SSH 2 días",      desc: "Prueba sin costo. 1 conexión, WebSocket.", precio: 0, ir: "ssh" },
  { id: "ssh30",   tag: "Popular", nombre: "SSH 30 días",     desc: "Un mes completo. 1 conexión simultánea.",  precio: 3000, days: 30, maxLogin: 1 },
  { id: "ssh30x2", tag: "Pro",     nombre: "SSH 30 días x2",  desc: "Un mes con 2 conexiones simultáneas.",     precio: 5000, days: 30, maxLogin: 2 },
];
export const pagados = (ids) => ids.map((id) => CATALOGO.find((c) => c.id === id && c.precio > 0));
