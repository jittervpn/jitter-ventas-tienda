#!/bin/bash
# ============================================================
#  Añade HTTPS al agente de Jitterx YA INSTALADO.
#  NO reinstala nada y NO toca: usuarios SSH, cuentas V2Ray, Xray, sshd, el token ni tus puertos.
#  El HTTP de siempre sigue funcionando hasta que tú decidas cerrarlo (así no hay corte).
#
#  Uso:   bash https-agente.sh [dominio] [puerto_https]
#   - sin dominio: usa  IP-con-guiones.sslip.io  (no necesitas DNS)
#   - puerto por defecto: 9443
#  Necesita el archivo nuevo del agente junto a este script:  /root/jitterx-agent.py
# ============================================================
set -u
CONF=${CONF:-/etc/jitterx-agent.conf}
DST=${AGENT_DST:-/usr/local/bin/jitterx-agent}
NUEVO=${AGENT_NUEVO:-$(dirname "$(readlink -f "$0")")/jitterx-agent.py}
HOSTN=${1:-}
TLS_PORT=${2:-9443}
TEST=${JX_TEST:-0}

[ "$(id -u)" = 0 ] || { echo "Ejecuta como root."; exit 1; }
[ -f "$CONF" ] || { echo "No encuentro $CONF: el agente no está instalado en este servidor."; exit 1; }
[ -f "$DST" ] || { echo "No encuentro el agente instalado en $DST."; exit 1; }
[ -f "$NUEVO" ] || { echo "Falta el agente nuevo. Pon jitterx-agent.py junto a este script ($NUEVO)."; exit 1; }
python3 -m py_compile "$NUEVO" 2>/dev/null || { echo "El archivo jitterx-agent.py no es válido (¿se copió completo?)."; exit 1; }
grep -q "TLS_CERT" "$NUEVO" || { echo "Ese jitterx-agent.py no trae soporte HTTPS. Usa el archivo nuevo."; exit 1; }

getc() { grep -E "^$1=" "$CONF" | tail -1 | cut -d= -f2- | tr -d "\"' "; }
setc() { if grep -qE "^$1=" "$CONF"; then sed -i "s#^$1=.*#$1=$2#" "$CONF"; else echo "$1=$2" >> "$CONF"; fi; }
AGENT_PORT=$(getc AGENT_PORT); AGENT_PORT=${AGENT_PORT:-8088}
TOKEN=$(getc AGENT_TOKEN)
[ "$TLS_PORT" != "$AGENT_PORT" ] || { echo "El puerto HTTPS no puede ser el mismo que el HTTP ($AGENT_PORT)."; exit 1; }
if [ "$TEST" != 1 ] && ss -tln | grep -q ":$TLS_PORT "; then echo "El puerto $TLS_PORT ya está en uso. Elige otro:  bash https-agente.sh '' 9444"; exit 1; fi

if [ "$TEST" = 1 ]; then
  CERT=${CERT:?}; KEY=${KEY:?}; HOSTN=${HOSTN:-localhost}
