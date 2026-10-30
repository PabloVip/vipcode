#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import pc from "picocolors";
import { agentName } from "./agents.js";
import { App, BUILTIN_COMMANDS, type RunOptions, type UiAdapter } from "./app.js";
import { removeAuth } from "./auth.js";
import { configNotices, loadConfig } from "./config.js";
import { isImagePath, toDataUrl } from "./images.js";
import { doctorReport } from "./doctor.js";
import { limitsReport } from "./limits.js";
import { REPO_URL, VERSION } from "./meta.js";
import { NoSlotError } from "./router.js";
import { appendHistory, exportMarkdown, listSessions, loadSession, saveExport } from "./session.js";
import { showLine } from "./sanitize.js";
import { createSkill, installSkills, loadSkills, removeSkill } from "./skills.js";
import { type ProjectTrust, projectTrust, trustProject, untrustProject } from "./trust.js";
import { describeTrust, joinList } from "./trustinfo.js";
import { updateVipcode } from "./update.js";
import { completeMention } from "./tools.js";
import { plainAdapter, plainEvents, plainPermissionPrompt, printLog, ui } from "./ui.js";


const USAGE = `vipcode ${VERSION} · agente de programación para la terminal con IAs gratuitas

Uso:
  vipcode [mensaje]                abre la interfaz en la carpeta actual
  vipcode run "tarea"              hace la tarea y termina (sin interfaz)
  vipcode auth login [proveedor]   guarda la clave de un proveedor gratuito (en OpenRouter, iniciando sesión)
  vipcode auth list                proveedores, claves configuradas y dónde conseguirlas
  vipcode auth logout <proveedor>  borra una clave guardada
  vipcode models [refresh]         modelos disponibles (refresh busca modelos gratis nuevos)
  vipcode limites                  cuánto te queda hoy de cada plan gratis
  vipcode doctor                   comprueba que todo funciona y dice cómo arreglar lo que falte
  vipcode skills                   skills instaladas (instrucciones que el agente carga cuando las necesita)
  vipcode skills add <origen>      instala skills de una carpeta o de un repositorio git (p. ej. anthropics/skills)
  vipcode skills new <nombre>      crea una skill vacía para rellenar
  vipcode skills remove <nombre>   borra una skill instalada con vipcode
  vipcode update                   actualiza vipcode (del repositorio o a la última versión publicada)
  vipcode trust                    confiar en la configuración que trae esta carpeta (vipcode untrust lo deshace)
  vipcode sessions                 sesiones guardadas de esta carpeta
  vipcode export [id]              guarda una sesión en Markdown (por defecto la última)

Opciones:
  -c, --continue        continuar la última sesión de esta carpeta
  -s, --session <id>    abrir una sesión concreta
  -m, --model <p/m>     modelo preferido, por ejemplo groq/openai/gpt-oss-120b
  --agent <nombre>      agente con el que empezar (build, plan o uno tuyo)
  --plan                empezar con el agente planear (solo lectura)
  --yolo                aprobar todo sin preguntar
  --project             con vipcode skills: en la carpeta .vipcode/skills del proyecto en vez de la tuya
  --force               con vipcode skills add: sustituir las que ya existan
  --image <fichero>     adjuntar una imagen al mensaje
  --plain               interfaz de texto simple (sin pantalla interactiva)
  -v, --version         versión

Código, dudas y errores: ${REPO_URL}
`;

interface Options {
  command: string;
  args: string[];
  continueLast: boolean;
  session: string;
  model: string;
  agent: string;
  yolo: boolean;
  plain: boolean;
  refresh: boolean;
  images: string[];
  project: boolean;
  force: boolean;
}

