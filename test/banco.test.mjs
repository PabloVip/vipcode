import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ROOT, contentText, provider, startMock, systemEnv, tempWorkspace } from "./helpers/mock-llm.mjs";

const SCRIPT = path.join(ROOT, "scripts", "banco-tareas.mjs");
const banco = await import("../scripts/banco-tareas.mjs");
const noSandbox = banco.canSandbox() ? false : "en este Node no funciona --permission";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-banco-prueba-"));
const remove = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

test("banco: cada tarea está mal planteada si de partida ya está bien o su solución no vale", { skip: noSandbox }, () => {
  assert.ok(banco.TASKS.length >= 13);
  assert.equal(new Set(banco.TASKS.map((task) => task.id)).size, banco.TASKS.length);
  for (const task of banco.TASKS) {
    const dir = tempDir();
    try {
      banco.writeTask(task, dir);
      assert.notEqual(banco.verifyTask(task, dir, "He mirado el proyecto."), null, `${task.id}: de partida no debería estar bien`);
      task.solve(dir);
      assert.equal(banco.verifyTask(task, dir, task.answer || ""), null, `${task.id}: la solución de referencia debería valer`);
    } finally {
      remove(dir);
    }
  }
});

test("banco: las pruebas originales se restauran y el código del modelo está aislado", { skip: noSandbox }, () => {
  const task = banco.TASKS.find((item) => item.id === "arregla-calculos");
  const dir = tempDir();
  const outside = tempDir();
  const secret = path.join(outside, "secreto.txt");
  fs.writeFileSync(secret, "clave");
  try {
    banco.writeTask(task, dir);
    // Si el modelo vacía las pruebas o hace que el programa salga bien antes de tiempo, no cuenta
    fs.writeFileSync(path.join(dir, "pruebas.mjs"), 'console.log("PRUEBAS-OK");');
    assert.match(banco.verifyTask(task, dir), /no pasan las pruebas/);
    fs.writeFileSync(path.join(dir, "calculos.mjs"), "process.exit(0);\nexport const suma = 1, media = 1, maximo = 1;\n");
    assert.match(banco.verifyTask(task, dir), /no pasan las pruebas/);

    // Lo que intente el código del modelo mientras se comprueba: leer fuera, escribir, lanzar programas
    const marker = path.join(dir, "escrito.txt");
    fs.writeFileSync(
      path.join(dir, "calculos.mjs"),
      `import fs from "node:fs";
import cp from "node:child_process";
const results = [];
for (const attempt of [() => fs.readFileSync(${JSON.stringify(secret)}, "utf8"), () => fs.writeFileSync(${JSON.stringify(marker)}, "x"), () => cp.execSync("echo hola")]) {
  try {
    attempt();
    results.push("permitido");
  } catch (err) {
    results.push(err.code);
  }
}
console.error("INTENTOS " + results.join(" "));
export const suma = () => 0, media = () => 0, maximo = () => 0;
`,
    );
    const run = spawnSync(process.execPath, ["--permission", "--allow-fs-read=.", "calculos.mjs"], { cwd: dir, encoding: "utf8", env: systemEnv(dir) });
    assert.match(run.stderr, /INTENTOS ERR_ACCESS_DENIED ERR_ACCESS_DENIED ERR_ACCESS_DENIED/);
    assert.match(banco.verifyTask(task, dir), /no pasan las pruebas/);
    assert.ok(!fs.existsSync(marker));
  } finally {
    remove(dir);
    remove(outside);
  }
});

