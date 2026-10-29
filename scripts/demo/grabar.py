# Graba una sesión real de vipcode en una pseudo-terminal (formato asciicast v2) para la animación del README.
# Lo lanza scripts/demo/hacer.mjs (npm run demo) con: <dist/index.js> <carpeta personal de prueba> <proyecto> <salida.cast>
import codecs
import fcntl
import json
import os
import pty
import random
import re
import select
import struct
import sys
import termios
import time

CLI, HOME, PROJECT, OUT = sys.argv[1:5]
COLS, ROWS = 100, 37
PROMPT = "El descuento de carrito.js es un porcentaje, pero se resta tal cual. ¿Lo arreglas?"
ANSI = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]")

env = {
    "PATH": os.environ["PATH"],
    "HOME": HOME,
    "VIPCODE_HOME": os.path.join(HOME, ".vipcode"),
    "TERM": "xterm-256color",
    "LANG": "es_ES.UTF-8",
}

pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    os.chdir(PROJECT)
    os.execvpe("node", ["node", CLI], env)

start = time.time()
events = []
plain = ""
# Un carácter de varios bytes puede llegar partido entre dos lecturas: el decodificador incremental los junta
decoder = codecs.getincrementaldecoder("utf-8")("replace")


def pump(seconds):
    """Lee lo que escribe vipcode durante unos segundos y lo apunta con su tiempo."""
    global plain
    end = time.time() + seconds
    while True:
        left = end - time.time()
        if left <= 0:
            return
        ready, _, _ = select.select([fd], [], [], min(left, 0.05))
        if ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            if not data:
                return
            text = decoder.decode(data)
            if text:
                events.append([round(time.time() - start, 4), "o", text])
                plain += ANSI.sub("", text)


def wait_for(pattern, timeout, since=0):
    """Espera a que aparezca el patrón en la pantalla (a partir de la posición since)."""
    end = time.time() + timeout
    while time.time() < end:
        found = re.search(pattern, plain[since:])
        if found:
            return since + found.end()
        pump(0.1)
    raise SystemExit(f"no aparece {pattern!r}\n---\n{plain[-3000:]}")


def send(text):
    os.write(fd, text.encode("utf-8"))


def marker(name):
    """Marca en la grabación (para acelerar después las esperas al modelo)."""
    events.append([round(time.time() - start, 4), "m", name])


wait_for(r"Escribe tu mensaje", 30)
pump(2.5)
marker("escribe")
for char in PROMPT:
    send(char)
    pump(random.uniform(0.035, 0.085))
pump(0.8)
send("\r")
marker("espera")
mark = len(plain)

# Hasta que conteste: se aceptan las ediciones; un comando solo si es un node sin nada más detrás
answered = None
deadline = time.time() + 240
while time.time() < deadline:
    pump(0.2)
    tail = plain[mark:]
    dialog = re.search(r"\? (Editar|Crear|Sobrescribir|Ejecutar)[^\n]*", tail)
    if dialog:
        marker("dialogo")
        pump(3.0)
        if dialog.group(1) == "Ejecutar":
            command = re.search(r"\$ ([^\n]+)", plain[mark + dialog.start():])
            safe = command and re.match(r"^node [\w ./=-]+$", command.group(1).strip())
            send("s" if safe else "n")
        else:
            send("s")
        # El diálogo se sigue viendo un momento: se espera a que se cierre antes de buscar el siguiente
        marker("espera")
        pump(1.5)
        mark = len(plain)
        continue
    footer = re.search(r"◆ \S+/\S+[^\n]* · (<1|\d+(,\d)?) s", tail)
    if footer and re.search(r"Escribe tu mensaje", tail[footer.end():]):
        answered = time.time()
        marker("hecho")
        break
if not answered:
    raise SystemExit(f"no ha terminado\n---\n{plain[-3000:]}")

pump(5.0)
events.append([round(time.time() - start, 4), "m", "fin"])
send("\x03")
pump(0.4)
send("\x03")
pump(1.5)
try:
    os.kill(pid, 9)
except OSError:
    pass

with open(OUT, "w", encoding="utf-8") as out:
    out.write(json.dumps({"version": 2, "width": COLS, "height": ROWS, "timestamp": int(start)}) + "\n")
    for event in events:
        out.write(json.dumps(event, ensure_ascii=False) + "\n")
with open(OUT + ".txt", "w", encoding="utf-8") as out:
    out.write(plain)
print(f"{len(events)} eventos, {events[-1][0]:.1f} s")
