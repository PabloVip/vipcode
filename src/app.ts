import { spawn } from "node:child_process";
import fs from "node:fs";
import pc from "picocolors";
import { Agent, type UserInput } from "./agent.js";
import { type AgentDefinition, MAIN_AGENT, agentName, loadAgents, primaryAgents, subagents } from "./agents.js";
import { envNames, maskKey, readAuth, removeAuth, resolveCredentials, saveAuth, urlVars } from "./auth.js";
import { CATALOG } from "./catalog.js";
import { type CommandDefinition, expandCommand, loadCommands } from "./commands.js";
import { CONFIG_PATH, type Config, type ModelConfig, type ProviderConfig, configNotices, isAnonymous, loadConfig, setGlobalConfigValue } from "./config.js";
import { type RefreshSummary, buildProviders, detectLocal, refreshModels } from "./discovery.js";
import { isRemoteSession, loginOpenRouter, openBrowser } from "./login.js";
import { limitsReport, providerName, quotaFor } from "./limits.js";
import { LspManager } from "./lsp.js";
import { McpManager } from "./mcp.js";
import { VERSION } from "./meta.js";
import { AUTH_PATH, HOME_DIR, NOTICES_PATH, STATE_PATH, ensureHomeDir } from "./paths.js";
import { type PermissionReply, type PermissionRequest, SessionGrants, createAsker, permissionsFor, riskyGitConfig } from "./permissions.js";
import { Ranking, loadRankingData, rankingKey, refreshRanking } from "./ranking.js";
import { Router } from "./router.js";
import { type SkillDefinition, loadSkills, skillContent } from "./skills.js";
import { hasSecurity, localChangelog, sectionsBetween } from "./changelog.js";
import { cleanForClipboard, copyToClipboard, lastCodeBlock } from "./clipboard.js";
import { bugReportUrl, doctorReport, gitAdvice } from "./doctor.js";
import { type Session, deleteSession, listSessions, newSession, saveExport, saveSession, sessionMarkdownPath } from "./session.js";
import { Snapshots } from "./snapshot.js";
import { commandShell, findProgram, killTree } from "./shell.js";
import { type UpdateStep, compareVersions, updateVipcode } from "./update.js";
import { type TutorialCard, type TutorialEvent, isTutorialDir, tutorialCard, tutorialDone } from "./tutorial.js";
import { INTERFACES, interfaceFor } from "./interfaces.js";
import { formatTodos, truncate } from "./tools.js";
import { showLine } from "./sanitize.js";
import { type ProjectTrust, projectTrust } from "./trust.js";
import { joinList } from "./trustinfo.js";

export interface SelectItem<T> {
  label: string;
  description?: string;
  value: T;
}

// Lo que la interfaz (completa o de texto simple) ofrece a los comandos /
export interface UiAdapter {
  info(text: string): void;
  notice(text: string): void;
  error(text: string): void;
  // Texto preformateado (tablas, diffs, ayuda)
  block(text: string): void;
  select?<T>(title: string, items: SelectItem<T>[]): Promise<T | null>;
  prompt?(title: string, options?: { mask?: boolean; placeholder?: string }): Promise<string | null>;
  // Vuelve a poner un texto en la caja de escritura (tras /undo)
  setInput?(text: string): void;
  // Barra de carga de algo que tarda (/update); null la quita
  progress?(progress: Progress | null): void;
  // Se ha instalado una versión nueva de vipcode: hay que reiniciarlo para usarla
  updated?(version: string): void;
  // El paso del tutorial en el que vas
  tutorial?(card: TutorialCard): void;
  // /interfaz: la interfaz completa se pinta con la que has elegido
  setInterface?(id: string): void;
}

export interface Progress extends UpdateStep {
  // Lo que se está haciendo, encima de la barra («Actualizando vipcode»)
  title: string;
}

export interface RunOptions {
  agent?: string;
  model?: string;
  subtask?: boolean;
}

export interface CommandResult {
  exit?: boolean;
  // Cerrar y abrir la versión nueva en esta misma conversación (tras /update)
  restart?: boolean;
  run?: { input: UserInput; options: RunOptions };
  // Se ha cargado otra sesión: la interfaz enseña su conversación
  loaded?: boolean;
}

export const BUILTIN_COMMANDS: { name: string; args?: string; description: string }[] = [
  { name: "help", description: "esta ayuda" },
  { name: "models", args: "[refresh]", description: "estado de cada modelo; elige uno o busca modelos nuevos" },
  { name: "model", args: "<p/m|auto>", description: "fijar un modelo como preferido (auto = rotación)" },
  { name: "connect", args: "[proveedor]", description: "añadir la clave de un proveedor gratuito (en OpenRouter, iniciando sesión)" },
  { name: "disconnect", args: "<proveedor>", description: "borrar la clave guardada de un proveedor" },
  { name: "providers", description: "proveedores gratuitos, si tienes clave y dónde conseguirla" },
  { name: "agents", description: "agentes disponibles (Tab cambia entre los principales)" },
  { name: "agent", args: "<nombre>", description: "cambiar de agente" },
  { name: "planear", description: "agente de solo lectura: investiga y propone un plan (antes /plan)" },
  { name: "programar", description: "agente que puede modificar ficheros (antes /build)" },
  { name: "profe", description: "agente que te enseña paso a paso; no cambia nada, lo haces tú" },
  { name: "limites", description: "cuánto te queda hoy de cada plan gratis" },
  { name: "copiar", args: "[código]", description: "copia la última respuesta (o su último bloque de código) al portapapeles" },
  { name: "doctor", description: "comprueba que todo funciona (programas, claves, proveedores) y dice cómo arreglar lo que falte" },
  { name: "bug", args: "[qué ha pasado]", description: "avisa de un fallo: abre un issue en GitHub con el informe de /doctor ya puesto (sin tus claves)" },
  { name: "tutorial", description: "aprende lo básico en 5 pasos, en una carpeta de prácticas" },
  { name: "interfaz", description: "elige cómo se ve vipcode: pantalla completa, clásica, compacta, alto contraste, zen o criaturas" },
  { name: "undo", description: "deshacer el último mensaje (ficheros y conversación)" },
  { name: "redo", description: "rehacer lo deshecho" },
  { name: "diff", args: "[all]", description: "cambios del último mensaje (o de toda la sesión)" },
  { name: "todos", description: "lista de tareas del agente" },
  { name: "skills", description: "skills instaladas; elige una para usarla (vipcode skills add instala más)" },
  { name: "compact", description: "resumir la conversación para ahorrar contexto" },
  { name: "new", description: "empezar una sesión nueva" },
  { name: "sessions", description: "sesiones de esta carpeta" },
  { name: "load", args: "<n>", description: "cargar una sesión de la lista" },
  { name: "delete", args: "<n>", description: "borrar una sesión de la lista" },
  { name: "export", description: "guardar la conversación en Markdown" },
  { name: "usage", description: "tokens gastados en esta sesión" },
  { name: "mcp", description: "estado de los servidores MCP" },
  { name: "lsp", description: "servidores de lenguaje (diagnósticos)" },
  { name: "yolo", args: "[on|off]", description: "aprobar todo sin preguntar en esta sesión" },
  { name: "reset-limits", description: "olvidar las pausas guardadas de los proveedores" },
  { name: "config", description: "rutas de configuración" },
  { name: "update", description: "actualiza vipcode a lo último del repositorio o a la última versión publicada" },
  { name: "exit", description: "salir" },
];

