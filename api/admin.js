// /api/admin — panel de administración (jitterxcloud.shop/admin). Solo correos de CDN_PERMITIDOS.
//   GET /api/admin -> resumen del negocio
// Cada sección nueva del admin se añade aquí como ?que=... para no gastar funciones del plan (máximo 12).
import { cors } from "../lib/cors.js";
import { limit } from "../lib/ratelimit.js";
import { requireUser } from "../lib/auth.js";
import { esAdmin } from "../lib/admin.js";
import { cdn, listaServicios } from "../lib/cdn.js";
import { registro, mapPrueba, esDePruebas } from "../lib/pruebas.js";
import { contadorCdn } from "../lib/contador.js";
import { ppActivo, ppPrecio } from "../lib/paypal.js";
import { CATALOGO, MONEDA, PLAN_CDN } from "../lib/precios.js";

const seguro = async (fn) => { try { return await fn(); } catch (e) { return { error: e.message }; } };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  if (limit(req, { max: 60, windowMs: 60000 })) return res.status(429).json({ error: "Demasiadas peticiones. Espera un minuto." });
  const u = await requireUser(req, res); if (!u) return;
  if (!esAdmin(u)) return res.status(403).json({ error: "No tienes acceso al panel de administración." });
  if (req.method !== "GET") return res.status(405).json({ error: "Método no permitido" });

  const [saldo, servicios, pruebas, contador] = await Promise.all([
    seguro(() => cdn("GET", "/v1/balance")),
    seguro(async () => listaServicios(await cdn("GET", "/v1/services"))),
    seguro(async () => (await registro({ accion: "lista" })).pruebas.map(mapPrueba)),
    seguro(() => contadorCdn()),
  ]);
  const sv = Array.isArray(servicios) ? servicios.filter((s) => !esDePruebas(s)) : [];
  const ahora = Date.now(), en7 = ahora + 7 * 864e5;
  const pr = Array.isArray(pruebas) ? pruebas : [];
  const item = CATALOGO.find((c) => c.id === PLAN_CDN);
  return res.status(200).json({
    admin: { email: u.email },
    saldo,
    cdn: {
      servicios: sv.length,
      clientes: contador?.clientes ?? null,
      activos: contador?.activos ?? null,
      vencenPronto: sv.filter((s) => s.expira && s.expira > ahora && s.expira < en7).length,
      error: servicios?.error,
    },
    pruebas: { activas: pr.filter((p) => p.estado === "activa" && p.vence > ahora).length, pendientes: pr.filter((p) => p.estado === "pendiente").length, total: pr.length, error: pruebas?.error },
    precios: { tarjeta: item?.precio ?? null, moneda: MONEDA, paypal: ppActivo() ? ppPrecio() : null },
  });
}
