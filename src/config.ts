import fs from "node:fs";
import path from "node:path";
import { CONFIG_PATH, HOME_DIR } from "./paths.js";

export { CONFIG_PATH, HOME_DIR, SESSIONS_DIR, STATE_PATH } from "./paths.js";

// Un modelo concreto dentro de un proveedor
export interface ModelConfig {
  id: string;
  // Nombre bonito para mostrar (opcional)
  name?: string;
  // Tokens máximos que aceptamos enviar a este modelo (contexto real o límite del plan gratuito)
  context: number;
  // Acepta imágenes
  vision?: boolean;
  // false si no sabe usar herramientas (solo se usa para resúmenes)
  tools?: boolean;
  disabled?: boolean;
}

// Un proveedor compatible con la API de OpenAI
export interface ProviderConfig {
  name: string;
  // Nombre para mostrar
  label?: string;
  // Puede llevar variables, por ejemplo ${CLOUDFLARE_ACCOUNT_ID}
  baseURL: string;
  // Variable(s) de entorno donde está la clave (por ejemplo GROQ_API_KEY)
  apiKeyEnv?: string | string[];
  // Alternativa: la clave escrita directamente en el config
  apiKey?: string;
  // Variables extra que necesita la URL
  requiredVars?: string[];
  // Proveedores que funcionan sin clave (anónimos de internet o locales); si tienes clave, se usa
  noKey?: boolean;
  // Servidor en tu ordenador (Ollama, LM Studio…): se detecta solo al arrancar
  local?: boolean;
  enabled?: boolean;
  headers?: Record<string, string>;
  models: ModelConfig[];
  // En tu config: true para usar solo tus modelos y no los del catálogo
  replaceModels?: boolean;
  // Dónde conseguir la clave
  signup?: string;
  // Inicio de sesión en el navegador que crea la clave sola (solo donde el proveedor lo permite oficialmente)
  login?: "openrouter";
  // Resumen del plan gratuito
  freeInfo?: string;
  // Cómo descubrir modelos nuevos: endpoint /models normal, o el formato de OpenRouter/Kilo/LLM7
  discover?: "openai" | "openrouter" | "kilo" | "llm7";
  // Al descubrir, quedarse solo con los modelos gratis
  freeOnly?: boolean;
  // Al descubrir, quitar los modelos del catálogo que ya no existen
  pruneMissing?: boolean;
  // Expresión regular: solo se descubren los modelos cuyo id encaja
  modelFilter?: string;
  // Contexto para modelos descubiertos que no dicen el suyo
  defaultContext?: number;
  // Contexto máximo real del plan gratis (por ejemplo, Groq limita los tokens por minuto)
  contextCap?: number;
  // "provider" si el límite es de toda la cuenta y no de cada modelo
  limitScope?: "model" | "provider";
  // false si el proveedor no acepta stream_options (se aprende solo si falla)
  streamUsage?: boolean;
  // Lo pone vipcode: proveedor añadido por ti (no viene en el catálogo); va el primero en la rotación
  custom?: boolean;
}

// Cómo se ordenan los modelos: por su puntuación en LLM Stats (https://llm-stats.com)
export interface RankingConfig {
  enabled: boolean;
  // "coding" = programación, agentes y herramientas; "general" = índice general de LLM Stats
  metric: "coding" | "general";
  // true: los anónimos (sin clave) van detrás de los que tienen clave aunque tengan mejor nota
  anonymousLast: boolean;
}

export interface SkillsConfig {
  enabled: boolean;
  // Carpetas extra con skills (cada skill es una subcarpeta con su SKILL.md)
  paths: string[];
  // Nombres de skills que no se cargan
  disabled: string[];
  // Leer también las de Claude Code, opencode y .agents (~/.claude/skills, .opencode/skill…)
  external: boolean;
}

export type PermissionAction = "allow" | "ask" | "deny";

// Qué hacer antes de cada acción con riesgo; bash y mcp admiten patrones con *
export interface PermissionConfig {
  edit?: PermissionAction;
  bash?: PermissionAction | Record<string, PermissionAction>;
  webfetch?: PermissionAction;
  mcp?: PermissionAction | Record<string, PermissionAction>;
}

export interface McpServerConfig {
  // local = programa que se lanza aquí; remote = servidor por HTTP
  type?: "local" | "remote";
  command?: string | string[];
  args?: string[];
  environment?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeoutMs?: number;
}

export interface LspServerConfig {
  command: string[];
  extensions: string[];
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
  disabled?: boolean;
}

