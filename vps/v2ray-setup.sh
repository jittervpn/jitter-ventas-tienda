#!/bin/bash
# =====================================================================
#  Jitterx - V2Ray (VLESS por WebSocket) en el mismo puerto 80 y 443
#
#  Paso 1:  bash v2ray-setup.sh xray      -> configura Xray (NO toca tu tunel SSH)
#  Paso 2:  bash v2ray-setup.sh pdirect   -> enseña a pdirect.py a desviar /vless a Xray
#  Deshacer el paso 2:  bash v2ray-setup.sh quitar
#
#  Xray escucha SOLO en 127.0.0.1 (nadie de fuera llega a el). Tu tunel SSH sigue igual:
#  solo las conexiones WebSocket a la ruta /vless van a Xray.
# =====================================================================
set -e
[ "$(id -u)" = "0" ] || { echo "Ejecuta como root."; exit 1; }

PD=/usr/local/bin/pdirect.py
SVC=ssh-ws
XRAY=$(command -v xray || echo /usr/local/bin/xray)
CFG=$(find /etc /usr/local/etc -path '*xray*' -name 'config.json' 2>/dev/null | head -1)
[ -n "$CFG" ] || CFG=/usr/local/etc/xray/config.json
HOSTD=$(grep -E '^HOST_DOMAIN=' /etc/jitterx-agent.conf 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
[ -n "$HOSTD" ] || HOSTD=$(hostname -I | awk '{print $1}')

paso_xray() {
  [ -x "$XRAY" ] || { echo "No encuentro el programa xray."; exit 1; }
  if [ -s "$CFG" ] && [ "$(tr -d ' \n\t' < "$CFG")" != "{}" ] && [ "$1" != "--forzar" ]; then
    echo "$CFG ya tiene una configuracion. No la piso."
    echo "Si quieres reemplazarla (se guarda copia):  bash v2ray-setup.sh xray --forzar"; exit 1
  fi
  for p in 10000 10085; do
    if ss -tln | grep -q "127.0.0.1:$p "; then
      systemctl is-active --quiet xray || { echo "El puerto $p ya esta en uso por otro programa."; exit 1; }
    fi
  done
  echo "-> Copia de seguridad: $CFG.jitterx.bak"
  [ -f "$CFG.jitterx.bak" ] || cp "$CFG" "$CFG.jitterx.bak" 2>/dev/null || true
  cat > "$CFG.nuevo" << 'XRAYCFG'
{
  "log": {"loglevel": "warning"},
  "api": {"tag": "api", "services": ["HandlerService", "StatsService"]},
  "stats": {},
  "policy": {
    "levels": {"0": {"statsUserUplink": true, "statsUserDownlink": true, "statsUserOnline": true}},
    "system": {"statsInboundUplink": true, "statsInboundDownlink": true}
  },
  "inbounds": [
    {"tag": "api", "listen": "127.0.0.1", "port": 10085, "protocol": "dokodemo-door", "settings": {"address": "127.0.0.1"}},
    {"tag": "vless-ws", "listen": "127.0.0.1", "port": 10000, "protocol": "vless",
     "settings": {"clients": [], "decryption": "none"},
     "streamSettings": {"network": "ws", "wsSettings": {"path": "/vless"}}}
  ],
  "outbounds": [
    {"tag": "direct", "protocol": "freedom"},
    {"tag": "block", "protocol": "blackhole"}
  ],
  "routing": {
    "domainStrategy": "IPIfNonMatch",
    "rules": [
      {"type": "field", "inboundTag": ["api"], "outboundTag": "api"},
      {"type": "field", "ip": ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "::1/128", "fc00::/7", "fe80::/10"], "outboundTag": "block"},
      {"type": "field", "port": "25", "outboundTag": "block"}
    ]
  }
}
XRAYCFG
  "$XRAY" run -test -config "$CFG.nuevo" >/tmp/xray-test.log 2>&1 || { echo "La configuracion nueva no es valida. No se cambio nada:"; tail -5 /tmp/xray-test.log; rm -f "$CFG.nuevo"; exit 1; }
  mv "$CFG.nuevo" "$CFG"; chmod 644 "$CFG"
  systemctl enable xray >/dev/null 2>&1 || true
  systemctl restart xray; sleep 2
  if ! systemctl is-active --quiet xray; then
    echo "Xray no arranco con la configuracion nueva. Restaurando la anterior."
    cp "$CFG.jitterx.bak" "$CFG"; systemctl restart xray || true; exit 1
  fi
  UUID=$(cat /proc/sys/kernel/random/uuid)
  printf '{"inbounds":[{"tag":"vless-ws","protocol":"vless","port":10000,"settings":{"clients":[{"id":"%s","email":"prueba","level":0}],"decryption":"none"}}]}' "$UUID" > /tmp/xray-add.json
  "$XRAY" api adu -s 127.0.0.1:10085 /tmp/xray-add.json >/dev/null 2>&1 && rm -f /tmp/xray-add.json
  echo
  echo "XRAY LISTO (WebSocket, ruta /vless, solo accesible desde dentro del VPS)."
  echo "Cuenta de PRUEBA temporal (se borra si Xray se reinicia). Importa uno de estos enlaces en v2rayNG / NekoBox / Hiddify:"
  echo
  echo "vless://$UUID@$HOSTD:80?encryption=none&type=ws&path=%2Fvless&host=$HOSTD#Jitterx-80"
  echo "vless://$UUID@$HOSTD:443?encryption=none&security=tls&sni=$HOSTD&allowInsecure=1&insecure=1&type=ws&path=%2Fvless&host=$HOSTD#Jitterx-443"
  echo
  echo "Aun NO conectaran: falta el paso 2 (bash v2ray-setup.sh pdirect)."
}

