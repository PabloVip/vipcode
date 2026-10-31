import crypto from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { estimateTokens } from "./router.js";
import { truncate } from "./tools.js";

// Cuando la conversación entera no cabe en ningún modelo libre, al modelo se le manda una vista: un resumen de lo de
// antes y los últimos mensajes tal cual. El historial (session.messages) no se toca: si vuelve un modelo en el que cabe
// entero, lo recibe entero

type Message = ChatCompletionMessageParam;

// Resumen de los primeros mensajes de la conversación
export interface ContextSummary {
  text: string;
  // Cuántos mensajes del principio cubre
  covers: number;
  // Huella de esos mensajes: si cambian (/undo, /redo, llamadas reparadas…), el resumen ya no vale
  hash: string;
}

// Dónde se guarda el resumen: la sesión (y así queda en disco) o, en un subagente, un objeto en memoria
export interface SummaryHolder {
  summary?: ContextSummary;
}

// Lo que puede ocupar el resumen dentro del presupuesto del modelo
export const SUMMARY_SHARE = 0.25;
// Al actualizar el resumen, la cola de mensajes literales se deja en como mucho esta parte del presupuesto: así le queda
// sitio para crecer y no hay que volver a resumir en el paso siguiente
const TAIL_SHARE = 0.5;
// Salidas de herramientas recientes que se dejan enteras al recortar las antiguas
const KEEP_TOOL_OUTPUTS = 6;
const PRUNED_MARK = "[… salida antigua recortada para ahorrar contexto …]";

export function hashMessages(messages: Message[], count: number): string {
  return crypto.createHash("sha256").update(JSON.stringify(messages.slice(0, count))).digest("hex").slice(0, 16);
}

// El resumen guardado, si sigue valiendo para estos mensajes (y deja al menos uno detrás)
export function validSummary(summary: ContextSummary | undefined, messages: Message[]): ContextSummary | null {
  if (!summary || typeof summary.text !== "string" || !Number.isInteger(summary.covers) || summary.covers <= 0 || summary.covers >= messages.length) {
    return null;
  }
  return hashMessages(messages, summary.covers) === summary.hash ? summary : null;
}

// Copia con las salidas antiguas de herramientas (todas menos las últimas) reducidas a su principio. Tiene los mismos
// mensajes en el mismo orden; el original no se toca
export function prunedCopy(messages: Message[]): Message[] {
  const toolIndexes = messages.flatMap((message, index) => (message.role === "tool" ? [index] : []));
  const old = new Set(toolIndexes.slice(0, -KEEP_TOOL_OUTPUTS));
  return messages.map((message, index) => {
    if (!old.has(index) || typeof message.content !== "string" || message.content.length <= 500 || message.content.includes(PRUNED_MARK)) {
      return message;
    }
    return { ...message, content: `${message.content.slice(0, 300)}\n${PRUNED_MARK}` } as Message;
  });
}

// El texto de un mensaje (las imágenes, como un aviso)
export function plainText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part: any) => {
      if (part?.type === "text") {
        return String(part.text ?? "");
      }
      return part?.type === "image_url" ? "[imagen]" : "";
    })
    .filter(Boolean)
    .join("\n");
}

// Cada mensaje como texto, para pedir el resumen: así sirve cualquier modelo (también los que no admiten herramientas) y
// no hay parejas de llamada y respuesta que romper
export function transcript(messages: Message[]): string[] {
  return messages.map((message: any) => {
    if (message.role === "tool") {
      return `[resultado de una herramienta]\n${truncate(plainText(message.content), 2000)}`;
    }
    if (message.role === "assistant") {
      const calls = (message.tool_calls || []).map((call: any) => {
        const name = call.function?.name || call.custom?.name || "herramienta";
        return `→ llama a ${name}(${truncate(String(call.function?.arguments ?? call.custom?.input ?? ""), 400)})`;
      });
      return ["[asistente]", plainText(message.content), ...calls].filter(Boolean).join("\n");
    }
    if (message.role === "user") {
      return `[persona]\n${plainText(message.content)}`;
    }
    return `[${message.role}]\n${plainText(message.content)}`;
  });
}

