import fs from "node:fs";
import { type Credentials, readAuth, resolveCredentials } from "./auth.js";
import { CATALOG, RETIRED_PROVIDERS } from "./catalog.js";
import { type Config, type ModelConfig, type ProviderConfig, configNotices, isAnonymous, mergeProvider } from "./config.js";
import { debugLog } from "./debug.js";
import { HOME_DIR, MODELS_CACHE_PATH } from "./paths.js";

// Modelos descubiertos en cada proveedor, guardados en ~/.vipcode/models.json
export interface DiscoveryCache {
  updated: number;
  providers: Record<string, { updated: number; models: ModelConfig[] }>;
}

export interface RefreshSummary {
  updated: { name: string; count: number; added: string[] }[];
  failed: { name: string; error: string }[];
}

// Modelos que no sirven para chatear (embeddings, voz, imágenes, vídeo…)
const NON_CHAT =
  /embed|bge-|minilm|rerank|guard|safety|moderation|whisper|tts|transcri|speech|audio-|native-audio|image|imagen|flux|diffusion|sdxl|video|veo|lyria|ocr|retriever|reward|nvclip|clip-|cosmos|bevformer|sparsedrive|streampetr|detector|studiovoice|riva|canary|parakeet|paligemma|grounding|aqa|deplot|kosmos|fuyu|neva|translate|computer-use|robotics|-live|usdcode|usdvalidate|usdsearch/i;

export function readDiscovery(): DiscoveryCache {
  try {
    const data = JSON.parse(fs.readFileSync(MODELS_CACHE_PATH, "utf8"));
    if (data && typeof data === "object" && data.providers) {
      return data as DiscoveryCache;
    }
  } catch {
    // todavía no se ha descubierto nada
  }
  return { updated: 0, providers: {} };
}

function writeDiscovery(cache: DiscoveryCache) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(MODELS_CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {
    // no es grave si no se puede guardar
  }
}

export function discoveryIsStale(maxAgeMs = 24 * 60 * 60 * 1000): boolean {
  return Date.now() - readDiscovery().updated > maxAgeMs;
}

// Junta los modelos del catálogo con los descubiertos, manteniendo el orden del catálogo
function combine(provider: ProviderConfig, discovered: ModelConfig[], handAdded: Set<string> = new Set()): ModelConfig[] {
  const ids = new Set(discovered.map((model) => model.id));
  let base = provider.models;
  if (provider.pruneMissing) {
    // Los que has puesto tú en la config no se quitan nunca
    base = base.filter((model) => ids.has(model.id) || handAdded.has(model.id));
  }
  const known = new Set(provider.models.map((model) => model.id));
  const extra = discovered.filter((model) => !known.has(model.id));
  return [...base, ...extra];
}

function cloneProvider(provider: ProviderConfig): ProviderConfig {
  return { ...provider, models: provider.models.map((model) => ({ ...model })) };
}

