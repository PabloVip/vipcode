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

// Se comparan con el comando ya limpio: sin rutas, sin .cmd ni .exe, sin npx, sin variables delante, sin lo que solo lanza
// otro programa («bundle exec», «uv run»…) y con «python -m módulo» como el módulo
const LONG_RUNNING: { pattern: RegExp; alternative: string }[] = [
  { pattern: /^ng (serve|s)\b/i, alternative: "ng build" },
  // ng test se queda vigilando si no se le dice lo contrario
  { pattern: /^ng (test|t)\b(?!.*--(no-watch|watch[= ]false))/i, alternative: "ng test --watch=false" },
  { pattern: /^vitest (watch|dev)\b/i, alternative: "vitest run" },
  // vite a secas, dev, serve o preview; con «build» en cualquier sitio («vite --mode production build») termina
  { pattern: /^vite\b(?!.*\s(build|optimize)\b)/i, alternative: "vite build" },
  { pattern: /^next (dev|start)\b/i, alternative: "next build" },
  { pattern: /^(nuxt|nuxi) (dev|preview|start)\b/i, alternative: "nuxt build" },
  { pattern: /^astro (dev|preview)\b/i, alternative: "astro build" },
  { pattern: /^(remix|svelte-kit) (dev|preview)\b/i, alternative: BUILD },
  { pattern: /^gatsby (develop|serve)\b/i, alternative: "gatsby build" },
  { pattern: /^vue-cli-service serve\b/i, alternative: "vue-cli-service build" },
  { pattern: /^react-scripts start\b/i, alternative: "react-scripts build" },
  { pattern: /^(webpack serve\b|webpack-dev-server\b)/i, alternative: "webpack (sin serve)" },
  { pattern: /^parcel\b(?!.*\sbuild\b)/i, alternative: "parcel build" },
  { pattern: /^(ember|ionic) serve\b/i, alternative: BUILD },
  { pattern: /^(expo|react-native) start\b/i, alternative: BUILD },
  { pattern: /^nest start\b/i, alternative: "nest build" },
  { pattern: /^strapi (develop|start)\b/i, alternative: "strapi build" },
  { pattern: /^(hugo server|jekyll serve)\b/i, alternative: "hugo o jekyll build" },
  { pattern: /^(storybook (dev|start)|start-storybook)\b/i, alternative: "storybook build" },
  { pattern: /^(wrangler|netlify|vercel) dev\b/i, alternative: BUILD },
  { pattern: /^firebase (emulators:start|serve)\b/i, alternative: BUILD },
  { pattern: /^sam local start-(api|lambda)\b/i, alternative: "sam build" },
  // bin/dev (Rails) y los que arrancan un Procfile
  { pattern: /^(dev|(foreman|overmind|honcho) start)(\s|$)/i, alternative: BUILD },
  { pattern: /^(nodemon|ts-node-dev|node-dev|supervisor)\b/i, alternative: "ejecutar el programa una vez, si termina solo" },
  { pattern: /^tsx watch\b/i, alternative: "tsc --noEmit" },
  { pattern: /^(serve|http-server|live-server|lite-server|browser-sync)\b/i, alternative: BUILD },
  { pattern: /^http\.server\b/i, alternative: "no hace falta servir nada para comprobarlo" },
  { pattern: /^(manage\.py|django) runserver\b/i, alternative: "python manage.py check" },
  { pattern: /^(flask\b.*\srun\b|uvicorn\b|gunicorn\b|hypercorn\b|streamlit run\b|jupyter (notebook|lab)\b)/i, alternative: "las pruebas del proyecto, o python -m compileall" },
  { pattern: /^php\s+-S\b/i, alternative: "php -l para comprobar la sintaxis" },
  { pattern: /^php\s+artisan\s+serve\b/i, alternative: "php artisan test" },
  { pattern: /^rails (s|server)\b/i, alternative: "rails test" },
  { pattern: /^(mvn|mvnw)\b.*\b(spring-boot:run|quarkus:dev|jetty:run|tomcat7:run)\b/i, alternative: "mvn package" },
  { pattern: /^(gradle|gradlew)\b.*\b(bootrun|quarkusdev)\b/i, alternative: "gradle build" },
  { pattern: /^dotnet watch\b/i, alternative: "dotnet build" },
  { pattern: /^(cargo watch|air)\b/i, alternative: "cargo build o go build" },
  // up sin -d no vuelve; con --abort-on-container-exit, --exit-code-from o --wait sí (así se pasan pruebas en CI)
  {
    pattern: /^(docker compose|docker-compose)\b.*\sup\b(?!.*\s(-[a-z]*d[a-z]*|--detach|--abort-on-container-exit|--exit-code-from|--wait|--no-start)(\s|=|$))/i,
    alternative: "docker compose up -d",
  },
  { pattern: /^(docker compose|docker-compose)\b.*\swatch\b/i, alternative: "docker compose up -d" },
  { pattern: /^(docker|podman|kubectl) (compose )?logs\b.*\s(-f|--follow)\b/i, alternative: "logs sin -f (por ejemplo con --tail 50)" },
  { pattern: /^kubectl port-forward\b/i, alternative: "kubectl get" },
  { pattern: /^kubectl\b.*\sget\b.*\s(-w|--watch|--watch-only)(=true)?(\s|$)/i, alternative: "kubectl get sin -w" },
  { pattern: /^tail\b.*\s(-[a-z0-9]*f[a-z0-9]*|--follow\S*)(\s|$)/i, alternative: "tail -n 50" },
  { pattern: /^journalctl\b.*\s(-[a-z]*f[a-z]*|--follow)(\s|$)/i, alternative: "journalctl -n 50" },
  { pattern: /^get-content\b.*\s-wait\b/i, alternative: "Get-Content -Tail 50" },
  { pattern: /^watch\s+\S/i, alternative: "ejecutar el comando una vez" },
  // En Windows -t es «para siempre»; en macOS, -t <segundos> es un tiempo límite
  { pattern: /^ping\b.*\s-t(\s+(?!\d+(\s|$))\S|\s*$)/i, alternative: "ping -n 4" },
  { pattern: /^(ngrok|localtunnel|lt)\b/i, alternative: BUILD },
  // -w es «watch» solo en estas: en jest, por ejemplo, es otra cosa
  { pattern: /^(tsc|webpack|rollup|babel|sass|lessc|tailwindcss|tailwind|esbuild|swc|node-sass|stylus)\b.*\s-[a-z]*w(\s|$)/i, alternative: "el mismo comando sin -w" },
];

