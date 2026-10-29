import fs from "node:fs";
import { readAuth } from "./auth.js";
import { debugLog } from "./debug.js";
import { HOME_DIR, RANKING_PATH } from "./paths.js";

// Ranking de modelos con los datos de LLM Stats (https://llm-stats.com).
// vipcode no trae sus datos: sus condiciones no permiten redistribuirlos, así que cada usuario
// los descarga con su propia clave gratuita (vipcode auth login llm-stats) y se guardan en ranking.json.

// Un modelo según LLM Stats con sus índices
export interface StatsModel {
  id: string;
  name: string;
  general: number | null;
  code: number | null;
  agents: number | null;
  tools: number | null;
  released: string | null;
}

export interface RankingData {
  updated: string;
  source: string;
  models: StatsModel[];
}

// "coding" pondera programación, agentes y herramientas (lo que importa a un agente); "general" usa el índice general
export type RankingMetric = "coding" | "general";

const WEIGHTS: Record<RankingMetric, Partial<Record<"general" | "code" | "agents" | "tools", number>>> = {
  coding: { code: 0.4, agents: 0.3, tools: 0.15, general: 0.15 },
  general: { general: 1 },
};

// Nombres que cada proveedor escribe a su manera y no se parecen al de LLM Stats
const ALIASES: Record<string, string> = {
  "openai-fast": "gpt-oss-20b",
  "nemotron-3-120b-a12b": "nemotron-3-super-120b-a12b",
};

// API oficial de LLM Stats (VIPCODE_LLMSTATS_URL permite usar otra, por ejemplo en las pruebas)
function apiBase(): string {
  return process.env.VIPCODE_LLMSTATS_URL || "https://api.zeroeval.com/stats/v1";
}