// Lista final de proveedores: tus proveedores propios primero, luego el catálogo con tus cambios
export function buildProviders(config: Config, local: Record<string, ModelConfig[]> = {}): ProviderConfig[] {
  const cache = readDiscovery();
  const catalog = CATALOG.map(cloneProvider);
  const custom: ProviderConfig[] = [];
  const handAdded = new Map<string, Set<string>>();

  for (const user of config.providers) {
    if (!user || typeof user.name !== "string") {
      continue;
    }
    handAdded.set(user.name, new Set((user.models || []).map((model) => model.id)));
    if (RETIRED_PROVIDERS[user.name] && String(user.baseURL || "").includes("models.github.ai")) {
      const notice = `Ignoro el proveedor "${user.name}" de tu config: ${RETIRED_PROVIDERS[user.name]}.`;
      if (!configNotices.includes(notice)) {
        configNotices.push(notice);
      }
      continue;
    }
    const index = catalog.findIndex((provider) => provider.name === user.name);
    if (index >= 0) {
      catalog[index] = mergeProvider(catalog[index], user);
    } else {
      custom.push({ ...user, custom: true, models: (user.models || []).map((model) => ({ ...model })) });
    }
  }

  let list = [...custom, ...catalog];
  list = list.map((provider) => {
    const result = cloneProvider(provider);
    const found = cache.providers[provider.name];
    if (found && found.models.length > 0 && !provider.replaceModels) {
      result.models = combine(result, found.models, handAdded.get(provider.name));
    }
    if (local[provider.name]) {
      result.models = combine(result, local[provider.name]);
    }
    result.models = result.models.filter((model) => !model.disabled);
    // Con "keyless": false, los anónimos solo se usan si les has puesto clave
    if (config.keyless === false && isAnonymous(result)) {
      result.noKey = false;
    }
    return result;
  });

  const disabled = new Set(config.disabledProviders || []);
  const enabledOnly = new Set(config.enabledProviders || []);
  return list.filter((provider) => {
    if (disabled.has(provider.name) || provider.enabled === false) {
      return false;
    }
    if (enabledOnly.size > 0 && !enabledOnly.has(provider.name)) {
      return false;
    }
    return true;
  });
}

