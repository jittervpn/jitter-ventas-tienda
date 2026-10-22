#!/usr/bin/env python3
"""
Agente Jitterx para VPS — crea cuentas SSH/WebSocket bajo demanda.
Escucha peticiones firmadas con un token compartido y crea usuarios Linux
con expiración automática y límite de conexiones simultáneas.

Instalar con install.sh. Config en /etc/jitterx-agent.conf
"""
import json, os, re, subprocess, secrets, string, hmac, time, threading, uuid, shutil, tempfile
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
DAYS       = int(cfg.get("DAYS", "2"))
MAX_LOGIN  = int(cfg.get("MAX_LOGIN", "1"))
MAX_USERS  = int(cfg.get("MAX_USERS", "100"))
FREE_PER_IP = int(cfg.get("FREE_PER_IP", "3"))     # cuentas gratis máx. por IP en 24 h (redes móviles comparten IP: no bajar mucho)
PAID_RESERVE = int(cfg.get("PAID_RESERVE", "20"))   # plazas extra solo para cuentas pagas
PREFIX     = cfg.get("USER_PREFIX", "jx")
DB         = "/etc/jitterx-users.json"
STATS      = "/etc/jitterx-stats.json"   # contador histórico de cuentas Premium vendidas
AUDIT      = "/var/log/jitterx-audit.log"
# Lista blanca opcional: si está vacía, se acepta cualquier IP con token válido
ALLOWED_IPS = [x.strip() for x in cfg.get("ALLOWED_IPS", "").split(",") if x.strip()]
MAX_FAILS   = int(cfg.get("MAX_FAILS", "5"))       # fallos de token antes de bloquear
BAN_MINUTES = int(cfg.get("BAN_MINUTES", "60"))
RATE_MAX    = int(cfg.get("RATE_MAX", "20"))       # peticiones por minuto y por IP

# ---- V2Ray (Xray, VLESS por WebSocket): se activa solo si Xray existe en el VPS ----
V2_ENABLED = cfg.get("V2_ENABLED", "1") != "0"
XRAY_BIN   = cfg.get("XRAY_BIN") or shutil.which("xray") or "/usr/local/bin/xray"
XRAY_API   = cfg.get("XRAY_API", "127.0.0.1:10085")
V2_TAG     = cfg.get("V2_TAG", "vless-ws")
V2_PATH    = cfg.get("V2_PATH", "/vless")
V2_PORT    = int(cfg.get("V2_PORT", "10000"))
XRAY_SVC   = cfg.get("XRAY_SERVICE", "xray")

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


# ---------------- V2Ray / Xray ----------------
_pending = set()   # usuarios cuyo alta en Xray falló: se reintenta en el bucle de sincronización


def xray_ready():
    return V2_ENABLED and os.path.exists(XRAY_BIN)


def xray_add(name, uid):
    """Da de alta al usuario en Xray en caliente. Devuelve True si quedó registrado (o ya existía)."""
    if not xray_ready():
        return False
    fd, path = tempfile.mkstemp(suffix=".json", prefix="xadd-")   # 0600; la extensión .json la exige Xray
    try:
        with os.fdopen(fd, "w") as f:
            json.dump({"inbounds": [{"tag": V2_TAG, "protocol": "vless", "port": V2_PORT,
                                     "settings": {"clients": [{"id": uid, "email": name, "level": 0}],
                                                  "decryption": "none"}}]}, f)
        r = subprocess.run([XRAY_BIN, "api", "adu", "-s", XRAY_API, path], capture_output=True, text=True, timeout=8)
        out = (r.stdout + r.stderr).lower()
        ok = r.returncode == 0 or "already exists" in out
        if ok:
            _pending.discard(name)
        else:
            _pending.add(name)
            audit(f"XRAY alta fallida usuario={name} rc={r.returncode}")
        return ok
    except Exception as e:
        _pending.add(name)
        audit(f"XRAY alta error usuario={name} {e}")
        return False
    finally:
        try:
            os.remove(path)
        except Exception:
            pass


