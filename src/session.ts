import fs from "node:fs";
import path from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ContextSummary } from "./context.js";
import { toolLabel } from "./labels.js";
import { EXPORTS_DIR, HISTORY_PATH, SESSIONS_DIR, ensureHomeDir, writeFileAtomic } from "./paths.js";
import { type Todo, describeCall } from "./tools.js";

// Un mensaje tuyo y todo lo que hizo el agente después (para /undo y /redo)
export interface Turn {
  // Mensajes que había antes de este turno
  messageIndex: number;
  // Instantáneas de los ficheros antes y después (null si no hay git)
  before: string | null;
  after: string | null;
  // Cambia cada vez que se resume la conversación
  epoch: number;
  userText: string;
}

// Lo que fue pasando en la conversación tal como lo viste. A diferencia de los mensajes que recibe el modelo,
// no se resume nunca: con esto se enseña la conversación al volver a ella y se escribe el .md
export interface LogEntry {
  role: "user" | "assistant" | "tool" | "info";
  text: string;
  time: number;
  // assistant: modelo que contestó
  model?: string;
  // tool: herramienta, resumen de la llamada, si falló y el diff que enseñó
  tool?: { name: string; summary: string; isError: boolean; display?: string };
  // user: imágenes que adjuntaste
  images?: number;
}

export interface Session {
  id: string;
  title: string;
  cwd: string;
  created: number;
  updated: number;
  messages: ChatCompletionMessageParam[];
  todos: Todo[];
  turns: Turn[];
  redo: { turn: Turn; messages: ChatCompletionMessageParam[] }[];
  epoch: number;
  usage: { prompt: number; completion: number };
  agent?: string;
  log: LogEntry[];
  // Resumen de los primeros mensajes para los modelos en los que la conversación no cabe entera (src/context.ts). Los
  // mensajes siguen enteros en «messages»
  summary?: ContextSummary;
}

export function newSession(cwd: string): Session {
  const now = new Date();
  // id legible y ordenable: 20261029-174512-k3x
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14).replace(/(\d{8})(\d{6})/, "$1-$2");
  const suffix = Math.random().toString(36).slice(2, 5);
  return {
    id: `${stamp}-${suffix}`,
    title: "(sin título)",
    cwd,
    created: Date.now(),
    updated: Date.now(),
    messages: [],
    todos: [],
    turns: [],
    redo: [],
    epoch: 0,
    usage: { prompt: 0, completion: 0 },
    log: [],
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (part.type === "text") {
          return part.text;
        }
        if (part.type === "image_url") {
          return "[imagen]";
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

// Lo que escribiste, sin los ficheros adjuntos con @ ni las notas que añade vipcode
function userText(text: string): string {
  let clean = text;
  const attached = clean.indexOf("\n\nFicheros adjuntos con @");
  if (attached >= 0) {
    const names = [...clean.slice(attached).matchAll(/<(?:fichero|carpeta) ruta="([^"]+)">/g)].map((match) => match[1]);
    clean = `${clean.slice(0, attached)}\n\n_Adjuntos: ${names.join(", ")}_`;
  }
  return clean.replace(/^\((?:Nota|El usuario ha ejecutado)[\s\S]*?\)\n\n/, "").replace(/^\[Mensaje nuevo del usuario mientras trabajabas\] /, "");
}

// Las sesiones de antes no tenían historial: se saca de los mensajes que quedan
function logFromMessages(messages: ChatCompletionMessageParam[], time: number): LogEntry[] {
  const log: LogEntry[] = [];
  const results = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "tool") {
      results.set(String((message as any).tool_call_id), contentText(message.content));
    }
  }
  for (const message of messages) {
    if (message.role === "user") {
      const text = contentText(message.content);
      if (/^(Continúa con la tarea pendiente\.|Has hecho la misma llamada|Has repetido la misma llamada|Imágenes devueltas por las herramientas:)/.test(text)) {
        continue;
      }
      if (text.startsWith("Resumen de la conversación anterior:")) {
        log.push({ role: "info", text: "Conversación resumida para ahorrar contexto (lo anterior al resumen ya no se guardaba entonces).", time });
        continue;
      }
      log.push({ role: "user", text: userText(text), time });
    } else if (message.role === "assistant") {
      const text = contentText(message.content);
      if (text.trim() !== "" && text !== "Entendido, sigo desde aquí.") {
        log.push({ role: "assistant", text, time });
      }
      for (const call of ((message as any).tool_calls || []) as any[]) {
        const name = String(call.function?.name || "");
        const output = results.get(String(call.id)) || "";
        log.push({ role: "tool", text: output.slice(0, 4000), time, tool: { name, summary: describeCall(name, call.function?.arguments || ""), isError: output.startsWith("Error") } });
      }
    }
  }
  return log;
}

// Las sesiones de la versión anterior no tenían todos los campos
function normalize(data: Partial<Session>): Session {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  return {
    id: String(data.id),
    title: data.title || "(sin título)",
    cwd: data.cwd || "",
    created: data.created || data.updated || Date.now(),
    updated: data.updated || Date.now(),
    messages,
    todos: Array.isArray(data.todos) ? data.todos : [],
    turns: Array.isArray(data.turns) ? data.turns : [],
    redo: Array.isArray(data.redo) ? data.redo : [],
    epoch: data.epoch || 0,
    usage: data.usage || { prompt: 0, completion: 0 },
    agent: data.agent,
    log: Array.isArray(data.log) ? data.log : logFromMessages(messages, data.updated || Date.now()),
    summary: data.summary && typeof data.summary.text === "string" && typeof data.summary.hash === "string" ? data.summary : undefined,
  };
}

