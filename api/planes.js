import { MONEDA, catalogo } from "../lib/precios.js";
import { cargarPanel } from "../lib/panel.js";

import { cors } from "../lib/cors.js";
export default async function handler(req, res) {
  if (cors(req, res)) return;
  await cargarPanel();
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    moneda: MONEDA,
    publicKey: (process.env.MP_PUBLIC_KEY || "").trim(),
    items: catalogo().map(({ id, tag, nombre, desc, precio, ir }) => ({ id, tag, nombre, desc, precio, ir })),
  });
}
