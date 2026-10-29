import hljs from "highlight.js/lib/common";
import { type Token, type Tokens, marked } from "marked";
import pc from "picocolors";
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
          out += `${pc.underline(pc.blue(text))} ${pc.dim(`(${link.href})`)}`;
        }
        break;
      }
      case "image":
        out += pc.dim(`[imagen: ${(token as Tokens.Image).text || (token as Tokens.Image).href}]`);
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
    const body = blocks(item.tokens, width - 3, depth + 1).replace(/^\n+|\n+$/g, "");
    const [first, ...rest] = body.split("\n");
    const pad = " ".repeat(bullet.length + 1);
    lines.push(`${pc.yellow(bullet)} ${first || ""}`);
    for (const line of rest) {
      lines.push(pad + line);
    }
  }
  return lines.join("\n");
}

function renderTable(table: Tokens.Table): string {
  const header = table.header.map((cell) => inline(cell.tokens));
  const rows = table.rows.map((row) => row.map((cell) => inline(cell.tokens)));
  const visible = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").length;
  const widths = header.map((cell, i) => Math.max(visible(cell), ...rows.map((row) => visible(row[i] || ""))));
  const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visible(text)));
  const line = (cells: string[]) => cells.map((cell, i) => pad(cell, widths[i])).join(pc.dim(" │ "));
  const out = [pc.bold(line(header)), pc.dim(widths.map((w) => "─".repeat(w)).join("─┼─"))];
  for (const row of rows) {
    out.push(line(row));
  }
  return out.join("\n");
}

function blocks(tokens: Token[], width: number, depth = 0): string {
  const out: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const heading = token as Tokens.Heading;
        const text = inline(heading.tokens);
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
        out.push(inline((token as Tokens.Paragraph).tokens));
        break;
      case "text": {
        const text = token as Tokens.Text;
        out.push(text.tokens ? inline(text.tokens) : decodeHtml(text.text));
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        const label = code.lang ? pc.dim(`─ ${code.lang} `) : pc.dim("─");
        out.push(`${label}${pc.dim("─".repeat(Math.max(0, Math.min(width, 60) - (code.lang || "").length - 3)))}`);
        out.push(indent(highlightCode(code.text, code.lang), "  "));
        out.push(pc.dim("─".repeat(Math.min(width, 60))));
        break;
      }
      case "blockquote":
        out.push(indent(blocks((token as Tokens.Blockquote).tokens, width - 2, depth), pc.dim("│ ")));
        break;
      case "list":
        out.push(renderList(token as Tokens.List, width, depth));
        break;
      case "table":
        out.push(renderTable(token as Tokens.Table));
        break;
      case "hr":
        out.push(pc.dim("─".repeat(Math.min(width, 60))));
        break;
      case "html":
        out.push((token as Tokens.HTML).text.trim());
        break;
      case "space":
        break;
      default:
        out.push((token as any).raw || "");
    }
  }
  if (depth > 0) {
    return out.join("\n");
  }
  return out.join("\n\n");
}

// Markdown → texto con colores para la terminal
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