test("banco: las cuentas, el informe y la comparación", () => {
  const run = (id, ok, extra = {}) => ({ id, ok, problem: ok ? null : "falla", noModels: false, falseClaim: false, ranTests: true, models: ["a/m"], steps: 3, switches: 1, stuck: 0, stopped: 0, unchecked: 1, tokens: 100, seconds: 10, ...extra });
  assert.ok(banco.claimsDone("Hecho: ya funciona."));
  assert.ok(banco.claimsDone("Done, the bug is fixed."));
  assert.ok(!banco.claimsDone("No he podido arreglarlo: sigue fallando."));
  assert.ok(!banco.claimsDone("Está hecho, pero sin probar."));
  assert.ok(!banco.claimsDone("He mirado el fichero."));

  const before = { date: "2026-11-02T10:00:00Z", version: "1", runs: [run("a", true), run("b", false, { falseClaim: true }), run("c", false, { noModels: true })] };
  const after = { date: "2026-11-03T10:00:00Z", version: "1", runs: [run("a", true), run("b", true), run("c", true)] };
  const summary = banco.summarize(before.runs);
  assert.equal(summary.runs, 2, "las que no tenían modelos no cuentan");
  assert.equal(summary.noModels, 1);
  assert.equal(summary.solved, 1);
  assert.equal(summary.falseClaims, 1);
  const report = banco.renderReport(before);
  assert.match(report, /Resueltas: 1 de 2 \(50 %\)/);
  assert.match(report, /✗ \(dijo que sí\)/);
  assert.match(report, /sin modelos/);
  assert.match(report, /\*\*b\*\*: falla/);
  const compared = banco.compareResults(before, after);
  assert.match(compared, /Resueltas \| 1 de 2 \(50 %\) \| 3 de 3 \(100 %\)/);
  assert.match(compared, /- b: 0\/1 → 1\/1/);
  assert.match(compared, /pueden ser casualidad/);
});

