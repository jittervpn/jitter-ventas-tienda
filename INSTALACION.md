# Jitterx Panel Cloud — versión Cloudflare Pages

## Estructura (sube la carpeta completa, con la subcarpeta `functions/`)
```
jitterx-panel-cloud/
├── index.html            ← la web (no contiene ningún token)
└── functions/
    ├── _lib.js           ← código del servidor
    └── api/
        ├── create.js     ← POST /api/create
        ├── me.js         ← GET  /api/me
        └── stats.js      ← GET  /api/stats
```

## 1. Token nuevo
Revoca el token que pegaste en el chat. Mi perfil → API Tokens → Create Token →
plantilla **Edit zone DNS** → Zone Resources: solo tu dominio.

## 2. KV
Workers & Pages → KV → Create namespace → `jitterx`.

## 3. Subir a Pages
Tu proyecto `jitterxpanel` → Deployments → **Create deployment** → Upload assets →
arrastra la carpeta `jitterx-panel-cloud` entera (con `functions/`).
Si subes solo `index.html` la web cargará pero la API no existirá.

## 4. Variables y bindings
Proyecto → Settings:

**Variables and Secrets** (marca Production; también Preview si quieres)
| Nombre | Tipo | Valor |
|---|---|---|
| `CF_API_TOKEN` | Secret | tu token nuevo |
| `ZONE_ID` | Secret | `558d22cc8428f9f57ac29f6471cf9b94` |
| `ZONE_NAME` | Text | tu dominio, ej. `midominio.com` |
| `MAX_USERS` | Text | ej. `100` |

**Bindings → Add → KV namespace**: Variable name `JITTERX_KV` → namespace `jitterx`.

Tras cambiar variables o bindings, haz **Retry deployment** (o sube de nuevo)
para que se apliquen.

## 5. Comprobar
Abre `https://jitterxpanel.pages.dev/api/stats` → debe devolver JSON con tu dominio.
Si ves el dominio en la cabecera de la web, todo está conectado.

## Notas
- Pages no tiene cron: los registros vencidos se borran solos cuando alguien
  visita la web (se revisa como máximo una vez por hora).
- Identidad de usuario = IP + cookie de dispositivo → 1 registro cada 7 días.
- Cambiar duración: `SEVEN_DAYS_MS` en `functions/_lib.js`.
