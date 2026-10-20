#!/bin/bash
# =====================================================================
#  Jitterx - Limite REAL de conexiones simultaneas por cuenta (OpenSSH)
#
#  Uso (como root, en cada VPS):  bash limite-conexiones.sh
#  Deshacer:                      bash limite-conexiones.sh --quitar
#
#  - Rechaza la conexion NUEVA cuando la cuenta ya tiene su maximo.
#  - Un vigilante corta las sobrantes (las mas nuevas) por si entran dos a la vez.
#  - Cierra sesiones "fantasma" (cortes de red) en ~1 minuto con keepalive.
# =====================================================================
set -e
[ "$(id -u)" = "0" ] || { echo "Ejecuta como root."; exit 1; }

BIN=/usr/local/bin/jitterx-limit
PAMF=/etc/pam.d/sshd
LINEA='account    required     pam_exec.so quiet /usr/local/bin/jitterx-limit check'

recargar_ssh() { sshd -t && { systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true; }; }

if [ "$1" = "--quitar" ]; then
  systemctl disable --now jitterx-limit.service 2>/dev/null || true
  rm -f /etc/systemd/system/jitterx-limit.service /etc/ssh/sshd_config.d/jitterx-keepalive.conf
  sed -i '\#jitterx-limit check#d' "$PAMF"
  systemctl daemon-reload; recargar_ssh
  echo "Limite de conexiones desactivado (el archivo $BIN se conserva)."
  exit 0
fi

command -v python3 >/dev/null || { echo "Falta python3."; exit 1; }
[ -f "$PAMF" ] || { echo "No existe $PAMF: este VPS no usa PAM para SSH."; exit 1; }
sshd -T 2>/dev/null | grep -qi '^usepam yes' || { echo "sshd tiene UsePAM desactivado. Activalo en /etc/ssh/sshd_config (UsePAM yes) y repite."; exit 1; }

echo "-> Instalando el control en $BIN"
cat > "$BIN" << 'LIMITPY_EOF'
#!/usr/bin/env python3
"""
jitterx-limit: hace cumplir el limite de conexiones simultaneas de cada cuenta SSH.

Por que hace falta: 'maxlogins' (pam_limits) solo cuenta sesiones con terminal, y los
tuneles (HTTP Custom, NetMod...) no abren terminal, asi que nunca se cuentan.

  check     lo llama PAM (pam_exec) al iniciar sesion. Sale con 1 si el usuario ya tiene
            su maximo de conexiones: la conexion NUEVA se rechaza.
  watch     vigila cada pocos segundos y corta las conexiones sobrantes (las mas nuevas).
            Cubre el caso de dos conexiones que entran a la vez.
  selftest  comprobacion rapida de la logica.

Los limites salen de /etc/security/limits.d/jitterx.conf (lineas "usuario hard maxlogins N"),
que ya escribe el agente al crear cada cuenta. Los usuarios sin linea (root, tu admin) no se tocan.
Si algo falla, 'check' deja pasar: nunca bloquea el acceso por un error propio.
"""
import os, re, signal, subprocess, sys, time

LIMITS = os.environ.get("JX_LIMITS", "/etc/security/limits.d/jitterx.conf")
AUDIT = os.environ.get("JX_AUDIT", "/var/log/jitterx-audit.log")
# 'sshd: usuario@notty'  /  'sshd: usuario@pts/0'  /  'sshd-session: usuario@notty' (OpenSSH 9.8+)
SESION = re.compile(r"^sshd(?:-session)?: ([^@\s\[]+)@")


def log(msg):
    try:
        with open(AUDIT, "a") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S") + " LIMITE " + msg + "\n")
    except Exception:
        pass


def limites():
    out = {}
    try:
        for line in open(LIMITS):
            p = line.split()
            if len(p) >= 4 and not p[0].startswith("#") and p[1] == "hard" and p[2] == "maxlogins":
                out[p[0]] = int(p[3])
    except Exception:
        pass
    return out


def sesiones(texto=None):
    """{usuario: [(segundos_conectado, pid), ...]} a partir de 'ps'."""
    if texto is None:
        if os.environ.get("JX_PS_FILE"):
            texto = open(os.environ["JX_PS_FILE"]).read()
        else:
            texto = subprocess.run(["ps", "-eo", "pid=,etimes=,args="], capture_output=True, text=True).stdout
    res = {}
    for line in texto.splitlines():
        p = line.split(None, 2)
        if len(p) < 3 or not p[0].isdigit() or not p[1].isdigit():
            continue
        m = SESION.match(p[2])
        if m:
            res.setdefault(m.group(1), []).append((int(p[1]), int(p[0])))
    return res


