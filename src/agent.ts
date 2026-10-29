import type {
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { type AgentDefinition, subagents, toolEnabled } from "./agents.js";
import type { Config } from "./config.js";
import type { LspManager } from "./lsp.js";
import type { McpManager } from "./mcp.js";
import type { PermissionReply, PermissionRequest } from "./permissions.js";
import { systemPrompt } from "./prompt.js";
import { type ChatResult, type Router, type Usage, estimateTokens } from "./router.js";
import { type LogEntry, type Session, type Turn, saveSession } from "./session.js";
import { type SkillDefinition, skillTool } from "./skills.js";
import type { Snapshots } from "./snapshot.js";
import {
  CORE_TOOLS,
  type Todo,
  type Tool,
  type ToolContext,
  beginTurn,
  describeCall,
  expandMentions,
  runTool,
  taskTool,
  toolDefinitions,
  truncate,
  undoLastTurn,
} from "./tools.js";

export type Mode = "build" | "plan";

export interface ToolEvent {
  id: string;
  name: string;
  summary: string;
  // 0 = agente principal, 1 = subagente
  depth: number;
  agent: string;
}

export interface ToolEndEvent extends ToolEvent {
  output: string;
  display?: string;
  isError: boolean;
}

// Lo que va pasando, para que la interfaz lo pinte
export interface AgentEvents {
  onText?(chunk: string, depth: number): void;
  onReasoning?(chunk: string, depth: number): void;
  onTextEnd?(depth: number): void;
  onToolStart?(event: ToolEvent): void;
  onToolProgress?(event: ToolEvent, text: string): void;
  onToolEnd?(event: ToolEndEvent): void;
  onNotice?(message: string): void;
  onInfo?(message: string): void;
  onTodos?(todos: Todo[]): void;
  onStep?(info: { slot: string; usage: Usage | null; tokens: number }): void;
  // Modelo al que se le está preguntando ahora (cambia si uno falla y se prueba otro)
  onModel?(slot: string, depth: number): void;
  // Respuesta final de un mensaje tuyo y el modelo que la ha dado
  onAnswer?(slot: string): void;
}

export interface UserInput {
  text: string;
  images?: string[];
  // Lo que escribiste, si es distinto de lo que se manda (por ejemplo «/review» frente a su plantilla)
  display?: string;
}

export interface AgentDeps {
  router: Router;
  config: Config;
  root: string;
  agents: AgentDefinition[];
  lsp: LspManager | null;
  mcp: McpManager | null;
  snapshots: Snapshots | null;
  skills: SkillDefinition[];
  ask: (request: PermissionRequest, agent: AgentDefinition) => Promise<PermissionReply>;
}

const COMPACT_PROMPT = `Summarize this conversation so another engineer can continue the work without the history.
Include: the user's goal, decisions taken, files read or modified (with paths), the current state and pending steps.
Be concrete and complete but brief. Write it in the language of the conversation.`;

type Message = ChatCompletionMessageParam;

export class Agent {
  agent: AgentDefinition;
  events: AgentEvents = {};
  // Mensajes que escribes mientras trabaja: se le entregan en cuanto acaba el paso actual
  queue: UserInput[] = [];
  // Ficheros leídos y cuándo (para no editar a ciegas)
  readTimes = new Map<string, number>();
  lastSlot = "";
  // Tokens de la última petición (los que dice el proveedor o los estimados)
  lastTokens = 0;
  running = false;
  // Aviso para el modelo que se añade al siguiente mensaje (por ejemplo tras /undo)
  private pendingNote = "";

  constructor(
    private deps: AgentDeps,
    public session: Session,
    agentName = "build",
  ) {
    this.agent = deps.agents.find((agent) => agent.name === agentName) || deps.agents.find((agent) => agent.name === "build")!;
  }

  get mode(): Mode {
    if (this.agent.readOnly) {
      return "plan";
    }
    return "build";
  }

  setAgent(name: string): boolean {
    const found = this.deps.agents.find((agent) => agent.name === name);
    if (!found) {
      return false;
    }
    this.agent = found;
    return true;
  }

  updateDeps(changes: Partial<AgentDeps>) {
    Object.assign(this.deps, changes);
    const current = this.deps.agents.find((agent) => agent.name === this.agent.name);
    if (current) {
      this.agent = current;
    }
  }

  setSession(session: Session) {
    this.session = session;
    this.readTimes.clear();
    this.pendingNote = "";
    this.lastTokens = 0;
  }

  // Herramientas de un agente: las propias, task (si hay subagentes) y las de MCP, con sus filtros
  toolsFor(agent: AgentDefinition, depth: number): Tool[] {
    let tools = [...CORE_TOOLS];
    const subs = subagents(this.deps.agents).filter((sub) => sub.name !== agent.name);
    if (depth === 0 && subs.length > 0) {
      tools.push(taskTool(subs));
    }
    if (this.deps.skills.length > 0) {
      tools.push(skillTool(this.deps.skills));
    }
    if (this.deps.mcp) {
      tools.push(...this.deps.mcp.tools());
    }
    if (!this.deps.lsp || !this.deps.lsp.enabled()) {
      tools = tools.filter((tool) => tool.name !== "diagnostics");
    }
    if (depth > 0) {
      tools = tools.filter((tool) => tool.name !== "todowrite" && tool.name !== "todoread");
    }
    tools = tools.filter((tool) => toolEnabled(agent, tool.name));
    if (agent.readOnly) {
      tools = tools.filter((tool) => tool.readOnly);
    }
    return tools;
  }

  private systemFor(agent: AgentDefinition, tools: Tool[], depth: number): Message {
    return {
      role: "system",
      content: systemPrompt(this.deps.root, {
        agent,
        toolNames: tools.map((tool) => tool.name),
        instructions: this.deps.config.instructions || [],
        subagent: depth > 0,
      }),
    };
  }

  // Texto que se añade al principio del siguiente mensaje tuyo (por ejemplo la salida de un !comando)
  addNote(text: string) {
    this.pendingNote += text;
  }

  // Apunta algo en el historial de la sesión (lo que se enseña al volver y se guarda en el .md)
  logEntry(entry: Omit<LogEntry, "time">) {
    this.session.log.push({ ...entry, time: Date.now() });
  }

  private toolContext(agent: AgentDefinition, signal: AbortSignal | undefined, depth: number): ToolContext {
    const lsp = this.deps.lsp;
    const ctx: ToolContext = {
      root: this.deps.root,
      bashTimeoutMs: this.deps.config.bashTimeoutMs,
      signal,
      ask: (request) => this.deps.ask(request, agent),
      readTimes: this.readTimes,
    };
    if (lsp && lsp.enabled()) {
      ctx.diagnostics = (file, all) => lsp.report(file, all);
    }
    if (depth === 0) {
      ctx.todos = {
        get: () => this.session.todos,
        set: (list) => {
          this.session.todos = list;
          this.events.onTodos?.(list);
        },
      };
      ctx.subagent = (type, prompt, description) => this.runSubagent(type, prompt, description, agent, signal);
    }
    return ctx;
  }

  private requestTokens(messages: Message[], tools: Tool[]): number {
    return estimateTokens(messages) + estimateTokens(toolDefinitions(tools));
  }

  private limit(): number {
    return Math.min(this.deps.config.autoCompactTokens, Math.max(4000, this.deps.router.maxContext() * 0.8));
  }

  private tooBig(tools: Tool[]): boolean {
    return this.requestTokens(this.fullMessages(tools), tools) > this.limit();
  }

  private fullMessages(tools: Tool[]): Message[] {
    return [this.systemFor(this.agent, tools, 0), ...this.session.messages];
  }

  // Vacía las salidas de herramientas antiguas (menos las últimas 6); devuelve true si ha recortado algo
  private prune(messages: Message[]): boolean {
    const toolIndexes: number[] = [];
    messages.forEach((message, index) => {
      if (message.role === "tool") {
        toolIndexes.push(index);
      }
    });
    let changed = false;
    for (const index of toolIndexes.slice(0, -6)) {
      const message = messages[index] as any;
      if (typeof message.content === "string" && message.content.length > 500 && !message.content.includes("[… salida antigua recortada")) {
        message.content = `${message.content.slice(0, 300)}\n[… salida antigua recortada para ahorrar contexto …]`;
        changed = true;
      }
    }
    return changed;
  }

  // Antes de mandar: primero recortamos salidas viejas y, si no basta, resumimos
  private async ensureRoom(tools: Tool[], signal?: AbortSignal): Promise<boolean> {
    if (!this.tooBig(tools)) {
      return false;
    }
    if (this.prune(this.session.messages) && !this.tooBig(tools)) {
      this.events.onInfo?.("He recortado salidas antiguas de herramientas para ahorrar contexto.");
      return false;
    }
    // Recién resumida no hay nada más que ganar (el router avisará si no cabe en ningún modelo)
    if (this.session.messages.length <= 3) {
      return false;
    }
    await this.compact(signal);
    return true;
  }

  // Resume la conversación para que quepa en modelos con poco contexto
  async compact(signal?: AbortSignal) {
    if (this.session.messages.length < 2) {
      this.events.onInfo?.("No hay nada que resumir.");
      return;
    }
    this.events.onInfo?.("Resumiendo la conversación…");
    // Recortamos salidas de herramientas antiguas para que el propio resumen quepa
    const trimmed = this.session.messages.map((m) => {
      if (m.role === "tool" && typeof m.content === "string") {
        return { ...m, content: truncate(m.content, 2000) };
      }
      return m;
    });
    const result = await this.deps.router.chat(
      {
        messages: [
          { role: "system", content: "You are a precise assistant that writes handover summaries." },
          ...trimmed,
          { role: "user", content: COMPACT_PROMPT },
        ],
      },
      signal,
      { onNotice: (t) => this.events.onNotice?.(t) },
    );
    const summary = result.message.content || "";
    let todoText = "";
    if (this.session.todos.length > 0) {
      todoText = `\n\nLista de tareas actual:\n${this.session.todos.map((todo) => `- [${todo.status}] ${todo.content}`).join("\n")}`;
    }
    this.session.messages = [
      { role: "user", content: `Resumen de la conversación anterior:\n\n${summary}${todoText}` },
      { role: "assistant", content: "Entendido, sigo desde aquí." },
    ];
    this.session.epoch++;
    this.logEntry({ role: "info", text: "Conversación resumida para ahorrar contexto: el modelo sigue con un resumen, pero aquí sigue todo lo anterior." });
    saveSession(this.session);
    this.events.onInfo?.(`Conversación resumida (~${estimateTokens(this.session.messages)} tokens).`);
  }

  // Si se canceló a mitad, puede haber llamadas a herramientas sin respuesta: los proveedores lo rechazan
  repairHistory(messages: Message[] = this.session.messages) {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i] as any;
      if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) {
        continue;
      }
      for (const call of m.tool_calls) {
        const answered = messages.some((other: any) => other.role === "tool" && other.tool_call_id === call.id);
        if (!answered) {
          // Insertamos la respuesta justo después de las que ya hay de este turno
          let insertAt = i + 1;
          while (insertAt < messages.length && messages[insertAt].role === "tool") {
            insertAt++;
          }
          messages.splice(insertAt, 0, { role: "tool", tool_call_id: call.id, content: "Cancelado por el usuario." });
        }
      }
    }
  }

  private buildUserMessage(input: UserInput): Message {
    const mentions = expandMentions(input.text, this.deps.root, this.readTimes);
    for (const file of mentions.files) {
      this.events.onInfo?.(`  + adjunto ${file}`);
    }
    const text = this.pendingNote + mentions.text;
    this.pendingNote = "";
    const images = [...(input.images || []), ...mentions.images];
    if (images.length === 0) {
      return { role: "user", content: text };
    }
    return {
      role: "user",
      content: [{ type: "text", text }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))],
    };
  }

  // Una llamada al modelo, con el texto y el razonamiento en directo
  private async step(messages: Message[], tools: Tool[], agent: AgentDefinition, signal: AbortSignal | undefined, depth: number): Promise<ChatResult> {
    let printedText = false;
    const result = await this.deps.router.chat(
      { messages, tools: toolDefinitions(tools), temperature: agent.temperature, prefer: agent.model },
      signal,
      {
        onText: (chunk) => {
          printedText = true;
          this.events.onText?.(chunk, depth);
        },
        onReasoning: (chunk) => this.events.onReasoning?.(chunk, depth),
        onNotice: (notice) => this.events.onNotice?.(notice),
        onAttempt: (slot) => this.events.onModel?.(slot, depth),
      },
    );
    if (printedText) {
      this.events.onTextEnd?.(depth);
    }
    let tokens = this.requestTokens(messages, tools);
    if (result.usage) {
      tokens = result.usage.prompt + result.usage.completion;
      if (depth === 0) {
        this.session.usage.prompt += result.usage.prompt;
        this.session.usage.completion += result.usage.completion;
      }
    }
    if (depth === 0) {
      this.lastSlot = result.slot.key;
      this.lastTokens = tokens;
    }
    this.events.onStep?.({ slot: result.slot.key, usage: result.usage, tokens });
    return result;
  }

  // Ejecuta las herramientas que pidió el modelo; varios "task" seguidos van en paralelo
  private async runCalls(
    calls: ChatCompletionMessageToolCall[],
    tools: Tool[],
    ctx: ToolContext,
    agent: AgentDefinition,
    depth: number,
    messages: Message[],
    signal?: AbortSignal,
  ) {
    const images: string[] = [];
    const runOne = async (call: ChatCompletionMessageFunctionToolCall) => {
      const name = call.function.name;
      const args = call.function.arguments;
      const event: ToolEvent = { id: call.id, name, summary: describeCall(name, args), depth, agent: agent.name };
      this.events.onToolStart?.(event);
      const result = await runTool(tools, name, args, { ...ctx, onProgress: (text) => this.events.onToolProgress?.(event, text) }, agent.readOnly);
      this.events.onToolEnd?.({ ...event, output: result.output, display: result.display, isError: Boolean(result.isError) });
      if (depth === 0) {
        this.logEntry({
          role: "tool",
          text: truncate(result.output, 4000),
          tool: { name, summary: event.summary, isError: Boolean(result.isError), display: result.display ? truncate(result.display, 4000) : undefined },
        });
      }
      if (result.images) {
        images.push(...result.images);
      }
      return { role: "tool" as const, tool_call_id: call.id, content: result.output };
    };

    const functionCalls = calls.filter((call): call is ChatCompletionMessageFunctionToolCall => call.type === "function");
    let i = 0;
    while (i < functionCalls.length) {
      if (signal?.aborted) {
        break;
      }
      if (functionCalls[i].function.name === "task") {
        let j = i;
        while (j < functionCalls.length && functionCalls[j].function.name === "task") {
          j++;
        }
        const results = await Promise.all(functionCalls.slice(i, j).map(runOne));
        messages.push(...results);
        i = j;
      } else {
        messages.push(await runOne(functionCalls[i]));
        i++;
      }
    }
    if (images.length > 0) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: "Imágenes devueltas por las herramientas:" }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))],
      });
    }
  }

  // Detecta cuando el modelo repite la misma llamada una y otra vez
  private repeated(history: string[], calls: ChatCompletionMessageToolCall[]): string | null {
    for (const call of calls) {
      if (call.type !== "function") {
        continue;
      }
      history.push(`${call.function.name}:${call.function.arguments}`);
    }
    if (history.length >= 3) {
      const last = history.slice(-3);
      if (last[0] === last[1] && last[1] === last[2]) {
        history.length = 0;
        return last[0].split(":")[0];
      }
    }
    return null;
  }

  async run(input: UserInput, signal?: AbortSignal) {
    this.running = true;
    let turn: Turn | null = null;
    try {
      this.repairHistory();
      const tools = this.toolsFor(this.agent, 0);
      await this.ensureRoom(tools, signal);

      const before = this.deps.snapshots ? await this.deps.snapshots.track() : null;
      beginTurn();
      turn = { messageIndex: this.session.messages.length, before, after: null, epoch: this.session.epoch, userText: input.display ?? input.text };
      this.session.turns.push(turn);
      this.session.redo = [];
      this.session.agent = this.agent.name;
      this.session.messages.push(this.buildUserMessage(input));
      this.logEntry({ role: "user", text: input.display ?? input.text, images: input.images?.length || undefined });
      saveSession(this.session);

      await this.loop(tools, signal);
    } finally {
      if (turn && this.deps.snapshots) {
        turn.after = await this.deps.snapshots.track();
      }
      saveSession(this.session);
      this.running = false;
    }
  }

  private async loop(tools: Tool[], signal?: AbortSignal) {
    const agent = this.agent;
    const maxSteps = agent.maxSteps || this.deps.config.maxSteps;
    const ctx = this.toolContext(agent, signal, 0);
    const history: string[] = [];

    for (let step = 0; step < maxSteps; step++) {
      // Si la conversación crece demasiado a mitad de tarea, la resumimos y seguimos
      if (await this.ensureRoom(tools, signal)) {
        this.session.messages.push({ role: "user", content: "Continúa con la tarea pendiente." });
      }

      const result = await this.step(this.fullMessages(tools), tools, agent, signal, 0);
      const message = result.message;
      this.session.messages.push(message as Message);
      if (typeof message.content === "string" && message.content.trim() !== "") {
        this.logEntry({ role: "assistant", text: message.content, model: result.slot.key });
      }
      saveSession(this.session);

      if (!message.tool_calls || message.tool_calls.length === 0) {
        if (this.events.onAnswer) {
          this.events.onAnswer(result.slot.key);
        } else {
          this.events.onInfo?.(`  ${result.slot.key}`);
        }
        return;
      }

      await this.runCalls(message.tool_calls, tools, ctx, agent, 0, this.session.messages, signal);
      saveSession(this.session);

      if (signal?.aborted) {
        return;
      }

      const looping = this.repeated(history, message.tool_calls);
      if (looping) {
        this.session.messages.push({
          role: "user",
          content: `Has hecho la misma llamada a ${looping} tres veces seguidas con los mismos argumentos. No la repitas: cambia de enfoque o explica qué te bloquea.`,
        });
      }

      // Lo que hayas escrito mientras trabajaba se le entrega ahora
      if (this.queue.length > 0) {
        for (const queued of this.queue.splice(0)) {
          this.session.messages.push(this.buildUserMessage({ text: `[Mensaje nuevo del usuario mientras trabajabas] ${queued.text}`, images: queued.images }));
          this.logEntry({ role: "user", text: queued.text, images: queued.images?.length || undefined });
        }
        this.events.onInfo?.("(mensaje entregado al agente)");
        saveSession(this.session);
      }
    }

    this.events.onNotice?.(`Se alcanzó el máximo de ${maxSteps} pasos. Escribe "continúa" para seguir.`);
  }

  // Un subagente trabaja con su propio historial y devuelve solo su informe final
  async runSubagent(type: string, prompt: string, description: string, parent: AgentDefinition, signal?: AbortSignal): Promise<string> {
    let sub = subagents(this.deps.agents).find((agent) => agent.name === type);
    if (!sub) {
      sub = subagents(this.deps.agents).find((agent) => agent.name === "general");
    }
    if (!sub) {
      return `Error: no existe el subagente ${type}.`;
    }
    // Un agente de solo lectura no puede saltarse la norma lanzando un subagente que edite
    const agent: AgentDefinition = parent.readOnly ? { ...sub, readOnly: true } : sub;
    const tools = this.toolsFor(agent, 1);
    const ctx = this.toolContext(agent, signal, 1);
    const messages: Message[] = [{ role: "user", content: prompt }];
    const maxSteps = agent.maxSteps || Math.min(this.deps.config.maxSteps, 30);
    const history: string[] = [];
    this.events.onInfo?.(`  ↳ ${agent.name}: ${description}`);

    for (let step = 0; step < maxSteps; step++) {
      const system = this.systemFor(agent, tools, 1);
      if (this.requestTokens([system, ...messages], tools) > this.limit()) {
        this.prune(messages);
      }
      const result = await this.step([system, ...messages], tools, agent, signal, 1);
      messages.push(result.message as Message);
      if (!result.message.tool_calls || result.message.tool_calls.length === 0) {
        return result.message.content || "(el subagente no devolvió ningún texto)";
      }
      await this.runCalls(result.message.tool_calls, tools, ctx, agent, 1, messages, signal);
      if (signal?.aborted) {
        return "Cancelado por el usuario.";
      }
      const looping = this.repeated(history, result.message.tool_calls);
      if (looping) {
        messages.push({ role: "user", content: `Has repetido la misma llamada a ${looping} tres veces. Cambia de enfoque o termina con lo que tengas.` });
      }
    }
    this.repairHistory(messages);
    const final = await this.deps.router.chat(
      {
        messages: [
          this.systemFor(agent, tools, 1),
          ...messages,
          { role: "user", content: "Se acabaron los pasos. Escribe ya tu informe final con lo que hayas averiguado o hecho." },
        ],
      },
      signal,
      { onNotice: (notice) => this.events.onNotice?.(notice) },
    );
    return final.message.content || "(el subagente no devolvió ningún informe)";
  }

  // Deshace el último mensaje: ficheros (con instantáneas, incluido lo que hizo bash) y conversación
  async undo(): Promise<{ files: string[]; text: string; restoredMessages: boolean } | null> {
    const turn = this.session.turns.pop();
    if (!turn) {
      return null;
    }
    let files: string[] = [];
    if (turn.before && this.deps.snapshots) {
      files = await this.deps.snapshots.restore(turn.before);
    } else {
      files = undoLastTurn(this.deps.root);
    }
    let removed: Message[] = [];
    let restoredMessages = false;
    if (turn.epoch === this.session.epoch && turn.messageIndex <= this.session.messages.length) {
      removed = this.session.messages.splice(turn.messageIndex);
      restoredMessages = true;
    } else if (files.length > 0) {
      this.pendingNote += `(Nota: el usuario ha deshecho tus últimos cambios en ${files.join(", ")}; esos ficheros vuelven a estar como antes. Léelos de nuevo si los necesitas.)\n\n`;
    }
    this.session.redo.push({ turn, messages: removed });
    this.readTimes.clear();
    this.logEntry({ role: "info", text: `Deshecho: «${turn.userText}»${files.length > 0 ? ` (ficheros restaurados: ${files.join(", ")})` : ""}` });
    saveSession(this.session);
    return { files, text: turn.userText, restoredMessages };
  }

  async redo(): Promise<{ files: string[] } | null> {
    const entry = this.session.redo.pop();
    if (!entry) {
      return null;
    }
    let files: string[] = [];
    if (entry.turn.after && this.deps.snapshots) {
      files = await this.deps.snapshots.restore(entry.turn.after);
    }
    if (entry.messages.length > 0 && entry.turn.epoch === this.session.epoch && this.session.messages.length === entry.turn.messageIndex) {
      this.session.messages.push(...entry.messages);
    }
    this.session.turns.push(entry.turn);
    this.readTimes.clear();
    this.logEntry({ role: "info", text: `Rehecho: «${entry.turn.userText}»` });
    saveSession(this.session);
    return { files };
  }

  // Diff de lo que ha cambiado en el último mensaje o en toda la sesión
  async diff(all: boolean): Promise<string> {
    if (!this.deps.snapshots) {
      return "";
    }
    const turns = this.session.turns.filter((turn) => turn.before);
    if (turns.length === 0) {
      return "";
    }
    if (all) {
      return this.deps.snapshots.diff(turns[0].before!);
    }
    const last = turns[turns.length - 1];
    return this.deps.snapshots.diff(last.before!, last.after || undefined);
  }
}
