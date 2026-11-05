// Copyright (C) 2026 Pablo Vicente Juan
// SPDX-License-Identifier: AGPL-3.0-or-later
import { isUtf8 } from "node:buffer";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import fg from "fast-glob";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { debugLog } from "./debug.js";
import { isImagePath, toDataUrl } from "./images.js";
import { isSecretPath } from "./secrets.js";
import { MAX_RUNNING, type BackgroundJob, allJobs, findJob, jobState, readJob, runningJobs, startJob, stopJob, waitForJob } from "./background.js";
import type { Permission, PermissionReply, PermissionRequest } from "./permissions.js";
import { stripControl } from "./sanitize.js";
import { isInside, protectedDirs } from "./paths.js";
import { findLongRunning, looksLikeServer } from "./long-running.js";
import { spawnGroup, watchChild } from "./process.js";
import { commandShell, decodeClixml, findProgram } from "./shell.js";

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
  // Líneas añadidas y quitadas de verdad (el diff de «display» puede ir recortado)
  stats?: { added: number; removed: number };
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

const IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/vendor/**",
  "**/.venv/**",
  "**/__pycache__/**",
  // Si alguien abre vipcode en su carpeta personal de Windows: AppData es enorme y está llena de carpetas sin permiso
  "**/AppData/**",
  "**/$RECYCLE.BIN/**",
];
const MAX_OUTPUT = 20000;

export function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) {
    return text;
  }
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n[… ${text.length - max} caracteres omitidos …]\n\n${text.slice(-half)}`;
}

// Ruta real siguiendo los enlaces simbólicos, aunque el destino (o parte de él) todavía no exista.
// La versión nativa devuelve además las mayúsculas reales de cada carpeta
function realPathOf(file: string, depth = 0): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    // no existe (todavía) o es un enlace roto
  }
  if (depth < 40) {
    try {
      if (fs.lstatSync(file).isSymbolicLink()) {
        return realPathOf(path.resolve(path.dirname(file), fs.readlinkSync(file)), depth + 1);
      }
    } catch {
      // no existe
    }
  }
  const parent = path.dirname(file);
  if (parent === file || depth >= 40) {
    return file;
  }
  return path.join(realPathOf(parent, depth + 1), path.basename(file));
}

// Convierte una ruta relativa en absoluta y comprueba que no sale del proyecto
export function resolvePath(root: string, p: string | undefined, options: { write?: boolean } = {}): string {
  let input = p;
  if (!input) {
    input = ".";
  }
  const abs = path.resolve(root, input);
  if (!isInside(abs, root)) {
    throw new Error(`La ruta ${p} está fuera del proyecto (${root})`);
  }
  // Un enlace simbólico dentro del proyecto tampoco puede llevar fuera (por ejemplo a ~/.ssh o a tus claves)
  const real = realPathOf(abs);
  const realRoot = realPathOf(root);
  if (!isInside(real, realRoot)) {
    throw new Error(`La ruta ${p} es un enlace que lleva fuera del proyecto (${real})`);
  }
  // vipcode no puede tocarse a sí mismo: ni sus datos (claves, configuración) ni, para escribir, su instalación
  for (const { dir, read } of protectedDirs()) {
    const realDir = realPathOf(dir);
    if ((read || options.write) && isInside(real, realDir)) {
      if (read) {
        throw new Error(`La ruta ${p} está en la carpeta de datos de vipcode (${dir}), que guarda tus claves y tu configuración: no se puede leer ni cambiar desde aquí.`);
      }
      throw new Error(`La ruta ${p} es parte de la instalación de vipcode (${dir}): vipcode no puede modificarse a sí mismo.`);
    }
  }
  return abs;
}

// Patrones para que glob y grep no recorran la carpeta de datos de vipcode si está dentro del proyecto
function protectedIgnore(root: string): string[] {
  const realRoot = realPathOf(root);
  const patterns: string[] = [];
  for (const { dir, read } of protectedDirs()) {
    const relative = path.relative(realRoot, realPathOf(dir));
    if (read && relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      patterns.push(`${relative.split(path.sep).join("/")}/**`);
    }
  }
  return patterns;
}

// Ruta relativa al proyecto, siempre con / (también en Windows): es lo que ve el modelo y lo que comparan los permisos
export function rel(root: string, abs: string): string {
  const r = path.relative(root, abs);
  if (r === "") {
    return ".";
  }
  return r.split(path.sep).join("/");
}

// Los patrones glob van siempre con /; en Windows el modelo a veces los escribe con \
function globPattern(pattern: string): string {
  return process.platform === "win32" ? pattern.replace(/\\/g, "/") : pattern;
}

// Un patrón glob no puede salir del proyecto: nada de rutas absolutas ni de «..» (si no, «../**» llegaría a tus claves)
function outsidePattern(pattern: string): boolean {
  const clean = globPattern(pattern);
  return path.isAbsolute(clean) || /^[a-zA-Z]:/.test(clean) || clean.startsWith("~") || /(^|[/{,])\.\.([/},]|$)/.test(clean);
}

// Lo que encuentra fast-glob, comprobado como cualquier otra ruta (enlaces simbólicos y carpetas de vipcode incluidos)
function insideProject(root: string, cwd: string, files: string[]): string[] {
  return files.filter((file) => {
    try {
      resolvePath(root, path.relative(root, path.resolve(cwd, file)));
      return true;
    } catch {
      return false;
    }
  });
}

const OUTSIDE_PATTERN = "Error: el patrón tiene que ser relativo a la carpeta del proyecto (sin rutas absolutas ni «..»).";

function rejected(reply: PermissionReply, what: string): string {
  if (reply.feedback) {
    return `El usuario ha rechazado ${what}. Motivo: ${reply.feedback}`;
  }
  return `El usuario ha rechazado ${what}.`;
}

// Historial para /undo cuando no hay git: un grupo por cada mensaje del usuario, con el contenido previo de cada fichero
interface Change {
  file: string;
  // null si el fichero no existía antes. Los bytes tal cual: como texto se perdería lo que no esté en UTF-8
  previous: Buffer | null;
}
const undoStack: Change[][] = [];

export function beginTurn() {
  undoStack.push([]);
}

function recordChange(file: string, previous: Buffer | null) {
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

// Las operaciones del diff por líneas (iguales, quitadas y añadidas), en orden
function diffOps(oldText: string, newText: string): DiffLine[] {
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
  return ops;
}

// Cuántas líneas se añaden y se quitan de verdad (el diff que se enseña puede ir recortado)
export function diffCounts(oldText: string, newText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of diffOps(oldText, newText)) {
    if (op.type === "+") {
      added++;
    } else if (op.type === "-") {
      removed++;
    }
  }
  return { added, removed };
}

// Diff por líneas al estilo de git: solo los trozos que cambian, con unas líneas de contexto (lo colorea la UI)
export function unifiedDiff(oldText: string, newText: string, context = 3, maxLines = 120): string {
  const ops = diffOps(oldText, newText);

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
// Más que esto no se lee entero (un fichero de varios GB agotaría la memoria)
const MAX_READ_BYTES = 20 * 1024 * 1024;

function readNumbered(file: string, label: string, offset?: number, maxLines?: number): string {
  if (fs.statSync(file).size > MAX_READ_BYTES) {
    return `${label} ocupa más de 20 MB: no se lee entero. Busca lo que necesitas con grep.`;
  }
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) {
    return `${label} parece un fichero binario; no se muestra.`;
  }
  const lines = decodeText(buffer).text.split(/\r?\n/);
  // El salto de línea del final no es otra línea: un fichero «hola\nmundo\n» tiene 2
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
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

// Los modelos flojos mandan a veces los booleanos como texto, y «"false"» no puede contar como verdadero
export function isTrue(value: unknown): boolean {
  return value === true || value === 1 || (typeof value === "string" && /^(true|1)$/i.test(value.trim()));
}

// Muchos ficheros antiguos no están en UTF-8 sino en Windows-1252 (con ñ y tildes). Leídos como UTF-8, esas letras se
// convierten en «�» y al guardar se perderían para siempre. Se leen y se escriben byte a byte en su codificación
const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";

function decodeText(buffer: Buffer): { text: string; legacy: boolean } {
  if (isUtf8(buffer)) {
    return { text: buffer.toString("utf8"), legacy: false };
  }
  let text = "";
  for (const byte of buffer) {
    text += byte >= 0x80 && byte < 0xa0 ? CP1252_HIGH[byte - 0x80] : String.fromCharCode(byte);
  }
  return { text, legacy: true };
}

// Los bytes de un texto en Windows-1252, o null si lleva algo que no existe en esa codificación
function encodeLegacy(text: string): Buffer | null {
  const bytes: number[] = [];
  for (const letter of text) {
    const code = letter.codePointAt(0)!;
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) {
      bytes.push(code);
    } else {
      const high = CP1252_HIGH.indexOf(letter);
      if (high < 0) {
        return null;
      }
      bytes.push(0x80 + high);
    }
  }
  return Buffer.from(bytes);
}

function legacyError(name: string): string {
  return `Error: ${name} está en Windows-1252, no en UTF-8, y lo que quieres escribir lleva caracteres que no existen en esa codificación. No se ha cambiado nada: usa solo los que existen en ella (letras con tilde, ñ, €…).`;
}

// Antes de leer un fichero que puede guardar claves se pregunta, porque lo que se lee se manda al modelo. Devuelve el rechazo,
// o null si se puede leer. Un enlace a un secreto es un secreto; si ya lo has dejado leer, no se vuelve a preguntar
async function secretRefused(ctx: ToolContext, file: string): Promise<string | null> {
  const name = rel(ctx.root, file);
  const real = path.relative(realPathOf(ctx.root), realPathOf(file));
  if ((!isSecretPath(name) && !isSecretPath(real)) || ctx.readTimes.has(file)) {
    return null;
  }
  const reply = await ctx.ask({
    kind: "secrets",
    title: `Leer ${name}`,
    preview: `${name} puede guardar claves o contraseñas.\nLo que se lee se envía al modelo que esté contestando, que puede ser de un proveedor sin cuenta.`,
    subject: name,
  });
  return reply.allow ? null : rejected(reply, "leer el fichero");
}

// Antes de modificar un fichero que ya existe hay que haberlo leído, y no debe haber cambiado desde entonces
// Si no lo había leído (por ejemplo lo vio con cat en bash) y es pequeño, se le enseña en el propio error y cuenta como
// leído: así no gasta otro paso en read_file
const SHOW_UNREAD_LINES = 400;

function checkFresh(ctx: ToolContext, file: string): string | null {
  const readAt = ctx.readTimes.get(file);
  const name = rel(ctx.root, file);
  if (readAt === undefined) {
    // Un fichero con secretos se lee con read_file, que pregunta: aquí no se enseña
    if (isSecretPath(name) || isSecretPath(path.relative(realPathOf(ctx.root), realPathOf(file)))) {
      return `Error: lee ${name} con read_file antes de modificarlo.`;
    }
    try {
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/).length;
      if (lines <= SHOW_UNREAD_LINES && !text.includes("\u0000")) {
        const numbered = readNumbered(file, name, 1, SHOW_UNREAD_LINES);
        markRead(ctx, file);
        return `Error: lee ${name} con read_file antes de modificarlo. Este es su contenido actual (ya cuenta como leído): vuelve a hacer el cambio a partir de él.\n${numbered}`;
      }
    } catch {
      // si no se puede leer, el aviso de siempre
    }
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
    const refused = await secretRefused(ctx, file);
    if (refused) {
      return refused;
    }
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
    const file = resolvePath(ctx.root, args.path, { write: true });
    let content = String(args.content ?? "");
    const exists = fs.existsSync(file);
    const before = exists ? fs.readFileSync(file) : null;
    const old = before ? decodeText(before) : null;
    // Si ya existe y no está en UTF-8, sigue en su codificación (salvo un binario, que se sustituye entero)
    const legacy = Boolean(old?.legacy) && !before?.includes(0);
    // Windows PowerShell 5.1 lee los .ps1 sin BOM como ANSI: «está» saldría «estÃ¡». Con BOM los lee en UTF-8
    if (!legacy && process.platform === "win32" && /\.(ps1|psm1|psd1)$/i.test(file) && !content.startsWith("\uFEFF") && /[^\x00-\x7f]/.test(content)) {
      content = `\uFEFF${content}`;
    }
    const bytes = legacy ? encodeLegacy(content) : Buffer.from(content);
    let previous: string | null = null;
    let title = `Crear ${rel(ctx.root, file)}`;
    const newLines = content.split("\n");
    // El salto de línea del final no es otra línea
    const lineCount = newLines.length - (newLines.length > 1 && newLines[newLines.length - 1] === "" ? 1 : 0);
    // Un fichero nuevo se enseña recortado, pero la cuenta de líneas es la de verdad
    let preview = newLines.slice(0, Math.min(40, lineCount)).map((l) => `+ ${l}`).join("\n");
    if (lineCount > 40) {
      preview += `\n[… ${lineCount - 40} líneas más]`;
    }
    let stats = { added: lineCount, removed: 0 };
    if (exists) {
      const stale = checkFresh(ctx, file);
      if (stale) {
        return { output: stale, isError: true };
      }
      if (!bytes) {
        return { output: legacyError(rel(ctx.root, file)), isError: true };
      }
      previous = old!.text;
      title = `Sobrescribir ${rel(ctx.root, file)}`;
      preview = unifiedDiff(previous, content);
      stats = diffCounts(previous, content);
    }
    const reply = await ctx.ask({ kind: "write", title, preview, subject: rel(ctx.root, file) });
    if (!reply.allow) {
      return rejected(reply, "escribir el fichero");
    }
    recordChange(file, before);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes!);
    markRead(ctx, file);
    const output = await withDiagnostics(ctx, file, `Escrito ${rel(ctx.root, file)} (${content.split("\n").length} líneas).`);
    return { output, display: preview, stats };
  },
};

// Los modelos a veces copian old_string de la salida de read_file con el número de línea delante («12\tcódigo»): si todas
// las líneas lo llevan, se quita
export function stripLineNumbers(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const withText = lines.filter((line) => line.trim() !== "");
  if (withText.length === 0 || !withText.every((line) => /^\s*\d+\t/.test(line))) {
    return text;
  }
  return lines.map((line) => line.replace(/^\s*\d+\t/, "")).join("\n");
}

// Parecido entre dos líneas (de 0 a 1), por pares de letras (coeficiente de Dice), sin espacios de los bordes
function similarity(a: string, b: string): number {
  const x = a.trim();
  const y = b.trim();
  if (x === y) {
    return 1;
  }
  if (x.length < 2 || y.length < 2) {
    return 0;
  }
  const pairs = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const pair = x.slice(i, i + 2);
    pairs.set(pair, (pairs.get(pair) || 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const pair = y.slice(i, i + 2);
    const count = pairs.get(pair) || 0;
    if (count > 0) {
      shared++;
      pairs.set(pair, count - 1);
    }
  }
  return (2 * shared) / (x.length - 1 + (y.length - 1));
}

// Dónde empieza en el fichero el trozo que más se parece a «wanted» (las líneas tal cual, sin espacios de los bordes
// comparados), o -1 si nada se parece de verdad
function closestBlock(fileLines: string[], wanted: string[]): { at: number; score: number } {
  let best = { at: -1, score: 0 };
  if (wanted.length === 0) {
    return best;
  }
  for (let i = 0; i < fileLines.length; i++) {
    let total = 0;
    for (let j = 0; j < wanted.length && i + j < fileLines.length; j++) {
      total += similarity(fileLines[i + j], wanted[j]);
    }
    const score = total / wanted.length;
    if (score > best.score) {
      best = { at: i, score };
    }
  }
  return best.score >= 0.6 ? best : { at: -1, score: best.score };
}

// Líneas (desde 1) donde aparece «text» sin contar los espacios de los bordes. Un texto de una línea puede ser un trozo
// de una línea; en uno de varias, la primera puede ser el final de una línea y la última, el principio de otra
function findTrimmed(fileLines: string[], text: string): number[] {
  const wanted = text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim());
  while (wanted.length > 1 && wanted[wanted.length - 1] === "") {
    wanted.pop();
  }
  while (wanted.length > 1 && wanted[0] === "") {
    wanted.shift();
  }
  if (wanted.every((line) => line === "")) {
    return [];
  }
  const found: number[] = [];
  const last = wanted.length - 1;
  for (let i = 0; i + wanted.length <= fileLines.length; i++) {
    const ok = wanted.every((line, j) => {
      const real = fileLines[i + j].trim();
      if (wanted.length === 1) {
        // Un trozo muy corto («x», «)») aparece en cualquier parte: tiene que ser la línea entera
        return real === line || (line.length >= 8 && real.includes(line));
      }
      if (j === 0) {
        return real.endsWith(line);
      }
      if (j === last) {
        return real.startsWith(line);
      }
      return real === line;
    });
    if (ok) {
      found.push(i + 1);
    }
  }
  return found;
}

// Qué decirle al modelo cuando old_string no aparece: si lo nuevo está justo donde iría el cambio, que no repita la
// edición; si no, el trozo del fichero que más se parece, con sus números de línea, para que copie el texto exacto sin
// otra llamada. Que lo nuevo aparezca en otra parte no dice nada: «return result;» puede estar en cualquier función
function notFoundMessage(original: string, oldString: string, newString: string): { message: string; applied: boolean } {
  const fileLines = original.replace(/\r\n/g, "\n").split("\n");
  const wanted = oldString.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim() !== "").slice(0, 30);
  const near = closestBlock(fileLines, wanted);
  const appearsAt = newString.trim() !== "" ? findTrimmed(fileLines, newString) : [];
  const newCount = newString.trim().split("\n").length;
  const inPlace = appearsAt.find((line) => near.at >= 0 && line - 1 < near.at + wanted.length && near.at < line - 1 + newCount);
  if (inPlace !== undefined) {
    return {
      message: `Nada que cambiar: old_string no está en el fichero y new_string ya aparece en la línea ${inPlace}, justo donde iría este cambio. Parece ya hecho: no repitas esta edición y sigue con el siguiente paso.`,
      applied: true,
    };
  }
  let message = "Error: old_string no aparece en el fichero (ni ignorando la sangría y los espacios de los bordes).";
  if (near.at >= 0) {
    const from = Math.max(0, near.at - 2);
    const to = Math.min(fileLines.length, near.at + wanted.length + 2);
    const block = fileLines.slice(from, to).map((line, i) => `${from + i + 1}\t${line}`).join("\n");
    message += ` Lo más parecido está en la línea ${near.at + 1}; cópialo tal cual de aquí (sin el número ni el tabulador del principio):\n${block}`;
  } else {
    message += " Ningún trozo del fichero se le parece: vuelve a leerlo con read_file (puede que ya lo hayas cambiado) antes de editar.";
  }
  if (appearsAt.length > 0) {
    message += `\nnew_string aparece en la línea ${appearsAt[0]}, pero no donde iría este cambio, y no se ha cambiado nada: comprueba si esa línea es lo que querías.`;
  }
  return { message, applied: false };
}

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
  // Copiado de read_file con los números de línea delante
  const unnumbered = stripLineNumbers(oldString);
  if (unnumbered !== oldString) {
    const result = replaceInText(original, unnumbered, stripLineNumbers(newString), replaceAll);
    if (!("error" in result)) {
      return { ...result, note: `${result.note} (se quitaron los números de línea copiados de read_file)` };
    }
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
    return { error: "Error: old_string no aparece en el fichero." };
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
    const file = resolvePath(ctx.root, args.path, { write: true });
    if (!fs.existsSync(file)) {
      return { output: `Error: ${args.path} no existe. Para crear un fichero usa write_file.`, isError: true };
    }
    const stale = checkFresh(ctx, file);
    if (stale) {
      return { output: stale, isError: true };
    }
    const before = fs.readFileSync(file);
    if (before.includes(0)) {
      return { output: `Error: ${rel(ctx.root, file)} parece un fichero binario: no se puede editar sin estropearlo.`, isError: true };
    }
    const { text: original, legacy } = decodeText(before);
    const oldString = String(args.old_string ?? "");
    const newString = String(args.new_string ?? "");
    if (oldString === "") {
      return { output: "Error: old_string está vacío. Para crear un fichero usa write_file.", isError: true };
    }
    if (oldString === newString) {
      // Suele pasar cuando el modelo cree que aún tiene que aplicar un cambio que ya hizo: que no lo repita
      if (findTrimmed(original.replace(/\r\n/g, "\n").split("\n"), oldString).length > 0) {
        return { output: "Nada que cambiar: old_string y new_string son iguales y ese texto ya está en el fichero. El cambio ya está hecho: sigue con el siguiente paso." };
      }
      return { output: "Error: old_string y new_string son iguales; no hay nada que cambiar.", isError: true };
    }
    const result = replaceInText(original, oldString, newString, isTrue(args.replace_all));
    if ("error" in result) {
      if (result.error.startsWith("Error: old_string no aparece")) {
        const { message, applied } = notFoundMessage(original, stripLineNumbers(oldString), stripLineNumbers(newString));
        return { output: message, isError: !applied };
      }
      return { output: result.error, isError: true };
    }
    const bytes = legacy ? encodeLegacy(result.updated) : Buffer.from(result.updated);
    if (!bytes) {
      return { output: legacyError(rel(ctx.root, file)), isError: true };
    }
    const diff = unifiedDiff(original, result.updated);
    const reply = await ctx.ask({ kind: "write", title: `Editar ${rel(ctx.root, file)}`, preview: diff, subject: rel(ctx.root, file) });
    if (!reply.allow) {
      return rejected(reply, "la edición");
    }
    recordChange(file, before);
    fs.writeFileSync(file, bytes);
    markRead(ctx, file);
    const output = await withDiagnostics(ctx, file, `Editado ${rel(ctx.root, file)} (${result.count} sustitución/es)${result.note}.`);
    return { output, display: diff, stats: diffCounts(original, result.updated) };
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
    if (outsidePattern(String(args.pattern))) {
      return OUTSIDE_PATTERN;
    }
    // suppressErrors: una carpeta sin permiso (en Windows pasa en AppData\Local\Temp) se salta en vez de tumbar la búsqueda
    const found = await fg(globPattern(String(args.pattern)), {
      cwd,
      ignore: [...IGNORE, ...protectedIgnore(cwd)],
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    });
    const files = insideProject(ctx.root, cwd, found);
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

let ripgrepPath: string | null | undefined;

// Ruta completa de ripgrep, si está instalado (VIPCODE_RIPGREP=0 hace que no se use)
function ripgrepProgram(): string | null {
  if (process.env.VIPCODE_RIPGREP === "0") {
    return null;
  }
  if (ripgrepPath === undefined) {
    const found = findProgram("rg");
    try {
      ripgrepPath = found && spawnSync(found, ["--version"], { stdio: "ignore" }).status === 0 ? found : null;
    } catch {
      ripgrepPath = null;
    }
  }
  return ripgrepPath;
}

// ripgrep es mucho más rápido en proyectos grandes; devuelve null si falla para usar la búsqueda propia
function ripgrep(args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number; stdout: string } | null> {
  return new Promise((resolve) => {
    const child = spawn(ripgrepProgram() || "rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort);
    // Como texto: así una letra de varios bytes (ñ, á, €) no se rompe si llega partida entre dos trozos
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      if (stdout.length < 2000000) {
        stdout += text;
      }
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0 || code === 1) {
        resolve({ code: code ?? 1, stdout });
      } else if (code === 2 && stdout.trim() !== "") {
        // 2 con resultados: ha encontrado cosas pero alguna carpeta no se podía leer (sin permiso): valen igual
        resolve({ code: 0, stdout });
      } else {
        resolve(null);
      }
    });
  });
}

const grepTool: Tool = {
  name: "grep",
  description:
    "Busca una expresión regular dentro de los ficheros del proyecto, o solo en una carpeta o fichero con path. Devuelve fichero:línea: texto (rutas relativas a la raíz del proyecto).",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Expresión regular" },
      path: { type: "string", description: "Carpeta o fichero donde buscar, relativo a la raíz (por defecto, todo el proyecto)" },
      include: { type: "string", description: "Glob de ficheros donde buscar, por ejemplo **/*.php" },
      ignore_case: { type: "boolean" },
    },
    required: ["pattern"],
  },
  permission: "none",
  readOnly: true,
  async run(args, ctx) {
    const pattern = String(args.pattern);
    if (args.include && outsidePattern(String(args.include))) {
      return OUTSIDE_PATTERN;
    }
    // Dónde se busca: todo el proyecto o lo que diga path (una carpeta o un fichero)
    const target = resolvePath(ctx.root, args.path);
    let dir = target;
    let single: string | null = null;
    try {
      if (fs.statSync(target).isFile()) {
        dir = path.dirname(target);
        single = path.basename(target);
      }
    } catch {
      return `Error: ${args.path} no existe.`;
    }
    // Pedir un fichero con secretos por su nombre se pregunta, como al leerlo
    if (single) {
      const refused = await secretRefused(ctx, target);
      if (refused) {
        return refused;
      }
    }
    // Lo que devuelve la búsqueda va relativo a «dir»; el modelo lo ve relativo a la raíz
    const prefix = rel(ctx.root, dir);
    const fromRoot = (file: string) => (prefix === "." ? file : `${prefix}/${file}`);
    // Lo que sale de los ficheros con secretos no se enseña (salvo si lo has pedido por su nombre), pero se dice que hay más
    const hideSecrets = (lines: string[]): string[] => {
      if (single) {
        return lines;
      }
      const hidden = new Set<string>();
      const shown = lines.filter((line) => {
        const file = /^([^:]+):\d+:/.exec(line)?.[1] || "";
        if (isSecretPath(file)) {
          hidden.add(file);
          return false;
        }
        return true;
      });
      if (hidden.size > 0) {
        shown.push(`[se ha omitido ${hidden.size} fichero${hidden.size > 1 ? "s" : ""} que puede${hidden.size > 1 ? "n" : ""} guardar claves: ${[...hidden].slice(0, 5).join(", ")}. Léelo${hidden.size > 1 ? "s" : ""} con read_file si hace falta]`);
      }
      return shown;
    };

    if (ripgrepProgram()) {
      // --crlf: en los ficheros con saltos de línea de Windows, $ también encaja antes del \r\n
      const rgArgs = ["--line-number", "--no-heading", "--color", "never", "--with-filename", "--no-messages", "--crlf", "--max-columns", "300", "--max-columns-preview", "-e", pattern];
      if (process.platform === "win32") {
        rgArgs.push("--path-separator", "/");
      }
      if (isTrue(args.ignore_case)) {
        rgArgs.push("-i");
      }
      if (args.include) {
        rgArgs.push("-g", globPattern(String(args.include)));
      }
      for (const ignored of protectedIgnore(dir)) {
        rgArgs.push("-g", `!${ignored}`);
      }
      // «--»: un fichero del proyecto puede llamarse «--pre=sh», y rg ejecutaría ese programa con lo que busca
      rgArgs.push("--", single ?? ".");
      const found = await ripgrep(rgArgs, dir, ctx.signal);
      if (found) {
        if (found.code === 1 || found.stdout.trim() === "") {
          return "Sin coincidencias.";
        }
        const lines = found.stdout
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => line.replace(/\r$/, "").replace(/^\.\//, "").replace(/^([^:]+):(\d+):/, (_, file: string, n: string) => `${fromRoot(file)}:${n}: `));
        const shown = hideSecrets(lines);
        if (shown.length > 200) {
          return `${shown.slice(0, 200).join("\n")}\n[… limitado a 200 resultados]`;
        }
        return shown.length > 0 ? shown.join("\n") : "Sin coincidencias.";
      }
    }

    const flags = isTrue(args.ignore_case) ? "i" : "";
    try {
      new RegExp(pattern, flags);
    } catch (err) {
      return `Expresión regular inválida: ${(err as Error).message}`;
    }
    let include = "**/*";
    if (args.include) {
      include = globPattern(String(args.include));
    }
    let files: string[];
    if (single) {
      files = [single];
    } else {
      // suppressErrors: una carpeta sin permiso se salta en vez de tumbar la búsqueda entera
      files = insideProject(
        ctx.root,
        dir,
        await fg(include, { cwd: dir, ignore: [...IGNORE, ...protectedIgnore(dir)], dot: false, onlyFiles: true, followSymbolicLinks: false, suppressErrors: true }),
      );
    }
    const found = await searchInWorker(dir, files, pattern, flags, ctx.signal);
    const results = hideSecrets(found.matches.map((match) => `${rel(ctx.root, path.join(dir, match.file))}:${match.line}: ${match.text}`));
    if (found.cancelled) {
      return ["Cancelado por el usuario", ...results].join("\n");
    }
    if (found.stalled) {
      const note = `la expresión regular tarda demasiado (la búsqueda se ha parado en ${rel(ctx.root, path.join(dir, found.stalled))}): prueba con una más sencilla`;
      return results.length > 0 ? `${results.join("\n")}\n[… ${note}]` : `Error: ${note}.`;
    }
    if (results.length === 0) {
      return "Sin coincidencias.";
    }
    return results.join("\n") + (found.limited ? "\n[… limitado a 200 resultados]" : "");
  },
};