def xray_remove(name):
    if not xray_ready():
        return
    _pending.discard(name)
    try:
        subprocess.run([XRAY_BIN, "api", "rmu", "-s", XRAY_API, f"-tag={V2_TAG}", name],
                       capture_output=True, text=True, timeout=8)
    except Exception as e:
        audit(f"XRAY baja error usuario={name} {e}")


def xray_stamp():
    """Marca de arranque de Xray: si cambia, Xray se reinició y perdió los usuarios dados de alta en caliente."""
    try:
        r = subprocess.run(["systemctl", "show", XRAY_SVC, "-p", "ActiveEnterTimestampMonotonic", "--value"],
                           capture_output=True, text=True, timeout=5)
        return r.stdout.strip()
    except Exception:
        return ""


def xray_sync_all():
    """Da de alta en Xray todas las cuentas activas. Las cuentas antiguas sin UUID reciben uno ahora."""
    if not xray_ready():
        return
    with _LOCK:
        db = purge_expired(load_db())
        changed = False
        for name, rec in db.items():
            if not rec.get("uuid"):
                rec["uuid"] = str(uuid.uuid4())
                changed = True
        if changed:
            save_db(db)
        items = [(n, r["uuid"]) for n, r in db.items()]
    for name, uid in items:
        xray_add(name, uid)


def xray_watch():
    """Hilo de fondo: re-sincroniza cuando Xray se reinicia, reintenta altas fallidas y purga cuentas vencidas."""
    last = None
    while True:
        try:
            cur = xray_stamp()
            if cur != last and cur not in ("", "0"):
                xray_sync_all()
                last = cur
            elif _pending:
                db = load_db()
                for name in list(_pending):
                    if name in db and db[name].get("uuid"):
                        xray_add(name, db[name]["uuid"])
                    else:
                        _pending.discard(name)
            with _LOCK:
                purge_expired(load_db())
        except Exception as e:
            audit(f"XRAY watch error {e}")
        time.sleep(15)


def purge_expired(db):
    """Borra del sistema los usuarios cuya fecha ya pasó."""
    now = time.time()
    changed = False
    for name, rec in list(db.items()):
        if rec["expires_at"] <= now:
            sh("pkill", "-9", "-u", name)
            sh("userdel", "-r", name)
            xray_remove(name)
            del db[name]
            changed = True
    if changed:
        save_db(db)
    return db


def gen_password(n=10):
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


_LOCK = threading.Lock()


def create_account(*a, **k):
    with _LOCK:  # una creación a la vez: evita cuentas duplicadas si llegan dos avisos del mismo pago
        return _create_account(*a, **k)


