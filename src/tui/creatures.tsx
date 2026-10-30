import { Box, Text, useAnimation } from "ink";
import pc from "picocolors";
import type { ReactNode } from "react";
import stringWidth from "string-width";
import { look } from "./theme.js";

// La interfaz «Criaturas»: un monstruito de píxeles hecho al azar (cuerpo, colores, ojos, boca, orejas, brazos y patas)
// con su nombre, en un panel a la derecha. Sale otro al terminar cada respuesta o con un clic, y da saltitos mientras
// vipcode trabaja. Son originales: se inventan aquí, no se descarga ni se copia ningún dibujo

// Filas de píxeles de arriba abajo: un color (#rrggbb) o null si está vacío
type Pixels = (string | null)[][];

// 16 × 16 píxeles: se dibuja la mitad izquierda y se copia en espejo
const SIZE = 16;
const HALF = SIZE / 2;

export interface Creature {
  name: string;
  message: string;
  // El color de su nombre, y si es de las raras (dorada, una de cada veinte)
  color: string;
  rare: boolean;
  // De 16 × 16, y la grande de 32 × 32 con más detalle (bordes redondeados, luces y sombras y brillo en los ojos)
  pixels: Pixels;
  big: Pixels;
}

// Cómo se pintan los píxeles: con medios bloques («▀», dos píxeles por carácter) o con el fondo de los caracteres (dos
// caracteres por píxel). El Terminal del Mac pinta los bloques sin llenar todo el alto de la línea y salen rayas entre
// las filas; los fondos sí los pinta enteros
export type PixelMode = "bloques" | "fondos";
export function pixelMode(env: NodeJS.ProcessEnv = process.env): PixelMode {
  return env.TERM_PROGRAM === "Apple_Terminal" ? "fondos" : "bloques";
}

// El panel según lo que quepa: la criatura grande en terminales anchas y altas, la pequeña en las demás y nada si no
// cabe. Con fondos solo hay una: la de 16 × 16, que ya ocupa 32 columnas. «width»: lo que se le quita a la conversación
export interface CreatureLayout {
  width: number;
  big: boolean;
  mode: PixelMode;
}
export function creatureLayout(columns: number, rows: number, mode: PixelMode = pixelMode()): CreatureLayout | null {
  if (!look.interface.pets) {
    return null;
  }
  if (mode === "fondos") {
    return columns >= 90 && rows >= 28 ? { width: SIZE * 2 + 4, big: false, mode } : null;
  }
  if (columns >= 120 && rows >= 32) {
    return { width: SIZE * 2 + 4, big: true, mode };
  }
  return columns >= 70 ? { width: SIZE + 4, big: false, mode } : null;
}

