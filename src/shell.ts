import { type ChildProcess, type ChildProcessByStdio, type SpawnOptions, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import crossSpawn from "cross-spawn";

// Lanza un programa. En Windows npm instala los programas como .cmd, que spawn no puede lanzar directamente:
// cross-spawn los lanza a través de cmd.exe con las comillas bien puestas
export function spawnProgram(command: string, args: string[], options: SpawnOptions): ChildProcess {
  if (process.platform === "win32") {
    return crossSpawn(command, args, options);
  }
  return spawn(command, args, options);
}

// Nombres de variables que suelen guardar claves (GEMINI_API_KEY, GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY…)
const SECRET_NAME = /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)(_|$)/i;

// Tu entorno sin las claves, para los programas que vipcode arranca por su cuenta (los servidores de lenguaje): no
// las necesitan, y así no se las podría llevar uno que estuviera comprometido
export function withoutSecrets(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !SECRET_NAME.test(name)) {
      clean[name] = value;
    }
  }
  return clean;
}

// Ruta completa de un programa, buscándolo solo en las carpetas absolutas del PATH. Nunca en la carpeta actual (la del
// proyecto): en Windows, lanzar un programa por su nombre lo busca ahí primero, así que un proyecto podría traer su
// propio rg.exe o git.exe y vipcode lo ejecutaría; en macOS y Linux pasaría lo mismo si el PATH tiene «.» o «::»
const programs = new Map<string, string | null>();

export function findProgram(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (path.isAbsolute(name)) {
    return fs.existsSync(name) ? name : null;
  }
  const dirs = env.PATH ?? env.Path ?? "";
  const key = `${name}\u0000${dirs}`;
  if (programs.has(key)) {
    return programs.get(key)!;
  }
  const extensions = process.platform === "win32" && !path.extname(name) ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  let found: string | null = null;
  for (const dir of dirs.split(path.delimiter)) {
    if (found || !dir || !path.isAbsolute(dir)) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension.toLowerCase());
      try {
        if (fs.statSync(candidate).isFile()) {
          found = candidate;
          break;
        }
      } catch {
        // no está en esta carpeta
      }
    }
  }
  programs.set(key, found);
  return found;
}

// Programas de Windows que siempre están en System32
function system32(name: string): string {
  return findProgram(name) || path.join(process.env.SystemRoot || "C:\\Windows", "System32", name);
}

