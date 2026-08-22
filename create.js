import { json, getCookie, userKey, cfRequest, SEVEN_DAYS_MS } from "../_lib.js";

const isValidIPv4 = (ip) =>
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(ip);
const isValidSub = (s) => /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(s);
const RESERVED = new Set(["www", "mail", "ns1", "ns2", "api", "panel", "admin", "ftp", "smtp", "cpanel"]);

export async function onRequestPost({ request, env }) {
  if (!env.CF_API_TOKEN || !env.ZONE_ID || !env.ZONE_NAME || !env.JITTERX_KV) {
    return json({ error: "El panel no está configurado: faltan variables o el binding KV en Settings." }, 500);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "Cuerpo inválido" }, 400); }

  const sub = String(body.subdomain || "").trim().toLowerCase();
  const ip = String(body.ip || "").trim();
  if (!isValidSub(sub)) return json({ error: "Subdominio inválido: solo letras, números y guiones (2-32 caracteres)." }, 400);
  if (RESERVED.has(sub)) return json({ error: "Ese subdominio está reservado." }, 400);
  if (!isValidIPv4(ip)) return json({ error: "IP inválida. Usa una IPv4 pública, por ejemplo 203.0.113.10." }, 400);

  let device = getCookie(request, "jx_device");
  const setCookie = device ? {} : {
    "set-cookie": `jx_device=${(device = crypto.randomUUID())}; Path=/; Max-Age=31536000; SameSite=Lax; Secure; HttpOnly`,
  };
  const key = await userKey(request, device);

  const existing = await env.JITTERX_KV.get("user:" + key, "json");
  if (existing && existing.expiresAt > Date.now()) {
    return json({ error: "Ya tienes un registro activo. Podrás crear otro cuando expire.", record: existing }, 429, setCookie);
  }

  const max = parseInt(env.MAX_USERS || "100", 10);
  const active = parseInt((await env.JITTERX_KV.get("stats:active")) || "0", 10);
  if (active >= max) return json({ error: "Se alcanzó el límite de usuarios. Inténtalo más tarde." }, 503, setCookie);
  if (await env.JITTERX_KV.get("sub:" + sub)) return json({ error: "Ese subdominio ya está en uso." }, 409, setCookie);

  const fqdn = `${sub}.${env.ZONE_NAME}`;
  const now = Date.now();
  const expiresAt = now + SEVEN_DAYS_MS;

  let dns;
  try {
    dns = await cfRequest(env, `/zones/${env.ZONE_ID}/dns_records`, {
      method: "POST",
      body: JSON.stringify({
        type: "A", name: fqdn, content: ip, ttl: 60, proxied: false,
        comment: `jitterx expira ${new Date(expiresAt).toISOString()}`,
      }),
    });
  } catch (e) {
    return json({ error: "Cloudflare rechazó el registro: " + e.message }, 502, setCookie);
  }

  const record = { id: dns.id, name: fqdn, ip, createdAt: now, expiresAt, userKey: key };
  const ttl = Math.ceil(SEVEN_DAYS_MS / 1000) + 3600;
  const total = parseInt((await env.JITTERX_KV.get("stats:total")) || "0", 10);

  await Promise.all([
    env.JITTERX_KV.put("user:" + key, JSON.stringify(record), { expirationTtl: ttl }),
    env.JITTERX_KV.put("sub:" + sub, "1", { expirationTtl: ttl }),
    env.JITTERX_KV.put("rec:" + dns.id, JSON.stringify(record)),
    env.JITTERX_KV.put("stats:active", String(active + 1)),
    env.JITTERX_KV.put("stats:total", String(total + 1)),
  ]);

  return json({ ok: true, record }, 201, setCookie);
}