// Números al azar repetibles a partir de una semilla (mulberry32)
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hsl(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${[channel(0), channel(8), channel(4)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

// Los nombres: un principio, a veces algo en medio y un final
const FIRST = ["Zu", "Blo", "Fli", "Gru", "Chi", "Po", "Tri", "Bu", "Nu", "Ro", "Ti", "Mu", "Plu", "Ga", "Lu", "Bri", "Cha", "Fu", "Que", "Ra", "Tru", "Ze", "Mo", "Pi"];
const MIDDLE = ["mba", "ra", "li", "mo", "ta", "ri", "bo", "nde", "pi"];
const LAST = ["lo", "lín", "rito", "pón", "chete", "lote", "bú", "ñito", "zón", "ruli", "quín", "dín", "flín", "rrón", "xel", "nzo", "gol", "tín", "mbi", "fín", "fo", "rex"];
const MESSAGES = [
  "¡Un {name} salvaje!",
  "¡Ha salido un {name}!",
  "{name} te echa una mano",
  "{name} vigila los tests",
  "{name} quiere más código",
  "{name} te saluda",
  "{name} busca bugs",
  "{name} aplaude",
];

const WHITE = "#ffffff";
const DARK = "#1c1a2b";
// Las pupilas, de otro tono que la boca: en la grande llevan brillo
const PUPIL = "#1a1830";
const PINK = "#ff8fb1";
const IVORY = "#f2e7cf";

// Se dibuja la mitad izquierda y se copia en espejo (salvo el brillo y hacia dónde miran), y al final se le pone un
// borde oscuro. 16 × 16 píxeles: 16 columnas y 8 filas de la terminal
export function makeCreature(seed = Math.floor(Math.random() * 4294967296)): Creature {
  const random = generator(seed);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const chance = (p: number) => random() < p;
  const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

  // Los colores: uno de base y sus tonos, y otro de adorno
  const rare = chance(0.05);
  const hue = rare ? 45 : between(0, 359);
  const saturation = rare ? 92 : between(55, 80);
  const lightness = rare ? 56 : between(52, 64);
  const body = hsl(hue, saturation, lightness);
  const shade = hsl(hue, saturation, lightness - 16);
  const light = hsl(hue, saturation - 10, Math.min(90, lightness + 22));
  const belly = rare ? "#fff4c2" : hsl((hue + 30) % 360, 65, 82);
  const accent = rare ? WHITE : hsl((hue + between(150, 210)) % 360, 75, 60);
  const outline = hsl(hue, 45, 14);

  const grid: (string | null)[][] = Array.from({ length: SIZE }, () => Array<string | null>(SIZE).fill(null));
  const inside = (y: number, x: number) => y >= 0 && y < SIZE && x >= 0 && x < HALF;
  const put = (y: number, x: number, color: string) => {
    if (inside(y, x)) {
      grid[y][x] = color;
      grid[y][SIZE - 1 - x] = color;
    }
  };
  const at = (y: number, x: number) => (inside(y, x) ? grid[y][x] : null);
  // Dónde empieza el cuerpo por la izquierda en una fila, y por arriba en una columna
  const leftAt = (y: number) => grid[y].findIndex((cell) => cell !== null);
  const topAt = (x: number) => grid.findIndex((row) => row[x] !== null);

  // El cuerpo: una elipse más o menos cuadrada, a veces más ancha por abajo (o por arriba)
  const feet = pick(["patas", "patas", "tentáculos", "ninguna"] as const);
  const bottom = feet === "ninguna" ? 13 : 12;
  const top = between(3, 6);
  const centerY = (top + bottom + 1) / 2;
  const halfHeight = (bottom - top + 1) / 2;
  const halfWidth = 3.5 + random() * 3;
  const power = pick([2, 2.5, 3, 4]);
  const taper = (random() - 0.4) * 0.6;
  for (let y = top; y <= bottom; y++) {
    const dy = (y + 0.5 - centerY) / halfHeight;
    const width = Math.min(6.5, halfWidth * (1 + taper * dy));
    for (let x = 0; x < HALF; x++) {
      if (Math.abs((HALF - 0.5 - x) / width) ** power + Math.abs(dy) ** power <= 1) {
        put(y, x, body);
      }
    }
  }
  // Más oscuro por abajo, la barriga más clara y, a veces, manchas o rayas
  for (let x = 0; x < HALF; x++) {
    const lowest = grid.map((row) => row[x]).lastIndexOf(body);
    if (lowest >= 0) {
      put(lowest, x, shade);
    }
  }
  if (chance(0.6)) {
    for (let y = top; y < bottom; y++) {
      for (let x = 0; x < HALF; x++) {
        const dx = (HALF - 0.5 - x) / (halfWidth * 0.55);
        const dy = (y + 0.5 - (centerY + halfHeight * 0.35)) / (halfHeight * 0.5);
        if (dx * dx + dy * dy <= 1 && at(y, x) === body) {
          put(y, x, belly);
        }
      }
    }
  }
  const pattern = pick(["nada", "nada", "manchas", "rayas"] as const);
  if (pattern === "manchas") {
    for (let i = 0; i < 3; i++) {
      const y = between(top + 2, bottom - 1);
      const x = between(1, 4);
      if (at(y, x) === body) {
        put(y, x, shade);
      }
    }
  } else if (pattern === "rayas") {
    for (let y = top + 2; y < bottom; y += 2) {
      const left = leftAt(y);
      if (left >= 0 && left < HALF - 3) {
        put(y, left, shade);
        put(y, left + 1, shade);
      }
    }
  }
  const shine = leftAt(top + 1);
  if (at(top + 1, shine + 1) === body) {
    grid[top + 1][shine + 1] = light;
  }

  // Los ojos: grandes, de punto, uno solo en medio, contentos (^ ^) o dormidos (- -)
  let eyes = pick(["grandes", "grandes", "punto", "cíclope", "contentos", "dormidos"] as const);
  let eyeY = Math.min(top + 1 + (halfHeight >= 4.5 ? 1 : 0) + (chance(0.3) ? 1 : 0), bottom - 5);
  let eyeX = Math.max(leftAt(eyeY + 1) + 1, between(3, 5));
  if (eyes === "contentos") {
    eyeX = Math.min(eyeX, 4);
  }
  // Si la cara es estrecha, ojos de punto (o uno solo)
  if (eyeX > 5 || (eyes === "contentos" && leftAt(eyeY + 1) + 1 > 4)) {
    eyeX = 5;
    eyes = eyes === "cíclope" || chance(0.3) ? "cíclope" : "punto";
  }
  if (eyes === "grandes") {
    put(eyeY, eyeX, WHITE);
    put(eyeY, eyeX + 1, WHITE);
    put(eyeY + 1, eyeX, WHITE);
    put(eyeY + 1, eyeX + 1, WHITE);
    // Las pupilas: abajo, o las dos hacia el mismo lado
    const gaze = pick(["abajo", "izquierda", "derecha"] as const);
    if (gaze === "abajo") {
      put(eyeY + 1, eyeX, PUPIL);
      put(eyeY + 1, eyeX + 1, PUPIL);
    } else {
      const shift = gaze === "izquierda" ? 0 : 1;
      grid[eyeY][eyeX + shift] = PUPIL;
      grid[eyeY + 1][eyeX + shift] = PUPIL;
      grid[eyeY][SIZE - 2 - eyeX + shift] = PUPIL;
      grid[eyeY + 1][SIZE - 2 - eyeX + shift] = PUPIL;
    }
  } else if (eyes === "punto") {
    put(eyeY, eyeX + 1, WHITE);
    put(eyeY + 1, eyeX + 1, PUPIL);
  } else if (eyes === "cíclope") {
    eyeX = HALF - 2;
    for (let y = eyeY; y <= eyeY + 2; y++) {
      put(y, HALF - 2, WHITE);
      put(y, HALF - 1, WHITE);
    }
    put(eyeY + 1, HALF - 1, PUPIL);
    put(eyeY + 2, HALF - 1, PUPIL);
    eyeY++;
  } else if (eyes === "contentos") {
    put(eyeY + 1, eyeX, DARK);
    put(eyeY, eyeX + 1, DARK);
    put(eyeY + 1, eyeX + 2, DARK);
  } else {
    put(eyeY + 1, eyeX, DARK);
    put(eyeY + 1, eyeX + 1, DARK);
  }

  // La boca, debajo de los ojos, y a veces los mofletes colorados
  const mouthY = eyeY + 3;
  const mouth = pick(["sonrisa", "sonrisa", "abierta", "colmillos", "pequeña", "ninguna"] as const);
  if (mouth === "sonrisa") {
    put(mouthY, HALF - 2, DARK);
    put(mouthY + 1, HALF - 1, DARK);
  } else if (mouth === "abierta") {
    put(mouthY, HALF - 1, DARK);
    put(mouthY + 1, HALF - 1, PINK);
  } else if (mouth === "colmillos") {
    put(mouthY, HALF - 2, DARK);
    put(mouthY, HALF - 1, DARK);
    put(mouthY + 1, HALF - 2, WHITE);
  } else if (mouth === "pequeña") {
    put(mouthY, HALF - 1, DARK);
  }
  if (eyes !== "cíclope" && chance(0.4) && [body, belly].includes(at(mouthY - 1, eyeX - 1) ?? "")) {
    put(mouthY - 1, eyeX - 1, PINK);
  }

  // Arriba: orejas, antenas, cuernos o un mechón
  const crown = pick(["puntiagudas", "redondas", "antenas", "cuernos", "mechón", "nada"] as const);
  const earX = Math.min(5, Math.max(between(2, 5), leftAt(top + 2)));
  const earTop = topAt(earX + 1);
  if (crown === "puntiagudas") {
    put(earTop - 1, earX, body);
    put(earTop - 1, earX + 1, PINK);
    put(earTop - 2, earX, body);
  } else if (crown === "redondas") {
    for (const [dy, dx] of [[1, 0], [1, 1], [2, 0], [2, 1]]) {
      put(earTop - dy, earX + dx, body);
    }
  } else if (crown === "cuernos") {
    const base = topAt(earX);
    put(base - 1, earX, IVORY);
    put(base - 2, earX - 1, IVORY);
  } else if (crown === "mechón") {
    put(top - 1, HALF - 2, accent);
    put(top - 1, HALF - 1, accent);
    put(top - 2, HALF - 1, accent);
  }
  // A los lados: bracitos o alas
  const armY = Math.min(Math.round(centerY), bottom - 2);
  const edge = leftAt(armY);
  const arms = pick(["brazos", "alas", "nada", "nada"] as const);
  if (arms === "brazos" && edge >= 2) {
    put(armY, edge - 1, body);
    put(armY + 1, edge - 1, body);
  } else if (arms === "alas" && edge >= 3) {
    put(armY, edge - 1, accent);
    put(armY - 1, edge - 1, accent);
    put(armY - 1, edge - 2, accent);
    put(armY - 2, edge - 2, accent);
  }
  // Abajo: patas, tentáculos o nada (se apoya en la barriga)
  if (feet === "patas") {
    const footX = Math.min(Math.max(leftAt(bottom), between(3, 5)), HALF - 3);
    put(bottom + 1, footX, shade);
    put(bottom + 1, footX + 1, shade);
  } else if (feet === "tentáculos") {
    for (let x = Math.max(1, leftAt(bottom)); x < HALF - 1; x += 2) {
      put(bottom + 1, x, shade);
      put(bottom + 2, x, body);
    }
  }

  // El borde: lo vacío que toca algo pintado
  const filled = grid.map((row) => row.map((cell) => cell !== null));
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!filled[y][x] && [[y - 1, x], [y + 1, x], [y, x - 1], [y, x + 1]].some(([ny, nx]) => filled[ny]?.[nx])) {
        grid[y][x] = outline;
      }
    }
  }
  // Las antenas, finas (sin borde) y con una bolita
  if (crown === "antenas") {
    put(earTop - 1, earX + 1, shade);
    put(earTop - 2, earX + 1, shade);
    put(earTop - 3, earX + 1, accent);
  }

  const name = pick(FIRST) + (chance(0.35) ? pick(MIDDLE) : "") + pick(LAST);
  const message = rare ? `¡Un ${name} dorado! Qué suerte` : pick(MESSAGES).replace("{name}", name);
  return { name, message, color: body, rare, pixels: grid, big: detailed(grid, { body, light, shade, outline }) };
}

