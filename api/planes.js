import { MONEDA, CATALOGO } from "../lib/precios.js";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    moneda: MONEDA,
    publicKey: (process.env.MP_PUBLIC_KEY || "").trim(),
    items: CATALOGO.map(({ id, tag, nombre, desc, precio, ir }) => ({ id, tag, nombre, desc, precio, ir })),
  });
}
