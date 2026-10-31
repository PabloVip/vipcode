import hljs from "highlight.js/lib/common";
import { type Token, type Tokens, marked } from "marked";
import pc from "picocolors";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { stripControl } from "./sanitize.js";

// Colores de resaltado de código por clase de highlight.js
const CODE_COLORS: Record<string, (text: string) => string> = {
  keyword: pc.magenta,
  built_in: pc.cyan,
  type: pc.cyan,
  literal: pc.blue,
  number: pc.yellow,
  string: pc.green,
  regexp: pc.red,
  comment: pc.gray,
  doctag: pc.gray,
  meta: pc.gray,
  function: pc.blue,
  title: pc.blue,
  "title.class": pc.yellow,
  "title.function": pc.blue,
  params: (text) => text,
  attr: pc.yellow,
  attribute: pc.yellow,
  variable: pc.red,
  "variable.language": pc.magenta,
  tag: pc.red,
  name: pc.red,
  "selector-tag": pc.red,
  "selector-class": pc.yellow,
  "selector-id": pc.yellow,
  symbol: pc.yellow,
  bullet: pc.yellow,
  section: pc.bold,
  addition: pc.green,
  deletion: pc.red,
  emphasis: pc.italic,
  strong: pc.bold,
  property: pc.cyan,
  operator: (text) => text,
  punctuation: (text) => text,
  subst: (text) => text,
};

// Lo secundario (enlaces, rayas, bordes de tablas y citas) va atenuado
const faint = pc.dim;

// Parte el texto (con sus colores) al ancho que hay, por palabras y sin espacios al principio de las líneas partidas. Se
// parte aquí y no en la pantalla para que cada línea lleve su sangría: la de las listas, la raya de las citas…
function wrap(text: string, width: number): string {
  return wrapAnsi(text, Math.max(1, width), { hard: true, trim: true });
}

// El código se parte justo en el ancho, sin quitarle espacios (la sangría importa), y lo que baja lleva su sangría
function wrapCode(code: string, width: number, prefix: string): string {
  return code
    .split("\n")
    .map((line) => wrapAnsi(line, Math.max(1, width - stringWidth(prefix)), { hard: true, trim: false, wordWrap: false }))
    .join("\n")
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function decodeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// highlight.js devuelve HTML con <span class="hljs-…">; lo convertimos en colores de terminal
function htmlToAnsi(html: string): string {
  const stack: string[] = [];
  let out = "";
  const pattern = /<span class="([^"]+)">|<\/span>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    if (match[1] !== undefined) {
      stack.push(match[1].replace(/hljs-/g, "").split(" ")[0]);
    } else if (match[0] === "</span>") {
      stack.pop();
    } else if (match[2] !== undefined) {
      const text = decodeHtml(match[2]);
      let colored = text;
      for (let i = stack.length - 1; i >= 0; i--) {
        const color = CODE_COLORS[stack[i]] || CODE_COLORS[stack[i].split(".")[0]];
        if (color) {
          colored = color(text);
          break;
        }
      }
      out += colored;
    }
  }
  return out;
}

export function highlightCode(code: string, lang: string | undefined): string {
  const language = (lang || "").trim().split(/\s+/)[0].toLowerCase();
  if (language && hljs.getLanguage(language)) {
    try {
      return htmlToAnsi(hljs.highlight(code, { language, ignoreIllegals: true }).value);
    } catch {
      // si falla, sin colores
    }
  }
  return code;
}

function inline(tokens: Token[] | undefined): string {
  if (!tokens) {
    return "";
  }
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        out += pc.bold(inline((token as Tokens.Strong).tokens));
        break;
      case "em":
        out += pc.italic(inline((token as Tokens.Em).tokens));
        break;
      case "del":
        out += pc.strikethrough(inline((token as Tokens.Del).tokens));
        break;
      case "codespan":
        out += pc.cyan(decodeHtml((token as Tokens.Codespan).text));
        break;
      case "link": {
        const link = token as Tokens.Link;
        const text = inline(link.tokens);
        if (text === link.href || link.href.startsWith("mailto:")) {
          out += pc.underline(pc.blue(text));
        } else {
          out += `${pc.underline(pc.blue(text))} ${faint(`(${link.href})`)}`;
        }
        break;
      }
      case "image":
        out += faint(`[imagen: ${(token as Tokens.Image).text || (token as Tokens.Image).href}]`);
        break;
      case "br":
        out += "\n";
        break;
      case "escape":
        out += (token as Tokens.Escape).text;
        break;
      case "text": {
        const text = token as Tokens.Text;
        if (text.tokens && text.tokens.length > 0) {
          out += inline(text.tokens);
        } else {
          out += decodeHtml(text.text);
        }
        break;
      }
      case "html":
        out += (token as Tokens.HTML).text;
        break;
      default:
        out += decodeHtml((token as any).raw || "");
    }
  }
  return out;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function renderList(list: Tokens.List, width: number, depth: number): string {
  const lines: string[] = [];
  let number = typeof list.start === "number" ? list.start : 1;
  for (const item of list.items) {
    let bullet = "•";
    if (list.ordered) {
      bullet = `${number}.`;
      number++;
    }
    if (item.task) {
      bullet = item.checked ? pc.green("☑") : "☐";
    }
    // Lo que no cabe en una línea sigue debajo del texto, no debajo del punto
    const pad = " ".repeat(stringWidth(bullet) + 1);
    const body = blocks(item.tokens, width - pad.length, depth + 1).replace(/^\n+|\n+$/g, "");
    const [first, ...rest] = body.split("\n");
    lines.push(`${pc.yellow(bullet)} ${first || ""}`);
    for (const line of rest) {
      lines.push(pad + line);
    }
  }
  return lines.join("\n");
}