// Al doble de tamaño redondeando las esquinas (Scale2x: cada píxel pasa a cuatro y, en las diagonales, toma el color de
// los vecinos que coinciden)
function scale2x(grid: Pixels): Pixels {
  const height = grid.length;
  const width = grid[0].length;
  const out: Pixels = Array.from({ length: height * 2 }, () => Array<string | null>(width * 2).fill(null));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = grid[y][x];
      const a = y > 0 ? grid[y - 1][x] : p;
      const b = x < width - 1 ? grid[y][x + 1] : p;
      const c = x > 0 ? grid[y][x - 1] : p;
      const d = y < height - 1 ? grid[y + 1][x] : p;
      out[y * 2][x * 2] = c === a && c !== d && a !== b ? a : p;
      out[y * 2][x * 2 + 1] = a === b && a !== c && b !== d ? b : p;
      out[y * 2 + 1][x * 2] = d === c && d !== b && c !== a ? c : p;
      out[y * 2 + 1][x * 2 + 1] = b === d && b !== a && d !== c ? d : p;
    }
  }
  return out;
}

// La grande: al doble, con el borde fino, luz de arriba a la izquierda (más claro por arriba y por la izquierda, más
// oscuro abajo a la derecha) y un brillo blanco en cada pupila
function detailed(grid: Pixels, colors: { body: string; light: string; shade: string; outline: string }): Pixels {
  const big = scale2x(grid);
  const size = big.length;
  const before = big.map((row) => [...row]);
  const at = (y: number, x: number) => before[y]?.[x] ?? null;
  const outside = (y: number, x: number) => at(y, x) === null || at(y, x) === colors.outline;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cell = before[y][x];
      const around = [at(y - 1, x), at(y + 1, x), at(y, x - 1), at(y, x + 1)];
      if (cell === colors.outline && around.every((near) => near === null || near === colors.outline)) {
        big[y][x] = null;
      } else if (cell === colors.body && (outside(y - 1, x) || (outside(y, x - 1) && y < size / 2))) {
        big[y][x] = colors.light;
      } else if (cell === colors.body && outside(y, x + 1) && y >= size / 2) {
        big[y][x] = colors.shade;
      } else if (cell === PUPIL && at(y - 1, x) !== PUPIL && at(y, x - 1) !== PUPIL && at(y + 1, x) === PUPIL && at(y, x + 1) === PUPIL) {
        big[y][x] = WHITE;
      }
    }
  }
  return big;
}

