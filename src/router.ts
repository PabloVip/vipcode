import fs from "node:fs";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { readAuth, resolveCredentials } from "./auth.js";
import type { Config, ModelConfig, ProviderConfig } from "./config.js";
import { debugLog } from "./debug.js";
import { wildcardMatch } from "./match.js";
import { STATE_PATH } from "./paths.js";
import type { Ranking } from "./ranking.js";

// Una combinación proveedor + modelo
export interface Slot {
  key: string; // "proveedor/modelo"
  provider: ProviderConfig;
  model: ModelConfig;
  client: OpenAI;
  // Nota de 0 a 100 según LLM Stats (null si no hay datos) y el modelo de LLM Stats con el que se ha emparejado
  score: number | null;
  ratedAs: string | null;
  // Proveedor de internet usado sin clave
  anonymous: boolean;
}

export interface ChatRequest {
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  temperature?: number;
  // Modelo o patrón preferido para esta petición (por ejemplo el del agente)
  prefer?: string;
}

export interface ChatHandlers {
  onText?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onNotice?: (text: string) => void;
  // Justo antes de preguntar a cada modelo
  onAttempt?: (slot: string) => void;
}

export interface Usage {
  prompt: number;
  completion: number;
}

export interface ChatResult {
  message: { role: "assistant"; content: string | null; tool_calls?: ChatCompletionMessageToolCall[] };
  slot: Slot;
  // Tokens que dice el proveedor (null si no lo dice)
  usage: Usage | null;
}

type ErrorKind = "rate" | "daily" | "context" | "unsupported" | "auth" | "server" | "params" | "other";

interface Classified {
  kind: ErrorKind;
  retryAfterMs: number;
  detail: string;
}

export interface SlotRow {
  key: string;
  label: string;
  status: string;
  available: boolean;
  context: number;
  vision: boolean;
  score: number | null;
}

export class NoSlotError extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;
// Si el proveedor no manda nada en este tiempo, cortamos y probamos otro
const IDLE_MS = 120000;

// Estimación rápida de tokens (unos 3,6 caracteres por token; cada imagen cuenta como ~1.200)
export function estimateTokens(value: unknown): number {
  let chars = 0;
  let images = 0;
  const walk = (item: unknown) => {
    if (typeof item === "string") {
      if (item.startsWith("data:image/")) {
        images++;
      } else {
        chars += item.length;
      }
    } else if (Array.isArray(item)) {
      for (const child of item) {
        walk(child);
      }
    } else if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        chars += key.length + 3;
        walk(child);
      }
    } else if (item !== undefined && item !== null) {
      chars += String(item).length;
    }
  };
  walk(value);
  return Math.ceil(chars / 3.6) + images * 1200;
}

export function hasImages(messages: ChatCompletionMessageParam[]): boolean {
  return messages.some((message) => Array.isArray(message.content) && message.content.some((part: any) => part?.type === "image_url"));
}

// Cambia las imágenes por un aviso de texto para los modelos que no ven
export function stripImages(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) {
      return message;
    }
    const parts = message.content.map((part: any) => {
      if (part?.type === "image_url") {
        return { type: "text", text: "[imagen omitida: este modelo no acepta imágenes]" };
      }
      return part;
    });
    return { ...message, content: parts } as ChatCompletionMessageParam;
  });
}

// Id corto y alfanumérico: Mistral exige 9 caracteres y el resto acepta cualquier cosa
function shortId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 9; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function nextUtcMidnight(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 1);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    }
  });
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal && signal.aborted) {
    return true;
  }
  const name = (err as Error)?.name || "";
  return name === "AbortError" || name === "APIUserAbortError";
}

// "1m25.5s", "7.66s", "2h3m" → milisegundos
function parseDuration(text: string): number {
  let ms = 0;
  const hours = /(\d+(?:\.\d+)?)h/.exec(text);
  const minutes = /(\d+(?:\.\d+)?)m(?!s)/.exec(text);
  const seconds = /(\d+(?:\.\d+)?)s/.exec(text);
  if (hours) {
    ms += Number(hours[1]) * 3600000;
  }
  if (minutes) {
    ms += Number(minutes[1]) * 60000;
  }
  if (seconds) {
    ms += Number(seconds[1]) * 1000;
  }
  return Math.ceil(ms);
}

