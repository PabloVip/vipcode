import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import fg from "fast-glob";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { isImagePath, toDataUrl } from "./images.js";
import type { Permission, PermissionReply, PermissionRequest } from "./permissions.js";

export type { Permission } from "./permissions.js";

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "high" | "medium" | "low";
}

export interface ToolContext {
  root: string;
  bashTimeoutMs: number;
  signal?: AbortSignal;
  // Pide permiso (según la configuración puede contestar solo)
  ask: (request: PermissionRequest) => Promise<PermissionReply>;
  // Ficheros leídos en esta sesión y su fecha de modificación, para no editar a ciegas
  readTimes: Map<string, number>;
  // Errores del servidor de lenguaje (LSP) de un fichero, ya formateados
  diagnostics?: (file: string, all: boolean) => Promise<string>;
  todos?: { get(): Todo[]; set(list: Todo[]): void };
  // Lanza un subagente y devuelve su informe final
  subagent?: (type: string, prompt: string, description: string) => Promise<string>;
  // Salida parcial de un comando largo, para enseñarla mientras se ejecuta
  onProgress?: (text: string) => void;
}

export interface ToolOutput {
  output: string;
  // Lo que se enseña en pantalla además del resumen (por ejemplo el diff aplicado)
  display?: string;
  // Imágenes para que el modelo las vea (data URLs)
  images?: string[];
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  permission: Permission;
  // Se puede usar en modo plan (no cambia nada)
  readOnly: boolean;
  run: (args: any, ctx: ToolContext) => Promise<string | ToolOutput>;
}

const IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**", "**/vendor/**"];
const MAX_OUTPUT = 20000;

export function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) {
    return text;
  }
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n[… ${text.length - max} caracteres omitidos …]\n\n${text.slice(-half)}`;
}

// Convierte una ruta relativa en absoluta y comprueba que no sale del proyecto
export function resolvePath(root: string, p: string | undefined): string {
  let input = p;
  if (!input) {
    input = ".";
  }
  const abs = path.resolve(root, input);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`La ruta ${p} está fuera del proyecto (${root})`);
  }
  return abs;
}

export function rel(root: string, abs: string): string {
  const r = path.relative(root, abs);
  if (r === "") {
    return ".";
  }
  return r;
}

function rejected(reply: PermissionReply, what: string): string {
  if (reply.feedback) {
    return `El usuario ha rechazado ${what}. Motivo: ${reply.feedback}`;
  }
  return `El usuario ha rechazado ${what}.`;
}

// Historial para /undo cuando no hay git: un grupo por cada mensaje del usuario, con el contenido previo de cada fichero
interface Change {
  file: string;
  // null si el fichero no existía antes
  previous: string | null;
}
const undoStack: Change[][] = [];

export function beginTurn() {
  undoStack.push([]);
}

function recordChange(file: string, previous: string | null) {
  if (undoStack.length === 0) {
    undoStack.push([]);
  }
  const group = undoStack[undoStack.length - 1];
  // Solo guardamos el estado anterior al turno; las siguientes ediciones del mismo fichero no cuentan
  if (!group.some((change) => change.file === file)) {
    group.push({ file, previous });
  }
}

// Restaura los ficheros del último turno que cambió algo; devuelve sus rutas
export function undoLastTurn(root: string): string[] {
  while (undoStack.length > 0) {
    const group = undoStack.pop()!;
    if (group.length === 0) {
      continue;
    }
    for (const change of group) {
      if (change.previous === null) {
        fs.rmSync(change.file, { force: true });
      } else {
        fs.mkdirSync(path.dirname(change.file), { recursive: true });
        fs.writeFileSync(change.file, change.previous);
      }
    }
    return group.map((change) => rel(root, change.file));
  }
  return [];
}

interface DiffLine {
  type: " " | "-" | "+";
  text: string;
  // Número de línea en el fichero nuevo (o en el viejo si es una línea quitada)
  line: number;
}

// Diff por líneas al estilo de git: solo los trozos que cambian, con unas líneas de contexto (lo colorea la UI)
export function unifiedDiff(oldText: string, newText: string, context = 3, maxLines = 120): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");

  // Quitamos lo común al principio y al final para que el cálculo sea pequeño
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops: DiffLine[] = [];
  let lineA = 1;
  let lineB = 1;
  const keep = (text: string) => {
    ops.push({ type: " ", text, line: lineB });
    lineA++;
    lineB++;
  };
  const remove = (text: string) => {
    ops.push({ type: "-", text, line: lineA });
    lineA++;
  };
  const add = (text: string) => {
    ops.push({ type: "+", text, line: lineB });
    lineB++;
  };

  for (let i = 0; i < start; i++) {
    keep(a[i]);
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m <= 4000000) {
    // lcs[i][j] = longitud de la subsecuencia común más larga de midA[i..] y midB[j..]
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (midA[i] === midB[j]) {
          lcs[i][j] = lcs[i + 1][j + 1] + 1;
        } else {
          lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        keep(midA[i]);
        i++;
        j++;
      } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
        remove(midA[i]);
        i++;
      } else {
        add(midB[j]);
        j++;
      }
    }
  } else {
    // Demasiado grande para compararlo línea a línea: todo lo viejo fuera y todo lo nuevo dentro
    for (const line of midA) {
      remove(line);
    }
    for (const line of midB) {
      add(line);
    }
  }

  for (let i = endA; i < a.length; i++) {
    keep(a[i]);
  }

  // Marcamos qué líneas se muestran: los cambios y su contexto
  const visible = new Array<boolean>(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type !== " ") {
      for (let c = Math.max(0, k - context); c <= Math.min(ops.length - 1, k + context); c++) {
        visible[c] = true;
      }
    }
  }

  const out: string[] = [];
  let changed = 0;
  for (let k = 0; k < ops.length; k++) {
    if (!visible[k]) {
      continue;
    }
    if (k === 0 || !visible[k - 1]) {
      out.push(`@@ línea ${ops[k].line} @@`);
    }
    if (ops[k].type === " ") {
      out.push(`  ${ops[k].text}`);
    } else {
      out.push(`${ops[k].type} ${ops[k].text}`);
      changed++;
    }
  }

  if (changed === 0) {
    return "(sin cambios)";
  }
  if (out.length > maxLines) {
    return `${out.slice(0, maxLines).join("\n")}\n[… ${out.length - maxLines} líneas más del diff]`;
  }
  return out.join("\n");
}

// Contenido de un fichero con las líneas numeradas (lo usan read_file y los @ficheros del mensaje)
function readNumbered(file: string, label: string, offset?: number, maxLines?: number): string {
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) {
    return `${label} parece un fichero binario; no se muestra.`;
  }
  const lines = buffer.toString("utf8").split("\n");
  let start = 1;
  if (offset && offset > 0) {
    start = Math.floor(offset);
  }
  let limit = 1500;
  if (maxLines && maxLines > 0) {
    limit = Math.floor(maxLines);
  }
  const slice = lines.slice(start - 1, start - 1 + limit);
  const numbered = slice.map((line, i) => `${start + i}\t${line}`).join("\n");
  let footer = "";
  if (start - 1 + limit < lines.length) {
    footer = `\n[mostradas ${slice.length} de ${lines.length} líneas; usa offset para seguir]`;
  }
  return truncate(numbered) + footer;
}

function markRead(ctx: ToolContext, file: string) {
  try {
    ctx.readTimes.set(file, fs.statSync(file).mtimeMs);
  } catch {
    // el fichero no existe
  }
}

// Antes de modificar un fichero que ya existe hay que haberlo leído, y no debe haber cambiado desde entonces
function checkFresh(ctx: ToolContext, file: string): string | null {
  const readAt = ctx.readTimes.get(file);
  const name = rel(ctx.root, file);
  if (readAt === undefined) {
    return `Error: lee ${name} con read_file antes de modificarlo.`;
  }
  if (fs.statSync(file).mtimeMs > readAt + 1) {
    return `Error: ${name} ha cambiado desde que lo leíste; vuelve a leerlo con read_file.`;
  }
  return null;
}

// Tras escribir, preguntamos al LSP si el fichero tiene errores para que el modelo los arregle
async function withDiagnostics(ctx: ToolContext, file: string, text: string): Promise<string> {
  if (!ctx.diagnostics) {
    return text;
  }
  try {
    const found = await ctx.diagnostics(file, false);
    if (found) {
      return `${text}\n\nEl servidor de lenguaje encontró estos errores tras el cambio (arréglalos si son tuyos):\n${found}`;
    }
  } catch {
    // sin LSP no pasa nada
  }
  return text;
}

const readFile: Tool = {
  name: "read_file",
  description:
    "Lee un fichero de texto del proyecto. Devuelve las líneas numeradas. Usa offset/limit para ficheros grandes. Si es una imagen (png, jpg, gif, webp) te la enseña.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Ruta relativa a la raíz del proyecto" },
      offset: { type: "number", description: "Primera línea a leer (empieza en 1)" },
      limit: { type: "number", description: "Número de líneas (por defecto 1500)" },
    },
    required: ["path"],
  },
  permission: "none",
  readOnly: true,
  async run(args, ctx) {
    const file = resolvePath(ctx.root, args.path);
    if (isImagePath(file)) {
      const image = toDataUrl(file);
      return { output: `Imagen ${rel(ctx.root, file)} adjuntada a continuación para que la veas.`, images: [image] };
    }
    const text = readNumbered(file, String(args.path), args.offset, args.limit);
    markRead(ctx, file);
    return text;
  },
};

const writeFile: Tool = {
  name: "write_file",
  description: "Crea un fichero o lo sobrescribe entero. Para cambios parciales usa edit_file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string", description: "Contenido completo del fichero" },
    },
    required: ["path", "content"],
  },
  permission: "write",
  readOnly: false,
  async run(args, ctx) {
    const file = resolvePath(ctx.root, args.path);
    const content = String(args.content ?? "");
    const exists = fs.existsSync(file);
    let previous: string | null = null;
    let title = `Crear ${rel(ctx.root, file)}`;
    let preview = content.split("\n").slice(0, 40).map((l) => `+ ${l}`).join("\n");
    if (exists) {
      const stale = checkFresh(ctx, file);
      if (stale) {
        return { output: stale, isError: true };
      }
      previous = fs.readFileSync(file, "utf8");
      title = `Sobrescribir ${rel(ctx.root, file)}`;
      preview = unifiedDiff(previous, content);
    }
    const reply = await ctx.ask({ kind: "write", title, preview, subject: rel(ctx.root, file) });
    if (!reply.allow) {
      return rejected(reply, "escribir el fichero");
    }
    recordChange(file, previous);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    markRead(ctx, file);
    const output = await withDiagnostics(ctx, file, `Escrito ${rel(ctx.root, file)} (${content.split("\n").length} líneas).`);
    return { output, display: preview };
  },
};

// Busca old_string en el fichero; si no aparece exacto, prueba ignorando saltos de línea de Windows y los espacios de los bordes
function replaceInText(
  original: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { updated: string; count: number; note: string } | { error: string } {
  const exact = (text: string, from: string, to: string) => {
    const count = text.split(from).length - 1;
    if (count === 0) {
      return null;
    }
    if (count > 1 && !replaceAll) {
      return { error: `Error: old_string aparece ${count} veces. Añade más contexto para que sea único o usa replace_all.` };
    }
    if (replaceAll) {
      return { updated: text.split(from).join(to), count, note: "" };
    }
    const index = text.indexOf(from);
    return { updated: text.slice(0, index) + to + text.slice(index + from.length), count, note: "" };
  };

  const direct = exact(original, oldString, newString);
  if (direct) {
    return direct;
  }

  const crlf = original.includes("\r\n");
  if (crlf && !oldString.includes("\r\n")) {
    const windows = exact(original, oldString.replace(/\n/g, "\r\n"), newString.replace(/\n/g, "\r\n"));
    if (windows) {
      return windows;
    }
  }

  // Coincidencia por líneas ignorando la sangría y los espacios finales
  const fileLines = original.split("\n");
  const oldLines = oldString.replace(/\r\n/g, "\n").split("\n");
  while (oldLines.length > 1 && oldLines[oldLines.length - 1].trim() === "") {
    oldLines.pop();
  }
  while (oldLines.length > 1 && oldLines[0].trim() === "") {
    oldLines.shift();
  }
  const matches: number[] = [];
  for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (fileLines[i + j].trim() !== oldLines[j].trim()) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matches.push(i);
    }
  }
  if (matches.length === 0 || oldLines.every((line) => line.trim() === "")) {
    return {
      error:
        "Error: old_string no aparece en el fichero. Vuelve a leerlo con read_file y copia el texto exacto (espacios incluidos, sin el número de línea).",
    };
  }
  if (matches.length > 1 && !replaceAll) {
    return { error: `Error: old_string aparece ${matches.length} veces. Añade más contexto para que sea único o usa replace_all.` };
  }

  const indentOf = (line: string) => /^[ \t]*/.exec(line)![0];
  let lines = fileLines;
  // De abajo arriba para que los índices no se muevan
  for (const at of [...matches].reverse()) {
    // Si el modelo se comió la sangría, se la devolvemos línea a línea:
    // las que coinciden con una línea vieja usan la sangría real de esa línea; el resto, la de la línea vieja en su misma posición
    let newLines = newString
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line, index) => {
        if (line.trim() === "") {
          return line;
        }
        let k = oldLines.findIndex((old) => old.trim() === line.trim());
        if (k < 0) {
          k = Math.min(index, oldLines.length - 1);
        }
        const fileIndent = indentOf(lines[at + k].replace(/\r$/, ""));
        const oldIndent = indentOf(oldLines[k]);
        if (fileIndent !== oldIndent && fileIndent.startsWith(oldIndent)) {
          return fileIndent.slice(oldIndent.length) + line;
        }
        return line;
      });
    if (crlf) {
      newLines = newLines.map((line) => `${line}\r`);
    }
    lines = [...lines.slice(0, at), ...newLines, ...lines.slice(at + oldLines.length)];
  }
  return { updated: lines.join("\n"), count: matches.length, note: " (coincidencia aproximada: se ignoraron los espacios de los bordes)" };
}

