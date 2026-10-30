import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasSecurity, parseChangelog, sectionsBetween } from "./changelog.js";
import { PACKAGE_NAME, REPO_URL, VERSION } from "./meta.js";
import { INSTALL_DIR, UPDATE_PATH, ensureHomeDir, isInside } from "./paths.js";
import { findProgram, spawnProgram } from "./shell.js";

// Cada cuánto se vuelve a mirar si hay una versión nueva (con un día, el aviso llegaba tarde a quien ya lo había abierto)
export const CHECK_MS = 60 * 60 * 1000;

// Carpeta donde está instalado vipcode (la que contiene dist/). VIPCODE_INSTALL_ROOT permite fingir otra en las pruebas
export function packageRoot(): string {
  return process.env.VIPCODE_INSTALL_ROOT || INSTALL_DIR;
}

// "v0.10.1" frente a "0.9.3": positivo si a es más nueva
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) =>
    version
      .replace(/^v/, "")
      .split("-")[0]
      .split(".")
      .map((part) => Number(part) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] || 0) - (y[i] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

// API de GitHub del repositorio (VIPCODE_UPDATE_URL permite usar otra, por ejemplo en las pruebas)
function apiBase(): string {
  return process.env.VIPCODE_UPDATE_URL || REPO_URL.replace("https://github.com/", "https://api.github.com/repos/");
}

// Registro de npm (VIPCODE_REGISTRY_URL permite usar otro, por ejemplo en las pruebas)
function registryBase(): string {
  return (process.env.VIPCODE_REGISTRY_URL || "https://registry.npmjs.org").replace(/\/+$/, "");
}

export interface Release {
  version: string;
  // Lo que se instala con «npm install -g»: vipcode@X de npm o el paquete de la release de GitHub
  spec: string;
  // De dónde sale, para enseñarlo
  source: "npm" | "GitHub";
}

// Última versión publicada en npm (null si no está, o si el paquete con ese nombre no es este proyecto)
async function latestFromNpm(): Promise<Release | null> {
  const response = await fetch(`${registryBase()}/${PACKAGE_NAME}/latest`, {
    headers: { accept: "application/json", "user-agent": `vipcode/${VERSION}` },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`npm ha respondido ${response.status}`);
  }
  const json: any = await response.json();
  const repository = String(json.repository?.url || json.repository || "");
  if (!json.version || !repository.includes(REPO_URL.replace("https://", ""))) {
    return null;
  }
  return { version: String(json.version), spec: `${PACKAGE_NAME}@${json.version}`, source: "npm" };
}

// Última release de GitHub con su paquete ya compilado (null si todavía no hay ninguna)
async function latestFromGitHub(): Promise<Release | null> {
  const response = await fetch(`${apiBase()}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": `vipcode/${VERSION}` },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`GitHub ha respondido ${response.status}`);
  }
  const json: any = await response.json();
  const assets: any[] = Array.isArray(json.assets) ? json.assets : [];
  const asset = assets.find((item) => item.name === "vipcode.tgz") || assets.find((item) => /\.tgz$/.test(String(item.name)));
  if (!asset?.browser_download_url) {
    return null;
  }
  return { version: String(json.tag_name || "").replace(/^v/, ""), spec: String(asset.browser_download_url), source: "GitHub" };
}

// La más nueva entre npm y GitHub (con la misma versión, la de npm); null si no hay ninguna publicada
export async function latestRelease(): Promise<Release | null> {
  const errors: Error[] = [];
  const found = (
    await Promise.all(
      [latestFromNpm, latestFromGitHub].map((source) =>
        source().catch((err) => {
          errors.push(err as Error);
          return null;
        }),
      ),
    )
  ).filter((release): release is Release => release !== null);
  if (found.length === 0) {
    if (errors.length === 2) {
      throw new Error(`no he podido consultar npm ni GitHub (${errors[0].message})`);
    }
    return null;
  }
  return found.reduce((best, release) => (compareVersions(release.version, best.version) > 0 ? release : best));
}

// CHANGELOG.md de una versión publicada (VIPCODE_CHANGELOG_URL permite usar otro, por ejemplo en las pruebas;
// {version} se cambia por el número)
function changelogUrl(version: string): string {
  const template = process.env.VIPCODE_CHANGELOG_URL || `${REPO_URL.replace("https://github.com/", "https://raw.githubusercontent.com/")}/v{version}/CHANGELOG.md`;
  return template.replace("{version}", encodeURIComponent(version));
}

// ¿Trae arreglos de seguridad alguna de las versiones entre la tuya y la nueva? (si no se puede saber, false)
async function bringsSecurity(latest: string): Promise<boolean> {
  try {
    const response = await fetch(changelogUrl(latest), { headers: { "user-agent": `vipcode/${VERSION}` }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      return false;
    }
    const text = (await response.text()).slice(0, 500000);
    return hasSecurity(sectionsBetween(parseChangelog(text), VERSION, latest));
  } catch {
    return false;
  }
}

export interface UpdateNotice {
  version: string;
  // Alguna de las versiones nuevas trae arreglos de seguridad: el aviso lo destaca para que no se deje para luego
  security: boolean;
}

// Como mucho una vez por hora, en segundo plano: la versión nueva si la hay (y nunca falla)
export async function checkForUpdate(): Promise<UpdateNotice | null> {
  let cache: { checked?: number; latest?: string; security?: boolean; from?: string } = {};
  try {
    cache = JSON.parse(fs.readFileSync(UPDATE_PATH, "utf8"));
  } catch {
    // primera vez
  }
  // Se vuelve a mirar cada hora, y también si has actualizado desde la última vez (cambia lo que te falta)
  if (!cache.checked || Date.now() - cache.checked > CHECK_MS || !cache.latest || (cache.from && cache.from !== VERSION)) {
    try {
      const release = await latestRelease();
      const latest = release?.version || VERSION;
      const security = compareVersions(latest, VERSION) > 0 ? await bringsSecurity(latest) : false;
      cache = { checked: Date.now(), latest, security, from: VERSION };
      ensureHomeDir();
      fs.writeFileSync(UPDATE_PATH, JSON.stringify(cache, null, 2));
    } catch {
      return null;
    }
  }
  if (cache.latest && compareVersions(cache.latest, VERSION) > 0) {
    return { version: cache.latest, security: cache.security === true };
  }
  return null;
}

// Sin las variables que pone npm al ejecutar un script (si vipcode se lanzó así, npm_config_local_prefix
// apuntaría a otra carpeta y npm trabajaría sobre ella)
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^npm_(config_local_prefix|package_|lifecycle_|command$)/i.test(key)) {
      env[key] = value;
    }
  }
  return env;
}

function run(command: string, args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    // Por su ruta completa (no el que haya en la carpeta), y con cross-spawn, que en Windows sabe lanzar npm.cmd
    const child = spawnProgram(findProgram(command) || command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...cleanEnv(), GIT_TERMINAL_PROMPT: "0" },
    });
    let output = "";
    child.stdout?.on("data", (data) => (output += data.toString()));
    child.stderr?.on("data", (data) => (output += data.toString()));
    child.on("error", (err) => resolve({ code: null, output: err.message }));
    child.on("close", (code) => resolve({ code, output }));
  });
}

const NPM = "npm";

function lastLines(text: string, count = 6): string {
  return text.trim().split("\n").slice(-count).join("\n");
}

function isInstalledIn(dir: string, parent: string): boolean {
  try {
    return isInside(fs.realpathSync.native(dir), fs.realpathSync.native(parent));
  } catch {
    return false;
  }
}

export interface UpdateResult {
  status: "updated" | "current" | "manual" | "error";
  message: string;
  // La versión que se ha instalado (con «updated»)
  version?: string;
}

// En qué va la actualización, para la barra de carga: el paso que está haciendo y entre qué puntos de la barra (de 0 a
// 1) va mientras tanto
export interface UpdateStep {
  text: string;
  from: number;
  to: number;
}

// Hasta dónde llega la barra a los «ms» de empezar un paso: avanza deprisa y cada vez más despacio, y no llega al final
// del paso hasta que termina (npm no dice cuánto le falta)
export function stepProgress(step: UpdateStep, ms: number): number {
  return step.from + (step.to - step.from) * (1 - Math.exp(-Math.max(0, ms) / 15000));
}

function installedVersion(root: string): string | null {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "") || null;
  } catch {
    return null;
  }
}

// Instalado desde el código (con .git): se trae lo último del repositorio y se compila
async function updateFromGit(root: string, step: (step: UpdateStep) => void): Promise<UpdateResult> {
  const status = await run("git", ["status", "--porcelain"], root);
  if (status.code !== 0) {
    return { status: "error", message: `No he podido usar git en ${root}: ${lastLines(status.output, 2)}` };
  }
  if (status.output.trim() !== "") {
    return { status: "error", message: `Tienes cambios sin guardar en ${root}: haz commit o descártalos y vuelve a probar. No he tocado nada.` };
  }
  step({ text: "Buscando cambios en el repositorio", from: 0, to: 0.2 });
  const before = (await run("git", ["rev-parse", "HEAD"], root)).output.trim();
  const pull = await run("git", ["pull", "--ff-only"], root);
  if (pull.code !== 0) {
    return { status: "error", message: `git pull ha fallado:\n${lastLines(pull.output)}` };
  }
  const after = (await run("git", ["rev-parse", "HEAD"], root)).output.trim();
  if (before === after) {
    return { status: "current", message: `Ya tienes lo último del repositorio (vipcode ${VERSION}).` };
  }
  const count = (await run("git", ["rev-list", "--count", `${before}..${after}`], root)).output.trim();
  const changes = count === "1" ? "1 cambio nuevo" : `${count} cambios nuevos`;
  // npm ci no reescribe package-lock.json (si lo cambiara, la próxima vez habría «cambios sin guardar»)
  const install = fs.existsSync(path.join(root, "package-lock.json")) ? ["ci"] : ["install"];
  const steps: [string[], UpdateStep][] = [
    [install, { text: `${changes.replace(/^./, (letter) => letter.toUpperCase())}: instalando dependencias`, from: 0.2, to: 0.7 }],
    [["run", "build"], { text: "Compilando", from: 0.7, to: 1 }],
  ];
  for (const [args, info] of steps) {
    step(info);
    const done = await run(NPM, args, root);
    if (done.code !== 0) {
      return { status: "error", message: `npm ${args.join(" ")} ha fallado:\n${lastLines(done.output)}` };
    }
  }
  const version = installedVersion(root) || VERSION;
  return {
    status: "updated",
    version,
    message: `Actualizado desde el repositorio (${changes}): vipcode ${version}. Si tienes vipcode abierto, ciérralo y vuelve a abrirlo para usarlo.`,
  };
}

// Instalado con npm: se instala el paquete de la última versión publicada en GitHub
async function updateFromRelease(root: string, step: (step: UpdateStep) => void): Promise<UpdateResult> {
  step({ text: "Buscando la última versión", from: 0, to: 0.1 });
  let release: Release | null;
  try {
    release = await latestRelease();
  } catch (err) {
    return { status: "error", message: `No he podido buscar versiones nuevas: ${(err as Error).message}` };
  }
  if (!release) {
    return { status: "manual", message: `Todavía no hay ninguna versión publicada (ni en npm ni en ${REPO_URL}/releases).` };
  }
  if (compareVersions(release.version, VERSION) <= 0) {
    return { status: "current", message: `Ya tienes la última versión (${VERSION}).` };
  }
  // Ya la instaló un /update de antes, pero sigue abierta la de antes: basta con reiniciar
  const onDisk = installedVersion(root);
  if (onDisk && compareVersions(onDisk, VERSION) > 0 && compareVersions(release.version, onDisk) <= 0) {
    return { status: "updated", version: onDisk, message: `vipcode ${onDisk} ya está instalado: ciérralo y vuelve a abrirlo para usarlo.` };
  }
  const prefix = (await run(NPM, ["prefix", "-g"], os.tmpdir())).output.trim();
  const globalDir = process.platform === "win32" ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");
  if (!prefix || !isInstalledIn(root, globalDir)) {
    return {
      status: "manual",
      message: `Hay una versión nueva (${release.version}, tienes la ${VERSION}), pero este vipcode no está instalado con «npm install -g». Instálala con:\n  npm install -g ${release.spec}`,
    };
  }
  if (!/^[\w@.:/+~-]+$/.test(release.spec) || release.spec.startsWith("-")) {
    return { status: "error", message: `La última versión publicada tiene un nombre de paquete raro (${release.spec}): no la instalo.` };
  }
  step({ text: `Descargando e instalando vipcode ${release.version} desde ${release.source}`, from: 0.1, to: 0.9 });
  // Desde la carpeta temporal, para que no se mezcle con la configuración de npm del proyecto en el que estás
  const install = await run(NPM, ["install", "-g", release.spec], os.tmpdir());
  if (install.code !== 0) {
    return { status: "error", message: `npm install ha fallado:\n${lastLines(install.output)}` };
  }
  // Que de verdad esté la nueva (npm puede terminar bien y dejar otra, por ejemplo si el paquete no es el que dice ser)
  step({ text: "Comprobando la instalación", from: 0.9, to: 1 });
  const installed = installedVersion(root);
  if (installed !== release.version) {
    return { status: "error", message: `npm ha terminado, pero la versión instalada es la ${installed || "?"} y no la ${release.version}. Prueba a mano: npm install -g ${release.spec}` };
  }
  return {
    status: "updated",
    version: release.version,
    message: `vipcode ${release.version} instalado (tenías la ${VERSION}). Si tienes vipcode abierto, ciérralo y vuelve a abrirlo para usarlo.`,
  };
}

// Abre la versión instalada (la nueva, tras /update) en esta misma terminal y carpeta, y espera a que se cierre para
// salir con su código. Este proceso solo espera: lo que escribas y Ctrl+C son para el nuevo
export function restartVipcode(args: string[]): Promise<number> {
  const root = packageRoot();
  let entry = path.join(root, "dist", "index.js");
  try {
    const bin = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).bin;
    const file = path.resolve(root, String(typeof bin === "string" ? bin : bin?.vipcode || ""));
    // Solo un fichero de dentro del paquete
    if (file !== path.resolve(root) && isInside(file, path.resolve(root))) {
      entry = file;
    }
  } catch {
    // el de siempre
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
  return new Promise((resolve) => {
    // Con el mismo Node (por su ruta completa) y sin shell
    const child = spawn(process.execPath, [entry, ...args], { stdio: "inherit" });
    process.on("SIGINT", () => {});
    for (const signal of ["SIGTERM", "SIGHUP"] as const) {
      process.on(signal, () => child.kill(signal));
    }
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

// «step» dice en qué paso va, para la barra de carga
export async function updateVipcode(step: (step: UpdateStep) => void = () => {}): Promise<UpdateResult> {
  const root = packageRoot();
  if (fs.existsSync(path.join(root, ".git"))) {
    return updateFromGit(root, step);
  }
  return updateFromRelease(root, step);
}
