# Jitterx Panel Cloud — versión Vercel + cPanel

## Qué hace cada parte
| Dónde | Qué | Archivos |
|---|---|---|
| **cPanel** (jitterxcloud.shop) | La web + el **login por código** (PHP + MySQL + correo del hosting) | `index.html`, `privacidad.html`, `terminos.html`, carpeta `auth/` |
| **Vercel** | Pagos, cuentas SSH/V2Ray, DNS (solo comprueba la sesión) | `api/`, `lib/`, `package.json` |
| **VPS** | Agente que crea las cuentas | `vps/` |

Ya no se usa Firebase, Upstash ni Resend.

---

## 1) cPanel — login por código (≈10 minutos)

1. **MySQL:** cPanel → *Bases de datos MySQL* → crea una base y un usuario, y asígnalo con **Todos los privilegios**.
   (cPanel les pone un prefijo, por ejemplo `cpuser_jitterx`: usa el nombre completo.)
2. **Envío del correo:** muchos hostings bloquean la función `mail()` de PHP (la web mostrará *«No se pudo enviar el correo»*).
   La solución es enviar por **SMTP**: edita el archivo `auth/smtp.php` (solo hay que poner la contraseña):
   - **Gmail:** activa la verificación en 2 pasos de la cuenta, crea una *contraseña de aplicación* (myaccount.google.com/apppasswords) y usa
     `smtp.gmail.com`, puerto `465`, `'ssl'`, tu Gmail como usuario y esa contraseña de 16 letras. `MAIL_FROM_ADDR` debe ser ese mismo Gmail. Límite ≈ 500 correos/día.
   - **Brevo** (300/día gratis, remitente con tu dominio): `smtp-relay.brevo.com`, puerto `587`, `'tls'`, con el usuario y la clave SMTP de Brevo.
   - **Spacemail** (de pago tras la prueba): usa los datos SMTP que muestra tu buzón.
3. **Sube la carpeta** `cpanel/auth/` a `public_html/auth/` (queda `jitterxcloud.shop/auth/request-code.php`).
4. **Edita `auth/config.php`:** datos de MySQL, `SESSION_SECRET` (texto aleatorio de 40+ caracteres) y el remitente.
   Las tablas se crean solas en la primera petición.
5. Sube también `index.html`, `privacidad.html` y `terminos.html` a `public_html/` (reemplazan a los anteriores).

## 2) Vercel

Añade **una sola variable nueva** y haz Redeploy:

| Nombre | Valor |
|---|---|
| `SESSION_SECRET` | **exactamente el mismo texto** que pusiste en `auth/config.php` |

Las demás variables (CF_API_TOKEN, ZONE_ID, ZONE_NAME, MAX_USERS, MP_ACCESS_TOKEN, AGENT_URL, AGENT_TOKEN…) no cambian.
Puedes borrar `FIREBASE_PROJECT_ID` si la tenías.

## 3) Usuarios que ya tenías en Firebase (para que no pierdan sus cuentas)

El código identifica a cada usuario por su correo. Para que los antiguos conserven su identificador (y con él sus cuentas SSH, V2Ray y compras):

```
npx firebase-tools login
npx firebase-tools auth:export usuarios.json --format=JSON --project shocktv-df24f
node scripts/convertir-usuarios.mjs usuarios.json
```
Importa el `legacy-uids.sql` resultante en cPanel → *phpMyAdmin* → tu base → *Importar*.
Hazlo **antes** de publicar la web nueva. Los usuarios nuevos reciben un identificador automático.

## Seguridad incluida
- Código de 6 dígitos, vence a los 10 min, **un solo uso**, máximo **5 intentos**; en MySQL solo se guarda su hash.
- Límites: 1 código/min por correo, 6/hora por correo, 10/hora por IP y tope diario global (`MAX_CODES_DAY`).
- Correos desechables bloqueados. En Gmail se ignoran puntos y `+alias` (evita cuentas gratis infinitas).
- Sesión de 30 días firmada (HS256); si cambias `SESSION_SECRET` se cierran todas las sesiones.
- `auth/.htaccess` impide abrir `config.php` y `lib.php` desde el navegador.

## Comprobar
- `https://jitterxcloud.shop/auth/request-code.php` en el navegador → `{"error":"Método no permitido"}` = PHP funciona.
- `https://jitterxcloud.shop/auth/config.php` → debe dar **403**. Si muestra algo, avísame.
- Si el correo no llega: revisa *Email Deliverability* y el spam; el error real queda en *Errores* de cPanel.

---
## Anexo: DNS sin base de datos (sin cambios)
- Cada registro A se crea con un comentario `jitterx|usuario|fecha`.
- El contador total se guarda en un registro TXT `_jitterx-stats.tudominio`.
- Los registros vencidos se borran al consultar el panel.

---
## CDN CloudFront para clientes (api/cdn.js + lib/cdn.js)
Variables en Vercel → Settings → Environment Variables (luego Redeploy):

| Nombre | Valor |
|---|---|
| `CDN_API_KEY` | tu clave oficial del CDN (**solo aquí; nunca en archivos ni en GitHub**) |
| `CDN_API_BASE` | opcional. Por defecto `https://api-cdn.h4x.site` (oficial). Para pruebas: `https://api-cdn.h4x.site/sandbox` |
| `CDN_PERMITIDOS` | correos de administrador que pueden crear/renovar SIN pagar (pruebas). Ej.: `jittervpn@gmail.com` |
| `CDN_PRECIO` | precio de cada servicio y de cada renovación (30 días). Por defecto `17000` |
| `MP_ACCESS_TOKEN` / `MP_PUBLIC_KEY` | Mercado Pago: cobro del CDN (tarjeta en la web y página de Mercado Pago) |
| `SSH_ACTIVO` | `1` solo si quieres volver a permitir crear cuentas SSH/V2Ray (por defecto desactivado) |
| `CDN_MAX_POR_CLIENTE` | opcional, por defecto 2 |

- Los clientes pagan el CDN con Mercado Pago y el servicio se crea solo al aprobarse el pago (también por webhook).
- Si el servicio no se puede crear por un dato inválido (origen, ruta ocupada…), el pago se devuelve automáticamente.
- Cambiar el origen de un servicio propio es gratis.
- La clave vive solo en Vercel: el navegador del cliente nunca la ve.
- Cada cliente solo ve y toca los servicios cuya ruta empieza por su prefijo (`/c<6 letras>-nombre`).
- ⚠ El formato de peticiones/respuestas se asumió. Si algo no coincide, se ajusta solo en `CAMPOS` y `mapService()` de `lib/cdn.js`.
  Los errores del CDN quedan en Vercel → Logs con el prefijo `cdn:`.