function firstUserText(session: Session): string {
  // Lo que escribiste (por ejemplo «/review»), mejor que el mensaje ya expandido
  const logged = session.log.find((entry) => entry.role === "user");
  if (logged) {
    return logged.text;
  }
  const first = session.messages.find((m) => m.role === "user");
  if (!first) {
    return "";
  }
  if (typeof first.content === "string") {
    return first.content;
  }
  if (Array.isArray(first.content)) {
    const part = first.content.find((p: any) => p.type === "text") as any;
    return part?.text || "";
  }
  return "";
}

export function saveSession(session: Session) {
  if (session.messages.length === 0) {
    return;
  }
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  session.updated = Date.now();
  if (session.title === "(sin título)") {
    // Sin los ficheros adjuntos con @
    const text = firstUserText(session).split("\n\nFicheros adjuntos con @")[0];
    if (text) {
      session.title = text.replace(/\s+/g, " ").trim().slice(0, 60);
    }
  }
  // De golpe: si vipcode se cierra a mitad de guardar, la conversación de antes sigue entera
  writeFileAtomic(path.join(SESSIONS_DIR, `${session.id}.json`), JSON.stringify(session));
  // Y la conversación entera en Markdown, para leerla cuando quieras
  try {
    writeFileAtomic(sessionMarkdownPath(session), exportMarkdown(session));
  } catch {
    // no es grave: lo importante es el .json
  }
}

export function sessionMarkdownPath(session: Session): string {
  return path.join(SESSIONS_DIR, `${session.id}.md`);
}

export function listSessions(cwd?: string): Session[] {
  if (!fs.existsSync(SESSIONS_DIR)) {
    return [];
  }
  const sessions: Session[] = [];
  for (const file of fs.readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    try {
      const data = normalize(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8")));
      if (!cwd || data.cwd === cwd) {
        sessions.push(data);
      }
      // Las conversaciones de antes de que existiera el .md también lo tienen
      if (data.log.length > 0 && !fs.existsSync(sessionMarkdownPath(data))) {
        fs.writeFileSync(sessionMarkdownPath(data), exportMarkdown(data));
      }
    } catch {
      // sesión corrupta: la ignoramos
    }
  }
  sessions.sort((a, b) => b.updated - a.updated);
  return sessions;
}

export function loadSession(id: string): Session | null {
  try {
    return normalize(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${id}.json`), "utf8")));
  } catch {
    return null;
  }
}

export function deleteSession(id: string): boolean {
  const file = path.join(SESSIONS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) {
    return false;
  }
  fs.rmSync(file);
  fs.rmSync(path.join(SESSIONS_DIR, `${id}.md`), { force: true });
  return true;
}

// Un bloque de código que no se rompe aunque el texto lleve ```
function fence(text: string, lang = ""): string[] {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = "`".repeat(longest + 1);
  return [`${ticks}${lang}`, text, ticks];
}

// En español aunque el sistema no diga el idioma: 29/10/2026, 20:06:06
function when(time: number): string {
  return new Date(time).toLocaleString("es-ES");
}

// La conversación entera en Markdown (sale del historial, que no se resume nunca)
export function exportMarkdown(session: Session): string {
  const lines: string[] = [
    `# ${session.title}`,
    "",
    `- Carpeta: \`${session.cwd}\``,
    `- Empezada: ${when(session.created)} · Última actividad: ${when(session.updated)}`,
    `- Tokens: ${session.usage.prompt} de entrada, ${session.usage.completion} de salida`,
    "",
    "---",
    "",
  ];
  for (const entry of session.log) {
    if (entry.role === "user") {
      const images = entry.images ? ` · ${entry.images} imagen${entry.images > 1 ? "es" : ""}` : "";
      lines.push(`### Tú · ${when(entry.time)}${images}`, "", entry.text, "");
    } else if (entry.role === "assistant") {
      lines.push(`### vipcode${entry.model ? ` · ${entry.model}` : ""}`, "", entry.text, "");
    } else if (entry.role === "tool" && entry.tool) {
      const summary = entry.tool.summary ? ` \`${entry.tool.summary.replace(/`/g, "'")}\`` : "";
      lines.push(`- **${toolLabel(entry.tool.name)}**${summary}${entry.tool.isError ? " — ✗ falló" : ""}`);
      if (entry.tool.display) {
        lines.push("", ...fence(entry.tool.display, "diff"), "");
      } else if (entry.tool.isError || entry.tool.name === "bash") {
        const output = entry.text.split("\n").slice(0, 15).join("\n");
        if (output.trim() !== "") {
          lines.push("", ...fence(output), "");
        }
      }
    } else if (entry.role === "info") {
      lines.push("", `_${entry.text}_`, "");
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function saveExport(session: Session): string {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  const file = path.join(EXPORTS_DIR, `${session.id}.md`);
  fs.writeFileSync(file, exportMarkdown(session));
  return file;
}

// Historial de lo que escribes (flechas arriba/abajo), compartido entre sesiones
export function loadHistory(): string[] {
  try {
    return fs
      .readFileSync(HISTORY_PATH, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        try {
          return String(JSON.parse(line));
        } catch {
          return line;
        }
      })
      .slice(-500);
  } catch {
    return [];
  }
}

export function appendHistory(text: string) {
  if (text.trim() === "") {
    return;
  }
  try {
    ensureHomeDir();
    fs.appendFileSync(HISTORY_PATH, `${JSON.stringify(text)}\n`);
    // De vez en cuando lo recortamos para que no crezca sin fin
    const stat = fs.statSync(HISTORY_PATH);
    if (stat.size > 512 * 1024) {
      const lines = fs.readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean).slice(-1000);
      fs.writeFileSync(HISTORY_PATH, `${lines.join("\n")}\n`);
    }
  } catch {
    // no es grave
  }
}