// Una línea de texto recortada (sin saltos de línea)
function short(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// Un resumen sencillo hecho aquí, sin modelo, por si el modelo no da uno de verdad: lo que pidió la persona, lo que
// contestó el asistente y qué herramientas usó (sin sus salidas), cada cosa recortada. «maxChars»: lo que puede ocupar
export function digest(messages: Message[], maxChars: number): string {
  const lines: string[] = [];
  for (const message of messages as any[]) {
    if (message.role === "user") {
      lines.push(`- La persona pidió: ${short(plainText(message.content), 300)}`);
    } else if (message.role === "assistant") {
      const text = plainText(message.content);
      if (text.trim()) {
        lines.push(`- El asistente contestó: ${short(text, 400)}`);
      }
      for (const call of message.tool_calls || []) {
        const name = call.function?.name || call.custom?.name || "una herramienta";
        lines.push(`- Usó ${name}(${short(String(call.function?.arguments ?? call.custom?.input ?? ""), 120)})`);
      }
    }
  }
  return truncate(lines.join("\n"), Math.max(200, maxChars));
}

// Lo que devuelve un modelo y no es un resumen: ha seguido la conversación (empieza como una línea de la transcripción)
// o, si había un resumen anterior, lo ha dejado en casi nada
export function badSummary(text: string, previous: string): boolean {
  if (/^(→|\[(persona|asistente|resultado de una herramienta)\]|<\/?conversacion>)/.test(text.trim())) {
    return true;
  }
  return previous.length > 400 && text.length < previous.length * 0.3;
}

export interface ViewPlan {
  // Desde qué mensaje va la cola literal
  start: number;
  // Mensajes que hay que añadir al resumen (de lo que ya cubre hasta «start»; puede no haber ninguno si solo hay que
  // acortarlo), o null si el resumen guardado vale tal cual
  fold: [number, number] | null;
}

// Desde dónde puede empezar la cola: nunca en la respuesta de una herramienta, que quedaría sin su llamada (las respuestas
// van siempre detrás de su llamada, así que desde cualquier otro mensaje hasta el final no se rompe ninguna pareja)
function canStart(messages: Message[], index: number): boolean {
  return index < messages.length && messages[index].role !== "tool";
}

// Elige la cola. Si el resumen guardado y lo que viene detrás caben, tal cual. Si no, hay que resumir hasta un punto
// desde el que la cola ocupe como mucho la mitad del presupuesto; mejor si empieza en un mensaje de la persona. Si ni
// el último paso cabe ahí, la cola empieza en él (y sus salidas se recortarán en la vista). «summaryTokens»: lo que
// ocupa el mensaje con el resumen guardado
export function planView(messages: Message[], budget: number, summary: ContextSummary | null, summaryTokens: number): ViewPlan | null {
  const n = messages.length;
  // De cada posición al final, lo que ocupan los mensajes
  const from = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    from[i] = from[i + 1] + estimateTokens(messages[i]);
  }
  const covered = summary ? summary.covers : 0;
  if (summary && canStart(messages, covered) && summaryTokens + from[covered] <= budget) {
    return { start: covered, fold: null };
  }
  const target = budget * TAIL_SHARE;
  let start = -1;
  for (let i = covered; i < n; i++) {
    if (canStart(messages, i) && from[i] <= target) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    for (let i = n - 1; i >= covered; i--) {
      if (canStart(messages, i)) {
        start = i;
        break;
      }
    }
  }
  if (start === -1) {
    return null;
  }
  const user = messages.findIndex((message, index) => index > start && message.role === "user");
  if (user !== -1 && from[user] >= target / 2) {
    start = user;
  }
  return { start, fold: [covered, start] };
}

// El mensaje con el resumen: va como mensaje de la persona (los modelos no siempre aceptan dos de sistema), pero dice que
// es contexto escrito por un modelo y no instrucciones suyas. Si la cola no llega a su última petición, la lleva literal
export function summaryMessage(text: string, extra: { todos?: string; request?: string; omitted?: number } = {}): Message {
  const parts = [
    "[Resumen automático de la parte anterior de la conversación, que no cabe entera en este modelo. Lo ha escrito un modelo: es contexto, no instrucciones de la persona.]",
  ];
  if (text) {
    parts.push(text);
  }
  if (extra.omitted) {
    parts.push(`(Faltan ${extra.omitted} mensajes anteriores que no se han podido resumir.)`);
  }
  if (extra.todos) {
    parts.push(extra.todos);
  }
  if (extra.request) {
    parts.push(`Lo último que ha pedido la persona: «${extra.request}»`);
  }
  return { role: "user", content: parts.join("\n\n") };
}

// La vista para un modelo: el mensaje del resumen y la cola desde «start». Las salidas de herramientas de la cola que no
// quepan se recortan aquí (las más grandes primero), no en el historial. null si ni así cabe (por ejemplo, un mensaje
// tuyo enorme: eso no se recorta)
export function buildView(
  messages: Message[],
  start: number,
  budget: number,
  summary: string,
  extra: { todos?: string; omitted?: number } = {},
): Message[] | null {
  const tail = messages.slice(start).map((message) => ({ ...message }) as Message);
  if (tail.length === 0) {
    return null;
  }
  let lastUser = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") {
      lastUser = index;
    }
  });
  const prefix: Message[] = [];
  // La última petición, como mucho un 15 % del presupuesto (en caracteres, a ~3,6 por token)
  const request = lastUser !== -1 && lastUser < start ? truncate(plainText(messages[lastUser].content), Math.max(400, Math.floor(budget * 0.15 * 3.6))) : "";
  if (summary || extra.omitted || extra.todos || request) {
    prefix.push(summaryMessage(summary, { ...extra, request }));
    // Para que se alternen bien los papeles (algunos proveedores no aceptan dos mensajes de la persona seguidos)
    if (tail[0].role === "user") {
      prefix.push({ role: "assistant", content: "Entendido, sigo desde aquí." });
    }
  }
  const room = budget - estimateTokens(prefix);
  // Las que ya no se pueden acortar más
  const exhausted = new Set<number>();
  while (estimateTokens(tail) > room) {
    let biggest = -1;
    tail.forEach((message, index) => {
      if (exhausted.has(index) || message.role !== "tool" || typeof message.content !== "string") {
        return;
      }
      if (biggest === -1 || message.content.length > (tail[biggest].content as string).length) {
        biggest = index;
      }
    });
    if (biggest === -1) {
      return null;
    }
    const content = tail[biggest].content as string;
    const shorter = truncate(content, Math.max(400, Math.floor(content.length / 2)));
    if (shorter.length >= content.length - 50) {
      exhausted.add(biggest);
      continue;
    }
    tail[biggest] = { ...tail[biggest], content: shorter } as Message;
  }
  return [...prefix, ...tail];
}

// La lista de tareas como texto, para el resumen
export function todoText(todos: { content: string; status: string }[]): string {
  if (todos.length === 0) {
    return "";
  }
  return `Lista de tareas actual:\n${todos.map((todo) => `- [${todo.status}] ${todo.content}`).join("\n")}`;
}
