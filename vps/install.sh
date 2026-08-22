#!/bin/bash
# ============================================================
#  Jitterx Agent — instalador todo en uno
#  Uso:  bash <(curl -sL TU_URL/install.sh)
# ============================================================
set -e
[ "$EUID" -eq 0 ] || { echo "Ejecuta como root (usa: sudo -i)"; exit 1; }
command -v python3 >/dev/null || { echo "Falta python3"; exit 1; }

echo
echo "=========================================="
echo "   INSTALADOR JITTERX AGENT"
echo "=========================================="
echo

DEFDOM=$(hostname -f 2>/dev/null || echo "")
read -rp "Dominio publico del VPS [$DEFDOM]: " HOST_DOMAIN; HOST_DOMAIN=${HOST_DOMAIN:-$DEFDOM}
[ -z "$HOST_DOMAIN" ] && { echo "El dominio es obligatorio"; exit 1; }
read -rp "Puerto WebSocket [80]: " WS_PORT; WS_PORT=${WS_PORT:-80}
read -rp "Puerto SSL/TLS [443]: " SSL_PORT; SSL_PORT=${SSL_PORT:-443}
read -rp "Puerto SSH [22]: " SSH_PORT; SSH_PORT=${SSH_PORT:-22}
read -rp "Pais del servidor [Brasil]: " COUNTRY; COUNTRY=${COUNTRY:-Brasil}
read -rp "Ciudad [Sao Paulo]: " CITY; CITY=${CITY:-Sao Paulo}
read -rp "Codigo de bandera ISO [BR]: " FLAG; FLAG=${FLAG:-BR}
read -rp "Maximo de cuentas activas [30]: " MAX_USERS; MAX_USERS=${MAX_USERS:-30}
read -rp "Puerto del agente [8088]: " AGENT_PORT; AGENT_PORT=${AGENT_PORT:-8088}

if [ -f /etc/jitterx-agent.conf ]; then
  TOKEN=$(grep '^AGENT_TOKEN=' /etc/jitterx-agent.conf | cut -d= -f2)
  echo "-> Conservando el token existente."
else
  TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)
fi

echo "-> Instalando agente..."
cat > /usr/local/bin/jitterx-agent << 'JITTERX_AGENT_EOF'
#!/usr/bin/env python3
"""
Agente Jitterx para VPS — crea cuentas SSH/WebSocket bajo demanda.
Escucha peticiones firmadas con un token compartido y crea usuarios Linux
con expiración automática y límite de conexiones simultáneas.

Instalar con install.sh. Config en /etc/jitterx-agent.conf
"""
import json, os, re, subprocess, secrets, string, hmac, time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONF = "/etc/jitterx-agent.conf"
cfg = {}
for line in open(CONF):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        cfg[k.strip()] = v.strip().strip('"').strip("'")

TOKEN      = cfg["AGENT_TOKEN"]
PORT       = int(cfg.get("AGENT_PORT", "8088"))
HOST_DOM   = cfg.get("HOST_DOMAIN", "")
WS_PORT    = cfg.get("WS_PORT", "80")
SSL_PORT   = cfg.get("SSL_PORT", "443")
SSH_PORT   = cfg.get("SSH_PORT", "22")
DAYS       = int(cfg.get("DAYS", "7"))
MAX_LOGIN  = int(cfg.get("MAX_LOGIN", "1"))
MAX_USERS  = int(cfg.get("MAX_USERS", "100"))
PREFIX     = cfg.get("USER_PREFIX", "jx")
DB         = "/etc/jitterx-users.json"
AUDIT      = "/var/log/jitterx-audit.log"
# Lista blanca opcional: si está vacía, se acepta cualquier IP con token válido
ALLOWED_IPS = [x.strip() for x in cfg.get("ALLOWED_IPS", "").split(",") if x.strip()]
MAX_FAILS   = int(cfg.get("MAX_FAILS", "5"))       # fallos de token antes de bloquear
BAN_MINUTES = int(cfg.get("BAN_MINUTES", "60"))
RATE_MAX    = int(cfg.get("RATE_MAX", "20"))       # peticiones por minuto y por IP

COUNTRY    = cfg.get("COUNTRY", "Brasil")
CITY       = cfg.get("CITY", "")
FLAG       = cfg.get("FLAG", "BR")

# ---------------- protección: baneos y límite de peticiones ----------------
_fails = {}   # ip -> [contador, primer_intento]
_bans = {}    # ip -> timestamp_fin
_hits = {}    # ip -> [timestamps]
_lock = __import__("threading").Lock()


