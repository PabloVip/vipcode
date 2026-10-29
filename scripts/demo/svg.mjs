// Convierte una grabación asciicast v2 de vipcode en un SVG animado para el README: reproduce la grabación en un
// emulador de terminal, toma los fotogramas y los apila; una animación CSS los va enseñando uno a uno
import fs from "node:fs";
import xterm from "@xterm/headless";

const { Terminal } = xterm;

// Esperas al modelo, más rápidas; lo demás a tiempo real. Como mucho un fotograma cada FRAME_MS
const SPEED = { escribe: 1, espera: 4, dialogo: 1, hecho: 1 };
const FRAME_MS = 80;
const LAST_HOLD = 5000;
const START_HOLD = 1200;

const CW = 8.4;
const LH = 18;
const PAD = 16;
const BAR = 34;
const FONT = 14;

// Tema oscuro (paleta de la terminal de GitHub)
const BG = "#0d1117";
const FG = "#c9d1d9";
const ANSI = ["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4", "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc"];

function rgb(value) {
  return `#${value.toString(16).padStart(6, "0")}`;
}

function palette(index) {
  if (index < 16) {
    return ANSI[index];
  }
  if (index < 232) {
    const n = index - 16;
    const level = (v) => (v === 0 ? 0 : 55 + v * 40);
    return rgb((level(Math.floor(n / 36)) << 16) | (level(Math.floor(n / 6) % 6) << 8) | level(n % 6));
  }
  const gray = 8 + (index - 232) * 10;
  return rgb((gray << 16) | (gray << 8) | gray);
}

function color(cell, kind) {
  const isDefault = kind === "fg" ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) {
    return null;
  }
  const value = kind === "fg" ? cell.getFgColor() : cell.getBgColor();
  const isRgb = kind === "fg" ? cell.isFgRGB() : cell.isBgRGB();
  return isRgb ? rgb(value) : palette(value);
}

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// La pantalla como líneas de tramos con el mismo estilo
function snapshot(term) {
  const buffer = term.buffer.active;
  const lines = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    const runs = [];
    let run = null;
    for (let x = 0; line && x < term.cols; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) {
        continue;
      }
      let fg = color(cell, "fg");
      let bg = color(cell, "bg");
      if (cell.isInverse()) {
        [fg, bg] = [bg || BG, fg || FG];
      }
      const style = `${fg}|${bg}|${cell.isBold() ? 1 : 0}${cell.isDim() ? 1 : 0}${cell.isItalic() ? 1 : 0}${cell.isUnderline() ? 1 : 0}`;
      const chars = cell.getChars() || " ";
      if (run && run.style === style && run.end === x) {
        run.text += chars;
        run.end = x + cell.getWidth();
      } else {
        run = { x, end: x + cell.getWidth(), text: chars, style, fg, bg, bold: cell.isBold(), dim: cell.isDim(), italic: cell.isItalic(), underline: cell.isUnderline() };
        runs.push(run);
      }
    }
    lines.push(runs.filter((r) => r.bg || r.text.trim() !== ""));
  }
  return lines;
}

function lineSvg(runs) {
  let out = "";
  for (const r of runs) {
    if (r.bg) {
      out += `<rect x="${(r.x * CW).toFixed(1)}" y="0" width="${((r.end - r.x) * CW).toFixed(1)}" height="${LH}" fill="${r.bg}"/>`;
    }
  }
  for (const r of runs) {
    const text = r.text.replace(/\s+$/, "");
    if (!text) {
      continue;
    }
    const cls = [r.bold ? "b" : "", r.dim ? "d" : "", r.italic ? "i" : "", r.underline ? "u" : ""].filter(Boolean).join(" ");
    // textLength: cada carácter ocupa su casilla aunque el tipo de letra de quien lo ve sea algo más ancho o estrecho
    const width = (text.length * CW).toFixed(1);
    out += `<text x="${(r.x * CW).toFixed(1)}" y="${LH - 5}"${r.fg ? ` fill="${r.fg}"` : ""}${cls ? ` class="${cls}"` : ""} textLength="${width}" lengthAdjust="spacingAndGlyphs">${escape(text)}</text>`;
  }
  return out;
}