// Estos solo miran o guardan texto, o esperan a algo que acaba («gh pr checks --watch»): un «--watch» no los hace eternos
const NEVER_WATCH = new Set(["git", "gh", "echo", "printf", "grep", "rg", "cat", "ls", "find", "sed", "awk", "man"]);
// Lanzan un script del proyecto por su nombre
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "deno", "turbo", "nx", "lerna"]);
const VALUE_FLAGS = new Set(["--prefix", "-c", "--cwd", "--dir", "--filter", "-f", "--workspace", "-w"]);
// Solo lanzan el programa que va detrás
const LAUNCHERS = new Set(["nohup", "exec", "command", "time", "sudo", "npx", "bunx", "pnpx", "env", "cross-env"]);
// «bundle exec rails s», «uv run uvicorn app», «poetry run python manage.py runserver»…
const RUNNERS_WITH_VERB: Record<string, string> = { bundle: "exec", uv: "run", poetry: "run", pipenv: "run", pdm: "run", hatch: "run", rye: "run" };
// Sus opciones que llevan un valor detrás («uv run --env-file .env uvicorn app»)
const RUNNER_VALUE_FLAGS = new Set(["--env-file", "--with", "--python", "-p", "--project", "--directory", "--package", "--group", "--extra", "--index", "-e", "--env"]);

// Nombres de scripts: lo que arranca algo que se queda escuchando, y lo que es una tarea que acaba (aunque lleve «dev» o
// «server» en el nombre: test:server, migrate:dev, dev:seed)
const SERVER_WORDS = new Set(["start", "dev", "develop", "serve", "server", "preview", "storybook"]);
const TASK_WORDS = new Set([
  "test", "tests", "e2e", "lint", "typecheck", "types", "tsc", "check", "build", "compile", "bundle", "setup", "seed", "migrate",
  "migration", "migrations", "db", "clean", "format", "fmt", "install", "deploy", "release", "ci", "gen", "generate", "codegen",
  "docs", "prepare", "reset", "analyze",
]);

// Scripts de package.json (o tareas de deno, turbo, nx): start, dev, serve:ssr, test:watch, build:watch… pero no build:dev,
// test:server ni migrate:dev
function isServerScript(name: string): boolean {
  const parts = name.toLowerCase().split(/[:._\-/]+/).filter(Boolean);
  // Un modo watch no acaba nunca, sea de lo que sea
  if (parts.includes("watch")) {
    return true;
  }
  if (parts.some((part) => TASK_WORDS.has(part))) {
    return false;
  }
  return parts.some((part) => SERVER_WORDS.has(part));
}