// "nvidia/z-ai/glm-5.3:free" → "glm-5.3"
function baseId(id: string): string {
  let text = String(id).toLowerCase().replace(/^@cf\//, "");
  text = text.slice(text.lastIndexOf("/") + 1);
  return text.replace(/(:free|-free|:cloud|-cloud)$/, "");
}

// Clave para comparar: solo letras y números, sin palabras que no cambian el modelo
function keyOf(id: string): string {
  let text = baseId(id).replace(/[:._\s]+/g, "-");
  text = text.replace(/-(instruct|it|chat|fp8|hf|versatile)(?=-|$)/g, "");
  text = text.replace(/^(meta-|zai-|z-ai-)/, "");
  return text.replace(/[^a-z0-9]/g, "");
}

// Palabras del nombre sin versiones ni tamaños ("gemini-3.8-flash" → gemini, flash)
function wordsOf(id: string): string {
  return baseId(id)
    .replace(/[:._\s]+/g, "-")
    .split("-")
    .filter((word) => word && word !== "latest" && !/^\d+$/.test(word) && !/^v?\d+(\.\d+)?[bm]?$/.test(word))
    .sort()
    .join(" ");
}

// Lo descargado con la API (null si todavía no hay clave de LLM Stats o nunca se ha descargado)
export function loadRankingData(): RankingData | null {
  try {
    const data = JSON.parse(fs.readFileSync(RANKING_PATH, "utf8")) as RankingData;
    if (Array.isArray(data.models) && data.models.length > 0) {
      return data;
    }
  } catch {
    // sin descargas todavía
  }
  return null;
}

export class Ranking {
  private byKey = new Map<string, StatsModel>();
  private keys: string[] = [];
  private sorted: Record<string, number[]> = {};
  private cache = new Map<string, { score: number; model: StatsModel } | null>();

  constructor(
    readonly data: RankingData,
    private metric: RankingMetric = "coding",
  ) {
    for (const model of data.models) {
      for (const key of [keyOf(model.id), keyOf(model.name)]) {
        if (key && !this.byKey.has(key)) {
          this.byKey.set(key, model);
        }
      }
    }
    this.keys = [...this.byKey.keys()];
    for (const field of ["general", "code", "agents", "tools"] as const) {
      this.sorted[field] = data.models
        .map((model) => model[field])
        .filter((value): value is number => typeof value === "number")
        .sort((a, b) => a - b);
    }
  }

  // Busca el modelo de LLM Stats que corresponde a un id de proveedor
  find(id: string): StatsModel | null {
    const alias = ALIASES[baseId(id)];
    if (alias) {
      return this.byKey.get(keyOf(alias)) || null;
    }
    const base = baseId(id);
    const withoutDate = base.replace(/-(\d{4}|\d{6}|\d{8}|\d{2}-\d{4})$/, "");
    const tries = [keyOf(base), keyOf(withoutDate), keyOf(base.replace(/-v\d+$/, ""))];
    for (const key of tries) {
      if (this.byKey.has(key)) {
        return this.byKey.get(key)!;
      }
    }
    // "…-latest": el más reciente con las mismas palabras
    if (base.endsWith("-latest")) {
      const words = wordsOf(base);
      const candidates = this.data.models
        .filter((model) => wordsOf(model.id) === words)
        .sort((a, b) => String(b.released).localeCompare(String(a.released)));
      if (candidates[0]) {
        return candidates[0];
      }
    }
    // Un nombre más corto que el de LLM Stats ("beam" → "beam-1.0-501b-a23b"), o más largo ("llama-4-scout-17b" → "llama-4-scout")
    const short = keyOf(withoutDate);
    const longer = this.keys.filter((key) => key.startsWith(short)).sort((a, b) => a.length - b.length);
    const distinct = new Set(longer.map((key) => this.byKey.get(key)));
    if (longer.length > 0 && (distinct.size === 1 || short.length >= 8)) {
      return this.byKey.get(longer[0])!;
    }
    const shorter = this.keys.filter((key) => key.length >= 8 && short.startsWith(key)).sort((a, b) => b.length - a.length);
    if (shorter[0]) {
      return this.byKey.get(shorter[0])!;
    }
    return null;
  }

  private percentile(field: string, value: number): number {
    const list = this.sorted[field];
    if (!list || list.length < 2) {
      return 0.5;
    }
    let below = 0;
    while (below < list.length && list[below] < value) {
      below++;
    }
    return below / (list.length - 1);
  }

  // Nota de 0 a 100 (null si LLM Stats no tiene datos del modelo)
  score(id: string): { score: number; model: StatsModel } | null {
    if (this.cache.has(id)) {
      return this.cache.get(id)!;
    }
    const model = this.find(id);
    let result: { score: number; model: StatsModel } | null = null;
    if (model) {
      let sum = 0;
      let weight = 0;
      for (const [field, value] of Object.entries(WEIGHTS[this.metric])) {
        const raw = model[field as keyof StatsModel];
        if (typeof raw === "number" && value) {
          // Percentiles para que índices con escalas distintas se puedan sumar
          sum += this.percentile(field, raw) * value;
          weight += value;
        }
      }
      if (weight > 0) {
        result = { score: Math.round((sum / weight) * 100), model };
      }
    }
    this.cache.set(id, result);
    return result;
  }
}

// Clave de la API de LLM Stats (vipcode auth login llm-stats, o la variable LLMSTATS_API_KEY)
export function rankingKey(): string | null {
  return readAuth()["llm-stats"]?.key || process.env.LLMSTATS_API_KEY || null;
}

function pick(source: Record<string, unknown>, names: string[]): number | null {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

// Un modelo tal como lo devuelve la API (los nombres de los campos pueden variar: se buscan varios)
function parseApiModel(item: any): StatsModel | null {
  const id = String(item?.id || item?.model_id || "");
  if (!id) {
    return null;
  }
  const scores: Record<string, unknown> = {
    ...item,
    ...(item.top_scores || {}),
    ...(item.scores || {}),
    ...(item.indices || {}),
    ...(item.category_scores || {}),
  };
  return {
    id,
    name: String(item.name || id),
    general: pick(scores, ["index_general", "general", "overall", "llm_stats_score", "score"]),
    code: pick(scores, ["index_code", "code", "coding"]),
    agents: pick(scores, ["index_agents", "agents", "agent", "agentic"]),
    tools: pick(scores, ["index_tool_calling", "tool_calling", "tools", "tool_use"]),
    released: item.release_date ? String(item.release_date) : null,
  };
}

// Descarga las puntuaciones actuales con la API oficial (plan gratis: 250 respuestas al día)
export async function refreshRanking(apiKey: string, signal?: AbortSignal): Promise<{ count: number }> {
  const models: StatsModel[] = [];
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    let url = `${apiBase()}/models?limit=100`;
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }
    const signals = [AbortSignal.timeout(20000)];
    if (signal) {
      signals.push(signal);
    }
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.any(signals),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const json: any = await response.json();
    const items: any[] = Array.isArray(json?.models) ? json.models : Array.isArray(json?.data) ? json.data : [];
    for (const item of items) {
      const model = parseApiModel(item);
      if (model) {
        models.push(model);
      }
    }
    cursor = json?.next_cursor || json?.nextCursor || "";
    if (!cursor || items.length === 0) {
      break;
    }
  }
  const rated = models.filter((model) => [model.general, model.code, model.agents, model.tools].some((value) => value !== null));
  if (rated.length < 30) {
    throw new Error("la API no devolvió puntuaciones que vipcode sepa leer");
  }
  const data: RankingData = { updated: new Date().toISOString().slice(0, 10), source: "https://llm-stats.com (API)", models: rated };
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(RANKING_PATH, JSON.stringify(data));
  debugLog("ranking actualizado", rated.length);
  return { count: rated.length };
}
