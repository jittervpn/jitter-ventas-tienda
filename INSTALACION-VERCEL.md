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

## Pruebas de 1 hora del CDN

1. Sube `auth/pruebas.php` a la carpeta `auth` de cPanel (junto a `lib.php` y `config.php`). La tabla `cdn_pruebas` se crea sola.
2. Como administrador, en la sección CDN crea UNA vez un servicio con **Crear sin cobro**: ruta que empiece por `prueba` (p. ej. `prueba1`) y origen `example.com`. Cada servicio de pruebas atiende a un cliente a la vez; si quieres dos pruebas simultáneas, crea `prueba2`.
3. En el bloque «Pruebas de 1 hora» escribe el correo del cliente y pulsa **Dar prueba**. El cliente la activa en su sección CDN con el origen de su servidor.
4. Las pruebas vencidas se cierran solas en cada visita a la web. Para que se cierren aunque no entre nadie, crea un aviso gratuito en https://cron-job.org que abra cada 5 minutos: `https://jitter-ventas-tienda.vercel.app/api/planes`.

Variables opcionales: `PRUEBAS_URL` (por defecto `https://jitterxcloud.shop/auth/pruebas.php`) y `CDN_PRUEBA_REPOSO` (origen al terminar una prueba, por defecto `example.com`).
Los clientes no pueden comprar rutas que empiecen por `prueba`.

## Todo en Vercel (sin cPanel)

Desde noviembre de 2026 la web, el login y las pruebas de 1 hora viven en este mismo proyecto:

- `index.html`, guías, `sitemap.xml`, `robots.txt`, iconos → se sirven como archivos estáticos.
- Admin: `jitterxcloud.shop/admin` (admin.html + api/admin.js), solo correos de `CDN_PERMITIDOS`.
- Idioma: botón ES/EN. El panel se traduce con el diccionario al final de index.html; las guías y páginas tienen su versión en /en/.
- Precios: se cambian en /admin → Precios (se guardan en Blob, config/precios.json). Los pagos con el precio anterior se aceptan 48 h.
- Cupones: /admin → Cupones (campaña con precio y fecha, activar por correo). Datos en Blob (cupones.json). Un cupón = un pago.
- Tráfico: se detecta solo en la respuesta de la API del CDN (lib/trafico.js); /admin → API del CDN muestra qué devuelve.
- Login por código: `api/auth/codigo.js` (mismo uid por correo y mismo token que el antiguo PHP).
- Códigos de acceso y registro de pruebas: Vercel Blob privado `jitterx-datos` (`BLOB_READ_WRITE_TOKEN`).
- Correo: Gmail SMTP. Variables: `SMTP_USER` (tu Gmail) y `SMTP_PASS` (contraseña de aplicación de Google).
- Dominio: `jitterxcloud.shop` y `www.jitterxcloud.shop` añadidos al proyecto.

## PayPal

- Variables: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV` (`sandbox` o `live`), `PAYPAL_PRECIO_USD` (15 por defecto).
- PayPal cobra en USD. El botón aparece debajo del formulario de tarjeta al comprar o renovar.
- Para cobrar de verdad: crea credenciales **Live** en developer.paypal.com, cámbialas en Vercel y pon `PAYPAL_ENV=live`.
