#!/usr/bin/env python3
"""
Recrea en un VPS NUEVO las cuentas que había en el VPS anterior.

Uso (en el VPS nuevo, como root, DESPUÉS de instalar el agente):
  1) Copia /etc/jitterx-users.json del VPS viejo al nuevo (scp).
  2) python3 restaurar-cuentas.py            -> crea los usuarios Linux
     python3 restaurar-cuentas.py --prueba   -> solo muestra lo que haría

Conserva usuario, contraseña, vencimiento, plan Premium y límite de conexiones.
Las cuentas ya vencidas y las que ya existen se omiten.
"""
import json, subprocess, sys, time
from datetime import datetime, timezone

DB = "/etc/jitterx-users.json"
LIMITS = "/etc/security/limits.d/jitterx.conf"
PRUEBA = "--prueba" in sys.argv

def run(*a, **k):
    if PRUEBA:
        print("   [prueba]", " ".join(a)); return subprocess.CompletedProcess(a, 0)
    return subprocess.run(a, capture_output=True, text=True, **k)

try:
    db = json.load(open(DB))
except Exception as e:
    sys.exit(f"No se pudo leer {DB}: {e}\nCopia primero el archivo del VPS anterior.")

try:
    limites = open(LIMITS).read()
except Exception:
    limites = ""

ok = omitidas = vencidas = fallos = 0
for name, rec in db.items():
    exp = float(rec.get("expires_at", 0))
    if exp <= time.time():
        vencidas += 1; continue
    if subprocess.run(["id", "-u", name], capture_output=True).returncode == 0:
        omitidas += 1; continue
    cmd = ["useradd", "-M", "-N", "-s", "/bin/false", "-e", datetime.fromtimestamp(exp, timezone.utc).strftime("%Y-%m-%d")]
    if rec.get("plan") == "premium":
        run("groupadd", "-f", "jxpremium"); cmd += ["-G", "jxpremium"]
    if run(*cmd, name).returncode != 0:
        print(f"!! {name}: no se pudo crear el usuario"); fallos += 1; continue
    if not PRUEBA:
        p = subprocess.run(["chpasswd"], input=f"{name}:{rec['password']}\n", capture_output=True, text=True)
        if p.returncode != 0:
            subprocess.run(["userdel", "-r", name]); print(f"!! {name}: no se pudo asignar la contraseña"); fallos += 1; continue
        if f"{name} hard maxlogins" not in limites:
            with open(LIMITS, "a") as f:
                f.write(f"{name} hard maxlogins {int(rec.get('max_login', 1))}\n")
    print(f"ok {name}  ({rec.get('plan', 'gratis')})")
    ok += 1

print(f"\nRestauradas: {ok} | ya existían: {omitidas} | vencidas (omitidas): {vencidas} | con error: {fallos}")
