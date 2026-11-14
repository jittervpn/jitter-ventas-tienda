// Pruebas de 1 hora del CDN con un servicio COMPARTIDO del administrador (no gasta créditos por prueba).
//  - Servicio de pruebas: cualquier servicio del admin cuyo nombre empiece por "prueba" (p. ej. /c402107prueba1).
//    Los clientes no pueden usar ese nombre al comprar.
//  - El admin da una prueba a un correo; el cliente la activa con su origen: el servicio apunta 1 hora a su servidor.
//  - Al vencer, el origen vuelve a REPOSO (por defecto example.com), donde no hay túnel posible.
//  - El registro vive en tu MySQL de cPanel (auth/pruebas.php), con peticiones firmadas con SESSION_SECRET.
import crypto from "node:crypto";
import { cdn, CAMPOS, listaServicios, mapService } from "./cdn.js";

export const DURACION_MS = 60 * 60 * 1000;
const URL = () => (process.env.PRUEBAS_URL || "https://jitterxcloud.shop/auth/pruebas.php").trim();
export const REPOSO = () => (process.env.CDN_PRUEBA_REPOSO || "example.com").trim().toLowerCase();
export const NOMBRE_RESERVADO = /^prueba/;
export const esDePruebas = (s) => /^\/c[0-9a-f]{6}prueba[a-z0-9]*$/.test(String(s.path || ""));

/** Llamada firmada al registro de pruebas en cPanel. */
export async function registro(datos) {
  const secret = (process.env.SESSION_SECRET || "").trim();
  const cuerpo = JSON.stringify(datos);
  const t = Math.floor(Date.now() / 1000);
  const v = crypto.createHmac("sha256", secret).update(`pruebas|${t}|${cuerpo}`).digest("hex");
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(URL(), { method: "POST", signal: ctl.signal, body: cuerpo, headers: { "content-type": "application/json", "x-jx-firma": `t=${t},v=${v}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || "registro de pruebas " + r.status), { status: r.status });
    return j;
  } finally { clearTimeout(tm); }
}

const aMs = (s) => (s ? Number(s) * 1000 : null);
export const mapPrueba = (r) => r && ({ id: Number(r.id), email: r.email, estado: r.estado, servicio: r.servicio || null, origen: r.origen || null,
  creada: aMs(r.creada), activada: aMs(r.activada), vence: aMs(r.vence) });

/** Servicios de pruebas y cuál está ocupado ahora. */
export async function poolEstado(servicios) {
  const pool = (servicios || listaServicios(await cdn("GET", "/v1/services"))).filter(esDePruebas);
  const { pruebas = [] } = await registro({ accion: "lista" });
  const activas = pruebas.map(mapPrueba).filter((p) => p.estado === "activa" && p.vence > Date.now());
  return pool.map((s) => ({ ...s, ocupadoPor: activas.find((p) => p.servicio === String(s.id)) || null }));
}

/** Cierra las pruebas vencidas: devuelve el origen a REPOSO y las marca como terminadas. Como mucho una vez por minuto. */
const st = (globalThis.__jxPruebas ||= { ultima: 0 });
export async function vencerPruebas({ forzar = false } = {}) {
  if (!forzar && Date.now() - st.ultima < 60000) return 0;
  st.ultima = Date.now();
  let n = 0;
  try {
    const { pruebas = [] } = await registro({ accion: "lista" });
    for (const p of pruebas.map(mapPrueba).filter((x) => x.estado === "activa" && x.vence <= Date.now())) {
      try {
        await cdn("PATCH", "/v1/services/" + encodeURIComponent(p.servicio) + "/origin", CAMPOS.origen(REPOSO()));
        await registro({ accion: "terminar", id: p.id });
        n++;
      } catch (e) { console.error("pruebas: no se pudo cerrar la prueba", p.id, e.codigo || "", e.message); }
    }
  } catch (e) { console.error("pruebas: registro no disponible", e.message); }
  return n;
}

/** Prueba pendiente o activa de un correo (o null). Incluye los datos del servicio si está activa. */
export async function miPrueba(email, servicios) {
  if (!email) return null;
  const { pruebas = [] } = await registro({ accion: "lista", email });
  const p = pruebas.map(mapPrueba).find((x) => x.estado === "pendiente" || (x.estado === "activa" && x.vence > Date.now()));
  if (!p) return null;
  if (p.estado === "activa") {
    const s = (servicios || []).find((x) => String(x.id) === p.servicio) || mapService(await cdn("GET", "/v1/services/" + encodeURIComponent(p.servicio)));
    return { ...p, host: s.host, path: s.path };
  }
  return p;
}
