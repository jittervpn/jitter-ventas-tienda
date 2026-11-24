// Login por código al correo (antes auth/request-code.php y auth/verify-code.php en cPanel).
//   POST {accion:"pedir",   email}       -> envía un código de 6 dígitos (vence en 10 min)
//   POST {accion:"verificar", email, code} -> devuelve {token, user}. 5 intentos por código; un solo uso.
// Los códigos se guardan solo como HMAC (nunca en claro) en Vercel Blob.
import crypto from "node:crypto";
import { cors } from "../../lib/cors.js";
import { limit, clientIp } from "../../lib/ratelimit.js";
import { esDescartable, uidDeEmail, crearToken } from "../../lib/auth.js";
import { actualizar } from "../../lib/kv.js";
import { enviarCodigo } from "../../lib/correo.js";
import { recordarCliente } from "../../lib/clientes.js";

const EMAIL_RE = /^[^\s@"<>(),;:\\]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i;
const VENCE_S = 600, MAX_INTENTOS = 5, MAX_FALLOS_DIA = 15; // tope de códigos incorrectos por correo y por hora (frena adivinar sin bloquear días enteros)
const MAX_DIA = () => parseInt(process.env.MAX_CODES_DAY || "400", 10);
const secreto = () => (process.env.SESSION_SECRET || "").trim();
const hashCodigo = (email, code) => crypto.createHmac("sha256", secreto()).update(email + ":" + code).digest("hex");
const doc = (email) => "codigos/" + crypto.createHash("sha256").update("jx:" + email).digest("hex").slice(0, 40) + ".json";
const fallo = (status, error) => Object.assign(new Error(error), { status, publico: true });

async function pedir(req, email) {
  if (limit(req, { max: 10, windowMs: 3600000, key: "ip:" + clientIp(req) })) throw fallo(429, "Demasiadas solicitudes desde tu red. Inténtalo más tarde.");
  if (limit(req, { max: MAX_DIA(), windowMs: 86400000, key: "dia" })) throw fallo(429, "Hoy se alcanzó el límite de códigos. Inténtalo mañana o escríbenos por Telegram.");
  const now = Math.floor(Date.now() / 1000);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  await actualizar(doc(email), (act) => {
    const envios = (act?.envios || []).filter((t) => now - t < 3600);
    if (envios.length && now - envios[envios.length - 1] < 60) throw fallo(429, "Espera un minuto antes de pedir otro código.");
    if (envios.length >= 6) throw fallo(429, "Ya pediste varios códigos para este correo. Espera una hora.");
    return { data: { h: hashCodigo(email, code), vence: now + VENCE_S, intentos: 0, envios: [...envios, now], dia: act?.dia, fallosHoy: act?.fallosHoy } };
  });
  try { await enviarCodigo(email, code); }
  catch (e) {
    console.error("auth: no se pudo enviar el correo:", e.message);
    await actualizar(doc(email), (act) => ({ data: act ? { ...act, h: null } : undefined })).catch(() => {});
    throw fallo(502, "No se pudo enviar el correo. Inténtalo de nuevo en un momento.");
  }
  return { ok: true, expira: VENCE_S };
}

async function verificar(req, email, code) {
  if (limit(req, { max: 20, windowMs: 60000, key: "v:" + clientIp(req) })) throw fallo(429, "Demasiados intentos. Espera un minuto.");
  const now = Math.floor(Date.now() / 1000);
  const r = await actualizar(doc(email), (act) => {
    const dia = Math.floor(now / 3600), fallosHoy = act && act.dia === dia ? act.fallosHoy || 0 : 0;
    if (fallosHoy >= MAX_FALLOS_DIA) throw fallo(429, "Demasiados códigos incorrectos para este correo. Espera una hora y pide uno nuevo.");
    if (!act || !act.h || act.vence < now) throw fallo(400, "El código venció o no existe. Pide uno nuevo.");
    if (act.intentos >= MAX_INTENTOS) return { data: { ...act, h: null }, resultado: { error: fallo(429, "Demasiados intentos. Pide un código nuevo.") } };
    const a = Buffer.from(act.h, "hex"), b = Buffer.from(hashCodigo(email, code), "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      const quedan = MAX_INTENTOS - 1 - act.intentos;
      return { data: { ...act, intentos: act.intentos + 1, dia, fallosHoy: fallosHoy + 1 }, resultado: { error: fallo(400, quedan > 0 ? `Código incorrecto. Te quedan ${quedan} intentos.` : "Código incorrecto. Pide un código nuevo.") } };
    }
    return { data: { ...act, h: null, intentos: 0 }, resultado: { ok: true } }; // un solo uso
  });
  if (r.error) throw r.error;
  const uid = uidDeEmail(email);
  try { await recordarCliente(uid, email); } catch (e) { console.error("auth: no se pudo anotar el cliente", e.message); } // para ver correos en /admin
  return { ok: true, token: crearToken(uid, email), user: { uid, email, nombre: null, verificado: true } };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  if (secreto().length < 32) return res.status(500).json({ error: "Falta SESSION_SECRET en Vercel." });
  let b = {};
  try { b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; } catch { return res.status(400).json({ error: "Datos inválidos." }); }
  const email = String(b.email || "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return res.status(400).json({ error: "El correo no tiene un formato válido." });
  if (esDescartable(email)) return res.status(400).json({ error: "Los correos temporales no están permitidos. Usa tu correo personal." });
  try {
    if (b.accion === "pedir") return res.status(200).json(await pedir(req, email));
    if (b.accion === "verificar") {
      const code = String(b.code || "").replace(/\D/g, "");
      if (code.length !== 6) return res.status(400).json({ error: "Escribe los 6 dígitos del código." });
      return res.status(200).json(await verificar(req, email, code));
    }
    return res.status(400).json({ error: "Acción no válida." });
  } catch (e) {
    if (e.publico) return res.status(e.status).json({ error: e.message });
    console.error("auth/codigo:", e.message);
    return res.status(502).json({ error: "No se pudo completar. Inténtalo de nuevo en un momento." });
  }
}