else
  if [ -z "$HOSTN" ]; then
    IP=$(curl -4 -s --max-time 8 https://api.ipify.org || true)
    [ -n "$IP" ] || IP=$(hostname -I | awk '{print $1}')
    HOSTN="${IP//./-}.sslip.io"
  fi
  echo "Dominio para el certificado: $HOSTN"
  echo "Puerto HTTPS: $TLS_PORT"
  # El certificado (Let's Encrypt) se pide por el puerto 80: los servicios que lo usen se paran unos segundos.
  UNITS=$(ss -tlnp 'sport = :80' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u | while read -r p; do ps -o unit= -p "$p" 2>/dev/null | awk '{print $1}'; done | grep -E '\.service$' | sort -u | tr '\n' ' ')
  if ss -tln | grep -q ':80 ' && [ -z "$UNITS" ]; then
    echo "Algo ocupa el puerto 80 y no es un servicio de systemd; no puedo pararlo con seguridad. No toco nada."; exit 1
  fi
  [ -n "$UNITS" ] && echo "AVISO: se pararán unos segundos: $UNITS (las conexiones por el puerto 80 se cortan un momento; vuelven a conectar)."
  read -rp "¿Continuar? [s/N] " r; [ "$r" = s ] || [ "$r" = S ] || { echo "Cancelado. No se tocó nada."; exit 0; }

  command -v certbot >/dev/null || { apt-get update -qq; apt-get install -y -qq certbot; }
  command -v certbot >/dev/null || { echo "No se pudo instalar certbot."; exit 1; }
  HOOKS=()
  [ -n "$UNITS" ] && HOOKS=(--pre-hook "systemctl stop $UNITS" --post-hook "systemctl start $UNITS")
  certbot certonly --standalone --preferred-challenges http -d "$HOSTN" --non-interactive --agree-tos \
    --register-unsafely-without-email --deploy-hook "systemctl restart jitterx-agent" "${HOOKS[@]}" || {
    echo; echo "No se pudo obtener el certificado (tu configuración NO cambió; los servicios ya se reiniciaron)."
    echo "Causas habituales: el dominio no apunta a este servidor, el puerto 80 está cerrado en el firewall del proveedor,"
    echo "o sslip.io superó el límite de certificados de Let's Encrypt. Alternativa: usa un dominio tuyo:"
    echo "   bash https-agente.sh agente.tudominio.com   (con un registro A hacia la IP de este VPS)"
    exit 1; }
  CERT=/etc/letsencrypt/live/$HOSTN/fullchain.pem; KEY=/etc/letsencrypt/live/$HOSTN/privkey.pem
fi
[ -r "$CERT" ] && [ -r "$KEY" ] || { echo "No puedo leer el certificado ($CERT)."; exit 1; }

# --- aplicar con copia de seguridad ---
TS=$(date +%s); cp -p "$CONF" "$CONF.antes-https.$TS"; cp -p "$DST" "$DST.antes-https.$TS"
echo "Copias de seguridad: $CONF.antes-https.$TS y $DST.antes-https.$TS"
install -m 755 "$NUEVO" "$DST"
setc TLS_CERT "$CERT"; setc TLS_KEY "$KEY"; setc TLS_PORT "$TLS_PORT"

if [ "$TEST" != 1 ]; then
  systemctl restart jitterx-agent
  ok=0
  for t in $(seq 1 15); do sleep 1; ss -tln | grep -q ":$TLS_PORT " && ss -tln | grep -q ":$AGENT_PORT " && { ok=1; break; }; done
  if [ "$ok" != 1 ]; then
    echo "El agente no quedó escuchando en HTTP y HTTPS. Restauro lo anterior..."
    cp -p "$CONF.antes-https.$TS" "$CONF"; cp -p "$DST.antes-https.$TS" "$DST"; systemctl restart jitterx-agent
    journalctl -u jitterx-agent -n 8 --no-pager 2>/dev/null; exit 1
  fi
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow "$TLS_PORT/tcp" >/dev/null && echo "ufw: puerto $TLS_PORT abierto."; fi
  echo "--- comprobación por HTTPS:"
  curl -s --max-time 10 -H "x-agent-token: $TOKEN" "https://$HOSTN:$TLS_PORT/status" | head -c 160; echo
fi

echo
echo "============================================================"
echo " LISTO. Usa estos datos en tu panel / en Vercel:"
echo "   URL del agente : https://$HOSTN:$TLS_PORT"
echo "   Token          : $TOKEN   (no cambió)"
echo
echo " El HTTP de antes sigue activo en el puerto $AGENT_PORT. Cuando todo funcione por HTTPS, ciérralo con:"
echo "   echo BIND_ADDR=127.0.0.1 >> $CONF && systemctl restart jitterx-agent"
echo " Si tu proveedor tiene firewall propio, abre también el puerto $TLS_PORT/tcp."
echo " El certificado se renueva solo (certbot). Si cambias los servicios del puerto 80, vuelve a ejecutar este script."
echo "============================================================"
