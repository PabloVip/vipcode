import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crossSpawn from "cross-spawn";

// Lanza un programa. En Windows npm instala los programas como .cmd, que spawn no puede lanzar directamente:
// cross-spawn los lanza a través de cmd.exe con las comillas bien puestas
export function spawnProgram(command: string, args: string[], options: SpawnOptions): ChildProcess {
  if (process.platform === "win32") {
    return crossSpawn(command, args, options);
  }
  return spawn(command, args, options);
}

// Para un programa y todo lo que haya lanzado. En Windows no hay grupos de procesos: taskkill /T recorre los hijos
export function killTree(child: ChildProcess) {
  if (process.platform === "win32" && child.pid) {
    const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    taskkill.on("error", () => child.kill());
    return;
  }
  child.kill("SIGTERM");
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

function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH || env.Path || "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, name))) {
      return path.join(dir, name);
    }
  }
  return null;
}

// El bash de Git para Windows. No vale el de C:\Windows\System32, que es el de WSL y trabaja en otro sistema de ficheros
function gitBash(env: NodeJS.ProcessEnv): string | null {
  const candidates: string[] = [];
  const git = onPath("git.exe", env);
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
    if (base === "pwsh" || base === "powershell") {
      return powershell(custom);
    }
    if (base === "cmd") {
      return cmd(custom);
    }
    return bash(custom, base, platform !== "win32");
  }
  if (platform !== "win32") {
    return bash("bash", "bash", true);
  }
  const found = gitBash(env);
  return found ? bash(found, "Git Bash", false) : powershell(onPath("pwsh.exe", env) || "powershell.exe");
}

let cached: Shell | null = null;

export function commandShell(): Shell {
  cached ??= detectShell();
  return cached;
}
