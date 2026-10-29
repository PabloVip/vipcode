import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

// Separa la cabecera YAML (entre ---) del cuerpo de un .md
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(text);
  if (!match) {
    return { data: {}, body: text };
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(match[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  return { data, body: match[2] };
}

// Lee todos los .md de varias carpetas (las que no existen se ignoran); el nombre sale del fichero
export function readMarkdownDir(dirs: string[]): { name: string; file: string; data: Record<string, unknown>; body: string }[] {
  const result: { name: string; file: string; data: Record<string, unknown>; body: string }[] = [];
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir).filter((entry) => entry.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry);
      try {
        const { data, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
        result.push({ name: entry.replace(/\.md$/, ""), file, data, body: body.trim() });
      } catch {
        // fichero ilegible: lo saltamos
      }
    }
  }
  return result;
}
