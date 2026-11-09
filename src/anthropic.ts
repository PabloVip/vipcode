// Copyright (C) 2026 Pablo Vicente Juan
// SPDX-License-Identifier: AGPL-3.0-or-later
// La API propia de Anthropic (Claude). vipcode guarda la conversación en el formato de OpenAI, que es el que hablan casi
// todos los proveedores; aquí se traduce al de Anthropic y su respuesta se devuelve en el formato de siempre. Hablarle en
// su formato, y no por su capa compatible con OpenAI, permite la caché de prompts (repetir la conversación en cada paso
// cuesta mucho menos) y devolverle su razonamiento entre llamadas a herramientas
import Anthropic from "@anthropic-ai/sdk";
import type { ChatCompletionMessageParam, ChatCompletionMessageToolCall, ChatCompletionTool } from "openai/resources/chat/completions";
import type { ModelConfig } from "./config.js";

type Block = Record<string, any>;
interface ClaudeMessage {
  role: "user" | "assistant";
  content: Block[];
}

// Lo que vipcode guarda en el mensaje del asistente para devolvérselo tal cual a Claude en el siguiente paso (su
// razonamiento firmado va ahí). Los demás proveedores nunca lo ven: el router lo quita antes de mandarles nada
export const CLAUDE_CONTENT = "anthropic_content";

// Lo que se pide como máximo en cada respuesta: el razonamiento cuenta también. En streaming no hay problema de tiempo
const MAX_TOKENS = 64000;

// La raíz de la API: el SDK añade /v1/messages. Si en tu config pones la URL con /v1 (como en los de OpenAI), vale igual
export function claudeBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function claudeClient(apiKey: string, baseURL: string, headers: Record<string, string> = {}): Anthropic {
  return new Anthropic({
    apiKey,
    baseURL: claudeBaseURL(baseURL),
    defaultHeaders: headers,
    maxRetries: 0, // reintentar lo hace el router cambiando de modelo
    timeout: 180000,
  });
}

// Modelos con razonamiento adaptativo y nivel de esfuerzo (Claude 4.6 en adelante); a los anteriores no se les manda
function modern(id: string): boolean {
  return /^claude-(fable|mythos|opus|sonnet|haiku)-(\d{2,}|[5-9]|4-[6-9])\b/.test(id);
}

// Modelos que comprueban que la conversación anterior a su razonamiento no ha cambiado (Claude 5.x): vipcode resume las
// conversaciones largas y cambia de modelo, así que se le pide que descarte el razonamiento que ya no valga en vez de
// dar error
function bindsThinking(id: string): boolean {
  return /^claude-(fable|mythos|opus|sonnet|haiku)-(\d{2,}|[5-9])\b/.test(id);
}

// Modelos con relevo en el propio servidor si rechazan una petición por sus filtros de seguridad (lo pasa a otro Claude)
function hasFallbacks(id: string): boolean {
  return /^claude-(fable-5-1|opus-5|opus-5-5|sonnet-5-5)$/.test(id);
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("\n");
  }
  return "";
}

// Un bloque de texto vacío o solo con espacios es un error para la API
function textBlock(text: string): Block[] {
  return text.trim() ? [{ type: "text", text }] : [];
}

function imageBlock(url: string): Block | null {
  const data = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(url);
  if (data) {
    return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
  }
  if (/^https?:\/\//i.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }
  return null;
}

// Texto e imágenes de un mensaje del usuario o del resultado de una herramienta
function partsOf(content: unknown): Block[] {
  if (typeof content === "string") {
    return textBlock(content);
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: Block[] = [];
  for (const part of content as any[]) {
    if (part?.type === "text" && typeof part.text === "string") {
      blocks.push(...textBlock(part.text));
    } else if (part?.type === "image_url") {
      const image = imageBlock(String(part.image_url?.url || ""));
      if (image) {
        blocks.push(image);
      }
    }
  }
  return blocks;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
  } catch {
    // abajo
  }
  return { argumentos_no_validos: raw };
}

// El mensaje del asistente: lo que contestó Claude tal cual (con su razonamiento firmado) si sigue siendo el mismo, o
// rehecho a partir del texto y las llamadas a herramientas si vino de otro modelo o vipcode lo ha cambiado
function assistantBlocks(message: any): Block[] {
  const calls: ChatCompletionMessageToolCall[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const saved: unknown = message[CLAUDE_CONTENT];
  if (Array.isArray(saved) && saved.length > 0) {
    const savedIds = saved.filter((block: any) => block?.type === "tool_use").map((block: any) => block.id);
    const ids = calls.map((call) => call.id);
    if (savedIds.length === ids.length && savedIds.every((id, index) => id === ids[index])) {
      return saved as Block[];
    }
  }
  const blocks: Block[] = textBlock(typeof message.content === "string" ? message.content : textOf(message.content));
  for (const call of calls) {
    if (call.type === "function") {
      blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseArgs(call.function.arguments) });
    }
  }
  return blocks;
}

