import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box, Static, Text, render, useAnimation, useApp, useInput, usePaste, useWindowSize } from "ink";
import pc from "picocolors";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ToolEndEvent, ToolEvent, UserInput } from "../agent.js";
import type { App, RunOptions, SelectItem, UiAdapter } from "../app.js";
import { configNotices } from "../config.js";
import { discoveryIsStale } from "../discovery.js";
import { isImagePath, readClipboardImage, toDataUrl } from "../images.js";
import { toolLabel } from "../labels.js";
import { renderMarkdown } from "../markdown.js";
import { VERSION } from "../meta.js";
import type { PermissionReply, PermissionRequest } from "../permissions.js";
import { NoSlotError } from "../router.js";
import { showControl, stripControl, stripUnsafe } from "../sanitize.js";
import { type Session, appendHistory, loadHistory, sessionMarkdownPath } from "../session.js";
import { type Todo, suggestFiles } from "../tools.js";
import { colorPreview } from "../ui.js";
import { checkForUpdate } from "../update.js";
import { type PermissionChoice, PermissionDialog, PromptDialog, SelectDialog } from "./dialogs.js";
import * as E from "./editor.js";


type Item =
  | { id: number; kind: "banner" }
  | { id: number; kind: "user"; text: string; images: number; queued?: boolean; color: string }
  | { id: number; kind: "assistant"; text: string; color: string }
  | { id: number; kind: "tool"; event: ToolEndEvent; ms: number }
  // Pie de cada respuesta: qué modelo contestó, cuánto tardó y cuántos tokens gastó
  | { id: number; kind: "answer"; slot: string; score: number | null; ms: number; tokens: number }
  | { id: number; kind: "shell"; command: string; output: string; code: number | null }
  | { id: number; kind: "info" | "notice" | "error" | "block"; text: string };

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type NewItem = WithoutId<Item>;

type Dialog =
  | { kind: "permission"; request: PermissionRequest; agent: string; resolve: (choice: PermissionChoice) => void }
  | { kind: "select"; title: string; items: SelectItem<unknown>[]; resolve: (value: unknown) => void }
  | { kind: "prompt"; title: string; mask?: boolean; placeholder?: string; resolve: (value: string | null) => void };

interface Suggestion {
  label: string;
  description?: string;
  apply: (state: E.EditorState) => E.EditorState;
  // Al aceptarla con Enter se envía directamente (comandos sin argumentos)
  submit: boolean;
}

interface Live {
  text: string;
  reasoning: string;
  running: Map<string, { event: ToolEvent; progress: string; since: number }>;
  // Modelo al que se le está preguntando ahora
  model: string;
  // !comando en marcha
  shell: { command: string; output: string } | null;
}

// Al volver a una sesión se enseñan sus últimos pasos (el .md los tiene todos)
const REPLAY_MAX = 300;

// Comandos que se pueden usar mientras el agente trabaja (solo consultan)
const SAFE_WHILE_BUSY = ["/help", "/usage", "/todos", "/mcp", "/lsp", "/providers", "/skills"];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function Spinner(props: { color?: string }) {
  const { frame } = useAnimation({ interval: 80 });
  return <Text color={props.color || "cyan"}>{SPINNER[frame % SPINNER.length]}</Text>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return "<1 s";
  }
  const seconds = ms / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1).replace(".", ",")} s`;
  }
  if (seconds < 60) {
    return `${Math.round(seconds)} s`;
  }
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

function Elapsed(props: { since: number; hideUnderMs?: number }) {
  useAnimation({ interval: 1000 });
  const ms = Date.now() - props.since;
  if (props.hideUnderMs && ms < props.hideUnderMs) {
    return null;
  }
  return <Text dimColor>{formatDuration(ms)}</Text>;
}

function shortTokens(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k`;
  }
  return String(tokens);
}

function lastLines(text: string, count: number): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.slice(-count).join("\n");
}

function firstLine(text: string, max = 200): string {
  return (text.split("\n")[0] || "").slice(0, max);
}

function tildify(file: string): string {
  const home = os.homedir();
  if (file === home || file.startsWith(home + path.sep)) {
    return `~${file.slice(home.length)}`;
  }
  return file;
}

// Líneas añadidas y quitadas de un diff
function diffStats(display: string | undefined): { added: number; removed: number } | null {
  if (!display) {
    return null;
  }
  let added = 0;
  let removed = 0;
  for (const line of display.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed++;
    }
  }
  if (added === 0 && removed === 0) {
    return null;
  }
  return { added, removed };
}

// Debajo de cada herramienta, un resumen corto de lo que pasó
function toolDetail(event: ToolEndEvent): string[] {
  // La salida viene de ficheros y comandos: sin secuencias de la terminal
  const output = stripControl(event.output || "");
  if (event.isError) {
    return [pc.red(firstLine(output))];
  }
  if (event.display) {
    const lines = colorPreview(event.display).split("\n");
    if (lines.length > 14) {
      return [...lines.slice(0, 14), pc.dim(`… ${lines.length - 14} líneas más del diff`)];
    }
    return lines;
  }
  const count = output.split("\n").filter((line) => line.trim() !== "").length;
  switch (event.name) {
    case "read_file":
      if (output.startsWith("Imagen")) {
        return [pc.dim(firstLine(output))];
      }
      return [pc.dim(`Leídas ${output.split("\n").length} líneas`)];
    case "glob":
    case "grep":
      if (/^Sin (resultados|coincidencias)/.test(output)) {
        return [pc.dim(firstLine(output))];
      }
      return [pc.dim(`${count} resultados`)];
    case "list_dir":
      return [pc.dim(`${count} entradas`)];
    case "bash": {
      const lines = output.split("\n");
      const header = lines[0] || "";
      const body = lines.slice(1).filter((line) => line.trim() !== "");
      const tail = body.slice(-4).map((line) => pc.dim(line.slice(0, 200)));
      const ok = header === "Código de salida: 0";
      return [ok ? pc.dim(header) : pc.yellow(header), ...tail];
    }
    case "webfetch":
      return [pc.dim(`${output.length} caracteres`)];
    case "websearch":
      return [pc.dim(`${(output.match(/^\d+\. /gm) || []).length} resultados`)];
    case "todowrite":
      return output
        .split("\n")
        .slice(1)
        .map((line) => pc.dim(line));
    case "task":
      return output
        .split("\n")
        .filter((line) => line.trim() !== "")
        .slice(0, 3)
        .map((line) => pc.dim(line.slice(0, 200)));
    case "skill":
      return [pc.dim(event.summary.includes("·") ? "fichero leído" : "instrucciones cargadas")];
    default:
      return [pc.dim(firstLine(output))];
  }
}

