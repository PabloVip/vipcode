import { spawn } from "node:child_process";
import path from "node:path";
import type { Config } from "./config.js";
import { readMarkdownDir } from "./frontmatter.js";
import { GLOBAL_COMMANDS_DIR } from "./paths.js";
import { commandShell, killTree, splitArgs } from "./shell.js";
import { truncate } from "./tools.js";
import { isProjectFile, projectTrust } from "./trust.js";

// Comando personalizado: un mensaje plantilla que se lanza con /nombre
export interface CommandDefinition {
  name: string;
  description: string;
  template: string;
  agent?: string;
  model?: string;
  // Se ejecuta como subagente para no llenar la conversación
  subtask: boolean;
  builtIn: boolean;
  source?: string;
  // false en los comandos de una carpeta en la que no confías: sus !`órdenes` no se ejecutan
  allowShell?: boolean;
}

const INIT_TEMPLATE = `Analiza este proyecto y crea (o mejora, si ya existe) el fichero AGENTS.md en la raíz, con las instrucciones que necesitaría otro agente de programación para trabajar aquí sin perder tiempo.

Incluye solo lo que sea útil y concreto:
- Para qué sirve el proyecto y su estructura de carpetas principal.
- Cómo instalar dependencias, compilar, ejecutar, pasar los tests y el linter (comandos exactos, incluido cómo ejecutar un solo test).
- Convenciones de código que se ven en el proyecto (estilo, nombres, idioma de los comentarios, cómo se organizan los ficheros).
- Cosas que no son obvias y que conviene saber (variables de entorno, servicios externos, trampas conocidas).

Antes de escribir, explora el proyecto (README, ficheros de configuración, package.json/pyproject/Makefile…, algunos ficheros de código).
Si ya hay reglas en CLAUDE.md, .cursorrules, .cursor/rules o .github/copilot-instructions.md, incorpóralas.
Escribe AGENTS.md en el idioma principal del proyecto (si dudas, en español), conciso: unas 20-60 líneas.
$ARGUMENTS`;

const REVIEW_TEMPLATE = `Revisa los cambios sin confirmar de este repositorio (usa \`git status\`, \`git diff\` y \`git diff --staged\`; si no hay cambios, revisa el último commit con \`git show\`).

Busca, por orden de importancia: errores que romperían algo, casos límite no tratados, problemas de seguridad, código que no sigue el estilo del proyecto y cosas que se podrían simplificar.
Para cada problema di el fichero y la línea, por qué es un problema y cómo lo arreglarías. No cambies nada: solo informa.
$ARGUMENTS`;

const BUILTIN: CommandDefinition[] = [
  { name: "init", description: "Crea o mejora AGENTS.md con las instrucciones del proyecto", template: INIT_TEMPLATE, subtask: false, builtIn: true },
  { name: "review", description: "Revisa los cambios sin confirmar (no modifica nada)", template: REVIEW_TEMPLATE, agent: "plan", subtask: false, builtIn: true },
];

// Comandos integrados + ~/.vipcode/commands + .vipcode/commands y .opencode/command(s) del proyecto + "commands" del config
export function loadCommands(root: string, config: Config, trusted = projectTrust(root).trusted): CommandDefinition[] {
  const commands = new Map<string, CommandDefinition>();
  for (const command of BUILTIN) {
    commands.set(command.name, { ...command });
  }
  const dirs = [
    GLOBAL_COMMANDS_DIR,
    path.join(root, ".opencode", "command"),
    path.join(root, ".opencode", "commands"),
    path.join(root, ".vipcode", "commands"),
  ];
  for (const entry of readMarkdownDir(dirs)) {
    const data = entry.data as Record<string, any>;
    commands.set(entry.name, {
      name: entry.name,
      description: String(data.description || `Comando ${entry.name}`),
      template: entry.body,
      agent: data.agent ? String(data.agent) : undefined,
      model: data.model ? String(data.model) : undefined,
      subtask: Boolean(data.subtask),
      builtIn: false,
      source: entry.file,
      allowShell: trusted || !isProjectFile(root, entry.file),
    });
  }
  for (const [name, input] of Object.entries(config.commands || {})) {
    if (!input || typeof input.template !== "string") {
      continue;
    }
    commands.set(name, {
      name,
      description: input.description || `Comando ${name}`,
      template: input.template,
      agent: input.agent,
      model: input.model,
      subtask: Boolean(input.subtask),
      builtIn: false,
    });
  }
  return [...commands.values()];
}

function runShell(command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const shell = commandShell();
    const child = spawn(shell.file, shell.args(command), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...shell.env, GIT_PAGER: "cat", PAGER: "cat" },
      windowsHide: true,
    });
    let output = "";
    const timer = setTimeout(() => killTree(child), 30000);
    child.stdout.on("data", (d) => (output += d.toString()));
    child.stderr.on("data", (d) => (output += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`(no se pudo ejecutar: ${err.message})`);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(truncate(output.trim(), 10000));
    });
  });
}

// Rellena la plantilla: $ARGUMENTS, $1…$9 y !`comando` (se sustituye por su salida)
export async function expandCommand(command: CommandDefinition, args: string, root: string): Promise<string> {
  const parts = splitArgs(args);
  let text = command.template;
  const usesArgs = /\$ARGUMENTS|\$\d/.test(text);
  // Con función para que un "$&" dentro de los argumentos no se interprete
  text = text.replace(/\$ARGUMENTS/g, () => args);
  text = text.replace(/\$(\d)/g, (_match, n: string) => parts[Number(n) - 1] ?? "");
  if (!usesArgs && args.trim() !== "") {
    text += `\n\n${args}`;
  }
  const shellPattern = /!`([^`]+)`/g;
  const commands = [...text.matchAll(shellPattern)];
  for (const match of commands) {
    const output = command.allowShell === false ? "(no ejecutado: esta carpeta no es de confianza; usa «vipcode trust»)" : await runShell(match[1], root);
    text = text.replace(match[0], () => output);
  }
  return text.trim();
}