// Agente definido en el config (los .md de agents/ usan los mismos campos)
export interface AgentInput {
  description?: string;
  mode?: "primary" | "subagent" | "all";
  prompt?: string;
  model?: string;
  temperature?: number;
  tools?: Record<string, boolean>;
  permission?: PermissionConfig;
  maxSteps?: number;
  color?: string;
  readOnly?: boolean;
  disable?: boolean;
}

export interface CommandInput {
  template: string;
  description?: string;
  agent?: string;
  model?: string;
  // true para ejecutarlo como subagente y no ensuciar la conversación
  subtask?: boolean;
}

export interface Config {
  // Proveedores propios o cambios sobre los del catálogo (se mezclan por nombre)
  providers: ProviderConfig[];
  disabledProviders: string[];
  // Si no está vacío, solo se usan estos proveedores
  enabledProviders: string[];
  // Prioridad: patrones de "proveedor/modelo" que van primero, por ejemplo ["groq/*", "gemini/*"]
  order: string[];
  // Modelo preferido ("" = rotación automática)
  model: string;
  // Máximo de pasos (llamadas al modelo) por cada mensaje tuyo
  maxSteps: number;
  // A partir de estos tokens estimados se resume la conversación automáticamente
  autoCompactTokens: number;
  bashTimeoutMs: number;
  // Si un proveedor está enfriándose menos de esto, esperamos en vez de fallar
  maxWaitMs: number;
  permission: PermissionConfig;
  mcp: Record<string, McpServerConfig>;
  lsp: Record<string, LspServerConfig | false> | false;
  agents: Record<string, AgentInput>;
  commands: Record<string, CommandInput>;
  // Ficheros de instrucciones extra (rutas o patrones relativos al proyecto)
  instructions: string[];
  // Instantáneas con git para /undo y /redo
  snapshot: boolean;
  // Buscar modelos gratis nuevos una vez al día
  autoUpdateModels: boolean;
  // Usar los proveedores gratuitos que no piden clave (Kilo, OVHcloud, LLM7, Pollinations); pueden guardar lo que envías
  keyless: boolean;
  // Ordenar los modelos de mejor a peor según LLM Stats
  ranking: RankingConfig;
  // Skills: instrucciones y recursos que el agente carga cuando la tarea encaja
  skills: SkillsConfig;
  // Mostrar el razonamiento de los modelos que lo envían
  showReasoning: boolean;
}

export const DEFAULT_PERMISSION: PermissionConfig = {
  edit: "ask",
  bash: {
    "*": "ask",
    "git status*": "allow",
    "git diff*": "allow",
    "git log*": "allow",
    "git show*": "allow",
    "ls*": "allow",
    pwd: "allow",
  },
  webfetch: "ask",
  mcp: "ask",
};

export const DEFAULT_CONFIG: Config = {
  providers: [],
  disabledProviders: [],
  enabledProviders: [],
  order: [],
  model: "",
  maxSteps: 50,
  autoCompactTokens: 90000,
  bashTimeoutMs: 120000,
  maxWaitMs: 90000,
  permission: DEFAULT_PERMISSION,
  mcp: {},
  lsp: {},
  agents: {},
  commands: {},
  instructions: [],
  snapshot: true,
  autoUpdateModels: true,
  keyless: true,
  ranking: { enabled: true, metric: "coding", anonymousLast: false },
  skills: { enabled: true, paths: [], disabled: [], external: true },
  showReasoning: true,
};

// Proveedor de internet que se puede usar sin clave (los locales no cuentan)
export function isAnonymous(provider: ProviderConfig): boolean {
  return Boolean(provider.noKey && !provider.local);
}

// Lo que se escribe la primera vez en ~/.vipcode/config.json para que sea fácil de editar
const TEMPLATE = {
  model: "",
  order: [],
  disabledProviders: [],
  providers: [],
  permission: DEFAULT_PERMISSION,
  mcp: {},
  lsp: {},
  agents: {},
  commands: {},
  instructions: [],
  maxSteps: DEFAULT_CONFIG.maxSteps,
  autoCompactTokens: DEFAULT_CONFIG.autoCompactTokens,
  bashTimeoutMs: DEFAULT_CONFIG.bashTimeoutMs,
  maxWaitMs: DEFAULT_CONFIG.maxWaitMs,
  snapshot: true,
  autoUpdateModels: true,
  keyless: true,
  ranking: DEFAULT_CONFIG.ranking,
  showReasoning: true,
};