paso_pdirect() {
  [ -f "$PD" ] || { echo "No existe $PD"; exit 1; }
  systemctl is-active --quiet xray || { echo "Xray no esta activo: haz primero el paso 1 (bash v2ray-setup.sh xray)."; exit 1; }
  [ -f "$PD.v2ray.bak" ] || cp "$PD" "$PD.v2ray.bak"
  echo "-> Copia de seguridad: $PD.v2ray.bak"
  cat > /tmp/parchear-pdirect.py << 'PATCH_EOF'
#!/usr/bin/env python3
"""
Parchea /usr/local/bin/pdirect.py para que las conexiones WebSocket a /vless vayan a Xray
(127.0.0.1:10000). TODO lo demas (SSH) sigue exactamente igual.
Es idempotente: si ya esta parcheado, no hace nada.  Uso: parchear-pdirect.py RUTA
"""
import re, sys

ruta = sys.argv[1] if len(sys.argv) > 1 else "/usr/local/bin/pdirect.py"
src = open(ruta, encoding="utf-8").read()
if "V2RAY_PORT" in src:
    print("Ya estaba parcheado."); sys.exit(0)

AYUDAS = '''# ---- V2Ray (Xray) por WebSocket: las peticiones a /vless van a Xray; lo demas sigue igual ----
V2RAY_PORT = int(os.environ.get("PDIRECT_V2RAY_PORT", "10000"))
V2RAY_PATH = b"/vless"


def is_v2ray(data):
    if not data.startswith(b"GET " + V2RAY_PATH):
        return False
    sig = data[4 + len(V2RAY_PATH):5 + len(V2RAY_PATH)]
    return sig in (b" ", b"?", b"/") and b"sec-websocket-key" in data[:2048].lower()


def v2ray_forward(client, data):
    import threading
    up = socket.create_connection(("127.0.0.1", V2RAY_PORT), timeout=5)
    up.settimeout(None)
    up.sendall(data)

    def cp(a, b):
        try:
            while True:
                chunk = a.recv(65536)
                if not chunk:
                    break
                b.sendall(chunk)
        except Exception:
            pass
        finally:
            for s in (a, b):
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except Exception:
                    pass

    t = threading.Thread(target=cp, args=(up, client), daemon=True)
    t.start()
    cp(client, up)
    t.join(2)
    try:
        up.close()
    except Exception:
        pass


'''

# 1) funciones auxiliares justo antes de 'def handler('
m = re.search(r"^def handler\(", src, re.M)
if not m:
    sys.exit("No encuentro 'def handler(' en el archivo: no lo toco.")
src = src[:m.start()] + AYUDAS + src[m.start():]

# 2) desvio dentro de handler(), justo antes de conectar con el servidor SSH
patron = re.compile(r"^([ \t]+)remote = socket\.socket\(socket\.AF_INET, socket\.SOCK_STREAM\)\n([ \t]+)remote\.connect\(\(REMOTE_ADDR, REMOTE_PORT\)\)", re.M)
mm = patron.search(src)
if not mm:
    sys.exit("No encuentro el punto donde handler() conecta con SSH: no lo toco.")
ind = mm.group(1)
desvio = f"{ind}if is_v2ray(data):\n{ind}    v2ray_forward(client_socket, data)\n{ind}    return\n"
src = src[:mm.start()] + desvio + src[mm.start():]

open(ruta, "w", encoding="utf-8").write(src)
print("Parche aplicado.")
PATCH_EOF
  python3 /tmp/parchear-pdirect.py "$PD" || { echo "No se pudo parchear. No se cambio nada."; exit 1; }
  python3 -c "import ast,sys;ast.parse(open('$PD').read())" || { echo "El archivo quedo invalido. Restaurando."; cp "$PD.v2ray.bak" "$PD"; exit 1; }
  echo "-> Reiniciando $SVC (los clientes SSH se reconectan solos en unos segundos)"
  systemctl restart $SVC; sleep 3
  if ! systemctl is-active --quiet $SVC; then
    echo "ERROR: $SVC no arranco. Restaurando el original."
    cp "$PD.v2ray.bak" "$PD"; systemctl restart $SVC || true; exit 1
  fi
  echo "LISTO. Prueba ahora los enlaces vless:// de la cuenta de prueba."
  echo "Si algo falla:  bash v2ray-setup.sh quitar"
}

case "$1" in
  xray)    paso_xray "$2" ;;
  pdirect) paso_pdirect ;;
  quitar)
    [ -f "$PD.v2ray.bak" ] || { echo "No hay copia $PD.v2ray.bak: nada que restaurar."; exit 1; }
    cp "$PD.v2ray.bak" "$PD"; systemctl restart $SVC
    echo "pdirect.py restaurado y $SVC reiniciado. (Xray queda configurado pero sin salida a internet.)" ;;
  *) echo "Uso: bash v2ray-setup.sh xray | pdirect | quitar"; exit 2 ;;
esac
