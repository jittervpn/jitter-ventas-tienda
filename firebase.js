// Firebase Admin en el servidor: verifica tokens y da acceso a Firestore.
// Requiere la variable FIREBASE_SERVICE_ACCOUNT en Vercel (el JSON completo).
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

let ready = false;

function init() {
  if (ready || getApps().length) { ready = true; return; }
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
  if (!raw) throw new Error("Falta la variable FIREBASE_SERVICE_ACCOUNT en Vercel.");
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT no es un JSON válido.");
  }
  // Vercel guarda los saltos de línea escapados
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  initializeApp({ credential: cert(creds) });
  ready = true;
}

export function auth() { init(); return getAuth(); }
export function fs() { init(); return getFirestore(); }

/** Devuelve el usuario autenticado a partir del token, o null. */
export async function currentUser(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return null;
  try {
    const d = await auth().verifyIdToken(token);
    return { uid: d.uid, email: d.email || null, nombre: d.name || null, verificado: !!d.email_verified };
  } catch {
    return null;
  }
}

/** Perfil en Firestore; lo crea la primera vez. */
export async function profile(user) {
  const ref = fs().collection("usuarios").doc(user.uid);
  const snap = await ref.get();
  if (!snap.exists) {
    const nuevo = {
      email: user.email, nombre: user.nombre,
      creado_en: new Date().toISOString(), bloqueado: false,
    };
    await ref.set(nuevo);
    return { uid: user.uid, ...nuevo };
  }
  return { uid: user.uid, ...snap.data() };
}

/** Para rutas protegidas: responde 401 y devuelve null si no hay sesión válida. */
export async function requireUser(req, res) {
  let u = null;
  try {
    u = await currentUser(req);
  } catch (e) {
    res.status(500).json({ error: e.message });
    return null;
  }
  if (!u) { res.status(401).json({ error: "Inicia sesión para continuar." }); return null; }
  const p = await profile(u);
  if (p.bloqueado) { res.status(403).json({ error: "Esta cuenta está suspendida." }); return null; }
  return { ...u, perfil: p };
}