// El script de verdad, de principio a fin, con una IA de mentira y sus datos en una carpeta temporal
async function runBench(handler, args) {
  const mock = await startMock(handler);
  const ws = tempWorkspace();
  const out = path.join(ws.dir, "resultado.json");
  const config = { providers: [provider("p", mock.url, ["m"])], enabledProviders: ["p"], autoUpdateModels: false };
  // Sin red de verdad: la configuración solo tiene el proveedor de mentira
  const result = await new Promise((resolve) => {
    const proc = spawn(process.execPath, [SCRIPT, ...args, "--out", out, "--config", JSON.stringify(config)], { env: { ...systemEnv(ws.home), MI_CLAVE_SECRETA: "no-deberia-llegar" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => (stdout += data));
    proc.stderr.on("data", (data) => (stderr += data));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const saved = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
  await mock.close();
  ws.cleanup();
  return { ...result, saved, requests: mock.chats() };
}

test("banco: de principio a fin, resuelve, ejecuta solo lo permitido y pilla al que dice que está hecho sin estarlo", { skip: noSandbox }, async () => {
  const fixed = `export function suma(lista) { return lista.reduce((a, b) => a + b, 0); }
export function media(lista) { return lista.length ? suma(lista) / lista.length : 0; }
export function maximo(lista) { return Math.max(...lista); }
`;
  // Un modelo que lo arregla, intenta ejecutar lo que no puede, ejecuta las pruebas y dice que está hecho
  let results = [];
  let bench = await runBench(({ body }) => {
    const told = body.messages.filter((message) => message.role === "tool").length;
    if (told === 0) {
      return { tools: [{ name: "read_file", args: { path: "calculos.mjs" } }] };
    }
    if (told === 1) {
      return { tools: [{ name: "write_file", args: { path: "calculos.mjs", content: fixed } }] };
    }
    if (told === 2) {
      return { tools: [{ name: "bash", args: { command: "env; cat /etc/passwd" } }] };
    }
    if (told === 3) {
      return { tools: [{ name: "bash", args: { command: "node --permission --allow-fs-read=. pruebas.mjs" } }] };
    }
    results = body.messages.filter((message) => message.role === "tool").map((message) => contentText(message.content));
    return { text: "Hecho: ya funciona." };
  }, ["--tareas", "arregla-calculos"]);
  assert.equal(bench.code, 0, bench.stderr);
  assert.equal(bench.saved.runs[0].ok, true, JSON.stringify(bench.saved.runs[0]));
  assert.equal(bench.saved.runs[0].ranTests, true);
  assert.match(bench.stdout, /Resueltas: 1 de 1 \(100 %\)/);
  // El comando que no está permitido no se ha ejecutado; el de las pruebas, sí
  assert.match(results[2], /ha rechazado/);
  assert.match(results[3], /Código de salida: 0[\s\S]*PRUEBAS-OK/);
  assert.ok(!results.join("\n").includes("no-deberia-llegar"));

  // Un modelo que no hace nada y dice que está hecho
  bench = await runBench(() => ({ text: "Hecho: ya está arreglado." }), ["--tareas", "arregla-calculos"]);
  assert.equal(bench.saved.runs[0].ok, false);
  assert.equal(bench.saved.runs[0].falseClaim, true);
  assert.match(bench.stdout, /dijo que estaba hecho sin estarlo: 1/);

  // Un modelo que escribe un programa para llevarse tu entorno y lo ejecuta con el comando permitido: no tiene nada que llevarse
  let leaked = "";
  bench = await runBench(({ body }) => {
    const tool = body.messages.filter((message) => message.role === "tool");
    if (tool.length === 0) {
      return { tools: [{ name: "read_file", args: { path: "pruebas.mjs" } }] };
    }
    if (tool.length === 1) {
      return { tools: [{ name: "write_file", args: { path: "pruebas.mjs", content: "console.log(JSON.stringify(process.env));" } }] };
    }
    if (tool.length === 2) {
      return { tools: [{ name: "bash", args: { command: "node --permission --allow-fs-read=. pruebas.mjs" } }] };
    }
    leaked = contentText(tool[2].content);
    return { text: "No he podido." };
  }, ["--tareas", "arregla-calculos"]);
  assert.match(leaked, /Código de salida: 0/);
  assert.ok(!leaked.includes("no-deberia-llegar"), "el entorno lleva cosas que no hacen falta");
  assert.equal(bench.saved.runs[0].ok, false);
  assert.equal(bench.saved.runs[0].falseClaim, false);

  // Sin modelos que contesten no cuenta como mal
  bench = await runBench(() => ({ status: 401, json: { error: { message: "sin permiso" } } }), ["--tareas", "no-existe"]);
  assert.equal(bench.saved.runs[0].noModels, true, JSON.stringify(bench.saved.runs[0]));
  assert.match(bench.stdout, /Resueltas: 0 de 0/);
});

test("banco: --modelos prueba cada modelo sin pasar a otros y da una tabla por modelo", { skip: noSandbox }, async () => {
  const mock = await startMock(({ path: url }) => (url.startsWith("/bueno/") ? { text: "pagos.mjs no existe." } : { text: "Hecho: arreglado." }));
  const ws = tempWorkspace();
  const out = path.join(ws.dir, "resultado.json");
  const config = { providers: [provider("bueno", mock.url, ["m"]), provider("malo", mock.url, ["m"]), provider("otro", mock.url, ["m"])], enabledProviders: ["bueno", "malo", "otro"], autoUpdateModels: false };
  const result = await new Promise((resolve) => {
    const proc = spawn(process.execPath, [SCRIPT, "--tareas", "no-existe", "--modelos", "bueno/m,malo/m", "--out", out, "--config", JSON.stringify(config)], { env: systemEnv(ws.home), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout.on("data", (data) => (stdout += data));
    proc.on("close", (code) => resolve({ code, stdout }));
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /## Por modelo/);
  assert.match(result.stdout, /\| bueno\/m \| 1 de 1 \(100 %\) \| 0 \|/);
  assert.match(result.stdout, /\| malo\/m \| 0 de 1 \(0 %\) \| 1 \|/);
  assert.ok(!mock.chats().some((chat) => chat.path.startsWith("/otro/")));
  await mock.close();
  ws.cleanup();
});

test("banco: --lista y --comparar no ejecutan nada, y una tarea que no existe se dice", () => {
  const list = spawnSync(process.execPath, [SCRIPT, "--lista"], { encoding: "utf8" });
  assert.match(list.stdout, /arregla-calculos/);
  assert.match(list.stdout, /no-existe/);
  const dir = tempDir();
  const run = { id: "a", ok: true, problem: null, noModels: false, falseClaim: false, ranTests: true, models: [], steps: 1, switches: 0, stuck: 0, stopped: 0, unchecked: 0, tokens: 1, seconds: 1 };
  const file = path.join(dir, "r.json");
  fs.writeFileSync(file, JSON.stringify({ date: "x", version: "1", runs: [run] }));
  const compared = spawnSync(process.execPath, [SCRIPT, "--comparar", file, file], { encoding: "utf8" });
  assert.match(compared.stdout, /Resueltas \| 1 de 1 \(100 %\) \| 1 de 1 \(100 %\)/);
  remove(dir);
});
