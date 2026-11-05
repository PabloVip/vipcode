// Copyright (C) 2026 Pablo Vicente Juan
// SPDX-License-Identifier: AGPL-3.0-or-later
import { splitArgs } from "./shell.js";

// Comandos que no terminan solos: servidores de desarrollo y modos «watch». Si el agente lanza uno, se queda esperando hasta
// que se acaba el tiempo y no sirve para nada. Para añadir otro, basta con una línea en LONG_RUNNING

export interface LongRunning {
  // La parte del comando que no termina
  command: string;
  // Qué puede hacer el modelo en su lugar
  alternative: string;
}

const BUILD = "el build del proyecto (npm run build)";

// Se comparan con el comando ya limpio: sin rutas, sin .cmd ni .exe, sin npx y sin variables delante
const LONG_RUNNING: { pattern: RegExp; alternative: string }[] = [
  { pattern: /^ng (serve|s)\b/i, alternative: "ng build" },
  // ng test se queda vigilando si no se le dice lo contrario
  { pattern: /^ng (test|t)\b(?!.*--(no-watch|watch[= ]false))/i, alternative: "ng test --watch=false" },
  { pattern: /^vitest (watch|dev)\b/i, alternative: "vitest run" },
  { pattern: /^vite(\s+(dev|serve|preview|-).*)?$/i, alternative: "vite build" },
  { pattern: /^next (dev|start)\b/i, alternative: "next build" },
  { pattern: /^(nuxt|nuxi) (dev|preview|start)\b/i, alternative: "nuxt build" },
  { pattern: /^astro (dev|preview)\b/i, alternative: "astro build" },
  { pattern: /^(remix|svelte-kit) (dev|preview)\b/i, alternative: BUILD },
  { pattern: /^gatsby (develop|serve)\b/i, alternative: "gatsby build" },
  { pattern: /^vue-cli-service serve\b/i, alternative: "vue-cli-service build" },
  { pattern: /^react-scripts start\b/i, alternative: "react-scripts build" },
  { pattern: /^(webpack serve\b|webpack-dev-server\b)/i, alternative: "webpack (sin serve)" },
  { pattern: /^parcel(\s+(?!build\b)\S.*)?$/i, alternative: "parcel build" },
  { pattern: /^(ember|ionic) serve\b/i, alternative: BUILD },
  { pattern: /^(expo|react-native) start\b/i, alternative: BUILD },
  { pattern: /^nest start\b/i, alternative: "nest build" },
  { pattern: /^strapi (develop|start)\b/i, alternative: "strapi build" },
  { pattern: /^(hugo server|jekyll serve)\b/i, alternative: "hugo o jekyll build" },
  { pattern: /^(nodemon|ts-node-dev|node-dev|supervisor)\b/i, alternative: "ejecutar el programa una vez, si termina solo" },
  { pattern: /^tsx watch\b/i, alternative: "tsc --noEmit" },
  { pattern: /^(serve|http-server|live-server|lite-server|browser-sync)\b/i, alternative: BUILD },
  { pattern: /^(python\d*|py)\s+(-\S+\s+)*-m\s+http\.server\b/i, alternative: "no hace falta servir nada para comprobarlo" },
  { pattern: /^(python\d*|py)\s+\S*manage\.py\s+runserver\b/i, alternative: "python manage.py check" },
  { pattern: /^(flask run|uvicorn|gunicorn|hypercorn|streamlit run|jupyter (notebook|lab))\b/i, alternative: "las pruebas del proyecto, o python -m compileall" },
  { pattern: /^php\s+-S\b/i, alternative: "php -l para comprobar la sintaxis" },
  { pattern: /^php\s+artisan\s+serve\b/i, alternative: "php artisan test" },
  { pattern: /^rails (s|server)\b/i, alternative: "rails test" },
  { pattern: /^(mvn|mvnw)\b.*\b(spring-boot:run|quarkus:dev|jetty:run|tomcat7:run)\b/i, alternative: "mvn package" },
  { pattern: /^(gradle|gradlew)\b.*\b(bootrun|quarkusdev)\b/i, alternative: "gradle build" },
  { pattern: /^dotnet watch\b/i, alternative: "dotnet build" },
  { pattern: /^(cargo watch|air)\b/i, alternative: "cargo build o go build" },
  { pattern: /^(docker compose|docker-compose)\b.*\sup\b(?!.*\s(-[a-z]*d[a-z]*|--detach)(\s|$))/i, alternative: "docker compose up -d" },
  { pattern: /^(docker|podman|kubectl) (compose )?logs\b.*\s(-f|--follow)\b/i, alternative: "logs sin -f (por ejemplo con --tail 50)" },
  { pattern: /^kubectl port-forward\b/i, alternative: "kubectl get" },
  { pattern: /^tail\b.*\s(-[a-z0-9]*f[a-z0-9]*|--follow\S*)(\s|$)/i, alternative: "tail -n 50" },
  { pattern: /^journalctl\b.*\s(-[a-z]*f[a-z]*|--follow)(\s|$)/i, alternative: "journalctl -n 50" },
  { pattern: /^get-content\b.*\s-wait\b/i, alternative: "Get-Content -Tail 50" },
  { pattern: /^watch\s+\S/i, alternative: "ejecutar el comando una vez" },
  { pattern: /^ping\b.*\s-t(\s|$)/i, alternative: "ping -n 4" },
  { pattern: /^(ngrok|localtunnel|lt)\b/i, alternative: BUILD },
  // -w es «watch» solo en estas: en jest, por ejemplo, es otra cosa
  { pattern: /^(tsc|webpack|rollup|babel|sass|lessc|tailwindcss|tailwind|esbuild|swc|node-sass|stylus)\b.*\s-[a-z]*w(\s|$)/i, alternative: "el mismo comando sin -w" },
];

