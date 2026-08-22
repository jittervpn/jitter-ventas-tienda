#!/bin/bash
# Endurece el acceso al agente Jitterx: puerto aleatorio, firewall y token nuevo.
set -e
[ "$EUID" -eq 0 ] || { echo "Ejecuta como root"; exit 1; }
CONF=/etc/jitterx-agent.conf
[ -f "$CONF" ] || { echo "No existe $CONF. Instala primero el agente."; exit 1; }

OLDPORT=$(grep '^AGENT_PORT=' $CONF | cut -d= -f2)
NEWPORT=$(shuf -i 20000-60000 -n 1)
NEWTOKEN=$(head -c 32 /dev/urandom | md5sum | cut -c1-32)
DOM=$(grep '^HOST_DOMAIN=' $CONF | cut -d= -f2)

echo "-> Puerto nuevo: $NEWPORT (antes $OLDPORT)"
sed -i "s|^AGENT_PORT=.*|AGENT_PORT=$NEWPORT|" $CONF
sed -i "s|^AGENT_TOKEN=.*|AGENT_TOKEN=$NEWTOKEN|" $CONF
grep -q '^MAX_FAILS='   $CONF || echo "MAX_FAILS=5"    >> $CONF
grep -q '^BAN_MINUTES=' $CONF || echo "BAN_MINUTES=60" >> $CONF
grep -q '^RATE_MAX='    $CONF || echo "RATE_MAX=20"    >> $CONF

touch /var/log/jitterx-audit.log && chmod 600 /var/log/jitterx-audit.log

if command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw delete allow "$OLDPORT"/tcp >/dev/null 2>&1 || true
  ufw allow "$NEWPORT"/tcp >/dev/null 2>&1 || true
  echo "-> ufw: cerrado $OLDPORT, abierto $NEWPORT"
fi

systemctl restart jitterx-agent
sleep 1
systemctl is-active --quiet jitterx-agent && EST=ACTIVO || EST="ERROR"

echo
echo "============================================================"
echo "  ENDURECIDO — Estado: $EST"
echo "============================================================"
echo "  Actualiza en Vercel y haz Redeploy:"
echo
echo "  AGENT_URL   = http://$DOM:$NEWPORT"
echo "  AGENT_TOKEN = $NEWTOKEN"
echo
echo "  Proteccion activa: baneo tras 5 fallos de token (60 min),"
echo "  maximo 20 peticiones por minuto y por IP."
echo "  Registro:  tail -f /var/log/jitterx-audit.log"
echo "============================================================"