// Reproduce la grabación y devuelve los fotogramas distintos con su momento (las esperas al modelo, aceleradas)
async function readFrames(castFile) {
  const raw = fs.readFileSync(castFile, "utf8").trim().split("\n");
  const header = JSON.parse(raw[0]);
  const events = raw.slice(1).map((line) => JSON.parse(line));
  const term = new Terminal({ cols: header.width, rows: header.height, scrollback: 0, allowProposedApi: true });
  const write = (data) => new Promise((resolve) => term.write(data, resolve));

  const frames = [];
  let phase = "inicio";
  let clock = 0;
  let last = 0;
  let pending = "";
  let pendingAt = 0;
  const flush = async () => {
    if (!pending) {
      return;
    }
    await write(pending);
    pending = "";
    const screen = snapshot(term);
    const key = JSON.stringify(screen);
    const previous = frames[frames.length - 1];
    if (previous && previous.key === key) {
      return;
    }
    // Muy seguidos: este sustituye al anterior (así no salen más de 1000 / FRAME_MS por segundo)
    if (previous && clock - previous.at < FRAME_MS && frames.length > 1) {
      frames[frames.length - 1] = { at: previous.at, key, screen };
      return;
    }
    frames.push({ at: clock, key, screen });
  };
  for (const [time, kind, data] of events) {
    const ms = time * 1000;
    // Lo que llega casi a la vez (menos de 25 ms) es un mismo fotograma
    if (pending && ms - pendingAt > 25) {
      await flush();
    }
    clock += (ms - last) / (SPEED[phase] || 1);
    last = ms;
    if (kind === "m") {
      if (data === "fin") {
        break;
      }
      phase = data;
      continue;
    }
    if (!pending) {
      pendingAt = ms;
    }
    pending += data;
  }
  await flush();
  // Fuera la pantalla vacía del principio
  while (frames.length > 1 && frames[0].screen.every((line) => line.length === 0)) {
    frames.shift();
  }
  return { header, frames };
}

export async function castToSvg(castFile) {
  const { header, frames } = await readFrames(castFile);
  const origin = frames[0].at - START_HOLD;
  const times = frames.map((frame) => frame.at - origin);
  const total = times[times.length - 1] + LAST_HOLD;

  // Cada línea distinta se dibuja una vez y los fotogramas la reutilizan
  const ids = new Map();
  const defs = [];
  const lineId = (runs) => {
    const svg = lineSvg(runs);
    if (!ids.has(svg)) {
      ids.set(svg, `l${ids.size}`);
      defs.push(`<g id="${ids.get(svg)}">${svg}</g>`);
    }
    return ids.get(svg);
  };
  const screenH = header.height * LH;
  // Entre fotograma y fotograma, dos líneas vacías: así lo que sobresale de un carácter (│) no asoma en el de al lado
  const stride = screenH + 2 * LH;
  const film = frames
    .map((frame, i) => {
      const uses = frame.screen.map((runs, row) => (runs.length ? `<use href="#${lineId(runs)}" y="${row * LH}"/>` : "")).join("");
      return `<g transform="translate(0 ${i * stride})">${uses}</g>`;
    })
    .join("\n");
  const keyframes = times.map((time, i) => `${((time / total) * 100).toFixed(3)}%{transform:translateY(${-i * stride}px)}`).join("");

  const width = Math.round(header.width * CW + PAD * 2);
  const height = Math.round(screenH + BAR + PAD);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="titulo">
<title id="titulo">vipcode arregla un fallo en carrito.js: lee el fichero, enseña el cambio, pide permiso y lo aplica</title>
<style>
text{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:${FONT}px;white-space:pre;fill:${FG}}
.b{font-weight:700}.d{opacity:.55}.i{font-style:italic}.u{text-decoration:underline}
#film{animation:pasa ${(total / 1000).toFixed(2)}s step-end infinite}
@keyframes pasa{${keyframes}100%{transform:translateY(${-(frames.length - 1) * stride}px)}}
</style>
<defs>
${defs.join("\n")}
</defs>
<rect width="${width}" height="${height}" rx="10" fill="${BG}"/>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="none" stroke="#30363d"/>
<circle cx="20" cy="17" r="6" fill="#ff5f57"/><circle cx="40" cy="17" r="6" fill="#febc2e"/><circle cx="60" cy="17" r="6" fill="#28c840"/>
<text x="${width / 2}" y="22" text-anchor="middle" style="fill:#8b949e;font-size:13px">vipcode — ~/tienda</text>
<svg x="${PAD}" y="${BAR}" width="${(header.width * CW).toFixed(1)}" height="${screenH}">
<g id="film">
${film}
</g>
</svg>
</svg>
`;
  return { svg, frames: frames.length, seconds: total / 1000 };
}
