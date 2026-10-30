import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { HOME_DIR, TRUST_PATH, ensureHomeDir, isDataDir, realInside } from "./paths.js";

// Lo que un proyecto puede traer y que cambia qué ejecuta vipcode o a dónde manda tus claves: servidores MCP y
// de lenguaje, proveedores, permisos, agentes con permisos propios y comandos que lanzan órdenes. No se usa hasta
// que confías en la carpeta, y si cambia (por ejemplo tras un git pull) se vuelve a preguntar.
const CONFIG_FILES = ["vipcode.json", path.join(".vipcode", "config.json")];
const AGENT_DIRS = [path.join(".vipcode", "agents"), path.join(".opencode", "agent"), path.join(".opencode", "agents")];
const COMMAND_DIRS = [path.join(".vipcode", "commands"), path.join(".opencode", "command"), path.join(".opencode", "commands")];

// Un fichero que necesita tu confianza, con el texto leído: lo que se te cuenta (trustinfo.ts) es justo lo que apruebas
export interface TrustSource {
  file: string;
  text: string;
  kind: "config" | "agent" | "command";
}

export interface ProjectTrust {
  // Ficheros del proyecto que necesitan tu confianza (relativos a la carpeta)
  files: string[];
  sources: TrustSource[];
  fingerprint: string | null;
  // true si no trae nada de eso o si ya confiaste en esta misma versión
  trusted: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(file: string): string | null {
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

function markdownFiles(root: string, dirs: string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) {
    try {
      for (const name of fs.readdirSync(path.join(root, dir)).sort()) {
        if (name.endsWith(".md")) {
          files.push(path.join(dir, name));
        }
      }
    } catch {
      // la carpeta no existe
    }
  }
  return files;
}

function readStore(): Record<string, { fingerprint: string; date: string }> {
  try {
    const data = JSON.parse(fs.readFileSync(TRUST_PATH, "utf8"));
    return isObject(data) ? (data as Record<string, { fingerprint: string; date: string }>) : {};
  } catch {
    return {};
  }
}

function key(root: string): string {
  try {
    // La ruta real con sus mayúsculas: en macOS y Windows ~/Proyecto y ~/proyecto son la misma carpeta
    return fs.realpathSync.native(root);
  } catch {
    return path.resolve(root);
  }
}

export function projectTrust(root: string): ProjectTrust {
  const sources: TrustSource[] = [];
  // Abierto en tu carpeta personal, su .vipcode es la carpeta de datos de vipcode: lo que hay ahí es tuyo
  const own = isDataDir(path.join(root, ".vipcode"));
  const fromProject = (relative: string) => !(own && relative.split(path.sep)[0] === ".vipcode");
  // Con / también en Windows: así se enseñan igual en todos los sistemas
  const add = (file: string, text: string, kind: TrustSource["kind"]) => sources.push({ file: file.split(path.sep).join("/"), text, kind });
  for (const relative of CONFIG_FILES.filter(fromProject)) {
    const text = readText(path.join(root, relative));
    if (text !== null) {
      add(relative, text, "config");
    }
  }
  for (const relative of markdownFiles(root, AGENT_DIRS.filter(fromProject))) {
    const text = readText(path.join(root, relative)) || "";
    const { data } = parseFrontmatter(text);
    // Un agente que solo trae instrucciones es como un AGENTS.md: no hace falta confiar
    if (data.permission !== undefined || data.readOnly !== undefined) {
      add(relative, text, "agent");
    }
  }
  for (const relative of markdownFiles(root, COMMAND_DIRS.filter(fromProject))) {
    const text = readText(path.join(root, relative)) || "";
    if (/!`[^`]+`/.test(text)) {
      add(relative, text, "command");
    }
  }
  const files = sources.map((source) => source.file);
  if (files.length === 0) {
    return { files, sources, fingerprint: null, trusted: true };
  }
  const parts = sources.map((source) => `${source.file}\u0000${source.text}`);
  const fingerprint = crypto.createHash("sha256").update(parts.join("\u0000\u0000")).digest("hex");
  return { files, sources, fingerprint, trusted: readStore()[key(root)]?.fingerprint === fingerprint };
}

// Confías en la configuración que trae la carpeta tal como la has visto: si ha cambiado desde entonces, no vale y se
// te vuelve a preguntar
export function trustProject(root: string, seen: ProjectTrust = projectTrust(root)): ProjectTrust {
  if (!seen.fingerprint) {
    return seen;
  }
  const store = readStore();
  store[key(root)] = { fingerprint: seen.fingerprint, date: new Date().toISOString() };
  ensureHomeDir();
  fs.writeFileSync(TRUST_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
  return { ...seen, trusted: true };
}

export function untrustProject(root: string): boolean {
  const store = readStore();
  if (!store[key(root)]) {
    return false;
  }
  delete store[key(root)];
  ensureHomeDir();
  fs.writeFileSync(TRUST_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
  return true;
}

// Ficheros de un agente o comando que están dentro del proyecto (los tuyos de ~/.vipcode no cuentan, tampoco si abres
// vipcode en tu carpeta personal)
export function isProjectFile(root: string, file: string | undefined): boolean {
  if (!file || realInside(file, HOME_DIR)) {
    return false;
  }
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