async function fetchJson(url: string, credentials: Credentials | null, provider: ProviderConfig, timeoutMs: number, signal?: AbortSignal) {
  const headers: Record<string, string> = { accept: "application/json", ...(provider.headers || {}) };
  if (credentials && credentials.apiKey !== "no-key") {
    headers.authorization = `Bearer ${credentials.apiKey}`;
  }
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) {
    signals.push(signal);
  }
  const response = await fetch(url, { headers, signal: AbortSignal.any(signals) });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${body.slice(0, 160)}`);
  }
  return response.json();
}

function contextOf(item: any, provider: ProviderConfig, known?: ModelConfig): number {
  const candidates = [
    item.context_window,
    item.max_context_length,
    item.context_length,
    item.max_model_len,
    item.max_input_tokens,
    item.limits?.max_input_tokens,
    item.top_provider?.context_length,
    item.context_window?.tokens,
  ];
  let context = known?.context || candidates.find((value) => typeof value === "number" && value > 0) || provider.defaultContext || 32000;
  if (provider.contextCap) {
    context = Math.min(context, provider.contextCap);
  }
  return context;
}

function isFreeModel(item: any, provider: ProviderConfig): boolean {
  const id = String(item.id || "");
  if (provider.discover === "kilo") {
    return item.isFree === true;
  }
  if (provider.discover === "llm7") {
    // Los de pago van en el nivel "pro" y solo se usan pagando por consumo
    return item.tier !== "pro" && item.usage_based_only !== true;
  }
  if (provider.discover === "openrouter") {
    if (id.endsWith(":free")) {
      return true;
    }
    const prompt = item.pricing?.prompt;
    const completion = item.pricing?.completion;
    return prompt !== undefined && Number(prompt) === 0 && Number(completion) === 0;
  }
  return /(^|[:/-])free$/i.test(id);
}

function supportsTools(item: any, provider: ProviderConfig): boolean {
  if (provider.discover === "openrouter" || provider.discover === "kilo") {
    return Array.isArray(item.supported_parameters) && item.supported_parameters.includes("tools");
  }
  if (item.capabilities && typeof item.capabilities.function_calling === "boolean") {
    return item.capabilities.function_calling;
  }
  if (item.capabilities && typeof item.capabilities.tools === "boolean") {
    return item.capabilities.tools;
  }
  if (typeof item.tools_calling === "boolean") {
    return item.tools_calling;
  }
  return true;
}

function supportsVision(item: any, known?: ModelConfig): boolean {
  const modalities = item.architecture?.input_modalities || item.input_modalities || item.modalities?.input;
  if (Array.isArray(modalities)) {
    return modalities.includes("image");
  }
  if (item.capabilities && typeof item.capabilities.vision === "boolean") {
    return item.capabilities.vision;
  }
  return Boolean(known?.vision);
}

// Convierte la respuesta de /models en nuestra lista de modelos
export function parseModels(json: any, provider: ProviderConfig): ModelConfig[] {
  const items: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  const filter = provider.modelFilter ? new RegExp(provider.modelFilter, "i") : null;
  const result: ModelConfig[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    let id = String(item?.id || item?.name || "");
    if (id.startsWith("models/")) {
      id = id.slice("models/".length);
    }
    if (!id || seen.has(id) || NON_CHAT.test(id) || id === "openrouter/auto") {
      continue;
    }
    if (filter && !filter.test(id)) {
      continue;
    }
    if (item.active === false || item.object === "embedding") {
      continue;
    }
    // Modelos que no escriben texto (vectores, voz, imágenes): OVHcloud les pone max_completion_tokens 0 y LLM7 otro model_type
    if (item.max_completion_tokens === 0 || (typeof item.model_type === "string" && item.model_type !== "chat")) {
      continue;
    }
    if (item.deprecation && Date.parse(item.deprecation) < Date.now()) {
      continue;
    }
    if (provider.freeOnly && !isFreeModel(item, provider)) {
      continue;
    }
    if (!supportsTools(item, provider)) {
      continue;
    }
    const inputs = item.architecture?.input_modalities;
    if (Array.isArray(inputs) && !inputs.includes("text")) {
      continue;
    }
    const known = provider.models.find((model) => model.id === id);
    seen.add(id);
    result.push({ id, context: contextOf(item, provider, known), vision: supportsVision(item, known) });
  }
  return result;
}

// Pide /models a cada proveedor con clave y guarda los modelos nuevos
export async function refreshModels(providers: ProviderConfig[], options: { only?: string[]; signal?: AbortSignal } = {}): Promise<RefreshSummary> {
  const auth = readAuth();
  const cache = readDiscovery();
  const summary: RefreshSummary = { updated: [], failed: [] };

  const targets = providers.filter((provider) => {
    if (!provider.discover || provider.local) {
      return false;
    }
    if (options.only && options.only.length > 0 && !options.only.includes(provider.name)) {
      return false;
    }
    return resolveCredentials(provider, auth) !== null;
  });

  await Promise.allSettled(
    targets.map(async (provider) => {
      const credentials = resolveCredentials(provider, auth);
      const base = (credentials?.baseURL || provider.baseURL).replace(/\/+$/, "");
      try {
        const json = await fetchJson(`${base}/models`, credentials, provider, 20000, options.signal);
        const models = parseModels(json, provider);
        if (models.length === 0) {
          throw new Error("no devolvió ningún modelo útil");
        }
        const before = new Set((cache.providers[provider.name]?.models || provider.models).map((model) => model.id));
        cache.providers[provider.name] = { updated: Date.now(), models };
        summary.updated.push({ name: provider.name, count: models.length, added: models.map((model) => model.id).filter((id) => !before.has(id)) });
      } catch (err) {
        debugLog("descubrimiento", provider.name, err);
        summary.failed.push({ name: provider.name, error: (err as Error).message });
      }
    }),
  );

  cache.updated = Date.now();
  writeDiscovery(cache);
  return summary;
}

// Comprueba deprisa qué servidores locales (Ollama, LM Studio…) están encendidos y qué modelos tienen
export async function detectLocal(providers: ProviderConfig[], timeoutMs = 500): Promise<Record<string, ModelConfig[]>> {
  const found: Record<string, ModelConfig[]> = {};
  await Promise.allSettled(
    providers
      .filter((provider) => provider.local && provider.enabled !== false)
      .map(async (provider) => {
        try {
          const json = await fetchJson(`${provider.baseURL.replace(/\/+$/, "")}/models`, null, provider, timeoutMs);
          const models = parseModels(json, provider);
          if (models.length > 0) {
            found[provider.name] = models;
          }
        } catch {
          // no está encendido
        }
      }),
  );
  return found;
}