// El resumen sale de lo que pidió el modelo (comandos, rutas): los caracteres de control se ven, no actúan
function ToolHeader(props: { name: string; summary: string }) {
  return (
    <>
      <Text bold>{showControl(toolLabel(props.name))}</Text>
      {props.summary ? <Text> {showControl(props.summary)}</Text> : null}
    </>
  );
}

function ToolView(props: { event: ToolEndEvent; ms: number }) {
  const { event } = props;
  const detail = toolDetail(event);
  const stats = event.isError ? null : diffStats(event.display);
  return (
    <Box flexDirection="column" marginLeft={event.depth > 0 ? 4 : 0}>
      <Text wrap="truncate-end">
        <Text color={event.isError ? "red" : "green"}>● </Text>
        <ToolHeader name={event.name} summary={event.summary} />
        {stats ? (
          <Text>
            {"  "}
            <Text color="green">+{stats.added}</Text> <Text color="red">−{stats.removed}</Text>
          </Text>
        ) : null}
        {props.ms >= 1000 ? <Text dimColor> ({formatDuration(props.ms)})</Text> : null}
      </Text>
      {detail.map((line, index) => (
        <Text key={index}>
          {"  "}
          {index === 0 ? pc.dim("⎿ ") : "  "}
          {line}
        </Text>
      ))}
    </Box>
  );
}

// Pantalla de bienvenida
function Banner(props: { app: App }) {
  const { app } = props;
  const slots = app.router.slots;
  const providers = new Set(slots.map((slot) => slot.provider.name)).size;
  const first = slots[0];
  const extras: string[] = [];
  if (app.skills.length > 0) {
    extras.push(`${app.skills.length} skill${app.skills.length > 1 ? "s" : ""}`);
  }
  const mcp = Object.keys(app.config.mcp || {}).length;
  if (mcp > 0) {
    extras.push(`${mcp} MCP`);
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={2}>
      <Text>
        <Text bold color="magenta">
          ◆ vipcode
        </Text>
        <Text dimColor> v{VERSION} · programa con IAs gratuitas</Text>
      </Text>
      <Text dimColor>{tildify(app.root)}</Text>
      <Text> </Text>
      <Text>
        <Text color={slots.length > 0 ? "green" : "red"}>●</Text> {slots.length} modelo{slots.length === 1 ? "" : "s"} de {providers} proveedor
        {providers === 1 ? "" : "es"}
        {extras.length > 0 ? <Text dimColor> · {extras.join(" · ")}</Text> : null}
      </Text>
      {first ? (
        <Text wrap="truncate-end">
          <Text color="yellow">★</Text> Empieza con <Text bold>{first.key}</Text>
          {first.score !== null ? <Text dimColor> (nota {first.score} en LLM Stats)</Text> : null}
        </Text>
      ) : null}
      <Text> </Text>
      <Text dimColor wrap="truncate-end">
        Ctrl+P comandos · @ adjunta · ! terminal · Tab cambia de agente · /help ayuda
      </Text>
    </Box>
  );
}

function ItemView(props: { item: Item; app: App; width: number }) {
  const { item, width } = props;
  switch (item.kind) {
    case "banner":
      return <Banner app={props.app} />;
    case "user": {
      const lines = stripControl(item.text).split("\n");
      let text = lines.join("\n");
      if (lines.length > 20) {
        text = `${lines.slice(0, 20).join("\n")}\n… (${lines.length - 20} líneas más)`;
      }
      return (
        <Box marginTop={1} borderStyle="bold" borderTop={false} borderRight={false} borderBottom={false} borderColor={item.color} paddingLeft={1}>
          <Text>
            {text}
            {item.images > 0 ? pc.dim(` [${item.images} imagen${item.images > 1 ? "es" : ""}]`) : ""}
            {item.queued ? pc.dim(" (en cola: se le entrega al acabar el paso)") : ""}
          </Text>
        </Box>
      );
    }
    case "assistant":
      return (
        <Box marginTop={1}>
          <Text color={item.color}>● </Text>
          <Box flexDirection="column" flexGrow={1}>
            <Text>{renderMarkdown(item.text, Math.max(20, width - 4))}</Text>
          </Box>
        </Box>
      );
    case "tool":
      return <ToolView event={item.event} ms={item.ms} />;
    case "answer":
      return (
        <Box marginLeft={2}>
          <Text dimColor wrap="truncate-end">
            ◆ {item.slot}
            {item.score !== null ? ` · nota ${item.score}` : ""} · {formatDuration(item.ms)}
            {item.tokens > 0 ? ` · ${shortTokens(item.tokens)} tokens` : ""}
          </Text>
        </Box>
      );
    case "shell": {
      const lines = item.output ? stripControl(item.output).split("\n") : [];
      const shown = lines.slice(-30);
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color="yellow" bold>
              ${" "}
            </Text>
            <Text bold>{showControl(item.command)}</Text>
          </Text>
          {lines.length > shown.length ? <Text dimColor>  … {lines.length - shown.length} líneas antes</Text> : null}
          {shown.length > 0 ? <Text>{shown.map((line) => `  ${line}`).join("\n")}</Text> : null}
          <Text dimColor>
            {"  "}
            {item.code === 0 ? "✓" : "✗"} código {item.code ?? "?"} · el agente verá la salida con tu siguiente mensaje
          </Text>
        </Box>
      );
    }
    // Avisos y bloques pueden llevar mensajes de los proveedores o datos de fuera: solo se dejan los colores
    case "info":
      return <Text dimColor>{stripUnsafe(item.text)}</Text>;
    case "notice":
      return <Text color="yellow">⚠ {stripUnsafe(item.text)}</Text>;
    case "error":
      return <Text color="red">✖ {stripUnsafe(item.text)}</Text>;
    case "block":
      return (
        <Box marginY={1}>
          <Text>{stripUnsafe(item.text)}</Text>
        </Box>
      );
  }
}

