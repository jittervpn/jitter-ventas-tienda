#!/bin/bash
# ============================================================
#  Jitterx — instala el banner de bienvenida SSH
#  Uso:  bash banner.sh
#  Compatible con apps de tunel que pintan HTML (HTTP Custom, etc.):
#  no depende de alinear texto con espacios.
# ============================================================
set -e
[ "$DRY" = "1" ] || { [ "$EUID" -eq 0 ] || { echo "Ejecuta como root"; exit 1; }; }

CONF=/etc/jitterx-agent.conf
get() { grep -s "^$1=" "$CONF" | head -1 | cut -d= -f2-; }
COUNTRY=$(get COUNTRY); COUNTRY=${COUNTRY:-Brasil}
CITY=$(get CITY);       CITY=${CITY:-Sao Paulo}
DAYS=$(get DAYS);       DAYS=${DAYS:-2}
LOGIN=$(get MAX_LOGIN); LOGIN=${LOGIN:-1}
SITE="jitter-ventas-tienda.vercel.app"
SEP="========================================"

BANNER="$SEP
JITTERX PANEL | CLOUD SSH
$SEP

Servidor: $COUNTRY - $CITY
Estado: OPERATIVO

> Cuenta personal e intransferible
> $LOGIN conexion simultanea por usuario
> Duracion de la cuenta: $DAYS dias
> Prohibido spam, escaneos y abuso
> Uso indebido = suspension sin aviso

Crea o renueva tu cuenta en:
$SITE

$SEP"

if [ "$DRY" = "1" ]; then echo "$BANNER"; exit 0; fi

FILE=/etc/ssh/jitterx-banner
echo "$BANNER" > "$FILE"
chmod 644 "$FILE"

# Banner en la configuracion principal, AL PRINCIPIO (antes de cualquier "Match").
# Los drop-ins de sshd_config.d no se leen si el script del VPS reescribe sshd_config.
rm -f /etc/ssh/sshd_config.d/00-jitterx-banner.conf
CFG=/etc/ssh/sshd_config
cp -n "$CFG" "$CFG.bak" 2>/dev/null || true
sed -i '/^Banner /d' "$CFG"
sed -i "1i Banner $FILE" "$CFG"

if sshd -t 2>/dev/null; then
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || systemctl restart ssh
  echo "-> OpenSSH: banner activo ($(sshd -T | grep -i '^banner'))"
else
  cp "$CFG.bak" "$CFG"
  echo "!! sshd_config no valido; se restauro la copia de seguridad"
  exit 1
fi

# Dropbear solo si realmente esta corriendo
if systemctl is-active --quiet dropbear 2>/dev/null; then
  grep -q '^DROPBEAR_BANNER=' /etc/default/dropbear 2>/dev/null \
    && sed -i "s|^DROPBEAR_BANNER=.*|DROPBEAR_BANNER=\"$FILE\"|" /etc/default/dropbear \
    || echo "DROPBEAR_BANNER=\"$FILE\"" >> /etc/default/dropbear
  systemctl restart dropbear && echo "-> Dropbear: banner activo"
fi

echo
echo "Vista previa:"
echo "$BANNER"
echo
echo "Editar el texto:  nano $FILE   (se aplica a las nuevas conexiones)"
