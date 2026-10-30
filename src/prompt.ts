import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { AgentDefinition } from "./agents.js";
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

// Lo que hay en la raíz del proyecto, para que el modelo se oriente sin gastar una llamada
// Para que el modelo escriba los comandos en el idioma de la shell que hay de verdad
function shellLine(): string {
  const shell = commandShell();
  if (shell.name === "PowerShell") {
    return "PowerShell (write PowerShell commands, not bash)";
  }
  if (shell.name === "cmd") {
    return "cmd.exe (write Windows cmd commands, not bash)";
  }
  if (shell.name === "Git Bash") {
    return "Git Bash on Windows (bash syntax; Windows tools like npm, node and git work as usual)";
  }
  return shell.name;
}

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

export interface PromptOptions {
  agent: AgentDefinition;
  toolNames: string[];
  instructions: string[];
  // true si es un subagente lanzado con task
  subagent?: boolean;
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
    );
  }
  rules.push(
    "Call several tools in one turn when they are independent.",
    "If a tool returns an error, read it and fix your approach instead of repeating the same call.",
  );
  if (has("todowrite")) {
    rules.push(
      "For tasks with 3 or more steps, keep a todo list with todowrite: mark one step in_progress when you start it and completed as soon as it is done. Skip it for simple tasks.",
    );
  }
  if (has("task")) {
    rules.push("Use the task tool to delegate broad searches or independent sub-tasks to a subagent; it keeps your own context small.");
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

  return `You are vipcode, an expert software engineering agent running in the user's terminal.${modeText ? `\n\n${modeText}` : ""}${agentText}

Working rules:
${rules.map((rule) => `- ${rule}`).join("\n")}

Environment:
- Working directory: ${root}
- Git repository: ${isGit}
- Platform: ${process.platform}
- Shell for the bash tool: ${shellLine()}
- Date: ${new Date().toISOString().slice(0, 10)}
- Top-level entries: ${topLevel(root)}${projectInstructions(root, options.instructions)}`;
}