function TodoPanel(props: { todos: Todo[] }) {
  const open = props.todos.some((todo) => todo.status === "pending" || todo.status === "in_progress");
  if (!open) {
    return null;
  }
  const done = props.todos.filter((todo) => todo.status === "completed").length;
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      <Text dimColor>
        Tareas ({done}/{props.todos.length})
      </Text>
      {props.todos.slice(0, 10).map((todo, index) => {
        if (todo.status === "completed") {
          return (
            <Text key={index} color="green" strikethrough>
              ☑ {stripControl(todo.content)}
            </Text>
          );
        }
        if (todo.status === "in_progress") {
          return (
            <Text key={index} color="yellow">
              ◐ {stripControl(todo.content)}
            </Text>
          );
        }
        if (todo.status === "cancelled") {
          return (
            <Text key={index} dimColor strikethrough>
              ☒ {stripControl(todo.content)}
            </Text>
          );
        }
        return <Text key={index}>☐ {stripControl(todo.content)}</Text>;
      })}
      {props.todos.length > 10 ? <Text dimColor>… y {props.todos.length - 10} más</Text> : null}
    </Box>
  );
}

function InputBox(props: { editor: E.EditorState; color: string; placeholder: string; attachments: number; maxLines: number; width: number }) {
  const { editor } = props;
  // Con ! delante es un comando para la terminal
  const shell = editor.value.startsWith("!");
  const color = shell ? "yellow" : props.color;
  const lines = editor.value.split("\n");
  const { line, column } = E.cursorPosition(editor);
  // Con textos pegados muy largos solo se ve una ventana alrededor del cursor (el cuadro no puede pasar de la pantalla)
  const start = Math.max(0, Math.min(line - Math.floor(props.maxLines / 2), lines.length - props.maxLines));
  const end = Math.min(lines.length, start + props.maxLines);
  const maxChars = Math.max(200, props.width * 3);
  const clip = (text: string, from: number) => text.slice(from, from + maxChars);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginTop={1}>
      {props.attachments > 0 ? (
        <Text color="cyan">
          {Array.from({ length: props.attachments }, (_, i) => `[Imagen ${i + 1}]`).join(" ")}
          <Text dimColor> (se envían con el próximo mensaje)</Text>
        </Text>
      ) : null}
      {start > 0 ? <Text dimColor>  ↑ {start} líneas más</Text> : null}
      {lines.slice(start, end).map((text, offset) => {
        const index = start + offset;
        // En líneas larguísimas se enseña el trozo donde está el cursor
        const from = index === line ? Math.max(0, column - Math.floor(maxChars / 2)) : 0;
        return (
          <Text key={index}>
            <Text color={color}>{index === 0 ? (shell ? "$ " : "❯ ") : "  "}</Text>
            {editor.value === "" ? (
              <>
                <Text inverse> </Text>
                <Text dimColor>{props.placeholder}</Text>
              </>
            ) : index === line ? (
              <>
                {from > 0 ? "…" : ""}
                {text.slice(from, column)}
                <Text inverse>{text[column] || " "}</Text>
                {clip(text, column + 1).slice(0, maxChars - (column - from))}
              </>
            ) : (
              clip(text, 0) + (text.length > maxChars ? "…" : "")
            )}
          </Text>
        );
      })}
      {end < lines.length ? <Text dimColor>  ↓ {lines.length - end} líneas más</Text> : null}
      {shell ? <Text dimColor>Enter lo ejecuta en {tildify(process.cwd())} · el agente verá la salida</Text> : null}
    </Box>
  );
}

// Medidor de contexto: ▰▰▰▱▱▱▱▱ 34 %
function ContextGauge(props: { used: number; total: number }) {
  if (props.used <= 0 || props.total <= 0) {
    return null;
  }
  const ratio = Math.min(1, props.used / props.total);
  const filled = Math.min(8, Math.ceil(ratio * 8));
  let color = "green";
  if (ratio >= 0.85) {
    color = "red";
  } else if (ratio >= 0.6) {
    color = "yellow";
  }
  return (
    <Text>
      <Text dimColor> · </Text>
      <Text color={color}>{"▰".repeat(filled)}</Text>
      <Text dimColor>
        {"▱".repeat(8 - filled)} {Math.round(ratio * 100)}% de {shortTokens(props.total)}
      </Text>
    </Text>
  );
}