// Estos solo miran o guardan texto: un «--watch» en sus argumentos no es un modo watch
const NEVER_WATCH = new Set(["git", "echo", "printf", "grep", "rg", "cat", "ls", "find", "sed", "awk", "man"]);
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const VALUE_FLAGS = new Set(["--prefix", "-c", "--cwd", "--dir", "--filter", "-f", "--workspace", "-w"]);

// Scripts de package.json: start, dev, serve:ssr, test:watch… pero no build:dev
function isServerScript(name: string): boolean {
  if (/build|compile|bundle/i.test(name)) {
    return false;
  }
  return (
    /^(start|dev|develop|serve|server|watch|preview)([:._-]|$)/i.test(name) ||
    /[:._-](watch|serve|server)$/i.test(name) ||
    (/[:._-](start|dev)$/i.test(name) && !/^(test|lint|check|deploy)/i.test(name))
  );
}

// El script que lanza npm, pnpm, yarn o bun, saltándose sus opciones («npm --prefix web run dev»)
function scriptOf(words: string[]): string | null {
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (VALUE_FLAGS.has(word.toLowerCase())) {
      i++;
    } else if (word.toLowerCase() === "workspace") {
      i++;
    } else if (!word.startsWith("-") && word !== "run" && word !== "run-script") {
      return word;
    }
  }
  return null;
}

// Separa las partes de un comando sin mirar dentro de las comillas: en «git commit -m "a; npm start"» no hay ningún npm start
function splitParts(command: string): string[] {
  const parts: string[] = [];
  let part = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const letter = command[i];
    if (quote) {
      quote = letter === quote ? "" : quote;
      part += letter;
    } else if (letter === '"' || letter === "'") {
      quote = letter;
      part += letter;
    } else if (letter === "\n" || letter === ";" || letter === "|" || letter === "(" || letter === ")") {
      parts.push(part);
      part = "";
    } else if (letter === "&" && command[i - 1] !== ">" && command[i + 1] !== ">") {
      parts.push(part);
      part = "";
    } else {
      part += letter;
    }
  }
  parts.push(part);
  return parts.map((text) => text.trim()).filter((text) => text !== "");
}

function checkPart(part: string): LongRunning | null {
  let words = splitArgs(part.replace(/^[{\s]+/, ""));
  // Variables delante y lo que solo lanza otro programa
  while (words.length > 0) {
    const first = words[0];
    const name = first.replace(/^.*[\\/]/, "").replace(/\.(cmd|exe|ps1|bat)$/i, "").toLowerCase();
    if (/^\w+=/.test(first) || ["nohup", "exec", "command", "time", "sudo", "npx", "bunx", "pnpx", "env"].includes(name)) {
      words = words.slice(1);
      while ((name === "npx" || name === "bunx" || name === "pnpx") && words[0]?.startsWith("-")) {
        words = words.slice(1);
      }
    } else if ((name === "pnpm" || name === "yarn" || name === "npm") && (words[1] === "exec" || words[1] === "dlx")) {
      words = words.slice(2);
    } else if (["bash", "sh", "zsh", "cmd", "powershell", "pwsh"].includes(name) && words.some((word) => /^(-c|-lc|\/c|-command)$/i.test(word))) {
      // Lo que va dentro de «bash -c "…"»
      const index = words.findIndex((word) => /^(-c|-lc|\/c|-command)$/i.test(word));
      return findLongRunning(words.slice(index + 1).join(" "));
    } else {
      words = [name, ...words.slice(1)];
      break;
    }
  }
  if (words.length === 0) {
    return null;
  }
  // Solo preguntan algo y terminan
  if (words.some((word) => /^(--help|--version)$/i.test(word))) {
    return null;
  }
  const command = words.join(" ");
  if (SCRIPT_RUNNERS.has(words[0])) {
    const script = scriptOf(words);
    if (script && isServerScript(script)) {
      return { command, alternative: BUILD };
    }
  }
  for (const rule of LONG_RUNNING) {
    if (rule.pattern.test(command)) {
      return { command, alternative: rule.alternative };
    }
  }
  // Fuera de las comillas: en «--message "--watch"» es solo texto
  const unquoted = part.replace(/"[^"]*"|'[^']*'/g, " ");
  if (!NEVER_WATCH.has(words[0]) && /\s--(watch|watchall)(=true)?(\s|$)/i.test(unquoted)) {
    return { command, alternative: "el mismo comando sin --watch" };
  }
  return null;
}

// ¿Este comando, o alguna de sus partes («cd web && npm start»), no va a terminar solo?
export function findLongRunning(command: string): LongRunning | null {
  for (const part of splitParts(command)) {
    const found = checkPart(part);
    if (found) {
      return found;
    }
  }
  return null;
}

// Lo que escribe un servidor cuando ya está listo y solo espera. Es la última red, para lo que no reconoce la lista de arriba
const SERVER_READY =
  /watching for (file )?changes|local:\s+https?:\/\/|https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)[:/]|listening on\b|server (is )?(running|listening|started|ready)|started (server|on port|\w+ in\b)|^\s*started\s*\.?$|press ctrl\+c to (quit|stop)|compiled successfully|ready in \d+/im;

// ¿Lo último que ha escrito parece un servidor listo?
export function looksLikeServer(output: string): boolean {
  const lines = output
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  return SERVER_READY.test(lines.slice(-8).join("\n"));
}
