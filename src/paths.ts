import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Carpeta de datos de vipcode (VIPCODE_HOME permite usar otra, por ejemplo en pruebas)
export const HOME_DIR = process.env.VIPCODE_HOME || path.join(os.homedir(), ".vipcode");
export const CONFIG_PATH = path.join(HOME_DIR, "config.json");
export const STATE_PATH = path.join(HOME_DIR, "state.json");
// Claves añadidas con "vipcode auth login" o /connect (solo legible por tu usuario)
export const AUTH_PATH = path.join(HOME_DIR, "auth.json");
// Modelos descubiertos automáticamente en cada proveedor
export const MODELS_CACHE_PATH = path.join(HOME_DIR, "models.json");
// Puntuaciones de LLM Stats descargadas con la API (si tienes clave)
export const RANKING_PATH = path.join(HOME_DIR, "ranking.json");
export const HISTORY_PATH = path.join(HOME_DIR, "history.jsonl");
// Avisos que ya has visto (por ejemplo el de privacidad de los proveedores sin clave)
export const NOTICES_PATH = path.join(HOME_DIR, "notices.json");
// Última comprobación de versiones nuevas en GitHub
export const UPDATE_PATH = path.join(HOME_DIR, "update.json");
// Carpetas en las que confías para usar la configuración que traen
export const TRUST_PATH = path.join(HOME_DIR, "trusted.json");
export const SESSIONS_DIR = path.join(HOME_DIR, "sessions");
export const SNAPSHOTS_DIR = path.join(HOME_DIR, "snapshots");
export const EXPORTS_DIR = path.join(HOME_DIR, "exports");
export const GLOBAL_AGENTS_DIR = path.join(HOME_DIR, "agents");
export const GLOBAL_COMMANDS_DIR = path.join(HOME_DIR, "commands");
// Skills instaladas con "vipcode skills add" o creadas con "vipcode skills new"
export const GLOBAL_SKILLS_DIR = path.join(HOME_DIR, "skills");
// Instrucciones que se aplican a todos tus proyectos
export const GLOBAL_INSTRUCTIONS_PATH = path.join(HOME_DIR, "AGENTS.md");
export const DEBUG_LOG_PATH = path.join(HOME_DIR, "debug.log");

// La carpeta de datos guarda claves y conversaciones: solo la puede abrir tu usuario
export function ensureHomeDir() {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(HOME_DIR, 0o700);
  } catch {
    // en Windows o en carpetas que no son tuyas no se puede: no pasa nada
  }
}

// Carpeta donde está instalado vipcode (la que contiene dist/)
export const INSTALL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Lo que el agente no puede tocar: los datos de vipcode (claves, configuración, carpetas de confianza) ni leerlos,
// y su propio código no modificarlo. Quien desarrolle vipcode con vipcode puede permitir lo segundo con
// VIPCODE_ALLOW_SELF_EDIT=1.
// macOS y Windows no distinguen mayúsculas en las rutas: ~/.VIPCODE es la misma carpeta que ~/.vipcode
const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";

// true si file es dir o está dentro de dir
export function isInside(file: string, dir: string): boolean {
  const a = FOLD_CASE ? file.toLowerCase() : file;
  const b = FOLD_CASE ? dir.toLowerCase() : dir;
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

// true si el fichero, siguiendo los enlaces simbólicos, está de verdad dentro de la carpeta. Lo que trae un proyecto
// (AGENTS.md, agentes, comandos, skills) puede ser un enlace a ~/.ssh/id_rsa o a /proc/self/environ: no se lee
export function realInside(file: string, dir: string): boolean {
  try {
    return isInside(fs.realpathSync.native(file), fs.realpathSync.native(dir));
  } catch {
    return false;
  }
}

// true si la carpeta es la de datos de vipcode: al abrir vipcode en tu carpeta personal, su .vipcode es tu
// configuración, no la que trae un proyecto
export function isDataDir(dir: string): boolean {
  try {
    const a = fs.realpathSync.native(dir);
    const b = fs.realpathSync.native(HOME_DIR);
    return FOLD_CASE ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

export function protectedDirs(): { dir: string; read: boolean }[] {
  const dirs = [{ dir: HOME_DIR, read: true }];
  if (process.env.VIPCODE_ALLOW_SELF_EDIT !== "1") {
    dirs.push({ dir: INSTALL_DIR, read: false });
  }
  return dirs;
}