// La conversación de vipcode (formato de OpenAI) en el formato de Anthropic: el prompt de sistema aparte, los resultados de
// herramientas dentro de un mensaje del usuario justo detrás de la llamada, y siempre empezando y acabando por el usuario
export function toClaude(messages: ChatCompletionMessageParam[]): { system: string; messages: ClaudeMessage[] } {
  const system: string[] = [];
  const out: ClaudeMessage[] = [];
  let index = 0;
  while (index < messages.length && (messages[index].role === "system" || messages[index].role === "developer")) {
    system.push(textOf(messages[index].content));
    index++;
  }
  const push = (role: ClaudeMessage["role"], blocks: Block[]) => {
    if (blocks.length === 0) {
      return;
    }
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
    } else {
      out.push({ role, content: [...blocks] });
    }
  };
  for (; index < messages.length; index++) {
    const message: any = messages[index];
    if (message.role === "system" || message.role === "developer") {
      // Un aviso a mitad de conversación (nunca se cambia el prompt de sistema de arriba: invalidaría la caché)
      push("user", textBlock(`<aviso-del-sistema>\n${textOf(message.content)}\n</aviso-del-sistema>`));
    } else if (message.role === "user") {
      push("user", partsOf(message.content));
    } else if (message.role === "tool") {
      const parts = partsOf(message.content);
      push("user", [{ type: "tool_result", tool_use_id: String(message.tool_call_id || ""), content: parts.length > 0 ? parts : "(sin salida)" }]);
    } else if (message.role === "assistant") {
      push("assistant", assistantBlocks(message));
    }
  }
  return { system: system.filter((text) => text.trim()).join("\n\n"), messages: pairToolResults(out) };
}

// Cada llamada a una herramienta necesita su resultado en el mensaje siguiente, y un resultado sin su llamada es un error.
// Si la conversación se cortó a medias (cancelaste, se resumió), se apaña: sin resultado se dice que no lo hubo, y un
// resultado suelto pasa a ser texto
function pairToolResults(messages: ClaudeMessage[]): ClaudeMessage[] {
  const out: ClaudeMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "assistant") {
      out.push(message);
      const ids = message.content.filter((block) => block.type === "tool_use").map((block) => String(block.id));
      if (ids.length === 0) {
        continue;
      }
      const next = messages[index + 1];
      const following = next && next.role === "user" ? next.content : [];
      const results: Block[] = [];
      const rest: Block[] = [];
      for (const block of following) {
        if (block.type === "tool_result" && ids.includes(block.tool_use_id) && !results.some((one) => one.tool_use_id === block.tool_use_id)) {
          results.push(block);
        } else {
          rest.push(block);
        }
      }
      const answered = ids.map(
        (id) => results.find((block) => block.tool_use_id === id) || { type: "tool_result", tool_use_id: id, content: "(sin resultado: se interrumpió)", is_error: true },
      );
      // Los resultados van primero y el texto detrás
      out.push({ role: "user", content: [...answered, ...rest.map(looseResult)] });
      if (next && next.role === "user") {
        index++;
      }
    } else {
      const content = message.content.map(looseResult);
      const last = out[out.length - 1];
      if (last && last.role === "user") {
        last.content.push(...content);
      } else {
        out.push({ role: "user", content });
      }
    }
  }
  if (out.length === 0 || out[0].role !== "user") {
    out.unshift({ role: "user", content: [{ type: "text", text: "(continuación de una conversación anterior)" }] });
  }
  if (out[out.length - 1].role !== "user") {
    out.push({ role: "user", content: [{ type: "text", text: "Continúa." }] });
  }
  return out;
}

function looseResult(block: Block): Block {
  if (block.type !== "tool_result") {
    return block;
  }
  const text = typeof block.content === "string" ? block.content : textOf(block.content);
  return { type: "text", text: `Resultado de una herramienta:\n${text || "(sin salida)"}` };
}

export function toClaudeTools(tools: ChatCompletionTool[] = []): Block[] {
  return tools
    .filter((tool) => tool.type === "function")
    .map((tool: any) => {
      const schema = tool.function.parameters && typeof tool.function.parameters === "object" ? tool.function.parameters : {};
      return {
        name: tool.function.name,
        description: tool.function.description || "",
        input_schema: { ...schema, type: "object", properties: schema.properties || {} },
      };
    });
}

