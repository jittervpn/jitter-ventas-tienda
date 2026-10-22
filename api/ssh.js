// GET  /api/ssh  -> estado del servidor (público) + cuenta del usuario si hay sesión
// POST /api/ssh  -> crea una cuenta SSH/WebSocket (EXIGE sesión iniciada)
// La identidad que recibe el agente es el uid de Firebase: 1 cuenta por usuario,
// en cualquier dispositivo, y no se puede saltar borrando datos del navegador.
import { agentFetch } from "../lib/agent.js";
import { limit, clientIp } from "../lib/ratelimit.js";
import { currentUser, requireUser, usuarioValido } from "../lib/fbverify.js";

import { cors } from "../lib/cors.js";
export default async function handler(req, res) {
  if (cors(req, res)) return;
  const over = limit(req, { max: req.method === "POST" ? 5 : 30, windowMs: 60000 });
  if (over) return res.status(429).json({ error: over });

  try {
    if (req.method === "GET") {
      const cu = await currentUser(req).catch(() => null);
      const u = usuarioValido(cu) ? cu : null;
      const [status, account] = await Promise.all([
        agentFetch("/status"),
        u ? agentFetch("/account", { device: u.uid }) : Promise.resolve({ data: { account: null } }),
      ]);
      return res.status(200).json({ ...status.data, account: account.data.account || null, logged: !!u });
    }

    if (req.method === "POST") {
      const u = await requireUser(req, res);   // responde 401/403 por sí solo
      if (!u) return;
      const overU = limit(req, { max: 3, windowMs: 60000, key: "u:" + u.uid });
      if (overU) return res.status(429).json({ error: overU });
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const username = String(body.username || "").trim().toLowerCase();
      const { status, data } = await agentFetch("/create", {
        method: "POST", device: u.uid, clientIp: clientIp(req), body: { username, device: u.uid },
      });
      return res.status(status).json(data);
    }

    res.status(405).json({ error: "Método no permitido" });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
const PANEL = "https://project--c3546bd1-8ee0-47c8-a73a-a2b21ba32273.lovable.app/api/public/catalog";

async function cargarCatalogo() {
  const r = await fetch(PANEL, { headers: { "x-api-key": process.env.PANEL_API_KEY } });
  if (!r.ok) throw new Error("Panel no responde");
  return r.json(); // { servers: [...], domains: [...] }
}

