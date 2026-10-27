import { checkEnv, zoneName, maxUsers, listActive, getTotal } from "../lib/cf.js";
import { limit } from "../lib/ratelimit.js";

import { cors } from "../lib/cors.js";
import { cargarPanel } from "../lib/panel.js";
export default async function handler(req, res) {
  if (cors(req, res)) return;
  await cargarPanel();
  res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");
  const over = limit(req, { max: 30, windowMs: 60000 });
  if (over) return res.status(429).json({ error: over });
  const err = checkEnv();
  if (err) return res.status(500).json({ error: err });
  try {
    const [active, { total }] = await Promise.all([listActive(), getTotal()]);
    res.status(200).json({
      total, active: active.length,
      max: maxUsers(),
      zone: zoneName(),
    });
  } catch (e) {
    res.status(502).json({ error: "Cloudflare: " + e.message });
  }
}
