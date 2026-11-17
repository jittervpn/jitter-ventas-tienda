// Pruebas de 1 hora del CDN con un servicio COMPARTIDO del administrador (no gasta créditos por prueba).
//  - Servicio de pruebas: cualquier servicio del admin cuyo nombre empiece por "prueba" (p. ej. /c402107prueba1).
//    Los clientes no pueden usar ese nombre al comprar.
//  - El admin da una prueba a un correo; el cliente la activa con su origen: el servicio apunta 1 hora a su servidor.
//  - Al vencer, el origen vuelve a REPOSO (por defecto example.com), donde no hay túnel posible.
//  - El registro vive en Vercel Blob (lib/kv.js).
import { leer, actualizar } from "./kv.js";
import { cdn, CAMPOS, listaServicios, mapService } from "./cdn.js";

export const DURACION_MS = 60 * 60 * 1000;
export const REPOSO = () => (process.env.CDN_PRUEBA_REPOSO || "example.com").trim().toLowerCase();
export const NOMBRE_RESERVADO = /^prueba/;
export const esDePruebas = (s) => /^\/c[0-9a-f]{6}prueba[a-z0-9]*$/.test(String(s.path || ""));

// Registro en Vercel Blob (documento "pruebas.json"), con las mismas acciones que tenía auth/pruebas.php en cPanel.
// Las fechas se guardan en segundos unix (como antes), mapPrueba las pasa a milisegundos.
const DOC = "pruebas.json";
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
const SERV_RE = /^[\w.-]{3,80}$/;
const cache = (globalThis.__jxPruebasCache ||= { t: 0, data: null });
const fallo = (status, msg) => Object.assign(new Error(msg), { status });

async function lista() {
  if (cache.data && Date.now() - cache.t < 15000) return cache.data; // ahorra lecturas del Blob
  const r = await leer(DOC);
  cache.data = r?.data?.pruebas ? r.data : { seq: 0, pruebas: [] };
  cache.t = Date.now();
  return cache.data;
}

/** Acciones: lista | crear | activar | terminar | liberar | cancelar (mismo contrato que el antiguo PHP). */
export async function registro(d = {}) {
  const now = Math.floor(Date.now() / 1000);
  const email = String(d.email || "").trim().toLowerCase();
  const id = Number(d.id) || 0;
  if (d.accion === "lista") {
    const { pruebas } = await lista();
    const ord = [...pruebas].sort((a, b) => b.id - a.id);
    return { ok: true, pruebas: email ? ord.filter((p) => p.email === email).slice(0, 20) : ord.slice(0, 200) };
  }
  const cambiar = (fn) => actualizar(DOC, (act) => {
    const doc = act?.pruebas ? act : { seq: 0, pruebas: [] };
    const r = fn(doc);
    if (r.guardar === false) return { resultado: r.resultado };
    doc.pruebas = doc.pruebas.sort((a, b) => b.id - a.id).slice(0, 300); // se guardan las últimas 300
    return { data: doc, resultado: r.resultado };
  }).finally(() => { cache.t = 0; });

  switch (d.accion) {
    case "crear":
      if (!EMAIL_RE.test(email) || email.length > 254) throw fallo(400, "Correo inválido");
      return cambiar((doc) => {
        const ya = doc.pruebas.find((p) => p.email === email && (p.estado === "pendiente" || (p.estado === "activa" && p.vence > now)));
        if (ya) return { guardar: false, resultado: { ok: true, prueba: ya, existia: true } };
        const p = { id: ++doc.seq, email, estado: "pendiente", servicio: null, origen: null, creada: now, activada: null, vence: null };
        doc.pruebas.push(p);
        return { resultado: { ok: true, prueba: p } };
      });
    case "activar": {
      const serv = String(d.servicio || ""), origen = String(d.origen || ""), vence = Number(d.vence) || 0;
      if (!SERV_RE.test(serv) || !origen || origen.length > 253 || vence <= now || vence > now + 86400) throw fallo(400, "Datos inválidos");
      return cambiar((doc) => {
        if (doc.pruebas.some((p) => p.estado === "activa" && p.servicio === serv && p.vence > now)) throw fallo(409, "Ocupado");
        const p = doc.pruebas.find((x) => x.id === id && x.email === email && x.estado === "pendiente");
        if (!p) throw fallo(409, "La prueba no está pendiente");
        Object.assign(p, { estado: "activa", servicio: serv, origen, activada: now, vence });
        return { resultado: { ok: true } };
      });
    }
    case "terminar":
    case "liberar":
    case "cancelar":
      return cambiar((doc) => {
        const p = doc.pruebas.find((x) => x.id === id && x.estado === (d.accion === "cancelar" ? "pendiente" : "activa"));
        if (!p) return { guardar: false, resultado: { ok: true } };
        if (d.accion === "terminar") p.estado = "terminada";
        else if (d.accion === "cancelar") p.estado = "cancelada";
        else Object.assign(p, { estado: "pendiente", servicio: null, origen: null, activada: null, vence: null });
        return { resultado: { ok: true } };
      });
  }
  throw fallo(400, "Acción no válida");
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
        await cdn("PATCH", "/v1/services/" + encodeURIComponent(p.servicio) + "/origin", CAMPOS.origen(REPOSO()), { "idempotency-key": `reposo-${p.id}-${p.vence}` });
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
