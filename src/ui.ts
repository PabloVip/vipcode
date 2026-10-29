import type { Interface } from "node:readline/promises";
import pc from "picocolors";
import type { AgentEvents } from "./agent.js";
import type { UiAdapter } from "./app.js";
import { type PermissionReply, type PermissionRequest, type SessionGrants, suggestPattern } from "./permissions.js";
import { formatTodos } from "./tools.js";

export const ui = {
  text(chunk: string) {
    process.stdout.write(chunk);
  },
  info(message: string) {
    console.log(pc.dim(message));
  },
  notice(message: string) {
    console.log(pc.yellow(`⚠ ${message}`));
  },
  error(message: string) {
    console.log(pc.red(`✖ ${message}`));
  },
  tool(name: string, summary: string, depth = 0) {
    const indent = depth > 0 ? "      " : "  ";
    console.log(pc.cyan(`${indent}● ${name}`) + pc.dim(` ${summary}`));
  },
  banner(agent: string, slots: number) {
    console.log(pc.bold(pc.magenta("vipcode")) + pc.dim(` · agente ${agent} · ${slots} modelos · /help para ayuda`));
  },
  prompt(agent: string): string {
    if (agent === "plan") {
      return pc.blue("plan ❯ ");
    }
    if (agent !== "build") {
      return pc.yellow(`${agent} ❯ `);
    }
    return pc.magenta("❯ ");
  },
};

// Líneas quitadas en rojo, añadidas en verde, cabeceras @@ en cian y el contexto atenuado
export function colorPreview(preview: string): string {
  return preview
    .split("\n")
    .map((line) => {
      if (line.startsWith("+ ")) {
        return pc.green(line);
      }
      if (line.startsWith("- ")) {
        return pc.red(line);
      }
      if (line.startsWith("@@")) {
        return pc.cyan(line);
      }
      if (line.startsWith("  ")) {
        return pc.dim(line);
      }
      return line;
    })
    .join("\n");
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

// Eventos del agente pintados como texto normal
export function plainEvents(options: { showReasoning: boolean }): AgentEvents {
  let reasoning = "";
  let reasoningShown = false;
  const flushReasoning = () => {
    if (reasoningShown) {
      process.stdout.write("\n");
    }
    reasoning = "";
    reasoningShown = false;
  };
  return {
    onText: (chunk, depth) => {
      if (depth > 0) {
        return;
      }
      flushReasoning();
      process.stdout.write(chunk);
    },
    onTextEnd: (depth) => {
      if (depth === 0) {
        process.stdout.write("\n");
      }
    },
    onReasoning: (chunk, depth) => {
      if (!options.showReasoning || depth > 0) {
        return;
      }
      // Solo el principio del razonamiento, en una línea atenuada
      if (reasoning.length < 240) {
        if (!reasoningShown) {
          process.stdout.write(pc.dim("  💭 "));
          reasoningShown = true;
        }
        const piece = chunk.replace(/\s+/g, " ").slice(0, 240 - reasoning.length);
        reasoning += piece;
        process.stdout.write(pc.dim(piece));
        if (reasoning.length >= 240) {
          process.stdout.write(pc.dim("…"));
        }
      }
    },
    onToolStart: (event) => {
      flushReasoning();
      ui.tool(event.name, event.summary, event.depth);
    },
    onToolEnd: (event) => {
      const pad = event.depth > 0 ? "        " : "    ";
      if (event.isError) {
        console.log(pc.red(`${pad}${event.output.split("\n")[0].slice(0, 200)}`));
      } else if (event.display && event.depth === 0) {
        console.log(indent(colorPreview(event.display), pad));
      }
    },
    onNotice: (message) => {
      flushReasoning();
      ui.notice(message);
    },
    onInfo: (message) => ui.info(message),
    onTodos: (todos) => console.log(pc.dim(indent(formatTodos(todos), "    "))),
  };
}

// Pregunta s/n/t (y p para comandos) antes de escribir ficheros o ejecutar comandos
export function plainPermissionPrompt(getReadline: () => Interface | null, grants: () => SessionGrants) {
  return async (request: PermissionRequest): Promise<PermissionReply> => {
    const rl = getReadline();
    if (!rl || !process.stdin.isTTY) {
      return { allow: false, feedback: "no hay nadie para aprobarlo (usa --yolo o ajusta los permisos)" };
    }
    console.log("");
    console.log(pc.bold(pc.yellow(`? ${request.title}`)));
    console.log(colorPreview(request.preview));
    let options = "[s]í / [n]o / [t]odo en esta sesión / [e] no y explicar";
    let pattern = "";
    if (request.kind === "bash") {
      pattern = suggestPattern(request.subject);
      options = `[s]í / [n]o / [t]odo / [p] siempre «${pattern}» / [e] no y explicar`;
    }
    while (true) {
      let answer = "";
      try {
        answer = (await rl.question(pc.yellow(`  ¿Permitir? ${options}: `))).trim().toLowerCase();
      } catch {
        return { allow: false, feedback: "sin respuesta" };
      }
      if (["s", "si", "sí", "y", "yes"].includes(answer)) {
        return { allow: true };
      }
      if (answer === "n" || answer === "no") {
        return { allow: false };
      }
      if (answer === "t") {
        grants().allowKind(request.kind);
        return { allow: true };
      }
      if (answer === "p" && pattern) {
        grants().allowPattern("bash", pattern);
        return { allow: true };
      }
      if (answer === "e") {
        let why = "";
        try {
          why = (await rl.question(pc.yellow("  ¿Qué debería hacer en su lugar?: "))).trim();
        } catch {
          why = "";
        }
        return { allow: false, feedback: why || undefined };
      }
    }
  };
}

// Interfaz mínima para los comandos / en el modo de texto
export const plainAdapter: UiAdapter = {
  info: (text) => ui.info(text),
  notice: (text) => ui.notice(text),
  error: (text) => ui.error(text),
  block: (text) => console.log(text),
};
