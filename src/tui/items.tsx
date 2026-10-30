import os from "node:os";
import path from "node:path";
import { Box, Text } from "ink";
import pc from "picocolors";
import type { ToolEndEvent } from "../agent.js";
import type { App } from "../app.js";
import { toolLabel } from "../labels.js";
import { renderMarkdown } from "../markdown.js";
import { VERSION } from "../meta.js";
import { showControl, stripControl, stripUnsafe } from "../sanitize.js";
import { colorPreview } from "../ui.js";
import { look } from "./theme.js";

// Lo que sale en la conversación (tus mensajes, las respuestas, las herramientas, los avisos…) y cómo se pinta cada cosa

export type Item =
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

export type NewItem = WithoutId<Item>;

export function formatDuration(ms: number): string {
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

export function shortTokens(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k`;
  }
  return String(tokens);
}

function firstLine(text: string, max = 200): string {
  return (text.split("\n")[0] || "").slice(0, max);
}

export function tildify(file: string): string {
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
    const lines = colorPreview(event.display, look.faint).split("\n");
    if (lines.length > 14) {
      return [...lines.slice(0, 14), look.faint(`… ${lines.length - 14} líneas más del diff`)];
    }
    return lines;
  }
  const count = output.split("\n").filter((line) => line.trim() !== "").length;
  switch (event.name) {
    case "read_file":
      if (output.startsWith("Imagen")) {
        return [look.faint(firstLine(output))];
      }
      return [look.faint(`Leídas ${output.split("\n").length} líneas`)];
    case "glob":
    case "grep":
      if (/^Sin (resultados|coincidencias)/.test(output)) {
        return [look.faint(firstLine(output))];
      }
      return [look.faint(`${count} resultados`)];
    case "list_dir":
      return [look.faint(`${count} entradas`)];
    case "bash": {
      const lines = output.split("\n");
      const header = lines[0] || "";
      const body = lines.slice(1).filter((line) => line.trim() !== "");
      const tail = body.slice(-4).map((line) => look.faint(line.slice(0, 200)));
      const ok = header === "Código de salida: 0";
      return [ok ? look.faint(header) : pc.yellow(header), ...tail];
    }
    case "webfetch":
      return [look.faint(`${output.length} caracteres`)];
    case "websearch":
      return [look.faint(`${(output.match(/^\d+\. /gm) || []).length} resultados`)];
    case "todowrite":
      return output
        .split("\n")
        .slice(1)
        .map((line) => look.faint(line));
    case "task":
      return output
        .split("\n")
        .filter((line) => line.trim() !== "")
        .slice(0, 3)
        .map((line) => look.faint(line.slice(0, 200)));
    case "skill":
      return [look.faint(event.summary.includes("·") ? "fichero leído" : "instrucciones cargadas")];
    default:
      return [look.faint(firstLine(output))];
  }
}

// El resumen sale de lo que pidió el modelo (comandos, rutas): los caracteres de control se ven, no actúan
// Lo que está haciendo una herramienta, en una línea: un comando de varias líneas ocuparía media pantalla (y no dejaría
// sitio al diálogo de permiso, donde va entero)
export function oneLine(text: string): string {
  const [first, ...rest] = text.split("\n");
  return rest.length > 0 ? `${first} …` : text;
}

export function ToolHeader(props: { name: string; summary: string }) {
  return (
    <>
      <Text bold>{showControl(toolLabel(props.name))}</Text>
      {props.summary ? <Text> {showControl(props.summary)}</Text> : null}
    </>
  );
}

// Toda la salida de una herramienta, para verla desplegada (hasta 400 líneas)
function fullOutput(event: ToolEndEvent): string[] {
  const lines = event.display ? colorPreview(event.display, look.faint).split("\n") : stripControl(event.output || "").replace(/\s+$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") {
    return [];
  }
  return lines.length > 400 ? [...lines.slice(0, 400), look.faint(`… ${lines.length - 400} líneas más`)] : lines;
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
            <Text color={look.tone("green")}>+{stats.added}</Text> <Text color={look.tone("red")}>−{stats.removed}</Text>
          </Text>
        ) : null}
        {props.ms >= 1000 ? <Text dimColor={look.dim}> ({formatDuration(props.ms)})</Text> : null}
        {foldable ? <Text dimColor={look.dim}>{open ? "  ▾ plegar" : "  ▸ ver"}</Text> : null}
      </Text>
      {detail.map((line, index) => (
        <Text key={index}>
          {"  "}
          {index === 0 ? look.faint("⎿ ") : "  "}
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
  // Zen: sin bienvenida; compacta: en una línea
  if (look.minimal) {
    return null;
  }
  if (look.bare) {
    return (
      <Text wrap="truncate-end">
        <Text bold color={look.tone("magenta")}>
          ◆ vipcode
        </Text>
        <Text dimColor={look.dim}>
          {" "}
          v{VERSION} · {slots.length} modelo{slots.length === 1 ? "" : "s"} de {providers} proveedor{providers === 1 ? "" : "es"} · /help ayuda
        </Text>
      </Text>
    );
  }
  return (
    <Box flexDirection="column" alignSelf="flex-start" borderStyle="round" borderColor={look.tone("magenta")} paddingX={2}>
      <Text>
        <Text bold color={look.tone("magenta")}>
          ◆ vipcode
        </Text>
        <Text dimColor={look.dim}> v{VERSION} · programa con IAs gratuitas</Text>
      </Text>
      <Text dimColor={look.dim}>{tildify(app.root)}</Text>
      <Text> </Text>
      <Text>
        <Text color={slots.length > 0 ? "green" : "red"}>●</Text> {slots.length} modelo{slots.length === 1 ? "" : "s"} de {providers} proveedor
        {providers === 1 ? "" : "es"}
        {extras.length > 0 ? <Text dimColor={look.dim}> · {extras.join(" · ")}</Text> : null}
      </Text>
      {first ? (
        <Text wrap="truncate-end">
          <Text color={look.tone("yellow")}>★</Text> Empieza con <Text bold>{first.key}</Text>
          {first.score !== null ? <Text dimColor={look.dim}> (nota {first.score} en LLM Stats)</Text> : null}
        </Text>
      ) : null}
      <Text> </Text>
      <Text dimColor={look.dim} wrap="truncate-end">
        Ctrl+P comandos · @ adjunta · ! terminal · Tab cambia de agente · /help ayuda
      </Text>
    </Box>
  );
}

// El «●» delante de cada respuesta, en un hueco fijo de dos columnas: escrito como <Text>● </Text>, Ink no cuenta el
// espacio al repartir el ancho y el texto de al lado se pasa una columna (y la terminal lo corta)
export function Bullet(props: { color: string }) {
  return (
    <Box width={2} flexShrink={0}>
      <Text color={look.tone(props.color)}>●</Text>
    </Box>
  );
}

export function ItemView(props: { item: Item; app: App; width: number; fold?: "folded" | "open" }) {
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
        <Box marginTop={look.gap} borderStyle="bold" borderTop={false} borderRight={false} borderBottom={false} borderColor={look.tone(item.color)} paddingLeft={1}>
          <Text>
            {text}
            {item.images > 0 ? look.faint(` [${item.images} imagen${item.images > 1 ? "es" : ""}]`) : ""}
            {item.queued ? look.faint(" (en cola: se le entrega al acabar el paso)") : ""}
          </Text>
        </Box>
      );
    }
    case "assistant":
      return (
        <Box marginTop={look.gap}>
          <Bullet color={item.color} />
          <Box flexDirection="column" flexGrow={1}>
            <Text>{renderMarkdown(item.text, Math.max(20, width - 4), { faint: look.faint })}</Text>
          </Box>
        </Box>
      );
    case "tool":
      return <ToolView event={item.event} ms={item.ms} fold={props.fold} />;
    case "answer":
      return (
        <Box marginLeft={2}>
          <Text dimColor={look.dim} wrap="truncate-end">
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
        <Box flexDirection="column" marginTop={look.gap}>
          <Text>
            <Text color={look.tone("yellow")} bold>
              ${" "}
            </Text>
            <Text bold>{showControl(item.command)}</Text>
          </Text>
          {lines.length > shown.length ? <Text dimColor={look.dim}>  … {lines.length - shown.length} líneas antes</Text> : null}
          {shown.length > 0 ? <Text>{shown.map((line) => `  ${line}`).join("\n")}</Text> : null}
          <Text dimColor={look.dim}>
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
        <Box marginY={look.gap} alignSelf="flex-start" flexDirection="column" borderStyle="round" borderColor={look.tone(tone)} paddingX={2}>
          <Text bold color={look.tone(tone)}>
            {item.security ? "↑ ¡Hay una versión nueva de vipcode con arreglos de seguridad!" : "↑ ¡Hay una versión nueva de vipcode!"}
          </Text>
          <Text>
            {VERSION} → <Text bold color={look.tone(tone)}>{stripControl(item.version)}</Text> · escribe{" "}
            <Text bold color={look.tone("cyan")}>
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
        <Box marginY={look.gap} alignSelf="flex-start" flexDirection="column" borderStyle="round" borderColor={look.tone("green")} paddingX={2}>
          <Text bold color={look.tone("green")}>
            ✓ vipcode {stripControl(item.version)} instalado
          </Text>
          <Text>
            Para usar la versión nueva, reinicia vipcode: escribe{" "}
            <Text bold color={look.tone("cyan")}>
              /exit
            </Text>{" "}
            y vuelve a abrirlo con{" "}
            <Text bold color={look.tone("cyan")}>
              vipcode -c
            </Text>{" "}
            para seguir en esta conversación.
          </Text>
        </Box>
      );
    case "tutorial": {
      const finished = item.step > item.total;
      return (
        <Box marginY={look.gap} flexDirection="column" borderStyle="round" borderColor={look.tone("magenta")} paddingX={2}>
          <Text bold color={look.tone("magenta")}>
            {finished ? `✓ ${item.title}` : `Tutorial · paso ${item.step} de ${item.total}: ${item.title}`}
          </Text>
          <Text>{item.text}</Text>
          {finished ? null : <Text dimColor={look.dim}>Cuando lo hagas, pasas solo al siguiente paso (/tutorial lo repite).</Text>}
        </Box>
      );
    }
    case "news": {
      const lines = renderMarkdown(item.markdown, Math.max(20, width - 8), { faint: look.faint }).split("\n");
      const shown = lines.slice(0, 18);
      const tone = item.security ? "yellow" : "cyan";
      return (
        <Box marginY={look.gap} flexDirection="column" borderStyle="round" borderColor={look.tone(tone)} paddingX={2}>
          <Text bold color={look.tone(tone)}>
            ◆ Novedades de vipcode {item.version}
            {item.security ? " · trae arreglos de seguridad" : ""}
          </Text>
          <Text>{shown.join("\n")}</Text>
          {lines.length > shown.length ? <Text dimColor={look.dim}>… y más en CHANGELOG.md</Text> : null}
        </Box>
      );
    }
    // Avisos y bloques pueden llevar mensajes de los proveedores o datos de fuera: solo se dejan los colores
    case "info":
      return <Text dimColor={look.dim}>{stripUnsafe(item.text)}</Text>;
    case "notice":
      return <Text color={look.tone("yellow")}>⚠ {stripUnsafe(item.text)}</Text>;
    case "error":
      return <Text color={look.tone("red")}>✖ {stripUnsafe(item.text)}</Text>;
    case "block":
      return (
        <Box marginY={look.gap}>
          <Text>{stripUnsafe(item.text)}</Text>
        </Box>
      );
  }
}
