// Uso interno en tu backend (NO es una ruta pública). Trae IP, puerto,
// usuario y contraseña root para crear cuentas SSH.
// Ejemplo: import { getServer } from "./_panel.js"; const s = await getServer(id);
import { cargarPanel } from "../lib/panel.js";

export async function getCatalog() {
  const d = await cargarPanel();
  if (!d) throw new Error("Panel no disponible");
  return d;
}

export async function getServer(id) {
  const { servers } = await getCatalog();
  return servers.find((s) => s.id === String(id)) || null;
}