const editFile: Tool = {
  name: "edit_file",
  description:
    "Sustituye un texto exacto por otro en un fichero. old_string debe aparecer exactamente una vez (incluye contexto para que sea único) salvo que uses replace_all. Lee el fichero con read_file antes.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "Texto exacto a sustituir" },
      new_string: { type: "string", description: "Texto nuevo" },
      replace_all: { type: "boolean", description: "Sustituir todas las apariciones" },
    },
    required: ["path", "old_string", "new_string"],
  },
  permission: "write",
  readOnly: false,
  async run(args, ctx) {
    const file = resolvePath(ctx.root, args.path);
    if (!fs.existsSync(file)) {
      return { output: `Error: ${args.path} no existe. Para crear un fichero usa write_file.`, isError: true };
    }
    const stale = checkFresh(ctx, file);
    if (stale) {
      return { output: stale, isError: true };
    }
    const original = fs.readFileSync(file, "utf8");
    const oldString = String(args.old_string ?? "");
    const newString = String(args.new_string ?? "");
    if (oldString === "") {
      return { output: "Error: old_string está vacío. Para crear un fichero usa write_file.", isError: true };
    }
    if (oldString === newString) {
      return { output: "Error: old_string y new_string son iguales; no hay nada que cambiar.", isError: true };
    }
    const result = replaceInText(original, oldString, newString, Boolean(args.replace_all));
    if ("error" in result) {
      return { output: result.error, isError: true };
    }
    const diff = unifiedDiff(original, result.updated);
    const reply = await ctx.ask({ kind: "write", title: `Editar ${rel(ctx.root, file)}`, preview: diff, subject: rel(ctx.root, file) });
    if (!reply.allow) {
      return rejected(reply, "la edición");
    }
    recordChange(file, original);
    fs.writeFileSync(file, result.updated);
    markRead(ctx, file);
    const output = await withDiagnostics(ctx, file, `Editado ${rel(ctx.root, file)} (${result.count} sustitución/es)${result.note}.`);
    return { output, display: diff };
  },
};

