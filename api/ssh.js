// GET  /api/ssh  -> estado de TODOS los servidores (público) + las cuentas SSH y V2Ray del usuario si hay sesión
// POST /api/ssh  -> crea una cuenta en el servidor elegido: SSH/WebSocket (por defecto) o V2Ray con {type:"v2ray"}
//                   (EXIGE sesión con correo verificado)
// La identidad que recibe cada agente es el uid de Firebase: 1 cuenta gratis por usuario y por servidor.
import { agentFetch, serverIds, defaultServer } from "../lib/agent.js";
import { limit, clientIp } from "../lib/ratelimit.js";
import { currentUser, requireUser, usuarioValido } from "../lib/fbverify.js";

import { cors } from "../lib/cors.js";
const ultimo = (globalThis.__jxServidores ||= {}); // último estado conocido de cada servidor (para mostrarlo aunque esté caído)
const suma = (arr, k) => arr.reduce((a, s) => a + (Number(s[k]) || 0), 0);

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const over = limit(req, { max: req.method === "POST" ? 5 : 30, windowMs: 60000 });
  if (over) return res.status(429).json({ error: over });

  try {
    if (req.method === "GET") {
      const cu = await currentUser(req).catch(() => null);
      const u = usuarioValido(cu) ? cu : null;
      let primerError = "";
      const rs = await Promise.all(serverIds().map(async (id) => {
        try {
          const vacio = { data: { account: null } };
          const [st, ac, v2] = await Promise.all([
            agentFetch("/status", { server: id, timeoutMs: 4000 }),
            u ? agentFetch("/account", { device: u.uid, server: id, timeoutMs: 4000 }) : Promise.resolve(vacio),
            u ? agentFetch("/v2/account", { device: u.uid, server: id, timeoutMs: 4000 }).catch(() => vacio) : Promise.resolve(vacio), // agentes antiguos sin V2Ray: sin cuenta
          ]);
          if (st.status >= 300 || st.data?.ok === false) throw new Error(st.data?.error || "El agente no respondió bien (" + st.status + ").");
          const { country, city, flag, host } = st.data;
          ultimo[id] = { country, city, flag, host };
          return {
            server: { ...st.data, id, ok: true },
            account: ac.data?.account ? { ...ac.data.account, server: id } : null,
            v2: v2.data?.account ? { ...v2.data.account, server: id } : null,
          };
        } catch (e) {
          primerError ||= (serverIds().length > 1 ? `Servidor ${id}: ` : "") + e.message;
          return { server: { id, ok: false, ...(ultimo[id] || { country: "Servidor " + id }) }, account: null, v2: null };
        }
      }));
      const servers = rs.map((r) => r.server);
      const vivos = servers.filter((s) => s.ok);
      if (!vivos.length) throw new Error(primerError || "No hay servidores configurados.");
      const accounts = rs.map((r) => r.account).filter(Boolean)
        .sort((a, b) => (b.plan === "premium") - (a.plan === "premium") || b.expires_at - a.expires_at);
      return res.status(200).json({
        ...vivos[0],                                   // compatibilidad: datos del primer servidor disponible...
        active: suma(vivos, "active"), max: suma(vivos, "max"), online: suma(vivos, "online"), // ...con los totales
        premium_active: suma(vivos, "premium_active"), premium_sold: suma(vivos, "premium_sold"),
        servers, accounts, account: accounts[0] || null, v2accounts: rs.map((r) => r.v2).filter(Boolean), logged: !!u,
      });
    }

    if (req.method === "POST") {
      const u = await requireUser(req, res);   // responde 401/403 por sí solo
      if (!u) return;
      const overU = limit(req, { max: 3, windowMs: 60000, key: "u:" + u.uid });
      if (overU) return res.status(429).json({ error: overU });
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const username = String(body.username || "").trim().toLowerCase();
      const server = body.server ? String(body.server) : defaultServer();
      if (!serverIds().includes(server)) return res.status(400).json({ error: "Servidor no válido." });
      const esV2 = body.type === "v2ray";
      const { status, data } = await agentFetch(esV2 ? "/v2/create" : "/create", {
        method: "POST", device: u.uid, clientIp: clientIp(req), server, body: esV2 ? { device: u.uid } : { username, device: u.uid },
      });
      if (data?.account) data.account.server = server;
      return res.status(status).json(data);
    }

    res.status(405).json({ error: "Método no permitido" });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