// Las filas de píxeles vacías que se dejan encima para saltar: con medios bloques, dos (media fila de la terminal cada
// una); con fondos, una (una fila)
function hopRoom(mode: PixelMode): number {
  return mode === "fondos" ? 1 : 2;
}

// El dibujo sin las filas vacías de arriba y de abajo
function trimmed(grid: Pixels): Pixels {
  const used = grid.map((row) => row.some((cell) => cell !== null));
  return grid.slice(Math.max(0, used.indexOf(true)), used.lastIndexOf(true) + 1);
}

// Las filas de la terminal que ocupa el dibujo, con el hueco para saltar
export function spriteRows(creature: Creature, layout: CreatureLayout): number {
  const pixels = trimmed(layout.big ? creature.big : creature.pixels).length + hopRoom(layout.mode);
  return layout.mode === "fondos" ? pixels : Math.ceil(pixels / 2);
}

interface Cell {
  text: string;
  color?: string;
  background?: string;
}

// Los trozos seguidos con los mismos colores, juntos: menos cosas que pintar en cada saltito
function merge(cells: Cell[]): Cell[] {
  const runs: Cell[] = [];
  for (const cell of cells) {
    const last = runs.at(-1);
    if (last && last.color === cell.color && last.background === cell.background) {
      last.text += cell.text;
    } else {
      runs.push({ ...cell });
    }
  }
  return runs;
}

