import { checkEnv, listActive, getCookie, userKey } from "../lib/cf.js";

export default async function handler(req, res) {
  const err = checkEnv();
  if (err) return res.status(500).json({ error: err });
  try {
    const key = userKey(req, getCookie(req, "jx_device"));
    const rec = (await listActive()).find((r) => r.userKey === key) || null;
    res.status(200).json({ record: rec });
  } catch (e) {
    res.status(502).json({ error: "Cloudflare: " + e.message });
  }
}
