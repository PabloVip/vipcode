import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { TRUST_PATH, ensureHomeDir } from "./paths.js";

// Lo que un proyecto puede traer y que cambia qué ejecuta vipcode o a dónde manda tus claves: servidores MCP y
// de lenguaje, proveedores, permisos, agentes con permisos propios y comandos que lanzan órdenes. No se usa hasta
// que confías en la carpeta, y si cambia (por ejemplo tras un git pull) se vuelve a preguntar.
const CONFIG_FILES = ["vipcode.json", path.join(".vipcode", "config.json")];
const AGENT_DIRS = [path.join(".vipcode", "agents"), path.join(".opencode", "agent"), path.join(".opencode", "agents")];
const COMMAND_DIRS = [path.join(".vipcode", "commands"), path.join(".opencode", "command"), path.join(".opencode", "commands")];

export interface ProjectTrust {
  // Ficheros del proyecto que necesitan tu confianza (relativos a la carpeta)
  files: string[];
  // Qué cambian, para enseñártelo antes de confiar
  changes: string[];
  fingerprint: string | null;
  // true si no trae nada de eso o si ya confiaste en esta misma versión
  trusted: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function short(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
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

function describeConfig(data: Record<string, unknown>): string[] {
  const changes: string[] = [];
  const keys = Object.keys(data).filter((key) => !key.startsWith("$"));
  const rest: string[] = [];
  for (const key of keys) {
    const value = data[key];
    if (key === "providers" && Array.isArray(value)) {
      const names = value.map((item) => (isObject(item) ? String(item.name || "?") : "?"));
      changes.push(`proveedores: ${names.join(", ")} (pueden cambiar a dónde se mandan tus claves)`);
    } else if (key === "mcp" && isObject(value)) {
      const servers = Object.entries(value).map(([name, server]) => {
        const detail = isObject(server) ? server.command || server.url : server;
        return `${name} (${short(detail)})`;
      });
      changes.push(`servidores MCP que se arrancan solos: ${servers.join(", ")}`);
    } else if (key === "lsp" && isObject(value)) {
      changes.push(`servidores de lenguaje: ${short(value)}`);
    } else if (key === "permission") {
      changes.push(`permisos: ${short(value)}`);
    } else if (key === "agents" && isObject(value)) {
      changes.push(`agentes: ${Object.keys(value).join(", ")}`);
    } else if (key === "commands" && isObject(value)) {
      changes.push(`comandos: ${Object.keys(value).join(", ")}`);
    } else {
      rest.push(key);
    }
  }
  if (rest.length > 0) {
    changes.push(`otros ajustes: ${rest.join(", ")}`);
  }
  return changes;
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
  const files: string[] = [];
  const changes: string[] = [];
  const parts: string[] = [];
  const add = (file: string, text: string, change: string[]) => {
    // Con / también en Windows: así se enseñan igual en todos los sistemas
    const relative = file.split(path.sep).join("/");
    files.push(relative);
    parts.push(`${relative}\u0000${text}`);
    changes.push(...change.map((item) => `${relative}: ${item}`));
  };
  for (const relative of CONFIG_FILES) {
    const text = readText(path.join(root, relative));
    if (text === null) {
      continue;
    }
    let data: unknown = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
    const described = isObject(data) ? describeConfig(data) : [];
    add(relative, text, described.length > 0 ? described : ["configuración de vipcode"]);
  }
  for (const relative of markdownFiles(root, AGENT_DIRS)) {
    const text = readText(path.join(root, relative)) || "";
    const { data } = parseFrontmatter(text);
    // Un agente que solo trae instrucciones es como un AGENTS.md: no hace falta confiar
    if (data.permission !== undefined || data.readOnly !== undefined) {
      add(relative, text, [`agente con permisos propios: ${short({ permission: data.permission, readOnly: data.readOnly })}`]);
    }
  }
  for (const relative of markdownFiles(root, COMMAND_DIRS)) {
    const text = readText(path.join(root, relative)) || "";
    if (/!`[^`]+`/.test(text)) {
      add(relative, text, ["comando que ejecuta órdenes en la terminal al usarlo"]);
    }
  }
  if (files.length === 0) {
    return { files, changes, fingerprint: null, trusted: true };
  }
  const fingerprint = crypto.createHash("sha256").update(parts.join("\u0000\u0000")).digest("hex");
  return { files, changes, fingerprint, trusted: readStore()[key(root)]?.fingerprint === fingerprint };
}

// Confías en la configuración que trae la carpeta tal como está ahora
export function trustProject(root: string): ProjectTrust {
  const trust = projectTrust(root);
  if (!trust.fingerprint) {
    return trust;
  }
  const store = readStore();
  store[key(root)] = { fingerprint: trust.fingerprint, date: new Date().toISOString() };
  ensureHomeDir();
  fs.writeFileSync(TRUST_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
  return { ...trust, trusted: true };
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

// Ficheros de un agente o comando que están dentro del proyecto (los tuyos de ~/.vipcode no cuentan)
export function isProjectFile(root: string, file: string | undefined): boolean {
  if (!file) {
    return false;
  }
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
