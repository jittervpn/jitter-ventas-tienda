import { json, cleanupIfDue } from "../_lib.js";

export async function onRequestGet({ env }) {
  await cleanupIfDue(env);
  const total = parseInt((await env.JITTERX_KV.get("stats:total")) || "0", 10);
  const active = parseInt((await env.JITTERX_KV.get("stats:active")) || "0", 10);
  return json({ total, active, max: parseInt(env.MAX_USERS || "100", 10), zone: env.ZONE_NAME });
}