function shortContext(tokens: number): string {
  if (tokens >= 1000000) {
    return `${Number((tokens / 1000000).toFixed(1))}M`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

// Colorea la salida de git diff
export function colorGitDiff(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) {
        return pc.bold(line);
      }
      if (line.startsWith("+")) {
        return pc.green(line);
      }
      if (line.startsWith("-")) {
        return pc.red(line);
      }
      if (line.startsWith("@@")) {
        return pc.cyan(line);
      }
      if (line.startsWith("diff --git")) {
        return pc.bold(pc.yellow(line));
      }
      return line;
    })
    .join("\n");
}

// Comprueba una clave pidiendo la lista de modelos
async function checkProvider(provider: ProviderConfig): Promise<{ ok: boolean; message: string }> {
  const credentials = resolveCredentials(provider);
  if (!credentials) {
    return { ok: false, message: "falta la clave o alguna variable" };
  }
  try {
    const headers: Record<string, string> = { ...(provider.headers || {}) };
    if (credentials.apiKey !== "no-key") {
      headers.authorization = `Bearer ${credentials.apiKey}`;
    }
    const response = await fetch(`${credentials.baseURL.replace(/\/+$/, "")}/models`, { headers, signal: AbortSignal.timeout(15000) });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `la clave no es válida (HTTP ${response.status})` };
    }
    if (!response.ok) {
      return { ok: true, message: `no he podido comprobarla (HTTP ${response.status}), pero la guardo` };
    }
    return { ok: true, message: "clave comprobada" };
  } catch (err) {
    return { ok: true, message: `no he podido comprobarla (${(err as Error).message}), pero la guardo` };
  }
}

export class App {
  config: Config;
  providers: ProviderConfig[];
  router: Router;
  // Puntuaciones de LLM Stats con las que se ordenan los modelos (null si está desactivado)
  ranking: Ranking | null;
  agents: AgentDefinition[];
  commands: CommandDefinition[];
  skills: SkillDefinition[];
  // Configuración que trae el proyecto y si la estamos usando (solo si confías en la carpeta)
  trust: ProjectTrust;
  trusted: boolean;
  lsp: LspManager | null;
  mcp: McpManager | null;
  snapshots: Snapshots;
  agent: Agent;
  grants = new SessionGrants();
  yolo = false;
  local: Record<string, ModelConfig[]> = {};
  lastSessions: Session[] = [];
  // Versión nueva de vipcode publicada: la interfaz la recuerda abajo hasta que la instalas con /update
  newVersion: string | null = null;
  // Alguna de las versiones nuevas trae arreglos de seguridad (el aviso lo destaca)
  newVersionSecurity = false;
  // /update ya la ha instalado: se usa al cerrar y volver a abrir vipcode
  updateInstalled = false;
  // La versión que se ha instalado con /update (al salir se recuerda abrir vipcode otra vez para usarla)
  installedVersion: string | null = null;
  // Con qué abrir vipcode otra vez al cerrar la interfaz: la versión nueva tras /update o el tutorial
  relaunch: string[] | null = null;
  // El paso del tutorial en el que vas (null si no lo estás haciendo)
  tutorialStep: number | null = null;
  // /interfaz entre la clásica y la pantalla completa: la interfaz a la que se pasa (la pantalla se rehace)
  switchInterface: string | null = null;
  // Proveedores a los que ya se les ha sugerido otra cuenta porque se les acaban las peticiones (una vez cada uno)
  private quotaTips = new Set<string>();
  // La interfaz pone aquí cómo preguntar los permisos
  promptPermission: (request: PermissionRequest, agent: AgentDefinition) => Promise<PermissionReply> = async () => ({
    allow: false,
    feedback: "no hay nadie para aprobarlo (usa --yolo)",
  });

  constructor(
    readonly root: string,
    options: { session?: Session; agentName?: string; trusted?: boolean } = {},
  ) {
    this.trust = projectTrust(root);
    this.trusted = options.trusted ?? this.trust.trusted;
    if (!this.trusted) {
      const notice = showLine(`No estoy usando la configuración que trae esta carpeta (${joinList(this.trust.files, Infinity)}). Si es tuya o te fías de ella, escribe «vipcode trust» en la terminal para usarla.`);
      if (!configNotices.includes(notice)) {
        configNotices.push(notice);
      }
    }
    this.config = loadConfig(root, { trusted: this.trusted });
    this.providers = buildProviders(this.config);
    this.ranking = this.buildRanking();
    this.router = new Router(this.config, this.providers, this.ranking);
    if (this.config.model) {
      this.router.pinned = this.config.model;
    }
    this.agents = loadAgents(root, this.config, this.trusted);
    this.commands = loadCommands(root, this.config, this.trusted);
    this.skills = loadSkills(root, this.config);
    this.lsp = new LspManager(root, this.config);
    if (!this.lsp.enabled()) {
      this.lsp = null;
    }
    this.mcp = null;
    if (Object.keys(this.config.mcp || {}).length > 0) {
      this.mcp = new McpManager(this.config.mcp, root);
    }
    this.snapshots = new Snapshots(root, this.config.snapshot !== false);
    this.agent = new Agent(
      {
        router: this.router,
        config: this.config,
        root,
        agents: this.agents,
        lsp: this.lsp,
        mcp: this.mcp,
        snapshots: this.snapshots,
        skills: this.skills,
        ask: (request, agent) => this.ask(request, agent),
      },
      options.session || newSession(root),
      options.agentName || options.session?.agent || MAIN_AGENT,
    );
  }

  ask(request: PermissionRequest, agent: AgentDefinition): Promise<PermissionReply> {
    const permission = permissionsFor(this.config.permission, agent.permission);
    // En un repositorio cuya configuración de git ejecuta programas, ningún git se aprueba solo
    if (request.kind === "bash" && /^\s*git\b/.test(request.subject) && riskyGitConfig(this.root)) {
      request = { ...request, force: true, title: `${request.title} (la configuración de git de esta carpeta ejecuta programas)` };
    }
    return createAsker(
      () => permission,
      this.grants,
      (req) => this.promptPermission(req, agent),
    )(request);
  }

  setYolo(value: boolean) {
    this.yolo = value;
    if (value) {
      for (const kind of ["write", "bash", "web", "mcp"] as const) {
        this.grants.allowKind(kind);
      }
    } else {
      this.grants = new SessionGrants();
    }
  }

  reloadProviders() {
    this.providers = buildProviders(this.config, this.local);
    this.router.reload(this.providers);
  }

  // Aviso de privacidad: una sola vez, si se van a usar proveedores que no piden clave
  needsPrivacyNotice(): boolean {
    if (!this.router.slots.some((slot) => slot.anonymous)) {
      return false;
    }
    try {
      return !JSON.parse(fs.readFileSync(NOTICES_PATH, "utf8")).privacy;
    } catch {
      return true;
    }
  }

