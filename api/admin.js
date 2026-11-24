// /api/admin — panel de administración (jitterxcloud.shop/admin). Solo correos de CDN_PERMITIDOS.
//   GET  /api/admin                    -> resumen del negocio
//   GET  /api/admin?que=servicios      -> todos los servicios CDN de todos los clientes (con correo y tráfico)
//   GET  /api/admin?que=trafico&id=ID  -> diagnóstico: qué devuelve la API del CDN sobre tráfico de ese servicio
//   POST {accion:"precios", ars, usd}  -> cambia los precios
//   POST {accion:"renovar", id}        -> renueva 30 días SIN cobro cualquier servicio
// Las pruebas de 1 hora y crear sin cobro siguen en /api/cdn (ya restringidas al admin).
// Cada sección nueva del admin se añade aquí para no gastar funciones del plan (máximo 12).
import { cors } from "../lib/cors.js";
import { limit } from "../lib/ratelimit.js";
import { requireUser } from "../lib/auth.js";
import { esAdmin } from "../lib/admin.js";
import { cdn, listaServicios, mapService, mensaje, estadoHttp, operacionId } from "../lib/cdn.js";
import { registro, mapPrueba, esDePruebas } from "../lib/pruebas.js";
import { contadorCdn } from "../lib/contador.js";
import { traficoDe, diagnostico } from "../lib/trafico.js";
import { directorio } from "../lib/clientes.js";
import { ppActivo } from "../lib/paypal.js";
import { MONEDA, cargarPrecios, guardarPrecios, precioCdn, precioUsd } from "../lib/precios.js";

const seguro = async (fn) => { try { return await fn(); } catch (e) { return { error: e.message }; } };
const ID_RE = /^[\w.-]{3,80}$/;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  if (limit(req, { max: 60, windowMs: 60000 })) return res.status(429).json({ error: "Demasiadas peticiones. Espera un minuto." });
  const u = await requireUser(req, res); if (!u) return;
  if (!esAdmin(u)) return res.status(403).json({ error: "No tienes acceso al panel de administración." });
  const q = req.query || {};
  try {
    if (req.method === "POST") {
      let b = {};
      try { b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; } catch { return res.status(400).json({ error: "Datos inválidos." }); }
      if (b.accion === "precios") {
        const c = await guardarPrecios({ ars: b.ars, usd: b.usd }, u.email);
        console.log("admin: precios cambiados por", u.email, "->", c.ars, MONEDA, "/", c.usd, "USD");
        return res.status(200).json({ ok: true, precios: { ars: c.ars, usd: c.usd, moneda: MONEDA, actualizado: c.actualizado } });
      }
      if (b.accion === "renovar") {
        const id = String(b.id || "");
        if (!ID_RE.test(id)) return res.status(400).json({ error: "Servicio inválido." });
        const j = await cdn("POST", "/v1/services/" + encodeURIComponent(id) + "/renew", {}, { "idempotency-key": "adm-" + id + "-" + Math.floor(Date.now() / 120000) });
        console.log("admin: renovación sin cobro de", id, "por", u.email);
        return res.status(200).json({ ok: true, op: operacionId(j) || null });
      }
      return res.status(400).json({ error: "Acción no válida." });
    }
    if (req.method !== "GET") return res.status(405).json({ error: "Método no permitido" });

    if (q.que === "precios") {
      const c = await cargarPrecios({ forzar: true });
      return res.status(200).json({ ars: c.ars, usd: c.usd, moneda: MONEDA, paypal: ppActivo(), actualizado: c.actualizado, por: c.por });
    }
    if (q.que === "trafico") {
      if (!ID_RE.test(String(q.id || ""))) return res.status(400).json({ error: "Servicio inválido." });
      const crudo = await seguro(() => cdn("GET", "/v1/services/" + encodeURIComponent(q.id)));
      return res.status(200).json({ servicio: JSON.stringify(crudo).slice(0, 3000), enServicio: mapService(crudo).trafico, endpoints: await diagnostico(q.id) });
    }
    if (q.que === "servicios") {
      const [lista, dir] = await Promise.all([cdn("GET", "/v1/services").then(listaServicios), seguro(directorio)]);
      const sv = lista.filter((s) => !esDePruebas(s));
      await Promise.all(sv.map(async (s) => { s.trafico = await traficoDe(s.id, s.trafico).catch(() => null); }));
      return res.status(200).json({
        servicios: sv.map((s) => { const p = (String(s.path).match(/^\/(c[0-9a-f]{6})/) || [])[1]; return { ...s, prefijo: p || null, email: (p && dir && dir[p] && dir[p].email) || null }; })
          .sort((a, b) => (a.expira || 0) - (b.expira || 0)),
      });
    }

    // resumen
    await cargarPrecios();
    const [saldo, servicios, pruebas, contador] = await Promise.all([
      seguro(() => cdn("GET", "/v1/balance")),
      seguro(async () => listaServicios(await cdn("GET", "/v1/services"))),
      seguro(async () => (await registro({ accion: "lista" })).pruebas.map(mapPrueba)),
      seguro(() => contadorCdn()),
    ]);
    const sv = Array.isArray(servicios) ? servicios.filter((s) => !esDePruebas(s)) : [];
    const ahora = Date.now(), en7 = ahora + 7 * 864e5;
    const pr = Array.isArray(pruebas) ? pruebas : [];
    const bytes = sv.reduce((t, s) => t + (s.trafico?.bytes || 0), 0);
    return res.status(200).json({
      admin: { email: u.email },
      saldo,
      cdn: {
        servicios: sv.length,
        clientes: contador?.clientes ?? null,
        activos: contador?.activos ?? null,
        vencenPronto: sv.filter((s) => s.expira && s.expira > ahora && s.expira < en7).length,
        trafico: sv.some((s) => s.trafico) ? bytes : null,
        error: servicios?.error,
      },
      pruebas: { activas: pr.filter((p) => p.estado === "activa" && p.vence > ahora).length, pendientes: pr.filter((p) => p.estado === "pendiente").length, total: pr.length, error: pruebas?.error },
      precios: { tarjeta: precioCdn(), moneda: MONEDA, paypal: ppActivo() ? precioUsd() : null },
    });
  } catch (e) {
    const c = e.codigo;
    if (e.status && e.status < 500 && !c) return res.status(e.status).json({ error: e.message });
    console.error("api/admin:", c || "", e.message);
    return res.status(c ? estadoHttp(c) : 502).json({ error: c ? mensaje(c) + " (" + e.message + ")" : "No se pudo completar. " + e.message });
  }
}
