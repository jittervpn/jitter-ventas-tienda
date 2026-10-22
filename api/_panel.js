// Uso interno en tu backend (NO es una ruta pública). Trae IP, puerto,
// usuario y contraseña root para crear cuentas SSH.
// Ejemplo: import { getServer } from "./_panel.js"; const s = await getServer(id);
const PANEL = "https://paneladminjitterx.lovable.app/api/public/catalog";

export async function getCatalog() {
  const r = await fetch(PANEL, {
    headers: { "x-api-key": process.env.PANEL_API_KEY },
    cache: "no-store",
  });
  if (!r.ok) throw new Error("Panel no disponible");
  return r.json();
}

export async function getServer(id) {
  const { servers } = await getCatalog();
  return servers.find((s) => s.id === id) || null;
}