  privacyNotice(): string {
    const names = [...new Set(this.router.slots.filter((slot) => slot.anonymous).map((slot) => (slot.provider.label || slot.provider.name).replace(/ \(sin clave\)$/, "")))];
    return [
      `Para que puedas empezar ya mismo, vipcode usa IAs gratuitas que no piden registro (${names.join(", ")}).`,
      "Como son gratis, pueden guardar lo que les escribes para mejorar sus modelos, así que mejor no compartas contraseñas, claves ni datos privados.",
      "Cuando quieras, conecta una cuenta gratuita con /connect y tendrás más mensajes y más modelos.",
    ].join("\n");
  }

  // Lo que traen las versiones nuevas desde la última que abriste, para enseñarlo una vez. Si ya usabas vipcode antes
  // de que se apuntara la versión, se enseña lo de esta; a quien lo abre por primera vez, nada
  takeNews(): { version: string; markdown: string; security: boolean } | null {
    let data: Record<string, unknown> = {};
    let existed = false;
    try {
      data = JSON.parse(fs.readFileSync(NOTICES_PATH, "utf8"));
      existed = true;
    } catch {
      // primera vez
    }
    let last = typeof data.lastVersion === "string" ? data.lastVersion : null;
    if (last !== VERSION) {
      data.lastVersion = VERSION;
      try {
        ensureHomeDir();
        fs.writeFileSync(NOTICES_PATH, JSON.stringify(data, null, 2));
      } catch {
        // no es grave
      }
    }
    if (!last && existed && data.privacy) {
      last = "0.0.0";
    }
    if (!last || compareVersions(VERSION, last) <= 0) {
      return null;
    }
    const sections = sectionsBetween(localChangelog(), last, VERSION).slice(0, last === "0.0.0" ? 1 : 5);
    if (sections.length === 0) {
      return null;
    }
    return {
      version: VERSION,
      markdown: sections.map((section) => `**${section.version}**\n\n${section.body}`).join("\n\n"),
      security: hasSecurity(sections),
    };
  }

