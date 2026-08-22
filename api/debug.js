import { clean } from "../lib/cf.js";

// Diagnóstico: nunca muestra el token completo.
export default async function handler(req, res) {
  const token = clean(process.env.CF_API_TOKEN);
  const out = {
    CF_API_TOKEN: token ? `presente (${token.length} caracteres, empieza por ${token.slice(0, 5)}…)` : "FALTA",
    ZONE_NAME: clean(process.env.ZONE_NAME) || "FALTA",
    ZONE_ID: clean(process.env.ZONE_ID) || "(vacío, se buscará por ZONE_NAME)",
  };
  if (token) {
    const v = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers: { authorization: "Bearer " + token },
    }).then((r) => r.json()).catch((e) => ({ error: e.message }));
    out.token_valido = v.success ? `sí (${v.result.status})` : "NO: " + (v.errors?.[0]?.message || JSON.stringify(v));
    if (v.success && out.ZONE_NAME !== "FALTA") {
      const z = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(out.ZONE_NAME)}`, {
        headers: { authorization: "Bearer " + token },
      }).then((r) => r.json()).catch((e) => ({ error: e.message }));
      out.zona_encontrada = z.success && z.result.length
        ? `sí: ${z.result[0].name} (id ${z.result[0].id}, estado ${z.result[0].status})`
        : "NO: la zona no está en esta cuenta o el token no puede verla. " + (z.errors?.[0]?.message || "");
    }
  }
  res.status(200).json(out);
}
