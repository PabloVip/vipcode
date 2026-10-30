import stringWidth from "string-width";
import { stripControl } from "../sanitize.js";

// La conversación en pantalla completa: buscar en ella (Ctrl+F) y la barra de desplazamiento

export interface Match {
  line: number;
  // Columna en pantalla y ancho de lo encontrado
  col: number;
  width: number;
}

// Sin tildes ni mayúsculas, letra a letra (para que cada posición siga siendo la misma): «Sesión» → «sesion»
function fold(text: string): string {
  return [...text]
    .map((char) => {
      const plain = char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
      return [...plain].length === 1 ? plain : char;
    })
    .join("");
}

// Dónde aparece lo buscado, sin distinguir mayúsculas ni tildes, de arriba abajo
export function findMatches(lines: string[], query: string): Match[] {
  const wanted = [...fold(query)];
  if (wanted.length === 0 || wanted.join("").trim() === "") {
    return [];
  }
  const matches: Match[] = [];
  lines.forEach((line, index) => {
    const chars = [...stripControl(line)];
    const folded = [...fold(chars.join(""))];
    for (let i = 0; i + wanted.length <= folded.length; i++) {
      if (wanted.every((char, j) => folded[i + j] === char)) {
        matches.push({ line: index, col: stringWidth(chars.slice(0, i).join("")), width: stringWidth(chars.slice(i, i + wanted.length).join("")) });
        i += wanted.length - 1;
      }
    }
  });
  return matches;
}

// La barra de desplazamiento: dónde empieza el trozo que se ve y cuánto ocupa, en filas (null si cabe todo)
export function scrollThumb(total: number, height: number, top: number): { start: number; size: number } | null {
  if (total <= height || height <= 0) {
    return null;
  }
  const size = Math.max(1, Math.round((height * height) / total));
  const start = Math.round((top / (total - height)) * (height - size));
  return { start: Math.max(0, Math.min(height - size, start)), size };
}
