import fs from "node:fs";
import path from "node:path";
import { Box, Static, Text, render, useAnimation, useApp, useInput, usePaste, useWindowSize } from "ink";
import pc from "picocolors";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ToolEvent, UserInput } from "../agent.js";
import type { App, Progress, RunOptions, SelectItem, UiAdapter } from "../app.js";
import { configNotices } from "../config.js";
import { discoveryIsStale } from "../discovery.js";
import { isImagePath, readClipboardImage, toDataUrl } from "../images.js";
import { providerName, quotaFor } from "../limits.js";
import { renderMarkdown } from "../markdown.js";
import type { PermissionReply, PermissionRequest } from "../permissions.js";
import { NoSlotError } from "../router.js";
import { showControl, stripControl } from "../sanitize.js";
import { type Session, appendHistory, loadHistory, sessionMarkdownPath } from "../session.js";
import { type Todo, suggestFiles } from "../tools.js";
import { type TutorialCard, tutorialCard } from "../tutorial.js";
import { colorPreview } from "../ui.js";
import { CHECK_MS, checkForUpdate, stepProgress } from "../update.js";
import { INTERFACES, interfaceFor } from "../interfaces.js";
import { useConversation } from "./conversation.js";
import { type PermissionChoice, PermissionDialog, PromptDialog, SelectDialog } from "./dialogs.js";
import * as E from "./editor.js";
import { Bullet, type Item, ItemView, type NewItem, ToolHeader, formatDuration, oneLine, shortTokens, tildify } from "./items.js";
import { look, setLook } from "./theme.js";

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

function Elapsed(props: { since: number; hideUnderMs?: number }) {
  useAnimation({ interval: 1000 });
  const ms = Date.now() - props.since;
  if (props.hideUnderMs && ms < props.hideUnderMs) {
    return null;
  }
  return <Text dimColor={look.dim}>{formatDuration(ms)}</Text>;
}

// Barra de carga (/update): el paso en el que va, cuánto lleva hecho y el tiempo
function ProgressBar(props: { progress: Progress & { since: number; stepSince: number }; width: number }) {
  useAnimation({ interval: 100 });
  const value = stepProgress(props.progress, Date.now() - props.progress.stepSince);
  const cells = Math.max(10, Math.min(30, props.width - 60));
  const filled = Math.round(value * cells);
  return (
    <Box flexDirection="column" marginTop={look.gap}>
      <Text>
        <Spinner color={look.tone("green")} /> <Text bold>{props.progress.title}</Text>
      </Text>
      <Text wrap="truncate-end">
        {"  "}
        <Text color={look.tone("green")}>{"█".repeat(filled)}</Text>
        <Text dimColor={look.dim}>{"░".repeat(cells - filled)}</Text> {Math.floor(value * 100)} %
        <Text dimColor={look.dim}> · {stripControl(props.progress.text)}… · </Text>
        <Elapsed since={props.progress.since} />
      </Text>
    </Box>
  );
}

function lastLines(text: string, count: number): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.slice(-count).join("\n");
}