// El script que lanza npm, pnpm, yarn, bun, deno task, turbo o nx, saltándose sus opciones («npm --prefix web run dev»)
function scriptOf(words: string[]): string | null {
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (VALUE_FLAGS.has(word.toLowerCase())) {
      i++;
    } else if (word.toLowerCase() === "workspace") {
      i++;
    } else if (!word.startsWith("-") && word !== "run" && word !== "run-script" && word !== "task") {
      return word;
    }
  }
  return null;
}

// Quita lo que va dentro de un heredoc («<<EOF» … «EOF») o de un here-string de PowerShell (@" … "@): es texto, no comandos.
// Si no, un README escrito con cat <<EOF que diga «npm run dev» en una línea no se podría escribir
function withoutHeredocs(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    const heredoc = lines[i].match(/<<[-~]?\s*(['"]?)([A-Za-z_][\w.-]*)\1/);
    if (heredoc) {
      const end = heredoc[2];
      while (i + 1 < lines.length && lines[i + 1].trim() !== end) {
        i++;
      }
      // y la línea que lo cierra
      i++;
    } else if (/@["']\s*$/.test(lines[i])) {
      while (i + 1 < lines.length && !/^["']@/.test(lines[i + 1])) {
        i++;
      }
      i++;
    }
  }
  return kept.join("\n");
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

// «python -m flask run» es flask run; «python manage.py runserver», manage.py runserver
function pythonTarget(words: string[]): string[] {
  const module = words.indexOf("-m");
  if (module >= 0 && words[module + 1]) {
    return words.slice(module + 1);
  }
  const script = words.findIndex((word, index) => index > 0 && !word.startsWith("-"));
  if (script > 0) {
    return [words[script].replace(/^.*[\\/]/, ""), ...words.slice(script + 1)];
  }
  return words;
}

function checkPart(part: string): LongRunning | null {
  let words = splitArgs(part.replace(/^[{\s]+/, ""));
  // Variables delante y lo que solo lanza otro programa
  while (words.length > 0) {
    const first = words[0];
    const name = first.replace(/^.*[\\/]/, "").replace(/\.(cmd|exe|ps1|bat)$/i, "").toLowerCase();
    if (/^\w+=/.test(first) || LAUNCHERS.has(name)) {
      words = words.slice(1);
      while ((name === "npx" || name === "bunx" || name === "pnpx") && words[0]?.startsWith("-")) {
        words = words.slice(1);
      }
    } else if ((name === "pnpm" || name === "yarn" || name === "npm") && (words[1] === "exec" || words[1] === "dlx")) {
      words = words.slice(2);
    } else if (RUNNERS_WITH_VERB[name] && words[1] === RUNNERS_WITH_VERB[name]) {
      words = words.slice(2);
      while (words[0]?.startsWith("-")) {
        words = words.slice(RUNNER_VALUE_FLAGS.has(words[0].toLowerCase()) ? 2 : 1);
      }
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
  if (/^(python[\d.]*|py)$/.test(words[0])) {
    words = pythonTarget(words);
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
  // Fuera de las comillas: en «--message "--watch"» es solo texto. «kubectl rollout status» espera a que acabe y termina
  const unquoted = part.replace(/"[^"]*"|'[^']*'/g, " ");
  const waitsForEnd = words[0] === "kubectl" && words[1] === "rollout";
  if (!NEVER_WATCH.has(words[0]) && !waitsForEnd && /\s--(watch|watchall)(=true)?(\s|$)/i.test(unquoted)) {
    return { command, alternative: "el mismo comando sin --watch" };
  }
  return null;
}

// ¿Este comando, o alguna de sus partes («cd web && npm start»), no va a terminar solo?
export function findLongRunning(command: string): LongRunning | null {
  for (const part of splitParts(withoutHeredocs(command))) {
    const found = checkPart(part);
    if (found) {
      return found;
    }
  }
  return null;
}

// Lo que escribe un servidor cuando ya está listo y solo espera. Es la última red, para lo que no reconoce la lista de arriba.
// «Started Xxx in 3.2 seconds» no está: lo escriben también las pruebas de Spring Boot, que luego pueden pasar un rato calladas
const SERVER_READY =
  /watching for (file )?changes|local:\s+https?:\/\/|https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)[:/]|listening on\b|server (is )?(running|listening|started|ready)|started (server|on port)\b|^\s*started\s*\.?$|press ctrl\+c to (quit|stop)|compiled successfully|ready in \d+/im;

// ¿Lo último que ha escrito parece un servidor listo?
export function looksLikeServer(output: string): boolean {
  const lines = output
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  return SERVER_READY.test(lines.slice(-8).join("\n"));
}
