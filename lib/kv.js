// Almacén pequeño de documentos JSON en Vercel Blob (privado). Sustituye al MySQL de cPanel.
// Cada documento es un archivo; las escrituras usan el ETag (ifMatch) para que dos peticiones a la vez
// no se pisen: si otra escribió antes, se vuelve a leer y se reintenta.
// Necesita BLOB_READ_WRITE_TOKEN (Vercel la crea al conectar el Blob store al proyecto).
import { get, put, del, head, BlobNotFoundError } from "@vercel/blob";

const PREFIJO = "jx/";
const ok = () => !!(process.env.BLOB_READ_WRITE_TOKEN || "").trim();

/** Lee un documento: {data, etag} o null si no existe.
 * El ETag para escribir sale de head() (la API de Blob): el de la descarga viene en otro formato y
 * hacía fallar siempre las escrituras con «Precondition failed: ETag mismatch». */
export async function leer(nombre) {
  if (!ok()) throw new Error("Falta BLOB_READ_WRITE_TOKEN en Vercel (conecta un Blob store al proyecto).");
  for (let i = 0; i < 3; i++) {
    let h;
    try { h = await head(PREFIJO + nombre); }
    catch (e) { if (e instanceof BlobNotFoundError || /not.?found|404/i.test(String(e?.message) + e?.name)) return null; throw e; }
    const r = await get(PREFIJO + nombre, { access: "private", useCache: false });
    if (!r || r.statusCode !== 200) return null;
    // si la descarga es más vieja que lo que dice head (caché), se vuelve a leer
    const lm = Date.parse(r.headers?.get?.("last-modified") || "") || 0;
    if (lm && h.uploadedAt && lm < h.uploadedAt.getTime() - 1000) { if (i === 2) throw new Error("Blob devolvió una versión vieja; inténtalo de nuevo."); await new Promise((ok2) => setTimeout(ok2, 150)); continue; }
    const txt = await new Response(r.stream).text();
    try { return { data: JSON.parse(txt), etag: h.etag }; } catch { return { data: null, etag: h.etag }; }
  }
  return null;
}

async function escribir(nombre, data, etag) {
  const opts = { access: "private", contentType: "application/json", addRandomSuffix: false, cacheControlMaxAge: 60 };
  if (etag) Object.assign(opts, { allowOverwrite: true, ifMatch: etag });
  else opts.allowOverwrite = false; // solo crea si no existe
  const r = await put(PREFIJO + nombre, JSON.stringify(data), opts);
  return r.etag;
}

const esConflicto = (e) => /precondition|already exists|etag|412|409/i.test(String(e?.message || "") + " " + (e?.name || "") + " " + (e?.constructor?.name || "") + " " + (e?.status || ""));

/**
 * Lee, modifica y guarda un documento de forma segura frente a peticiones simultáneas.
 * fn(dataActual|null) devuelve {data, resultado}; si data es undefined no se escribe nada.
 */
export async function actualizar(nombre, fn, intentos = 5) {
  for (let i = 0; ; i++) {
    const act = await leer(nombre);
    const { data, resultado } = await fn(act ? act.data : null);
    if (data === undefined) return resultado;
    try { await escribir(nombre, data, act?.etag); return resultado; }
    catch (e) {
      if (i >= intentos - 1 || !esConflicto(e)) throw e;
      await new Promise((r) => setTimeout(r, 80 + Math.random() * 200));
    }
  }
}

export async function borrar(nombre) {
  try { await del(PREFIJO + nombre); } catch {}
}
