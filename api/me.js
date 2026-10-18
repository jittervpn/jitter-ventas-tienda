import { checkEnv, listActive, identity, isMine } from "../lib/cf.js";

import { cors } from "../lib/cors.js";
export default async function handler(req, res) {
  if (cors(req, res)) return;
  const err = checkEnv();
  if (err) return res.status(500).json({ error: err });
  try {
    const id = identity(req);
    const rec = (await listActive()).find((r) => isMine(r, id)) || null;
    res.status(200).json({ record: rec });
  } catch (e) {
    res.status(502).json({ error: "Cloudflare: " + e.message });
  }
}
