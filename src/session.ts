import fs from "node:fs";
import path from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { EXPORTS_DIR, HISTORY_PATH, HOME_DIR, SESSIONS_DIR } from "./paths.js";
import type { Todo } from "./tools.js";

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
  };
}

// Las sesiones de la versión anterior no tenían todos los campos
function normalize(data: Partial<Session>): Session {
  return {
    id: String(data.id),
    title: data.title || "(sin título)",
    cwd: data.cwd || "",
    created: data.created || data.updated || Date.now(),
    updated: data.updated || Date.now(),
    messages: Array.isArray(data.messages) ? data.messages : [],
    todos: Array.isArray(data.todos) ? data.todos : [],
    turns: Array.isArray(data.turns) ? data.turns : [],
    redo: Array.isArray(data.redo) ? data.redo : [],
    epoch: data.epoch || 0,
    usage: data.usage || { prompt: 0, completion: 0 },
    agent: data.agent,
  };
}

function firstUserText(session: Session): string {
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
  fs.writeFileSync(path.join(SESSIONS_DIR, `${session.id}.json`), JSON.stringify(session));
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
  return true;
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

// La conversación en Markdown, para guardarla o compartirla
export function exportMarkdown(session: Session): string {
  const lines: string[] = [
    `# ${session.title}`,
    "",
    `- Carpeta: \`${session.cwd}\``,
    `- Empezada: ${new Date(session.created).toLocaleString()}`,
    `- Última actividad: ${new Date(session.updated).toLocaleString()}`,
    `- Tokens: ${session.usage.prompt} de entrada, ${session.usage.completion} de salida`,
    "",
  ];
  for (const message of session.messages) {
    if (message.role === "system") {
      continue;
    }
    if (message.role === "user") {
      let text = contentText(message.content);
      const attached = text.indexOf("\n\nFicheros adjuntos con @");
      if (attached >= 0) {
        const names = [...text.slice(attached).matchAll(/<(?:fichero|carpeta) ruta="([^"]+)">/g)].map((match) => match[1]);
        text = `${text.slice(0, attached)}\n\n_Adjuntos: ${names.join(", ")}_`;
      }
      lines.push("## Tú", "", text, "");
    } else if (message.role === "assistant") {
      const text = contentText(message.content);
      lines.push("## vipcode", "");
      if (text.trim() !== "") {
        lines.push(text, "");
      }
      const calls = (message as any).tool_calls || [];
      for (const call of calls) {
        let args = call.function?.arguments || "";
        if (args.length > 600) {
          args = `${args.slice(0, 600)}…`;
        }
        lines.push(`> 🔧 **${call.function?.name}** \`${args.replace(/`/g, "'")}\``, "");
      }
    } else if (message.role === "tool") {
      let text = contentText(message.content);
      if (text.length > 2000) {
        text = `${text.slice(0, 2000)}\n[…]`;
      }
      lines.push("<details><summary>Resultado</summary>", "", "```", text.replace(/```/g, "'''"), "```", "", "</details>", "");
    }
  }
  return lines.join("\n");
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
    fs.mkdirSync(HOME_DIR, { recursive: true });
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
