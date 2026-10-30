import fs from "node:fs";
import path from "node:path";
import { INSTALL_DIR } from "./paths.js";

// Las novedades de CHANGELOG.md: para enseñar qué trae una versión al abrirla y avisar si trae arreglos de seguridad

export interface ChangelogSection {
  version: string;
  body: string;
}

// Cada «## [x.y.z] - fecha» con lo que trae (sin «Sin publicar»)
export function parseChangelog(text: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  const pattern = /^## \[(\d+\.\d+\.\d+)\][^\n]*\n([\s\S]*?)(?=^## \[|^\[[^\]]+\]: |(?![\s\S]))/gm;
  for (const match of text.matchAll(pattern)) {
    sections.push({ version: match[1], body: match[2].trim() });
  }
  return sections;
}

function compare(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

// Lo que traen las versiones posteriores a «from» hasta «to» (incluida), de la más nueva a la más vieja
export function sectionsBetween(sections: ChangelogSection[], from: string, to: string): ChangelogSection[] {
  return sections.filter((section) => compare(section.version, from) > 0 && compare(section.version, to) <= 0).sort((a, b) => compare(b.version, a.version));
}

export function hasSecurity(sections: ChangelogSection[]): boolean {
  return sections.some((section) => /^### Seguridad\b/m.test(section.body));
}

// El CHANGELOG.md que viene con este vipcode
export function localChangelog(): ChangelogSection[] {
  try {
    return parseChangelog(fs.readFileSync(path.join(INSTALL_DIR, "CHANGELOG.md"), "utf8"));
  } catch {
    return [];
  }
}
