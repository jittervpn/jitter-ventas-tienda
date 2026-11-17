// Sesión: token HS256 firmado con SESSION_SECRET (lo emite /api/auth/codigo tras validar el código del correo).
// Mismo formato y mismo uid por correo que el antiguo login PHP de cPanel: las sesiones y los CDN de cada cliente siguen valiendo.
// Misma API que tenía lib/fbverify.js (currentUser, requireUser, usuarioValido, esDescartable).
import crypto from "node:crypto";


function secreto() {
  const s = (process.env.SESSION_SECRET || "").trim();
  if (s.length < 32) throw new Error("Falta SESSION_SECRET en Vercel (mínimo 32 caracteres).");
  return s;
}

export const SESSION_DAYS = 30;
/** Correo "canónico" (en Gmail los puntos y el +sufijo no cuentan). */
export function canonico(email) {
  const [l, d] = String(email).split("@");
  return d === "gmail.com" || d === "googlemail.com" ? l.split("+")[0].replace(/\./g, "") + "@gmail.com" : String(email);
}
/** uid estable por correo (idéntico a uid_de_email() del PHP). */
export const uidDeEmail = (email) => "u" + crypto.createHash("sha256").update("jx:" + canonico(email)).digest("hex").slice(0, 28);

export function crearToken(uid, email) {
  const now = Math.floor(Date.now() / 1000);
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = b({ alg: "HS256", typ: "JWT" }), p = b({ sub: uid, email, iat: now, exp: now + SESSION_DAYS * 86400 });
  return `${h}.${p}.` + crypto.createHmac("sha256", secreto()).update(`${h}.${p}`).digest("base64url");
}

export function verificarToken(token) {
  const p = String(token || "").split(".");
  if (p.length !== 3) return null;
  let head, body;
  try {
    head = JSON.parse(Buffer.from(p[0], "base64url").toString("utf8"));
    body = JSON.parse(Buffer.from(p[1], "base64url").toString("utf8"));
  } catch { return null; }
  if (head.alg !== "HS256") return null;
  const esperado = crypto.createHmac("sha256", secreto()).update(p[0] + "." + p[1]).digest();
  const recibido = Buffer.from(p[2], "base64url");
  if (esperado.length !== recibido.length || !crypto.timingSafeEqual(esperado, recibido)) return null;
  if (!body.exp || body.exp <= Math.floor(Date.now() / 1000)) return null;
  if (typeof body.sub !== "string" || !body.sub) return null;
  return { uid: body.sub, email: body.email || null, nombre: null, verificado: true };
}

/** Por qué se rechaza un token (para diagnosticar la configuración): sin_secret | formato | firma | vencido. */
export function motivoRechazo(token) {
  const sec = (process.env.SESSION_SECRET || "").trim();
  if (sec.length < 32) return "sin_secret";
  const p = String(token || "").split(".");
  if (p.length !== 3) return "formato";
  try { if (JSON.parse(Buffer.from(p[0], "base64url").toString("utf8")).alg !== "HS256") return "formato"; }
  catch { return "formato"; }
  const esperado = crypto.createHmac("sha256", sec).update(p[0] + "." + p[1]).digest();
  const recibido = Buffer.from(p[2], "base64url");
  if (esperado.length !== recibido.length || !crypto.timingSafeEqual(esperado, recibido)) return "firma";
  return "vencido";
}

/** Usuario autenticado según la cabecera Authorization, o null. */
export async function currentUser(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return null;
  try { return verificarToken(token); } catch { return null; }
}

// Dominios de correo desechable: verificar el correo no sirve si el buzón es temporal.
const DESCARTABLES = new Set(["mailinator.com","guerrillamail.com","guerrillamail.net","guerrillamail.org","sharklasers.com","grr.la","10minutemail.com","10minutemail.net","tempmail.com","temp-mail.org","temp-mail.io","tempmail.net","tempmailo.com","yopmail.com","yopmail.net","trashmail.com","trashmail.net","getnada.com","nada.email","dispostable.com","maildrop.cc","fakeinbox.com","throwawaymail.com","mohmal.com","emailondeck.com","mintemail.com","spamgourmet.com","mailnesia.com","burnermail.io","moakt.com","tmpmail.org","tmpmail.net","discard.email","dropmail.me","fexpost.com","inboxkitten.com","mail.tm","mailsac.com","33mail.com","anonaddy.me","cs.email"]);
export const esDescartable = (email) => DESCARTABLES.has(String(email || "").split("@")[1]?.toLowerCase());
/** Usuario con sesión válida y correo no desechable. */
export const usuarioValido = (u) => !!u && u.verificado && !esDescartable(u.email);

/** Para rutas protegidas: responde 401/403 y devuelve null si no hay sesión válida. */
export async function requireUser(req, res, { allowUnverified = false } = {}) {
  const u = await currentUser(req);
  if (!u) { res.status(401).json({ error: "Inicia sesión para continuar." }); return null; }
  if (!allowUnverified && esDescartable(u.email)) {
    res.status(403).json({ code: "email_descartable", error: "Los correos temporales no están permitidos. Usa tu correo personal." });
    return null;
  }
  return u;
}