const listDir: Tool = {
  name: "list_dir",
  description: "Lista el contenido de una carpeta (las carpetas terminan en /).",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Carpeta relativa (por defecto la raíz)" } },
  },
  permission: "none",
  readOnly: true,
  async run(args, ctx) {
    const dir = resolvePath(ctx.root, args.path);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const lines = entries
      .filter((e) => e.name !== ".git" && e.name !== "node_modules")
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 500)
      .map((e) => {
        if (e.isDirectory()) {
          return `${e.name}/`;
        }
        return e.name;
      });
    if (lines.length === 0) {
      return "(carpeta vacía)";
    }
    return lines.join("\n");
  },
};

const globTool: Tool = {
  name: "glob",
  description: "Busca ficheros por patrón glob, por ejemplo src/**/*.ts",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "Carpeta donde buscar (por defecto la raíz)" },
    },
    required: ["pattern"],
  },
  permission: "none",
  readOnly: true,
  async run(args, ctx) {
    const cwd = resolvePath(ctx.root, args.path);
    const files = await fg(String(args.pattern), { cwd, ignore: IGNORE, dot: true, onlyFiles: true });
    if (files.length === 0) {
      return "Sin resultados.";
    }
    files.sort();
    let extra = "";
    if (files.length > 300) {
      extra = `\n[… y ${files.length - 300} más]`;
    }
    return files.slice(0, 300).join("\n") + extra;
  },
};

let ripgrepAvailable: boolean | null = null;

function hasRipgrep(): boolean {
  if (ripgrepAvailable === null) {
    try {
      ripgrepAvailable = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
    } catch {
      ripgrepAvailable = false;
    }
  }
  return ripgrepAvailable;
}

// ripgrep es mucho más rápido en proyectos grandes; devuelve null si falla para usar la búsqueda propia
function ripgrep(args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number; stdout: string } | null> {
  return new Promise((resolve) => {
    const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort);
    child.stdout.on("data", (d) => {
      if (stdout.length < 2000000) {
        stdout += d.toString();
      }
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0 || code === 1) {
        resolve({ code: code ?? 1, stdout });
      } else {
        resolve(null);
      }
    });
  });
}

const grepTool: Tool = {
  name: "grep",
  description: "Busca una expresión regular dentro de los ficheros del proyecto. Devuelve fichero:línea: texto.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Expresión regular" },
      include: { type: "string", description: "Glob de ficheros donde buscar, por ejemplo **/*.php" },
      ignore_case: { type: "boolean" },
    },
    required: ["pattern"],
  },
  permission: "none",
  readOnly: true,
  async run(args, ctx) {
    const pattern = String(args.pattern);
    if (hasRipgrep()) {
      const rgArgs = ["--line-number", "--no-heading", "--color", "never", "--with-filename", "--max-columns", "300", "--max-columns-preview", "-e", pattern];
      if (args.ignore_case) {
        rgArgs.push("-i");
      }
      if (args.include) {
        rgArgs.push("-g", String(args.include));
      }
      rgArgs.push(".");
      const found = await ripgrep(rgArgs, ctx.root, ctx.signal);
      if (found) {
        if (found.code === 1 || found.stdout.trim() === "") {
          return "Sin coincidencias.";
        }
        const lines = found.stdout
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => line.replace(/^\.\//, "").replace(/^([^:]+):(\d+):/, "$1:$2: "));
        if (lines.length > 200) {
          return `${lines.slice(0, 200).join("\n")}\n[… limitado a 200 resultados]`;
        }
        return lines.join("\n");
      }
    }

    let flags = "";
    if (args.ignore_case) {
      flags = "i";
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch (err) {
      return `Expresión regular inválida: ${(err as Error).message}`;
    }
    let include = "**/*";
    if (args.include) {
      include = String(args.include);
    }
    const files = await fg(include, { cwd: ctx.root, ignore: IGNORE, dot: false, onlyFiles: true });
    const results: string[] = [];
    for (const file of files) {
      const abs = path.join(ctx.root, file);
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > 1024 * 1024) {
        continue;
      }
      const buffer = fs.readFileSync(abs);
      if (buffer.includes(0)) {
        continue;
      }
      const lines = buffer.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push(`${file}:${i + 1}: ${lines[i].slice(0, 300)}`);
          if (results.length >= 200) {
            return results.join("\n") + "\n[… limitado a 200 resultados]";
          }
        }
      }
    }
    if (results.length === 0) {
      return "Sin coincidencias.";
    }
    return results.join("\n");
  },
};

