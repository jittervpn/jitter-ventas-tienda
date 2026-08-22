import { checkEnv, clean, listActive, getTotal } from "../lib/cf.js";
import { limit } from "../lib/ratelimit.js";

export default async function handler(req, res) {
  const over = limit(req, { max: 30, windowMs: 60000 });
  if (over) return res.status(429).json({ error: over });
  const err = checkEnv();
  if (err) return res.status(500).json({ error: err });
  try {
    const [active, { total }] = await Promise.all([listActive(), getTotal()]);
    res.status(200).json({
      total, active: active.length,
      max: parseInt(process.env.MAX_USERS || "100", 10),
      zone: clean(process.env.ZONE_NAME),
    });
  } catch (e) {
    res.status(502).json({ error: "Cloudflare: " + e.message });
  }
}
