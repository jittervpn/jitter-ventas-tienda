// Puente entre Vercel y el agente instalado en el VPS.
import { clean } from "./cf.js";

// Servidores (VPS): el 1 usa AGENT_URL / AGENT_TOKEN; el 2 al 6 usan AGENT2_URL / AGENT2_TOKEN ... AGENT6_*.
const MAX_SERVERS = 6;
const envOf = (id) => id === "1"
  ? [process.env.AGENT_URL, process.env.AGENT_TOKEN]
  : [process.env[`AGENT${id}_URL`], process.env[`AGENT${id}_TOKEN`]];

/** Ids de los servidores configurados, p. ej. ["1","2"]. */
export function serverIds() {
  const out = [];
  for (let i = 1; i <= MAX_SERVERS; i++) {
    const [u, t] = envOf(String(i));
    if (clean(u) && clean(t)) out.push(String(i));
  }
  return out;
}
export const defaultServer = () => serverIds()[0] || "1";
/** Devuelve el id si existe como servidor configurado; si no, el servidor por defecto. */
export const serverValido = (id) => (serverIds().includes(String(id)) ? String(id) : defaultServer());

export function agentEnv(server) {
  const id = server ? String(server) : defaultServer();
  const [u, t] = envOf(id);
  const url = clean(u), token = clean(t);
  if (!url || !token) {
    return { error: id === "1" ? "Faltan variables AGENT_URL o AGENT_TOKEN en Vercel." : `Faltan variables AGENT${id}_URL o AGENT${id}_TOKEN en Vercel.` };
  }
  return { url: url.replace(/\/$/, ""), token };
}

export async function agentFetch(path, { method = "GET", body, device, clientIp, server, timeoutMs = 10000 } = {}) {
  const { url, token, error } = agentEnv(server);
  if (error) throw new Error(error);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url + path, {
      method,
      signal: ctrl.signal,
      headers: {
        "x-agent-token": token,
        ...(device ? { "x-jx-device": device } : {}),
        ...(clientIp ? { "x-real-client-ip": clientIp } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({ error: "El agente devolvió una respuesta inválida." }));
    return { status: res.status, data };
  } catch (e) {
    const code = e.cause?.code || e.code || "";
    const host = (() => { try { return new URL(url).host; } catch { return url; } })();
    const motivos = {
      ENOTFOUND: `el dominio ${host.split(":")[0]} no resuelve a ninguna IP (falta el registro A en Cloudflare o no se ha propagado)`,
      EAI_AGAIN: "fallo temporal de DNS, inténtalo de nuevo en un minuto",
      ECONNREFUSED: `el servidor ${host} rechazó la conexión (el agente no está escuchando en ese puerto o la IP no es la del VPS)`,
      ETIMEDOUT: `tiempo agotado conectando a ${host} (firewall bloqueando el puerto)`,
      UND_ERR_CONNECT_TIMEOUT: `tiempo agotado conectando a ${host} (firewall bloqueando el puerto)`,
      ECONNRESET: "la conexión se cortó (posible baneo temporal por intentos fallidos)",
      EHOSTUNREACH: "no hay ruta hacia el VPS",
    };
    const msg = e.name === "AbortError"
      ? `El VPS no responde (tiempo agotado) en ${host}. ¿Está el agente encendido y el puerto abierto?`
      : "No se pudo contactar con el VPS: " + (motivos[code] || `${e.message}${code ? " [" + code + "]" : ""}`);
    throw new Error(msg);
  } finally {
    clearTimeout(t);
  }
}

export const deviceOf = (req) => req.headers["x-jx-device"] || "";
