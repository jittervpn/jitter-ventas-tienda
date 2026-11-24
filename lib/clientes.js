// Directorio de clientes para /admin: prefijo del CDN (/cXXXXXX) -> correo y último acceso.
// El prefijo sale de un hash del correo y no se puede revertir; por eso se anota al iniciar sesión.
import { leer, actualizar } from "./kv.js";
import { prefijo } from "./cdn.js";

const DOC = "clientes.json";

export async function recordarCliente(uid, email) {
  const p = prefijo(uid), ahora = Date.now();
  await actualizar(DOC, (act) => {
    const d = act && typeof act === "object" ? act : {};
    const prev = d[p];
    if (prev && prev.email === email && ahora - (prev.visto || 0) < 6 * 3600000) return { data: undefined }; // no escribir en cada login
    return { data: { ...d, [p]: { email, alta: prev?.alta || ahora, visto: ahora } } };
  });
}

/** { cXXXXXX: {email, alta, visto} } */
export async function directorio() {
  const r = await leer(DOC);
  return r?.data && typeof r.data === "object" ? r.data : {};
}
