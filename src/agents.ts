import path from "node:path";
import type { AgentInput, Config, PermissionConfig } from "./config.js";
import { readMarkdownDir } from "./frontmatter.js";
import { wildcardMatch } from "./match.js";
import { GLOBAL_AGENTS_DIR } from "./paths.js";

export interface AgentDefinition {
  name: string;
  description: string;
  // primary = se elige con Tab; subagent = solo lo lanza la herramienta task; all = ambos
  mode: "primary" | "subagent" | "all";
  // Instrucciones extra que se añaden al prompt del sistema
  prompt: string;
  // Modelo preferido ("proveedor/modelo" o patrón como "groq/*")
  model?: string;
  temperature?: number;
  // Herramientas activadas o desactivadas (admite * y los nombres de opencode)
  tools: Record<string, boolean>;
  permission?: PermissionConfig;
  maxSteps?: number;
  // Sin herramientas que modifiquen nada
  readOnly: boolean;
  color: string;
  builtIn: boolean;
  source?: string;
}

const PLAN_PROMPT = `You are in PLAN mode: you can only read and search (and browse the web). Do NOT try to modify anything.
Investigate the code and reply with a concrete, step-by-step plan: which files to change, what to change in each one and how to verify it.`;

const GENERAL_PROMPT = `You are a subagent launched by the main agent to do one task on your own.
Work autonomously until the task is done; you cannot ask the user questions.
Your final answer is the only thing the main agent will see: make it a complete, self-contained report (what you found or changed, with file paths and key details).`;

const EXPLORE_PROMPT = `You are a fast, read-only exploration subagent.
Use glob, grep, list_dir and read_file to answer the question about the codebase. Be efficient: search first, then read only what you need.
Your final answer is the only thing the main agent will see: give precise findings with file paths and line numbers.`;

const BUILTIN: AgentDefinition[] = [
  {
    name: "build",
    description: "Agente principal: lee, edita ficheros y ejecuta comandos",
    mode: "primary",
    prompt: "",
    tools: {},
    readOnly: false,
    color: "magenta",
    builtIn: true,
  },
  {
    name: "plan",
    description: "Solo lectura: investiga y propone un plan sin tocar nada",
    mode: "primary",
    prompt: PLAN_PROMPT,
    tools: {},
    permission: { edit: "deny", bash: "deny" },
    readOnly: true,
    color: "blue",
    builtIn: true,
  },
  {
    name: "general",
    description: "Subagente para investigar preguntas complejas o hacer tareas de varios pasos de forma autónoma (puede editar)",
    mode: "subagent",
    prompt: GENERAL_PROMPT,
    tools: { task: false, todowrite: false, todoread: false },
    readOnly: false,
    color: "cyan",
    builtIn: true,
  },
  {
    name: "explore",
    description: "Subagente rápido de solo lectura para encontrar ficheros, símbolos o entender cómo funciona algo del código",
    mode: "subagent",
    prompt: EXPLORE_PROMPT,
    tools: { task: false, todowrite: false, todoread: false, webfetch: false, websearch: false },
    readOnly: true,
    color: "green",
    builtIn: true,
  },
];

// Nombres de herramientas de opencode → los de vipcode
const ALIASES: Record<string, string> = {
  read: "read_file",
  write: "write_file",
  edit: "edit_file",
  patch: "edit_file",
  multiedit: "edit_file",
  list: "list_dir",
  ls: "list_dir",
};

const COLORS = ["magenta", "blue", "cyan", "green", "yellow", "red", "white", "gray"];

function normalizeTools(input: unknown): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (Array.isArray(input)) {
    // Lista = solo estas herramientas
    result["*"] = false;
    for (const name of input) {
      result[ALIASES[String(name)] || String(name)] = true;
    }
    return result;
  }
  if (input && typeof input === "object") {
    for (const [name, enabled] of Object.entries(input)) {
      result[ALIASES[name] || name] = Boolean(enabled);
    }
  }
  return result;
}

function fromInput(name: string, input: AgentInput, base: AgentDefinition | undefined, source?: string): AgentDefinition {
  let mode = input.mode || base?.mode || "all";
  if (!["primary", "subagent", "all"].includes(mode)) {
    mode = "all";
  }
  let color = input.color || base?.color || "yellow";
  if (!COLORS.includes(color)) {
    color = "yellow";
  }
  return {
    name,
    description: input.description || base?.description || `Agente ${name}`,
    mode,
    prompt: input.prompt ?? base?.prompt ?? "",
    model: input.model || base?.model,
    temperature: typeof input.temperature === "number" ? input.temperature : base?.temperature,
    tools: { ...(base?.tools || {}), ...normalizeTools(input.tools) },
    permission: input.permission || base?.permission,
    maxSteps: typeof input.maxSteps === "number" ? input.maxSteps : base?.maxSteps,
    readOnly: typeof input.readOnly === "boolean" ? input.readOnly : base?.readOnly ?? false,
    color,
    builtIn: base?.builtIn ?? false,
    source: source || base?.source,
  };
}

// Agentes integrados + ~/.vipcode/agents + .vipcode/agents y .opencode/agent(s) del proyecto + "agents" del config
export function loadAgents(root: string, config: Config): AgentDefinition[] {
  const agents = new Map<string, AgentDefinition>();
  for (const agent of BUILTIN) {
    agents.set(agent.name, { ...agent, tools: { ...agent.tools } });
  }

  const dirs = [
    GLOBAL_AGENTS_DIR,
    path.join(root, ".opencode", "agent"),
    path.join(root, ".opencode", "agents"),
    path.join(root, ".vipcode", "agents"),
  ];
  const disabled = new Set<string>();
  const apply = (name: string, input: AgentInput, source?: string) => {
    if (input.disable) {
      disabled.add(name);
      return;
    }
    agents.set(name, fromInput(name, input, agents.get(name), source));
  };

  for (const entry of readMarkdownDir(dirs)) {
    const data = entry.data as Record<string, any>;
    apply(
      entry.name,
      {
        description: data.description,
        mode: data.mode,
        prompt: entry.body,
        model: data.model,
        temperature: data.temperature,
        tools: data.tools,
        permission: data.permission,
        maxSteps: data.maxSteps ?? data.steps,
        color: data.color,
        readOnly: data.readOnly,
        disable: data.disable,
      },
      entry.file,
    );
  }
  for (const [name, input] of Object.entries(config.agents || {})) {
    apply(name, input);
  }
  for (const name of disabled) {
    agents.delete(name);
  }
  if (!agents.has("build")) {
    agents.set("build", { ...BUILTIN[0] });
  }
  return [...agents.values()];
}

export function primaryAgents(agents: AgentDefinition[]): AgentDefinition[] {
  return agents.filter((agent) => agent.mode === "primary" || agent.mode === "all");
}

export function subagents(agents: AgentDefinition[]): AgentDefinition[] {
  return agents.filter((agent) => agent.mode === "subagent" || agent.mode === "all");
}

// ¿Puede este agente usar la herramienta? Gana la última regla que encaje; por defecto sí
export function toolEnabled(agent: AgentDefinition, toolName: string): boolean {
  let enabled = true;
  for (const [pattern, value] of Object.entries(agent.tools)) {
    if (pattern === toolName || wildcardMatch(pattern, toolName)) {
      enabled = value;
    }
  }
  return enabled;
}
