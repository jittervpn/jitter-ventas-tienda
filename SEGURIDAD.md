# Revisión de seguridad — Jitterx Panel Cloud

## Corregido en el código
- **DNS gratis:** ya no acepta IPs privadas/reservadas (10.x, 127.x, 192.168.x, 172.16-31.x, 169.254.x, CGNAT, multicast) y un JSON roto ya no da error 500.
- **Errores públicos:** `/api/ssh` ya no revela el dominio ni el puerto del VPS cuando está caído (solo en los logs de Vercel). Para depurar al instalar: variable `DEBUG_ERRORS=1`.
- **Frontend:** `esc()` escapa también comillas y se aplica a usuario, host y contraseña; probado contra un servidor que devuelve HTML malicioso.
- **API:** `vercel.json` añade `Cache-Control: no-store` y `nosniff` a todo `/api/*` (las respuestas llevan contraseñas).
- **Login PHP:** soporta IP real tras Cloudflare (`const BEHIND_CLOUDFLARE = true;` en config.php) y limpia contadores/códigos caducados.
- **Agente VPS:** corta conexiones colgadas (15 s), limita el cuerpo a 64 KB y permite `BIND_ADDR` (ver abajo). Hay que copiar el archivo nuevo y reiniciar el servicio.
- **Sitio:** `cpanel/htaccess-sitio.txt` con cabeceras de seguridad y HTTPS forzado.

## Pendiente (requiere acciones tuyas)
1. **Rotar secretos expuestos en capturas** (`SESSION_SECRET` y clave de MySQL). Quien tenga `SESSION_SECRET` puede fabricar sesiones de cualquier usuario.
2. **Tráfico Vercel → agente sin cifrar (HTTP):** viajan el token y las contraseñas de las cuentas. Solución: Cloudflare Tunnel (o proxy HTTPS en un puerto distinto de 80/443), poner `BIND_ADDR=127.0.0.1` en `/etc/jitterx-agent.conf` y `AGENT_URL=https://...`.
3. **Los usuarios del túnel pueden alcanzar servicios locales** (API de Xray en 127.0.0.1:10085) y enviar spam por el puerto 25. Se bloquea con reglas iptables por grupo de usuarios.
4. **Subdominios gratis en tu dominio principal:** riesgo de phishing que dañe la reputación de jitterxcloud.shop. Usa un dominio aparte en `ZONE_NAME`.
5. **`MP_WEBHOOK_SECRET`:** configúralo en Vercel (Mercado Pago → Webhooks).
6. Menores: límites de uso en memoria por instancia, sesiones de 30 días no revocables guardadas en localStorage, sin CSP, reembolsos/contracargos no manejados.