function retryFromHeaders(headers: unknown): number {
  const h = headers as Headers | undefined;
  if (!h || typeof h.get !== "function") {
    return 0;
  }
  const ms = h.get("retry-after-ms");
  if (ms && !Number.isNaN(Number(ms))) {
    return Number(ms);
  }
  const retryAfter = h.get("retry-after");
  if (retryAfter) {
    if (!Number.isNaN(Number(retryAfter))) {
      return Number(retryAfter) * 1000;
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now());
    }
  }
  return 0;
}

// Gemini manda "retryDelay": "41s" y Groq "Please try again in 1m25.5s"
function retryFromMessage(message: string): number {
  const delay = /retry_?delay["'\s:=]+["']?(\d+(?:\.\d+)?s)/i.exec(message);
  if (delay) {
    return parseDuration(delay[1]);
  }
  const again = /try again in\s+((?:\d+(?:\.\d+)?h)?(?:\d+(?:\.\d+)?m(?!s))?(?:\d+(?:\.\d+)?s)?)/i.exec(message);
  if (again && again[1]) {
    return parseDuration(again[1]);
  }
  return 0;
}

// Decide qué hacer con un error del proveedor
function classify(err: unknown): Classified {
  let message = String((err as Error)?.message || err);
  let status = 0;
  let retryAfterMs = 0;

  if (err instanceof OpenAI.APIConnectionError) {
    return { kind: "server", retryAfterMs: 30000, detail: "sin conexión" };
  }
  if (err instanceof OpenAI.APIError) {
    status = err.status || 0;
    retryAfterMs = retryFromHeaders(err.headers);
    if (err.error) {
      message += ` ${JSON.stringify(err.error)}`;
    }
  }
  if (!retryAfterMs) {
    retryAfterMs = retryFromMessage(message);
  }

  const lower = message.toLowerCase();
  const compact = lower.replace(/\s+/g, "");

  if (status >= 400 && status < 500 && /stream_options|include_usage/.test(lower)) {
    return { kind: "params", retryAfterMs: 0, detail: "no acepta stream_options" };
  }
  if (
    status === 401 ||
    /api key not valid|invalid api key|incorrect api key|invalid_api_key|api_key_invalid|invalid authentication|authentication failed|missing or invalid api key/.test(lower)
  ) {
    return { kind: "auth", retryAfterMs: 0, detail: "clave inválida o sin permiso" };
  }
  if (status === 403) {
    if (/model|region|not available|access to/.test(lower)) {
      return { kind: "unsupported", retryAfterMs: DAY_MS, detail: "sin acceso a este modelo" };
    }
    return { kind: "auth", retryAfterMs: 0, detail: "clave inválida o sin permiso" };
  }
  if (status === 402 || /insufficient (credits|balance|quota)|credit balance|payment required/.test(lower)) {
    return { kind: "daily", retryAfterMs, detail: "sin créditos" };
  }
  if (status === 429 || /rate.?limit|too many requests|quota exceeded|resource_exhausted|resource exhausted/.test(lower)) {
    if (/limit:\s*0\b|"limit":\s*0\b|limit 0\b/.test(lower)) {
      return { kind: "unsupported", retryAfterMs: 7 * DAY_MS, detail: "no incluido en el plan gratis" };
    }
    if (/per.?day|daily|rpd|tpd|requestsperday|tokensperday|free-models-per-day/.test(compact)) {
      return { kind: "daily", retryAfterMs, detail: "límite diario agotado" };
    }
    if (/per.?month|monthly/.test(compact)) {
      return { kind: "daily", retryAfterMs: retryAfterMs || DAY_MS, detail: "límite mensual agotado" };
    }
    return { kind: "rate", retryAfterMs, detail: "límite por minuto" };
  }
  if (
    status === 413 ||
    /context.?length|context window|maximum context|too long|too large|reduce the length|max_tokens|prompt is too long|request too large|input is too long|exceeds the (maximum|limit)/.test(lower)
  ) {
    return { kind: "context", retryAfterMs: 0, detail: "conversación demasiado larga para este modelo" };
  }
  if (
    status === 404 ||
    /model.{0,40}(not found|does not exist|not exist|no longer|decommissioned|deprecated|unknown|invalid|not available|not supported)|no endpoints found|unknown model|invalid model|model_not_found|does not support (tools|tool|function)|tools? (use |calling )?(is |are )?not supported|function calling is not|tool_choice.{0,30}not supported/.test(lower)
  ) {
    return { kind: "unsupported", retryAfterMs: DAY_MS, detail: "modelo no disponible o sin soporte de herramientas" };
  }
  if (status >= 500 || /overloaded|unavailable|timeout|timed out|econnreset|socket hang up|bad gateway|dejó de responder/.test(lower)) {
    return { kind: "server", retryAfterMs: 30000, detail: status ? `error del servidor (${status})` : "el servidor no responde" };
  }
  if (/respuesta vacía/.test(lower)) {
    return { kind: "other", retryAfterMs: 0, detail: "respuesta vacía" };
  }
  return { kind: "other", retryAfterMs: 0, detail: `${status || ""} ${message.slice(0, 160)}`.trim() };
}

// Cada proveedor quiere el historial un poco distinto
function prepareMessages(slot: Slot, messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const gemini = slot.provider.baseURL.includes("generativelanguage.googleapis.com");
  return messages.map((message: any) => {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      return message;
    }
    const toolCalls = message.tool_calls.map((call: any) => {
      const { extra_content, ...rest } = call;
      if (!gemini) {
        return rest;
      }
      // Gemini 3 exige la "firma de pensamiento" en cada llamada; si vino de otro modelo, usamos la de comodín
      const signature = extra_content?.google?.thought_signature || "skip_thought_signature_validator";
      return { ...rest, extra_content: { google: { thought_signature: signature } } };
    });
    return { ...message, tool_calls: toolCalls };
  });
}

