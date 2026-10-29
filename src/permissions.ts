import os from "node:os";
import path from "node:path";
import { type PermissionAction, type PermissionConfig, deepMerge } from "./config.js";
import { wildcardMatch } from "./match.js";
import { HOME_DIR, INSTALL_DIR } from "./paths.js";

// Tipo de acción con riesgo; "web" y "none" no modifican nada, así que valen en modo plan
export type Permission = "none" | "write" | "bash" | "web" | "mcp";

export interface PermissionRequest {
  kind: Permission;
  title: string;
  preview: string;
  // Lo que se compara con las reglas: el comando, la URL, la ruta o el nombre de la herramienta MCP
  subject: string;
}

export interface PermissionReply {
  allow: boolean;
  // Si el usuario explica por qué no, se lo pasamos al modelo
  feedback?: string;
}

const STRICTNESS: Record<PermissionAction, number> = { allow: 0, ask: 1, deny: 2 };

function strictest(a: PermissionAction, b: PermissionAction): PermissionAction {
  if (STRICTNESS[b] > STRICTNESS[a]) {
    return b;
  }
  return a;
}

// Reglas tipo { "*": "ask", "git status*": "allow" }: gana el patrón más concreto (el más largo)
export function matchRules(
  rules: PermissionAction | Record<string, PermissionAction> | undefined,
  subject: string,
  fallback: PermissionAction,
): PermissionAction {
  if (!rules) {
    return fallback;
  }
  if (typeof rules === "string") {
    return rules;
  }
  let best: { length: number; action: PermissionAction } | null = null;
  for (const [pattern, action] of Object.entries(rules)) {
    if (wildcardMatch(pattern, subject) && (!best || pattern.length >= best.length)) {
      best = { length: pattern.length, action };
    }
  }
  if (best) {
    return best.action;
  }
  return fallback;
}

// Parte "a && b | c; d" en comandos sueltos para que "git status && rm -rf x" no pase como "git status"
// Redirecciones que no escriben ficheros (2>&1, >/dev/null): no cuentan como separadores ni como escritura
const HARMLESS_REDIRECTS = /\d*>&\d+|&>\s*\/dev\/null|\d*>>?\s*\/dev\/null/g;

export function splitCommand(command: string): string[] {
  // Un & suelto (segundo plano) también separa: «ls & rm -rf ~» son dos comandos
  return command
    .replace(HARMLESS_REDIRECTS, " ")
    .split(/&&|\|\||;|\||\n|&/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function evaluate(config: PermissionConfig, kind: Permission, subject: string): PermissionAction {
  if (kind === "none") {
    return "allow";
  }
  if (kind === "write") {
    return config.edit || "ask";
  }
  if (kind === "web") {
    return config.webfetch || "ask";
  }
  if (kind === "mcp") {
    return matchRules(config.mcp, subject, "ask");
  }
  const parts = splitCommand(subject);
  let result: PermissionAction = "allow";
  if (parts.length === 0) {
    result = matchRules(config.bash, subject, "ask");
  }
  for (const part of parts) {
    result = strictest(result, matchRules(config.bash, part, "ask"));
  }
  // Una sustitución $(...) o `...` puede esconder cualquier cosa
  // Sustituciones, escribir en ficheros (> o --output) y saltos de línea raros siempre se preguntan,
  // aunque el comando esté permitido (si no, «ls > ~/.zshrc» pasaría por «ls*»)
  const writes = /[<>]\(|>/.test(subject.replace(HARMLESS_REDIRECTS, " ")) || /--output\b|\r/.test(subject);
  if (/\$\(|`/.test(subject) || writes) {
    result = strictest(result, "ask");
  }
  return result;
}

// Mezcla los permisos generales con los de un agente concreto
export function permissionsFor(base: PermissionConfig, override?: PermissionConfig): PermissionConfig {
  if (!override) {
    return base;
  }
  return deepMerge(base, override);
}

// Sugerencia de patrón para "siempre este comando": "npm test -- --watch" → "npm test*"
export function suggestPattern(command: string): string {
  const first = splitCommand(command)[0] || command.trim();
  const words = first.split(/\s+/);
  const twoWords = ["npm", "pnpm", "yarn", "bun", "git", "cargo", "go", "pip", "pip3", "python", "python3", "node", "npx", "docker", "make", "uv", "poetry", "deno", "composer", "php", "dotnet", "mvn", "gradle", "./gradlew", "bundle", "rails", "rake", "pytest", "php artisan"];
  if (words.length >= 2 && twoWords.includes(words[0])) {
    return `${words[0]} ${words[1]}*`;
  }
  return `${words[0]}*`;
}

// Permisos concedidos durante la sesión ("sí a todo", "siempre este comando")
export class SessionGrants {
  private kinds = new Set<Permission>();
  private patterns: { kind: Permission; pattern: string }[] = [];

  allowKind(kind: Permission) {
    this.kinds.add(kind);
  }

  allowPattern(kind: Permission, pattern: string) {
    this.patterns.push({ kind, pattern });
  }

  allows(kind: Permission, subject: string): boolean {
    if (this.kinds.has(kind)) {
      return true;
    }
    const patterns = this.patterns.filter((entry) => entry.kind === kind).map((entry) => entry.pattern);
    if (patterns.length === 0) {
      return false;
    }
    if (kind === "bash") {
      if (/\$\(|`/.test(subject)) {
        return false;
      }
      const parts = splitCommand(subject);
      return parts.length > 0 && parts.every((part) => patterns.some((pattern) => wildcardMatch(pattern, part)));
    }
    return patterns.some((pattern) => wildcardMatch(pattern, subject));
  }
}

// Decide si una acción se permite sola, se bloquea o hay que preguntar
// Un comando que nombra la carpeta de datos de vipcode o su instalación (para leer tus claves, cambiar la
// configuración o tocar su propio código) se pregunta siempre: no vale ninguna regla allow ni «sí a todo»
export function touchesVipcode(command: string): boolean {
  const home = os.homedir();
  const names = [HOME_DIR, INSTALL_DIR, "lib/node_modules/vipcode"];
  if (HOME_DIR.startsWith(home + path.sep)) {
    const inHome = HOME_DIR.slice(home.length + 1);
    names.push(`~/${inHome}`, `$HOME/${inHome}`, `\${HOME}/${inHome}`);
  }
  return names.some((name) => command.includes(name));
}

export function createAsker(
  getConfig: () => PermissionConfig,
  grants: SessionGrants,
  prompt: (request: PermissionRequest) => Promise<PermissionReply>,
): (request: PermissionRequest) => Promise<PermissionReply> {
  return async (request) => {
    const action = evaluate(getConfig(), request.kind, request.subject);
    if (action === "deny") {
      return { allow: false, feedback: "bloqueado por la configuración de permisos (deny)" };
    }
    if (request.kind === "bash" && touchesVipcode(request.subject)) {
      return prompt({ ...request, title: `${request.title} (toca la carpeta de vipcode)` });
    }
    if (action === "allow" || grants.allows(request.kind, request.subject)) {
      return { allow: true };
    }
    return prompt(request);
  };
}