function helpText(): string {
  const lines = [USAGE, "Comandos dentro de la interfaz:"];
  for (const command of BUILTIN_COMMANDS) {
    const name = `/${command.name}${command.args ? ` ${command.args}` : ""}`;
    lines.push(`  ${name.padEnd(24)} ${command.description}`);
  }
  lines.push(
    "  /init                    crea o mejora AGENTS.md",
    "  /review                  revisa los cambios sin confirmar",
    "",
    "Atajos: Enter envía · Alt+Enter o \\ al final = nueva línea · Tab cambia de agente · Esc interrumpe",
    "        Ctrl+C dos veces sale · @ruta adjunta ficheros e imágenes · Ctrl+V pega una imagen",
  );
  return lines.join("\n");
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    command: "",
    args: [],
    continueLast: false,
    session: "",
    model: "",
    agent: "",
    yolo: false,
    plain: false,
    refresh: false,
    images: [],
    project: false,
    force: false,
  };
  const commands = ["run", "auth", "models", "limites", "limits", "doctor", "skills", "sessions", "export", "update", "trust", "untrust", "help"];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-c" || arg === "--continue") {
      options.continueLast = true;
    } else if (arg === "-s" || arg === "--session") {
      options.session = argv[i + 1] || "";
      i++;
    } else if (arg === "-m" || arg === "--model") {
      options.model = argv[i + 1] || "";
      i++;
    } else if (arg === "--agent") {
      options.agent = argv[i + 1] || "";
      i++;
    } else if (arg === "--plan") {
      options.agent = "planear";
    } else if (arg === "--yolo") {
      options.yolo = true;
    } else if (arg === "--plain") {
      options.plain = true;
    } else if (arg === "--refresh") {
      options.refresh = true;
    } else if (arg === "--project") {
      options.project = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--image") {
      options.images.push(argv[i + 1] || "");
      i++;
    } else if (arg === "-h" || arg === "--help") {
      console.log(helpText());
      process.exit(0);
    } else if (arg === "-v" || arg === "--version") {
      console.log(VERSION);
      process.exit(0);
    } else if (!options.command && options.args.length === 0 && commands.includes(arg)) {
      options.command = arg;
    } else if (!arg.startsWith("--")) {
      options.args.push(arg);
    }
  }
  return options;
}

function loadImages(files: string[], root: string): string[] {
  const images: string[] = [];
  for (const file of files) {
    const abs = path.resolve(root, file);
    if (!fs.existsSync(abs) || !isImagePath(abs)) {
      ui.error(`No encuentro la imagen ${file}`);
      process.exit(1);
    }
    images.push(toDataUrl(abs));
  }
  return images;
}

// Lee una clave sin que se vea en pantalla
async function askHidden(rl: readline.Interface, question: string): Promise<string> {
  const anyRl = rl as any;
  const original = anyRl._writeToOutput;
  anyRl._writeToOutput = function (text: string) {
    if (text.startsWith(question)) {
      original.call(anyRl, question + text.slice(question.length).replace(/[^\r\n]/g, "•"));
    } else if (text === "\r\n" || text === "\n") {
      original.call(anyRl, text);
    } else {
      original.call(anyRl, text.replace(/[^\r\n]/g, "•"));
    }
  };
  try {
    return await rl.question(question);
  } finally {
    anyRl._writeToOutput = original;
  }
}

// Interfaz de los comandos / para la línea de comandos (listas numeradas y preguntas normales)
function cliAdapter(rl: readline.Interface): UiAdapter {
  return {
    ...plainAdapter,
    select: async (title, items) => {
      console.log(pc.bold(title));
      items.forEach((item, index) => {
        console.log(`  ${pc.bold(String(index + 1).padStart(2))}. ${item.label}${item.description ? pc.dim(` — ${item.description}`) : ""}`);
      });
      const answer = (await rl.question("Número (Enter para cancelar): ")).trim();
      const index = Number(answer) - 1;
      if (!answer || Number.isNaN(index) || !items[index]) {
        return null;
      }
      return items[index].value;
    },
    prompt: async (title, options) => {
      if (options?.mask) {
        return askHidden(rl, `${title}: `);
      }
      return rl.question(`${title}: `);
    },
  };
}

async function runAuth(options: Options, root: string) {
  const [sub, name] = options.args;
  const app = new App(root);
  await app.detectLocalModels();
  if (!sub || sub === "list") {
    console.log(app.providersTable());
    console.log(pc.dim("\nAñade una clave con: vipcode auth login <proveedor>"));
    return;
  }
  if (sub === "logout") {
    if (!name) {
      ui.error("Uso: vipcode auth logout <proveedor>");
      process.exitCode = 1;
    } else if (removeAuth(name)) {
      ui.info(`Clave de ${name} borrada.`);
    } else {
      ui.error(`No había ninguna clave guardada para ${name}.`);
      process.exitCode = 1;
    }
    return;
  }
  if (sub === "login") {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    try {
      await app.connect(cliAdapter(rl), name || "");
    } finally {
      rl.close();
    }
    return;
  }
  ui.error(`Subcomando desconocido: ${sub}. Usa login, list o logout.`);
  process.exitCode = 1;
}

