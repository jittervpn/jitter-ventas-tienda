# Jitterx Panel Cloud — versión Vercel

## Estructura del repositorio (todo en la raíz)
```
index.html        ← la web
package.json
api/
  create.js       ← POST /api/create
  me.js           ← GET  /api/me
  stats.js        ← GET  /api/stats
lib/cf.js         ← lógica del servidor
```
Borra del repo la carpeta `functions/` de la versión anterior (Vercel no la usa).

## Variables de entorno (Vercel → Project → Settings → Environment Variables)
| Nombre | Valor |
|---|---|
| `CF_API_TOKEN` | token nuevo (permiso Zone → DNS → Edit) |
| `ZONE_ID` | **Zone ID del dominio** (no el Account ID). Dominio → Overview → columna derecha → API → Zone ID |
| `ZONE_NAME` | tu dominio, ej. `midominio.com` |
| `MAX_USERS` | ej. `100` |

Tras añadir variables: Deployments → ⋯ → **Redeploy**. No se aplican a despliegues anteriores.

## Comprobar
`https://TU-APP.vercel.app/api/stats` → JSON con `"zone": "tudominio"`.
Si devuelve `{"error":"Faltan variables..."}` faltan variables o falta el redeploy.
Si devuelve `Cloudflare: ...` el token o el Zone ID están mal.

## Cómo funciona sin base de datos
- Cada registro A se crea con un comentario `jitterx|usuario|fecha`.
- El contador total se guarda en un registro TXT `_jitterx-stats.tudominio`.
- Los registros vencidos se borran al consultar el panel.
