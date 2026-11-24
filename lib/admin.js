// Quién es administrador: los correos de CDN_PERMITIDOS (separados por comas) en Vercel.
export const permitidos = () => String(process.env.CDN_PERMITIDOS || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
export const esAdmin = (u) => !!(u && u.email) && permitidos().includes(String(u.email).toLowerCase());
