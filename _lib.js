// Código compartido entre las funciones de la API (se ejecuta en el servidor, nunca llega al navegador)
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const CF_API = "https://api.cloudflare.com/client/v4";

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });

export function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  const m = raw.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}

export async function userKey(request, device) {
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + "|" + (device || "")));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export async function cfRequest(env, path, init = {}) {
  const res = await fetch(CF_API + path, {
    ...init,
    headers: { authorization: "Bearer " + env.CF_API_TOKEN, "content-type": "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(body?.errors?.[0]?.message || "Error en la API de Cloudflare");
  }
  return body.result;
}

/** Borra registros vencidos. Se ejecuta como máximo una vez por hora (Pages no tiene cron). */
export async function cleanupIfDue(env) {
  const last = parseInt((await env.JITTERX_KV.get("stats:lastCleanup")) || "0", 10);
  if (Date.now() - last < 60 * 60 * 1000) return;
  await env.JITTERX_KV.put("stats:lastCleanup", String(Date.now()));

  const now = Date.now();
  let cursor, removed = 0;
  do {
    const list = await env.JITTERX_KV.list({ prefix: "rec:", cursor });
    for (const k of list.keys) {
      const rec = await env.JITTERX_KV.get(k.name, "json");
      if (!rec) { await env.JITTERX_KV.delete(k.name); continue; }
      if (rec.expiresAt > now) continue;
      try {
        await cfRequest(env, `/zones/${env.ZONE_ID}/dns_records/${rec.id}`, { method: "DELETE" });
      } catch (e) {
        if (!/not found|does not exist|81044/i.test(e.message)) continue;
      }
      const sub = rec.name.replace("." + env.ZONE_NAME, "");
      await Promise.all([
        env.JITTERX_KV.delete(k.name),
        env.JITTERX_KV.delete("sub:" + sub),
        env.JITTERX_KV.delete("user:" + rec.userKey),
      ]);
      removed++;
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  if (removed) {
    const active = parseInt((await env.JITTERX_KV.get("stats:active")) || "0", 10);
    await env.JITTERX_KV.put("stats:active", String(Math.max(0, active - removed)));
  }
}