// La búsqueda sin rg va en otro hilo. Una expresión regular mal escrita, como (a+)+$, puede tardar años en una sola línea, y
// en el hilo principal dejaría vipcode colgado para siempre, sin que funcione ni Esc. Rg no tiene ese problema
const SEARCH_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { dir, files, pattern, flags, limit } = workerData;
const regex = new RegExp(pattern, flags);
function search() {
  let found = 0;
  for (const file of files) {
    parentPort.postMessage({ at: file });
    const abs = path.join(dir, file);
    let buffer;
    try {
      if (fs.statSync(abs).size > 1024 * 1024) {
        continue;
      }
      buffer = fs.readFileSync(abs);
    } catch {
      // sin permiso para leerlo: se salta
      continue;
    }
    if (buffer.includes(0)) {
      continue;
    }
    const lines = buffer.toString("utf8").split(/\\r?\\n/);
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        parentPort.postMessage({ file, line: i + 1, text: lines[i].slice(0, 300) });
        if (++found >= limit) {
          parentPort.postMessage({ limited: true });
          return;
        }
      }
    }
  }
}
search();
parentPort.postMessage({ done: true });
`;
// Sin noticias de un fichero en este tiempo (ocupan como mucho 1 MB) es que la expresión no va a terminar
const SEARCH_STALL_MS = 10000;

interface WorkerSearch {
  matches: { file: string; line: number; text: string }[];
  limited: boolean;
  // El fichero en el que se ha quedado, si la expresión tarda demasiado
  stalled: string | null;
  cancelled: boolean;
}

function searchInWorker(dir: string, files: string[], pattern: string, flags: string, signal?: AbortSignal): Promise<WorkerSearch> {
  const result: WorkerSearch = { matches: [], limited: false, stalled: null, cancelled: false };
  if (files.length === 0) {
    return Promise.resolve(result);
  }
  return new Promise((resolve) => {
    const worker = new Worker(SEARCH_WORKER, { eval: true, workerData: { dir, files, pattern, flags, limit: 200 } });
    const stallMs = Number(process.env.VIPCODE_GREP_STALL_MS) || SEARCH_STALL_MS;
    let current = files[0];
    let timer: NodeJS.Timeout;
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      void worker.terminate();
      resolve(result);
    };
    const cancel = () => {
      result.cancelled = true;
      finish();
    };
    const watch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        result.stalled = current;
        finish();
      }, stallMs);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }
    watch();
    worker.on("message", (message: { at?: string; file?: string; line?: number; text?: string; limited?: boolean; done?: boolean }) => {
      if (message.at !== undefined) {
        current = message.at;
        watch();
      } else if (message.file !== undefined) {
        result.matches.push({ file: message.file, line: message.line!, text: message.text! });
      } else if (message.limited) {
        result.limited = true;
        finish();
      } else if (message.done) {
        finish();
      }
    });
    worker.on("error", (err) => {
      debugLog("grep", err);
      finish();
    });
    worker.on("exit", finish);
  });
}

// Un .git/config con core.fsmonitor ejecutaría un programa en cada «git status» (que se aprueba solo)
function gitSafetyEnv(): Record<string, string> {
  const count = Number(process.env.GIT_CONFIG_COUNT) || 0;
  return { GIT_CONFIG_COUNT: String(count + 1), [`GIT_CONFIG_KEY_${count}`]: "core.fsmonitor", [`GIT_CONFIG_VALUE_${count}`]: "false" };
}

// Lo que se espera a un comando en segundo plano antes de dar por bueno que ha arrancado: si falla enseguida (no existe, el
// puerto está ocupado…) el agente lo sabe ya
const BACKGROUND_START_MS = 2000;
const BACKGROUND_WAIT_MS = 30000;
// Un comando que lleva esto sin escribir nada y cuya última salida parece la de un servidor listo se corta
const SERVER_IDLE_MS = 30000;

function seconds(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

const bashTool: Tool = {
  name: "bash",
  description:
    "Ejecuta un comando de shell (tests, git, instalar dependencias…). Cada llamada empieza de nuevo en la raíz del proyecto: un cd no se conserva para la siguiente; para trabajar en una subcarpeta usa workdir. No lo uses para leer o editar ficheros: para eso están las otras herramientas. No es interactivo: evita comandos que esperen que escribas algo. No lances servidores de desarrollo ni comandos en modo watch: no terminan y se rechazan. Una tarea larga que termina sola (pruebas, un build grande) puedes lanzarla con background: true.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      workdir: { type: "string", description: "Carpeta donde ejecutarlo, relativa a la raíz del proyecto (por defecto, la raíz)" },
      description: { type: "string", description: "Qué hace el comando, en 5-10 palabras" },
      timeout_ms: { type: "number", description: "Tiempo máximo en milisegundos (máximo 600000)" },
      background: { type: "boolean", description: "Déjalo en marcha y sigue trabajando; se mira y se para con la herramienta background" },
    },
    required: ["command"],
  },
  permission: "bash",
  readOnly: false,
  async run(args, ctx) {
    const command = String(args.command ?? "");
    // Lo que no termina solo no se ejecuta, y ni se pregunta: es lo que dejaba a vipcode esperando horas
    const endless = findLongRunning(command);
    if (endless) {
      return `Error: no se ejecuta «${endless.command}» porque no termina solo (es un servidor de desarrollo o un modo watch). Para comprobar que compila usa ${endless.alternative}. Los servidores de desarrollo los arranca el usuario en su propia terminal: si hace falta uno, díselo.`;
    }
    let cwd = ctx.root;
    if (args.workdir && String(args.workdir).trim() !== "" && String(args.workdir).trim() !== ".") {
      // Con write: el comando puede escribir, así que tampoco vale la instalación de vipcode
      cwd = resolvePath(ctx.root, String(args.workdir), { write: true });
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return `Error: la carpeta ${args.workdir} no existe.`;
      }
      // Lo que se escribe en .git (hooks, config) lo ejecuta git después; con workdir, el comando ya no nombraría .git
      const inner = path.relative(realPathOf(ctx.root), realPathOf(cwd));
      if (inner.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")) {
        return "Error: workdir no puede estar dentro de .git.";
      }
    }
    const background = isTrue(args.background);
    if (background && runningJobs().length >= MAX_RUNNING) {
      return `Error: ya hay ${MAX_RUNNING} comandos en segundo plano. Para alguno con la herramienta background antes de lanzar otro.`;
    }
    let title = background ? "Ejecutar en segundo plano" : "Ejecutar comando";
    if (args.description) {
      title = `${title}: ${String(args.description).slice(0, 80)}`;
    }
    const workdir = cwd === ctx.root ? undefined : rel(ctx.root, cwd);
    const where = `${background ? "(en segundo plano) " : ""}${workdir ? `(en ${workdir}) ` : ""}`;
    const reply = await ctx.ask({ kind: "bash", title, preview: `${where}$ ${command}`, subject: command, workdir });
    if (!reply.allow) {
      return rejected(reply, "ejecutar el comando");
    }
    let timeout = ctx.bashTimeoutMs;
    if (args.timeout_ms && args.timeout_ms > 0) {
      timeout = Math.min(args.timeout_ms, 600000);
    }
    const environment = (shell: ReturnType<typeof commandShell>) => ({ ...process.env, ...shell.env, ...gitSafetyEnv(), VIPCODE: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" });

    if (background) {
      const shell = commandShell();
      const job = startJob({
        command,
        workdir,
        cwd,
        file: shell.file,
        args: shell.args(command),
        env: environment(shell),
        timeoutMs: args.timeout_ms > 0 ? timeout : undefined,
      });
      await waitForJob(job, BACKGROUND_START_MS, ctx.signal, false);
      // Esc mientras arranca: lo has cancelado. Después ya no le afecta: para eso está en segundo plano
      if (ctx.signal?.aborted && job.finished === null) {
        void stopJob(job);
        return "Cancelado por el usuario";
      }
      const body = truncate(readJob(job).trim()) || "(sin salida)";
      if (job.finished !== null) {
        return `Código de salida: ${job.code} (ha terminado enseguida: ya no está en marcha)\n${body}`;
      }
      return `En marcha en segundo plano con el id ${job.id}; se para al cerrar vipcode. Con la herramienta background ves lo que escribe (action: "output") y lo paras (action: "stop").\nSalida hasta ahora:\n${body}`;
    }

    const shell = commandShell();
    // En su propio grupo de procesos, para poder parar también a los hijos (npm test, servidores…)
    const child = spawnGroup(shell.file, shell.args(command), {
      cwd,
      env: environment(shell),
      windowsHide: true,
    });
    const idleMs = Number(process.env.VIPCODE_SERVER_IDLE_MS) || SERVER_IDLE_MS;
    const result = await watchChild(child, { timeoutMs: timeout, signal: ctx.signal, onOutput: ctx.onProgress, idleMs, isIdle: looksLikeServer });
    if (result.error) {
      return `No se pudo ejecutar: ${result.error}`;
    }
    let header = `Código de salida: ${result.code}`;
    if (result.reason === "timeout") {
      header = `Cortado por tiempo tras ${seconds(timeout)} s. Si es un servidor o algo que no termina, lo tiene que arrancar el usuario; para comprobar que compila, usa el build`;
    } else if (result.reason === "abort") {
      header = "Cancelado por el usuario";
    } else if (result.reason === "idle") {
      header = `Cortado: llevaba ${seconds(idleMs)} s sin escribir nada y lo último parece un servidor ya listo, que no va a terminar. Lo ha dejado parado; para comprobar que compila, usa el build, y los servidores los arranca el usuario`;
    } else if (result.lingering) {
      header += " (había dejado algo en marcha con su salida abierta, y se ha parado)";
    }
    // Por si PowerShell manda algún error en CLIXML («#< CLIXML <Objs…»): en texto normal
    let body = decodeClixml(result.output).trim();
    if (body === "") {
      body = "(sin salida)";
    }
    return `${header}\n${truncate(body)}`;
  },
};

// Una línea por cada comando en segundo plano
function describeJob(job: BackgroundJob): string {
  return `${job.id}: ${jobState(job)} · ${job.workdir ? `(en ${job.workdir}) ` : ""}${job.command.replace(/\s+/g, " ").slice(0, 120)}`;
}

const backgroundTool: Tool = {
  name: "background",
  description:
    'Mira o para lo que lanzaste con bash y background: true. action: "list" (qué hay), "output" (lo que ha escrito desde la última vez; con wait_ms espera a que escriba algo, por ejemplo a que arranque un servidor) o "stop" (lo para con todo lo que haya lanzado).',
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "output", "stop"] },
      id: { type: "string", description: "El id que te dio bash, por ejemplo bg1 (no hace falta si solo hay uno)" },
      wait_ms: { type: "number", description: "Con output: lo que se espera a que escriba algo, en milisegundos (máximo 30000)" },
    },
    required: ["action"],
  },
  permission: "none",
  readOnly: false,
  async run(args, ctx) {
    const action = String(args.action);
    const list = allJobs();
    if (action === "list") {
      return list.length > 0 ? list.map(describeJob).join("\n") : "No hay nada en segundo plano.";
    }
    if (action !== "output" && action !== "stop") {
      return `Error: action tiene que ser list, output o stop, no «${action}».`;
    }
    let job: BackgroundJob | undefined;
    if (args.id) {
      // Solo los que ha lanzado vipcode: esto nunca para un proceso cualquiera del ordenador
      job = findJob(String(args.id));
    } else {
      const running = runningJobs();
      job = running.length === 1 ? running[0] : undefined;
    }
    if (!job) {
      return `Error: no encuentro ese comando. ${list.length > 0 ? `Hay estos:\n${list.map(describeJob).join("\n")}` : "No hay nada en segundo plano."}`;
    }
    if (action === "stop") {
      await stopJob(job);
      return describeJob(job);
    }
    if (args.wait_ms > 0) {
      await waitForJob(job, Math.min(Number(args.wait_ms), BACKGROUND_WAIT_MS), ctx.signal, true);
    }
    const text = readJob(job).trim();
    return `${describeJob(job)}\n${text ? truncate(text) : "(no ha escrito nada nuevo)"}`;
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
    // Una dirección de tu ordenador o de tu red se pregunta siempre, aunque tengas webfetch en allow: un texto
    // malicioso podría pedir al modelo que entre en tu router o en los datos de tu nube
    const internal = await isInternalHost(parsed.hostname);
    const title = internal ? "Descargar una dirección de tu ordenador o de tu red" : "Descargar página web";
    const reply = await ctx.ask({ kind: "web", title, preview: `GET ${parsed.href}`, subject: parsed.href, force: internal });
    if (!reply.allow) {
      return rejected(reply, "descargar la página");
    }
    // Las redirecciones se siguen a mano: una página de internet no puede mandarte a tu red sin que lo apruebes
    let current = parsed;
    let response: Response;
    for (let hop = 0; ; hop++) {
      response = await fetch(current, {
        signal: webSignal(ctx),
        redirect: "manual",
        headers: { "user-agent": "vipcode", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
      });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (!location) {
        break;
      }
      if (hop >= 5) {
        return "Error: demasiadas redirecciones.";
      }
      const next = new URL(location, current);
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        return "Error: la página redirige a una dirección que no es http ni https.";
      }
      if (!internal && (await isInternalHost(next.hostname))) {
        const again = await ctx.ask({ kind: "web", title: "La página redirige a una dirección de tu ordenador o de tu red", preview: `GET ${next.href}`, subject: next.href, force: true });
        if (!again.allow) {
          return rejected(again, "seguir la redirección");
        }
      }
      current = next;
    }
    if (!response.ok) {
      return `Error: HTTP ${response.status} ${response.statusText}`;
    }
    const type = response.headers.get("content-type") || "";
    if (type !== "" && !/text|json|xml|javascript/.test(type)) {
      return `Error: tipo de contenido no soportado (${type})`;
    }
    let body = await readBody(response);
    if (/html/.test(type)) {
      body = htmlToText(body);
    }
    if (body === "") {
      body = "(página vacía)";
    }
    return `${current.href}\n\n${truncate(body)}`;
  },
};

// Direcciones de tu ordenador o de tu red: localhost, 10.x, 192.168.x, la de los datos de las nubes (169.254.169.254)…
export function isInternalAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    if (ip === "::1" || ip === "::") {
      return true;
    }
    if (ip.startsWith("::ffff:")) {
      return isInternalAddress(ip.slice(7));
    }
    return /^(fc|fd|fe[89ab])/.test(ip);
  }
  return false;
}

// ¿Esta dirección lleva a tu ordenador o a tu red? (también si es un nombre que apunta a una IP interna)
export async function isInternalHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(host)) {
    return isInternalAddress(host);
  }
  if (host === "localhost" || /\.(localhost|local|internal|lan|home)$/.test(host) || !host.includes(".")) {
    return true;
  }
  try {
    return (await dns.lookup(host, { all: true })).some((entry) => isInternalAddress(entry.address));
  } catch {
    // Si no se resuelve, la descarga fallará igualmente
    return false;
  }
}

// Más que esto no se descarga (una página enorme agotaría la memoria)
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    size += value.length;
    if (size >= MAX_PAGE_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, MAX_PAGE_BYTES).toString("utf8");
}

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
  return todos.map((todo) => `${STATUS_ICON[todo.status] || "[ ]"} ${stripControl(String(todo.content))}`).join("\n");
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
    description: `Lanza un subagente que trabaja por su cuenta, con su propio contexto, y te devuelve un informe. Úsalo para investigaciones amplias o tareas independientes que llenarían tu contexto. Lanza varios a la vez si son independientes. Revisa cada informe: si empieza por [Subagente INCOMPLETO] o solo anuncia lo que iba a hacer, esa parte no está hecha. Tipos:\n${subagents
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
      return await ctx.subagent(String(args.subagent_type || "ayudante"), String(args.prompt || ""), String(args.description || ""));
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
  backgroundTool,
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
      return `${args.subagent_type || "ayudante"}: ${args.description || ""}`.trim();
    }
    if (name === "todowrite" && Array.isArray(args.todos)) {
      return `${args.todos.length} tareas`;
    }
    if (name === "skill") {
      return `${args.name || ""}${args.file ? ` · ${args.file}` : ""}`;
    }
    // Un comando se resume por su primera línea con algo (un «python - <<EOF» de varias líneas, por esa)
    if (name === "background") {
      return `${args.action === "stop" ? "para" : args.action === "output" ? "mira" : "lista"}${args.id ? ` ${args.id}` : ""}`;
    }
    if (name === "bash" && args.command) {
      const lines = String(args.command).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      let text = lines[0] || "";
      if (lines.length > 1) {
        text += " …";
      }
      if (isTrue(args.background)) {
        text = `(en segundo plano) ${text}`;
      }
      if (args.workdir && String(args.workdir).trim() !== "" && String(args.workdir).trim() !== ".") {
        text = `(${args.workdir}) ${text}`;
      }
      return text.slice(0, 120);
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
    files = fg
      .sync("**/*", { cwd: root, ignore: [...IGNORE, ...protectedIgnore(root)], dot: true, onlyFiles: false, markDirectories: true, deep: 8, suppressErrors: true, followSymbolicLinks: false })
      .slice(0, 20000);
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
