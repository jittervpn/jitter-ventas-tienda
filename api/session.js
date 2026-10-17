// Devuelve el usuario si el token de Firebase es válido.
import { currentUser } from "../../lib/fbverify.js";

export default async function handler(req, res) {
  const u = await currentUser(req);
  res.status(200).json({ user: u ? { uid: u.uid, email: u.email, nombre: u.nombre } : null });
}