  // En Windows sin Git para Windows: el consejo de instalarlo, como mucho una vez al día
  gitNotice(): string | null {
    const shell = commandShell();
    const advice = gitAdvice(process.platform, findProgram("git") !== null, shell.name, Boolean(process.env.VIPCODE_SHELL));
    if (!advice) {
      return null;
    }
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(fs.readFileSync(NOTICES_PATH, "utf8"));
    } catch {
      // primera vez
    }
    const today = new Date().toISOString().slice(0, 10);
    if (data.gitAdvice === today) {
      return null;
    }
    data.gitAdvice = today;
    try {
      ensureHomeDir();
      fs.writeFileSync(NOTICES_PATH, JSON.stringify(data, null, 2));
    } catch {
      // no es grave
    }
    return advice;
  }

  acceptPrivacyNotice() {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(fs.readFileSync(NOTICES_PATH, "utf8"));
    } catch {
      // primera vez
    }
    data.privacy = new Date().toISOString();
    ensureHomeDir();
    fs.writeFileSync(NOTICES_PATH, JSON.stringify(data, null, 2));
  }

  // «No usar nunca los que no piden clave»: se guarda en tu config global
  disableKeyless() {
    setGlobalConfigValue("keyless", false);
    this.config.keyless = false;
    this.reloadProviders();
  }

  // Vuelve a buscar las skills (por si has instalado alguna con la interfaz abierta)
  reloadSkills() {
    this.skills = loadSkills(this.root, this.config);
    this.agent.updateDeps({ skills: this.skills });
  }

  // Ollama, LM Studio o llama.cpp encendidos en este ordenador
  async detectLocalModels(): Promise<Record<string, ModelConfig[]>> {
    const found = await detectLocal(this.providers);
    this.local = found;
    if (Object.keys(found).length > 0) {
      this.reloadProviders();
    }
    return found;
  }

  private buildRanking(): Ranking | null {
    if (this.config.ranking?.enabled === false) {
      return null;
    }
    const data = loadRankingData();
    if (!data) {
      return null;
    }
    return new Ranking(data, this.config.ranking?.metric || "coding");
  }

  // Busca modelos nuevos y, si tienes clave de LLM Stats, actualiza también sus puntuaciones
  async refreshModels(only?: string[]): Promise<RefreshSummary> {
    const summary = await refreshModels(this.providers, { only });
    const key = rankingKey();
    if (key && this.config.ranking?.enabled !== false && (!only || only.includes("llm-stats"))) {
      try {
        const result = await refreshRanking(key);
        this.ranking = this.buildRanking();
        this.router.setRanking(this.ranking, this.providers);
        summary.updated.push({ name: "llm-stats", count: result.count, added: [] });
      } catch (err) {
        summary.failed.push({ name: "llm-stats", error: (err as Error).message });
      }
    }
    this.reloadProviders();
    return summary;
  }

  rankingInfo(): string {
    if (this.config.ranking?.enabled === false) {
      return "Orden del catálogo (ranking desactivado con \"ranking\": { \"enabled\": false }).";
    }
    if (!this.ranking) {
      return "Orden del catálogo. Para ordenarlos de mejor a peor con los datos de LLM Stats, consigue una clave gratis en https://llm-stats.com/developer y guárdala con «vipcode auth login llm-stats».";
    }
    let update = "con tu clave de LLM Stats se actualizan solos cada día";
    if (!rankingKey()) {
      update = "sin clave ya no se actualizan: vipcode auth login llm-stats";
    }
    return `Ordenados de mejor a peor. Datos de LLM Stats (llm-stats.com) del ${this.ranking.data.updated}; ${update}.`;
  }

  async startMcp(onChange?: () => void) {
    if (this.mcp) {
      await this.mcp.start(onChange);
    }
  }

  // Para abrir la versión nueva en esta misma conversación (si todavía no hay nada, una nueva)
  restartArgs(): string[] {
    return this.agent.session.messages.length > 0 ? ["--session", this.agent.session.id] : [];
  }

  startTutorial(): TutorialCard {
    this.tutorialStep = 0;
    return tutorialCard(0);
  }

  // Si lo que acaba de pasar completa el paso del tutorial, el siguiente (o el final)
  tutorialEvent(event: TutorialEvent): TutorialCard | null {
    if (this.tutorialStep === null || !tutorialDone(this.tutorialStep, event)) {
      return null;
    }
    const card = tutorialCard(++this.tutorialStep);
    if (card.step > card.total) {
      this.tutorialStep = null;
    }
    return card;
  }

  // Cuando quedan pocas peticiones gratis hoy en el modelo en uso: lo dice una vez y sugiere las cuentas gratis que más
  // dan de las que todavía no tienes
  lowQuotaTip(): string | null {
    const slot = this.router.slotFor(this.agent.lastSlot);
    const quota = slot ? quotaFor(this.router, slot) : null;
    if (!slot || !quota?.limit || quota.period !== "day" || quota.remaining > Math.max(3, Math.ceil(quota.limit * 0.1)) || this.quotaTips.has(slot.provider.name)) {
      return null;
    }
    this.quotaTips.add(slot.provider.name);
    const who = providerName(slot.provider);
    const left =
      quota.remaining <= 0
        ? `Se han acabado por hoy las peticiones gratis de ${who}: vipcode sigue solo con otro proveedor`
        : `Te ${quota.remaining === 1 ? "queda 1 petición gratis" : `quedan ${quota.remaining} peticiones gratis`} hoy en ${who}. Cuando se acaben, vipcode seguirá solo con otro proveedor`;
    const offers = ["cerebras", "groq"]
      .filter((name) => name !== slot.provider.name && !this.router.slots.some((other) => other.provider.name === name))
      .flatMap((name) => {
        const perDay = CATALOG.find((provider) => provider.name === name)?.freeLimits?.perDay;
        return perDay ? [`/connect ${name} (${perDay.toLocaleString("es-ES")} al día por modelo)`] : [];
      });
    return offers.length > 0 ? `${left}. Para tener muchas más, conecta una cuenta gratis: ${offers.join(" o ")}.` : `${left}.`;
  }

  // /bug: GitHub con el informe de /doctor ya puesto; la persona cuenta qué ha pasado y lo envía ella
  async reportBug(ui: UiAdapter, description: string) {
    ui.info("Preparando el informe…");
    const url = bugReportUrl(await doctorReport(this), description);
    // Por SSH, o en Linux sin escritorio, el navegador de esta máquina no es el tuyo: el enlace, al portapapeles (salvo si
    // has dicho con VIPCODE_BROWSER cómo abrirlo)
    const local = Boolean(process.env.VIPCODE_BROWSER) || (!isRemoteSession() && (process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)));
    if (local) {
      openBrowser(url);
      ui.info("He abierto GitHub en tu navegador con el informe ya puesto. Cuenta qué ha pasado y pulsa «Submit new issue»: no se envía nada hasta entonces. El informe no lleva tus claves, pero revísalo por si hay algo que no quieras compartir.");
    } else if ((await copyToClipboard(url)) === "portapapeles") {
      ui.info("He copiado al portapapeles el enlace para avisar del fallo en GitHub: pégalo en tu navegador, cuenta qué ha pasado y pulsa «Submit new issue».");
    } else {
      ui.info(`Abre este enlace en tu navegador para avisar del fallo (no se envía nada hasta que pulses «Submit new issue»):\n${url}`);
    }
  }

  async shutdown() {
    saveSession(this.agent.session);
    await Promise.allSettled([this.lsp?.shutdown(), this.mcp?.close()]);
  }

  primaryAgents(): AgentDefinition[] {
    return primaryAgents(this.agents);
  }

  // true si todos los modelos disponibles son de proveedores anónimos (no has puesto ninguna clave)
  onlyAnonymous(): boolean {
    if (this.router.slots.length === 0) {
      return false;
    }
    const auth = readAuth();
    return this.router.slots.every((slot) => isAnonymous(slot.provider) && resolveCredentials(slot.provider, auth)?.apiKey === "no-key");
  }

  anonymousNotice(): string {
    const names = [...new Set(this.router.slots.map((slot) => (slot.provider.label || slot.provider.name).replace(/ \(sin clave\)/, "")))];
    return `Estás usando IAs gratuitas sin registro (${names.join(", ")}). Consejo: conecta una cuenta gratuita con /connect para tener más mensajes y más modelos (y recuerda no compartir datos privados).`;
  }

  // Siguiente agente principal (Tab)
  cycleAgent(direction = 1): AgentDefinition {
    const list = this.primaryAgents();
    const index = list.findIndex((agent) => agent.name === this.agent.agent.name);
    const next = list[(index + direction + list.length) % list.length];
    this.agent.setAgent(next.name);
    return next;
  }

  newSession() {
    saveSession(this.agent.session);
    this.agent.setSession(newSession(this.root));
  }

  loadSession(session: Session) {
    saveSession(this.agent.session);
    this.agent.setSession(session);
    if (session.agent) {
      this.agent.setAgent(session.agent);
    }
  }

  // Ejecuta un mensaje con el agente (y opciones de un comando personalizado)
  async runPrompt(input: UserInput, options: RunOptions, signal?: AbortSignal) {
    const previousAgent = this.agent.agent.name;
    const previousPin = this.router.pinned;
    try {
      if (options.model) {
        this.router.pinned = options.model;
      }
      if (options.subtask) {
        const report = await this.agent.runSubagent(options.agent || "ayudante", input.text, "comando", this.agent.agent, signal);
        this.agent.events.onText?.(report, 0);
        this.agent.events.onTextEnd?.(0);
        return;
      }
      if (options.agent && this.agents.some((agent) => agent.name === agentName(options.agent!))) {
        this.agent.setAgent(options.agent);
      }
      await this.agent.run(input, signal);
    } finally {
      if (options.agent) {
        this.agent.setAgent(previousAgent);
      }
      if (options.model) {
        this.router.pinned = previousPin;
      }
    }
  }

  helpText(): string {
    const title = (text: string) => pc.bold(pc.magenta(text));
    const row = (name: string, description: string) => `  ${pc.cyan(name.padEnd(24))} ${description}`;
    const lines = [title("Comandos")];
    for (const command of BUILTIN_COMMANDS) {
      lines.push(row(`/${command.name}${command.args ? ` ${command.args}` : ""}`, command.description));
    }
    if (this.commands.length > 0) {
      lines.push("", `${title("Comandos con plantilla")}${pc.dim(" (los tuyos en ~/.vipcode/commands o .vipcode/commands)")}`);
      for (const command of this.commands) {
        lines.push(row(`/${command.name}`, command.description));
      }
    }
    const invocable = this.skills.filter((skill) => skill.userInvocable);
    if (invocable.length > 0) {
      lines.push("", `${title("Skills")}${pc.dim(" (el agente las carga solo cuando encajan; también puedes usarlas con /nombre)")}`);
      for (const skill of invocable) {
        lines.push(row(`/${skill.name}`, skill.description.length > 100 ? `${skill.description.slice(0, 99)}…` : skill.description));
      }
    }
    lines.push(
      "",
      title("Atajos"),
      row("Enter", "envía · Alt+Enter, Ctrl+J o \\ al final: línea nueva"),
      row("Tab · Shift+Tab", "cambia de agente (programar, planear y los tuyos)"),
      row("Ctrl+P", "paleta con todos los comandos y skills"),
      row("↑ ↓", "historial de lo que has escrito"),
      row("@ruta", "adjunta un fichero, una carpeta o una imagen · Ctrl+V pega una imagen"),
      row("!comando", "lo ejecuta en la terminal; la salida le llega al agente con tu siguiente mensaje"),
      row("Esc", "interrumpe al agente (mientras trabaja puedes seguir escribiendo)"),
      row("Ctrl+C", "interrumpe o borra lo escrito; dos veces seguidas sale"),
    );
    // Con la pantalla completa, el ratón lo maneja vipcode: la rueda mueve la conversación y arrastrar copia
    if (interfaceFor(this.config).fullscreen) {
      lines.push(
        row("Rueda · AvPág · RePág", "sube y baja por la conversación (al escribir vuelves abajo); también la barra de la derecha"),
        row("Ctrl+Inicio · Ctrl+Fin", "al principio o al final de la conversación"),
        row("Ctrl+F", "busca en la conversación (Enter o ↑ la anterior, ↓ la siguiente, Esc cierra)"),
        row("Copiar", "arrastra con el ratón y se copia al soltar; doble clic, una palabra; triple, la línea · /copiar"),
        row("Clic en una herramienta", "despliega su salida entera (otro clic la pliega)"),
      );
    } else {
      lines.push(row("Copiar", "selecciona con el ratón y Cmd+C (Mac), Ctrl+Shift+C (Linux) o Ctrl+C (Windows Terminal) · /copiar"));
    }
    return lines.join("\n");
  }

  modelsTable(): string {
    const rows = this.router.describe();
    if (rows.length === 0) {
      return "No hay modelos: añade una clave con /connect o «vipcode auth login».";
    }
    // En el orden real de la rotación, con la nota de LLM Stats delante
    const lines: string[] = [pc.dim(this.rankingInfo()), pc.dim(this.ranking ? "  nota  modelo" : "  modelo"), ""];
    for (const row of rows) {
      let color = pc.green;
      if (!row.available) {
        color = pc.yellow;
      }
      const vision = row.vision ? " imagen" : "";
      let score = "";
      if (this.ranking) {
        score = `${row.score !== null ? pc.cyan(String(row.score).padStart(4)) : pc.dim("   —")}  `;
      }
      lines.push(`  ${score}${row.key.padEnd(52)} ${color(row.status)} ${pc.dim(`${shortContext(row.context)}${vision}`)}`);
    }
    lines.push("", pc.dim(`${this.router.availableCount()} de ${rows.length} disponibles ahora · /models refresh busca modelos gratis nuevos`));
    return lines.join("\n");
  }

  providersTable(): string {
    const auth = readAuth();
    const lines: string[] = [];
    for (const provider of this.providers) {
      const credentials = resolveCredentials(provider, auth);
      let state = pc.dim("sin configurar");
      if (credentials && credentials.apiKey === "no-key") {
        state = pc.green("✓ sin clave (anónimo)");
      } else if (credentials) {
        state = pc.green(`✓ ${credentials.source} ${maskKey(credentials.apiKey)}`);
      }
      if (provider.local) {
        state = this.local[provider.name] ? pc.green(`✓ encendido (${this.local[provider.name].length} modelos)`) : pc.dim("apagado");
      }
      const env = envNames(provider);
      lines.push(`${pc.bold((provider.label || provider.name).padEnd(36))} ${state}`);
      lines.push(pc.dim(`  ${provider.name} · ${provider.models.length} modelos${env.length ? ` · ${env[0]}` : ""}${provider.signup ? ` · ${provider.signup}` : ""}`));
      if (provider.freeInfo) {
        lines.push(pc.dim(`  ${provider.freeInfo}`));
      }
    }
    lines.push("", pc.dim(this.rankingInfo()));
    return lines.join("\n");
  }

  // La clave de LLM Stats no es de un proveedor de modelos: solo sirve para actualizar el ranking
  private async connectRanking(ui: UiAdapter, key?: string) {
    ui.info("LLM Stats ordena los modelos de mejor a peor. Consigue la clave gratis (250 consultas al día) en https://llm-stats.com/developer");
    let apiKey = key;
    if (apiKey === undefined && ui.prompt) {
      const answer = await ui.prompt("Clave de LLM Stats", { mask: true });
      if (answer === null) {
        return;
      }
      apiKey = answer.trim();
    }
    if (!apiKey) {
      ui.error("No has escrito ninguna clave.");
      return;
    }
    saveAuth("llm-stats", { key: apiKey });
    try {
      const result = await refreshRanking(apiKey);
      this.ranking = this.buildRanking();
      this.router.setRanking(this.ranking, this.providers);
      ui.info(`Ranking actualizado: ${result.count} modelos con puntuación. A partir de ahora se actualiza solo cada día.`);
    } catch (err) {
      ui.error(`He guardado la clave, pero no he podido descargar el ranking (${(err as Error).message}). Sigo con los datos que trae vipcode.`);
    }
  }

  // Añade la clave de un proveedor (pidiéndola si la interfaz sabe preguntar)
  async connect(ui: UiAdapter, name: string, key?: string): Promise<void> {
    let providerName = name;
    if (!providerName) {
      if (!ui.select) {
        ui.block(this.providersTable());
        ui.info("Uso: /connect <proveedor> <clave>");
        return;
      }
      const auth = readAuth();
      const choice = await ui.select("¿Qué proveedor quieres conectar?", [
        ...this.providers
          .filter((provider) => !provider.local)
          .map((provider) => {
            let mark = "";
            if (resolveCredentials(provider, auth)) {
              mark = "✓ ";
            }
            return { label: `${mark}${provider.label || provider.name}`, description: provider.freeInfo, value: provider.name };
          }),
        {
          label: `${rankingKey() ? "✓ " : ""}LLM Stats (ranking de modelos)`,
          description: "clave gratis para que el orden de los modelos se actualice solo cada día",
          value: "llm-stats",
        },
      ]);
      if (!choice) {
        return;
      }
      providerName = choice;
    }
    if (providerName === "llm-stats" || providerName === "llmstats") {
      await this.connectRanking(ui, key);
      return;
    }
    const provider = this.providers.find((p) => p.name === providerName) || CATALOG.find((p) => p.name === providerName);
    if (!provider) {
      ui.error(`No conozco el proveedor «${providerName}». Mira /providers`);
      return;
    }
    if (provider.local) {
      ui.info(`${provider.label} no necesita clave: arráncalo y vipcode lo detecta solo al empezar (${provider.baseURL}).`);
      return;
    }

    const anonymous = isAnonymous(provider);
    let apiKey = key;
    let loggedIn = false;
    // Donde el proveedor lo permite oficialmente, iniciar sesión en el navegador crea la clave sola
    if (apiKey === undefined && provider.login === "openrouter" && ui.select) {
      const how = await ui.select(`¿Cómo quieres conectar ${provider.label}?`, [
        { label: "Iniciar sesión en el navegador (recomendado)", description: "la clave se crea y se guarda sola", value: "login" },
        { label: "Pegar una clave que ya tengo", description: provider.signup, value: "key" },
      ]);
      if (!how) {
        return;
      }
      if (how === "login") {
        try {
          const baseURL = resolveCredentials(provider)?.baseURL || provider.baseURL;
          const found = await loginOpenRouter(ui, baseURL, { headless: isRemoteSession() });
          if (!found) {
            ui.error("No se ha completado el inicio de sesión.");
            return;
          }
          apiKey = found;
          loggedIn = true;
        } catch (err) {
          ui.error(`No he podido iniciar sesión en ${provider.label}: ${(err as Error).message}`);
          return;
        }
      }
    }

    if (apiKey === undefined) {
      if (anonymous) {
        ui.info(`${provider.label} ya funciona sin clave. Con una clave gratis tienes más límites${provider.signup ? ` (${provider.signup})` : ""}.`);
      } else if (provider.signup) {
        ui.info(`Consigue la clave gratis en ${provider.signup}`);
      }
    }
    if (apiKey === undefined && ui.prompt) {
      // Con Enter sin escribir nada se abre la página de la clave: allí se inicia sesión y se copia
      const canOpen = !anonymous && Boolean(provider.signup);
      let title = `Clave de ${provider.label}`;
      if (anonymous) {
        title += " (opcional, Enter para seguir sin clave)";
      } else if (canOpen) {
        title += " (Enter sin escribir nada abre la página para conseguirla)";
      }
      let answer = await ui.prompt(title, { mask: true });
      if (answer === null) {
        return;
      }
      if (!answer.trim() && canOpen) {
        openBrowser(provider.signup!);
        ui.info(`He abierto ${provider.signup} en el navegador: inicia sesión, crea la clave y pégala aquí.`);
        answer = await ui.prompt(`Clave de ${provider.label}`, { mask: true });
        if (answer === null) {
          return;
        }
      }
      apiKey = answer.trim();
    }
    if (!apiKey && anonymous) {
      ui.info(`Sigues usando ${provider.label} sin clave.`);
      return;
    }
    if (!apiKey) {
      ui.error("No has escrito ninguna clave.");
      return;
    }

    const vars: Record<string, string> = {};
    for (const variable of urlVars(provider)) {
      if (process.env[variable] || readAuth()[provider.name]?.vars?.[variable]) {
        continue;
      }
      if (!ui.prompt) {
        ui.error(`Este proveedor necesita también ${variable}: expórtala o usa «vipcode auth login ${provider.name}».`);
        return;
      }
      const value = await ui.prompt(`Valor de ${variable}`);
      if (!value) {
        return;
      }
      vars[variable] = value.trim();
    }

    saveAuth(provider.name, { key: apiKey, vars });
    this.reloadProviders();
    const check = await checkProvider(this.providers.find((p) => p.name === provider.name) || provider);
    if (!check.ok) {
      ui.error(`${provider.label}: ${check.message}. La he guardado igualmente; cámbiala con /connect ${provider.name}.`);
    } else {
      ui.info(`${provider.label} conectado (${check.message}). Guardado en ${AUTH_PATH}.`);
    }
    if (loggedIn && provider.signup) {
      ui.info(`La clave se llama «vipcode» en ${provider.signup}: desde ahí puedes borrarla cuando quieras.`);
    }
    if (provider.discover) {
      const summary = await this.refreshModels([provider.name]);
      const updated = summary.updated.find((entry) => entry.name === provider.name);
      if (updated) {
        ui.info(`${updated.count} modelos gratis disponibles en ${provider.label}.`);
      }
    }
  }

  // Comandos que empiezan por /
  async handleCommand(text: string, ui: UiAdapter): Promise<CommandResult> {
    const [command, ...rest] = text.trim().split(/\s+/);
    const arg = rest.join(" ");
    const name = command.slice(1);

    switch (command) {
      case "/exit":
      case "/quit":
        return { exit: true };
      case "/help":
        ui.block(this.helpText());
        return {};
      case "/models": {
        if (arg === "refresh") {
          ui.info("Buscando modelos gratis nuevos…");
          await this.detectLocalModels();
          const summary = await this.refreshModels();
          for (const entry of summary.updated) {
            let added = "";
            if (entry.added.length > 0) {
              added = ` (nuevos: ${entry.added.slice(0, 5).join(", ")}${entry.added.length > 5 ? "…" : ""})`;
            }
            ui.info(`  ${entry.name}: ${entry.count} modelos${added}`);
          }
          for (const entry of summary.failed) {
            ui.notice(`  ${entry.name}: ${entry.error}`);
          }
          if (summary.updated.length === 0 && summary.failed.length === 0) {
            ui.info("No hay proveedores con clave que listen modelos.");
          }
          return {};
        }
        if (ui.select && this.router.slots.length > 0) {
          const rows = this.router.describe();
          const choice = await ui.select<string>("Elige el modelo preferido (Esc para salir)", [
            { label: "auto", description: "rotación automática: los mejores primero según LLM Stats", value: "auto" },
            ...rows.map((row) => ({
              label: row.key,
              description: `${row.score !== null ? `★${row.score} · ` : ""}${row.status} · ${shortContext(row.context)}${row.vision ? " · imagen" : ""}`,
              value: row.key,
            })),
          ]);
          if (choice) {
            return this.handleCommand(`/model ${choice}`, ui);
          }
          return {};
        }
        ui.block(this.modelsTable());
        return {};
      }
      case "/model": {
        if (arg === "" || arg === "auto") {
          this.router.pinned = null;
          ui.info("Rotación automática.");
        } else if (this.router.slots.some((slot) => slot.key === arg)) {
          this.router.pinned = arg;
          ui.info(`Preferido: ${arg}`);
        } else {
          ui.error(`No existe ${arg}. Mira /models`);
        }
        return {};
      }
      case "/connect": {
        const [providerName, key] = rest;
        await this.connect(ui, providerName || "", key);
        return {};
      }
      case "/disconnect": {
        if (!arg) {
          ui.error("Uso: /disconnect <proveedor>");
        } else if (removeAuth(arg)) {
          this.reloadProviders();
          ui.info(`Clave de ${arg} borrada.`);
        } else {
          ui.error(`No había ninguna clave guardada para ${arg} (las variables de entorno no se pueden borrar desde aquí).`);
        }
        return {};
      }
      case "/providers":
        ui.block(this.providersTable());
        return {};
      case "/agents": {
        const list = this.agents.map((agent) => ({
          label: `${agent.name}${agent.name === this.agent.agent.name ? " (actual)" : ""}`,
          description: `${agent.mode === "subagent" ? "subagente · " : ""}${agent.description}`,
          value: agent.name,
        }));
        if (ui.select) {
          const choice = await ui.select("Agentes (Enter cambia al elegido)", list);
          if (choice) {
            return this.handleCommand(`/agent ${choice}`, ui);
          }
          return {};
        }
        ui.block(list.map((item) => `  ${item.label.padEnd(20)} ${item.description}`).join("\n"));
        return {};
      }
      case "/agent": {
        const found = this.agents.find((agent) => agent.name === agentName(arg));
        if (!found) {
          ui.error(`No existe el agente «${arg}». Mira /agents`);
        } else if (found.mode === "subagent") {
          ui.error(`«${arg}» es un subagente: lo usa el agente principal con la herramienta task.`);
        } else {
          this.agent.setAgent(found.name);
          ui.info(`Agente ${found.name}: ${found.description}`);
        }
        return {};
      }
      case "/undo": {
        if (this.agent.running) {
          ui.error("Espera a que termine (o interrúmpelo con Esc) antes de deshacer.");
          return {};
        }
        try {
          const result = await this.agent.undo();
          if (!result) {
            ui.info("No hay nada que deshacer.");
            return {};
          }
          if (result.files.length > 0) {
            ui.info(`Ficheros restaurados: ${result.files.join(", ")}`);
          } else {
            ui.info("No había cambios en ficheros.");
          }
          if (result.restoredMessages) {
            ui.info("He quitado ese mensaje de la conversación (/redo lo recupera).");
            ui.setInput?.(result.text);
          }
        } catch (err) {
          ui.error((err as Error).message);
        }
        return {};
      }
      case "/redo": {
        try {
          const result = await this.agent.redo();
          if (!result) {
            ui.info("No hay nada que rehacer.");
          } else {
            ui.info(`Rehecho${result.files.length > 0 ? `: ${result.files.join(", ")}` : ""}.`);
          }
        } catch (err) {
          ui.error((err as Error).message);
        }
        return {};
      }
      case "/diff": {
        const diff = await this.agent.diff(arg === "all");
        if (!diff.trim()) {
          if (this.snapshots.disabledReason) {
            ui.info(`Sin instantáneas: ${this.snapshots.disabledReason}.`);
          } else {
            ui.info("No hay cambios.");
          }
        } else {
          ui.block(colorGitDiff(diff.trimEnd()));
        }
        return {};
      }
      case "/todos":
        ui.block(formatTodos(this.agent.session.todos));
        return {};
      case "/skills": {
        this.reloadSkills();
        if (this.skills.length === 0) {
          ui.info("No tienes skills. Instala alguna con «vipcode skills add <carpeta o repositorio git>» o crea una con «vipcode skills new <nombre>».");
          return {};
        }
        if (ui.select && ui.setInput) {
          const choice = await ui.select(
            "Skills (Enter la prepara para usarla; el agente también las carga solo cuando encajan)",
            this.skills.map((skill) => ({ label: skill.name, description: `${skill.description} · ${skill.where}`, value: skill.name })),
          );
          const skill = this.skills.find((item) => item.name === choice);
          if (skill && skill.userInvocable) {
            ui.setInput(`/${skill.name} `);
          } else if (skill) {
            ui.info(`«${skill.name}» solo la usa el agente cuando la tarea encaja.`);
          }
          return {};
        }
        ui.block(this.skills.map((skill) => `  ${`/${skill.name}`.padEnd(26)} ${skill.description}  ${pc.dim(skill.where)}`).join("\n"));
        return {};
      }
      case "/compact": {
        try {
          await this.agent.compact();
        } catch (err) {
          ui.error((err as Error).message);
        }
        return {};
      }
      case "/new":
      case "/clear":
        this.newSession();
        ui.info("Sesión nueva.");
        return {};
      case "/sessions": {
        this.lastSessions = listSessions(this.root).slice(0, 30);
        if (this.lastSessions.length === 0) {
          ui.info("No hay sesiones guardadas en esta carpeta.");
          return {};
        }
        if (ui.select) {
          const choice = await ui.select(
            "Sesiones de esta carpeta (Enter carga)",
            this.lastSessions.map((session) => ({
              label: session.title,
              description: `${new Date(session.updated).toLocaleString()} · ${session.messages.length} mensajes`,
              value: session,
            })),
          );
          if (choice) {
            this.loadSession(choice);
            return { loaded: true };
          }
          return {};
        }
        ui.block(
          this.lastSessions
            .map((session, i) => `  ${pc.bold(String(i + 1).padStart(2))}  ${session.title}  ${pc.dim(new Date(session.updated).toLocaleString())}`)
            .join("\n"),
        );
        return {};
      }
      case "/load": {
        const chosen = this.lastSessions[Number(arg) - 1];
        if (chosen) {
          this.loadSession(chosen);
          return { loaded: true };
        }
        ui.error("Número no válido. Usa /sessions primero.");
        return {};
      }
      case "/delete": {
        const chosen = this.lastSessions[Number(arg) - 1];
        if (chosen && deleteSession(chosen.id)) {
          ui.info(`Borrada: ${chosen.title}`);
          this.lastSessions.splice(Number(arg) - 1, 1);
        } else {
          ui.error("Número no válido. Usa /sessions primero.");
        }
        return {};
      }
      case "/export": {
        saveSession(this.agent.session);
        if (this.agent.session.messages.length === 0) {
          ui.info("La conversación está vacía.");
        } else {
          ui.info(`Conversación guardada en ${saveExport(this.agent.session)} (además se guarda sola en ${sessionMarkdownPath(this.agent.session)})`);
        }
        return {};
      }
      case "/copiar":
      case "/copy": {
        const answers = this.agent.session.log.filter((entry) => entry.role === "assistant").map((entry) => entry.text);
        if (answers.length === 0) {
          ui.error("Todavía no hay ninguna respuesta que copiar.");
          return {};
        }
        const code = /^(c[oó]digo|code)\b/i.test(arg.trim());
        const text = code ? lastCodeBlock(answers) : answers[answers.length - 1];
        if (text === null) {
          ui.error("Las últimas respuestas no tienen ningún bloque de código. Usa /copiar para copiar la respuesta entera.");
          return {};
        }
        const how = await copyToClipboard(text);
        const what = code ? "el último bloque de código" : "la última respuesta";
        const size = `${cleanForClipboard(text).length.toLocaleString("es-ES")} caracteres`;
        if (how === "portapapeles") {
          ui.info(`Copiado ${what} al portapapeles (${size}).`);
        } else if (how === "terminal") {
          ui.info(`Le he pedido a tu terminal que copie ${what} (${size}). Si no se ha copiado, tu terminal no lo permite: selecciónalo con el ratón.`);
        } else {
          ui.error("No he podido copiar: en Linux instala wl-clipboard (Wayland) o xclip, o pon en VIPCODE_CLIPBOARD el programa que copie lo que le llega.");
        }
        return {};
      }
      case "/doctor":
        ui.info("Comprobando…");
        ui.block(await doctorReport(this));
        return {};
      case "/bug":
        await this.reportBug(ui, arg);
        return {};
      case "/interfaz": {
        if (!ui.setInterface || !ui.select) {
          ui.info('La interfaz se elige en la interfaz completa (sin --plain), o con "interfaz" en tu configuración.');
          return {};
        }
        const now = interfaceFor(this.config).id;
        const choice = await ui.select(
          "¿Cómo quieres ver vipcode? (se guarda para la próxima vez)",
          INTERFACES.map((item) => ({ label: item.id === now ? `${item.label} (la de ahora)` : item.label, description: item.description, value: item.id })),
        );
        if (!choice || choice === now) {
          return {};
        }
        setGlobalConfigValue("interfaz", choice);
        this.config.interfaz = choice;
        ui.setInterface(choice);
        return {};
      }
      case "/tutorial": {
        // Ya en la carpeta de prácticas: se empieza (o se repite el paso en el que vas)
        if (ui.tutorial && (this.tutorialStep !== null || isTutorialDir(this.root))) {
          ui.tutorial(this.tutorialStep !== null ? tutorialCard(this.tutorialStep) : this.startTutorial());
          return {};
        }
        if (!ui.tutorial || !ui.select) {
          ui.info("El tutorial necesita la interfaz completa: ábrelo en tu terminal con «vipcode tutorial».");
          return {};
        }
        const choice = await ui.select("El tutorial se hace en una carpeta de prácticas (~/vipcode-tutorial), para no tocar tus ficheros. ¿Lo abro?", [
          { label: "Abrir el tutorial", description: "cuando acabes, vipcode -c te devuelve a esta conversación", value: "si" },
          { label: "Ahora no", value: "no" },
        ]);
        if (choice === "si") {
          this.relaunch = ["tutorial"];
          return { restart: true };
        }
        return {};
      }
      case "/limites":
      case "/limits":
        ui.block(limitsReport(this.router));
        return {};
      case "/usage": {
        const usage = this.agent.session.usage;
        ui.info(
          `Tokens en esta sesión: ${usage.prompt} de entrada y ${usage.completion} de salida (todo gratis). Última petición: ~${this.agent.lastTokens} tokens con ${this.agent.lastSlot || "—"}.`,
        );
        return {};
      }
      case "/mcp": {
        if (!this.mcp) {
          ui.info('No hay servidores MCP. Añádelos en "mcp" de tu config (mira el README).');
          return {};
        }
        ui.block(
          this.mcp
            .status()
            .map((server) => `  ${server.name.padEnd(20)} ${server.state}${server.state === "conectado" ? ` (${server.tools} herramientas)` : ""}${server.error ? ` ${pc.red(server.error)}` : ""}`)
            .join("\n"),
        );
        return {};
      }
      case "/lsp": {
        if (!this.lsp) {
          ui.info("Los diagnósticos LSP están desactivados en la configuración.");
          return {};
        }
        const status = await this.lsp.status();
        const available = await this.lsp.availableServers();
        const lines = [];
        if (status.length > 0) {
          lines.push("En marcha:", ...status.map((row) => `  ${row.id.padEnd(28)} ${row.state} (${row.files} ficheros)`));
        } else {
          lines.push("Ninguno en marcha todavía (arrancan solos al editar un fichero).");
        }
        lines.push("", "Disponibles en este ordenador:", ...available.map((line) => `  ${line}`));
        ui.block(lines.join("\n"));
        return {};
      }
      case "/yolo": {
        const value = arg === "" ? !this.yolo : arg === "on";
        this.setYolo(value);
        if (value) {
          ui.notice("Modo yolo: apruebo todo sin preguntar en esta sesión (las reglas «deny» se respetan).");
        } else {
          ui.info("Modo yolo desactivado: vuelvo a preguntar.");
        }
        return {};
      }
      case "/update": {
        let result;
        try {
          result = await updateVipcode((step) => (ui.progress ? ui.progress({ title: "Actualizando vipcode", ...step }) : ui.info(`${step.text}…`)));
        } finally {
          ui.progress?.(null);
        }
        if (result.status === "error") {
          ui.error(result.message);
        } else if (result.status === "manual") {
          ui.notice(result.message);
        } else {
          this.newVersion = null;
          if (result.status === "updated") {
            this.updateInstalled = true;
            this.installedVersion = result.version || null;
          }
          if (result.status === "updated" && result.version && ui.updated) {
            ui.updated(result.version);
          } else {
            ui.info(result.message);
          }
          // La interfaz completa sabe reiniciarse sola, en esta misma conversación
          if (result.status === "updated" && ui.updated && ui.select) {
            const choice = await ui.select(`vipcode ${result.version || ""} está instalado. ¿Lo reinicias ahora para usarlo?`, [
              { label: "Reiniciar ahora", description: "sigues en esta misma conversación", value: "ahora" },
              { label: "Más tarde", description: "cuando quieras: /exit y vuelve a abrirlo con vipcode -c", value: "luego" },
            ]);
            if (choice === "ahora") {
              this.relaunch = this.restartArgs();
              return { restart: true };
            }
          }
        }
        return {};
      }
      case "/reset-limits":
        this.router.resetCooldowns();
        ui.info("Pausas borradas.");
        return {};
      case "/config":
        ui.block(
          [
            `Config global:   ${CONFIG_PATH}`,
            "Config proyecto: vipcode.json o .vipcode/config.json",
            `Claves:          ${AUTH_PATH}`,
            `Estado:          ${STATE_PATH}`,
            `Carpeta:         ${HOME_DIR}`,
          ].join("\n"),
        );
        return {};
    }

    const custom = this.commands.find((item) => item.name === name);
    if (custom) {
      const expanded = await expandCommand(custom, arg, this.root);
      return { run: { input: { text: expanded, display: text.trim() }, options: { agent: custom.agent, model: custom.model, subtask: custom.subtask } } };
    }
    // /nombre-de-skill tarea: se le da la skill ya cargada junto con la tarea
    const skill = this.skills.find((item) => item.name === name && item.userInvocable);
    if (skill) {
      const task = arg ? `\n\nTarea: ${arg}` : "";
      return { run: { input: { text: `Usa la skill «${skill.name}» para esto.${task}\n\n${skillContent(skill)}`, display: text.trim() }, options: {} } };
    }
    // /programar, /planear y los tuyos (también /build y /plan, como antes)
    const agent = this.primaryAgents().find((item) => item.name === agentName(name));
    if (agent) {
      this.agent.setAgent(agent.name);
      ui.info(`Agente ${agent.name}: ${agent.description}`);
      if (arg) {
        return { run: { input: { text: arg }, options: {} } };
      }
      return {};
    }
    ui.error(`Comando desconocido: ${command}. Escribe /help`);
    return {};
  }

  // Sugerencias para el autocompletado de /comandos
  commandSuggestions(): { name: string; description: string; needsArgs: boolean }[] {
    const list = BUILTIN_COMMANDS.map((command) => ({
      name: command.name,
      description: command.description,
      needsArgs: Boolean(command.args && command.args.startsWith("<")),
    }));
    for (const command of this.commands) {
      list.push({ name: command.name, description: command.description, needsArgs: false });
    }
    for (const skill of this.skills) {
      if (skill.userInvocable && !list.some((item) => item.name === skill.name)) {
        list.push({ name: skill.name, description: `skill: ${skill.description}`, needsArgs: false });
      }
    }
    for (const agent of this.primaryAgents()) {
      if (!list.some((item) => item.name === agent.name)) {
        list.push({ name: agent.name, description: `agente: ${agent.description}`, needsArgs: false });
      }
    }
    return list;
  }

  // !comando: lo ejecuta en la carpeta del proyecto (lo escribes tú, así que no pide permiso)
  // y guarda la salida para que el agente la vea con tu siguiente mensaje
  runShell(command: string, onOutput?: (text: string) => void, signal?: AbortSignal): Promise<{ output: string; code: number | null }> {
    return new Promise((resolve) => {
      // Tu shell de siempre; en Windows, la misma que usa el agente (el bash de Git o PowerShell)
      let shell = { file: process.env.SHELL || findProgram("bash") || "/bin/sh", args: ["-lc", command], env: {} as Record<string, string> };
      if (process.platform === "win32" || process.env.VIPCODE_SHELL) {
        const found = commandShell();
        shell = { file: found.file, args: found.args(command), env: found.env };
      }
      const child = spawn(shell.file, shell.args, {
        cwd: this.root,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...shell.env, GIT_PAGER: "cat", PAGER: "cat" },
        windowsHide: true,
      });
      let output = "";
      const add = (data: Buffer) => {
        const text = data.toString();
        output += text;
        onOutput?.(text);
      };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      const stop = () => killTree(child);
      const timer = setTimeout(stop, this.config.bashTimeoutMs);
      signal?.addEventListener("abort", stop, { once: true });
      let done = false;
      const finish = (code: number | null) => {
        // "error" y "close" pueden llegar los dos
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        const clean = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trimEnd();
        this.agent.addNote(`(El usuario ha ejecutado en la terminal \`${command}\`, código de salida ${code ?? "desconocido"}:\n\`\`\`\n${truncate(clean, 8000)}\n\`\`\`)\n\n`);
        this.agent.logEntry({ role: "tool", text: truncate(clean, 4000), tool: { name: "bash", summary: `(tú) ${command}`, isError: code !== 0 } });
        saveSession(this.agent.session);
        resolve({ output: clean, code });
      };
      child.on("error", (err) => {
        output += `No se pudo ejecutar: ${err.message}`;
        finish(null);
      });
      child.on("close", (code) => finish(code));
    });
  }

  subagentNames(): string[] {
    return subagents(this.agents).map((agent) => agent.name);
  }
}