// El dibujo. Con medios bloques, dos píxeles por carácter: ▀ con el de arriba como letra y el de abajo como fondo; con
// fondos, cada píxel son dos espacios con su color de fondo. Sin colores, la silueta con bloques. «lift»: cuánto se
// levanta del suelo al saltar
export function CreatureView(props: { creature: Creature; layout: CreatureLayout; lift?: number; colors?: boolean }) {
  const { layout } = props;
  const colors = props.colors ?? pc.isColorSupported;
  const room = hopRoom(layout.mode);
  const lift = Math.max(0, Math.min(room, props.lift ?? 0));
  const sprite = trimmed(layout.big ? props.creature.big : props.creature.pixels);
  const empty = Array<string | null>(sprite[0].length).fill(null);
  const pixels: Pixels = [...Array(room - lift).fill(empty), ...sprite, ...Array(lift).fill(empty)];
  const lines: Cell[][] = [];
  if (layout.mode === "fondos") {
    for (const row of pixels) {
      lines.push(row.map((cell) => (cell === null ? { text: "  " } : colors ? { text: "  ", background: cell } : { text: "██" })));
    }
  } else {
    for (let y = 0; y < pixels.length; y += 2) {
      lines.push(
        pixels[y].map((up, x) => {
          const down = pixels[y + 1]?.[x] ?? null;
          if (!colors) {
            return { text: up && down ? "█" : up ? "▀" : down ? "▄" : " " };
          }
          if (up && down) {
            return { text: "▀", color: up, background: down };
          }
          return up || down ? { text: up ? "▀" : "▄", color: (up || down)! } : { text: " " };
        }),
      );
    }
  }
  return (
    <Box flexDirection="column">
      {lines.map((cells, y) => (
        <Text key={y}>
          {merge(cells).map((run, index) =>
            run.color || run.background ? (
              <Text key={index} color={run.color} backgroundColor={run.background}>
                {run.text}
              </Text>
            ) : (
              run.text
            ),
          )}
        </Text>
      ))}
    </Box>
  );
}

// Parte un texto en líneas de como mucho «width» columnas, por los espacios
export function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && stringWidth(`${line} ${word}`) > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  return line ? [...lines, line] : lines;
}

// El panel de la derecha: la criatura (que salta mientras vipcode trabaja) y, si caben debajo, su nombre, lo que dice y
// «clic: otra». «height»: el alto que tiene; si ni el dibujo cabe, no se enseña
export function CreaturePanel(props: { creature: Creature; busy: boolean; layout: CreatureLayout; height: number }) {
  const { creature, layout } = props;
  const room = hopRoom(layout.mode);
  const { frame } = useAnimation({ interval: 160, isActive: props.busy });
  const lift = props.busy ? (room === 2 ? [0, 1, 2, 1] : [0, 0, 1, 1])[frame % 4] : 0;
  const free = props.height - 2 - spriteRows(creature, layout);
  if (free < 0) {
    return null;
  }
  // Cada línea de lo que dice por separado, para que salgan centradas
  const lines: ReactNode[] = [
    <Text key="nombre" bold color={creature.color} wrap="truncate-end">
      {creature.rare ? "★ " : ""}
      {creature.name}
    </Text>,
    ...wrapWords(creature.message, layout.width - 4).map((line, index) => (
      <Text key={`dice-${index}`} dimColor={look.dim}>
        {line}
      </Text>
    )),
    <Text key="clic" dimColor={look.dim}>
      clic: otra
    </Text>,
  ];
  return (
    <Box
      flexDirection="column"
      width={layout.width}
      flexShrink={0}
      alignSelf="flex-start"
      alignItems="center"
      borderStyle="round"
      borderColor="gray"
      borderDimColor={look.dim}
      paddingX={1}
    >
      <CreatureView creature={creature} layout={layout} lift={lift} />
      {lines.slice(0, free)}
    </Box>
  );
}