def audit(msg):
    try:
        with open(AUDIT, "a") as f:
            f.write(f"{datetime.now(timezone.utc).isoformat()} {msg}\n")
    except Exception:
        pass


def is_banned(ip):
    with _lock:
        until = _bans.get(ip, 0)
        if until > time.time():
            return True
        _bans.pop(ip, None)
        return False


def note_fail(ip):
    with _lock:
        c, first = _fails.get(ip, (0, time.time()))
        if time.time() - first > 600:
            c, first = 0, time.time()
        c += 1
        _fails[ip] = (c, first)
        if c >= MAX_FAILS:
            _bans[ip] = time.time() + BAN_MINUTES * 60
            _fails.pop(ip, None)
            audit(f"BAN ip={ip} motivo=token_invalido intentos={c}")
            return True
    return False


def rate_ok(ip):
    now = time.time()
    with _lock:
        hits = [t for t in _hits.get(ip, []) if now - t < 60]
        hits.append(now)
        _hits[ip] = hits
        if len(_hits) > 5000:
            _hits.clear()
        return len(hits) <= RATE_MAX


USER_RE = re.compile(r"^[a-z][a-z0-9]{2,15}$")
RESERVED = {"root","admin","ubuntu","test","user","ssh","www","daemon","bin","sys"}


def load_db():
    try:
        return json.load(open(DB))
    except Exception:
        return {}


def save_db(db):
    tmp = DB + ".tmp"
    with open(tmp, "w") as f:
        json.dump(db, f, indent=1)
    os.replace(tmp, DB)
    os.chmod(DB, 0o600)


def sh(*args):
    return subprocess.run(args, capture_output=True, text=True)


def system_user_exists(name):
    return sh("id", "-u", name).returncode == 0


def purge_expired(db):
    """Borra del sistema los usuarios cuya fecha ya pasó."""
    now = time.time()
    changed = False
    for name, rec in list(db.items()):
        if rec["expires_at"] <= now:
            sh("pkill", "-9", "-u", name)
            sh("userdel", "-r", name)
            del db[name]
            changed = True
    if changed:
        save_db(db)
    return db


def gen_password(n=10):
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


def create_account(username, device):
    db = purge_expired(load_db())

    if len(db) >= MAX_USERS:
        return 503, {"error": "El servidor alcanzó el límite de cuentas. Inténtalo más tarde."}

    # 1 cuenta por dispositivo
    for name, rec in db.items():
        if rec.get("device") == device:
            return 429, {"error": "Ya tienes una cuenta activa. Podrás crear otra cuando expire.",
                         "account": public(name, rec)}

    if not USER_RE.match(username):
        return 400, {"error": "Usuario inválido: 3-16 caracteres, empieza por letra, solo minúsculas y números."}
    if username in RESERVED or username in db or system_user_exists(username):
        return 409, {"error": "Ese usuario ya está en uso, elige otro."}

    password = gen_password()
    expires = datetime.now(timezone.utc) + timedelta(days=DAYS)
    exp_str = expires.strftime("%Y-%m-%d")

    r = sh("useradd", "-M", "-N", "-s", "/bin/false", "-e", exp_str, username)
    if r.returncode != 0:
        return 500, {"error": "No se pudo crear el usuario en el sistema."}
    p = subprocess.run(["chpasswd"], input=f"{username}:{password}\n", capture_output=True, text=True)
    if p.returncode != 0:
        sh("userdel", "-r", username)
        return 500, {"error": "No se pudo asignar la contraseña."}

    # Límite de conexiones simultáneas
    with open("/etc/security/limits.d/jitterx.conf", "a") as f:
        f.write(f"{username} hard maxlogins {MAX_LOGIN}\n")

    rec = {"password": password, "device": device,
           "created_at": time.time(), "expires_at": expires.timestamp()}
    db[username] = rec
    save_db(db)
    return 201, {"ok": True, "account": public(username, rec)}


def public(name, rec):
    return {
        "username": name, "password": rec["password"],
        "host": HOST_DOM, "ws_port": WS_PORT, "ssl_port": SSL_PORT, "ssh_port": SSH_PORT,
        "created_at": int(rec["created_at"] * 1000),
        "expires_at": int(rec["expires_at"] * 1000),
        "max_login": MAX_LOGIN,
    }


def find_by_device(device):
    db = purge_expired(load_db())
    for name, rec in db.items():
        if rec.get("device") == device:
            return public(name, rec)
    return None


