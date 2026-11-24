// Cupones de descuento del CDN.
//  - Campaña: precio con cupón (ARS y USD) y fecha de fin (por defecto, fin de este mes en hora de Argentina).
//  - El cliente pulsa «Reclamar mi cupón» en la web -> queda PENDIENTE con su correo.
//  - El admin lo activa en /admin (o escribe un correo y lo activa directo) -> ACTIVO y se le avisa por correo.
//  - Sirve para UN pago (compra o renovación) antes de que termine la campaña -> USADO.
// Todo vive en Blob (cupones.json).
import { leer, actualizar } from "./kv.js";
import { uidDeEmail } from "./auth.js";
import { precioCdn, precioUsd, cargarPrecios } from "./precios.js";

const DOC = "cupones.json";
const EMAIL_RE = /^[^\s@"<>(),;:\\]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i;
const fallo = (status, msg) => Object.assign(new Error(msg), { status });
const st = (globalThis.__jxCupones ||= { t: 0, d: null });

/** Fin del mes actual en Argentina (UTC-3): el 1 del mes siguiente a las 00:00 ART. */
export function finDeMes(ahora = Date.now()) {
  const ar = new Date(ahora - 3 * 3600000);
  return Date.UTC(ar.getUTCFullYear(), ar.getUTCMonth() + 1, 1, 3, 0, 0);
}
const campanaPorDefecto = () => ({ activa: true, ars: 12000, usd: 10.5, hasta: finDeMes() });

async function datos({ forzar = false } = {}) {
  if (!forzar && st.d && Date.now() - st.t < 15000) return st.d;
  const r = await leer(DOC);
  const d = r?.data && typeof r.data === "object" ? r.data : {};
  st.d = { campana: { ...campanaPorDefecto(), ...(d.campana || {}) }, lista: Array.isArray(d.lista) ? d.lista : [], seq: d.seq || 0 };
  st.t = Date.now();
  return st.d;
}
function cambiar(fn) {
  return actualizar(DOC, (act) => {
    const d = { campana: { ...campanaPorDefecto(), ...(act?.campana || {}) }, lista: Array.isArray(act?.lista) ? act.lista : [], seq: act?.seq || 0 };
    const r = fn(d);
    if (r && r.guardar === false) return { resultado: r.resultado };
    d.lista = d.lista.slice(-500);
    return { data: d, resultado: r?.resultado };
  }).finally(() => { st.t = 0; });
}

export const campanaVigente = (c) => !!(c && c.activa && c.hasta > Date.now());
const vigente = (c, k) => k && k.estado === "activo" && k.hasta > Date.now() && campanaVigente(c);

/** Campaña pública (para el aviso de la web) o null si no hay. */
export async function campanaPublica() {
  try { const { campana } = await datos(); return campanaVigente(campana) ? { ars: campana.ars, usd: campana.usd, hasta: campana.hasta } : null; }
  catch { return null; }
}

/** Cupón del cliente (el más reciente) + campaña. */
export async function cuponDe(uid) {
  const { campana, lista } = await datos();
  const k = [...lista].reverse().find((x) => x.uid === uid);
  const c = campanaVigente(campana) ? { ars: campana.ars, usd: campana.usd, hasta: campana.hasta } : null;
  if (!k) return { campana: c, cupon: null };
  const estado = k.estado === "activo" && !vigente(campana, k) ? "vencido" : k.estado;
  return { campana: c, cupon: { estado, ars: k.ars, usd: k.usd, hasta: k.hasta, pedido: k.pedido, activado: k.activado || null } };
}

/** Precio que paga este cliente ahora: con cupón activo o normal. */
export async function precioPara(uid) {
  await cargarPrecios();
  const normal = { ars: precioCdn(), usd: precioUsd(), cupon: false };
  try {
    const { campana, lista } = await datos({ forzar: true });
    const k = [...lista].reverse().find((x) => x.uid === uid && vigente(campana, x));
    if (k && k.ars < normal.ars) return { ars: k.ars, usd: Math.min(k.usd, normal.usd), cupon: true };
  } catch (e) { console.error("cupones: no se pudo leer", e.message); }
  return normal;
}

/** ¿Este importe corresponde al cupón de ese cliente? (también si ya se marcó usado por un pago de estos minutos) */
export async function importeConCupon(uid, monto, moneda) {
  try {
    const { lista } = await datos({ forzar: true });
    const campo = moneda === "USD" ? "usd" : "ars";
    return lista.some((k) => k.uid === uid && (k.estado === "activo" || k.estado === "usado") && k.hasta > Date.now() - 48 * 3600000 && Math.abs(Number(k[campo]) - Number(monto)) <= 0.01);
  } catch { return false; }
}

/** Marca el cupón como usado tras entregar un pago con descuento. */
export function marcarUsado(uid, pago) {
  return cambiar((d) => {
    const k = [...d.lista].reverse().find((x) => x.uid === uid && x.estado === "activo");
    if (!k) return { guardar: false };
    Object.assign(k, { estado: "usado", usado: Date.now(), pago: String(pago) });
    return {};
  }).catch((e) => console.error("cupones: no se pudo marcar usado", uid, e.message));
}

/** El cliente reclama su cupón (queda pendiente para que el admin lo active). */
export function reclamar(uid, email) {
  return cambiar((d) => {
    if (!campanaVigente(d.campana)) throw fallo(400, "Ahora mismo no hay cupones disponibles.");
    const ya = d.lista.find((x) => x.uid === uid && x.hasta > Date.now() && ["pendiente", "activo", "usado"].includes(x.estado));
    if (ya) return { guardar: false, resultado: { estado: ya.estado, existia: true } };
    d.lista.push({ id: ++d.seq, uid, email, estado: "pendiente", pedido: Date.now(), ars: d.campana.ars, usd: d.campana.usd, hasta: d.campana.hasta });
    return { resultado: { estado: "pendiente" } };
  });
}

// ---------- admin ----------
export async function listaAdmin() {
  const { campana, lista } = await datos({ forzar: true });
  const ahora = Date.now();
  return { campana, cupones: [...lista].reverse().slice(0, 300).map((k) => ({ ...k, estado: k.estado === "activo" && !vigente(campana, k) ? "vencido" : k.estado, uid: undefined })), ahora };
}

/** Activa por correo (Gmail u otro): si había pedido pendiente lo activa; si no, crea uno ya activo. */
export function activar(email, admin) {
  email = String(email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return Promise.reject(fallo(400, "Correo inválido."));
  const uid = uidDeEmail(email);
  return cambiar((d) => {
    if (!campanaVigente(d.campana)) throw fallo(400, "La campaña de cupones está cerrada o vencida. Ábrela o cambia la fecha en esta misma sección.");
    let k = [...d.lista].reverse().find((x) => x.uid === uid && x.hasta > Date.now() && ["pendiente", "activo"].includes(x.estado));
    if (k && k.estado === "activo") return { guardar: false, resultado: { ya: true, cupon: k } };
    if (!k) { k = { id: ++d.seq, uid, email, pedido: null }; d.lista.push(k); }
    Object.assign(k, { estado: "activo", activado: Date.now(), por: admin || null, ars: d.campana.ars, usd: d.campana.usd, hasta: d.campana.hasta });
    return { resultado: { cupon: k } };
  });
}

export function rechazar(id) {
  return cambiar((d) => {
    const k = d.lista.find((x) => x.id === Number(id) && (x.estado === "pendiente" || x.estado === "activo"));
    if (!k) return { guardar: false, resultado: { ok: true } };
    k.estado = "rechazado"; k.rechazado = Date.now();
    return { resultado: { ok: true } };
  });
}

export function guardarCampana({ activa, ars, usd, hasta }) {
  const a = Math.round(Number(ars)), u = Math.round(Number(usd) * 100) / 100, h = Number(hasta);
  if (!(a >= 100 && a <= 10000000)) return Promise.reject(fallo(400, "El precio con cupón en ARS no es válido."));
  if (!(u >= 1 && u <= 1000)) return Promise.reject(fallo(400, "El precio con cupón en USD no es válido."));
  if (!(h > Date.now() - 864e5 && h < Date.now() + 400 * 864e5)) return Promise.reject(fallo(400, "La fecha de fin no es válida."));
  return cambiar((d) => {
    d.campana = { activa: !!activa, ars: a, usd: u, hasta: h };
    // los cupones ya activos o pendientes siguen la campaña (precio y fecha nuevos)
    for (const k of d.lista) if (k.estado === "pendiente" || k.estado === "activo") Object.assign(k, { ars: a, usd: u, hasta: h });
    return { resultado: { campana: d.campana } };
  });
}
