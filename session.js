// Verifica el token de Firebase y devuelve el perfil (creándolo la primera vez).
import { currentUser, profile } from "../../lib/firebase.js";

export default async function handler(req, res) {
  try {
    const u = await currentUser(req);
    if (!u) return res.status(200).json({ user: null });
    const p = await profile(u);
    if (p.bloqueado) return res.status(403).json({ error: "Esta cuenta está suspendida.", user: null });
    res.status(200).json({ user: { uid: u.uid, email: u.email, nombre: p.nombre || u.nombre } });
  } catch (e) {
    res.status(500).json({ error: e.message, user: null });
  }
}
