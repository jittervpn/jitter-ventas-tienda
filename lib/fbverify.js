// Verificación de tokens de Firebase SIN dependencias (sin firebase-admin).
// Comprueba la firma RS256 con las claves públicas de Google y valida
// aud / iss / exp / sub, que es lo que exige la documentación de Firebase.
import crypto from "node:crypto";

const PROJECT_ID = (process.env.FIREBASE_PROJECT_ID || "shocktv-df24f").trim();
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

let cache = { keys: null, exp: 0 };

async function getKeys(force = false) {
  if (!force && cache.keys && cache.exp > Date.now()) return cache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error("No se pudieron obtener las claves públicas de Firebase (" + res.status + ")");
  const data = await res.json();
  const m = (res.headers.get("cache-control") || "").match(/max-age=(\d+)/);
  const ttl = Math.min((m ? parseInt(m[1], 10) : 3600) * 1000, 6 * 3600 * 1000);
  cache = { keys: data.keys || [], exp: Date.now() + ttl };
  return cache.keys;
}

const b64 = (s) => Buffer.from(s, "base64url");

export async function verifyIdToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;

  let header, payload;
  try {
    header = JSON.parse(b64(parts[0]).toString("utf8"));
    payload = JSON.parse(b64(parts[1]).toString("utf8"));
  } catch { return null; }

  if (header.alg !== "RS256" || !header.kid) return null;

  let keys = await getKeys();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await getKeys(true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) return null;

  const pub = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
  const firmaOk = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), pub, b64(parts[2]));
  if (!firmaOk) return null;

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== PROJECT_ID) return null;
  if (payload.iss !== "https://securetoken.google.com/" + PROJECT_ID) return null;
  if (typeof payload.sub !== "string" || !payload.sub) return null;
  if (!payload.exp || payload.exp <= now) return null;
  if (payload.iat && payload.iat > now + 300) return null;

  return { uid: payload.sub, email: payload.email || null, nombre: payload.name || null, verificado: !!payload.email_verified };
}

/** Usuario autenticado según la cabecera Authorization, o null. */
export async function currentUser(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return null;
  try { return await verifyIdToken(token); } catch { return null; }
}

/** Para rutas protegidas: responde 401 y devuelve null si no hay sesión válida. */
export async function requireUser(req, res) {
  const u = await currentUser(req);
  if (!u) { res.status(401).json({ error: "Inicia sesión para continuar." }); return null; }
  return u;
}
