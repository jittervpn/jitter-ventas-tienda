// Devuelve el usuario si el token de sesión es válido. Si trae un token que se rechaza, añade "reason" (diagnóstico).
import { currentUser, motivoRechazo } from "../../lib/auth.js";

import { cors } from "../../lib/cors.js";
export default async function handler(req, res) {
  if (cors(req, res)) return;
  const u = await currentUser(req);
  const h = req.headers.authorization || "";
  const reason = !u && h.startsWith("Bearer ") ? motivoRechazo(h.slice(7)) : undefined;
  res.status(200).json({
    user: u ? { uid: u.uid, email: u.email, nombre: u.nombre, verificado: !!u.verificado } : null,
    ...(reason ? { reason } : {}),
  });
}
