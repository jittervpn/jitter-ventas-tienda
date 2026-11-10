import { MONEDA, CATALOGO } from "../lib/precios.js";

import { cors } from "../lib/cors.js";
export default function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    moneda: MONEDA,
    publicKey: (process.env.MP_PUBLIC_KEY || "").trim(),
    items: CATALOGO.map(({ id, tag, nombre, desc, precio, ir }) => ({ id, tag, nombre, desc, precio, ir })),
  });
}
