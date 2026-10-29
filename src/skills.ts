import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config.js";
import { parseFrontmatter } from "./frontmatter.js";
import { GLOBAL_SKILLS_DIR } from "./paths.js";
import { type Tool, truncate } from "./tools.js";

// Una skill es una carpeta con un SKILL.md (formato abierto Agent Skills, el mismo de Claude Code y opencode):
// cabecera con name y description, instrucciones en Markdown y, si hace falta, scripts y documentos al lado
export interface SkillDefinition {
  name: string;
  description: string;
  // Carpeta de la skill: sus scripts y documentos están aquí
  dir: string;
  body: string;
  // De dónde viene, para enseñarlo en /skills
  where: string;
  // "user-invocable: false" en la cabecera: solo la usa el agente, no aparece como /nombre
  userInvocable: boolean;
  // "disable-model-invocation: true": solo se usa con /nombre, el agente no la ve
  modelInvocable: boolean;
}

const MAX_BODY = 40000;
const SKILL_FILES = ["SKILL.md", "skill.md", "Skill.md"];

// Nombre según el estándar: minúsculas, números y guiones, hasta 64 caracteres
export function normalizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

function tildify(file: string): string {
  const home = os.homedir();
  if (file === home || file.startsWith(home + path.sep)) {
    return `~${file.slice(home.length)}`;
  }
  return file;
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function skillFile(dir: string): string | null {
  for (const name of SKILL_FILES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return file;
    }
  }
  return null;
}