def net_iface():
    try:
        with open("/proc/net/route") as f:
            for line in f.readlines()[1:]:
                p = line.split()
                if p[1] == "00000000":
                    return p[0]
    except Exception:
        pass
    return "eth0"


def rx_tx(iface):
    try:
        base = f"/sys/class/net/{iface}/statistics/"
        return int(open(base + "rx_bytes").read()), int(open(base + "tx_bytes").read())
    except Exception:
        return 0, 0


_last = {"t": 0.0, "rx": 0, "tx": 0, "mbps": 0.0}


def throughput_mbps():
    """Mbps en uso ahora mismo, medido entre dos llamadas consecutivas."""
    iface = net_iface()
    rx, tx = rx_tx(iface)
    now = time.time()
    dt = now - _last["t"]
    if _last["t"] and 0.5 < dt < 300:
        delta = (rx - _last["rx"]) + (tx - _last["tx"])
        _last["mbps"] = round(max(0, delta) * 8 / dt / 1_000_000, 2)
    _last.update({"t": now, "rx": rx, "tx": tx})
    return _last["mbps"]


def system_metrics():
    m = {}
    try:
        m["load"] = round(os.getloadavg()[0], 2)
        m["cores"] = os.cpu_count() or 1
        m["cpu"] = min(100, round(m["load"] / m["cores"] * 100))
    except Exception:
        m["cpu"] = 0
    try:
        mem = {}
        for line in open("/proc/meminfo"):
            k, v = line.split(":", 1)
            mem[k] = int(v.strip().split()[0])
        total, avail = mem["MemTotal"], mem.get("MemAvailable", mem["MemFree"])
        m["ram_total_mb"] = total // 1024
        m["ram_used_mb"] = (total - avail) // 1024
        m["ram"] = round((total - avail) / total * 100)
    except Exception:
        m["ram"] = 0
    try:
        st = os.statvfs("/")
        m["disk"] = round((1 - st.f_bavail / st.f_blocks) * 100)
    except Exception:
        m["disk"] = 0
    try:
        m["uptime"] = int(float(open("/proc/uptime").read().split()[0]))
    except Exception:
        m["uptime"] = 0
    m["mbps"] = throughput_mbps()
    return m


def online_users(db):
    """Cuántas cuentas del panel tienen sesión abierta ahora."""
    try:
        out = sh("who").stdout.split()
        return len({u for u in out if u in db})
    except Exception:
        return 0


class Handler(BaseHTTPRequestHandler):
    server_version = "jitterx"

    def log_message(self, fmt, *args):
        pass  # silencio; systemd ya registra lo importante

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    @property
    def peer(self):
        return self.client_address[0]

    def authed(self):
        got = self.headers.get("x-agent-token", "")
        ok = hmac.compare_digest(got, TOKEN)
        if not ok:
            note_fail(self.peer)
        return ok

    def guard(self):
        """Devuelve True si la petición puede continuar."""
        ip = self.peer
        if ALLOWED_IPS and ip not in ALLOWED_IPS:
            audit(f"RECHAZO ip={ip} motivo=fuera_de_lista")
            self.reply(403, {"error": "Origen no permitido"})
            return False
        if is_banned(ip):
            self.reply(429, {"error": "Demasiados intentos. Bloqueado temporalmente."})
            return False
        if not rate_ok(ip):
            audit(f"RATE ip={ip}")
            self.reply(429, {"error": "Demasiadas peticiones."})
            return False
        if not self.authed():
            self.reply(401, {"error": "No autorizado"})
            return False
        return True

    def do_GET(self):
        if not self.guard():
            return
        if self.path.startswith("/status"):
            db = purge_expired(load_db())
            return self.reply(200, {
                "ok": True, "active": len(db), "max": MAX_USERS, "online": online_users(db),
                "host": HOST_DOM, "days": DAYS, "max_login": MAX_LOGIN,
                "country": COUNTRY, "city": CITY, "flag": FLAG,
                "ws_port": WS_PORT, "ssl_port": SSL_PORT, "ssh_port": SSH_PORT,
                **system_metrics(),
            })
        if self.path.startswith("/account"):
            device = self.headers.get("x-jx-device", "")
            return self.reply(200, {"account": find_by_device(device) if device else None})
        self.reply(404, {"error": "Ruta no encontrada"})

    def do_POST(self):
        if not self.guard():
            return
        if not self.path.startswith("/create"):
            return self.reply(404, {"error": "Ruta no encontrada"})
        try:
            n = int(self.headers.get("content-length", 0))
            data = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self.reply(400, {"error": "JSON inválido"})
        username = str(data.get("username", "")).strip().lower()
        device = str(data.get("device", "")).strip()
        if not device:
            return self.reply(400, {"error": "Falta el identificador de dispositivo"})
        real_ip = self.headers.get("x-real-client-ip", "-")
        code, out = create_account(username, device)
        if code == 201:
            audit(f"CUENTA usuario={username} device={device[:8]} ip_usuario={real_ip} origen={self.peer}")
        self.reply(code, out)


