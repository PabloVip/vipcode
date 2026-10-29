import os from "node:os";
import path from "node:path";

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