function readSkill(dir: string, where: string): SkillDefinition | null {
  const file = skillFile(dir);
  if (!file) {
    return null;
  }
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(text);
  const name = normalizeSkillName(String(data.name || path.basename(dir)));
  if (!name) {
    return null;
  }
  let description = typeof data.description === "string" ? data.description.trim() : "";
  if (!description) {
    // Sin descripción, la primera línea con texto: el agente la necesita para saber cuándo usarla
    description =
      body
        .split("\n")
        .map((line) => line.replace(/^#+\s*/, "").trim())
        .find((line) => line !== "") || `Skill ${name}`;
  }
  return {
    name,
    description: description.replace(/\s+/g, " ").slice(0, 1024),
    dir,
    body: body.trim(),
    where,
    userInvocable: data["user-invocable"] !== false,
    modelInvocable: data["disable-model-invocation"] !== true,
  };
}

// La carpeta puede ser una skill (en "paths" del config) o contener una skill por subcarpeta
function scanDir(dir: string, where: string): SkillDefinition[] {
  const self = readSkill(dir, where);
  if (self) {
    return [self];
  }
  const result: SkillDefinition[] = [];
  for (const entry of safeReaddir(dir)) {
    if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) {
      continue;
    }
    const skill = readSkill(path.join(dir, entry.name), where);
    if (skill) {
      result.push(skill);
    }
  }
  return result;
}

// Dónde se buscan, de menos a más prioridad (con el mismo nombre gana la última: las del proyecto)
export function skillDirs(root: string, config: Config): { dir: string; where: string }[] {
  const home = os.homedir();
  const external = config.skills?.external !== false;
  const dirs: { dir: string; where: string }[] = [];
  if (external) {
    for (const parts of [[".claude", "skills"], [".config", "opencode", "skill"], [".config", "opencode", "skills"], [".agents", "skills"]]) {
      dirs.push({ dir: path.join(home, ...parts), where: `~/${parts.join("/")}` });
    }
  }
  dirs.push({ dir: GLOBAL_SKILLS_DIR, where: tildify(GLOBAL_SKILLS_DIR) });
  if (external) {
    for (const parts of [[".claude", "skills"], [".opencode", "skill"], [".opencode", "skills"], [".agents", "skills"]]) {
      dirs.push({ dir: path.join(root, ...parts), where: parts.join("/") });
    }
  }
  dirs.push({ dir: path.join(root, ".vipcode", "skills"), where: ".vipcode/skills" });
  for (const extra of config.skills?.paths || []) {
    dirs.push({ dir: path.resolve(root, String(extra).replace(/^~(?=$|[\\/])/, home)), where: String(extra) });
  }
  return dirs;
}

export function loadSkills(root: string, config: Config): SkillDefinition[] {
  if (config.skills?.enabled === false) {
    return [];
  }
  const disabled = new Set((config.skills?.disabled || []).map((name) => normalizeSkillName(String(name))));
  const found = new Map<string, SkillDefinition>();
  for (const { dir, where } of skillDirs(root, config)) {
    for (const skill of scanDir(dir, where)) {
      if (!disabled.has(skill.name)) {
        found.set(skill.name, skill);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Ficheros que trae la skill además de SKILL.md, para que el agente sepa qué puede leer
function skillFiles(dir: string, max = 60): string[] {
  const result: string[] = [];
  const walk = (current: string, prefix: string, depth: number) => {
    for (const entry of safeReaddir(current)) {
      if (result.length >= max || depth > 3) {
        return;
      }
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") {
        continue;
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), relative, depth + 1);
      } else if (!SKILL_FILES.includes(relative)) {
        result.push(relative);
      }
    }
  };
  walk(dir, "", 0);
  return result;
}

// Lo que recibe el modelo al cargar una skill (con la herramienta o con /nombre)
export function skillContent(skill: SkillDefinition): string {
  let extra = "";
  const files = skillFiles(skill.dir);
  if (files.length > 0) {
    extra = `\n\nFicheros de la skill (en ${skill.dir}):\n${files.map((file) => `- ${file}`).join("\n")}\nLéelos con la herramienta skill (name: "${skill.name}", file: "ruta") y ejecuta sus scripts con bash usando la ruta completa.`;
  }
  return `<skill name="${skill.name}" dir="${skill.dir}">\n${truncate(skill.body, MAX_BODY)}\n</skill>${extra}`;
}

// Un fichero de la skill (sin salir de su carpeta)
export function readSkillFile(skill: SkillDefinition, file: string): string {
  const abs = path.resolve(skill.dir, file);
  let real = abs;
  let base = skill.dir;
  try {
    real = fs.realpathSync(abs);
    base = fs.realpathSync(skill.dir);
  } catch {
    return `Error: la skill ${skill.name} no tiene el fichero ${file}.`;
  }
  if (real !== base && !real.startsWith(base + path.sep)) {
    return `Error: ${file} está fuera de la carpeta de la skill.`;
  }
  if (fs.statSync(real).isDirectory()) {
    const entries = safeReaddir(real).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    return `Contenido de ${file}:\n${entries.join("\n") || "(vacía)"}`;
  }
  const buffer = fs.readFileSync(real);
  if (buffer.subarray(0, 8000).includes(0)) {
    return `${file} es un fichero binario (${buffer.length} bytes): úsalo desde bash con la ruta ${real}.`;
  }
  return `<fichero skill="${skill.name}" ruta="${file}">\n${truncate(buffer.toString("utf8"), MAX_BODY)}\n</fichero>`;
}

// En la lista que va en cada petición, descripciones cortas: los modelos gratis tienen poco contexto
const LISTED_DESCRIPTION = 250;

// Herramienta para que el agente cargue una skill cuando la tarea encaja con su descripción
export function skillTool(skills: SkillDefinition[]): Tool {
  const listed = skills.filter((skill) => skill.modelInvocable);
  const short = (text: string) => (text.length > LISTED_DESCRIPTION ? `${text.slice(0, LISTED_DESCRIPTION - 1)}…` : text);
  return {
    name: "skill",
    description: `Carga una skill: instrucciones y recursos para un tipo de tarea concreto. Si la tarea encaja con la descripción de alguna, cárgala antes de empezar y sigue sus instrucciones. Con "file" lees uno de sus ficheros (por ejemplo references/guia.md).\nSkills disponibles:\n${listed
      .map((skill) => `- ${skill.name}: ${short(skill.description)}`)
      .join("\n")}`,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre de la skill" },
        file: { type: "string", description: "Opcional: fichero de la skill que quieres leer, relativo a su carpeta" },
      },
      required: ["name"],
    },
    permission: "none",
    readOnly: true,
    async run(args) {
      const wanted = normalizeSkillName(String(args.name || ""));
      const skill = skills.find((item) => item.name === wanted);
      if (!skill) {
        return `Error: no hay ninguna skill llamada «${args.name}». Disponibles: ${listed.map((item) => item.name).join(", ") || "ninguna"}.`;
      }
      if (args.file) {
        return readSkillFile(skill, String(args.file));
      }
      return skillContent(skill);
    },
  };
}

// Las carpetas de vipcode donde se instalan (las de Claude Code u opencode no se tocan)
export function installDir(root: string, project: boolean): string {
  if (project) {
    return path.join(root, ".vipcode", "skills");
  }
  return GLOBAL_SKILLS_DIR;
}

// Carpetas con SKILL.md dentro de un directorio (ella misma o hasta 4 niveles más abajo)
function findSkillFolders(dir: string, depth = 0): string[] {
  if (skillFile(dir)) {
    return [dir];
  }
  if (depth >= 4) {
    return [];
  }
  const result: string[] = [];
  for (const entry of safeReaddir(dir)) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      result.push(...findSkillFolders(path.join(dir, entry.name), depth + 1));
    }
  }
  return result;
}

