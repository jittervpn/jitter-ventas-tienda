import { MONEDA, CATALOGO } from "../lib/precios.js";
export default function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  res.status(200).json({ moneda: MONEDA, items: CATALOGO.map(({ id, tag, nombre, desc, precio, ir }) => ({ id, tag, nombre, desc, precio, ir })) });
}
