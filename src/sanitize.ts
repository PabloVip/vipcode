// Lo que llega del modelo, de las herramientas o de los proveedores no puede mover el cursor, borrar la pantalla,
// cambiar el portapapeles (OSC 52) ni disfrazar un comando en el diálogo de permiso

// Secuencias completas (CSI, OSC, DCS…) y escapes sueltos
const SEQUENCES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[@-Z\\-_]?/g;
// Caracteres de control salvo el tabulador y el salto de línea (incluye \r y los C1, como el CSI de un byte)
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
// Colores y estilos (SGR): son inofensivos salvo «oculto» (8), que escondería texto
const SGR = /\x1b\[([0-9;]*)m/g;

// Para enseñar texto que no es nuestro
export function stripControl(text: string): string {
  return String(text).replace(SEQUENCES, "").replace(CONTROLS, "");
}

// Para nuestros propios bloques (tablas con colores) que llevan dentro datos de fuera: deja solo los colores
export function stripUnsafe(text: string): string {
  const input = String(text);
  let result = "";
  let last = 0;
  for (const match of input.matchAll(SGR)) {
    result += stripControl(input.slice(last, match.index));
    if (!match[1].split(";").includes("8")) {
      result += match[0];
    }
    last = (match.index || 0) + match[0].length;
  }
  return result + stripControl(input.slice(last));
}

// Para lo que vas a aprobar (comandos, rutas, diffs): los caracteres de control se ven en vez de actuar
export function showControl(text: string): string {
  return String(text).replace(CONTROLS, (char) => {
    if (char === "\x1b") {
      return "␛";
    }
    if (char === "\r") {
      return "␍";
    }
    return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}
