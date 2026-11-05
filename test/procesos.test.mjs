// Comandos que no terminan: cancelar nunca los espera, no queda ningún proceso vivo y /exit siempre sale. Es el fallo de
// Windows en el que «npm start» dejaba a vipcode esperando horas, por eso los programas de prueba lanzan a su vez otro programa
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CLI, contentText, lastMessage, provider, startMock, systemEnv, tempWorkspace } from "./helpers/mock-llm.mjs";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-procesos-"));
process.env.VIPCODE_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const tools = await import("../dist/tools.js");
const { findLongRunning, looksLikeServer } = await import("../dist/long-running.js");
const { killTree, spawnGroup, stopAllProcesses, watchChild } = await import("../dist/process.js");
const { expandCommand } = await import("../dist/commands.js");
const { App } = await import("../dist/app.js");
const { systemPrompt } = await import("../dist/prompt.js");

// La carpeta de datos se fija al importar los módulos: lo que se usa aquí dentro, sin lanzar otro programa, se configura en ella
function writeConfig(url, extra = {}) {
  fs.writeFileSync(path.join(HOME, "config.json"), JSON.stringify({ providers: [provider("p", url, ["m"])], enabledProviders: ["p"], autoUpdateModels: false, checkUpdates: false, verifyCode: false, ...extra }));
}

const hasExpect = process.platform !== "win32" && spawnSync("expect", ["-v"], { stdio: "ignore" }).status === 0;

const run = async (ctx, args) => tools.runTool(tools.CORE_TOOLS, "bash", JSON.stringify(args), ctx, false);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) {
      return true;
    }
    await sleep(25);
  }
  return check();
}

