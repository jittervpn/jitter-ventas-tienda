import crypto from "node:crypto";
import { checkEnv, cfRequest, zoneId, clean, listActive, getCookie, userKey, makeComment, incrementTotal, SEVEN_DAYS_MS } from "../lib/cf.js";

const isValidIPv4 = (ip) =>
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(ip);
const isValidSub = (s) => /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(s);
const RESERVED = new Set(["www", "mail", "ns1", "ns2", "api", "panel", "admin", "ftp", "smtp", "cpanel"]);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  const err = checkEnv();
  if (err) return res.status(500).json({ error: err });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const sub = String(body.subdomain || "").trim().toLowerCase();
  const ip = String(body.ip || "").trim();
  if (!isValidSub(sub)) return res.status(400).json({ error: "Subdominio inválido: solo letras, números y guiones (2-32 caracteres)." });
  if (RESERVED.has(sub)) return res.status(400).json({ error: "Ese subdominio está reservado." });
  if (!isValidIPv4(ip)) return res.status(400).json({ error: "IP inválida. Usa una IPv4 pública, por ejemplo 203.0.113.10." });

  let device = getCookie(req, "jx_device");
  if (!device) {
    device = crypto.randomUUID();
    res.setHeader("set-cookie", `jx_device=${device}; Path=/; Max-Age=31536000; SameSite=Lax; Secure; HttpOnly`);
  }
  const key = userKey(req, device);
  const fqdn = `${sub}.${clean(process.env.ZONE_NAME)}`;

  try {
    const zone = await zoneId();
    const active = await listActive();
    const mine = active.find((r) => r.userKey === key);
    if (mine) return res.status(429).json({ error: "Ya tienes un registro activo. Podrás crear otro cuando expire.", record: mine });

    const max = parseInt(process.env.MAX_USERS || "100", 10);
    if (active.length >= max) return res.status(503).json({ error: "Se alcanzó el límite de usuarios. Inténtalo más tarde." });

    const taken = await cfRequest(`/zones/${zone}/dns_records?name=${fqdn}`);
    if (taken.length) return res.status(409).json({ error: "Ese subdominio ya está en uso." });

    const now = Date.now();
    const expiresAt = now + SEVEN_DAYS_MS;
    const dns = await cfRequest(`/zones/${zone}/dns_records`, {
      method: "POST",
      body: JSON.stringify({ type: "A", name: fqdn, content: ip, ttl: 60, proxied: false, comment: makeComment(key, expiresAt) }),
    });
    await incrementTotal().catch(() => {});

    res.status(201).json({ ok: true, record: { id: dns.id, name: fqdn, ip, createdAt: now, expiresAt, userKey: key } });
  } catch (e) {
    res.status(502).json({ error: "Cloudflare rechazó la operación: " + e.message });
  }
}