def sobrantes(ses, lim):
    """[(usuario, pid)] a cerrar: las conexiones MAS NUEVAS por encima del maximo de cada usuario."""
    out = []
    for u, lista in ses.items():
        n = lim.get(u)
        if n is None or len(lista) <= n:
            continue
        out += [(u, pid) for _, pid in sorted(lista)[: len(lista) - n]]  # menor antiguedad = mas nueva
    return out


def check():
    try:
        u = os.environ.get("PAM_USER", "")
        n = limites().get(u)
        if n is None:
            return 0
        if len(sesiones().get(u, [])) >= n:
            log(f"usuario={u} rechazado: ya tiene {n} conexion(es) activa(s)")
            return 1
    except Exception:
        pass
    return 0


def watch():
    while True:
        try:
            for u, pid in sobrantes(sesiones(), limites()):
                try:
                    os.kill(pid, signal.SIGTERM)
                    log(f"usuario={u} conexion sobrante cerrada pid={pid}")
                except ProcessLookupError:
                    pass
        except Exception:
            pass
        time.sleep(3)


def selftest():
    ps = """\
    1 99999 sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups
  100  9000 sshd: jx1 [priv]
  101  5000 sshd: jx1@notty
  102   100 sshd: jx1@notty
  103     3 sshd: jx2@notty
  104  7000 sshd-session: jx3@notty
  105    50 sshd-session: jx3@notty
  106    40 sshd-session: jx3@notty
  107  1000 sshd: root@pts/0
"""
    lim = {"jx1": 1, "jx2": 2, "jx3": 2}
    ses = sesiones(ps)
    assert sorted(len(v) for v in ses.values()) == [1, 1, 2, 3], ses
    # jx1 tiene 2 con limite 1 -> cierra la mas nueva (102); jx3 tiene 3 con limite 2 -> cierra la mas nueva (106)
    assert sorted(sobrantes(ses, lim)) == [("jx1", 102), ("jx3", 106)], sobrantes(ses, lim)
    assert "root" in ses and "root" not in lim  # root no tiene limite: nunca se corta
    print("selftest OK")
    return 0


if __name__ == "__main__":
    modo = sys.argv[1] if len(sys.argv) > 1 else ""
    if modo == "check":
        sys.exit(check())
    if modo == "watch":
        watch()
    if modo == "selftest":
        sys.exit(selftest())
    print(__doc__)
    sys.exit(2)
LIMITPY_EOF
chmod 755 "$BIN"
"$BIN" selftest

echo "-> Configurando PAM (copia de seguridad en $PAMF.jitterx.bak)"
[ -f "$PAMF.jitterx.bak" ] || cp "$PAMF" "$PAMF.jitterx.bak"
if ! grep -q 'jitterx-limit check' "$PAMF"; then
  if grep -q '^@include common-account' "$PAMF"; then
    sed -i "/^@include common-account/a $LINEA" "$PAMF"
  else
    echo "$LINEA" >> "$PAMF"
  fi
fi
# El usuario root no tiene limite: debe pasar siempre
PAM_USER=root "$BIN" check || { echo "ERROR: la comprobacion bloquearia a root. Restaurando PAM."; cp "$PAMF.jitterx.bak" "$PAMF"; exit 1; }

echo "-> Keepalive de SSH (cierra sesiones fantasma en ~1 minuto)"
mkdir -p /etc/ssh/sshd_config.d
printf 'ClientAliveInterval 30\nClientAliveCountMax 2\n' > /etc/ssh/sshd_config.d/jitterx-keepalive.conf
recargar_ssh

echo "-> Servicio vigilante"
cat > /etc/systemd/system/jitterx-limit.service << 'UNIT'
[Unit]
Description=Jitterx - corta conexiones SSH por encima del limite de cada cuenta
After=network.target ssh.service

[Service]
ExecStart=/usr/local/bin/jitterx-limit watch
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now jitterx-limit.service >/dev/null 2>&1
systemctl restart jitterx-limit.service

echo
echo "LISTO. Prueba: conecta una cuenta de 1 conexion y luego intenta con otro dispositivo."
echo "Registro de rechazos:  grep LIMITE /var/log/jitterx-audit.log"
echo "Si algo sale mal:      bash limite-conexiones.sh --quitar"
