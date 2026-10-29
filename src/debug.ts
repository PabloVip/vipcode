import fs from "node:fs";
import { DEBUG_LOG_PATH, ensureHomeDir } from "./paths.js";

// Con VIPCODE_DEBUG=1 se apunta en ~/.vipcode/debug.log lo que pasa por dentro (peticiones, errores…)
const enabled = process.env.VIPCODE_DEBUG === "1" || process.env.VIPCODE_DEBUG === "true";

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
    fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${text}\n`);
  } catch {
    // no es grave si no se puede escribir el log
  }
}