// vipcode skills [list|add|new|remove]
function runSkills(options: Options, root: string) {
  const [sub, target] = options.args;
  const config = loadConfig(root);
  if (!sub || sub === "list") {
    const skills = loadSkills(root, config);
    if (skills.length === 0) {
      ui.info("Todavía no tienes skills.");
    }
    for (const skill of skills) {
      const description = skill.description.length > 90 ? `${skill.description.slice(0, 89)}…` : skill.description;
      console.log(`  ${pc.bold(skill.name.padEnd(24))} ${description}`);
      console.log(pc.dim(`  ${"".padEnd(24)} ${skill.where}${skill.userInvocable ? ` · /${skill.name}` : " · solo la usa el agente"}`));
    }
    console.log(pc.dim("\nInstala más con «vipcode skills add <carpeta o repositorio git>» o crea una con «vipcode skills new <nombre>»."));
    return;
  }
  try {
    if (sub === "add") {
      if (!target) {
        ui.error("Uso: vipcode skills add <carpeta | https://github.com/usuario/repo[/tree/rama/carpeta] | usuario/repo> [--project] [--force]");
        process.exitCode = 1;
        return;
      }
      const result = installSkills(target, root, { project: options.project, force: options.force });
      for (const item of result.installed) {
        ui.info(`Instalada ${pc.bold(item.name)} en ${item.dir}`);
      }
      for (const item of result.skipped) {
        ui.notice(`${item.name}: ${item.reason}`);
      }
      if (result.installed.length > 0) {
        ui.info(pc.dim("Las skills pueden traer scripts: si no conoces su origen, revísalas. vipcode pide permiso antes de ejecutar cualquier comando."));
      } else {
        process.exitCode = 1;
      }
      return;
    }
    if (sub === "new") {
      if (!target) {
        ui.error("Uso: vipcode skills new <nombre> [--project]");
        process.exitCode = 1;
        return;
      }
      const dir = createSkill(target, root, options.project);
      ui.info(`Creada ${path.join(dir, "SKILL.md")}. Edítala: en «description» pon cuándo debe usarse y debajo, las instrucciones.`);
      return;
    }
    if (sub === "remove" || sub === "rm" || sub === "delete") {
      if (!target) {
        ui.error("Uso: vipcode skills remove <nombre>");
        process.exitCode = 1;
        return;
      }
      ui.info(`Borrada ${removeSkill(target, root, config)}`);
      return;
    }
  } catch (err) {
    ui.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  ui.error(`Subcomando desconocido: ${sub}. Usa list, add, new o remove.`);
  process.exitCode = 1;
}

// Qué cambiaría la configuración de la carpeta, en palabras sencillas: primero lo que puede hacerte daño. Devuelve true
// si hay algo de eso
function showTrust(trust: ProjectTrust): boolean {
  const { changes, settings } = describeTrust(trust);
  const title = showLine(`Esta carpeta trae su propia configuración de vipcode (${joinList(trust.files, Infinity)}).`);
  const rest = joinList(settings, 8);
  if (changes.length === 0) {
    console.log(title);
    console.log(settings.length > 0 ? `  Solo cambia ajustes sin riesgo: ${rest}.` : "  No cambia nada de lo que tienes.");
    return false;
  }
  console.log(pc.yellow(`⚠ ${title}`));
  console.log("  Si la usas, vipcode:");
  for (const change of changes) {
    console.log(`  · ${change}`);
  }
  if (settings.length > 0) {
    console.log(`  · y cambiará ajustes sin riesgo: ${rest}`);
  }
  return true;
}

// Antes de abrir la interfaz: ¿usamos la configuración del proyecto?
async function askTrust(trust: ProjectTrust): Promise<boolean> {
  if (showTrust(trust)) {
    console.log(pc.dim("  Si la carpeta es tuya o de alguien de confianza, puedes decir que sí. Si la has descargado y no sabes qué trae, mejor di que no: vipcode funcionará igual, con tu configuración de siempre."));
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("¿Usar la configuración de esta carpeta? (s/N) ")).trim().toLowerCase();
    return ["s", "si", "sí", "y", "yes"].includes(answer);
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

function noModelsHelp() {
  ui.error('No hay ningún modelo disponible (los proveedores sin clave se desactivan con "keyless": false o al limitar enabledProviders).');
  console.log(`Añade una clave gratuita con:   vipcode auth login
O exporta una variable, p. ej.:  export GEMINI_API_KEY="..."
Proveedores y enlaces:           vipcode auth list`);
}

// vipcode run "tarea": hace la tarea con texto normal y termina
async function runOnce(app: App, options: Options, root: string) {
  const text = options.args.join(" ").trim();
  if (text === "") {
    ui.error('Uso: vipcode run "tarea"');
    process.exitCode = 1;
    return;
  }
  const images = loadImages(options.images, root);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  app.promptPermission = plainPermissionPrompt(() => rl, () => app.grants);
  app.agent.events = plainEvents({ showReasoning: app.config.showReasoning });
  await app.startMcp();
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  try {
    // vipcode run "/review" o "/mi-skill tarea": comandos y skills igual que en la interfaz
    let input = { text, images };
    let runOptions: RunOptions = {};
    if (text.startsWith("/")) {
      const result = await app.handleCommand(text, plainAdapter);
      if (!result.run) {
        return;
      }
      input = { ...result.run.input, images };
      runOptions = result.run.options;
    }
    await app.runPrompt(input, runOptions, controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      ui.info("(cancelado)");
    } else if (err instanceof NoSlotError) {
      ui.error(err.message);
      process.exitCode = 1;
    } else {
      ui.error((err as Error).message || String(err));
      process.exitCode = 1;
    }
  } finally {
    rl.close();
  }
}

// Modo de texto simple: sin pantalla interactiva (o cuando la entrada no es una terminal)
async function plainLoop(app: App, options: Options, root: string) {
  const commandNames = app.commandSuggestions().map((command) => `/${command.name}`);
  const completer = (line: string): [string[], string] => {
    const mention = line.match(/(?:^|\s)(@[^\s@]*)$/);
    if (mention) {
      return [completeMention(root, mention[1].slice(1)), mention[1]];
    }
    if (line.startsWith("/") && !line.includes(" ")) {
      return [commandNames.filter((name) => name.startsWith(line)), line];
    }
    return [[], line];
  };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY), completer });
  app.promptPermission = plainPermissionPrompt(() => rl, () => app.grants);
  app.agent.events = plainEvents({ showReasoning: app.config.showReasoning });
  void app.startMcp();

  let current: AbortController | null = null;
  let lastCtrlC = 0;
  rl.on("SIGINT", () => {
    if (current) {
      current.abort();
      console.log(pc.dim("\n(cancelado)"));
      return;
    }
    if (Date.now() - lastCtrlC < 1500) {
      rl.close();
      process.exit(0);
    }
    lastCtrlC = Date.now();
    console.log(pc.dim("\n(pulsa Ctrl+C otra vez para salir)"));
    rl.prompt();
  });

  const runTask = async (text: string, runOptions: { agent?: string; model?: string; subtask?: boolean } = {}, images: string[] = []) => {
    current = new AbortController();
    try {
      await app.runPrompt({ text, images }, runOptions, current.signal);
    } catch (err) {
      if (current.signal.aborted) {
        // cancelado por el usuario
      } else if (err instanceof NoSlotError) {
        ui.error(err.message);
      } else {
        ui.error((err as Error).message || String(err));
      }
    } finally {
      current = null;
    }
  };

  const adapter: UiAdapter = { ...plainAdapter, setInput: (text) => ui.info(`Tu mensaje era: ${text}`) };
  ui.banner(app.agent.agent.name, app.router.slots.length);
  printLog(app.agent.session);
  if (options.args.length > 0) {
    await runTask(options.args.join(" "), {}, loadImages(options.images, root));
  }

  while (true) {
    let input = "";
    try {
      input = await rl.question(ui.prompt(app.agent.agent.name));
    } catch {
      break; // stdin cerrado
    }
    // Varias líneas: termina la línea con \ para seguir escribiendo
    while (input.endsWith("\\")) {
      input = input.slice(0, -1) + "\n" + (await rl.question(pc.dim("… ")));
    }
    const text = input.trim();
    if (text === "") {
      continue;
    }
    appendHistory(text);
    if (text.startsWith("!")) {
      const command = text.slice(1).trim();
      if (command) {
        const result = await app.runShell(command, (chunk) => process.stdout.write(chunk));
        console.log(pc.dim(`(código ${result.code ?? "?"}; el agente verá la salida con tu siguiente mensaje)`));
      }
      continue;
    }
    if (text.startsWith("/")) {
      const result = await app.handleCommand(text, adapter);
      if (result.exit) {
        break;
      }
      if (result.loaded) {
        printLog(app.agent.session);
      }
      if (result.run) {
        await runTask(result.run.input.text, result.run.options);
      }
      continue;
    }
    await runTask(text);
  }
  rl.close();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = process.cwd();

  if (options.command === "help") {
    console.log(helpText());
    return;
  }
  if (options.command === "auth") {
    await runAuth(options, root);
    return;
  }
  if (options.command === "skills") {
    runSkills(options, root);
    return;
  }
  if (options.command === "trust") {
    const trust = projectTrust(root);
    if (!trust.fingerprint) {
      ui.info("Esta carpeta no trae configuración de vipcode: no hace falta confiar en ella.");
      return;
    }
    showTrust(trust);
    trustProject(root, trust);
    ui.info("Hecho: vipcode usará esa configuración en esta carpeta. Si cambia, te volverá a preguntar.");
    return;
  }
  if (options.command === "untrust") {
    ui.info(untrustProject(root) ? "Hecho: ya no uso la configuración de esta carpeta." : "No confiabas en esta carpeta.");
    return;
  }
  if (options.command === "update") {
    const result = await updateVipcode((text) => ui.info(text));
    if (result.status === "error") {
      ui.error(result.message);
      process.exitCode = 1;
    } else if (result.status === "manual") {
      ui.notice(result.message);
    } else {
      ui.info(result.message);
    }
    return;
  }
  if (options.command === "sessions") {
    const sessions = listSessions(root);
    if (sessions.length === 0) {
      ui.info("No hay sesiones guardadas en esta carpeta.");
    }
    for (const session of sessions.slice(0, 50)) {
      console.log(`  ${pc.bold(session.id)}  ${session.title}  ${pc.dim(new Date(session.updated).toLocaleString())}`);
    }
    return;
  }
  if (options.command === "export") {
    const session = options.args[0] ? loadSession(options.args[0]) : listSessions(root)[0];
    if (!session) {
      ui.error("No encuentro esa sesión. Mira «vipcode sessions».");
      process.exitCode = 1;
      return;
    }
    if (process.stdout.isTTY) {
      ui.info(`Guardada en ${saveExport(session)}`);
    } else {
      process.stdout.write(exportMarkdown(session));
    }
    return;
  }

  let session;
  if (options.session) {
    session = loadSession(options.session);
    if (!session) {
      ui.error(`No existe la sesión ${options.session}. Mira «vipcode sessions».`);
      process.exitCode = 1;
      return;
    }
  } else if (options.continueLast) {
    session = listSessions(root)[0];
  }

  // En la interfaz se pregunta si usar la configuración del proyecto; con «run» se avisa y no se usa. Se aprueba lo que
  // has visto: si la carpeta cambia mientras contestas, no se usa
  const trust = projectTrust(root);
  if (!trust.trusted && options.command === "" && process.stdin.isTTY && (await askTrust(trust))) {
    trustProject(root, trust);
  }
  const app = new App(root, { session, agentName: options.agent || undefined });
  if (options.agent && !app.agents.some((agent) => agent.name === agentName(options.agent))) {
    ui.error(`No existe el agente «${options.agent}».`);
    process.exitCode = 1;
    return;
  }
  if (options.model) {
    app.router.pinned = options.model;
  }
  app.setYolo(options.yolo);
  await app.detectLocalModels();

  const interactive = options.command === "" && Boolean(process.stdin.isTTY && process.stdout.isTTY) && !options.plain;
  if (!interactive) {
    for (const notice of configNotices) {
      ui.notice(notice);
    }
    if (session && options.continueLast) {
      ui.info(`Continuando: ${session.title}`);
    }
  }

  if (options.command === "models") {
    // «vipcode models refresh» igual que «/models refresh» dentro de la interfaz
    if (options.refresh || options.args[0] === "refresh") {
      ui.info("Buscando modelos gratis nuevos…");
      const summary = await app.refreshModels();
      for (const entry of summary.updated) {
        ui.info(`  ${entry.name}: ${entry.count} modelos${entry.added.length ? ` (${entry.added.length} nuevos)` : ""}`);
      }
      for (const entry of summary.failed) {
        ui.notice(`  ${entry.name}: ${entry.error}`);
      }
    }
    console.log(app.modelsTable());
    return;
  }

  if (options.command === "doctor") {
    console.log(await doctorReport(app));
    return;
  }

  if (options.command === "limites" || options.command === "limits") {
    console.log(limitsReport(app.router));
    return;
  }

  if (!interactive && app.router.slots.length === 0) {
    noModelsHelp();
    process.exitCode = 1;
    return;
  }
  if (!interactive && app.needsPrivacyNotice()) {
    ui.notice(app.privacyNotice());
    app.acceptPrivacyNotice();
  } else if (!interactive && app.onlyAnonymous()) {
    ui.info(app.anonymousNotice());
  }

  try {
    if (options.command === "run") {
      await runOnce(app, options, root);
    } else if (interactive) {
      const { startTui } = await import("./tui/app.js");
      await startTui(app, { initial: options.args.join(" ") });
    } else {
      await plainLoop(app, options, root);
    }
  } finally {
    await app.shutdown();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(pc.red(String(err?.stack || err)));
    process.exit(1);
  });
