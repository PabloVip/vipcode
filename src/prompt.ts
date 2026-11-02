import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fg from "fast-glob";
import type { AgentDefinition } from "./agents.js";
import { BUILTIN_COMMANDS } from "./builtin-commands.js";
import { REPO_URL, VERSION } from "./meta.js";
import { GLOBAL_INSTRUCTIONS_PATH, realInside } from "./paths.js";
import { commandShell } from "./shell.js";

function readLimited(file: string, max = 15000): string {
  try {
    return fs.readFileSync(file, "utf8").slice(0, max);
  } catch {
    return "";
  }
}

// Instrucciones del proyecto, igual que hace opencode con AGENTS.md
function projectInstructions(root: string, extra: string[]): string {
  const parts: string[] = [];
  const global = readLimited(GLOBAL_INSTRUCTIONS_PATH);
  if (global.trim() !== "") {
    parts.push(`# Instrucciones generales del usuario (~/.vipcode/AGENTS.md)\n${global}`);
  }
  const names = ["AGENTS.md", "CLAUDE.md", ".vipcode.md"];
  for (const name of names) {
    const file = path.join(root, name);
    if (fs.existsSync(file) && realInside(file, root)) {
      parts.push(`# Instrucciones del proyecto (${name})\n${readLimited(file)}`);
      break;
    }
  }
  // Ficheros extra del config ("instructions": ["docs/estilo.md", ".cursor/rules/*.md"])
  const seen = new Set<string>();
  for (const pattern of extra) {
    let files: string[] = [];
    try {
      files = fg.sync(pattern, { cwd: root, onlyFiles: true, dot: true, absolute: true }).slice(0, 10);
    } catch {
      files = [];
    }
    for (const file of files) {
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      parts.push(`# Instrucciones (${path.relative(root, file).split(path.sep).join("/")})\n${readLimited(file, 8000)}`);
    }
  }
  if (parts.length === 0) {
    return "";
  }
  return `\n\n${parts.join("\n\n")}`;
}

// Para que el modelo escriba los comandos en el idioma de la shell que hay de verdad. Con Windows PowerShell 5.1 los
// modelos escriben bash (&&, grep, tail, mkdir -p {a,b}…) aunque se les diga PowerShell: se les dice qué no existe
function shellLine(): string {
  const shell = commandShell();
  if (shell.name === "PowerShell") {
    if (shell.flavor === "windows") {
      return "Windows PowerShell 5.1 (NOT bash, NOT PowerShell 7). Write PowerShell 5.1 commands: there is no && or || (use ; or `cmd1; if ($?) { cmd2 }`), no grep/tail/head/cat -n/chmod/which/touch (use Select-String, Select-Object -Last/-First, Get-Content, Get-Command, New-Item), no brace expansion (mkdir -p a/{b,c} does not work: New-Item -ItemType Directory -Force -Path a\\b, a\\c), and Get-ChildItem uses -Depth (there is no -MaxDepth)";
    }
    return "PowerShell 7 (pwsh; write PowerShell commands, not bash; && and || work)";
  }
  if (shell.name === "cmd") {
    return "cmd.exe (write Windows cmd commands, not bash)";
  }
  if (shell.name === "Git Bash") {
    return "Git Bash on Windows (bash syntax; Windows tools like npm, node and git work as usual)";
  }
  return shell.name;
}

// Un script de varias líneas metido entre comillas en la línea de comandos (python3 -c '…') se rompe en cuanto el script
// lleva comillas: cómo pasarlo sin ellas en cada shell
function scriptRule(): string {
  const shell = commandShell();
  if (shell.name === "PowerShell") {
    return "For a multi-line script (Python, Node…), don't put it in quotes on the command line: pipe a here-string, e.g. @'\n…\n'@ | python -";
  }
  if (shell.name === "cmd") {
    return "For a multi-line script (Python, Node…), don't put it in quotes on the command line: write it to a file with write_file and run that file.";
  }
  return "For a multi-line script (Python, Node…), don't put it in quotes on the command line (python3 -c '…' breaks as soon as the script has a quote): pass it with a quoted heredoc, e.g. python3 - <<'EOF' … EOF.";
}

// Lo que hay en la raíz del proyecto, para que el modelo se oriente sin gastar una llamada
function topLevel(root: string): string {
  try {
    const entries = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.name !== ".git" && entry.name !== "node_modules" && entry.name !== ".DS_Store")
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((entry) => {
        if (entry.isDirectory()) {
          return `${entry.name}/`;
        }
        return entry.name;
      });
    if (entries.length === 0) {
      return "(empty)";
    }
    let extra = "";
    if (entries.length > 40) {
      extra = ` … (+${entries.length - 40} more)`;
    }
    return entries.slice(0, 40).join(", ") + extra;
  } catch {
    return "(unknown)";
  }
}