// Avisos de la carga del config para enseñarlos al arrancar
export const configNotices: string[] = [];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Mezcla objetos en profundidad; los arrays y los valores simples se sustituyen
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isObject(base) || !isObject(override)) {
    return override as T;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    if (isObject(value) && isObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

function mergeModels(base: ModelConfig[], override: ModelConfig[]): ModelConfig[] {
  const result = base.map((model) => ({ ...model }));
  for (const model of override) {
    const index = result.findIndex((existing) => existing.id === model.id);
    if (index >= 0) {
      result[index] = { ...result[index], ...model };
    } else {
      result.push({ ...model });
    }
  }
  return result;
}

export function mergeProvider(base: ProviderConfig, override: Partial<ProviderConfig>): ProviderConfig {
  let models = base.models;
  if (Array.isArray(override.models)) {
    if (override.replaceModels) {
      models = override.models.map((model) => ({ ...model }));
    } else {
      models = mergeModels(base.models, override.models);
    }
  }
  return {
    ...base,
    ...override,
    headers: { ...(base.headers || {}), ...(override.headers || {}) },
    models,
  };
}

export function mergeProviders(base: ProviderConfig[], override: ProviderConfig[]): ProviderConfig[] {
  const result = base.map((provider) => ({ ...provider }));
  for (const provider of override) {
    if (!provider || typeof provider.name !== "string") {
      continue;
    }
    const index = result.findIndex((existing) => existing.name === provider.name);
    if (index >= 0) {
      result[index] = mergeProvider(result[index], provider);
    } else {
      result.push({ ...provider, models: provider.models || [] });
    }
  }
  return result;
}

function mergeConfig(base: Config, override: Record<string, unknown>): Config {
  const result: Config = { ...base };
  const target = result as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || key.startsWith("$")) {
      continue;
    }
    if (key === "providers" && Array.isArray(value)) {
      result.providers = mergeProviders(base.providers, value as ProviderConfig[]);
    } else if ((key === "instructions" || key === "disabledProviders") && Array.isArray(value)) {
      target[key] = [...new Set([...(target[key] as string[]), ...value])];
    } else if (key === "lsp" && value === false) {
      result.lsp = false;
    } else if (["permission", "mcp", "lsp", "agents", "commands", "ranking", "skills"].includes(key) && isObject(value)) {
      target[key] = deepMerge(target[key] || {}, value);
    } else {
      target[key] = value;
    }
  }
  return result;
}

// El config.json que creaba la versión 0.1 traía la lista de proveedores entera (ya anticuada)
function isOldGeneratedConfig(raw: Record<string, unknown>): boolean {
  const oldKeys = ["providers", "maxSteps", "autoCompactTokens", "bashTimeoutMs", "maxWaitMs"];
  if (Object.keys(raw).some((key) => !oldKeys.includes(key))) {
    return false;
  }
  const providers = raw.providers;
  if (!Array.isArray(providers)) {
    return false;
  }
  const names = providers.map((p) => (p as ProviderConfig).name).join(",");
  if (names !== "gemini,openrouter,cerebras,groq,mistral,github,ollama") {
    return false;
  }
  return (
    raw.maxSteps === 40 && raw.autoCompactTokens === 90000 && raw.bashTimeoutMs === 120000 && raw.maxWaitMs === 90000
  );
}

function readJson(file: string): Record<string, unknown> {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isObject(data)) {
      throw new Error("no es un objeto JSON");
    }
    return data;
  } catch (err) {
    throw new Error(`No se pudo leer ${file}: ${(err as Error).message}`);
  }
}

// Config del proyecto: vipcode.json o .vipcode/config.json en la carpeta donde ejecutas vipcode
export function projectConfigFiles(root: string): string[] {
  const candidates = [path.join(root, "vipcode.json"), path.join(root, ".vipcode", "config.json")];
  return candidates.filter((file) => path.resolve(file) !== path.resolve(CONFIG_PATH) && fs.existsSync(file));
}

// Cambia un valor de tu config global (~/.vipcode/config.json) sin tocar el resto
export function setGlobalConfigValue(key: string, value: unknown) {
  loadConfig();
  const raw = readJson(CONFIG_PATH);
  raw[key] = value;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
}

export function loadConfig(root: string = process.cwd()): Config {
  fs.mkdirSync(HOME_DIR, { recursive: true });

  // La primera vez creamos el config con los valores por defecto para que puedas editarlo
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(TEMPLATE, null, 2));
  }

  let raw = readJson(CONFIG_PATH);
  if (isOldGeneratedConfig(raw)) {
    fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(TEMPLATE, null, 2));
    raw = readJson(CONFIG_PATH);
    configNotices.push(`He actualizado ${CONFIG_PATH} al formato nuevo (copia del antiguo en config.json.bak).`);
  }

  let config = mergeConfig(DEFAULT_CONFIG, raw);
  for (const file of projectConfigFiles(root)) {
    config = mergeConfig(config, readJson(file));
  }
  if (!Array.isArray(config.providers)) {
    config.providers = [];
  }
  return config;
}