const bashTool: Tool = {
  name: "bash",
  description:
    "Ejecuta un comando de shell en la raíz del proyecto (tests, git, instalar dependencias…). No lo uses para leer o editar ficheros: para eso están las otras herramientas. No es interactivo: evita comandos que esperen que escribas algo.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      description: { type: "string", description: "Qué hace el comando, en 5-10 palabras" },
      timeout_ms: { type: "number", description: "Tiempo máximo en milisegundos (máximo 600000)" },
    },
    required: ["command"],
  },
  permission: "bash",
  readOnly: false,
  async run(args, ctx) {
    const command = String(args.command ?? "");
    let title = "Ejecutar comando";
    if (args.description) {
      title = `Ejecutar: ${String(args.description).slice(0, 80)}`;
    }
    const reply = await ctx.ask({ kind: "bash", title, preview: `$ ${command}`, subject: command });
    if (!reply.allow) {
      return rejected(reply, "ejecutar el comando");
    }
    let timeout = ctx.bashTimeoutMs;
    if (args.timeout_ms && args.timeout_ms > 0) {
      timeout = Math.min(args.timeout_ms, 600000);
    }

    return await new Promise<string>((resolve) => {
      let shell = "bash";
      let shellArgs = ["-lc", command];
      if (process.platform === "win32") {
        shell = "cmd.exe";
        shellArgs = ["/c", command];
      }
      const child = spawn(shell, shellArgs, {
        cwd: ctx.root,
        env: { ...process.env, VIPCODE: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" },
        stdio: ["ignore", "pipe", "pipe"],
        // Grupo de procesos propio para poder matar también a los hijos (npm test, servidores…)
        detached: process.platform !== "win32",
      });
      let output = "";
      let timedOut = false;

      const kill = () => {
        try {
          if (process.platform !== "win32" && child.pid) {
            process.kill(-child.pid, "SIGTERM");
          } else {
            child.kill("SIGTERM");
          }
        } catch {
          child.kill("SIGTERM");
        }
        setTimeout(() => {
          try {
            if (process.platform !== "win32" && child.pid) {
              process.kill(-child.pid, "SIGKILL");
            }
          } catch {
            // ya había terminado
          }
        }, 3000).unref();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeout);

      ctx.signal?.addEventListener("abort", kill);

      const onData = (d: Buffer) => {
        const text = d.toString();
        output += text;
        if (output.length > 5000000) {
          output = output.slice(-2000000);
        }
        ctx.onProgress?.(text);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve(`No se pudo ejecutar: ${err.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", kill);
        let header = `Código de salida: ${code}`;
        if (timedOut) {
          header = `Cancelado por tiempo (${timeout} ms)`;
        } else if (ctx.signal?.aborted) {
          header = "Cancelado por el usuario";
        }
        let body = output.trim();
        if (body === "") {
          body = "(sin salida)";
        }
        resolve(`${header}\n${truncate(body)}`);
      });
    });
  },
};

// Convierte HTML en texto legible para el modelo (sin etiquetas, scripts ni estilos)
export function htmlToText(html: string): string {
  let text = html.replace(/<(script|style|noscript|svg|head|template)\b[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<h([1-6])[^>]*>/gi, (_match, level) => `\n\n${"#".repeat(Number(level))} `);
  text = text.replace(/<li[^>]*>/gi, "\n- ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|h[1-6]|tr|pre|section|article|header|footer|blockquote|table|ul|ol)>/gi, "\n\n");
  text = text.replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(text: string): string {
  const entities: Record<string, string> = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", uuml: "ü",
    Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", Uuml: "Ü",
    iexcl: "¡", iquest: "¿", laquo: "«", raquo: "»", copy: "©", reg: "®", deg: "°", middot: "·",
    ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", euro: "€",
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (entities[code] !== undefined) {
      return entities[code];
    }
    const lower = code.toLowerCase();
    if (entities[lower] !== undefined) {
      return entities[lower];
    }
    try {
      if (lower.startsWith("#x")) {
        return String.fromCodePoint(parseInt(lower.slice(2), 16));
      }
      if (lower.startsWith("#")) {
        return String.fromCodePoint(Number(lower.slice(1)));
      }
    } catch {
      // número fuera de rango
    }
    return match;
  });
}

function webSignal(ctx: ToolContext): AbortSignal {
  const signals = [AbortSignal.timeout(30000)];
  if (ctx.signal) {
    signals.push(ctx.signal);
  }
  return AbortSignal.any(signals);
}

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const webFetch: Tool = {
  name: "webfetch",
  description: "Descarga una página web (documentación, issues, APIs…) y la devuelve como texto plano. Solo http/https.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL completa, por ejemplo https://nodejs.org/api/fs.html" },
    },
    required: ["url"],
  },
  permission: "web",
  readOnly: true,
  async run(args, ctx) {
    const url = String(args.url ?? "");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `Error: URL inválida: ${url}`;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Error: solo se admiten URLs http o https.";
    }
    const reply = await ctx.ask({ kind: "web", title: "Descargar página web", preview: `GET ${parsed.href}`, subject: parsed.href });
    if (!reply.allow) {
      return rejected(reply, "descargar la página");
    }
    const response = await fetch(parsed, {
      signal: webSignal(ctx),
      redirect: "follow",
      headers: { "user-agent": "vipcode", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
    });
    if (!response.ok) {
      return `Error: HTTP ${response.status} ${response.statusText}`;
    }
    const type = response.headers.get("content-type") || "";
    if (type !== "" && !/text|json|xml|javascript/.test(type)) {
      return `Error: tipo de contenido no soportado (${type})`;
    }
    let body = await response.text();
    if (/html/.test(type)) {
      body = htmlToText(body);
    }
    if (body === "") {
      body = "(página vacía)";
    }
    return `${response.url}\n\n${truncate(body)}`;
  },
};

// Resultados de DuckDuckGo (versión HTML, sin clave)
export function parseSearchResults(html: string, max: number): { title: string; url: string; snippet: string }[] {
  const results: { title: string; url: string; snippet: string }[] = [];
  const blocks = html.split(/class="result__a"/).slice(1);
  for (const block of blocks) {
    const link = /href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) {
      continue;
    }
    let url = decodeEntities(link[1]);
    const redirect = /[?&]uddg=([^&]+)/.exec(url);
    if (redirect) {
      url = decodeURIComponent(redirect[1]);
    }
    if (url.startsWith("//")) {
      url = `https:${url}`;
    }
    if (url.includes("duckduckgo.com/y.js")) {
      continue; // anuncios
    }
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    results.push({
      title: decodeEntities(link[2].replace(/<[^>]+>/g, "")).trim(),
      url,
      snippet: snippet ? decodeEntities(snippet[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "",
    });
    if (results.length >= max) {
      break;
    }
  }
  return results;
}

const webSearch: Tool = {
  name: "websearch",
  description:
    "Busca en internet (DuckDuckGo) y devuelve títulos, enlaces y un resumen de cada resultado. Úsalo para encontrar documentación o errores; después lee la página que te interese con webfetch.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Lo que quieres buscar" },
      max_results: { type: "number", description: "Número de resultados (por defecto 8)" },
    },
    required: ["query"],
  },
  permission: "web",
  readOnly: true,
  async run(args, ctx) {
    const query = String(args.query ?? "").trim();
    if (query === "") {
      return "Error: la búsqueda está vacía.";
    }
    const reply = await ctx.ask({ kind: "web", title: "Buscar en internet", preview: `Buscar: ${query}`, subject: `search:${query}` });
    if (!reply.allow) {
      return rejected(reply, "buscar en internet");
    }
    const response = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      signal: webSignal(ctx),
      headers: { "user-agent": BROWSER_UA, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ q: query }).toString(),
    });
    if (!response.ok) {
      return `Error: el buscador respondió HTTP ${response.status}`;
    }
    let max = 8;
    if (args.max_results && args.max_results > 0) {
      max = Math.min(20, Math.floor(args.max_results));
    }
    const results = parseSearchResults(await response.text(), max);
    if (results.length === 0) {
      return "Sin resultados (o el buscador ha bloqueado la petición).";
    }
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
  },
};

const STATUS_ICON: Record<Todo["status"], string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]", cancelled: "[-]" };

export function formatTodos(todos: Todo[]): string {
  if (todos.length === 0) {
    return "(lista de tareas vacía)";
  }
  return todos.map((todo) => `${STATUS_ICON[todo.status] || "[ ]"} ${todo.content}`).join("\n");
}

const todoWrite: Tool = {
  name: "todowrite",
  description:
    "Crea o actualiza la lista de tareas de esta conversación (sustituye la lista entera). Úsala en tareas de 3 pasos o más: apunta los pasos, marca uno como in_progress mientras trabajas en él y como completed nada más acabarlo.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Qué hay que hacer" },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
            priority: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  permission: "none",
  readOnly: true,
  async run(args, ctx) {
    if (!ctx.todos) {
      return "Error: la lista de tareas no está disponible aquí.";
    }
    const valid = ["pending", "in_progress", "completed", "cancelled"];
    const list: Todo[] = (Array.isArray(args.todos) ? args.todos : [])
      .filter((item: any) => item && typeof item.content === "string" && item.content.trim() !== "")
      .map((item: any) => {
        const todo: Todo = { content: item.content.trim(), status: "pending" };
        if (valid.includes(item.status)) {
          todo.status = item.status;
        }
        if (["high", "medium", "low"].includes(item.priority)) {
          todo.priority = item.priority;
        }
        return todo;
      });
    ctx.todos.set(list);
    const pending = list.filter((todo) => todo.status === "pending" || todo.status === "in_progress").length;
    return `Lista actualizada (${pending} pendientes):\n${formatTodos(list)}`;
  },
};

const todoRead: Tool = {
  name: "todoread",
  description: "Lee la lista de tareas actual de esta conversación.",
  parameters: { type: "object", properties: {} },
  permission: "none",
  readOnly: true,
  async run(_args, ctx) {
    if (!ctx.todos) {
      return "Error: la lista de tareas no está disponible aquí.";
    }
    return formatTodos(ctx.todos.get());
  },
};

const diagnosticsTool: Tool = {
  name: "diagnostics",
  description:
    "Pide al servidor de lenguaje (LSP) los errores y avisos de un fichero: tipos, sintaxis, imports… Más rápido que compilar todo el proyecto.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Fichero a revisar" } },
    required: ["path"],
  },
  permission: "none",
  readOnly: true,
  async run(args, ctx) {
    const file = resolvePath(ctx.root, args.path);
    if (!ctx.diagnostics) {
      return "No hay servidor de lenguaje disponible para este fichero.";
    }
    const found = await ctx.diagnostics(file, true);
    if (!found) {
      return `Sin errores en ${rel(ctx.root, file)} (o no hay servidor de lenguaje para este tipo de fichero).`;
    }
    return found;
  },
};

// La herramienta "task" lista los subagentes que hay, así que se crea cuando se conocen
export function taskTool(subagents: { name: string; description: string }[]): Tool {
  return {
    name: "task",
    description: `Lanza un subagente que trabaja por su cuenta, con su propio contexto, y te devuelve un informe. Úsalo para investigaciones amplias o tareas independientes que llenarían tu contexto. Lanza varios a la vez si son independientes. Tipos:\n${subagents
      .map((agent) => `- ${agent.name}: ${agent.description}`)
      .join("\n")}`,
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Resumen de la tarea en 3-5 palabras" },
        prompt: { type: "string", description: "Instrucciones completas para el subagente: qué hacer y qué debe devolverte" },
        subagent_type: { type: "string", enum: subagents.map((agent) => agent.name) },
      },
      required: ["description", "prompt", "subagent_type"],
    },
    permission: "none",
    readOnly: true,
    async run(args, ctx) {
      if (!ctx.subagent) {
        return "Error: los subagentes no están disponibles aquí.";
      }
      return await ctx.subagent(String(args.subagent_type || "general"), String(args.prompt || ""), String(args.description || ""));
    },
  };
}

// Herramientas propias de vipcode (las de MCP y "task" se añaden aparte)
export const CORE_TOOLS: Tool[] = [
  readFile,
  writeFile,
  editFile,
  listDir,
  globTool,
  grepTool,
  bashTool,
  webFetch,
  webSearch,
  todoWrite,
  todoRead,
  diagnosticsTool,
];

// Definiciones que se mandan al modelo
export function toolDefinitions(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

export async function runTool(tools: Tool[], name: string, rawArgs: string, ctx: ToolContext, readOnlyMode: boolean): Promise<ToolOutput> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return { output: `Error: la herramienta ${name} no existe. Usa solo las de la lista.`, isError: true };
  }
  if (readOnlyMode && !tool.readOnly) {
    return { output: "Error: estás en modo de solo lectura. Propón los cambios en texto.", isError: true };
  }
  let args: any = {};
  try {
    args = JSON.parse(rawArgs);
  } catch {
    return { output: `Error: argumentos JSON inválidos: ${rawArgs.slice(0, 200)}`, isError: true };
  }
  if (args === null || typeof args !== "object") {
    args = {};
  }
  // Los modelos flojos a veces llaman sin algún argumento: se lo decimos claro para que lo corrijan
  const required: string[] = Array.isArray(tool.parameters.required) ? (tool.parameters.required as string[]) : [];
  const missing = required.filter((key) => args[key] === undefined || args[key] === null || (key === "path" && String(args[key]).trim() === ""));
  if (missing.length > 0) {
    return {
      output: `Error: a ${name} le faltan argumentos obligatorios: ${missing.join(", ")}. Vuelve a llamarla con todos ellos en el JSON de argumentos.`,
      isError: true,
    };
  }
  try {
    const result = await tool.run(args, ctx);
    if (typeof result === "string") {
      return { output: result, isError: result.startsWith("Error") };
    }
    return { ...result, isError: result.isError ?? result.output.startsWith("Error") };
  } catch (err) {
    return { output: `Error: ${(err as Error).message}`, isError: true };
  }
}

// Resumen corto de una llamada para mostrarlo en pantalla
export function describeCall(name: string, rawArgs: string): string {
  try {
    const args = JSON.parse(rawArgs);
    if (name === "task") {
      return `${args.subagent_type || "general"}: ${args.description || ""}`.trim();
    }
    if (name === "todowrite" && Array.isArray(args.todos)) {
      return `${args.todos.length} tareas`;
    }
    if (name === "skill") {
      return `${args.name || ""}${args.file ? ` · ${args.file}` : ""}`;
    }
    if (args.path && args.pattern) {
      return `${args.pattern} en ${args.path}`;
    }
    if (args.path) {
      return String(args.path);
    }
    if (args.pattern) {
      return String(args.pattern);
    }
    if (args.command) {
      return String(args.command).slice(0, 120);
    }
    if (args.url) {
      return String(args.url).slice(0, 120);
    }
    if (args.query) {
      return String(args.query).slice(0, 120);
    }
  } catch {
    // ignorar
  }
  return "";
}

export interface Mentions {
  text: string;
  files: string[];
  images: string[];
}

// Adjunta al mensaje el contenido de cada @ruta que exista en el proyecto (las imágenes van aparte)
export function expandMentions(text: string, root: string, readTimes?: Map<string, number>): Mentions {
  const files: string[] = [];
  const images: string[] = [];
  const blocks: string[] = [];
  const pattern = /(^|\s)@([^\s@]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null && files.length < 10) {
    // Probamos tal cual y sin la puntuación final ("mira @src/a.ts.")
    const candidates = [match[2], match[2].replace(/[.,;:!?)\]'"]+$/, "")];
    for (const candidate of candidates) {
      let abs: string;
      try {
        abs = resolvePath(root, candidate);
      } catch {
        continue;
      }
      if (!fs.existsSync(abs)) {
        continue;
      }
      const label = rel(root, abs);
      if (!files.includes(label)) {
        files.push(label);
        if (fs.statSync(abs).isDirectory()) {
          const entries = fs
            .readdirSync(abs, { withFileTypes: true })
            .filter((e) => e.name !== ".git" && e.name !== "node_modules")
            .slice(0, 300)
            .map((e) => {
              if (e.isDirectory()) {
                return `${e.name}/`;
              }
              return e.name;
            });
          blocks.push(`<carpeta ruta="${label}">\n${entries.join("\n")}\n</carpeta>`);
        } else if (isImagePath(abs)) {
          images.push(toDataUrl(abs));
        } else {
          blocks.push(`<fichero ruta="${label}">\n${readNumbered(abs, label)}\n</fichero>`);
          if (readTimes) {
            readTimes.set(abs, fs.statSync(abs).mtimeMs);
          }
        }
      }
      break;
    }
  }
  if (blocks.length === 0) {
    return { text, files, images };
  }
  return { text: `${text}\n\nFicheros adjuntos con @ (ya leídos):\n\n${blocks.join("\n\n")}`, files, images };
}

// Lista de ficheros del proyecto para autocompletar @rutas (se guarda un rato para ir rápido)
let fileCache: { root: string; at: number; files: string[] } | null = null;

export function projectFiles(root: string): string[] {
  if (fileCache && fileCache.root === root && Date.now() - fileCache.at < 15000) {
    return fileCache.files;
  }
  let files: string[] = [];
  try {
    files = fg.sync("**/*", { cwd: root, ignore: IGNORE, dot: true, onlyFiles: false, markDirectories: true, deep: 8, suppressErrors: true }).slice(0, 20000);
  } catch {
    files = [];
  }
  fileCache = { root, at: Date.now(), files };
  return files;
}

// Sugerencias para @ruta: primero lo que empieza igual, luego lo que contiene el texto
export function suggestFiles(root: string, typed: string, max = 8): string[] {
  const query = typed.toLowerCase();
  const files = projectFiles(root);
  const scored: { file: string; score: number }[] = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = lower.slice(lower.replace(/\/$/, "").lastIndexOf("/") + 1);
    let score = -1;
    if (query === "") {
      score = file.split("/").length * 10 + file.length / 100;
    } else if (lower.startsWith(query)) {
      score = file.length / 100;
    } else if (base.startsWith(query)) {
      score = 10 + file.length / 100;
    } else if (lower.includes(query)) {
      score = 20 + file.length / 100;
    }
    if (score >= 0) {
      scored.push({ file, score });
    }
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, max).map((entry) => entry.file);
}

// Autocompletado con Tab de @rutas en el modo de texto simple
export function completeMention(root: string, typed: string): string[] {
  let dirPart = "";
  const slash = typed.lastIndexOf("/");
  if (slash >= 0) {
    dirPart = typed.slice(0, slash + 1);
  }
  const base = typed.slice(dirPart.length);
  try {
    const dir = resolvePath(root, dirPart || ".");
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name.startsWith(base) && e.name !== ".git" && e.name !== "node_modules")
      .map((e) => {
        if (e.isDirectory()) {
          return `@${dirPart}${e.name}/`;
        }
        return `@${dirPart}${e.name}`;
      })
      .sort();
  } catch {
    return [];
  }
}
