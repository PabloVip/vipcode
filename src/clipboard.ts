import { spawn } from "node:child_process";
import path from "node:path";
import { isRemoteSession } from "./login.js";
import { stripControl } from "./sanitize.js";
import { findProgram, splitArgs } from "./shell.js";

// Lo que se copia, sin caracteres de control ni de dirección del texto: un modelo podría colar secuencias que, al
// pegarlo en una terminal, se salgan del pegado seguro y ejecuten algo, o código que se lee distinto de como es
export function cleanForClipboard(text: string): string {
  return stripControl(text).replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g, "");
}

// El programa que copia lo que le llega por la entrada, según el sistema (VIPCODE_CLIPBOARD permite poner otro)
function copier(): string[] | null {
  const custom = splitArgs(process.env.VIPCODE_CLIPBOARD || "");
  if (custom.length > 0) {
    return [findProgram(custom[0]) || custom[0], ...custom.slice(1)];
  }
  if (process.platform === "darwin") {
    const pbcopy = findProgram("pbcopy");
    return pbcopy ? [pbcopy] : null;
  }
  if (process.platform === "win32") {
    // PowerShell lee el texto en UTF-8 (clip.exe estropearía las tildes)
    const powershell = findProgram("powershell.exe") || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false\nSet-Clipboard -Value ([Console]::In.ReadToEnd())";
    return [powershell, "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  }
  const wayland = process.env.WAYLAND_DISPLAY ? findProgram("wl-copy") : null;
  if (wayland) {
    return [wayland];
  }
  const xclip = findProgram("xclip");
  if (xclip) {
    return [xclip, "-selection", "clipboard"];
  }
  const xsel = findProgram("xsel");
  return xsel ? [xsel, "--clipboard", "--input"] : null;
}

// Nombre del programa con el que copia /copiar (null si se lo tendría que pedir a la terminal)
export function clipboardProgram(): string | null {
  const command = copier();
  if (!command) {
    return null;
  }
  return process.platform === "win32" && !process.env.VIPCODE_CLIPBOARD ? "PowerShell" : path.basename(command[0]);
}

// OSC 52: se lo pide a la terminal, que copia aunque vipcode esté en otra máquina (por SSH). Lo entienden iTerm2,
// Windows Terminal, kitty, WezTerm, Ghostty… pero no la Terminal de macOS
function askTerminal(text: string): boolean {
  const data = Buffer.from(text, "utf8").toString("base64");
  if (!process.stdout.isTTY || data.length > 100000) {
    return false;
  }
  const sequence = `\x1b]52;c;${data}\x07`;
  // Dentro de tmux hay que envolverla para que le llegue a la terminal
  process.stdout.write(process.env.TMUX ? `\x1bPtmux;\x1b${sequence}\x1b\\` : sequence);
  return true;
}

export type CopyResult = "portapapeles" | "terminal" | null;

export function copyToClipboard(text: string): Promise<CopyResult> {
  const clean = cleanForClipboard(text);
  // Por SSH, el portapapeles de esta máquina no es el tuyo: mejor la terminal
  const command = isRemoteSession() && !process.env.VIPCODE_CLIPBOARD ? null : copier();
  if (!command) {
    return Promise.resolve(askTerminal(clean) ? "terminal" : null);
  }
  return new Promise((resolve) => {
    // Sin esperar a su salida: xclip y wl-copy se quedan en segundo plano sirviendo lo copiado
    const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.on("error", () => resolve(askTerminal(clean) ? "terminal" : null));
    child.on("exit", (code) => resolve(code === 0 ? "portapapeles" : askTerminal(clean) ? "terminal" : null));
    child.stdin?.on("error", () => {
      // si el programa no lee la entrada, ya avisa al salir
    });
    child.stdin?.end(clean);
  });
}

// El último bloque de código (```…```) de las respuestas, empezando por la más reciente
export function lastCodeBlock(answers: string[]): string | null {
  for (const answer of [...answers].reverse()) {
    const blocks = [...answer.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
    if (blocks.length > 0) {
      return blocks[blocks.length - 1][1].replace(/\n$/, "");
    }
  }
  return null;
}