// Programa de prueba: un padre que lanza un nieto con la salida heredada y los dos se quedan esperando para siempre. Con
// «suelto», el nieto va en su propio grupo de procesos (matar el grupo del padre no lo alcanza); con «sale», el padre termina
// y el nieto se queda con la salida abierta
const PADRE = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const modo = process.argv[2] || "";
const nieto = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit", detached: modo.includes("suelto") });
fs.writeFileSync("nieto.pid", String(nieto.pid));
fs.writeFileSync("padre.pid", String(process.pid));
console.log("en marcha");
if (modo.includes("sale")) {
  nieto.unref();
  process.exit(0);
}
setInterval(() => {}, 1000);
`;

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-procesos-"));
  fs.writeFileSync(path.join(root, "padre.cjs"), PADRE);
  const pid = (name) => Number(fs.readFileSync(path.join(root, `${name}.pid`), "utf8"));
  const started = () => until(() => {
    try {
      return pid("padre") > 0 && pid("nieto") > 0;
    } catch {
      return false;
    }
  }, 15000);
  const pids = () => [pid("padre"), pid("nieto")];
  const cleanup = () => {
    for (const name of ["padre", "nieto"]) {
      try {
        process.kill(pid(name), "SIGKILL");
      } catch {
        // ya no está
      }
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { root, ctx: { root, bashTimeoutMs: 60000, readTimes: new Map(), ask: async () => ({ allow: true }) }, started, pids, cleanup };
}

async function noneAlive(pids) {
  assert.ok(await until(() => pids.every((pid) => !alive(pid))), `siguen vivos: ${pids.filter(alive).join(", ")}`);
}

test("Esc: la herramienta contesta en menos de 3 s con lo que había escrito y no queda ningún proceso vivo", async () => {
  const ws = workspace();
  try {
    const cancel = new AbortController();
    const pending = run({ ...ws.ctx, signal: cancel.signal }, { command: "node padre.cjs" });
    assert.ok(await ws.started());
    await sleep(200);
    const start = Date.now();
    cancel.abort();
    const result = await pending;
    assert.ok(Date.now() - start < 3000, `ha tardado ${Date.now() - start} ms`);
    assert.match(result.output, /^Cancelado por el usuario/);
    assert.match(result.output, /en marcha/);
    await noneAlive(ws.pids());
  } finally {
    ws.cleanup();
  }
});

test("tiempo máximo: lo mismo, y avisa de cuánto llevaba", async () => {
  const ws = workspace();
  try {
    const start = Date.now();
    const result = await run(ws.ctx, { command: "node padre.cjs", timeout_ms: 1500 });
    assert.ok(Date.now() - start < 4500, `ha tardado ${Date.now() - start} ms`);
    assert.match(result.output, /^Cortado por tiempo tras 1\.5 s/);
    assert.match(result.output, /en marcha/);
    await noneAlive(ws.pids());
  } finally {
    ws.cleanup();
  }
});

// El fallo tal cual: algo que no se puede matar con el árbol mantiene abierta la salida, y «close» no llega nunca
test("un nieto al que no se alcanza no deja colgada la herramienta (Esc y tiempo máximo)", async () => {
  const ws = workspace();
  try {
    const cancel = new AbortController();
    const pending = run({ ...ws.ctx, signal: cancel.signal }, { command: "node padre.cjs suelto" });
    assert.ok(await ws.started());
    const start = Date.now();
    cancel.abort();
    assert.match((await pending).output, /^Cancelado por el usuario/);
    assert.ok(Date.now() - start < 3000, `ha tardado ${Date.now() - start} ms`);
  } finally {
    ws.cleanup();
  }
  const other = workspace();
  try {
    const start = Date.now();
    const result = await run(other.ctx, { command: "node padre.cjs suelto", timeout_ms: 1000 });
    assert.match(result.output, /^Cortado por tiempo/);
    assert.ok(Date.now() - start < 4000, `ha tardado ${Date.now() - start} ms`);
  } finally {
    other.cleanup();
  }
});

test("un comando que termina pero deja algo con su salida abierta contesta a los ~2 s, sin que nadie lo cancele", async () => {
  const ws = workspace();
  try {
    const start = Date.now();
    const result = await run(ws.ctx, { command: "node padre.cjs sale" });
    assert.ok(Date.now() - start < 6000, `ha tardado ${Date.now() - start} ms`);
    assert.match(result.output, /en marcha/);
    // En Windows, Node mata a un hijo normal cuando muere su padre (lo mete en un «job object»): el nieto muere, su salida se
    // cierra y «close» llega sin esperar. El caso de un nieto que sobrevive se prueba abajo
    if (process.platform !== "win32") {
      assert.match(result.output, /^Código de salida: 0 \(había dejado algo en marcha/);
      await noneAlive([ws.pids()[1]]);
    }
  } finally {
    ws.cleanup();
  }
});

// Un nieto «detached» sobrevive a su padre en todos los sistemas, con la salida abierta: «close» no llega nunca por sí solo
test("un nieto que sobrevive con la salida abierta no impide contestar (ha terminado, Esc y tiempo máximo)", async () => {
  const launch = (ws, mode) => spawnGroup(process.execPath, ["padre.cjs", mode], { cwd: ws.root, windowsHide: true });
  let ws = workspace();
  try {
    const start = Date.now();
    const result = await watchChild(launch(ws, "sale-suelto"), { timeoutMs: 60000 });
    assert.ok(Date.now() - start < 6000, `ha tardado ${Date.now() - start} ms`);
    assert.equal(result.lingering, true);
    assert.equal(result.code, 0);
    assert.equal(result.reason, null);
    assert.match(result.output, /en marcha/);
  } finally {
    ws.cleanup();
  }
  ws = workspace();
  try {
    const cancel = new AbortController();
    const pending = watchChild(launch(ws, "suelto"), { timeoutMs: 60000, signal: cancel.signal });
    assert.ok(await ws.started());
    await sleep(200);
    const start = Date.now();
    cancel.abort();
    const result = await pending;
    assert.ok(Date.now() - start < 3000, `ha tardado ${Date.now() - start} ms`);
    assert.equal(result.reason, "abort");
    assert.match(result.output, /en marcha/);
  } finally {
    ws.cleanup();
  }
  ws = workspace();
  try {
    const start = Date.now();
    const result = await watchChild(launch(ws, "suelto"), { timeoutMs: 1000 });
    assert.ok(Date.now() - start < 4000, `ha tardado ${Date.now() - start} ms`);
    assert.equal(result.reason, "timeout");
  } finally {
    ws.cleanup();
  }
});

test("killTree: el que no hace caso a la primera se para a la fuerza, y stopAllProcesses los para todos", { skip: process.platform === "win32" && "en Windows taskkill /F no pregunta" }, async () => {
  const stubborn = spawnGroup(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('listo'); setInterval(() => {}, 1000)"], {});
  await new Promise((resolve) => stubborn.stdout.once("data", resolve));
  const start = Date.now();
  await killTree(stubborn);
  assert.ok(Date.now() - start >= 1500, "no ha esperado antes de forzarlo");
  await noneAlive([stubborn.pid]);
  const many = [1, 2, 3].map(() => spawnGroup(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {}));
  await stopAllProcesses();
  await noneAlive(many.map((child) => child.pid));
});

test("!comando y plantillas: tampoco se quedan colgados", async () => {
  const ws = tempWorkspace();
  const mock = await startMock(() => ({ text: "ok" }));
  writeConfig(mock.url);
  fs.writeFileSync(path.join(ws.proj, "padre.cjs"), PADRE);
  const pid = (name) => Number(fs.readFileSync(path.join(ws.proj, `${name}.pid`), "utf8"));
  try {
    const app = new App(ws.proj);
    const cancel = new AbortController();
    const pending = app.runShell("node padre.cjs suelto", undefined, cancel.signal);
    assert.ok(await until(() => fs.existsSync(path.join(ws.proj, "nieto.pid")) && fs.existsSync(path.join(ws.proj, "padre.pid")), 15000));
    const start = Date.now();
    cancel.abort();
    const result = await pending;
    assert.ok(Date.now() - start < 3000, `ha tardado ${Date.now() - start} ms`);
    assert.match(result.output, /\(interrumpido\)/);
    // Este nieto va por su cuenta a propósito: si se quedara vivo, sería un proceso de prueba huérfano
    const loose = pid("nieto");
    process.kill(loose, "SIGKILL");
    await noneAlive([loose]);
    // La plantilla espera a su comando, que termina y deja algo con su salida abierta
    const begin = Date.now();
    const text = await expandCommand({ name: "x", template: "salida: !`node padre.cjs sale`", description: "", subtask: false, builtIn: false, trusted: true }, "", ws.proj);
    assert.ok(Date.now() - begin < 6000, `ha tardado ${Date.now() - begin} ms`);
    assert.match(text, /salida: en marcha/);
    await app.shutdown();
  } finally {
    try {
      process.kill(pid("nieto"), "SIGKILL");
    } catch {
      // ya no está
    }
    await mock.close();
    ws.cleanup();
  }
});

// El modelo pide el comando al primer mensaje; después, contesta
function commandMock(command) {
  return startMock(({ path: url, body }) => {
    if (!url.endsWith("/chat/completions")) {
      return { json: { data: [] } };
    }
    return lastMessage(body).role === "tool" ? { text: "hecho" } : { tools: [{ name: "bash", args: { command } }] };
  });
}

function startPlain(ws, args = ["--plain", "--yolo"]) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: ws.proj,
    env: { ...systemEnv(ws.home), VIPCODE_HOME: ws.home, NO_COLOR: "1", VIPCODE_BROWSER: "true" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal || code)));
  return { child, exited, output: () => output };
}

async function withCommandRunning(fn) {
  const mock = await commandMock("node padre.cjs");
  const ws = tempWorkspace();
  ws.writeConfig({ providers: [provider("p", mock.url, ["m"])], enabledProviders: ["p"], autoUpdateModels: false, checkUpdates: false, onboarded: true });
  fs.writeFileSync(path.join(ws.proj, "padre.cjs"), PADRE);
  const pid = (name) => Number(fs.readFileSync(path.join(ws.proj, `${name}.pid`), "utf8"));
  const started = () => until(() => {
    try {
      return pid("padre") > 0 && pid("nieto") > 0;
    } catch {
      return false;
    }
  }, 20000);
  try {
    await fn(ws, started, () => [pid("padre"), pid("nieto")]);
  } finally {
    for (const name of ["padre", "nieto"]) {
      try {
        process.kill(pid(name), "SIGKILL");
      } catch {
        // ya no está
      }
    }
    await mock.close();
    ws.cleanup();
  }
}

test("/exit con un comando en marcha: sale, guarda la conversación y no deja huérfanos (modo de texto)", async () => {
  await withCommandRunning(async (ws, started, pids) => {
    const vip = startPlain(ws);
    vip.child.stdin.write("lanza el comando\n");
    assert.ok(await started(), vip.output());
    const start = Date.now();
    vip.child.stdin.write("/exit\n");
    const code = await Promise.race([vip.exited, sleep(8000).then(() => "colgado")]);
    if (code === "colgado") {
      vip.child.kill("SIGKILL");
    }
    assert.equal(code, 0, vip.output());
    assert.ok(Date.now() - start < 6000, `ha tardado ${Date.now() - start} ms`);
    await noneAlive(pids());
    // La conversación se ha guardado
    const saved = fs.readdirSync(path.join(ws.home, "sessions"), { recursive: true }).map(String).filter((name) => name.endsWith(".json"));
    assert.ok(saved.some((name) => fs.readFileSync(path.join(ws.home, "sessions", name), "utf8").includes("lanza el comando")), `sesiones: ${saved}`);
  });
});

test("señales: al parar vipcode con SIGTERM se paran los comandos, en cualquier modo", { skip: process.platform === "win32" && "en Windows una señal mata el proceso sin avisar" }, async () => {
  await withCommandRunning(async (ws, started, pids) => {
    const vip = startPlain(ws);
    vip.child.stdin.write("lanza el comando\n");
    assert.ok(await started(), vip.output());
    vip.child.kill("SIGTERM");
    assert.equal(await vip.exited, "SIGTERM");
    await noneAlive(pids());
  });
});

test("vipcode run: Ctrl+C cancela y dos veces seguidas sale, sin dejar huérfanos", { skip: process.platform === "win32" && "en Windows una señal mata el proceso sin avisar" }, async () => {
  await withCommandRunning(async (ws, started, pids) => {
    const vip = startPlain(ws, ["run", "lanza el comando", "--yolo"]);
    assert.ok(await started(), vip.output());
    const running = pids();
    vip.child.kill("SIGINT");
    vip.child.kill("SIGINT");
    const code = await Promise.race([vip.exited, sleep(8000).then(() => "colgado")]);
    if (code === "colgado") {
      vip.child.kill("SIGKILL");
    }
    assert.notEqual(code, "colgado", vip.output());
    await noneAlive(running);
  });
});

for (const mode of ["exit", "ctrl-c"]) {
  const label = mode === "exit" ? "/exit" : "Ctrl+C dos veces";
  test(`interfaz: ${label} sale con un comando en marcha y no deja huérfanos`, { skip: !hasExpect && "falta el programa expect" }, async () => {
    await withCommandRunning(async (ws, started, pids) => {
      const { ROOT } = await import("./helpers/mock-llm.mjs");
      const child = spawn("expect", [path.join(ROOT, "test", "fixtures", "tui-salir.exp"), CLI, mode], {
        cwd: ws.proj,
        env: { ...systemEnv(ws.home), VIPCODE_HOME: ws.home, TERM: "xterm-256color" },
      });
      const chunks = [];
      child.stdout.on("data", (d) => chunks.push(d));
      child.stderr.on("data", (d) => chunks.push(d));
      const killer = setTimeout(() => child.kill("SIGKILL"), 60000);
      const code = await new Promise((resolve) => child.on("close", resolve));
      clearTimeout(killer);
      const plain = Buffer.concat(chunks).toString("utf8").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
      assert.equal(code, 0, plain.slice(-1500));
      assert.match(plain, /TUI-SALIR-OK/);
      assert.ok(await started());
      await noneAlive(pids());
    });
  });
}

test("subagentes: tienen su propio tiempo máximo y hacen caso a la cancelación del padre", async () => {
  // El subagente pide un comando que no termina; su tiempo máximo lo corta y el principal sigue
  const mock = await startMock(({ path: url, body }) => {
    if (!url.endsWith("/chat/completions")) {
      return { json: { data: [] } };
    }
    const system = contentText(body.messages.find((m) => m.role === "system")?.content);
    if (system.includes("You are a subagent")) {
      return lastMessage(body).role === "tool" ? { text: "fin" } : { tools: [{ name: "bash", args: { command: "node padre.cjs" } }] };
    }
    if (lastMessage(body).role === "tool") {
      return { text: `INFORME: ${contentText(lastMessage(body).content)}` };
    }
    return { tools: [{ name: "task", args: { description: "probar", prompt: "lanza", subagent_type: "general" } }] };
  });
  const ws = tempWorkspace();
  fs.writeFileSync(path.join(ws.proj, "padre.cjs"), PADRE);
  writeConfig(mock.url, { subagentTimeoutMs: 1500 });
  const pids = () => ["padre", "nieto"].map((name) => Number(fs.readFileSync(path.join(ws.proj, `${name}.pid`), "utf8")));
  try {
    let app = new App(ws.proj);
    app.setYolo(true);
    let text = "";
    app.agent.events = { onText: (chunk, depth) => { if (!depth) text += chunk; } };
    let start = Date.now();
    await app.agent.run({ text: "empieza" });
    assert.ok(Date.now() - start < 8000, `ha tardado ${Date.now() - start} ms`);
    assert.match(text, /se le acabó el tiempo/);
    await noneAlive(pids());

    // Un tiempo sin sentido en la configuración no rompe el subagente: se usa el de siempre
    for (const wrong of ["mucho", -1, 1e30]) {
      fs.rmSync(path.join(ws.proj, "padre.pid"), { force: true });
      fs.rmSync(path.join(ws.proj, "nieto.pid"), { force: true });
      writeConfig(mock.url, { subagentTimeoutMs: wrong });
      app = new App(ws.proj);
      app.setYolo(true);
      const cancel = new AbortController();
      const running = app.agent.run({ text: "empieza" }, cancel.signal).catch((err) => err);
      assert.ok(await until(() => fs.existsSync(path.join(ws.proj, "padre.pid")) && fs.existsSync(path.join(ws.proj, "nieto.pid")), 15000), `con ${wrong} no arranca`);
      await sleep(100);
      cancel.abort();
      assert.ok(!((await running) instanceof RangeError), String(wrong));
      await noneAlive(pids());
    }

    // Sin pasarse de tiempo, pero cancelado por el padre
    fs.rmSync(path.join(ws.proj, "padre.pid"));
    fs.rmSync(path.join(ws.proj, "nieto.pid"));
    writeConfig(mock.url, { subagentTimeoutMs: 600000 });
    app = new App(ws.proj);
    app.setYolo(true);
    const cancel = new AbortController();
    const running = app.agent.run({ text: "empieza" }, cancel.signal).catch(() => {});
    assert.ok(await until(() => fs.existsSync(path.join(ws.proj, "padre.pid")) && fs.existsSync(path.join(ws.proj, "nieto.pid")), 15000));
    await sleep(100);
    start = Date.now();
    cancel.abort();
    await running;
    assert.ok(Date.now() - start < 3000, `ha tardado ${Date.now() - start} ms`);
    await noneAlive(pids());
  } finally {
    await mock.close();
    ws.cleanup();
  }
});

test("npm start y ng serve se rechazan con la alternativa, sin preguntar y sin ejecutar nada", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-rechazo-"));
  let asked = 0;
  const ctx = { root, bashTimeoutMs: 5000, readTimes: new Map(), ask: async () => (asked++, { allow: true }) };
  const cases = [
    ["npm start", /npm run build/],
    ["ng serve", /ng build/],
    ["cd frontend && npm start", /npm run build/],
    ["docker compose up", /docker compose up -d/],
    ["mvn spring-boot:run", /mvn package/],
  ];
  for (const [command, alternative] of cases) {
    for (const background of [false, true]) {
      const result = await run(ctx, { command, background });
      assert.equal(result.isError, true, command);
      assert.match(result.output, /^Error: no se ejecuta/, command);
      assert.match(result.output, alternative, command);
      assert.match(result.output, /los arranca el usuario/, command);
    }
  }
  assert.equal(asked, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("la lista de comandos que no terminan: los habituales sí, y lo que se les parece no", () => {
  const endless = [
    "npm start", "npm run start", "npm run dev", "npm run serve", "npm run watch", "npm run test:watch", "npm --prefix web run dev", "npm start --prefix frontend",
    "pnpm dev", "pnpm -F web dev", "yarn start", "yarn workspace web dev", "bun run dev", "ng serve", "ng s --port 4300", "npx ng serve", "ng test",
    "vite", "vite dev", "vite --host", "npx vite", "next dev", "npx next dev", "nuxt dev", "astro dev", "gatsby develop", "webpack serve", "webpack-dev-server",
    "parcel index.html", "nodemon app.js", "./node_modules/.bin/nodemon app.js", "ts-node-dev src/a.ts", "tsx watch src/a.ts", "node --watch a.js",
    "tsc --watch", "tsc -w", "tsc -p . -w", "webpack --watch", "jest --watch", "jest --watchAll", "vitest watch", "cargo watch -x run", "dotnet watch run",
    "docker compose up", "docker-compose up", "docker compose -f x.yml up", "docker compose up --build", "tail -f app.log", "tail -F app.log", "tail -n 5 -f app.log",
    "python -m http.server", "python3 -m http.server 8000", "python manage.py runserver", "flask run", "uvicorn main:app", "php -S localhost:8000", "php artisan serve",
    "rails server", "rails s", "mvn spring-boot:run", "./mvnw spring-boot:run", "mvn -q quarkus:dev", "gradle bootRun", "./gradlew bootRun", "docker logs -f web",
    "kubectl logs -f web", "journalctl -f", "Get-Content app.log -Wait", "ping -t 1.1.1.1", "watch ls", "PORT=3000 npm start", "NODE_ENV=dev npx nodemon a.js",
    "cd web && npm run dev", "cd web; npm start", "npm install && npm start", "npm start &", "(cd web && npm start)", "bash -c 'npm start'", "cmd /c npm start", "nohup npm start",
    "npm start 2>&1", "npm start > salida.log 2>&1 &", "npm.cmd start", "ng.cmd serve", "C:/tools/ng.exe serve",
  ];
  for (const command of endless) {
    assert.ok(findLongRunning(command), `debería rechazarse: ${command}`);
  }
  const normal = [
    "npm run build", "npm run build:dev", "npm run server:build", "npm test", "npm install", "npm install serve", "npm ci", "npm run lint", "npm run start-db:migrate:build", "yarn build",
    "pnpm test", "ng build", "ng version", "ng test --watch=false", "ng test --no-watch", "vite build", "vite --version", "next build", "tsc", "tsc -p tsconfig.json", "webpack", "jest", "jest -w 4",
    "jest --watchAll=false", "vitest run", "parcel build index.html", "docker compose up -d", "docker compose up --detach", "docker compose up -d --build", "docker-compose up -d", "docker compose build",
    "docker logs web", "tail app.log", "tail -n 50 app.log", "mvn package", "mvn test", "gradle build", "cargo build", "dotnet build", "python -m pytest", "python main.py", "php -l a.php", "git status",
    "git log --oneline", "ls -la", "echo hola", "echo npm start", "echo ng serve && git status", 'grep "npm start" README.md', 'git commit -m "--watch añadido"', 'grep -- "--watch" a.txt', "cat vite.config.ts",
    "node a.js", "node --version", "timeout 5 npm start", "mkdir -p a", "npm --version", "ng serve --help", 'git commit -m "arregla; npm start"', 'echo "a && ng serve"', "npm run build 2>&1", "npm test > salida.txt 2>&1",
  ];
  for (const command of normal) {
    assert.equal(findLongRunning(command), null, `no debería rechazarse: ${command}`);
  }
});

test("los comandos normales siguen funcionando igual", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-normales-"));
  const ctx = { root, bashTimeoutMs: 60000, readTimes: new Map(), ask: async () => ({ allow: true }) };
  try {
    let result = await run(ctx, { command: "echo hola" });
    assert.equal(result.output, "Código de salida: 0\nhola");
    spawnSync("git", ["init", "-q"], { cwd: root });
    result = await run(ctx, { command: "git status" });
    assert.match(result.output, /^Código de salida: 0\n/);
    assert.match(result.output, /No commits yet|Aún no hay commits|On branch|En la rama/);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", scripts: { build: "node -e \"console.log('compilado')\"" } }));
    result = await run(ctx, { command: "npm run build" });
    assert.match(result.output, /^Código de salida: 0\n/);
    assert.match(result.output, /compilado/);
    result = await run(ctx, { command: "node -e \"process.exit(3)\"" });
    assert.match(result.output, /^Código de salida: 3/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("red final: un servidor que no reconoce la lista se corta si se queda callado tras decir que está listo", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-listo-"));
  const ctx = { root, bashTimeoutMs: 20000, readTimes: new Map(), ask: async () => ({ allow: true }) };
  process.env.VIPCODE_SERVER_IDLE_MS = "800";
  try {
    fs.writeFileSync(path.join(root, "raro.cjs"), `require("fs").writeFileSync("raro.pid", String(process.pid)); console.log("  ➜  Local:   http://localhost:4200/"); setInterval(() => {}, 1000);`);
    const start = Date.now();
    let result = await run(ctx, { command: "node raro.cjs && echo fin" });
    assert.ok(Date.now() - start < 10000, `ha tardado ${Date.now() - start} ms`);
    assert.match(result.output, /^Cortado: llevaba 0\.8 s sin escribir nada/);
    assert.match(result.output, /Local: {3}http:\/\/localhost:4200/);
    await noneAlive([Number(fs.readFileSync(path.join(root, "raro.pid"), "utf8"))]);
    // Callado, pero sin pinta de servidor: se le deja terminar
    fs.writeFileSync(path.join(root, "lento.cjs"), `console.log("calculando"); setTimeout(() => console.log("listo el cálculo"), 2500);`);
    result = await run(ctx, { command: "node lento.cjs" });
    assert.match(result.output, /^Código de salida: 0\n/);
    assert.match(result.output, /listo el cálculo/);
  } finally {
    delete process.env.VIPCODE_SERVER_IDLE_MS;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  for (const line of ["Watching for file changes.", "  Local: http://localhost:5173/", "Server listening on port 80", "listening on 0.0.0.0:8000", "Started Application in 3.2 seconds", "Started", "\x1b[32mcompiled successfully\x1b[0m"]) {
    assert.ok(looksLikeServer(`algo\n${line}\n`), line);
  }
  for (const line of ["Tests: 12 passed", "Compilando…", "started the migration of 3 tables", "Downloading http://example.com/a.tgz"]) {
    assert.ok(!looksLikeServer(`algo\n${line}\n`), line);
  }
});

test("el system prompt lleva la regla, con sus palabras", () => {
  const agent = { name: "programar", description: "", mode: "primary", prompt: "", tools: {}, readOnly: false };
  const prompt = systemPrompt(os.tmpdir(), { agent, toolNames: ["bash", "write_file"], instructions: [] });
  assert.ok(prompt.includes("Nunca ejecutes servidores de desarrollo ni comandos en modo watch; para comprobar que compila usa el build. No crees carpetas con mkdir: write_file ya crea las carpetas padre. Usa siempre rutas relativas con /."));
});
