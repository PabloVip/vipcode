import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import type { App } from "./app.js";
import { resolveCredentials } from "./auth.js";
import { clipboardProgram } from "./clipboard.js";
import { isAnonymous } from "./config.js";
import type { ProviderConfig } from "./config.js";
import { installedLanguageServers } from "./lsp.js";
import { VERSION } from "./meta.js";
import { AUTH_PATH, HOME_DIR } from "./paths.js";
import { stripControl } from "./sanitize.js";
import { commandShell, findProgram } from "./shell.js";
import { compareVersions, latestRelease, packageRoot } from "./update.js";

// vipcode doctor: qué funciona, qué falta y cómo arreglarlo. No lleva claves: se puede pegar en un issue

const ok = (text: string) => `${pc.green("✓")} ${text}`;
const warn = (text: string) => `${pc.yellow("⚠")} ${text}`;
const bad = (text: string) => `${pc.red("✗")} ${text}`;
const note = (text: string) => `${pc.dim("·")} ${text}`;

function tildify(file: string): string {
  const home = os.homedir();
  return file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

// Cómo instalar algo según el sistema
function install(what: { darwin: string; linux: string; win32: string }): string {
  if (process.platform === "darwin") {
    return what.darwin;
  }
  return process.platform === "win32" ? what.win32 : what.linux;
}

// En Windows, sin Git para Windows los comandos van por PowerShell (los modelos escriben bash) y /undo no puede
// deshacer lo que cambien los comandos
export function gitAdvice(platform: NodeJS.Platform, hasGit: boolean, shellName: string, customShell: boolean): string | null {
  if (platform !== "win32" || (hasGit && (shellName === "Git Bash" || customShell))) {
    return null;
  }
  return "Instala Git para Windows y vipcode irá mejor: los comandos usarán bash (los modelos los escriben así) y /undo podrá deshacer lo que cambien. Es un comando: winget install Git.Git (después cierra y vuelve a abrir la terminal).";
}

function version(program: string, args = ["--version"]): string | null {
  try {
    return execFileSync(program, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim().split("\n")[0];
  } catch {
    return null;
  }
}

// ¿Responde el proveedor? (pide la lista de modelos con tu clave, como al conectarlo)
async function probe(provider: ProviderConfig): Promise<string> {
  const label = provider.label || provider.name;
  const credentials = resolveCredentials(provider);
  if (!credentials) {
    return bad(`${label}: falta la clave`);
  }
  try {
    const headers: Record<string, string> = { ...(provider.headers || {}) };
    if (credentials.apiKey !== "no-key") {
      headers.authorization = `Bearer ${credentials.apiKey}`;
    }
    const response = await fetch(`${credentials.baseURL.replace(/\/+$/, "")}/models`, { headers, signal: AbortSignal.timeout(8000) });
    if (response.status === 401 || response.status === 403) {
      return bad(`${label}: la clave no funciona (HTTP ${response.status}). Cámbiala con /connect ${provider.name}`);
    }
    if (!response.ok) {
      return warn(`${label}: responde con un error (HTTP ${response.status})`);
    }
    return ok(`${label}: ${credentials.apiKey === "no-key" ? "responde" : "clave correcta"}`);
  } catch (err) {
    return warn(`${label}: no responde (${stripControl((err as Error).message).slice(0, 80)})`);
  }
}

export async function doctorReport(app: App): Promise<string> {
  const lines: string[] = [];
  const root = packageRoot();
  const fromGit = fs.existsSync(path.join(root, ".git"));
  lines.push(pc.bold(`vipcode ${VERSION}`) + pc.dim(` · ${fromGit ? "desde el código" : "instalado con npm"} (${tildify(root)})`));
  try {
    const latest = await latestRelease();
    if (latest && compareVersions(latest.version, VERSION) > 0) {
      lines.push(warn(`Hay una versión nueva: ${latest.version}. Escribe /update (o vipcode update)`));
    } else {
      lines.push(ok("Es la última versión"));
    }
  } catch {
    lines.push(note("No he podido mirar si hay una versión nueva"));
  }
  const node = Number(process.versions.node.split(".")[0]);
  lines.push(node >= 22 ? ok(`Node.js ${process.version}`) : bad(`Node.js ${process.version}: vipcode necesita la 22 o una más nueva`));
  const system = { darwin: "macOS", win32: "Windows", linux: "Linux" }[process.platform as string] || process.platform;
  lines.push(note(`${system} (${process.arch})${process.env.TERM_PROGRAM ? ` · terminal: ${stripControl(process.env.TERM_PROGRAM)}` : ""}`));

  // Programas que usa vipcode
  const shell = commandShell();
  const git = findProgram("git");
  lines.push(shell.name === "PowerShell" ? warn(`Los comandos van por PowerShell (${tildify(shell.file)}): los modelos escriben bash`) : ok(`Los comandos van por ${shell.name} (${tildify(shell.file)})`));
  const gitVersion = git ? version(git) : null;
  lines.push(
    gitVersion
      ? ok(`${gitVersion.replace(/^git version/, "git")}: /undo deshace también lo que cambien los comandos`)
      : bad(`No está git: /undo no podrá deshacer lo que cambien los comandos. Instálalo: ${install({ darwin: "xcode-select --install", linux: "sudo apt install git (o dnf install git)", win32: "winget install Git.Git" })}`),
  );
  const advice = gitAdvice(process.platform, git !== null, shell.name, Boolean(process.env.VIPCODE_SHELL));
  if (advice && gitVersion) {
    lines.push(warn(advice));
  }
  const rg = findProgram("rg");
  lines.push(rg ? ok("ripgrep: búsquedas rápidas") : note(`ripgrep no está (opcional, busca más rápido): ${install({ darwin: "brew install ripgrep", linux: "sudo apt install ripgrep", win32: "winget install BurntSushi.ripgrep.MSVC" })}`));
  const copier = clipboardProgram();
  lines.push(copier ? ok(`/copiar usa ${copier}`) : warn("No hay programa para copiar: /copiar se lo pedirá a la terminal. En Linux instala wl-clipboard (Wayland) o xclip"));

  // Tus datos: solo para tu usuario
  if (process.platform !== "win32") {
    try {
      const open = (fs.statSync(HOME_DIR).mode & 0o077) !== 0;
      const authOpen = fs.existsSync(AUTH_PATH) && (fs.statSync(AUTH_PATH).mode & 0o077) !== 0;
      if (open || authOpen) {
        lines.push(bad(`Otros usuarios de este ordenador pueden leer tus datos de vipcode: chmod 700 ${tildify(HOME_DIR)}${authOpen ? ` && chmod 600 ${tildify(AUTH_PATH)}` : ""}`));
      } else {
        lines.push(ok(`Tus datos (${tildify(HOME_DIR)}) solo los puede leer tu usuario`));
      }
    } catch {
      lines.push(note(`Todavía no hay datos en ${tildify(HOME_DIR)}`));
    }
  }

  // Proveedores: ¿responden y funcionan tus claves?
  const slots = app.router.slots;
  const providers = [...new Set(slots.map((slot) => slot.provider))];
  lines.push("", pc.bold(`Modelos: ${slots.length} de ${providers.length} proveedor${providers.length === 1 ? "" : "es"}`) + pc.dim(` (${app.router.availableCount()} disponibles ahora)`));
  if (providers.length === 0) {
    lines.push(bad("No hay ningún modelo: añade una clave gratis con /connect (o vipcode auth login)"));
  }
  const probes = await Promise.all(providers.filter((provider) => !provider.local).map((provider) => probe(provider)));
  lines.push(...probes);
  for (const provider of providers.filter((item) => item.local)) {
    lines.push(ok(`${provider.label || provider.name}: encendido en tu ordenador`));
  }
  if (providers.length > 0 && providers.every((provider) => isAnonymous(provider) && resolveCredentials(provider)?.apiKey === "no-key")) {
    lines.push(note("Solo usas IAs sin registro: con una cuenta gratuita (/connect) tendrás más mensajes y más modelos"));
  }

  // Esta carpeta
  lines.push("", pc.bold("Esta carpeta"));
  if (app.trust.files.length === 0) {
    lines.push(note("No trae configuración de vipcode"));
  } else if (app.trusted) {
    lines.push(ok(`Trae configuración de vipcode (${app.trust.files.join(", ")}) y confías en ella`));
  } else {
    lines.push(warn(`Trae configuración de vipcode (${app.trust.files.join(", ")}) que no se usa: si confías en la carpeta, vipcode trust`));
  }
  const mcp = Object.keys(app.config.mcp || {});
  if (mcp.length > 0) {
    lines.push(note(`Servidores MCP: ${mcp.join(", ")} (/mcp dice si están conectados)`));
  }
  const servers = installedLanguageServers();
  lines.push(note(`Servidores de lenguaje: ${servers.length > 0 ? servers.join(", ") : "ninguno"}`));

  lines.push("", pc.dim("Si abres un issue, puedes pegar este informe: no lleva tus claves."));
  return lines.join("\n");
}
