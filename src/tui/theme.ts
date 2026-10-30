import pc from "picocolors";
import { INTERFACES, type Interface } from "../interfaces.js";

// Cómo se pinta la pantalla según la interfaz elegida con /interfaz. Los componentes lo leen al pintarse, así que al
// cambiar de interfaz basta con volver a pintar

let current: Interface = INTERFACES[0];

export function setLook(next: Interface) {
  current = next;
}

export const look = {
  get interface(): Interface {
    return current;
  },
  // Para dimColor: con alto contraste no se atenúa nada
  get dim(): boolean {
    return !current.contrast;
  },
  // En vez de pc.dim
  faint(text: string): string {
    return current.contrast ? text : pc.dim(text);
  },
  // Línea en blanco entre mensajes (ninguna en la compacta)
  get gap(): number {
    return current.compact ? 0 : 1;
  },
  // Sin bordes ni bienvenida grande (compacta y zen)
  get bare(): boolean {
    return current.compact || current.minimal;
  },
  get minimal(): boolean {
    return current.minimal;
  },
  // El color, vivo con alto contraste («magenta» → «magentaBright»)
  tone(color: string | undefined): string | undefined {
    if (!color || !current.contrast || !/^(black|red|green|yellow|blue|magenta|cyan|white|gray)$/.test(color)) {
      return color;
    }
    return color === "gray" ? "white" : `${color}Bright`;
  },
};
