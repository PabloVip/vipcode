// Edición del cuadro de texto: funciones puras sobre el texto y la posición del cursor

export interface EditorState {
  value: string;
  cursor: number;
}

export const EMPTY: EditorState = { value: "", cursor: 0 };

// Las letras tal como se ven: un emoji, una bandera o una letra con su tilde aparte son una sola, y el cursor y el
// borrado no las pueden partir por la mitad (quedaría un carácter roto que algunos proveedores rechazan)
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Ninguna letra ocupa tanto: se mira solo un trozo alrededor del cursor (un texto pegado puede ser enorme)
const AROUND = 64;

// Dónde empieza la letra que hay justo antes de «index»
export function previousBoundary(value: string, index: number): number {
  if (index <= 0) {
    return 0;
  }
  const from = Math.max(0, index - AROUND);
  let start = from;
  for (const part of segmenter.segment(value.slice(from, index))) {
    start = from + part.index;
  }
  return start;
}

// Dónde acaba la letra que empieza en «index»
export function nextBoundary(value: string, index: number): number {
  if (index >= value.length) {
    return value.length;
  }
  const first = segmenter.segment(value.slice(index, index + AROUND))[Symbol.iterator]().next();
  return index + (first.done ? 1 : first.value.segment.length);
}

// Una posición que no cae entre las dos mitades de un emoji (o de otro carácter que ocupa dos)
export function safeIndex(value: string, index: number): number {
  const code = value.charCodeAt(index);
  return index > 0 && index < value.length && code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

// Para pintar una línea con el cursor en «at»: lo de antes, la letra del cursor (un espacio si está al final) y lo de
// después
export function splitAtCursor(text: string, at: number): { before: string; under: string; after: string } {
  const end = nextBoundary(text, at);
  return { before: text.slice(0, at), under: text.slice(at, end) || " ", after: text.slice(end) };
}

export function insert(state: EditorState, text: string): EditorState {
  const value = state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor);
  return { value, cursor: state.cursor + text.length };
}

export function backspace(state: EditorState): EditorState {
  if (state.cursor === 0) {
    return state;
  }
  const start = previousBoundary(state.value, state.cursor);
  return { value: state.value.slice(0, start) + state.value.slice(state.cursor), cursor: start };
}

export function deleteForward(state: EditorState): EditorState {
  if (state.cursor >= state.value.length) {
    return state;
  }
  return { value: state.value.slice(0, state.cursor) + state.value.slice(nextBoundary(state.value, state.cursor)), cursor: state.cursor };
}

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}_]/u.test(char);
}

function wordStart(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && !isWordChar(value[i - 1])) {
    i--;
  }
  while (i > 0 && isWordChar(value[i - 1])) {
    i--;
  }
  return i;
}

function wordEnd(value: string, cursor: number): number {
  let i = cursor;
  while (i < value.length && !isWordChar(value[i])) {
    i++;
  }
  while (i < value.length && isWordChar(value[i])) {
    i++;
  }
  return i;
}

export function moveLeft(state: EditorState, word = false): EditorState {
  if (word) {
    return { ...state, cursor: wordStart(state.value, state.cursor) };
  }
  return { ...state, cursor: previousBoundary(state.value, state.cursor) };
}

export function moveRight(state: EditorState, word = false): EditorState {
  if (word) {
    return { ...state, cursor: wordEnd(state.value, state.cursor) };
  }
  return { ...state, cursor: nextBoundary(state.value, state.cursor) };
}

export function deleteWordBack(state: EditorState): EditorState {
  const start = wordStart(state.value, state.cursor);
  return { value: state.value.slice(0, start) + state.value.slice(state.cursor), cursor: start };
}

function lineBounds(value: string, cursor: number): { start: number; end: number } {
  const start = value.lastIndexOf("\n", cursor - 1) + 1;
  let end = value.indexOf("\n", cursor);
  if (end < 0) {
    end = value.length;
  }
  return { start, end };
}

export function lineStart(state: EditorState): EditorState {
  return { ...state, cursor: lineBounds(state.value, state.cursor).start };
}

export function lineEnd(state: EditorState): EditorState {
  return { ...state, cursor: lineBounds(state.value, state.cursor).end };
}

export function deleteToLineStart(state: EditorState): EditorState {
  const { start } = lineBounds(state.value, state.cursor);
  return { value: state.value.slice(0, start) + state.value.slice(state.cursor), cursor: start };
}

export function deleteToLineEnd(state: EditorState): EditorState {
  const { end } = lineBounds(state.value, state.cursor);
  return { value: state.value.slice(0, state.cursor) + state.value.slice(end), cursor: state.cursor };
}

export function cursorPosition(state: EditorState): { line: number; column: number; lines: string[] } {
  const before = state.value.slice(0, state.cursor);
  const line = before.split("\n").length - 1;
  const column = before.length - (before.lastIndexOf("\n") + 1);
  return { line, column, lines: state.value.split("\n") };
}

// Sube o baja una línea; devuelve null si ya está en la primera/última (entonces se usa el historial)
export function moveVertical(state: EditorState, direction: -1 | 1): EditorState | null {
  const { line, column, lines } = cursorPosition(state);
  const target = line + direction;
  if (target < 0 || target >= lines.length) {
    return null;
  }
  let offset = 0;
  for (let i = 0; i < target; i++) {
    offset += lines[i].length + 1;
  }
  return { ...state, cursor: safeIndex(state.value, offset + Math.min(column, lines[target].length)) };
}

// La palabra @… que se está escribiendo justo antes del cursor
export function mentionAtCursor(state: EditorState): { start: number; text: string } | null {
  const before = state.value.slice(0, state.cursor);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) {
    return null;
  }
  return { start: before.length - match[2].length - 1, text: match[2] };
}

// Algunas terminales mandan "texto + Enter" en un solo bloque (o Enter como \n): separa el texto del Enter final
export function splitEnter(input: string, isReturn: boolean): { text: string; enter: boolean } {
  if (isReturn) {
    return { text: "", enter: true };
  }
  if (/[\r\n]$/.test(input) && !/[\r\n]/.test(input.slice(0, -1))) {
    return { text: input.slice(0, -1), enter: true };
  }
  return { text: input, enter: false };
}

export function replaceRange(state: EditorState, start: number, end: number, text: string): EditorState {
  return { value: state.value.slice(0, start) + text + state.value.slice(end), cursor: start + text.length };
}