// github.com/usuario/repo, …/tree/rama/carpeta, usuario/repo o cualquier URL de git
function parseGitSource(source: string): { url: string; ref?: string; subdir?: string } | null {
  const github = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s]+)(?:\/(.+?))?)?\/?$/.exec(source);
  if (github) {
    let subdir = github[4];
    // Un enlace a …/SKILL.md apunta a su carpeta
    if (subdir && /(^|\/)skill\.md$/i.test(subdir)) {
      subdir = path.posix.dirname(subdir);
    }
    return { url: `https://github.com/${github[1]}/${github[2]}.git`, ref: github[3], subdir };
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
    return { url: `https://github.com/${source}.git` };
  }
  if (/^(https?:\/\/|git@|ssh:\/\/|file:\/\/).+/.test(source) || source.endsWith(".git")) {
    return { url: source };
  }
  return null;
}

export interface InstallResult {
  installed: { name: string; dir: string }[];
  skipped: { name: string; reason: string }[];
}

// Copia las skills de una carpeta o de un repositorio git a la carpeta de vipcode
export function installSkills(source: string, root: string, options: { project?: boolean; force?: boolean } = {}): InstallResult {
  const result: InstallResult = { installed: [], skipped: [] };
  let base = path.resolve(root, source.replace(/^~(?=$|[\\/])/, os.homedir()));
  let temp: string | null = null;
  try {
    if (!fs.existsSync(base)) {
      const git = parseGitSource(source);
      if (!git) {
        throw new Error(`No encuentro ${source}: pon la ruta de una carpeta con SKILL.md o la dirección de un repositorio git.`);
      }
      temp = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-skill-"));
      const args = ["clone", "--depth", "1", ...(git.ref ? ["--branch", git.ref] : []), git.url, temp];
      const clone = spawnSync("git", args, { encoding: "utf8", timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      if (clone.error || clone.status !== 0) {
        throw new Error(`No he podido descargar ${git.url}: ${(clone.stderr || clone.error?.message || "").trim().split("\n").pop()}`);
      }
      base = git.subdir ? path.join(temp, git.subdir) : temp;
      if (!fs.existsSync(base)) {
        throw new Error(`El repositorio no tiene la carpeta ${git.subdir}.`);
      }
    }
    const folders = findSkillFolders(base);
    if (folders.length === 0) {
      throw new Error(`No hay ninguna skill (carpeta con SKILL.md) en ${source}.`);
    }
    const target = installDir(root, Boolean(options.project));
    fs.mkdirSync(target, { recursive: true });
    for (const folder of folders) {
      const skill = readSkill(folder, "");
      if (!skill) {
        continue;
      }
      const dest = path.join(target, skill.name);
      if (fs.existsSync(dest)) {
        if (!options.force) {
          result.skipped.push({ name: skill.name, reason: "ya existe (usa --force para sustituirla)" });
          continue;
        }
        fs.rmSync(dest, { recursive: true, force: true });
      }
      fs.cpSync(folder, dest, { recursive: true, filter: (file) => path.basename(file) !== ".git" });
      result.installed.push({ name: skill.name, dir: dest });
    }
  } finally {
    if (temp) {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  return result;
}

// Crea una skill nueva con una plantilla para rellenar
export function createSkill(name: string, root: string, project: boolean): string {
  const clean = normalizeSkillName(name);
  if (!clean) {
    throw new Error("El nombre solo puede tener letras, números y guiones.");
  }
  const dir = path.join(installDir(root, project), clean);
  if (fs.existsSync(dir)) {
    throw new Error(`Ya existe ${tildify(dir)}.`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const title = clean.replace(/-/g, " ").replace(/^./, (letter) => letter.toUpperCase());
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---
name: ${clean}
description: Explica en una o dos frases qué hace esta skill y cuándo usarla (por ejemplo «Úsala cuando el usuario pida…»). Con esta frase decide el agente si la carga.
---

# ${title}

## Cuándo usarla

- …

## Instrucciones

1. …
2. …

## Ejemplos

- …

<!-- Puedes añadir scripts/ y references/ en esta carpeta y nombrarlos aquí: el agente los lee cuando los necesita. -->
`,
  );
  return dir;
}

// Borra una skill de las carpetas de vipcode (las de otros programas no se tocan)
export function removeSkill(name: string, root: string, config: Config): string {
  const clean = normalizeSkillName(name);
  const own = [path.join(root, ".vipcode", "skills"), GLOBAL_SKILLS_DIR];
  for (const dir of own) {
    const skill = scanDir(dir, "").find((item) => item.name === clean);
    if (skill) {
      fs.rmSync(skill.dir, { recursive: true, force: true });
      return skill.dir;
    }
  }
  const elsewhere = loadSkills(root, config).find((item) => item.name === clean);
  if (elsewhere) {
    throw new Error(`La skill ${clean} está en ${elsewhere.where}, que no es de vipcode: bórrala desde allí o añádela a "skills.disabled" en la configuración.`);
  }
  throw new Error(`No hay ninguna skill llamada ${clean}.`);
}
