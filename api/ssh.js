// GET  /api/ssh  -> estado del servidor (público) + cuenta del usuario si hay sesión
// POST /api/ssh  -> crea una cuenta SSH/WebSocket (EXIGE sesión iniciada)
// La identidad que recibe el agente es el uid de Firebase: 1 cuenta por usuario,
// en cualquier dispositivo, y no se puede saltar borrando datos del navegador.
import { agentFetch } from "../lib/agent.js";
import { limit, clientIp } from "../lib/ratelimit.js";
import { currentUser, requireUser } from "../lib/fbverify.js";
import { beneficios } from "../lib/firestore.js";

export default async function handler(req, res) {
  const over = limit(req, { max: req.method === "POST" ? 5 : 30, windowMs: 60000 });
  if (over) return res.status(429).json({ error: over });

  try {
    if (req.method === "GET") {
      const u = await currentUser(req).catch(() => null);
      const [status, account] = await Promise.all([
        agentFetch("/status"),
        u ? agentFetch("/account", { device: u.uid }) : Promise.resolve({ data: { account: null } }),
      ]);
      return res.status(200).json({ ...status.data, account: account.data.account || null, logged: !!u });
    }

    if (req.method === "POST") {
      const u = await requireUser(req, res);   // responde 401/403 por sí solo
      if (!u) return;
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const username = String(body.username || "").trim().toLowerCase();
      // Si el usuario pagó un plan SSH vigente, la cuenta dura hasta que termine ese plan.
      let days;
      try {
        const b = await beneficios(u.uid);
        if (b.ssh_expires_at > Date.now()) days = Math.max(1, Math.ceil((b.ssh_expires_at - Date.now()) / 864e5));
      } catch (e) { console.warn("beneficios:", e.message); }
      const { status, data } = await agentFetch("/create", {
        method: "POST", device: u.uid, clientIp: clientIp(req),
        body: { username, device: u.uid, ...(days ? { days } : {}) },
      });
      return res.status(status).json(data);
    }

    res.status(405).json({ error: "Método no permitido" });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