def _create_account(username, device, days=None, ref="", max_login=None, paid=False, ip=""):
    db = purge_expired(load_db())
    if ref:  # idempotente: si MP reenvía el aviso, no se duplica la cuenta
        for name, rec in db.items():
            if rec.get("ref") == ref:
                return 200, {"ok": True, "account": public(name, rec)}
    eff_days = min(max(int(days or DAYS), 1), 60) if paid else DAYS
    eff_login = min(max(int(max_login or MAX_LOGIN), 1), 5) if paid else MAX_LOGIN

    # Los clientes que pagan tienen plazas reservadas: no se quedan fuera aunque las cuentas gratis llenen el servidor
    if len(db) >= MAX_USERS + (PAID_RESERVE if paid else 0):
        return 503, {"error": "El servidor alcanzó el límite de cuentas. Inténtalo más tarde."}

    # 1 cuenta por dispositivo
    for name, rec in (db.items() if not paid else []):
        if rec.get("device") == device:
            return 429, {"error": "Ya tienes una cuenta activa. Podrás crear otra cuando expire.",
                         "account": public(name, rec)}

    # Tope de cuentas gratis por IP y día (persistente: sale de las cuentas guardadas en disco)
    if not paid and ip:
        desde = time.time() - 86400
        n = sum(1 for r in db.values() if r.get("ip") == ip and r.get("plan") != "premium" and r.get("created_at", 0) >= desde)
        if n >= FREE_PER_IP:
            return 429, {"error": "Se alcanzó el límite de cuentas gratis desde tu red hoy. Inténtalo mañana o compra un plan Premium."}

    if paid and not username:
        while True:
            username = "jx" + "".join(secrets.choice(string.digits) for _ in range(6))
            if username not in db and not system_user_exists(username):
                break
    if not USER_RE.match(username):
        return 400, {"error": "Usuario inválido: 3-16 caracteres, empieza por letra, solo minúsculas y números."}
    if username in RESERVED or username in db or system_user_exists(username):
        return 409, {"error": "Ese usuario ya está en uso, elige otro."}

    password = gen_password()
    expires = datetime.now(timezone.utc) + timedelta(days=eff_days)
    exp_str = expires.strftime("%Y-%m-%d")

    cmd = ["useradd", "-M", "-N", "-s", "/bin/false", "-e", exp_str]
    if paid:  # el grupo permite mostrar un banner distinto a los Premium (ver banner.sh)
        sh("groupadd", "-f", "jxpremium")
        cmd += ["-G", "jxpremium"]
    r = sh(*cmd, username)
    if r.returncode != 0:
        return 500, {"error": "No se pudo crear el usuario en el sistema."}
    p = subprocess.run(["chpasswd"], input=f"{username}:{password}\n", capture_output=True, text=True)
    if p.returncode != 0:
        sh("userdel", "-r", username)
        return 500, {"error": "No se pudo asignar la contraseña."}

    # Límite de conexiones simultáneas
    with open("/etc/security/limits.d/jitterx.conf", "a") as f:
        f.write(f"{username} hard maxlogins {eff_login}\n")

    rec = {"password": password, "device": device, "ref": ref or "",
           "uuid": str(uuid.uuid4()) if xray_ready() else "",
           "plan": "premium" if paid else "gratis", "max_login": eff_login, "ip": ip,
           "created_at": time.time(), "expires_at": expires.timestamp()}
    db[username] = rec
    save_db(db)
    if rec["uuid"]:
        xray_add(username, rec["uuid"])   # si falla, la cuenta SSH sigue válida y el hilo de fondo reintenta
    if paid:
        bump_premium()
    return 201, {"ok": True, "account": public(username, rec)}


def load_stats():
    try:
        with open(STATS) as f:
            return json.load(f)
    except Exception:
        return {}


def bump_premium():
    st = load_stats()
    st["premium_sold"] = int(st.get("premium_sold", 0)) + 1
    tmp = STATS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f)
    os.replace(tmp, STATS)


def public(name, rec):
    v2 = {"uuid": rec["uuid"], "v2_path": V2_PATH} if rec.get("uuid") else {}
    return {
        **v2,
        "username": name, "password": rec["password"],
        "host": HOST_DOM, "ws_port": WS_PORT, "ssl_port": SSL_PORT, "ssh_port": SSH_PORT,
        "created_at": int(rec["created_at"] * 1000),
        "expires_at": int(rec["expires_at"] * 1000),
        "max_login": rec.get("max_login", MAX_LOGIN),
        "plan": rec.get("plan", "gratis"),
    }


def find_by_device(device):
    db = purge_expired(load_db())
    mine = [(rec["expires_at"], name, rec) for name, rec in db.items() if rec.get("device") == device]
    if mine:
        _, name, rec = max(mine, key=lambda m: (m[2].get("plan") == "premium", m[0]))
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
            prem_active = sum(1 for r in db.values() if r.get("plan") == "premium")
            return self.reply(200, {
                "ok": True, "active": len(db), "max": MAX_USERS, "online": online_users(db),
                "premium_active": prem_active,
                "premium_sold": max(int(load_stats().get("premium_sold", 0)), prem_active),
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
        code, out = create_account(username, device, days=data.get("days"), ref=str(data.get("ref", "")).strip(), max_login=data.get("max_login"), paid=bool(data.get("paid")), ip=(real_ip if real_ip != "-" else ""))
        if code == 201:
            audit(f"CUENTA usuario={username} device={device[:8]} ip_usuario={real_ip} origen={self.peer}")
        self.reply(code, out)


if __name__ == "__main__":
    purge_expired(load_db())
    if xray_ready():
        threading.Thread(target=xray_watch, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
