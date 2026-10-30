#!/bin/bash
# Añade a TU Xray actual la API y la entrada V2Ray (WebSocket /vless) que usa el agente de Jitterx,
# SIN tocar tus entradas existentes (por ejemplo 8443/8444). Hace copia de seguridad, valida la
# configuración antes de aplicarla y, si algo falla, restaura la anterior automáticamente.
#   Uso:  bash v2ray-agregar.sh
set -u
[ "$(id -u)" = 0 ] || { echo "Ejecuta como root."; exit 1; }
XRAY=$(command -v xray || echo /usr/local/bin/xray)
EXECX=$(systemctl cat xray 2>/dev/null | grep -E '^ExecStart' | head -1)
CFG=${XRAY_CFG:-$(echo "$EXECX" | grep -oE -- '-(config|c) +[^ ]+' | head -1 | awk '{print $2}')}
[ -n "$CFG" ] || CFG=/usr/local/etc/xray/config.json
NEW=/tmp/xray-config-fusion.json
PORTS=/tmp/xray-puertos-originales.txt
BAK="$CFG.antes-jitterx.$(date +%s).bak"

echo "$EXECX" | grep -q -- '-confdir' && { echo "Tu Xray usa -confdir (varios archivos). Este script no lo soporta: no toco nada."; exit 1; }
[ -x "$XRAY" ] || { echo "No encuentro el programa xray."; exit 1; }
[ -s "$CFG" ] || { echo "No encuentro la configuración: $CFG"; exit 1; }
command -v python3 >/dev/null || { echo "Falta python3."; exit 1; }

python3 - "$CFG" "$NEW" "$PORTS" << 'PYEOF' || exit 1
import json, sys
src, dst, ports_file = sys.argv[1:4]
try:
    c = json.load(open(src))
except Exception as e:
    sys.exit("Tu config.json no es JSON estándar (%s). No toco nada." % e)

inb = c.setdefault("inbounds", [])
for i in inb:
    if str(i.get("port")) in ("10000", "10085") and i.get("tag") not in ("api", "vless-ws"):
        sys.exit("El puerto %s ya lo usa otra entrada de tu Xray. No toco nada." % i.get("port"))
api = c.get("api") or {}
if api.get("tag") not in (None, "api"):
    sys.exit("Tu Xray ya tiene una API con otra etiqueta (%s). No toco nada." % api.get("tag"))

# puertos de TUS entradas, para comprobar después que siguen funcionando
open(ports_file, "w").write("\n".join(str(i["port"]) for i in inb if isinstance(i.get("port"), int) and i.get("tag") not in ("api", "vless-ws")))

api["tag"] = "api"
api["services"] = sorted(set(api.get("services", [])) | {"HandlerService", "StatsService"})
c["api"] = api
c.setdefault("stats", {})
pol = c.setdefault("policy", {})
pol.setdefault("levels", {}).setdefault("0", {}).update(statsUserUplink=True, statsUserDownlink=True, statsUserOnline=True)
pol.setdefault("system", {}).update(statsInboundUplink=True, statsInboundDownlink=True)

tags = {i.get("tag") for i in inb}
if "api" not in tags:
    inb.append({"tag": "api", "listen": "127.0.0.1", "port": 10085, "protocol": "dokodemo-door", "settings": {"address": "127.0.0.1"}})
if "vless-ws" not in tags:
    inb.append({"tag": "vless-ws", "listen": "127.0.0.1", "port": 10000, "protocol": "vless",
                "settings": {"clients": [], "decryption": "none"},
                "streamSettings": {"network": "ws", "wsSettings": {"path": "/vless"}}})

outs = c.setdefault("outbounds", [])
otags = {o.get("tag") for o in outs}
if "direct-jx" not in otags: outs.append({"tag": "direct-jx", "protocol": "freedom"})
if "block-jx" not in otags: outs.append({"tag": "block-jx", "protocol": "blackhole"})

r = c.setdefault("routing", {})
if "domainStrategy" not in r:
    r["domainStrategy"] = "IPIfNonMatch"
elif r["domainStrategy"] == "AsIs":
    print("AVISO: tu routing usa domainStrategy AsIs; el bloqueo de IPs privadas solo actuará sobre destinos dados como IP.", file=sys.stderr)
# Las reglas de bloqueo se limitan a la entrada vless-ws: tus otras entradas no cambian.
nuevas = [
    {"type": "field", "inboundTag": ["api"], "outboundTag": "api"},
    {"type": "field", "inboundTag": ["vless-ws"], "ip": ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "::1/128", "fc00::/7", "fe80::/10"], "outboundTag": "block-jx"},
    {"type": "field", "inboundTag": ["vless-ws"], "port": "25", "outboundTag": "block-jx"},
    {"type": "field", "inboundTag": ["vless-ws"], "outboundTag": "direct-jx"},
]
r["rules"] = nuevas + [x for x in r.get("rules", []) if x not in nuevas]
json.dump(c, open(dst, "w"), indent=2)
print("Configuración fusionada preparada.")
PYEOF

"$XRAY" run -test -config "$NEW" > /tmp/xray-test.log 2>&1 || { echo "La configuración fusionada no es válida; NO se aplicó nada."; tail -6 /tmp/xray-test.log; exit 1; }
cp -p "$CFG" "$BAK" || { echo "No pude crear la copia de seguridad."; exit 1; }
cp "$NEW" "$CFG"
echo "Copia de seguridad: $BAK"

if [ "${SKIP_SERVICE:-0}" != 1 ]; then
  systemctl restart xray
  ok=0
  for t in $(seq 1 12); do
    sleep 1; good=1
    for p in 10085 10000 $(cat "$PORTS"); do ss -tln | grep -q ":$p " || good=0; done
    [ "$good" = 1 ] && { ok=1; break; }
  done
  if [ "$ok" != 1 ]; then
    echo "Xray no quedó escuchando todos los puertos. Restauro tu configuración anterior..."
    cp -p "$BAK" "$CFG"; systemctl restart xray
    exit 1
  fi
  echo "LISTO: Xray escucha en 10085 (API), 10000 (V2Ray) y en tus puertos de siempre: $(tr '\n' ' ' < "$PORTS")"
  echo "Siguiente: systemctl restart jitterx-agent"
  echo "Y si 'grep -c /vless /usr/local/bin/pdirect.py' da 0:  bash v2ray-setup.sh pdirect"
else
  echo "(modo prueba: sin reiniciar el servicio)"
fi
