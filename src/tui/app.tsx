import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box, type DOMElement, Static, Text, render, renderToString, useAnimation, useApp, useBoxMetrics, useInput, usePaste, useWindowSize } from "ink";
import pc from "picocolors";
import sliceAnsi from "slice-ansi";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ToolEndEvent, ToolEvent, UserInput } from "../agent.js";
import type { App, Progress, RunOptions, SelectItem, UiAdapter } from "../app.js";
import { configNotices } from "../config.js";
import { discoveryIsStale } from "../discovery.js";
import { isImagePath, readClipboardImage, toDataUrl } from "../images.js";
import { toolLabel } from "../labels.js";
import { providerName, quotaFor } from "../limits.js";
import { renderMarkdown } from "../markdown.js";
import { VERSION } from "../meta.js";
import type { PermissionReply, PermissionRequest } from "../permissions.js";
import { NoSlotError } from "../router.js";
import { showControl, stripControl, stripUnsafe } from "../sanitize.js";
import { type Session, appendHistory, loadHistory, sessionMarkdownPath } from "../session.js";
import { type Todo, suggestFiles } from "../tools.js";
import { type TutorialCard, tutorialCard } from "../tutorial.js";
import { copyToClipboard } from "../clipboard.js";
import { colorPreview } from "../ui.js";
import { CHECK_MS, checkForUpdate, stepProgress } from "../update.js";
import { type PermissionChoice, PermissionDialog, PromptDialog, SelectDialog } from "./dialogs.js";
import * as E from "./editor.js";
import { MOUSE_OFF, MOUSE_ON, type TextPos, lineColumns, mouseEvents, selectedColumns, selectedText, wordAt } from "./mouse.js";
import { type Match, findMatches, scrollThumb } from "./view.js";


type Item =
  | { id: number; kind: "banner" }
  | { id: number; kind: "user"; text: string; images: number; queued?: boolean; color: string }
  | { id: number; kind: "assistant"; text: string; color: string }
  | { id: number; kind: "tool"; event: ToolEndEvent; ms: number }
  // Pie de cada respuesta: qué modelo contestó, cuánto tardó y cuántos tokens gastó
  | { id: number; kind: "answer"; slot: string; score: number | null; ms: number; tokens: number }
  | { id: number; kind: "shell"; command: string; output: string; code: number | null }
  // Recuadro de versión nueva de vipcode
  | { id: number; kind: "update"; version: string; security: boolean }
  // Lo que trae esta versión, la primera vez que la abres
  | { id: number; kind: "news"; version: string; markdown: string; security: boolean }
  // /update ha instalado una versión nueva: hay que reiniciar vipcode para usarla
  | { id: number; kind: "updated"; version: string }
  // El paso del tutorial en el que vas
  | { id: number; kind: "tutorial"; step: number; total: number; title: string; text: string }
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

// Ancho al que se pinta la conversación en pantalla completa: la última columna es para la barra de desplazamiento
function paintWidth(columns: number): number {
  return Math.max(20, columns - 1);
}

// Ctrl+F: lo que buscas y cuántas veces sale
function SearchBar(props: { query: string; index: number; total: number }) {
  let count = "";
  if (props.query !== "") {
    count = props.total === 0 ? "no sale" : `${props.index + 1} de ${props.total}`;
  }
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="yellow" paddingX={1} justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text color="yellow">Buscar: </Text>
          {stripControl(props.query)}
          <Text color="yellow">▍</Text>
        </Text>
        <Text dimColor>{count}</Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        {"  "}Enter o ↑ la anterior · ↓ la siguiente · Esc cierra
      </Text>
    </Box>
  );
}

// Barra de carga (/update): el paso en el que va, cuánto lleva hecho y el tiempo
function ProgressBar(props: { progress: Progress & { since: number; stepSince: number }; width: number }) {
  useAnimation({ interval: 100 });
  const value = stepProgress(props.progress, Date.now() - props.progress.stepSince);
  const cells = Math.max(10, Math.min(30, props.width - 60));
  const filled = Math.round(value * cells);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Spinner color="green" /> <Text bold>{props.progress.title}</Text>
      </Text>
      <Text wrap="truncate-end">
        {"  "}
        <Text color="green">{"█".repeat(filled)}</Text>
        <Text dimColor>{"░".repeat(cells - filled)}</Text> {Math.floor(value * 100)} %
        <Text dimColor> · {stripControl(props.progress.text)}… · </Text>
        <Elapsed since={props.progress.since} />
      </Text>
    </Box>
  );
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
// Lo que está haciendo una herramienta, en una línea: un comando de varias líneas ocuparía media pantalla (y no dejaría
// sitio al diálogo de permiso, donde va entero)
function oneLine(text: string): string {
  const [first, ...rest] = text.split("\n");
  return rest.length > 0 ? `${first} …` : text;
}