// Para un programa y todo lo que haya lanzado. En Windows no hay grupos de procesos: taskkill /T recorre los hijos. En
// macOS y Linux se para su grupo de procesos (si se lanzó con spawnGroup; si no, solo él), y si en 3 s no ha parado, a
// la fuerza
export function killTree(child: ChildProcess) {
  if (process.platform === "win32" && child.pid) {
    const taskkill = spawn(system32("taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    taskkill.on("error", () => child.kill());
    return;
  }
  try {
    if (!child.pid) {
      throw new Error("sin pid");
    }
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    try {
      if (child.pid) {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      // ya había terminado
    }
  }, 3000).unref();
}

// Comandos que siguen en marcha en su propio grupo de procesos (macOS y Linux)
const groups = new Set<ChildProcess>();
const EXIT_SIGNALS = ["SIGHUP", "SIGTERM"] as const;

function stopGroups() {
  for (const child of groups) {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      // ya había terminado
    }
  }
  groups.clear();
}

// Si cierras la ventana de la terminal (o alguien para vipcode), se paran también los comandos que estén en marcha.
// Después la señal hace lo de siempre: sin este oyente, cerrar vipcode, o lo que hagan los demás (Ink deja la terminal
// como estaba)
function onExitSignal(signal: NodeJS.Signals) {
  stopGroups();
  for (const name of EXIT_SIGNALS) {
    process.removeListener(name, onExitSignal);
  }
  process.kill(process.pid, signal);
}

// Lanza un comando de la shell en su propio grupo de procesos (en macOS y Linux), para poder pararlo con todo lo que
// lance (npm test, un servidor…) con killTree. Fuera del grupo de vipcode la terminal ya no lo pararía al cerrar la
// ventana: se para al cerrarse vipcode. Sin entrada, y su salida se lee por stdout y stderr
export function spawnGroup(file: string, args: string[], options: Omit<SpawnOptions, "stdio" | "detached">): ChildProcessByStdio<null, Readable, Readable> {
  const child = spawn(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  if (process.platform !== "win32" && child.pid) {
    if (groups.size === 0) {
      process.removeListener("exit", stopGroups);
      process.on("exit", stopGroups);
      for (const name of EXIT_SIGNALS) {
        process.removeListener(name, onExitSignal);
        process.on(name, onExitSignal);
      }
    }
    groups.add(child);
    child.once("exit", () => groups.delete(child));
  }
  return child;
}

// Separa los argumentos respetando las comillas: a "b c" d → [a, b c, d]
export function splitArgs(text: string): string[] {
  const result: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    result.push(match[1] ?? match[2] ?? match[3]);
  }
  return result;
}

export interface Shell {
  // Cómo se le cuenta al modelo
  name: string;
  file: string;
  args(command: string): string[];
  env: Record<string, string>;
}

// El bash de Git para Windows. No vale el de C:\Windows\System32, que es el de WSL y trabaja en otro sistema de ficheros
function gitBash(env: NodeJS.ProcessEnv): string | null {
  const candidates: string[] = [];
  const git = findProgram("git.exe", env);
  if (git) {
    // git.exe está en …\Git\cmd, …\Git\bin o …\Git\mingw64\bin
    candidates.push(path.resolve(path.dirname(git), "..", "bin", "bash.exe"), path.resolve(path.dirname(git), "..", "..", "bin", "bash.exe"));
  }
  const local = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs") : undefined;
  for (const base of [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"], local]) {
    if (base) {
      candidates.push(path.join(base, "Git", "bin", "bash.exe"));
    }
  }
  return candidates.find((file) => fs.existsSync(file)) || null;
}

function bash(file: string, name: string, login: boolean): Shell {
  // CHERE_INVOKING: el bash de Git para Windows no se va a tu carpeta personal al arrancar
  return { name, file, args: (command) => [login ? "-lc" : "-c", command], env: { CHERE_INVOKING: "1" } };
}

function powershell(file: string): Shell {
  return {
    name: "PowerShell",
    file,
    // En UTF-8 (si no, las tildes salen rotas), sin barras de progreso y con el código de salida del último programa.
    // Va codificado para que las comillas del comando lleguen tal cual
    args: (command) => {
      const script = [
        "$ProgressPreference = 'SilentlyContinue'",
        "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
        command,
        "$vipcodeOk = $?",
        "if ($LASTEXITCODE) { exit $LASTEXITCODE }",
        "if (-not $vipcodeOk) { exit 1 }",
      ].join("\n");
      return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
    },
    env: {},
  };
}

function cmd(file: string): Shell {
  return { name: "cmd", file, args: (command) => ["/d", "/s", "/c", command], env: {} };
}

// La shell de los comandos: bash en macOS y Linux; en Windows, el bash de Git para Windows si lo tienes (los modelos
// escriben comandos de bash) y si no, PowerShell. VIPCODE_SHELL permite elegir otra (bash, pwsh, powershell o cmd)
export function detectShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Shell {
  const custom = env.VIPCODE_SHELL;
  if (custom) {
    const base = path.basename(custom).toLowerCase().replace(/\.exe$/, "");
    const file = findProgram(custom, env) || custom;
    if (base === "pwsh" || base === "powershell") {
      return powershell(file);
    }
    if (base === "cmd") {
      return cmd(file);
    }
    return bash(file, base, platform !== "win32");
  }
  if (platform !== "win32") {
    return bash(findProgram("bash", env) || "/bin/bash", "bash", true);
  }
  const found = gitBash(env);
  if (found) {
    return bash(found, "Git Bash", false);
  }
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return powershell(findProgram("pwsh.exe", env) || findProgram("powershell.exe", env) || path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
}

let cached: Shell | null = null;

export function commandShell(): Shell {
  cached ??= detectShell();
  return cached;
}
