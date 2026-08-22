// Lógica del servidor. Estado guardado en Cloudflare DNS (sin base de datos):
//  - cada registro A lleva comment "jitterx|<userKey>|<expiresAt>"
//  - el total de cuentas creadas va en un TXT "_jitterx-stats.<dominio>"
import crypto from "node:crypto";

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const CF_API = "https://api.cloudflare.com/client/v4";
const TAG = "jitterx|";

export function checkEnv() {
  const missing = ["CF_API_TOKEN", "ZONE_ID", "ZONE_NAME"].filter((k) => !process.env[k]);
  return missing.length ? "Faltan variables de entorno en Vercel: " + missing.join(", ") : null;
}

export async function cfRequest(path, init = {}) {
  const res = await fetch(CF_API + path, {
    ...init,
    headers: { authorization: "Bearer " + process.env.CF_API_TOKEN, "content-type": "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(body?.errors?.[0]?.message || `Cloudflare respondió ${res.status}`);
  }
  return body.result;
}

export function getCookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}

export function userKey(req, device) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "0.0.0.0";
  return crypto.createHash("sha256").update(ip + "|" + (device || "")).digest("hex").slice(0, 32);
}

export const parseRecord = (r) => {
  if (!r.comment || !r.comment.startsWith(TAG)) return null;
  const [, key, exp] = r.comment.split("|");
  return { id: r.id, name: r.name, ip: r.content, userKey: key, expiresAt: parseInt(exp, 10) };
};
export const makeComment = (key, expiresAt) => `${TAG}${key}|${expiresAt}`;

/** Lista registros del panel y borra los vencidos. Devuelve los activos. */
export async function listActive() {
  const zone = process.env.ZONE_ID;
  const all = await cfRequest(`/zones/${zone}/dns_records?type=A&per_page=500&comment.startswith=${encodeURIComponent(TAG)}`);
  const now = Date.now();
  const active = [];
  for (const r of all) {
    const rec = parseRecord(r);
    if (!rec) continue;
    if (rec.expiresAt <= now) {
      await cfRequest(`/zones/${zone}/dns_records/${rec.id}`, { method: "DELETE" }).catch(() => {});
    } else active.push(rec);
  }
  return active;
}

const statsName = () => `_jitterx-stats.${process.env.ZONE_NAME}`;

export async function getTotal() {
  const res = await cfRequest(`/zones/${process.env.ZONE_ID}/dns_records?type=TXT&name=${statsName()}`);
  const txt = res[0];
  const n = parseInt((txt?.content || "").replace(/"/g, "").replace("total=", ""), 10);
  return { id: txt?.id, total: Number.isFinite(n) ? n : 0 };
}

export async function incrementTotal() {
  const { id, total } = await getTotal();
  const body = JSON.stringify({ type: "TXT", name: statsName(), content: `total=${total + 1}`, ttl: 3600, comment: "contador jitterx" });
  if (id) await cfRequest(`/zones/${process.env.ZONE_ID}/dns_records/${id}`, { method: "PATCH", body });
  else await cfRequest(`/zones/${process.env.ZONE_ID}/dns_records`, { method: "POST", body });
}