function ToolHeader(props: { name: string; summary: string }) {
  return (
    <>
      <Text bold>{showControl(toolLabel(props.name))}</Text>
      {props.summary ? <Text> {showControl(props.summary)}</Text> : null}
    </>
  );
}

// Toda la salida de una herramienta, para verla desplegada (hasta 400 líneas)
function fullOutput(event: ToolEndEvent): string[] {
  const lines = event.display ? colorPreview(event.display).split("\n") : stripControl(event.output || "").replace(/\s+$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") {
    return [];
  }
  return lines.length > 400 ? [...lines.slice(0, 400), pc.dim(`… ${lines.length - 400} líneas más`)] : lines;
}

// En pantalla completa la salida de una herramienta sale resumida y con un clic se despliega entera («fold»); sin él,
// siempre resumida
function ToolView(props: { event: ToolEndEvent; ms: number; fold?: "folded" | "open" }) {
  const { event } = props;
  const summary = toolDetail(event);
  const full = props.fold ? fullOutput(event) : [];
  // Solo si desplegada enseña algo más que el resumen
  const plain = (lines: string[]) => stripControl(lines.join("\n")).split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
  const foldable = full.length > 0 && plain(full) !== plain(summary);
  const open = foldable && props.fold === "open";
  const detail = open ? full : summary;
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
        {foldable ? <Text dimColor>{open ? "  ▾ plegar" : "  ▸ ver"}</Text> : null}
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
    <Box flexDirection="column" alignSelf="flex-start" borderStyle="round" borderColor="magenta" paddingX={2}>
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

// El «●» delante de cada respuesta, en un hueco fijo de dos columnas: escrito como <Text>● </Text>, Ink no cuenta el
// espacio al repartir el ancho y el texto de al lado se pasa una columna (y la terminal lo corta)
function Bullet(props: { color: string }) {
  return (
    <Box width={2} flexShrink={0}>
      <Text color={props.color}>●</Text>
    </Box>
  );
}

function ItemView(props: { item: Item; app: App; width: number; fold?: "folded" | "open" }) {
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
          <Bullet color={item.color} />
          <Box flexDirection="column" flexGrow={1}>
            <Text>{renderMarkdown(item.text, Math.max(20, width - 4))}</Text>
          </Box>
        </Box>
      );
    case "tool":
      return <ToolView event={item.event} ms={item.ms} fold={props.fold} />;
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
    case "update": {
      // Si trae arreglos de seguridad, en rojo y diciéndolo: que no se deje para luego
      const tone = item.security ? "red" : "green";
      return (
        <Box marginY={1} alignSelf="flex-start" flexDirection="column" borderStyle="round" borderColor={tone} paddingX={2}>
          <Text bold color={tone}>
            {item.security ? "↑ ¡Hay una versión nueva de vipcode con arreglos de seguridad!" : "↑ ¡Hay una versión nueva de vipcode!"}
          </Text>
          <Text>
            {VERSION} → <Text bold color={tone}>{stripControl(item.version)}</Text> · escribe{" "}
            <Text bold color="cyan">
              /update
            </Text>{" "}
            para instalarla{item.security ? " cuanto antes" : ""}
          </Text>
        </Box>
      );
    }
    case "updated":
      // Hasta que no se reinicia sigue funcionando la versión de antes: que no pase desapercibido
      return (
        <Box marginY={1} alignSelf="flex-start" flexDirection="column" borderStyle="round" borderColor="green" paddingX={2}>
          <Text bold color="green">
            ✓ vipcode {stripControl(item.version)} instalado
          </Text>
          <Text>
            Para usar la versión nueva, reinicia vipcode: escribe{" "}
            <Text bold color="cyan">
              /exit
            </Text>{" "}
            y vuelve a abrirlo con{" "}
            <Text bold color="cyan">
              vipcode -c
            </Text>{" "}
            para seguir en esta conversación.
          </Text>
        </Box>
      );
    case "tutorial": {
      const finished = item.step > item.total;
      return (
        <Box marginY={1} flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={2}>
          <Text bold color="magenta">
            {finished ? `✓ ${item.title}` : `Tutorial · paso ${item.step} de ${item.total}: ${item.title}`}
          </Text>
          <Text>{item.text}</Text>
          {finished ? null : <Text dimColor>Cuando lo hagas, pasas solo al siguiente paso (/tutorial lo repite).</Text>}
        </Box>
      );
    }
    case "news": {
      const lines = renderMarkdown(item.markdown, Math.max(20, width - 8)).split("\n");
      const shown = lines.slice(0, 18);
      const tone = item.security ? "yellow" : "cyan";
      return (
        <Box marginY={1} flexDirection="column" borderStyle="round" borderColor={tone} paddingX={2}>
          <Text bold color={tone}>
            ◆ Novedades de vipcode {item.version}
            {item.security ? " · trae arreglos de seguridad" : ""}
          </Text>
          <Text>{shown.join("\n")}</Text>
          {lines.length > shown.length ? <Text dimColor>… y más en CHANGELOG.md</Text> : null}
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
      <Text dimColor> · </Text>
      <Text color={color}>{"▰".repeat(filled)}</Text>
      <Text dimColor>
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
  const fit = { hint: 2, tokens: spent > 0, detail: true, models: true, score: true, name: 0, gauge: true, who: true };
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
        <Text bold color={(agent?.color as any) || "magenta"}>
          {props.agentName}
        </Text>
        <Text dimColor>{model()}</Text>
        {quota ? (
          <Text color={quotaColor} dimColor={!quotaColor}>
            {" "}
            · {stripControl(quotaText())}
          </Text>
        ) : null}
        {gauge() ? <ContextGauge used={app.agent.lastTokens} total={context} detail={fit.detail} /> : null}
        <Text dimColor>
          {fit.models ? ` · ${available}/${app.router.slots.length} modelos` : ""}
          {fit.tokens ? ` · ${shortTokens(spent)} tokens` : ""}
          {queued > 0 ? ` · ${queued} en cola` : ""}
        </Text>
        {app.yolo ? <Text color="red"> · yolo</Text> : null}
      </Text>
      {hintText() ? (
        <Text wrap="truncate-start" color={hint.color} dimColor={!hint.color} bold={hint.bold}>
          {hintText()}
        </Text>
      ) : null}
    </Box>
  );
}

function Main(props: { app: App; initial: string; fullscreen: boolean }) {
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
  // Pantalla completa: la conversación ya pintada, línea a línea (cada mensaje se pinta una vez para cada ancho), y
  // hasta dónde se ha subido (null: abajo del todo, siguiendo lo que llega)
  const painted = useRef(new Map<number, { width: number; open: boolean; lines: string[] }>());
  const [scrollTop, setScrollTop] = useState<number | null>(null);
  const historyRef = useRef<DOMElement>(null);
  const historyBox = useBoxMetrics(historyRef);
  const scrollState = useRef({ lines: 0, height: 1 });
  // Lo seleccionado arrastrando con el ratón sobre la conversación (se copia al soltar), dónde empezó el arrastre y lo
  // que se ve ahora (para saber qué línea hay bajo el ratón)
  const [selection, setSelection] = useState<{ from: TextPos; to: TextPos } | null>(null);
  const dragStart = useRef<TextPos | null>(null);
  const view = useRef({ lines: [] as string[], owners: [] as { id: number; first: boolean }[], top: 0, height: 1, bar: false });
  // Herramientas desplegadas con un clic, Ctrl+F (lo que se busca y cuál de las coincidencias es la actual; -1, la última)
  // y los clics seguidos (doble clic: palabra; triple: línea)
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const [search, setSearch] = useState<{ query: string; current: number } | null>(null);
  // Al momento (sin esperar a que se pinte): qué teclado manda, el de la búsqueda o el de la caja de escribir
  const searchOpen = useRef(false);
  const lastClick = useRef({ time: 0, line: -1, col: -1, count: 0 });
  const pendingToggle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggingBar = useRef(false);
  // Un aviso corto en la barra de abajo («✓ copiado»)
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showFlash = (text: string) => {
    clearTimeout(flashTimer.current ?? undefined);
    setFlash(text);
    flashTimer.current = setTimeout(() => setFlash(null), 2500);
  };
  const copies = useRef<Promise<unknown>>(Promise.resolve());
  const copySelection = (lines: string[], from: TextPos, to: TextPos) => {
    const text = selectedText(lines, from, to);
    if (text.trim() !== "") {
      // En fila: en un triple clic, la línea se copia después de la palabra del doble clic
      copies.current = copies.current
        .then(() => copyToClipboard(text))
        .then((how) => showFlash(how ? "✓ copiado" : "No he podido copiarlo: prueba con /copiar"));
    }
  };
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
    setScrollTop(null);
    setSelection(null);
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
        // Un comando que no cabe en el diálogo se escribe entero en el historial antes de preguntar: lo que apruebas
        // tienes que poder leerlo todo, y 30 líneas inofensivas podrían esconder una maliciosa al final
        if (request.kind === "bash" && request.preview.split("\n").length > permissionRoom(process.stdout.rows || 24)) {
          push({ kind: "block", text: `${pc.yellow("Comando entero que pide ejecutar:")}\n${colorPreview(request.preview)}` });
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
    for (const notice of configNotices) {
      push({ kind: "notice", text: notice });
    }
    if (app.agent.session.log.length > 0) {
      replay(app.agent.session);
    }
    if (app.router.slots.length === 0) {
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
    void app.startMcp(refresh).then(() => {
      for (const server of app.mcp?.status() || []) {
        if (server.state === "error") {
          push({ kind: "notice", text: `MCP ${server.name}: ${server.error}` });
        }
      }
      refresh();
    });
    // En Windows sin Git para Windows, el consejo de instalarlo (una vez al día)
    const gitNotice = app.gitNotice();
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
          push({ kind: "update", version: update.version, security: update.security });
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

  // La conversación, línea a línea, para la pantalla completa. Cada mensaje se pinta con renderToString en un
  // temporizador, fuera de React: mientras Ink pinta (o en sus efectos) no se puede, y rompe su cálculo de tamaños
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const [paintedCount, setPaintedCount] = useState(0);
  const paintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!props.fullscreen || paintTimer.current) {
      return;
    }
    paintTimer.current = setTimeout(() => {
      paintTimer.current = null;
      const width = paintWidth(columnsRef.current);
      let changed = false;
      for (const item of itemsRef.current) {
        const open = expandedRef.current.has(item.id);
        const done = painted.current.get(item.id);
        if (done && done.width === width && done.open === open) {
          continue;
        }
        const text = renderToString(
          <Box width={width} flexDirection="column">
            <ItemView item={item} app={app} width={width} fold={item.kind === "tool" ? (open ? "open" : "folded") : undefined} />
          </Box>,
          { columns: width },
        );
        painted.current.set(item.id, { width, open, lines: text.split("\n") });
        changed = true;
      }
      if (changed) {
        setPaintedCount((count) => count + 1);
      }
    }, 0);
  }, [items, columns, expanded]);
  useEffect(
    () => () => {
      clearTimeout(paintTimer.current ?? undefined);
      clearTimeout(flashTimer.current ?? undefined);
      clearTimeout(pendingToggle.current ?? undefined);
    },
    [],
  );
  // Las líneas y de qué mensaje es cada una (la primera de una herramienta se pincha para desplegarla)
  const conversation = useMemo(() => {
    const lines: string[] = [];
    const owners: { id: number; first: boolean }[] = [];
    for (const item of props.fullscreen ? items : []) {
      const done = painted.current.get(item.id);
      if (done && done.width === paintWidth(columns)) {
        done.lines.forEach((line, index) => {
          lines.push(line);
          owners.push({ id: item.id, first: index === 0 });
        });
      }
    }
    return { lines, owners };
  }, [items, columns, paintedCount]);
  const historyLines = conversation.lines;
  const viewHeight = historyBox.hasMeasured ? Math.max(1, historyBox.height) : Math.max(3, rows - 8);
  scrollState.current = { lines: historyLines.length, height: viewHeight };
  // La primera línea que se ve: abajo del todo si no has subido
  const maxTop = Math.max(0, historyLines.length - viewHeight);
  const top = scrollTop === null ? maxTop : Math.min(scrollTop, maxTop);
  const thumb = scrollThumb(historyLines.length, viewHeight, top);
  view.current = { lines: historyLines, owners: conversation.owners, top, height: viewHeight, bar: thumb !== null };

  // Ctrl+F: las coincidencias y la actual (al cambiar lo buscado, la de más abajo)
  const matches = useMemo(() => (search ? findMatches(historyLines, search.query) : []), [historyLines, search?.query]);
  const current = search && matches.length > 0 ? (search.current < 0 ? matches.length - 1 : Math.min(search.current, matches.length - 1)) : -1;
  useEffect(() => {
    if (current < 0) {
      return;
    }
    // Que se vea, más o menos en el centro
    const { lines, height } = scrollState.current;
    const max = Math.max(0, lines - height);
    const target = Math.max(0, Math.min(matches[current].line - Math.floor(height / 2), max));
    setScrollTop(target >= max ? null : target);
  }, [search?.query, current, matches.length]);

  // Sube o baja la conversación; al llegar abajo del todo vuelve a seguir lo que llega
  const scrollBy = (delta: number) => {
    const { lines, height } = scrollState.current;
    const max = Math.max(0, lines - height);
    setScrollTop((current) => {
      const next = (current ?? max) + delta;
      return next >= max ? null : Math.max(0, next);
    });
  };

  // AvPág/RePág, también con un diálogo abierto (para leer lo de arriba antes de contestar), salvo en las listas, que
  // los usan para moverse por ellas
  useInput(
    (_input, key) => {
      if (dialog?.kind !== "select" && (key.pageUp || key.pageDown)) {
        scrollBy((key.pageUp ? -1 : 1) * Math.max(1, scrollState.current.height - 2));
      } else if (key.ctrl && (key.home || key.end)) {
        // Ctrl+Inicio y Ctrl+Fin: al principio o al final de la conversación
        const { lines, height } = scrollState.current;
        setScrollTop(key.home && lines > height ? 0 : null);
      }
    },
    { isActive: props.fullscreen },
  );

  // Con la pantalla completa, la terminal le manda el ratón a vipcode (la rueda mueve la conversación); al salir, también
  // si sale de golpe, deja de hacerlo
  useEffect(() => {
    if (!props.fullscreen || !process.stdout.isTTY) {
      return;
    }
    process.stdout.write(MOUSE_ON);
    // Lo que lee Ink de la terminal pasa también por aquí (envolviendo stdin.read), sin quitárselo. No vale escuchar
    // «data»: cuando Ink cambia su oyente de «readable», Node puede ponerse a dar las teclas solo a ese oyente
    const onData = (chunk: Buffer | string) => {
      for (const event of mouseEvents(String(chunk))) {
        if (event.kind === "wheel") {
          scrollBy(event.delta * 3);
          continue;
        }
        const { lines, owners, top, height, bar } = view.current;
        // La barra de desplazamiento (la última columna): pinchar o arrastrar lleva a esa altura
        if (event.kind === "press" && bar && event.y < height && event.x >= columnsRef.current - 1) {
          draggingBar.current = true;
        }
        if (draggingBar.current) {
          if (event.kind === "release") {
            draggingBar.current = false;
          } else {
            const max = Math.max(0, lines.length - height);
            const target = Math.round((Math.max(0, Math.min(event.y, height - 1)) / Math.max(1, height - 1)) * max);
            setScrollTop(target >= max ? null : target);
          }
          continue;
        }
        // La línea de la conversación que hay bajo el ratón (si está más abajo, la última que se ve)
        const pos = { line: Math.max(0, Math.min(top + Math.min(event.y, height - 1), lines.length - 1)), col: event.x };
        if (event.kind === "press") {
          // Fuera de la conversación (en la caja o la barra de abajo) no se selecciona; un clic quita lo seleccionado
          if (event.y >= height) {
            dragStart.current = null;
            setSelection(null);
            continue;
          }
          const now = Date.now();
          const last = lastClick.current;
          const count = now - last.time < 450 && last.line === pos.line && Math.abs(last.col - pos.col) <= 1 ? last.count + 1 : 1;
          lastClick.current = { time: now, line: pos.line, col: pos.col, count };
          if (count >= 2) {
            // Doble clic: la palabra; triple: la línea entera. Se copia enseguida (y no despliega nada)
            clearTimeout(pendingToggle.current ?? undefined);
            dragStart.current = null;
            const range = count === 2 ? wordAt(lines[pos.line] || "", pos.col) : lineColumns(lines[pos.line] || "");
            if (range && range[1] > range[0]) {
              const from = { line: pos.line, col: range[0] };
              const to = { line: pos.line, col: range[1] - 1 };
              setSelection({ from, to });
              copySelection(lines, from, to);
            }
            continue;
          }
          dragStart.current = pos;
          setSelection({ from: pos, to: pos });
        } else if (event.kind === "drag" && dragStart.current) {
          // Contra el borde de arriba o por debajo de la conversación, se va moviendo para seguir seleccionando
          if (event.y <= 0) {
            scrollBy(-1);
          } else if (event.y >= height) {
            scrollBy(1);
          }
          setSelection({ from: dragStart.current, to: pos });
        } else if (event.kind === "release" && dragStart.current) {
          const start = dragStart.current;
          dragStart.current = null;
          if (start.line === pos.line && start.col === pos.col) {
            setSelection(null);
            // Un clic en la primera línea de una herramienta despliega (o pliega) su salida; se espera un momento por si
            // es un doble clic
            const owner = owners[pos.line];
            if (owner?.first && itemsRef.current.find((item) => item.id === owner.id)?.kind === "tool") {
              clearTimeout(pendingToggle.current ?? undefined);
              pendingToggle.current = setTimeout(() => {
                pendingToggle.current = null;
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (!next.delete(owner.id)) {
                    next.add(owner.id);
                  }
                  return next;
                });
              }, 300);
            }
            continue;
          }
          setSelection({ from: start, to: pos });
          copySelection(lines, start, pos);
        }
      }
    };
    const stdin = process.stdin;
    const read = stdin.read;
    stdin.read = ((size?: number) => {
      const chunk = read.call(stdin, size);
      if (chunk !== null && chunk !== undefined) {
        onData(chunk);
      }
      return chunk;
    }) as typeof stdin.read;
    const off = () => {
      try {
        fs.writeSync(process.stdout.fd, MOUSE_OFF);
      } catch {
        // la terminal ya no está
      }
    };
    process.on("exit", off);
    return () => {
      stdin.read = read;
      off();
      process.off("exit", off);
    };
  }, []);

  // Ctrl+F abierta: lo que escribes es lo que se busca
  useInput(
    (input, key) => {
      if (!searchOpen.current || dialogRef.current) {
        return;
      }
      if (key.escape || (key.ctrl && (input === "f" || input === "c"))) {
        searchOpen.current = false;
        setSearch(null);
      } else if (key.return || key.upArrow || key.downArrow) {
        if (matches.length > 0) {
          const step = key.downArrow ? 1 : -1;
          setSearch((previous) => previous && { ...previous, current: (current + step + matches.length) % matches.length });
        }
      } else if (key.backspace || key.delete) {
        setSearch((previous) => previous && { query: [...previous.query].slice(0, -1).join(""), current: -1 });
      } else if (input && !key.ctrl && !key.meta) {
        const text = stripControl(input).replace(/[\r\n\t]/g, "");
        if (text) {
          setSearch((previous) => previous && { query: previous.query + text, current: -1 });
        }
      }
    },
    { isActive: props.fullscreen },
  );

  useInput((input, key) => {
    // AvPág/RePág y Ctrl+Inicio/Ctrl+Fin mueven la conversación (lo hace el useInput de arriba)
    if (props.fullscreen && (key.pageUp || key.pageDown || (key.ctrl && (key.home || key.end)))) {
      return;
    }
    // Ctrl+F: buscar en la conversación (mientras, el teclado es de la búsqueda)
    if (searchOpen.current) {
      return;
    }
    if (props.fullscreen && key.ctrl && input === "f" && !dialogRef.current) {
      searchOpen.current = true;
      setSelection(null);
      setSearch({ query: "", current: -1 });
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
    { isActive: !dialog && search === null },
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
        <Text dimColor italic wrap="truncate-end">
          💭 {lastLines(stripControl(live.current.reasoning).replace(/\s+/g, " "), 1).slice(-Math.max(20, columns - 6))}
        </Text>
      ) : null}
      {liveText ? (
        <Box marginTop={1}>
          <Bullet color={color} />
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
            <Spinner /> <ToolHeader name={event.name} summary={oneLine(event.summary)} /> <Elapsed since={since} hideUnderMs={2000} />
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
      {progress ? <ProgressBar progress={progress} width={columns} /> : null}
      {busy && !shell && running.length === 0 && !liveText && !answered.current ? (
        <Box marginTop={1}>
          <Text wrap="truncate-end">
            <Spinner /> <Text dimColor>Pensando{live.current.model ? ` con ${live.current.model}` : ""}… </Text>
            <Elapsed since={startedAt.current} hideUnderMs={1000} />
          </Text>
        </Box>
      ) : null}
      {dialogView ||
        (search ? <SearchBar query={search.query} index={current} total={matches.length} /> : null) || (
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
      <StatusBar app={app} agentName={agentName} busy={busy} model={busy ? live.current.model : ""} width={columns} flash={flash} />
    </Box>
  );

  if (props.fullscreen) {
    // Lo que se ve de la conversación: lo buscado resaltado (lo actual en amarillo) y lo seleccionado en vídeo inverso; si
    // has subido, la última línea dice cuánto queda por debajo
    const mark = (line: string, from: number, to: number, paint: (text: string) => string) =>
      `${sliceAnsi(line, 0, from)}${paint(stripControl(sliceAnsi(line, from, to)))}${sliceAnsi(line, to)}`;
    const found = new Map<number, Match[]>();
    for (const match of matches) {
      found.set(match.line, [...(found.get(match.line) || []), match]);
    }
    let visible = historyLines.slice(top, top + viewHeight).map((line, index) => {
      let out = line;
      for (const match of found.get(top + index) || []) {
        out = mark(out, match.col, match.col + match.width, match === matches[current] ? (text) => pc.black(pc.bgYellow(text)) : pc.inverse);
      }
      const range = selection ? selectedColumns(top + index, selection.from, selection.to) : null;
      if (range && !(selection!.from.line === selection!.to.line && selection!.from.col === selection!.to.col)) {
        out = mark(out, range[0], range[1], pc.inverse);
      }
      return out;
    });
    const below = historyLines.length - (top + viewHeight);
    if (scrollTop !== null && below > 0) {
      visible = [...visible.slice(0, -1), pc.dim(`↓ ${below} líneas más · rueda del ratón o AvPág para bajar`)];
    }
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <Box ref={historyRef} flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
          <Box flexDirection="column" width={paintWidth(columns)}>
            {visible.map((line, index) => (
              <Text key={index} wrap="truncate-end">
                {line || " "}
              </Text>
            ))}
          </Box>
          {thumb ? (
            // La barra de desplazamiento: dónde estás en la conversación (se puede pinchar y arrastrar)
            <Box flexDirection="column" width={1}>
              {Array.from({ length: viewHeight }, (_, row) => (
                <Text key={row}>{row >= thumb.start && row < thumb.start + thumb.size ? "┃" : pc.dim("│")}</Text>
              ))}
            </Box>
          ) : null}
        </Box>
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
  // Pantalla completa (salvo con "fullscreen": false): la conversación tiene su propio scroll
  const fullscreen = app.config.fullscreen !== false;
  const instance = render(<Main app={app} initial={options.initial || ""} fullscreen={fullscreen} />, {
    exitOnCtrlC: false,
    kittyKeyboard: { mode: "auto" },
    alternateScreen: fullscreen,
  });
  await instance.waitUntilExit();
  // La pantalla completa no deja la conversación en la terminal: se recuerda cómo seguir con ella
  if (fullscreen && !app.relaunch && !app.installedVersion && app.agent.session.messages.length > 0) {
    console.log(pc.dim("Conversación guardada: «vipcode -c» sigue con ella."));
  }
  // Tras /update sigue abierta la versión de antes: se recuerda cómo abrir la nueva (salvo si ya se va a reiniciar)
  if (app.installedVersion && !app.relaunch) {
    console.log(pc.green(`✓ Abre vipcode otra vez para usar la versión ${stripControl(app.installedVersion)} (vipcode -c sigue con esta conversación).`));
  }
}
