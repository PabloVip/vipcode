import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import { stripControl } from "../sanitize.js";

// Con la pantalla completa, vipcode pide el ratón a la terminal (modo SGR, con arrastre): la rueda mueve la conversación
// y arrastrar sobre ella la selecciona y la copia. Llega como «ESC[<botón;columna;filaM» (o «…m» al soltar). Ink
// descarta esas secuencias antes de pasárselas a useInput, así que se leen de lo que llega de la terminal tal cual
export const MOUSE_ON = "\x1b[?1002h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

export interface MouseEvent {
  kind: "press" | "drag" | "release" | "wheel";
  // Columna y fila desde 0
  x: number;
  y: number;
  // Rueda: -1 hacia arriba, 1 hacia abajo
  delta: number;
}

// Lo que hace el ratón en un trozo de lo que llega (solo el botón izquierdo y la rueda)
export function mouseEvents(chunk: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  for (const match of chunk.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
    const code = Number(match[1]);
    const x = Number(match[2]) - 1;
    const y = Number(match[3]) - 1;
    // Los dos bits de abajo dicen el botón (en la rueda, 0 arriba y 1 abajo); 32 es arrastrar y 64 la rueda
    const button = code & 3;
    if (code & 64) {
      events.push({ kind: "wheel", x, y, delta: button === 0 ? -1 : button === 1 ? 1 : 0 });
    } else if (button === 0) {
      events.push({ kind: match[4] === "m" ? "release" : code & 32 ? "drag" : "press", x, y, delta: 0 });
    }
  }
  return events;
}

export interface TextPos {
  // Línea de la conversación y columna en pantalla
  line: number;
  col: number;
}

// Principio y fin de una selección, en orden (se puede arrastrar hacia arriba)
export function ordered(a: TextPos, b: TextPos): [TextPos, TextPos] {
  return a.line < b.line || (a.line === b.line && a.col <= b.col) ? [a, b] : [b, a];
}

// Las columnas de esa línea que entran en la selección (fin no incluido), o null si no entra
export function selectedColumns(line: number, a: TextPos, b: TextPos): [number, number] | null {
  const [start, end] = ordered(a, b);
  if (line < start.line || line > end.line) {
    return null;
  }
  return [line === start.line ? start.col : 0, line === end.line ? end.col + 1 : Number.MAX_SAFE_INTEGER];
}

// El texto seleccionado, sin colores ni espacios al final de cada línea
export function selectedText(lines: string[], a: TextPos, b: TextPos): string {
  const [start, end] = ordered(a, b);
  const out: string[] = [];
  for (let line = start.line; line <= end.line && line < lines.length; line++) {
    const [from, to] = selectedColumns(line, start, end)!;
    out.push(stripControl(sliceAnsi(lines[line] || "", from, to)).replace(/\s+$/, ""));
  }
  return out.join("\n");
}

// Lo que cuenta como parte de una palabra al hacer doble clic: también rutas, direcciones y comandos (src/app.ts:12,
// https://ejemplo.com/a?b=1, --force)
const WORD = /[\p{L}\p{N}_\-./:@~#%+=?&]/u;

// Las columnas [desde, hasta) de la palabra que hay en esa columna, o null si ahí no hay ninguna
export function wordAt(line: string, col: number): [number, number] | null {
  const chars = [...stripControl(line)];
  const starts: number[] = [];
  let width = 0;
  let index = -1;
  for (const [i, char] of chars.entries()) {
    starts.push(width);
    width += stringWidth(char);
    if (index < 0 && width > col) {
      index = i;
    }
  }
  if (index < 0 || !WORD.test(chars[index])) {
    return null;
  }
  let first = index;
  let last = index;
  while (first > 0 && WORD.test(chars[first - 1])) {
    first--;
  }
  while (last < chars.length - 1 && WORD.test(chars[last + 1])) {
    last++;
  }
  // El punto, la coma o los dos puntos del final de una frase no son de la palabra
  while (last > first && /[.,:;?]/.test(chars[last])) {
    last--;
  }
  return [starts[first], starts[last] + stringWidth(chars[last])];
}

// Las columnas [0, hasta) con texto de la línea (sin los espacios del final)
export function lineColumns(line: string): [number, number] {
  return [0, stringWidth(stripControl(line).replace(/\s+$/, ""))];
}

// Las direcciones de un texto (para encontrar entera la que no cabía en una línea y sigue en la de abajo)
export function urlsIn(text: string): string[] {
  return [...stripControl(text).matchAll(/https?:\/\/[^\s<>()[\]{}"'`|\\^]+/gi)].map((match) => match[0].replace(/[.,:;!?]+$/, ""));
}

// Solo direcciones web: un modelo podría escribir otra cosa (file:, javascript:…) que no queremos abrir con un clic
function webUrl(text: string): string | null {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

// La palabra (sin colores) que hay en esa columna de la línea
function tokenAt(line: string, col: number): string {
  const range = wordAt(line, col);
  if (!range) {
    return "";
  }
  return sliceAnsi(stripControl(line), range[0], range[1]);
}

// El enlace que hay en esa columna de las líneas de un mensaje («sources»: las direcciones enteras del mensaje). Si no
// cabía en una línea, sirve pinchar en cualquiera de los dos trozos
export function urlAt(lines: string[], line: number, col: number, sources: string[]): string | null {
  const token = tokenAt(lines[line] || "", col);
  if (!token) {
    return null;
  }
  let prefix = token;
  if (!/^https?:\/\//i.test(token)) {
    // ¿El final de una dirección que empieza al final de la línea de arriba?
    const above = stripControl(lines[line - 1] || "").trimEnd().split(/\s+/).pop() || "";
    const first = stripControl(lines[line] || "").trimStart().split(/\s+/)[0] || "";
    if (!/^https?:\/\//i.test(above) || first !== token) {
      return null;
    }
    prefix = above + token;
  }
  const exact = sources.find((url) => url === prefix);
  const longer = sources.filter((url) => url.startsWith(prefix));
  return webUrl(exact || (longer.length === 1 ? longer[0] : prefix));
}

// El /comando que hay en esa columna, si es uno de los que existen («/update», «/connect»…)
export function commandAt(line: string, col: number, names: string[]): string | null {
  const token = tokenAt(line, col);
  return token.startsWith("/") && names.includes(token.slice(1)) ? token : null;
}
