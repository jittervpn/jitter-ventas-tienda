import { json, getCookie, userKey } from "../_lib.js";

export async function onRequestGet({ request, env }) {
  const key = await userKey(request, getCookie(request, "jx_device"));
  const rec = await env.JITTERX_KV.get("user:" + key, "json");
  return json({ record: rec && rec.expiresAt > Date.now() ? rec : null });
}
