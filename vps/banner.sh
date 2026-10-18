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
SITE="jitterxcloud.shop"
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

# Banner PREMIUM. Estilo: STYLE=gamer (por defecto) | linux | simple
# HTTP Custom y apps parecidas pintan HTML (<font color>, <b>); otros clientes mostrarian las etiquetas tal cual.
STYLE=${STYLE:-gamer}
case "$STYLE" in
linux)
PREMIUM="<font color=\"#00FF66\"><b>root@jitterx:~# ssh --plan premium</b></font>
<font color=\"#7CFFB2\">Connecting to $COUNTRY - $CITY ...</font>

<font color=\"#00FF66\">[  OK  ]</font> Servidor operativo
<font color=\"#00FF66\">[  OK  ]</font> Autenticacion correcta
<font color=\"#FFD700\">[ PRO ]</font> <b>Plan PREMIUM activo</b>
<font color=\"#00FF66\">[  OK  ]</font> Cuenta personal e intransferible

<font color=\"#FF5555\">[ WARN ]</font> Prohibido spam, escaneos y abuso
<font color=\"#FF5555\">[ WARN ]</font> Uso indebido = suspension sin aviso

<font color=\"#00FF66\">root@jitterx:~#</font> renovar --en <font color=\"#5EC8FF\">$SITE</font>"
;;
simple)
PREMIUM="$SEP
JITTERX PANEL | CLOUD SSH  [PREMIUM]
$SEP

Servidor: $COUNTRY - $CITY
Estado: OPERATIVO
Plan: PREMIUM

> Gracias por tu compra
> Cuenta personal e intransferible
> Prohibido spam, escaneos y abuso
> Uso indebido = suspension sin aviso

Renueva o amplia tu plan en:
$SITE

$SEP"
;;
*)
PREMIUM="<font color=\"#FFD700\"><b>━━━━━━━━━━━━━━━━━━━━━━━━</b></font>
<font color=\"#FFD700\"><b>👑 𝗝𝗜𝗧𝗧𝗘𝗥𝗫 𝗣𝗥𝗘𝗠𝗜𝗨𝗠 👑</b></font>
<font color=\"#FFD700\"><b>━━━━━━━━━━━━━━━━━━━━━━━━</b></font>

<font color=\"#00E5FF\"><b>⚡ Servidor:</b></font> $COUNTRY - $CITY
<font color=\"#00FF66\"><b>✅ Estado:</b></font> OPERATIVO
<font color=\"#FF3DDC\"><b>💎 Plan:</b></font> <font color=\"#FFD700\"><b>PREMIUM</b></font>

<font color=\"#FF9A3C\"><b>🔥 Gracias por tu compra</b></font>
<font color=\"#FFFFFF\">➤ Cuenta personal e intransferible</font>
<font color=\"#FFFFFF\">➤ Prohibido spam, escaneos y abuso</font>
<font color=\"#FF5555\">➤ Uso indebido = suspension sin aviso</font>

<font color=\"#00E5FF\"><b>🚀 Renueva o amplia tu plan:</b></font>
<font color=\"#5EC8FF\">$SITE</font>

<font color=\"#FFD700\"><b>━━━━━━━━━━━━━━━━━━━━━━━━</b></font>"
;;
esac

if [ "$DRY" = "1" ]; then echo "$BANNER"; echo; echo "--- PREMIUM ---"; echo "$PREMIUM"; exit 0; fi

FILE=/etc/ssh/jitterx-banner
FILEP=/etc/ssh/jitterx-banner-premium
echo "$BANNER" > "$FILE"
echo "$PREMIUM" > "$FILEP"
chmod 644 "$FILE" "$FILEP"
groupadd -f jxpremium

# Banner en la configuracion principal, AL PRINCIPIO (antes de cualquier "Match").
# Los drop-ins de sshd_config.d no se leen si el script del VPS reescribe sshd_config.
rm -f /etc/ssh/sshd_config.d/00-jitterx-banner.conf
CFG=/etc/ssh/sshd_config
cp -n "$CFG" "$CFG.bak" 2>/dev/null || true
sed -i '/^Banner /d' "$CFG"
sed -i "1i Banner $FILE" "$CFG"
# Banner Premium: bloque Match AL FINAL (un Match llega hasta el siguiente Match o fin de archivo)
sed -i '/^# JITTERX-PREMIUM-BEGIN/,/^# JITTERX-PREMIUM-END/d' "$CFG"
printf '\n# JITTERX-PREMIUM-BEGIN\nMatch Group jxpremium\n    Banner %s\n# JITTERX-PREMIUM-END\n' "$FILEP" >> "$CFG"

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
echo "Editar el texto:  nano $FILE   y   nano $FILEP   (se aplica a las nuevas conexiones)"
echo "Nota: con Dropbear el banner es unico para todos (no distingue plan)."