interface RouterState {
  cooldowns: Record<string, number>;
  // Modelos que no existen o no sirven: hasta cuándo no se vuelven a probar
  unsupported: Record<string, number>;
  // Proveedores que rechazan stream_options
  noStreamUsage: Record<string, boolean>;
}

export class Router {
  slots: Slot[] = [];
  // Hasta cuándo está en pausa cada slot (se guarda en disco para recordar límites diarios)
  cooldowns: Record<string, number> = {};
  unsupported: Record<string, number> = {};
  noStreamUsage: Record<string, boolean> = {};
  // Slots descartados durante esta ejecución (clave mala…)
  skipped = new Set<string>();
  // Si no es null, se usa ese slot primero
  pinned: string | null = null;
  lastSlot: Slot | null = null;

  constructor(
    private config: Config,
    providers: ProviderConfig[],
    // Puntuaciones de LLM Stats para ordenar de mejor a peor (null = orden del catálogo)
    private ranking: Ranking | null = null,
  ) {
    this.loadState();
    this.reload(providers);
  }

  setRanking(ranking: Ranking | null, providers: ProviderConfig[]) {
    this.ranking = ranking;
    this.reload(providers);
  }

  // Rehace la lista de slots (al arrancar, al descubrir modelos o al añadir una clave)
  reload(providers: ProviderConfig[]) {
    const auth = readAuth();
    const slots: Slot[] = [];
    for (const provider of providers) {
      if (provider.enabled === false || provider.models.length === 0) {
        continue;
      }
      const credentials = resolveCredentials(provider, auth);
      if (!credentials) {
        continue;
      }
      const headers: Record<string, string | null> = { ...(provider.headers || {}) };
      if (credentials.apiKey === "no-key") {
        // Sin clave no se manda la cabecera: Kilo y OVHcloud rechazan un token inventado
        headers.Authorization = null;
      }
      const client = new OpenAI({
        apiKey: credentials.apiKey,
        baseURL: credentials.baseURL,
        defaultHeaders: headers,
        maxRetries: 0, // reintentar lo hacemos nosotros cambiando de proveedor
        timeout: 180000,
      });
      const anonymous = credentials.apiKey === "no-key" && !provider.local;
      for (const model of provider.models) {
        const rated = this.ranking ? this.ranking.score(model.id) : null;
        slots.push({
          key: `${provider.name}/${model.id}`,
          provider,
          model,
          client,
          score: rated ? rated.score : null,
          ratedAs: rated ? rated.model.id : null,
          anonymous,
        });
      }
    }
    this.slots = this.sortSlots(slots);
  }

