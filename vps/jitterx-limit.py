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
