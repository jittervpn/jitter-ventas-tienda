// Puente entre Vercel y el agente instalado en el VPS.
import { clean } from "./cf.js";

export function agentEnv() {
  const url = clean(process.env.AGENT_URL);
  const token = clean(process.env.AGENT_TOKEN);
  if (!url || !token) return { error: "Faltan variables AGENT_URL o AGENT_TOKEN en Vercel." };
  return { url: url.replace(/\/$/, ""), token };
}

export async function agentFetch(path, { method = "GET", body, device, clientIp } = {}) {
  const { url, token, error } = agentEnv();
  if (error) throw new Error(error);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
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
    const msg = e.name === "AbortError"
      ? "El VPS no responde (tiempo agotado). ¿Está el agente encendido?"
      : "No se pudo contactar con el VPS: " + e.message;
    throw new Error(msg);
  } finally {
    clearTimeout(t);
  }
}

export const deviceOf = (req) => req.headers["x-jx-device"] || "";