// Lo que el modelo tiene que saber de vipcode para no ir a buscarlo por el disco ni inventárselo: qué es, qué comandos
// tiene la interfaz (los escribe la persona, no el modelo) y qué agentes hay
function aboutVipcode(agentNames: string[]): string {
  const commands = BUILTIN_COMMANDS.map((command) => `/${command.name}${command.args ? ` ${command.args}` : ""}`).join(", ");
  return `About yourself: you are vipcode ${VERSION} (${REPO_URL}), a terminal coding agent that routes each request to free cloud AI models and jumps to another provider when one runs out; the model answering may change between steps. The user types these slash commands in the vipcode interface (you cannot run them): ${commands}. \`vipcode -c\` continues the last session of the folder. Agents: ${agentNames.join(", ")}. If the user asks about vipcode itself, answer from this; never search the disk or the user's folders to learn about vipcode.`;
}

export interface PromptOptions {
  agent: AgentDefinition;
  toolNames: string[];
  instructions: string[];
  // true si es un subagente lanzado con task
  subagent?: boolean;
  // Nombres de todos los agentes (para que el modelo sepa cuáles hay)
  agentNames?: string[];
}

export function systemPrompt(root: string, options: PromptOptions): string {
  const { agent, toolNames } = options;
  const has = (name: string) => toolNames.includes(name);

  let modeText =
    "You are in BUILD mode: you may read, create and edit files and run shell commands (the user approves risky actions).";
  if (agent.readOnly && !options.subagent) {
    modeText = "";
  }

  const rules = [
    "Explore before acting: use list_dir, glob, grep and read_file to understand the code. Never guess file contents.",
  ];
  if (!agent.readOnly) {
    rules.push(
      "To change an existing file, read it first and then use edit_file with an exact, unique old_string copied from read_file output (without the line-number prefix). Use write_file only for new files or full rewrites.",
      "Make the smallest change that solves the task and follows the existing style of the project.",
      "After changing code, run the relevant build, linter or tests with bash when the project has them. If the language server reports errors after your edit, fix them.",
      "Never say that code compiles, works or is finished unless you ran the build or tests in this session and they passed. If you could not run them (missing compiler, no Docker…), say clearly what is unverified. Never invent checksums, lockfiles (go.sum, package-lock.json…), hashes, versions or command output: generate them with the real tool or leave them out.",
      "Do not clone repositories, download files, install programs or packages, or create folders outside the project unless the user asked for it; ask first.",
    );
  }
  if (has("bash")) {
    rules.push(
      scriptRule(),
      "Every bash call starts again in the working directory: a cd in one call does not carry over to the next. Use the workdir argument (a folder relative to the project) instead of cd.",
    );
  }
  rules.push(
    "Call several tools in one turn when they are independent.",
    "If a tool returns an error, read it and fix your approach instead of repeating the same call. If the same thing fails twice, change strategy (for example, read the file again and rewrite it whole with write_file) or tell the user what blocks you.",
    "Never end your reply announcing what you are about to do (\"Voy a…\", \"Ahora…\"): either do it now with tools, or stop and say clearly what is done and what is left.",
  );
  if (has("todowrite")) {
    rules.push(
      "For tasks with 3 or more steps, keep a todo list with todowrite: mark one step in_progress when you start it and completed as soon as it is done (for code, only after checking it builds or its tests pass, when that is possible). Skip it for simple tasks.",
    );
  }
  if (has("task")) {
    rules.push(
      "Use the task tool to delegate broad searches or independent sub-tasks to a subagent; it keeps your own context small. Check each subagent report: if it says it did not finish, or only announces what it would do, the work is not done.",
    );
  }
  if (has("skill")) {
    rules.push(
      "The skill tool lists skills: specialised instructions for certain kinds of tasks. When the request matches a skill's description, load it with skill before starting and follow its instructions.",
    );
  }
  if (has("websearch") || has("webfetch")) {
    rules.push("Use websearch to find documentation and webfetch to read a page when you need information you don't have.");
  }
  rules.push(
    "Files the user attaches with @path come inside <fichero> or <carpeta> tags in their message; they are already read.",
    "When you finish, reply with a short summary of what you changed. Do not paste whole files back.",
    "Reply in the same language the user writes in (usually Spanish). Be concise; use Markdown only when it helps.",
  );

  let agentText = "";
  if (agent.prompt.trim() !== "") {
    agentText = `\n\n${agent.prompt.trim()}`;
  }
  let isGit = "no";
  if (fs.existsSync(path.join(root, ".git"))) {
    isGit = "yes";
  }
  let homeWarning = "";
  if (path.resolve(root) === path.resolve(os.homedir())) {
    homeWarning = "\n- Warning: the working directory is the user's home folder, not a project. Searches here are slow and touch personal files; create any new project in its own subfolder.";
  }
  let about = "";
  if (!options.subagent) {
    about = `\n\n${aboutVipcode(options.agentNames || [agent.name])}`;
  }

  return `You are vipcode, an expert software engineering agent running in the user's terminal.${modeText ? `\n\n${modeText}` : ""}${agentText}${about}

Working rules:
${rules.map((rule) => `- ${rule}`).join("\n")}

Environment:
- Working directory: ${root}
- Git repository: ${isGit}
- Platform: ${process.platform}
- Shell for the bash tool: ${shellLine()}
- Date: ${new Date().toISOString().slice(0, 10)}
- Top-level entries: ${topLevel(root)}${homeWarning}${projectInstructions(root, options.instructions)}`;
}