function TodoPanel(props: { todos: Todo[] }) {
  const open = props.todos.some((todo) => todo.status === "pending" || todo.status === "in_progress");
  if (!open) {
    return null;
  }
  const done = props.todos.filter((todo) => todo.status === "completed").length;
  return (
    <Box flexDirection="column" marginTop={look.gap} paddingX={1}>
      <Text dimColor={look.dim}>
        Tareas ({done}/{props.todos.length})
      </Text>
      {props.todos.slice(0, 10).map((todo, index) => {
        if (todo.status === "completed") {
          return (
            <Text key={index} color={look.tone("green")} strikethrough>
              ☑ {stripControl(todo.content)}
            </Text>
          );
        }
        if (todo.status === "in_progress") {
          return (
            <Text key={index} color={look.tone("yellow")}>
              ◐ {stripControl(todo.content)}
            </Text>
          );
        }
        if (todo.status === "cancelled") {
          return (
            <Text key={index} dimColor={look.dim} strikethrough>
              ☒ {stripControl(todo.content)}
            </Text>
          );
        }
        return <Text key={index}>☐ {stripControl(todo.content)}</Text>;
      })}
      {props.todos.length > 10 ? <Text dimColor={look.dim}>… y {props.todos.length - 10} más</Text> : null}
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
    <Box
      flexDirection="column"
      // Compacta y zen: solo una raya encima, para que quepa más conversación
      borderStyle={look.bare ? "single" : "round"}
      borderLeft={!look.bare}
      borderRight={!look.bare}
      borderBottom={!look.bare}
      borderColor={look.tone(color)}
      borderDimColor={look.bare && look.dim}
      paddingX={look.bare ? 0 : 1}
      marginTop={look.gap}
    >
      {props.attachments > 0 ? (
        <Text color={look.tone("cyan")}>
          {Array.from({ length: props.attachments }, (_, i) => `[Imagen ${i + 1}]`).join(" ")}
          <Text dimColor={look.dim}> (se envían con el próximo mensaje)</Text>
        </Text>
      ) : null}
      {start > 0 ? <Text dimColor={look.dim}>  ↑ {start} líneas más</Text> : null}
      {lines.slice(start, end).map((text, offset) => {
        const index = start + offset;
        // En líneas larguísimas se enseña el trozo donde está el cursor
        const from = index === line ? Math.max(0, column - Math.floor(maxChars / 2)) : 0;
        return (
          <Text key={index}>
            <Text color={look.tone(color)}>{index === 0 ? (shell ? "$ " : "❯ ") : "  "}</Text>
            {editor.value === "" ? (
              <>
                <Text inverse> </Text>
                <Text dimColor={look.dim}>{props.placeholder}</Text>
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
      {end < lines.length ? <Text dimColor={look.dim}>  ↓ {lines.length - end} líneas más</Text> : null}
      {shell ? <Text dimColor={look.dim}>Enter lo ejecuta en {tildify(process.cwd())} · el agente verá la salida</Text> : null}
    </Box>
  );
}

// Medidor de contexto: ▰▰▰▱▱▱▱▱ 34 %
// Texto del indicador de contexto («75% de 128k», o solo «75%» si falta sitio)
function gaugeLabel(used: number, total: number, detail: boolean): string {
  const percent = `${Math.round(Math.min(1, used / total) * 100)}%`;
  return detail ? `${percent} de ${shortTokens(total)}` : percent;
}

function ContextGauge(props: { used: number; total: number; detail: boolean }) {
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
      <Text dimColor={look.dim}> · </Text>
      <Text color={look.tone(color)}>{"▰".repeat(filled)}</Text>
      <Text dimColor={look.dim}>
        {"▱".repeat(8 - filled)} {gaugeLabel(props.used, props.total, props.detail)}
      </Text>
    </Text>
  );
}

// Líneas de vista previa que caben en el diálogo de permiso (la zona en directo no puede pasar del alto de la pantalla)
function permissionRoom(rows: number): number {
  return Math.max(6, rows - 16);
}

function StatusBar(props: { app: App; agentName: string; busy: boolean; model: string; width: number; flash?: string | null }) {
  const { app } = props;
  const agent = app.agents.find((item) => item.name === props.agentName);
  const current = props.model || app.router.pinned || app.agent.lastSlot;
  const slot = app.router.slotFor(current);
  const context = app.router.slotFor(app.agent.lastSlot)?.model.context || 0;
  const available = app.router.availableCount();
  const usage = app.agent.session.usage;
  const spent = usage.prompt + usage.completion;
  const queued = app.agent.queue.length;
  // Cuánto queda del plan gratis del modelo en uso (/limites lo enseña todo)
  const quota = slot ? quotaFor(app.router, slot) : null;
  let quotaColor: string | undefined;
  if (quota && quota.remaining <= 0) {
    quotaColor = "red";
  } else if (quota && quota.limit && quota.remaining / quota.limit <= 0.1) {
    quotaColor = "yellow";
  }
  // A la derecha, la ayuda (y su versión corta por si no cabe)
  let hint = { text: "ctrl+p comandos · /help", short: "/help", color: undefined as string | undefined, bold: false };
  if (props.flash) {
    hint = { text: props.flash, short: props.flash, color: "green", bold: false };
  } else if (props.busy) {
    hint = { text: "esc interrumpe · escribe para añadir instrucciones", short: "esc interrumpe", color: undefined, bold: false };
  } else if (app.updateInstalled) {
    hint = { text: "✓ vipcode actualizado · ciérralo y vuelve a abrirlo para usarlo", short: "✓ reinicia vipcode", color: "green", bold: false };
  } else if (app.newVersion && app.newVersionSecurity) {
    const version = stripControl(app.newVersion);
    hint = { text: `↑ vipcode ${version} trae arreglos de seguridad · escribe /update`, short: `↑ ${version} seguridad · /update`, color: "red", bold: true };
  } else if (app.newVersion) {
    const version = stripControl(app.newVersion);
    hint = { text: `↑ vipcode ${version} disponible · escribe /update`, short: `↑ ${version} · /update`, color: "green", bold: true };
  }

  // Si no cabe todo en una línea se va quitando, por este orden (primero lo que menos falta hace): la ayuda larga, los
  // tokens, el detalle del contexto, los modelos disponibles, la nota del modelo, su nombre largo («kilo/nvidia/x» →
  // «nvidia/x» → «x»), la ayuda corta, el medidor de contexto si todavía no avisa de nada y, lo último, de quién es el
  // límite (es lo que dice a qué se refiere «quedan 46/50»)
  // En la zen, lo justo: el agente, el modelo y lo que queda (y a la derecha solo los avisos que importan)
  const lean = look.minimal;
  const fit = { hint: lean && !hint.color && !props.busy ? 0 : 2, tokens: spent > 0 && !lean, detail: !lean, models: !lean, score: !lean, name: 0, gauge: !lean, who: true };
  const names = [current || "rotación automática", slot?.model.id, slot?.model.id.split("/").pop()];
  const model = () => ` · ${names[fit.name] || names[0]}${slot && slot.score !== null && fit.score ? ` ★${slot.score}` : ""}${app.router.pinned ? " (fijado)" : ""}`;
  const gauge = () => fit.gauge && app.agent.lastTokens > 0 && context > 0;
  // De quién es el límite: «OpenRouter: quedan 46/50 hoy»
  const quotaText = () => (quota && slot && fit.who ? `${providerName(slot.provider)}: ${quota.short}` : quota?.short || "");
  const hintText = () => [" ", hint.short, hint.text][fit.hint].trim();
  const width = () =>
    props.agentName.length +
    model().length +
    (quota ? quotaText().length + 3 : 0) +
    (gauge() ? 12 + gaugeLabel(app.agent.lastTokens, context, fit.detail).length : 0) +
    (fit.models ? ` · ${available}/${app.router.slots.length} modelos`.length : 0) +
    (fit.tokens ? ` · ${shortTokens(spent)} tokens`.length : 0) +
    (queued > 0 ? ` · ${queued} en cola`.length : 0) +
    (app.yolo ? 7 : 0) +
    (hintText() ? 2 + hintText().length : 0);
  const warning = context > 0 && app.agent.lastTokens / context >= 0.6;
  const steps = [
    () => (fit.hint = 1),
    () => (fit.tokens = false),
    () => (fit.detail = false),
    () => (fit.models = false),
    () => (fit.score = false),
    () => (fit.name = 1),
    () => (fit.name = 2),
    () => (fit.hint = 0),
    () => (fit.gauge = warning),
    () => (fit.who = false),
  ];
  const room = props.width - 2;
  for (const step of steps) {
    if (width() <= room) {
      break;
    }
    step();
  }

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text wrap="truncate-end">
        <Text bold color={look.tone(agent?.color || "magenta")}>
          {props.agentName}
        </Text>
        <Text dimColor={look.dim}>{model()}</Text>
        {quota ? (
          <Text color={look.tone(quotaColor)} dimColor={look.dim && !quotaColor}>
            {" "}
            · {stripControl(quotaText())}
          </Text>
        ) : null}
        {gauge() ? <ContextGauge used={app.agent.lastTokens} total={context} detail={fit.detail} /> : null}
        <Text dimColor={look.dim}>
          {fit.models ? ` · ${available}/${app.router.slots.length} modelos` : ""}
          {fit.tokens ? ` · ${shortTokens(spent)} tokens` : ""}
          {queued > 0 ? ` · ${queued} en cola` : ""}
        </Text>
        {app.yolo ? <Text color={look.tone("red")}> · yolo</Text> : null}
      </Text>
      {hintText() ? (
        <Text wrap="truncate-start" color={look.tone(hint.color)} dimColor={look.dim && !hint.color} bold={hint.bold}>
          {hintText()}
        </Text>
      ) : null}
    </Box>
  );
}

// «switched»: la interfaz que se acaba de elegir con /interfaz, si se ha rehecho la pantalla para pasar a la clásica o
// volver de ella (entonces sigue la misma conversación y no se repite lo del arranque)
function Main(props: { app: App; initial: string; fullscreen: boolean; switched: string | null }) {
  const { app } = props;
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [items, setItems] = useState<Item[]>([{ id: 0, kind: "banner" }]);
  const nextId = useRef(1);
  const [editor, setEditor] = useState<E.EditorState>(E.EMPTY);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [todos, setTodos] = useState<Todo[]>(app.agent.session.todos);
  const [progress, setProgress] = useState<(Progress & { since: number; stepSince: number }) | null>(null);
  // La interfaz (/interfaz) y la conversación en pantalla completa: scroll, selección, Ctrl+F y herramientas que se
  // despliegan
  const [interfaceId, setInterfaceId] = useState(look.interface.id);
  const conversation = useConversation({ app, items, columns, rows, fullscreen: props.fullscreen, dialog, interfaceId });
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
      progress: (state) => setProgress((previous) => (state ? { ...state, since: previous?.since ?? Date.now(), stepSince: Date.now() } : null)),
      updated: (version) => push({ kind: "updated", version }),
      tutorial: (card) => push({ kind: "tutorial", ...card }),
      setInterface: (id: string) => {
        const next = INTERFACES.find((item) => item.id === id) || INTERFACES[0];
        if (next.fullscreen !== props.fullscreen) {
          // Entre la clásica y la pantalla completa hay que rehacer la pantalla (startTui la vuelve a abrir)
          app.switchInterface = next.id;
          exit();
          return;
        }
        setLook(next);
        setInterfaceId(next.id);
        push({ kind: "info", text: `Interfaz «${next.label}».` });
      },
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

  // «Reiniciar ahora» tras /update: se cierra la interfaz y la versión nueva la abre index.ts (este proceso no sale)
  const restart = async () => {
    controller.current?.abort();
    cancelDialog();
    await app.shutdown();
    exit();
  };

  const sessionTokens = () => app.agent.session.usage.prompt + app.agent.session.usage.completion;

  // Si lo que acaba de pasar completa el paso del tutorial, el siguiente
  const tutorialStep = (card: TutorialCard | null) => {
    if (card) {
      push({ kind: "tutorial", ...card });
    }
  };

  const runAgent = async (input: UserInput, options: RunOptions) => {
    const ranAs = options.agent || app.agent.agent.name;
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
      // Si se acaban las peticiones gratis de hoy, la cuenta gratis que más da (una vez por proveedor)
      const tip = app.lowQuotaTip();
      if (tip) {
        push({ kind: "notice", text: tip });
      }
      tutorialStep(app.tutorialEvent({ kind: "message", text: input.text, agent: ranAs }));
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
      tutorialStep(app.tutorialEvent({ kind: "shell", text: command, agent: app.agent.agent.name }));
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
    // Mientras se instala la versión nueva, nada más: que no se mezclen ficheros de las dos versiones
    if (progress) {
      push({ kind: "error", text: "Espera a que termine la actualización." });
      return;
    }
    setEditor(E.EMPTY);
    historyIndex.current = null;
    // Al escribir se vuelve abajo del todo (y se quita lo seleccionado)
    conversation.toBottom();
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
        if (result.restart) {
          await restart();
          return;
        }
        tutorialStep(app.tutorialEvent({ kind: "command", text, agent: app.agent.agent.name }));
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
    const choice = await adapter.select!(`¡Te damos la bienvenida a vipcode!\n${app.privacyNotice()}`, [
      { label: "Empezar", description: "con las IAs gratuitas sin registro", value: "ok" },
      { label: "Conectar antes una cuenta gratuita", description: "para tener más mensajes y más modelos", value: "connect" },
      { label: "Prefiero usar solo mis cuentas", description: "y no las IAs sin registro", value: "off" },
    ]);
    if (!choice) {
      // Con Esc se vuelve a preguntar la próxima vez
      return;
    }
    app.acceptPrivacyNotice();
    if (app.tutorialStep === null) {
      push({ kind: "info", text: "¿Es tu primera vez con vipcode? Escribe /tutorial: en 5 pasos aprendes lo básico, sin tocar tus ficheros." });
    }
    if (choice === "connect") {
      await app.connect(adapter, "");
    } else if (choice === "off") {
      app.disableKeyless();
      push({ kind: "info", text: 'Hecho: solo usaré las cuentas que conectes. Si cambias de idea, pon "keyless": true en tu configuración (/config te dice dónde está).' });
      if (app.router.slots.length === 0) {
        await app.connect(adapter, "");
      }
    }
    refresh();
  };

  // La conversación de una sesión a la que vuelves, tal como la viste
  const replay = (session: Session, same = false) => {
    const entries = session.log;
    if (entries.length === 0) {
      push({ kind: "info", text: `Sesión «${session.title}» cargada.` });
      return;
    }
    const shown = entries.slice(-REPLAY_MAX);
    push({
      kind: "info",
      text: same ? "── Sigue la misma conversación ──" : `── Conversación anterior: «${session.title}» · ${new Date(session.updated).toLocaleString()} ──`,
    });
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
        // Un comando que no cabe en el diálogo se escribe entero en el historial antes de preguntar: lo que apruebas
        // tienes que poder leerlo todo, y 30 líneas inofensivas podrían esconder una maliciosa al final
        if (request.kind === "bash" && request.preview.split("\n").length > permissionRoom(process.stdout.rows || 24)) {
          push({ kind: "block", text: `${pc.yellow("Comando entero que pide ejecutar:")}\n${colorPreview(request.preview, look.faint)}` });
        }
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
    const switched = INTERFACES.find((item) => item.id === props.switched);
    if (switched) {
      // Se ha rehecho la pantalla para cambiar de interfaz: sigue la misma conversación, sin repetir lo del arranque
      push({ kind: "info", text: `Interfaz «${switched.label}».` });
      if (app.agent.session.log.length > 0) {
        replay(app.agent.session, true);
      }
    }
    for (const notice of switched ? [] : configNotices) {
      push({ kind: "notice", text: notice });
    }
    if (!switched && app.agent.session.log.length > 0) {
      replay(app.agent.session);
    }
    if (switched) {
      // nada más: lo demás ya se hizo al abrir vipcode
    } else if (app.router.slots.length === 0) {
      push({
        kind: "notice",
        text: "Para empezar, conecta una IA gratuita: elige una de la lista y sigue los pasos (puedes repetirlo cuando quieras con /connect).",
      });
      void app.connect(adapter, "").then(refresh);
    } else if (app.needsPrivacyNotice()) {
      starting = askPrivacy();
    } else if (app.onlyAnonymous()) {
      push({ kind: "info", text: app.anonymousNotice() });
    }
    void (switched ? Promise.resolve() : app.startMcp(refresh)).then(() => {
      for (const server of app.mcp?.status() || []) {
        if (server.state === "error") {
          push({ kind: "notice", text: `MCP ${server.name}: ${server.error}` });
        }
      }
      refresh();
    });
    // En Windows sin Git para Windows, el consejo de instalarlo (una vez al día)
    const gitNotice = switched ? null : app.gitNotice();
    if (gitNotice) {
      push({ kind: "notice", text: gitNotice });
    }
    // La primera vez que abres una versión nueva, lo que trae
    const news = app.takeNews();
    if (news) {
      push({ kind: "news", ...news });
    }
    // «vipcode tutorial»: el primer paso
    if (app.tutorialStep !== null) {
      push({ kind: "tutorial", ...tutorialCard(app.tutorialStep) });
    }
    // Mira en npm y GitHub si hay una versión nueva de vipcode (como mucho una vez por hora). Al abrirlo la anuncia
    // con el recuadro; si sale con vipcode abierto, en la barra de abajo
    let updates: ReturnType<typeof setInterval> | undefined;
    if (app.config.checkUpdates !== false) {
      void checkForUpdate().then((update) => {
        if (update) {
          app.newVersion = update.version;
          app.newVersionSecurity = update.security;
          if (!switched) {
            push({ kind: "update", version: update.version, security: update.security });
          }
        }
      });
      updates = setInterval(() => {
        void checkForUpdate().then((update) => {
          if (update && !app.updateInstalled && update.version !== app.newVersion) {
            app.newVersion = update.version;
            app.newVersionSecurity = update.security;
            refresh();
          }
        });
      }, CHECK_MS / 6);
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
    return () => {
      clearInterval(timer);
      clearInterval(updates);
    };
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
    // AvPág/RePág y Ctrl+Inicio/Ctrl+Fin mueven la conversación (lo hace el useInput de arriba)
    if (props.fullscreen && (key.pageUp || key.pageDown || (key.ctrl && (key.home || key.end)))) {
      return;
    }
    // Ctrl+F: buscar en la conversación (mientras, el teclado es de la búsqueda)
    if (conversation.searching.current) {
      return;
    }
    if (props.fullscreen && key.ctrl && input === "f" && !dialogRef.current) {
      conversation.openSearch();
      return;
    }
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
    if ((key.home && !key.ctrl) || (key.ctrl && input === "a")) {
      setEditor(E.lineStart(editor));
      return;
    }
    if ((key.end && !key.ctrl) || (key.ctrl && input === "e")) {
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
    { isActive: !dialog && conversation.searchBar === null },
  );

  const agent = app.agents.find((item) => item.name === agentName);
  const color = agent?.color || "magenta";
  // La zona en directo no puede pasar del alto de la pantalla (Ink no sabe borrar lo que se ha ido hacia arriba)
  const liveRoom = Math.max(4, rows - 14);
  const liveText = live.current.text ? lastLines(renderMarkdown(live.current.text, Math.max(20, columns - 4), { faint: look.faint }), liveRoom) : "";
  const running = [...live.current.running.values()];
  const shell = live.current.shell;

  let dialogView: React.ReactNode = null;
  if (dialog?.kind === "permission") {
    const lines = dialog.request.preview.split("\n");
    const room = permissionRoom(rows);
    let request = dialog.request;
    if (lines.length > room) {
      const where = dialog.request.kind === "bash" ? ": el comando entero está justo encima, léelo antes de aprobarlo" : "";
      request = { ...request, preview: `${lines.slice(0, room).join("\n")}\n… ${lines.length - room} líneas más${where}` };
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

  // Lo de abajo: lo que está pasando ahora, la caja de escribir (o el diálogo) y la barra
  const bottom = (
    <Box flexDirection="column" flexShrink={0}>
      {live.current.reasoning ? (
        <Text dimColor={look.dim} italic wrap="truncate-end">
          💭 {lastLines(stripControl(live.current.reasoning).replace(/\s+/g, " "), 1).slice(-Math.max(20, columns - 6))}
        </Text>
      ) : null}
      {liveText ? (
        <Box marginTop={look.gap}>
          <Bullet color={color} />
          <Box flexDirection="column" flexGrow={1}>
            <Text>
              {liveText}
              <Text color={look.tone(color)}>▍</Text>
            </Text>
          </Box>
        </Box>
      ) : null}
      {running.map(({ event, progress, since }) => (
        <Box key={`${event.depth}:${event.id}`} flexDirection="column" marginLeft={event.depth > 0 ? 4 : 0}>
          <Text wrap="truncate-end">
            <Spinner /> <ToolHeader name={event.name} summary={oneLine(event.summary)} /> <Elapsed since={since} hideUnderMs={2000} />
          </Text>
          {progress ? (
            <Text dimColor={look.dim} wrap="truncate-end">
              {"    "}
              {lastLines(stripControl(progress), 1).slice(0, Math.max(20, columns - 8))}
            </Text>
          ) : null}
        </Box>
      ))}
      {shell ? (
        <Box flexDirection="column" marginTop={look.gap}>
          <Text>
            <Spinner color={look.tone("yellow")} /> <Text bold>{showControl(shell.command)}</Text> <Elapsed since={startedAt.current} hideUnderMs={1000} />
          </Text>
          {shell.output ? <Text dimColor={look.dim}>{lastLines(stripControl(shell.output), Math.min(8, liveRoom)).replace(/^/gm, "  ")}</Text> : null}
        </Box>
      ) : null}
      <TodoPanel todos={todos} />
      {progress ? <ProgressBar progress={progress} width={columns} /> : null}
      {busy && !shell && running.length === 0 && !liveText && !answered.current ? (
        <Box marginTop={look.gap}>
          <Text wrap="truncate-end">
            <Spinner /> <Text dimColor={look.dim}>Pensando{live.current.model ? ` con ${live.current.model}` : ""}… </Text>
            <Elapsed since={startedAt.current} hideUnderMs={1000} />
          </Text>
        </Box>
      ) : null}
      {dialogView ||
        conversation.searchBar || (
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
              {suggestion.description ? <Text dimColor={look.dim}> {suggestion.description}</Text> : null}
            </Text>
          ))}
        </Box>
      ) : null}
      <StatusBar app={app} agentName={agentName} busy={busy} model={busy ? live.current.model : ""} width={columns} flash={conversation.flash} />
    </Box>
  );

  if (props.fullscreen) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        {conversation.viewport}
        {bottom}
      </Box>
    );
  }

  return (
    <>
      {/* Con el ancho fijo: si no, Ink parte las líneas largas al ancho de la terminal sin contar lo que llevan delante
          (el «● » de las respuestas, el borde de tus mensajes) y la terminal las corta por en medio de una palabra */}
      <Static items={items}>
        {(item) => (
          <Box key={item.id} width={columns} flexDirection="column">
            <ItemView item={item} app={app} width={columns} />
          </Box>
        )}
      </Static>
      {bottom}
    </>
  );
}

export async function startTui(app: App, options: { initial?: string } = {}) {
  let initial = options.initial || "";
  let switched: string | null = null;
  let fullscreen = true;
  for (;;) {
    // La interfaz elegida con /interfaz (o en tu configuración): pantalla completa, con su propio scroll, o clásica
    const chosen = interfaceFor(app.config);
    setLook(chosen);
    fullscreen = chosen.fullscreen;
    const instance = render(<Main app={app} initial={initial} fullscreen={fullscreen} switched={switched} />, {
      exitOnCtrlC: false,
      kittyKeyboard: { mode: "auto" },
      alternateScreen: fullscreen,
    });
    await instance.waitUntilExit();
    // /interfaz entre la clásica y la pantalla completa: se vuelve a abrir en el otro modo, con la misma conversación
    if (!app.switchInterface) {
      break;
    }
    switched = app.switchInterface;
    app.switchInterface = null;
    initial = "";
  }
  // La pantalla completa no deja la conversación en la terminal: se recuerda cómo seguir con ella
  if (fullscreen && !app.relaunch && !app.installedVersion && app.agent.session.messages.length > 0) {
    console.log(look.faint("Conversación guardada: «vipcode -c» sigue con ella."));
  }
  // Tras /update sigue abierta la versión de antes: se recuerda cómo abrir la nueva (salvo si ya se va a reiniciar)
  if (app.installedVersion && !app.relaunch) {
    console.log(pc.green(`✓ Abre vipcode otra vez para usar la versión ${stripControl(app.installedVersion)} (vipcode -c sigue con esta conversación).`));
  }
}
