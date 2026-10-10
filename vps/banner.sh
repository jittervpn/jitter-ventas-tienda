#!/bin/bash
# ============================================================
#  Jitterx — instala el banner de bienvenida SSH
#  Uso:  bash banner.sh
#  Se muestra al conectar (antes del login) en OpenSSH y Dropbear.
# ============================================================
set -e
[ "$DRY" = "1" ] || { [ "$EUID" -eq 0 ] || { echo "Ejecuta como root"; exit 1; }; }

CONF=/etc/jitterx-agent.conf
get() { grep -s "^$1=" "$CONF" | head -1 | cut -d= -f2-; }
COUNTRY=$(get COUNTRY); COUNTRY=${COUNTRY:-Brasil}
CITY=$(get CITY);       CITY=${CITY:-Sao Paulo}
DAYS=$(get DAYS);       DAYS=${DAYS:-7}
LOGIN=$(get MAX_LOGIN); LOGIN=${LOGIN:-1}
SITE="jitter-ventas-tienda.vercel.app"

W=40   # ancho interior (apto para pantallas de movil)
line() { printf '+%*s+\n' "$W" '' | tr ' ' '='; }
center() {
  local t="$1" pad=$(( (W - ${#1}) / 2 ))
  printf '|%*s%s%*s|\n' "$pad" '' "$t" $(( W - pad - ${#1} )) ''
}

BANNER=$(
  line
  center ""
  center "J I T T E R X   P A N E L"
  center "C L O U D   S S H"
  center ""
  line
  echo
  echo " Servidor : $COUNTRY - $CITY"
  echo " Estado   : OPERATIVO"
  echo
  echo " > Cuenta personal e intransferible"
  echo " > $LOGIN conexion simultanea por usuario"
  echo " > Duracion de la cuenta: $DAYS dias"
  echo " > Prohibido spam, escaneos y abuso"
  echo " > Uso indebido = suspension sin aviso"
  echo
  echo " Crea o renueva tu cuenta en:"
  echo " $SITE"
  echo
  line
  echo
)

if [ "$DRY" = "1" ]; then echo "$BANNER"; exit 0; fi

FILE=/etc/ssh/jitterx-banner
echo "$BANNER" > "$FILE"
chmod 644 "$FILE"

# --- OpenSSH: un drop-in "00-" se lee primero y gana sobre otros Banner ---
mkdir -p /etc/ssh/sshd_config.d
DROP=/etc/ssh/sshd_config.d/00-jitterx-banner.conf
echo "Banner $FILE" > "$DROP"

if sshd -t 2>/dev/null; then
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || systemctl restart ssh
  echo "-> OpenSSH: banner activo"
else
  rm -f "$DROP"
  echo "!! La configuracion de sshd no valida; se revirtio el cambio de OpenSSH"
fi

# --- Dropbear (si el script del VPS lo usa) ---
if [ -f /etc/default/dropbear ]; then
  if grep -q '^DROPBEAR_BANNER=' /etc/default/dropbear; then
    sed -i "s|^DROPBEAR_BANNER=.*|DROPBEAR_BANNER=\"$FILE\"|" /etc/default/dropbear
  else
    echo "DROPBEAR_BANNER=\"$FILE\"" >> /etc/default/dropbear
  fi
  if grep -q '^DROPBEAR_EXTRA_ARGS=' /etc/default/dropbear && ! grep -q -- '-b ' /etc/default/dropbear; then
    sed -i "s|^DROPBEAR_EXTRA_ARGS=\"\(.*\)\"|DROPBEAR_EXTRA_ARGS=\"\1 -b $FILE\"|" /etc/default/dropbear
  fi
  systemctl restart dropbear 2>/dev/null && echo "-> Dropbear: banner activo" || true
fi

echo
echo "Banner instalado. Vista previa:"
echo "$BANNER"
echo
echo "Para cambiar el texto:  nano $FILE   (se aplica a las nuevas conexiones)"