  // Orden de la rotación: primero los patrones de "order" del config; después tus proveedores propios
  // y luego todos los demás, de mejor a peor según LLM Stats (con "anonymousLast", los anónimos al final)
  private sortSlots(slots: Slot[]): Slot[] {
    const patterns = this.config.order || [];
    const byScore = Boolean(this.ranking) && this.config.ranking?.enabled !== false;
    const anonymousLast = this.config.ranking?.anonymousLast === true;
    const patternRank = (slot: Slot) => {
      const index = patterns.findIndex((pattern) => wildcardMatch(pattern, slot.key) || pattern === slot.provider.name);
      if (index < 0) {
        return patterns.length;
      }
      return index;
    };
    const group = (slot: Slot) => {
      if (slot.provider.custom) {
        return 0;
      }
      if (anonymousLast && slot.anonymous) {
        return 2;
      }
      return 1;
    };
    // Los que no tienen nota van detrás de los que sí, en el orden del catálogo
    const quality = (slot: Slot) => {
      if (!byScore || slot.score === null) {
        return -1;
      }
      return slot.score;
    };
    return slots
      .map((slot, index) => ({ slot, index }))
      .sort(
        (a, b) =>
          patternRank(a.slot) - patternRank(b.slot) ||
          group(a.slot) - group(b.slot) ||
          quality(b.slot) - quality(a.slot) ||
          a.index - b.index,
      )
      .map((entry) => entry.slot);
  }

