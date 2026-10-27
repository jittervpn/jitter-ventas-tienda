// Lee VPS, dominios y planes desde Jitter Panel. Si el panel no responde, la tienda usa las variables de Vercel.
const URL_DEF = "https://jitterxpanelcloud.lovable.app/api/public/catalog";
const TTL = 30000;
const st = (globalThis.__jxPanel ||= { data: null, at: 0 });

export async function cargarPanel() {
  const key = (process.env.PANEL_API_KEY || "").trim();
  if (!key) return null;
  if (st.data && Date.now() - st.at < TTL) return st.data;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch((process.env.PANEL_URL || URL_DEF).trim(), { headers: { "x-api-key": key }, cache: "no-store", signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error("Panel respondió " + r.status);
    st.data = await r.json();
    st.at = Date.now();
  } catch (e) {
    console.warn("Panel no disponible:", e.message);
  }
  return st.data;
}
export const panel = () => st.data;
export const panelServers = () => (st.data?.servers?.length ? st.data.servers : null);
export const panelPlans = () => (st.data?.plans?.length ? st.data.plans : null);
export const panelDomain = () => {
  const d = st.data?.domains || [];
  return d.find((x) => x.principal) || d[0] || null;
};
