// GET  /api/ssh  -> estado del servidor + cuenta del dispositivo
// POST /api/ssh  -> crea una cuenta SSH/WebSocket
import { agentFetch, deviceOf } from "../lib/agent.js";
import { limit, clientIp } from "../lib/ratelimit.js";

export default async function handler(req, res) {
  const device = deviceOf(req);
  const over = limit(req, { max: req.method === "POST" ? 5 : 30, windowMs: 60000 });
  if (over) return res.status(429).json({ error: over });
  try {
    if (req.method === "GET") {
      const [status, account] = await Promise.all([
        agentFetch("/status"),
        device ? agentFetch("/account", { device }) : Promise.resolve({ data: { account: null } }),
      ]);
      return res.status(200).json({ ...status.data, account: account.data.account || null });
    }

    if (req.method === "POST") {
      if (!device) return res.status(400).json({ error: "Falta el identificador de dispositivo." });
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const username = String(body.username || "").trim().toLowerCase();
      const { status, data } = await agentFetch("/create", {
        method: "POST", device, clientIp: clientIp(req), body: { username, device },
      });
      return res.status(status).json(data);
    }

    res.status(405).json({ error: "Método no permitido" });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
