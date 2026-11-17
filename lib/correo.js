// Envío del código de acceso por Gmail SMTP (igual que hacía smtp.php en cPanel).
// Variables en Vercel: SMTP_USER (tu Gmail), SMTP_PASS (contraseña de aplicación de Google, 16 letras),
// opcionales SMTP_HOST (smtp.gmail.com), SMTP_PORT (465), MAIL_FROM_NAME (Jitterx Panel Cloud).
import nodemailer from "nodemailer";

let tr = null;
function transporte() {
  const user = (process.env.SMTP_USER || "").trim(), pass = (process.env.SMTP_PASS || "").replace(/\s+/g, "");
  if (!user || !pass) throw new Error("Faltan SMTP_USER / SMTP_PASS en Vercel.");
  const port = Number(process.env.SMTP_PORT || 465);
  return (tr ||= nodemailer.createTransport({
    host: (process.env.SMTP_HOST || "smtp.gmail.com").trim(), port, secure: port === 465,
    auth: { user, pass }, connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000,
  }));
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export async function enviarCodigo(email, code) {
  const nombre = (process.env.MAIL_FROM_NAME || "Jitterx Panel Cloud").trim();
  const from = (process.env.MAIL_FROM_ADDR || process.env.SMTP_USER || "").trim();
  const texto = `Tu código de acceso a ${nombre} es ${code}.\nVence en 10 minutos y solo funciona una vez.\nSi no lo pediste, ignora este mensaje.`;
  const html = '<!doctype html><html lang="es"><body style="margin:0;background:#0a0f1c"><div style="background:#0a0f1c;padding:32px 16px;font-family:Segoe UI,Arial,sans-serif">'
    + '<div style="max-width:460px;margin:0 auto;background:#111a2e;border:1px solid #1f2c49;border-radius:16px;padding:32px;color:#eef2fb">'
    + `<div style="font-size:18px;font-weight:800;color:#22d3ee">${esc(nombre)}</div>`
    + '<h1 style="font-size:22px;margin:22px 0 8px;color:#eef2fb">Tu código de acceso</h1>'
    + '<p style="margin:0 0 22px;color:#aab6d3;font-size:15px;line-height:1.6">Escribe este código en la web para entrar a tu cuenta:</p>'
    + `<div style="background:#0e1526;border:1px solid #2b3a5e;border-radius:12px;padding:18px;text-align:center;font:700 34px 'Courier New',monospace;letter-spacing:10px;color:#22d3ee">${code}</div>`
    + '<p style="margin:22px 0 0;color:#aab6d3;font-size:14px;line-height:1.6">Vence en <b style="color:#eef2fb">10 minutos</b> y solo funciona una vez.</p>'
    + `<p style="margin:18px 0 0;color:#6b7a9c;font-size:12px;line-height:1.6;border-top:1px solid #1f2c49;padding-top:16px">Pediste este código con ${esc(email)}. Si no fuiste tú, ignora este mensaje: nadie puede entrar sin el código.<br>Nunca te pediremos este código por Telegram ni por ningún otro medio.</p>`
    + "</div></div></body></html>";
  await transporte().sendMail({
    from: { name: nombre, address: from }, replyTo: from, to: email,
    subject: `${code} es tu código de ${nombre}`, text: texto, html,
    headers: { "X-Auto-Response-Suppress": "All", "Auto-Submitted": "auto-generated" },
  });
}