export interface ClaudeOptions {
  // Sin lo nuevo (betas, relevo, descartar razonamiento): si la API no lo acepta, se repite una vez así
  plain?: boolean;
}

// La petición para Claude. La caché va puesta sobre toda la conversación: en el paso siguiente solo se paga entera la parte
// nueva
export function claudeParams(model: ModelConfig, request: { messages: ChatCompletionMessageParam[]; tools?: ChatCompletionTool[] }, options: ClaudeOptions = {}) {
  const { system, messages } = toClaude(request.messages);
  const params: Record<string, any> = {
    model: model.id,
    max_tokens: MAX_TOKENS,
    messages,
    cache_control: { type: "ephemeral" },
  };
  if (system) {
    params.system = system;
  }
  const tools = toClaudeTools(request.tools);
  if (tools.length > 0) {
    params.tools = tools;
    params.tool_choice = { type: "auto" };
  }
  const betas: string[] = [];
  if (modern(model.id)) {
    // Resumen de lo que piensa, para enseñarlo mientras (sin él, parece que no hace nada hasta que contesta)
    params.thinking = { type: "adaptive", display: "summarized" };
    if (model.reasoningEffort) {
      params.output_config = { effort: model.reasoningEffort === "minimal" ? "low" : model.reasoningEffort };
    }
    if (!options.plain && bindsThinking(model.id)) {
      params.thinking.block_binding = { prefix_mismatch_behavior: "drop_block" };
      betas.push("thinking-binding-controls-2026-08-01");
    }
  }
  if (!options.plain && hasFallbacks(model.id)) {
    params.fallbacks = "default";
    betas.push("server-side-fallback-2026-07-01");
  }
  if (betas.length > 0) {
    params.betas = betas;
  }
  return params;
}

// Un error de la API por algo de lo nuevo que pide vipcode (una beta, el relevo): se repite sin ello
export function rejectsExtras(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError) || err.status !== 400) {
    return false;
  }
  return /beta|fallbacks|block_binding|prefix_mismatch|display|Extra inputs/i.test(`${err.message} ${JSON.stringify(err.error || "")}`);
}

export interface ClaudeReply {
  text: string;
  toolCalls: ChatCompletionMessageToolCall[];
  // Lo que contestó tal cual, con los ids de vipcode, para devolvérselo en el paso siguiente
  content: Block[];
  usage: { prompt: number; completion: number } | null;
}

// Una respuesta en streaming. «alive» se llama con cada evento (también los «ping» con los que la API dice que sigue ahí
// mientras prepara una llamada larga a una herramienta), y con true cuando ya contesta algo
export async function streamClaude(
  client: Anthropic,
  params: Record<string, any>,
  signal: AbortSignal,
  handlers: { onText: (text: string) => void; onReasoning?: (text: string) => void; alive: (answer: boolean) => void },
  newId: () => string,
): Promise<ClaudeReply> {
  const stream = client.beta.messages.stream(params as any, { signal });
  for await (const event of stream as AsyncIterable<any>) {
    if (event.type === "content_block_start") {
      handlers.alive(true);
    } else if (event.type === "content_block_delta") {
      handlers.alive(true);
      if (event.delta?.type === "text_delta" && event.delta.text) {
        handlers.onText(event.delta.text);
      } else if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
        handlers.onReasoning?.(event.delta.thinking);
      }
    } else {
      handlers.alive(false);
    }
  }
  const message: any = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error("Claude no ha querido contestar a esta petición (refusal)");
  }
  const blocks: Block[] = Array.isArray(message.content) ? message.content : [];
  if (message.stop_reason === "max_tokens" && blocks.some((block) => block.type === "tool_use")) {
    throw new Error("la respuesta se ha cortado por largo (max_tokens) a mitad de una llamada a una herramienta");
  }
  // Ids propios para que el historial funcione al cambiar de proveedor; en lo guardado van los mismos
  const content: Block[] = [];
  const toolCalls: ChatCompletionMessageToolCall[] = [];
  let text = "";
  for (const block of blocks) {
    if (block.type === "tool_use") {
      const id = newId();
      content.push({ ...block, id });
      toolCalls.push({ id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
    } else {
      if (block.type === "text" && typeof block.text === "string") {
        text += block.text;
      }
      content.push(block);
    }
  }
  const usage = message.usage
    ? {
        prompt: (message.usage.input_tokens || 0) + (message.usage.cache_read_input_tokens || 0) + (message.usage.cache_creation_input_tokens || 0),
        completion: message.usage.output_tokens || 0,
      }
    : null;
  return { text, toolCalls, content, usage };
}