function StatusBar(props: { app: App; agentName: string; busy: boolean; model: string }) {
  const { app } = props;
  const agent = app.agents.find((item) => item.name === props.agentName);
  const current = props.model || app.router.pinned || app.agent.lastSlot;
  const slot = app.router.slotFor(current);
  const context = app.router.slotFor(app.agent.lastSlot)?.model.context || 0;
  const available = app.router.availableCount();
  const usage = app.agent.session.usage;
  const spent = usage.prompt + usage.completion;
  const queued = app.agent.queue.length;
  let hint = "ctrl+p comandos · /help";
  if (props.busy) {
    hint = "esc interrumpe · escribe para añadir instrucciones";
  }
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text wrap="truncate-end">
        <Text bold color={(agent?.color as any) || "magenta"}>
          {props.agentName}
        </Text>
        <Text dimColor>
          {" "}
          · {current || "rotación automática"}
          {slot && slot.score !== null ? ` ★${slot.score}` : ""}
          {app.router.pinned ? " (fijado)" : ""}
        </Text>
        <ContextGauge used={app.agent.lastTokens} total={context} />
        <Text dimColor>
          {" "}
          · {available}/{app.router.slots.length} modelos
          {spent > 0 ? ` · ${shortTokens(spent)} tokens` : ""}
          {queued > 0 ? ` · ${queued} en cola` : ""}
        </Text>
        {app.yolo ? <Text color="red"> · yolo</Text> : null}
      </Text>
      <Text dimColor wrap="truncate-start">
        {hint}
      </Text>
    </Box>
  );
}