// Cuánto ocupa cada columna de una tabla que no cabe: las que caben en su parte se quedan con su ancho, y las demás se
// reparten lo que queda (su texto se parte en varias líneas)
function fitColumns(natural: number[], room: number): number[] {
  const widths = [...natural];
  let left = room;
  let open = natural.map((_, index) => index);
  while (open.length > 0) {
    const share = Math.floor(left / open.length);
    const fits = open.filter((index) => natural[index] <= share);
    if (fits.length === 0) {
      const extra = left - share * open.length;
      open.forEach((index, order) => (widths[index] = share + (order < extra ? 1 : 0)));
      break;
    }
    for (const index of fits) {
      left -= natural[index];
    }
    open = open.filter((index) => !fits.includes(index));
  }
  return widths.map((value) => Math.max(3, value));
}

function renderTable(table: Tokens.Table, width: number): string {
  const header = table.header.map((cell) => inline(cell.tokens));
  const rows = table.rows.map((row) => header.map((_, index) => inline(row[index]?.tokens)));
  const natural = header.map((cell, index) => Math.max(1, stringWidth(cell), ...rows.map((row) => stringWidth(row[index]))));
  // Entre columna y columna van 3 (« │ »)
  const room = width - (header.length - 1) * 3;
  const widths = natural.reduce((total, value) => total + value, 0) > room ? fitColumns(natural, room) : natural;
  const pad = (text: string, size: number) => text + " ".repeat(Math.max(0, size - stringWidth(text)));
  const line = (cells: string[]) => {
    const parts = cells.map((cell, index) => wrap(cell, widths[index]).split("\n"));
    const height = Math.max(...parts.map((part) => part.length));
    return Array.from({ length: height }, (_, row) => parts.map((part, index) => pad(part[row] || "", widths[index])).join(faint(" │ ")).trimEnd());
  };
  const out = [...line(header).map((text) => pc.bold(text)), faint(widths.map((size) => "─".repeat(size)).join("─┼─"))];
  for (const row of rows) {
    out.push(...line(row));
  }
  return out.join("\n");
}

function blocks(tokens: Token[], width: number, depth = 0): string {
  const out: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const heading = token as Tokens.Heading;
        const text = wrap(inline(heading.tokens), width);
        if (heading.depth === 1) {
          out.push(pc.bold(pc.underline(pc.magenta(text))));
        } else if (heading.depth === 2) {
          out.push(pc.bold(pc.cyan(text)));
        } else {
          out.push(pc.bold(text));
        }
        break;
      }
      case "paragraph":
        out.push(wrap(inline((token as Tokens.Paragraph).tokens), width));
        break;
      case "text": {
        const text = token as Tokens.Text;
        out.push(wrap(text.tokens ? inline(text.tokens) : decodeHtml(text.text), width));
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        // El nombre del lenguaje también se corta: con uno larguísimo, la raya no puede pasar del ancho
        const lang = (code.lang || "").slice(0, Math.max(0, Math.min(width, 60) - 4));
        const label = lang ? faint(`─ ${lang} `) : faint("─");
        out.push(`${label}${faint("─".repeat(Math.max(0, Math.min(width, 60) - lang.length - 3)))}`);
        out.push(wrapCode(highlightCode(code.text, code.lang), width, "  "));
        out.push(faint("─".repeat(Math.min(width, 60))));
        break;
      }
      case "blockquote":
        out.push(indent(blocks((token as Tokens.Blockquote).tokens, width - 2, depth), faint("│ ")));
        break;
      case "list":
        out.push(renderList(token as Tokens.List, width, depth));
        break;
      case "table":
        out.push(renderTable(token as Tokens.Table, width));
        break;
      case "hr":
        out.push(faint("─".repeat(Math.min(width, 60))));
        break;
      case "html":
        out.push(wrap((token as Tokens.HTML).text.trim(), width));
        break;
      // La casilla de las listas de tareas ya va en el punto (☑ o ☐)
      case "space":
      case "checkbox":
        break;
      default:
        out.push(wrap((token as any).raw || "", width));
    }
  }
  if (depth > 0) {
    return out.join("\n");
  }
  return out.join("\n\n");
}

// Markdown → texto con colores para la terminal, partido para que quepa en «width» columnas
export function renderMarkdown(text: string, width = 80): string {
  // El texto del modelo no puede llevar secuencias de la terminal: los colores los ponemos nosotros
  const clean = stripControl(text);
  try {
    const tokens = marked.lexer(clean, { gfm: true });
    return blocks(tokens, width).replace(/\n{3,}/g, "\n\n");
  } catch {
    return clean;
  }
}
