import fs from "node:fs";
import { DEBUG_LOG_PATH, ensureHomeDir } from "./paths.js";

// Con VIPCODE_DEBUG=1 se apunta en ~/.vipcode/debug.log lo que pasa por dentro (peticiones, errores…)
const enabled = process.env.VIPCODE_DEBUG === "1" || process.env.VIPCODE_DEBUG === "true";

// Lo que tenga pinta de clave no se apunta: el registro se puede adjuntar a un issue
const SECRET = /\b(sk-[\w-]{8,}|gsk_\w{8,}|AIza[\w-]{20,}|nvapi-[\w-]{8,}|hf_\w{8,}|gh[pousr]_\w{8,}|github_pat_\w{8,}|xox[abp]-[\w-]{8,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/g;

export function redactSecrets(text: string): string {
  return text.replace(SECRET, "[clave oculta]").replace(/(authorization|api[-_]?key|token)(["':=\s]+)(bearer\s+)?[^\s"',}]{8,}/gi, "$1$2$3[clave oculta]");
}

export function debugLog(...parts: unknown[]) {
  if (!enabled) {
    return;
  }
  const text = parts
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part instanceof Error) {
        return part.stack || part.message;
      }
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .join(" ");
  try {
    ensureHomeDir();
    fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${redactSecrets(text)}\n`);
  } catch {
    // no es grave si no se puede escribir el log
  }
}