  private loadState() {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as Partial<RouterState>;
      this.cooldowns = data.cooldowns || {};
      this.unsupported = data.unsupported || {};
      this.noStreamUsage = data.noStreamUsage || {};
    } catch {
      this.cooldowns = {};
      this.unsupported = {};
      this.noStreamUsage = {};
    }
  }

  private saveState() {
    const now = Date.now();
    // Quitamos las pausas que ya han pasado para que el fichero no crezca
    for (const table of [this.cooldowns, this.unsupported]) {
      for (const [key, until] of Object.entries(table)) {
        if (until < now) {
          delete table[key];
        }
      }
    }
    try {
      const state: RouterState = { cooldowns: this.cooldowns, unsupported: this.unsupported, noStreamUsage: this.noStreamUsage };
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    } catch {
      // no es grave si no se puede guardar
    }
  }

  private setCooldown(slots: Slot[], until: number) {
    for (const slot of slots) {
      this.cooldowns[slot.key] = until;
    }
    this.saveState();
  }

  slotFor(key: string): Slot | undefined {
    return this.slots.find((slot) => slot.key === key);
  }

  // Estado legible de cada slot para /models
  describe(): SlotRow[] {
    const now = Date.now();
    return this.slots.map((slot) => {
      let status = "disponible";
      let available = true;
      const until = this.cooldowns[slot.key] || 0;
      const unsupportedUntil = this.unsupported[slot.key] || 0;
      if (this.skipped.has(slot.key)) {
        status = "descartado (clave inválida)";
        available = false;
      } else if (unsupportedUntil > now) {
        status = `no disponible hasta ${new Date(unsupportedUntil).toLocaleDateString()}`;
        available = false;
      } else if (until > now) {
        status = `en pausa hasta ${new Date(until).toLocaleTimeString()}`;
        available = false;
      }
      if (this.pinned === slot.key) {
        status += " (fijado)";
      }
      return {
        key: slot.key,
        label: slot.provider.label || slot.provider.name,
        status,
        available,
        context: slot.model.context,
        vision: Boolean(slot.model.vision),
        score: slot.score,
      };
    });
  }

  availableCount(): number {
    return this.describe().filter((row) => row.available).length;
  }

  resetCooldowns() {
    this.cooldowns = {};
    this.unsupported = {};
    this.skipped.clear();
    this.saveState();
  }

  // Slots utilizables ahora mismo para una petición de este tamaño
  private candidates(estTokens: number, excluded: Set<string>, needsVision: boolean, needsTools: boolean, prefer?: string): Slot[] {
    const now = Date.now();
    let list = this.slots.filter((slot) => {
      if (this.skipped.has(slot.key) || excluded.has(slot.key)) {
        return false;
      }
      if ((this.unsupported[slot.key] || 0) > now || (this.cooldowns[slot.key] || 0) > now) {
        return false;
      }
      if (needsVision && !slot.model.vision) {
        return false;
      }
      if (needsTools && slot.model.tools === false) {
        return false;
      }
      return slot.model.context >= estTokens;
    });
    // El fijado con /model va el primero; detrás, el preferido del agente
    for (const pattern of [prefer, this.pinned]) {
      if (!pattern) {
        continue;
      }
      const matching = list.filter((slot) => slot.key === pattern || wildcardMatch(pattern, slot.key));
      if (matching.length > 0) {
        list = [...matching, ...list.filter((slot) => !matching.includes(slot))];
      }
    }
    return list;
  }

  // Cuánto falta para que vuelva el primer slot que cabe en la petición
  private soonestReturn(estTokens: number, excluded: Set<string>, needsVision: boolean, needsTools: boolean): number {
    const now = Date.now();
    let soonest = Infinity;
    for (const slot of this.slots) {
      if (this.skipped.has(slot.key) || excluded.has(slot.key) || slot.model.context < estTokens) {
        continue;
      }
      if ((needsVision && !slot.model.vision) || (needsTools && slot.model.tools === false)) {
        continue;
      }
      if ((this.unsupported[slot.key] || 0) > now) {
        continue;
      }
      const wait = (this.cooldowns[slot.key] || 0) - now;
      if (wait < soonest) {
        soonest = wait;
      }
    }
    return soonest;
  }

  maxContext(): number {
    let max = 0;
    const now = Date.now();
    for (const slot of this.slots) {
      if (!this.skipped.has(slot.key) && (this.unsupported[slot.key] || 0) <= now && slot.model.context > max) {
        max = slot.model.context;
      }
    }
    return max;
  }

  async chat(request: ChatRequest, signal: AbortSignal | undefined, handlers: ChatHandlers = {}): Promise<ChatResult> {
    if (this.slots.length === 0) {
      throw new NoSlotError("No hay ningún proveedor configurado. Añade una clave con «vipcode auth login» o exporta, por ejemplo, GEMINI_API_KEY.");
    }

    let messages = request.messages;
    const needsTools = Boolean(request.tools && request.tools.length > 0);
    let needsVision = hasImages(messages);
    if (needsVision && !this.slots.some((slot) => slot.model.vision && !this.skipped.has(slot.key))) {
      messages = stripImages(messages);
      needsVision = false;
      handlers.onNotice?.("Ningún modelo configurado acepta imágenes; las envío sin ellas.");
    }

    let estTokens = estimateTokens(messages) + estimateTokens(request.tools || []);
    // Slots que han fallado en esta petición por motivos no permanentes (contexto, error raro)
    const excluded = new Set<string>();

    while (true) {
      const list = this.candidates(estTokens, excluded, needsVision, needsTools, request.prefer);

      if (list.length === 0) {
        const wait = this.soonestReturn(estTokens, excluded, needsVision, needsTools);
        if (wait > 0 && wait <= this.config.maxWaitMs) {
          handlers.onNotice?.(`Todos los proveedores están en pausa; espero ${Math.ceil(wait / 1000)} s…`);
          await sleep(wait + 500, signal);
          continue;
        }
        if (needsVision) {
          // Los que ven imágenes están agotados: seguimos con el resto sin las imágenes
          messages = stripImages(messages);
          needsVision = false;
          estTokens = estimateTokens(messages) + estimateTokens(request.tools || []);
          handlers.onNotice?.("Los modelos que aceptan imágenes no están disponibles; sigo sin las imágenes.");
          continue;
        }
        let reason = "Todos los proveedores están agotados o en pausa.";
        if (wait === Infinity) {
          reason = `Ningún modelo disponible admite una conversación de ~${estTokens} tokens. Usa /compact o /new.`;
        } else if (wait > 0) {
          reason += ` El primero vuelve a las ${new Date(Date.now() + wait).toLocaleTimeString()}.`;
        }
        throw new NoSlotError(reason);
      }

      const slot = list[0];
      let streamedText = false;
      handlers.onAttempt?.(slot.key);

      try {
        const result = await this.streamOnce(slot, { ...request, messages }, signal, {
          onText: (text) => {
            streamedText = true;
            handlers.onText?.(text);
          },
          onReasoning: handlers.onReasoning,
        });
        if (this.lastSlot && this.lastSlot.key !== slot.key) {
          handlers.onNotice?.(`usando ${slot.key}`);
        }
        this.lastSlot = slot;
        return { ...result, slot };
      } catch (err) {
        if (isAbort(err, signal)) {
          throw err;
        }
        const info = classify(err);
        debugLog("error", slot.key, info.kind, String((err as Error)?.message || err));
        const now = Date.now();
        // Si el límite es de toda la cuenta, se pausan todos los modelos del proveedor
        let scope = [slot];
        if (slot.provider.limitScope === "provider") {
          scope = this.slots.filter((other) => other.provider === slot.provider);
        }
        let action = "";

        if (info.kind === "params") {
          // Reintentamos el mismo modelo sin stream_options
          this.noStreamUsage[slot.provider.name] = true;
          this.saveState();
          continue;
        } else if (info.kind === "rate") {
          let ms = info.retryAfterMs;
          if (ms <= 0) {
            ms = 60000;
          }
          this.setCooldown(scope, now + ms);
          action = `pausa ${Math.ceil(ms / 1000)} s`;
        } else if (info.kind === "daily") {
          let until = nextUtcMidnight();
          if (info.retryAfterMs > 0) {
            until = now + info.retryAfterMs;
          }
          this.setCooldown(scope, until);
          action = `pausa hasta ${new Date(until).toLocaleString()}`;
        } else if (info.kind === "server") {
          this.setCooldown([slot], now + info.retryAfterMs);
          action = "pausa 30 s";
        } else if (info.kind === "auth") {
          // Si la clave falla, fallan todos los modelos de ese proveedor
          for (const other of this.slots) {
            if (other.provider === slot.provider) {
              this.skipped.add(other.key);
            }
          }
          action = "proveedor descartado";
        } else if (info.kind === "unsupported") {
          this.unsupported[slot.key] = now + (info.retryAfterMs || DAY_MS);
          this.saveState();
          action = "modelo descartado";
        } else {
          excluded.add(slot.key);
          action = "pruebo otro";
        }

        let prefix = "";
        if (streamedText) {
          prefix = "\n";
        }
        handlers.onNotice?.(`${prefix}${slot.key}: ${info.detail} → ${action}`);
      }
    }
  }

  // Una sola llamada en streaming; junta el texto y las llamadas a herramientas
  private async streamOnce(
    slot: Slot,
    request: ChatRequest,
    signal: AbortSignal | undefined,
    handlers: { onText: (text: string) => void; onReasoning?: (text: string) => void },
  ): Promise<{ message: ChatResult["message"]; usage: Usage | null }> {
    const params: Record<string, unknown> = {
      model: slot.model.id,
      messages: prepareMessages(slot, request.messages),
      stream: true,
    };
    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools;
      params.tool_choice = "auto";
    }
    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }
    if (slot.provider.streamUsage !== false && !this.noStreamUsage[slot.provider.name]) {
      params.stream_options = { include_usage: true };
    }

    // Si el proveedor deja de mandar datos mucho rato, cortamos para probar otro
    const idle = new AbortController();
    let combined: AbortSignal = idle.signal;
    if (signal) {
      combined = AbortSignal.any([signal, idle.signal]);
    }
    let idleTimer = setTimeout(() => idle.abort(), IDLE_MS);
    const bump = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(), IDLE_MS);
    };

    let content = "";
    let usage: Usage | null = null;
    interface PartialCall {
      id: string;
      name: string;
      args: string;
      extra?: unknown;
    }
    const calls: PartialCall[] = [];
    const byIndex = new Map<number, PartialCall>();
    const byId = new Map<string, PartialCall>();

    try {
      const stream = (await slot.client.chat.completions.create(params as any, { signal: combined })) as unknown as AsyncIterable<any>;

      for await (const chunk of stream) {
        bump();
        // Algunos proveedores mandan el error dentro del stream
        if (chunk && chunk.error) {
          const apiError = new Error(chunk.error.message || JSON.stringify(chunk.error) || "error en el stream");
          throw apiError;
        }
        const reported = chunk?.usage || chunk?.x_groq?.usage;
        if (reported && typeof reported.prompt_tokens === "number") {
          usage = { prompt: reported.prompt_tokens || 0, completion: reported.completion_tokens || 0 };
        }
        const choice = chunk?.choices?.[0];
        if (!choice || !choice.delta) {
          continue;
        }
        const delta = choice.delta;

        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === "string" && reasoning.length > 0) {
          handlers.onReasoning?.(reasoning);
        }

        if (typeof delta.content === "string" && delta.content.length > 0) {
          content += delta.content;
          handlers.onText(delta.content);
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            let entry: PartialCall | undefined;
            if (typeof tc.index === "number") {
              entry = byIndex.get(tc.index);
            } else if (tc.id) {
              entry = byId.get(tc.id);
            } else {
              entry = calls[calls.length - 1];
            }
            if (!entry) {
              entry = { id: "", name: "", args: "" };
              calls.push(entry);
              if (typeof tc.index === "number") {
                byIndex.set(tc.index, entry);
              }
            }
            if (tc.id && !entry.id) {
              entry.id = tc.id;
              byId.set(tc.id, entry);
            }
            if (tc.function?.name && !entry.name) {
              entry.name = tc.function.name;
            }
            if (tc.function?.arguments) {
              entry.args += tc.function.arguments;
            }
            if (tc.extra_content) {
              entry.extra = tc.extra_content;
            }
          }
        }
      }
    } catch (err) {
      if (idle.signal.aborted && !signal?.aborted) {
        throw new Error("el proveedor dejó de responder (timeout)");
      }
      throw err;
    } finally {
      clearTimeout(idleTimer);
    }

    const toolCalls: ChatCompletionMessageToolCall[] = [];
    for (const call of calls) {
      if (!call.name) {
        continue;
      }
      let args = call.args;
      if (args.trim() === "") {
        args = "{}";
      }
      // Usamos ids propios para que el historial funcione al cambiar de proveedor
      const toolCall: any = { id: shortId(), type: "function", function: { name: call.name, arguments: args } };
      if (call.extra) {
        toolCall.extra_content = call.extra;
      }
      toolCalls.push(toolCall);
    }

    if (toolCalls.length === 0 && content.trim() === "") {
      throw new Error("respuesta vacía del modelo");
    }

    if (toolCalls.length > 0) {
      let finalContent: string | null = null;
      if (content.length > 0) {
        finalContent = content;
      }
      return { message: { role: "assistant", content: finalContent, tool_calls: toolCalls }, usage };
    }
    return { message: { role: "assistant", content }, usage };
  }
}