if __name__ == "__main__":
    purge_expired(load_db())
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
JITTERX_AGENT_EOF
chmod 755 /usr/local/bin/jitterx-agent

cat > /etc/jitterx-agent.conf << CONF
AGENT_TOKEN=$TOKEN
AGENT_PORT=$AGENT_PORT
HOST_DOMAIN=$HOST_DOMAIN
WS_PORT=$WS_PORT
SSL_PORT=$SSL_PORT
SSH_PORT=$SSH_PORT
DAYS=7
MAX_LOGIN=1
MAX_USERS=$MAX_USERS
USER_PREFIX=jx
MAX_FAILS=5
BAN_MINUTES=60
RATE_MAX=20
ALLOWED_IPS=
COUNTRY=$COUNTRY
CITY=$CITY
FLAG=$FLAG
CONF
chmod 600 /etc/jitterx-agent.conf
[ -f /etc/jitterx-users.json ] || echo '{}' > /etc/jitterx-users.json
chmod 600 /etc/jitterx-users.json
touch /etc/security/limits.d/jitterx.conf
touch /var/log/jitterx-audit.log && chmod 600 /var/log/jitterx-audit.log

cat > /etc/systemd/system/jitterx-agent.service << 'UNIT'
[Unit]
Description=Jitterx agent (cuentas SSH temporales)
After=network.target

[Service]
ExecStart=/usr/local/bin/jitterx-agent
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
UNIT

cat > /usr/local/bin/jitterx-purge << 'PURGE'
#!/usr/bin/env python3
import importlib.util, sys
spec = importlib.util.spec_from_loader("jx", importlib.machinery.SourceFileLoader("jx", "/usr/local/bin/jitterx-agent"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.purge_expired(m.load_db())
PURGE
chmod 755 /usr/local/bin/jitterx-purge

cat > /etc/systemd/system/jitterx-purge.service << 'UNIT'
[Unit]
Description=Purga de cuentas Jitterx vencidas
[Service]
Type=oneshot
ExecStart=/usr/local/bin/jitterx-purge
UNIT
cat > /etc/systemd/system/jitterx-purge.timer << 'UNIT'
[Unit]
Description=Purga horaria de cuentas Jitterx
[Timer]
OnCalendar=hourly
Persistent=true
[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now jitterx-agent.service >/dev/null 2>&1
systemctl restart jitterx-agent.service
systemctl enable --now jitterx-purge.timer >/dev/null 2>&1

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q active; then
  ufw allow "$AGENT_PORT"/tcp >/dev/null 2>&1 || true
fi

sleep 1
if systemctl is-active --quiet jitterx-agent; then EST="ACTIVO"; else EST="ERROR (mira: journalctl -u jitterx-agent -n 30)"; fi

IP=$(curl -s4 --max-time 5 ifconfig.me 2>/dev/null || echo "tu-ip")
echo
echo "============================================================"
echo "  INSTALACION COMPLETA — Estado: $EST"
echo "============================================================"
echo
echo "  Copia estas 2 variables en Vercel (Settings > Environment"
echo "  Variables) y luego haz Redeploy:"
echo
echo "  AGENT_URL   = http://$HOST_DOMAIN:$AGENT_PORT"
echo "  AGENT_TOKEN = $TOKEN"
echo
echo "  Prueba local:"
echo "    curl -H \"x-agent-token: $TOKEN\" http://127.0.0.1:$AGENT_PORT/status"
echo
echo "  Comandos utiles:"
echo "    systemctl status jitterx-agent     estado"
echo "    journalctl -u jitterx-agent -f     logs en vivo"
echo "    nano /etc/jitterx-agent.conf       cambiar limites"
echo
echo "  Si tu proveedor tiene firewall propio (Oracle, AWS, GCP),"
echo "  abre tambien el puerto $AGENT_PORT/tcp en su panel."
echo "============================================================"
echo
