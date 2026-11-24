// Tráfico de cada servicio CDN.
// La documentación de la API no dice dónde está el tráfico, así que se detecta solo:
//  1) campos del propio servicio (bytes, traffic, bandwidth, transfer, requests, usage…), a cualquier profundidad;
//  2) si no hay, se prueba una vez cada endpoint candidato (/v1/services/ID/usage, /stats, /traffic, /metrics, /analytics)
//     y se recuerda el que funcione. Desde /admin → «API del CDN» se ve qué devolvió cada uno.
// Si la API no da tráfico, todo devuelve null y la web simplemente no muestra la línea.
import { cdn, extraerTrafico as extraer } from "./cdn.js";

const CANDIDATOS = ["usage", "stats", "traffic", "metrics", "analytics", "bandwidth"];
const st = (globalThis.__jxTrafico ||= { endpoint: undefined, reintentar: 0, cache: new Map() });

/** Tráfico de un servicio. `crudo` es el objeto del servicio tal como lo devolvió la API (si lo tienes). */
export async function traficoDe(id, directo) {
  if (directo) return directo; // ya venía en el propio servicio (mapService → .trafico)
  if (st.endpoint === null && Date.now() < st.reintentar) return null; // ya se probó y la API no tiene endpoint de tráfico (se reintenta cada hora)
  const c = st.cache.get(id);
  if (c && Date.now() - c.t < 300000) return c.v;
  const probar = st.endpoint ? [st.endpoint] : CANDIDATOS;
  for (const ep of probar) {
    try {
      const j = await cdn("GET", `/v1/services/${encodeURIComponent(id)}/${ep}`);
      const v = extraer(j);
      if (v) { st.endpoint = ep; st.cache.set(id, { t: Date.now(), v }); return v; }
    } catch { /* 404 / no existe: se prueba el siguiente */ }
  }
  if (!st.endpoint) { st.endpoint = null; st.reintentar = Date.now() + 3600000; }
  st.cache.set(id, { t: Date.now(), v: null });
  return null;
}

/** Diagnóstico para /admin: qué devuelve cada endpoint candidato para un servicio. */
export async function diagnostico(id) {
  const out = [];
  for (const ep of CANDIDATOS) {
    try { const j = await cdn("GET", `/v1/services/${encodeURIComponent(id)}/${ep}`); out.push({ endpoint: ep, ok: true, trafico: extraer(j), respuesta: JSON.stringify(j).slice(0, 1500) }); }
    catch (e) { out.push({ endpoint: ep, ok: false, error: (e.codigo || "") + " " + (e.status || "") + " " + String(e.message || "").slice(0, 200) }); }
  }
  return out;
}