function Main(props: { app: App; initial: string }) {
  const { app } = props;
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [items, setItems] = useState<Item[]>([{ id: 0, kind: "banner" }]);
  const nextId = useRef(1);
  const [editor, setEditor] = useState<E.EditorState>(E.EMPTY);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [todos, setTodos] = useState<Todo[]>(app.agent.session.todos);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [suggestionsClosed, setSuggestionsClosed] = useState(false);
  const [agentName, setAgentName] = useState(app.agent.agent.name);
  const [, setVersion] = useState(0);
  const live = useRef<Live>({ text: "", reasoning: "", running: new Map(), model: "", shell: null });
  const dirty = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const startedAt = useRef(Date.now());
  // Para el pie de cada respuesta: modelo que contestó y tokens al empezar
  const answered = useRef("");
  const tokensAtStart = useRef(0);
  const history = useRef<string[]>(loadHistory());
  const historyIndex = useRef<number | null>(null);
  const draft = useRef("");
  const lastCtrlC = useRef(0);
  const dialogRef = useRef<Dialog | null>(null);
  dialogRef.current = dialog;

  const refresh = () => setVersion((v) => v + 1);

  const push = (item: NewItem) => {
    const id = nextId.current++;
    setItems((previous) => [...previous, { ...item, id } as Item]);
  };

  const agentColor = () => app.agents.find((item) => item.name === app.agent.agent.name)?.color || "magenta";

  // Pasa el texto en directo al historial fijo de arriba
  const flushText = () => {
    const text = live.current.text;
    if (text.trim() !== "") {
      push({ kind: "assistant", text, color: agentColor() });
    }
    live.current.text = "";
    live.current.reasoning = "";
    dirty.current = true;
  };

  const adapter = useMemo<UiAdapter>(
    () => ({
      info: (text) => push({ kind: "info", text }),
      notice: (text) => push({ kind: "notice", text }),
      error: (text) => push({ kind: "error", text }),
      block: (text) => push({ kind: "block", text }),
      select: <T,>(title: string, list: SelectItem<T>[]) =>
        new Promise<T | null>((resolve) => {
          setDialog({
            kind: "select",
            title,
            items: list as SelectItem<unknown>[],
            resolve: (value) => {
              setDialog(null);
              resolve(value as T | null);
            },
          });
        }),
      prompt: (title, options) =>
        new Promise<string | null>((resolve) => {
          setDialog({
            kind: "prompt",
            title,
            mask: options?.mask,
            placeholder: options?.placeholder,
            resolve: (value) => {
              setDialog(null);
              resolve(value);
            },
          });
        }),
      setInput: (text) => setEditor({ value: text, cursor: text.length }),
    }),
    [],
  );

  // Si se interrumpe con un permiso pendiente, se contesta que no para que el agente no se quede esperando
  const cancelDialog = () => {
    const current = dialogRef.current;
    if (!current) {
      return;
    }
    if (current.kind === "permission") {
      current.resolve({ reply: { allow: false } });
    } else if (current.kind === "select") {
      current.resolve(null);
    } else {
      current.resolve(null);
    }
    setDialog(null);
  };

  const quit = async () => {
    controller.current?.abort();
    cancelDialog();
    await app.shutdown();
    exit();
    setTimeout(() => process.exit(0), 100);
  };

  const sessionTokens = () => app.agent.session.usage.prompt + app.agent.session.usage.completion;

  const runAgent = async (input: UserInput, options: RunOptions) => {
    setBusy(true);
    startedAt.current = Date.now();
    answered.current = "";
    tokensAtStart.current = sessionTokens();
    live.current.model = "";
    const abort = new AbortController();
    controller.current = abort;
    try {
      await app.runPrompt(input, options, abort.signal);
    } catch (err) {
      if (abort.signal.aborted) {
        push({ kind: "info", text: "(interrumpido)" });
      } else if (err instanceof NoSlotError) {
        push({ kind: "error", text: err.message });
      } else {
        push({ kind: "error", text: (err as Error).message || String(err) });
      }
    } finally {
      flushText();
      if (answered.current) {
        push({
          kind: "answer",
          slot: answered.current,
          score: app.router.slotFor(answered.current)?.score ?? null,
          ms: Date.now() - startedAt.current,
          tokens: sessionTokens() - tokensAtStart.current,
        });
      }
      live.current.running.clear();
      live.current.model = "";
      controller.current = null;
      setBusy(false);
      setAgentName(app.agent.agent.name);
      setTodos([...app.agent.session.todos]);
      refresh();
      // Lo que se escribió al final y no llegó a entregarse se lanza ahora
      const next = app.agent.queue.shift();
      if (next) {
        void runAgent(next, {});
      }
    }
  };

  // !comando: se ejecuta en la carpeta del proyecto y la salida le llega al agente con el siguiente mensaje
  const runShell = async (command: string) => {
    setBusy(true);
    startedAt.current = Date.now();
    const abort = new AbortController();
    controller.current = abort;
    live.current.shell = { command, output: "" };
    try {
      const result = await app.runShell(
        command,
        (text) => {
          if (live.current.shell) {
            live.current.shell.output = (live.current.shell.output + text).slice(-4000);
            dirty.current = true;
          }
        },
        abort.signal,
      );
      push({ kind: "shell", command, output: result.output, code: result.code });
    } finally {
      live.current.shell = null;
      controller.current = null;
      setBusy(false);
      refresh();
    }
  };

  const submit = async (raw: string) => {
    const text = raw.trim();
    if (text === "" && attachments.length === 0) {
      return;
    }
    setEditor(E.EMPTY);
    historyIndex.current = null;
    if (text !== "") {
      appendHistory(text);
      history.current.push(text);
    }

    if (text.startsWith("!")) {
      const command = text.slice(1).trim();
      if (!command) {
        return;
      }
      if (busy) {
        push({ kind: "error", text: "Espera a que termine (o pulsa Esc) para ejecutar un comando." });
        return;
      }
      void runShell(command);
      return;
    }

    const images = attachments;
    setAttachments([]);

    if (text.startsWith("/")) {
      const command = text.split(/\s+/)[0];
      if (busy && !SAFE_WHILE_BUSY.includes(command)) {
        push({ kind: "error", text: "Espera a que termine (o pulsa Esc) para usar ese comando." });
        return;
      }
      push({ kind: "info", text: `❯ ${text}` });
      try {
        const result = await app.handleCommand(text, adapter);
        setAgentName(app.agent.agent.name);
        setTodos([...app.agent.session.todos]);
        refresh();
        if (result.exit) {
          await quit();
          return;
        }
        if (result.loaded) {
          replay(app.agent.session);
        }
        if (result.run) {
          void runAgent({ ...result.run.input, images }, result.run.options);
        }
      } catch (err) {
        push({ kind: "error", text: (err as Error).message });
      }
      return;
    }

    if (busy) {
      app.agent.queue.push({ text, images });
      push({ kind: "user", text, images: images.length, queued: true, color: agentColor() });
      return;
    }
    push({ kind: "user", text, images: images.length, color: agentColor() });
    void runAgent({ text, images }, {});
  };

  // La primera vez que se van a usar proveedores sin clave, explicamos qué pasa con lo que envías
  const askPrivacy = async () => {
    const choice = await adapter.select!(`Antes de empezar: ${app.privacyNotice()}`, [
      { label: "Entendido, empezar", value: "ok" },
      { label: "Añadir antes un proveedor con clave", description: "como /connect", value: "connect" },
      { label: "No usar nunca los que no piden clave", description: 'guarda "keyless": false en tu configuración', value: "off" },
    ]);
    if (!choice) {
      // Con Esc se vuelve a preguntar la próxima vez
      return;
    }
    app.acceptPrivacyNotice();
    if (choice === "connect") {
      await app.connect(adapter, "");
    } else if (choice === "off") {
      app.disableKeyless();
      push({ kind: "info", text: "No usaré los proveedores sin clave (lo puedes cambiar con \"keyless\" en la configuración)." });
      if (app.router.slots.length === 0) {
        await app.connect(adapter, "");
      }
    }
    refresh();
  };

  // La conversación de una sesión a la que vuelves, tal como la viste
  const replay = (session: Session) => {
    const entries = session.log;
    if (entries.length === 0) {
      push({ kind: "info", text: `Sesión «${session.title}» cargada.` });
      return;
    }
    const shown = entries.slice(-REPLAY_MAX);
    push({ kind: "info", text: `── Conversación anterior: «${session.title}» · ${new Date(session.updated).toLocaleString()} ──` });
    if (entries.length > shown.length) {
      push({ kind: "info", text: `… ${entries.length - shown.length} pasos antes; la conversación entera está en ${sessionMarkdownPath(session)}` });
    }
    shown.forEach((entry, index) => {
      if (entry.role === "user") {
        push({ kind: "user", text: entry.text, images: entry.images || 0, color: agentColor() });
      } else if (entry.role === "assistant") {
        push({ kind: "assistant", text: entry.text, color: agentColor() });
      } else if (entry.role === "tool" && entry.tool) {
        const event = { id: `historial-${index}`, name: entry.tool.name, summary: entry.tool.summary, depth: 0, agent: "" };
        push({ kind: "tool", event: { ...event, output: entry.text, display: entry.tool.display, isError: entry.tool.isError }, ms: 0 });
      } else {
        push({ kind: "info", text: entry.text });
      }
    });
    push({ kind: "info", text: "── Sigues desde aquí (/new empieza otra conversación) ──" });
  };

  // Paleta de comandos (Ctrl+P): todos los comandos, skills y agentes con su descripción
  const openPalette = async () => {
    const commands = app.commandSuggestions();
    const choice = await adapter.select!(
      "Comandos y skills",
      commands.map((command) => ({ label: `/${command.name}`, description: command.description, value: command })),
    );
    if (!choice) {
      return;
    }
    if (choice.needsArgs) {
      const value = `/${choice.name} `;
      setEditor({ value, cursor: value.length });
      return;
    }
    void submit(`/${choice.name}`);
  };

  // Conectamos el agente con la pantalla
  useEffect(() => {
    app.agent.events = {
      onText: (chunk, depth) => {
        if (depth > 0) {
          return;
        }
        live.current.text += chunk;
        live.current.reasoning = "";
        dirty.current = true;
      },
      onReasoning: (chunk, depth) => {
        if (depth > 0 || !app.config.showReasoning) {
          return;
        }
        live.current.reasoning = (live.current.reasoning + chunk).slice(-600);
        dirty.current = true;
      },
      onTextEnd: (depth) => {
        if (depth === 0) {
          flushText();
        }
      },
      onToolStart: (event) => {
        flushText();
        live.current.running.set(`${event.depth}:${event.id}`, { event, progress: "", since: Date.now() });
        dirty.current = true;
      },
      onToolProgress: (event, text) => {
        const entry = live.current.running.get(`${event.depth}:${event.id}`);
        if (entry) {
          entry.progress = (entry.progress + text).slice(-2000);
          dirty.current = true;
        }
      },
      onToolEnd: (event) => {
        const key = `${event.depth}:${event.id}`;
        const since = live.current.running.get(key)?.since || Date.now();
        live.current.running.delete(key);
        push({ kind: "tool", event, ms: Date.now() - since });
        dirty.current = true;
      },
      onModel: (slot, depth) => {
        if (depth === 0) {
          live.current.model = slot;
          dirty.current = true;
        }
      },
      onAnswer: (slot) => {
        answered.current = slot;
        dirty.current = true;
      },
      onNotice: (message) => {
        flushText();
        const text = message.trim();
        // El router avisa cuando cambia de modelo: no es un problema, solo información
        if (text.startsWith("usando ")) {
          push({ kind: "info", text: `↻ sigue con ${text.slice("usando ".length)}` });
          return;
        }
        push({ kind: "notice", text });
      },
      onInfo: (message) => {
        if (message.trim().startsWith("↳")) {
          return;
        }
        push({ kind: "info", text: message });
      },
      onTodos: (list) => setTodos([...list]),
      onStep: () => refresh(),
    };
    app.promptPermission = (request: PermissionRequest, agent) =>
      new Promise<PermissionReply>((resolve) => {
        setDialog({
          kind: "permission",
          request,
          agent: agent.name,
          resolve: (choice) => {
            if (choice.grant === "kind") {
              app.grants.allowKind(request.kind);
            } else if (choice.grant === "pattern" && choice.pattern) {
              app.grants.allowPattern("bash", choice.pattern);
            }
            setDialog(null);
            resolve(choice.reply);
          },
        });
      });

    const timer = setInterval(() => {
      if (dirty.current) {
        dirty.current = false;
        refresh();
      }
    }, 60);

    // Tareas de arranque en segundo plano
    let starting: Promise<void> = Promise.resolve();
    for (const notice of configNotices) {
      push({ kind: "notice", text: notice });
    }
    if (app.agent.session.log.length > 0) {
      replay(app.agent.session);
    }
    if (app.router.slots.length === 0) {
      push({
        kind: "notice",
        text: "Todavía no tienes ningún modelo. Elige un proveedor gratuito y pega su clave (puedes repetirlo con /connect).",
      });
      void app.connect(adapter, "").then(refresh);
    } else if (app.needsPrivacyNotice()) {
      starting = askPrivacy();
    } else if (app.onlyAnonymous()) {
      push({ kind: "info", text: app.anonymousNotice() });
    }
    void app.startMcp(refresh).then(() => {
      for (const server of app.mcp?.status() || []) {
        if (server.state === "error") {
          push({ kind: "notice", text: `MCP ${server.name}: ${server.error}` });
        }
      }
      refresh();
    });
    // Una vez al día mira en GitHub si hay una versión nueva de vipcode
    if (app.config.checkUpdates !== false) {
      void checkForUpdate().then((version) => {
        if (version) {
          push({ kind: "notice", text: `Hay una versión nueva de vipcode (${version}, tienes la ${VERSION}). Escribe /update para instalarla.` });
        }
      });
    }
    if (app.config.autoUpdateModels && discoveryIsStale()) {
      void app
        .refreshModels()
        .then((summary) => {
          const added = summary.updated.reduce((total, entry) => total + entry.added.length, 0);
          if (added > 0) {
            push({ kind: "info", text: `He encontrado ${added} modelos gratis nuevos (/models para verlos).` });
          }
          refresh();
        })
        .catch(() => {});
    }
    void app.snapshots.cleanup().catch(() => {});
    // El mensaje con el que se abrió (vipcode "tarea") espera a que contestes el aviso de privacidad
    void starting.then(() => {
      if (props.initial.trim() !== "") {
        void submit(props.initial);
      }
    });
    return () => clearInterval(timer);
  }, []);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (dialog || suggestionsClosed) {
      return [];
    }
    const before = editor.value.slice(0, editor.cursor);
    if (editor.value.startsWith("/") && !before.includes(" ") && !editor.value.includes("\n")) {
      const typed = before.slice(1).toLowerCase();
      return app
        .commandSuggestions()
        .filter((command) => command.name.startsWith(typed))
        .slice(0, 8)
        .map((command) => ({
          label: `/${command.name}`,
          description: command.description,
          apply: () => {
            const value = `/${command.name} `;
            return { value, cursor: value.length };
          },
          submit: !command.needsArgs,
        }));
    }
    const mention = E.mentionAtCursor(editor);
    if (mention) {
      return suggestFiles(app.root, mention.text).map((file) => ({
        label: `@${file}`,
        apply: (state: E.EditorState) => E.replaceRange(state, mention.start, state.cursor, `@${file}${file.endsWith("/") ? "" : " "}`),
        submit: false,
      }));
    }
    return [];
  }, [editor, dialog, suggestionsClosed]);
  const suggestionsVisible = suggestions.length > 0;
  const selected = Math.min(selectedSuggestion, Math.max(0, suggestions.length - 1));

  const update = (state: E.EditorState) => {
    setEditor(state);
    setSuggestionsClosed(false);
    setSelectedSuggestion(0);
  };

  const accept = (andSubmit: boolean) => {
    const suggestion = suggestions[selected];
    if (!suggestion) {
      return;
    }
    const next = suggestion.apply(editor);
    if (andSubmit && suggestion.submit) {
      void submit(next.value);
      return;
    }
    update(next);
    if (!suggestion.label.endsWith("/")) {
      setSuggestionsClosed(true);
    }
  };

  const attachImage = (dataUrl: string, label: string) => {
    setAttachments((previous) => [...previous, dataUrl]);
    push({ kind: "info", text: `Imagen adjuntada: ${label}` });
  };

  useInput((input, key) => {
    // Ctrl+C funciona siempre: interrumpe, cierra el diálogo, borra lo escrito o sale
    if (key.ctrl && input === "c") {
      if (busy && controller.current) {
        controller.current.abort();
        cancelDialog();
        return;
      }
      if (dialogRef.current) {
        cancelDialog();
        return;
      }
      if (editor.value !== "") {
        update(E.EMPTY);
        return;
      }
      if (Date.now() - lastCtrlC.current < 1500) {
        void quit();
        return;
      }
      lastCtrlC.current = Date.now();
      push({ kind: "info", text: "(pulsa Ctrl+C otra vez para salir)" });
      return;
    }
    if (dialogRef.current) {
      // Los diálogos tienen su propio teclado; Esc en el de permisos ya contesta que no
      return;
    }
    if (key.escape) {
      if (suggestionsVisible) {
        setSuggestionsClosed(true);
      } else if (busy && controller.current) {
        controller.current.abort();
      }
      return;
    }
    // Algunas terminales mandan \n en vez de \r al pulsar Enter
    if (key.return || input === "\n") {
      if (key.meta || key.shift) {
        update(E.insert(editor, "\n"));
        return;
      }
      if (suggestionsVisible) {
        accept(true);
        return;
      }
      if (editor.value.endsWith("\\") && editor.cursor === editor.value.length) {
        update({ value: `${editor.value.slice(0, -1)}\n`, cursor: editor.value.length });
        return;
      }
      void submit(editor.value);
      return;
    }
    if (key.tab) {
      if (suggestionsVisible) {
        accept(false);
        return;
      }
      if (!busy) {
        const next = app.cycleAgent(key.shift ? -1 : 1);
        setAgentName(next.name);
      }
      return;
    }
    if (key.upArrow) {
      if (suggestionsVisible) {
        setSelectedSuggestion(Math.max(0, selected - 1));
        return;
      }
      const moved = E.moveVertical(editor, -1);
      if (moved) {
        setEditor(moved);
        return;
      }
      const list = history.current;
      if (list.length === 0) {
        return;
      }
      if (historyIndex.current === null) {
        draft.current = editor.value;
        historyIndex.current = list.length;
      }
      if (historyIndex.current > 0) {
        historyIndex.current--;
        const value = list[historyIndex.current];
        setEditor({ value, cursor: value.length });
        setSuggestionsClosed(true);
      }
      return;
    }
    if (key.downArrow) {
      if (suggestionsVisible) {
        setSelectedSuggestion(Math.min(suggestions.length - 1, selected + 1));
        return;
      }
      const moved = E.moveVertical(editor, 1);
      if (moved) {
        setEditor(moved);
        return;
      }
      if (historyIndex.current === null) {
        return;
      }
      historyIndex.current++;
      if (historyIndex.current >= history.current.length) {
        historyIndex.current = null;
        setEditor({ value: draft.current, cursor: draft.current.length });
      } else {
        const value = history.current[historyIndex.current];
        setEditor({ value, cursor: value.length });
      }
      setSuggestionsClosed(true);
      return;
    }
    if (key.leftArrow) {
      setEditor(E.moveLeft(editor, key.meta || key.ctrl));
      return;
    }
    if (key.rightArrow) {
      setEditor(E.moveRight(editor, key.meta || key.ctrl));
      return;
    }
    if (key.home || (key.ctrl && input === "a")) {
      setEditor(E.lineStart(editor));
      return;
    }
    if (key.end || (key.ctrl && input === "e")) {
      setEditor(E.lineEnd(editor));
      return;
    }
    if (key.backspace) {
      update(key.meta ? E.deleteWordBack(editor) : E.backspace(editor));
      return;
    }
    if (key.delete) {
      update(E.deleteForward(editor));
      return;
    }
    if (key.ctrl) {
      if (input === "u") {
        update(E.deleteToLineStart(editor));
      } else if (input === "k") {
        update(E.deleteToLineEnd(editor));
      } else if (input === "w") {
        update(E.deleteWordBack(editor));
      } else if (input === "j") {
        update(E.insert(editor, "\n"));
      } else if (input === "p") {
        void openPalette();
      } else if (input === "d") {
        if (editor.value === "") {
          void quit();
        } else {
          update(E.deleteForward(editor));
        }
      } else if (input === "v") {
        void readClipboardImage().then((image) => {
          if (image) {
            attachImage(image, "portapapeles");
          } else {
            push({ kind: "info", text: "No hay ninguna imagen en el portapapeles (para texto usa Cmd+V)." });
          }
        });
      }
      return;
    }
    if (key.meta) {
      if (input === "b") {
        setEditor(E.moveLeft(editor, true));
      } else if (input === "f") {
        setEditor(E.moveRight(editor, true));
      }
      return;
    }
    if (input) {
      // Algunas terminales mandan "texto + Enter" de golpe: el Enter final envía, no es un salto de línea
      if (input.length > 1 && /[\r\n]$/.test(input) && !/[\r\n]/.test(input.slice(0, -1))) {
        void submit(E.insert(editor, input.slice(0, -1)).value);
        return;
      }
      update(E.insert(editor, input.replace(/\r\n?/g, "\n")));
    }
  });

  usePaste(
    (text) => {
      // Arrastrar una imagen a la terminal pega su ruta: la adjuntamos como imagen
      const candidate = text.trim().replace(/^['"]|['"]$/g, "").replace(/\\ /g, " ");
      if (isImagePath(candidate)) {
        const file = path.resolve(app.root, candidate);
        if (fs.existsSync(file)) {
          try {
            attachImage(toDataUrl(file), path.basename(file));
          } catch (err) {
            push({ kind: "error", text: (err as Error).message });
          }
          return;
        }
      }
      update(E.insert(editor, text.replace(/\r\n?/g, "\n")));
    },
    { isActive: !dialog },
  );

  const agent = app.agents.find((item) => item.name === agentName);
  const color = agent?.color || "magenta";
  // La zona en directo no puede pasar del alto de la pantalla (Ink no sabe borrar lo que se ha ido hacia arriba)
  const liveRoom = Math.max(4, rows - 14);
  const liveText = live.current.text ? lastLines(renderMarkdown(live.current.text, Math.max(20, columns - 4)), liveRoom) : "";
  const running = [...live.current.running.values()];
  const shell = live.current.shell;

  let dialogView: React.ReactNode = null;
  if (dialog?.kind === "permission") {
    const lines = dialog.request.preview.split("\n");
    const room = Math.max(6, rows - 16);
    let request = dialog.request;
    if (lines.length > room) {
      request = { ...request, preview: `${lines.slice(0, room).join("\n")}\n… ${lines.length - room} líneas más` };
    }
    dialogView = <PermissionDialog key="permission" request={request} agent={dialog.agent} onDone={dialog.resolve} />;
  } else if (dialog?.kind === "select") {
    dialogView = <SelectDialog key="select" title={dialog.title} items={dialog.items} onDone={dialog.resolve} />;
  } else if (dialog?.kind === "prompt") {
    dialogView = <PromptDialog key="prompt" title={dialog.title} mask={dialog.mask} placeholder={dialog.placeholder} onDone={dialog.resolve} />;
  }

  let placeholder = "Escribe tu mensaje… (@ ficheros · / comandos · ! terminal · Ctrl+P paleta)";
  if (busy) {
    placeholder = "Escribe para añadir instrucciones mientras trabaja…";
  }

  return (
    <>
      <Static items={items}>{(item) => <ItemView key={item.id} item={item} app={app} width={columns} />}</Static>
      <Box flexDirection="column">
        {live.current.reasoning ? (
          <Text dimColor italic wrap="truncate-end">
            💭 {lastLines(stripControl(live.current.reasoning).replace(/\s+/g, " "), 1).slice(-Math.max(20, columns - 6))}
          </Text>
        ) : null}
        {liveText ? (
          <Box marginTop={1}>
            <Text color={color}>● </Text>
            <Box flexDirection="column" flexGrow={1}>
              <Text>
                {liveText}
                <Text color={color}>▍</Text>
              </Text>
            </Box>
          </Box>
        ) : null}
        {running.map(({ event, progress, since }) => (
          <Box key={`${event.depth}:${event.id}`} flexDirection="column" marginLeft={event.depth > 0 ? 4 : 0}>
            <Text wrap="truncate-end">
              <Spinner /> <ToolHeader name={event.name} summary={event.summary} /> <Elapsed since={since} hideUnderMs={2000} />
            </Text>
            {progress ? (
              <Text dimColor wrap="truncate-end">
                {"    "}
                {lastLines(stripControl(progress), 1).slice(0, Math.max(20, columns - 8))}
              </Text>
            ) : null}
          </Box>
        ))}
        {shell ? (
          <Box flexDirection="column" marginTop={1}>
            <Text>
              <Spinner color="yellow" /> <Text bold>{showControl(shell.command)}</Text> <Elapsed since={startedAt.current} hideUnderMs={1000} />
            </Text>
            {shell.output ? <Text dimColor>{lastLines(stripControl(shell.output), Math.min(8, liveRoom)).replace(/^/gm, "  ")}</Text> : null}
          </Box>
        ) : null}
        <TodoPanel todos={todos} />
        {busy && !shell && running.length === 0 && !liveText && !answered.current ? (
          <Box marginTop={1}>
            <Text wrap="truncate-end">
              <Spinner /> <Text dimColor>Pensando{live.current.model ? ` con ${live.current.model}` : ""}… </Text>
              <Elapsed since={startedAt.current} hideUnderMs={1000} />
            </Text>
          </Box>
        ) : null}
        {dialogView || (
          <InputBox
            editor={editor}
            color={color}
            placeholder={placeholder}
            attachments={attachments.length}
            maxLines={Math.max(3, Math.floor(rows / 2) - 4)}
            width={columns}
          />
        )}
        {suggestionsVisible && !dialog ? (
          <Box flexDirection="column" paddingX={2}>
            {suggestions.map((suggestion, index) => (
              <Text key={`${index}-${suggestion.label}`} color={index === selected ? "cyan" : undefined} wrap="truncate-end">
                {index === selected ? "❯ " : "  "}
                {suggestion.label}
                {suggestion.description ? <Text dimColor> {suggestion.description}</Text> : null}
              </Text>
            ))}
          </Box>
        ) : null}
        <StatusBar app={app} agentName={agentName} busy={busy} model={busy ? live.current.model : ""} />
      </Box>
    </>
  );
}

export async function startTui(app: App, options: { initial?: string } = {}) {
  const instance = render(<Main app={app} initial={options.initial || ""} />, {
    exitOnCtrlC: false,
    kittyKeyboard: { mode: "auto" },
  });
  await instance.waitUntilExit();
}
