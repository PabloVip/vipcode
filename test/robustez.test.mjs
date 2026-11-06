import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Carpeta de datos temporal para no tocar ~/.vipcode
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-robustez-"));
process.env.VIPCODE_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const tools = await import("../dist/tools.js");
const shell = await import("../dist/shell.js");
const permissions = await import("../dist/permissions.js");
const { announcesAction } = await import("../dist/agent.js");
const { supersededReads, SUPERSEDED_MARK } = await import("../dist/context.js");
const { withHandoff } = await import("../dist/router.js");
const { systemPrompt } = await import("../dist/prompt.js");

const run = async (ctx, name, args) => tools.runTool(tools.CORE_TOOLS, name, JSON.stringify(args), ctx, false);
const newCtx = (root) => ({ root, bashTimeoutMs: 5000, readTimes: new Map(), ask: async () => ({ allow: true }) });

test("grep: busca solo dentro de path (carpeta o fichero) y devuelve rutas desde la raíz", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-grep-path-"));
  fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
  fs.mkdirSync(path.join(root, "otra"));
  fs.writeFileSync(path.join(root, "a", "b", "uno.ts"), "const createdAt = 1;\n");
  fs.writeFileSync(path.join(root, "otra", "dos.ts"), "const createdAt = 2;\n");
  const ctx = newCtx(root);
  for (const rg of ["1", "0"]) {
    process.env.VIPCODE_RIPGREP = rg;
    let result = await run(ctx, "grep", { pattern: "createdAt", path: "a" });
    assert.match(result.output, /^a\/b\/uno\.ts:1: const createdAt = 1;$/m);
    assert.ok(!result.output.includes("otra/dos.ts"), result.output);
    result = await run(ctx, "grep", { pattern: "createdAt", path: "otra/dos.ts" });
    assert.equal(result.output, "otra/dos.ts:1: const createdAt = 2;");
    result = await run(ctx, "grep", { pattern: "createdAt", path: "no-existe" });
    assert.match(result.output, /no existe/);
    result = await run(ctx, "grep", { pattern: "createdAt", path: "../" });
    assert.match(result.output, /fuera del proyecto/);
  }
  delete process.env.VIPCODE_RIPGREP;
  fs.rmSync(root, { recursive: true, force: true });
});

test("grep y glob: una carpeta sin permiso se salta en vez de tumbar la búsqueda", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-eperm-"));
  fs.mkdirSync(path.join(root, "cerrada"));
  fs.writeFileSync(path.join(root, "cerrada", "x.txt"), "aguja\n");
  fs.writeFileSync(path.join(root, "abierta.txt"), "aguja\n");
  fs.chmodSync(path.join(root, "cerrada"), 0o000);
  const ctx = newCtx(root);
  try {
    process.env.VIPCODE_RIPGREP = "0";
    const grep = await run(ctx, "grep", { pattern: "aguja" });
    assert.equal(grep.output, "abierta.txt:1: aguja");
    const glob = await run(ctx, "glob", { pattern: "**/*.txt" });
    assert.equal(glob.output, "abierta.txt");
  } finally {
    delete process.env.VIPCODE_RIPGREP;
    fs.chmodSync(path.join(root, "cerrada"), 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("edit_file: números de línea copiados, cambio ya aplicado, lo más parecido y sin haber leído", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-edit2-"));
  const file = path.join(root, "main.go");
  fs.writeFileSync(file, 'package main\n\nimport (\n\t"fmt"\n\t"github.com/x/pb"\n)\n\nfunc main() {\n\tfmt.Println(pb.Hola)\n}\n');
  const ctx = newCtx(root);

  // Sin haberlo leído: el error trae el contenido y ya cuenta como leído
  let result = await run(ctx, "edit_file", { path: "main.go", old_string: "pb.Hola", new_string: "pb.Adios" });
  assert.ok(result.isError);
  assert.match(result.output, /lee main\.go con read_file/);
  assert.match(result.output, /9\t\tfmt\.Println\(pb\.Hola\)/);
  result = await run(ctx, "edit_file", { path: "main.go", old_string: "pb.Hola", new_string: "pb.Adios" });
  assert.ok(!result.isError, result.output);
  assert.deepEqual(result.stats, { added: 1, removed: 1 });

  // old_string copiado de read_file con el número y el tabulador delante
  result = await run(ctx, "edit_file", { path: "main.go", old_string: '4\t\t"fmt"\n5\t\t"github.com/x/pb"', new_string: '4\t\t"fmt"\n5\t\t"github.com/x/shared/pb"' });
  assert.ok(!result.isError, result.output);
  assert.match(result.output, /números de línea/);
  assert.match(fs.readFileSync(file, "utf8"), /\t"github\.com\/x\/shared\/pb"\n/);

  // Repetir un cambio ya hecho no es un error: se le dice que ya está
  result = await run(ctx, "edit_file", { path: "main.go", old_string: '"github.com/x/pb"', new_string: '"github.com/x/shared/pb"' });
  assert.ok(!result.isError, result.output);
  assert.match(result.output, /ya aparece en la línea 5/);
  result = await run(ctx, "edit_file", { path: "main.go", old_string: "pb.Adios", new_string: "pb.Adios" });
  assert.ok(!result.isError, result.output);
  assert.match(result.output, /ya está en el fichero/);

  // No aparece: se le enseña lo más parecido con sus números de línea
  result = await run(ctx, "edit_file", { path: "main.go", old_string: "fmt.Printf(pb.Adios)", new_string: "fmt.Println(1)" });
  assert.ok(result.isError);
  assert.match(result.output, /Lo más parecido está en la línea 9/);
  assert.match(result.output, /9\t\tfmt\.Println\(pb\.Adios\)/);
  result = await run(ctx, "edit_file", { path: "main.go", old_string: "zzzz qqqq wwww", new_string: "x" });
  assert.match(result.output, /Ningún trozo del fichero se le parece/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("write_file: la cuenta de líneas es la de verdad aunque el diff se enseñe recortado", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-stats-"));
  const ctx = newCtx(root);
  const content = Array.from({ length: 104 }, (_, i) => `linea ${i}`).join("\n") + "\n";
  let result = await run(ctx, "write_file", { path: "README.md", content });
  assert.deepEqual(result.stats, { added: 104, removed: 0 });
  assert.match(result.display, /\[… 64 líneas más\]/);
  await run(ctx, "read_file", { path: "README.md" });
  result = await run(ctx, "write_file", { path: "README.md", content: content.replace("linea 3\n", "") });
  assert.deepEqual(result.stats, { added: 0, removed: 1 });
  fs.rmSync(root, { recursive: true, force: true });
});

test("bash: workdir, la etiqueta de un comando de varias líneas y el CLIXML de PowerShell", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-workdir-"));
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "hola.txt"), "hola");
  const ctx = newCtx(root);
  if (process.platform !== "win32") {
    let result = await run(ctx, "bash", { command: "cat hola.txt", workdir: "sub" });
    assert.equal(result.output, "Código de salida: 0\nhola");
    result = await run(ctx, "bash", { command: "ls", workdir: "../" });
    assert.match(result.output, /fuera del proyecto/);
    result = await run(ctx, "bash", { command: "ls", workdir: "nada" });
    assert.match(result.output, /no existe/);
  }
  assert.equal(tools.describeCall("bash", JSON.stringify({ command: "python - <<'EOF'\nimport yaml\nEOF", path: "RutaVital-Pro" })), "python - <<'EOF' …");
  assert.equal(tools.describeCall("bash", JSON.stringify({ command: "npm test", workdir: "web" })), "(web) npm test");

  const clixml =
    '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">_x001B_[31;1mdocker : El término &apos;docker&apos; no se reconoce_x000D__x000A_</S><S S="Error">En línea: 1_x000D__x000A_</S></Objs>';
  assert.equal(shell.decodeClixml(`antes\n${clixml}`), "antes\ndocker : El término 'docker' no se reconoce\nEn línea: 1\n");
  assert.equal(shell.decodeClixml("sin nada raro"), "sin nada raro");
  fs.rmSync(root, { recursive: true, force: true });
});

test("PowerShell: sintaxis comprobada antes de ejecutar, en UTF-8, sin CLIXML y con el código de salida de siempre", async (t) => {
  const ps = shell.detectShell({ PATH: "", VIPCODE_SHELL: "powershell.exe" }, "win32");
  assert.equal(ps.flavor, "windows");
  assert.ok(ps.args("dir").includes("-OutputFormat"));
  assert.equal(shell.detectShell({ PATH: "", VIPCODE_SHELL: "pwsh" }, "win32").flavor, "core");
  const script = shell.powershellScript("Write-Output 'hola ñ'");
  assert.ok(script.includes("$vipcodeSource = 'Write-Output ''hola ñ'''"), script);
  // PowerShell también cierra una cadena con las comillas tipográficas: si no se doblan, el comando se saldría de ella
  assert.ok(shell.powershellScript("a\u2018b\u2019c\u201ad\u201be").includes("'a\u2018\u2018b\u2019\u2019c\u201a\u201ad\u201b\u201be'"));
  // Windows no admite líneas de comandos de más de 32.767 caracteres: tiene que caber un comando largo
  assert.ok(ps.args("a".repeat(10000)).join(" ").length < 32000);

  // Con un PowerShell de verdad (pwsh o VIPCODE_TEST_PWSH), si lo hay
  const pwsh = process.env.VIPCODE_TEST_PWSH || shell.findProgram(process.platform === "win32" ? "powershell.exe" : "pwsh");
  if (!pwsh) {
    t.diagnostic("sin PowerShell: solo se comprueba el script");
    return;
  }
  const real = shell.detectShell({ PATH: process.env.PATH, VIPCODE_SHELL: pwsh }, process.platform);
  const exec = (command) => {
    const r = spawnSync(real.file, real.args(command), { encoding: "utf8" });
    // Windows PowerShell 5.1 manda los errores en CLIXML aun con -OutputFormat Text: bash los decodifica, y esto también
    return { code: r.status, out: shell.decodeClixml(`${r.stdout}${r.stderr}`) };
  };
  let r = exec("Write-Output 'hola ñ'; exit 4");
  assert.equal(r.code, 4);
  assert.equal(r.out.trim(), "hola ñ");
  r = exec("Get-Item ./no-existe-nunca");
  assert.equal(r.code, 1);
  assert.ok(!r.out.includes("CLIXML"), r.out);
  assert.match(r.out, /no-existe-nunca/);
  r = exec("Get-Item ./no-existe-nunca; Write-Output sigue");
  assert.equal(r.code, 0);
  r = exec("$x = 2\nfunction doble { $x * 2 }\nWrite-Output (doble)");
  assert.equal(r.out.trim(), "4");
  r = exec("Write-Output 'it''s'; Write-Output \"a\u2019b\"");
  assert.equal(r.out.trim().replace(/\r/g, ""), "it's\na\u2019b");
  r = exec(`Write-Output '${"a".repeat(10000)}'`);
  assert.equal(r.out.trim().length, 10000);
  // En la 5.1 no hay && ni ||: error en claro y con la pista. En la 7 funcionan
  r = exec("echo a && echo b");
  if (real.flavor === "windows") {
    assert.equal(r.code, 1);
    assert.match(r.out, /Error de sintaxis de PowerShell \(línea 1\)/);
    assert.match(r.out, /Pista: esto es Windows PowerShell 5\.1/);
    assert.ok(!r.out.includes("CLIXML"), r.out);
  } else {
    assert.equal(r.out.trim().replace(/\r/g, ""), "a\nb");
  }
  r = exec("if (");
  assert.equal(r.code, 1);
  assert.match(r.out, /Error de sintaxis de PowerShell \(línea 1\)/);
});

test("agente: detecta cuando termina anunciando algo sin hacerlo", () => {
  assert.equal(announcesAction("El problema: los go.mod tienen placeholders. Voy a crear un módulo compartido local."), true);
  assert.equal(announcesAction("Ahora creo los servicios críticos restantes."), true);
  assert.equal(announcesAction("Let me fix the imports."), true);
  assert.equal(announcesAction("He arreglado los imports y los tests pasan."), false);
  assert.equal(announcesAction("¿Quieres que lo despliegue?"), false);
  assert.equal(announcesAction("Si quieres, voy a añadir los tests después."), false);
  assert.equal(announcesAction("Voy a necesitar que instales Docker: ¿lo tienes?"), false);
  assert.equal(announcesAction(""), false);
});

test("contexto: las lecturas viejas de un fichero que se volvió a leer no se mandan otra vez", () => {
  const big = "x".repeat(2000);
  const call = (id, args) => ({ id, type: "function", function: { name: "read_file", arguments: JSON.stringify(args) } });
  const messages = [
    { role: "user", content: "arregla" },
    { role: "assistant", content: null, tool_calls: [call("a", { path: "src/d.go" })] },
    { role: "tool", tool_call_id: "a", content: big },
    { role: "assistant", content: null, tool_calls: [call("b", { path: "src/d.go", offset: 10 })] },
    { role: "tool", tool_call_id: "b", content: big },
    { role: "assistant", content: null, tool_calls: [call("c", { path: "./src/d.go" })] },
    { role: "tool", tool_call_id: "c", content: big },
  ];
  const result = supersededReads(messages);
  assert.equal(result.length, messages.length);
  assert.ok(result[2].content.startsWith(SUPERSEDED_MARK));
  // La parcial y la última se quedan; el original no se toca
  assert.equal(result[4].content, big);
  assert.equal(result[6].content, big);
  assert.equal(messages[2].content, big);
  // Sin relecturas no cambia nada (y devuelve la misma lista)
  const once = messages.slice(0, 3);
  assert.equal(supersededReads(once), once);
});

test("bash: si se acaba el tiempo, explica que los servidores los arranca el usuario", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-bash-tiempo-"));
  fs.writeFileSync(path.join(root, "espera.cjs"), "setInterval(() => {}, 1000);");
  const result = await run(newCtx(root), "bash", { command: "node espera.cjs", timeout_ms: 500 });
  assert.match(result.output, /Cortado por tiempo tras 0\.5 s.*lo tiene que arrancar el usuario/);
  // Cortar por tiempo no espera a que el proceso muera (en Windows, a uno recién lanzado se le para pasado 1,5 s): la carpeta
  // se borra sin bloquear, para que mientras tanto vipcode pueda pararlo
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
});

test("relevo y prompt: nota para el modelo que coge la tarea, comandos de vipcode, honestidad y la shell de Windows", async () => {
  const handed = withHandoff([{ role: "system", content: "base" }, { role: "user", content: "hola" }], "Ficheros: a.go");
  assert.match(handed[0].content, /^base\n\n# Relevo\n/);
  assert.match(handed[0].content, /Ficheros: a\.go/);
  assert.equal(handed[1].content, "hola");
  assert.equal(withHandoff([{ role: "user", content: "hola" }], "x")[0].role, "system");

  const { BUILTIN_COMMANDS } = await import("../dist/builtin-commands.js");
  const main = { name: "programar", description: "", mode: "primary", prompt: "", tools: {}, readOnly: false };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-prompt-"));
  const prompt = systemPrompt(root, { agent: main, toolNames: ["bash", "edit_file", "task", "todowrite"], instructions: [], agentNames: ["programar", "ayudante"] });
  assert.match(prompt, /never search the disk/);
  assert.match(prompt, new RegExp(`/${BUILTIN_COMMANDS[0].name}`));
  assert.match(prompt, /Never invent checksums/);
  assert.match(prompt, /workdir/);
  assert.match(prompt, /announcing what you are about to do/);
  const sub = systemPrompt(root, { agent: main, toolNames: ["bash"], instructions: [], subagent: true });
  assert.ok(!sub.includes("About yourself"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("seguridad: un fichero del proyecto no puede colarle opciones a rg con el path de grep", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-grep-opcion-"));
  const marker = path.join(root, "ejecutado.txt");
  fs.writeFileSync(path.join(root, "--pre=sh"), "hola\n");
  fs.writeFileSync(path.join(root, "carga.txt"), `echo si > "${marker}"\n`);
  for (const rg of ["1", "0"]) {
    process.env.VIPCODE_RIPGREP = rg;
    const result = await run(newCtx(root), "grep", { pattern: "hola", path: "--pre=sh" });
    assert.equal(result.output, "--pre=sh:1: hola");
    assert.ok(!fs.existsSync(marker), "rg ha ejecutado un programa elegido por un nombre de fichero");
  }
  delete process.env.VIPCODE_RIPGREP;
  fs.rmSync(root, { recursive: true, force: true });
});

test("seguridad: lo aprobado para una carpeta no vale en otra con workdir, y .git queda fuera", async () => {
  const grants = new permissions.SessionGrants();
  grants.allowPattern("bash", "npm test*");
  const asked = [];
  const rules = { "*": "ask", ls: "allow", "rm *": "deny" };
  const ask = permissions.createAsker(() => ({ bash: rules }), grants, async (request) => {
    asked.push(request.subject);
    return { allow: false };
  });
  const bash = (subject, workdir) => ask({ kind: "bash", title: "", preview: "", subject, workdir });

  assert.ok((await bash("npm test")).allow);
  assert.ok((await bash("ls")).allow);
  assert.equal(asked.length, 0);
  // En otra carpeta el mismo comando es otro programa: se pregunta, venga de un «sí siempre» o de una regla allow
  assert.ok(!(await bash("npm test", "otra")).allow);
  assert.ok(!(await bash("ls", "otra")).allow);
  assert.deepEqual(asked, ["npm test", "ls"]);
  // «Sí siempre» dado en esa carpeta vale en esa y no en las demás ni en la raíz
  const scoped = new permissions.SessionGrants();
  scoped.allowPattern("bash", "make*", "web");
  assert.ok(scoped.allows("bash", "make all", "web"));
  assert.ok(!scoped.allows("bash", "make all", "otra"));
  assert.ok(!scoped.allows("bash", "make all"));
  // deny manda igual, y «sí a todo» sigue valiendo para todo
  assert.match((await bash("rm -rf x", "otra")).feedback, /deny/);
  grants.allowKind("bash");
  assert.ok((await bash("npm test", "otra")).allow);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-workdir-permiso-"));
  fs.mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, "sub"));
  const requests = [];
  const ctx = { ...newCtx(root), ask: async (request) => (requests.push(request), { allow: false }) };
  await run(ctx, "bash", { command: "pwd", workdir: "./sub/" });
  assert.equal(requests[0].workdir, "sub");
  assert.equal(requests[0].subject, "pwd");
  assert.match(requests[0].preview, /\(en sub\)/);
  await run(ctx, "bash", { command: "pwd", workdir: "sub/.." });
  assert.equal(requests[1].workdir, undefined);
  requests.length = 0;
  if (process.platform !== "win32") {
    fs.symlinkSync(".git", path.join(root, "enlace"));
  }
  // .GIT solo existe si el disco no distingue mayúsculas (Windows y macOS)
  const inGit = [".git", ".git/hooks", ".GIT/hooks", "enlace/hooks"].filter((workdir) => fs.existsSync(path.join(root, workdir)));
  for (const workdir of inGit) {
    const result = await run(ctx, "bash", { command: "echo x > pre-commit", workdir });
    assert.match(result.output, /dentro de \.git/, workdir);
  }
  assert.equal(requests.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("edit_file: no dice que el cambio está hecho si lo nuevo solo aparece en otra parte", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-edit-falso-"));
  const file = path.join(root, "a.js");
  const before = "function a() {\n  return result;\n}\nfunction b() {\n  return valor_viejo + 1;\n}\n";
  fs.writeFileSync(file, before);
  const ctx = newCtx(root);
  await run(ctx, "read_file", { path: "a.js" });
  // El texto se parece a la línea 5, pero lo nuevo está en la 2: no se ha hecho nada y tiene que saberlo
  let result = await run(ctx, "edit_file", { path: "a.js", old_string: "return valor_viejo+1;", new_string: "return result;" });
  assert.ok(result.isError, result.output);
  assert.doesNotMatch(result.output, /Nada que cambiar|ya está hecho/);
  assert.match(result.output, /Lo más parecido está en la línea 5/);
  assert.match(result.output, /no se ha cambiado nada/);
  // Sin nada parecido tampoco se puede saber
  result = await run(ctx, "edit_file", { path: "a.js", old_string: "zzzz qqqq wwww", new_string: "return result;" });
  assert.ok(result.isError, result.output);
  assert.match(result.output, /aparece en la línea 2/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  // Lo nuevo está justo donde iría el cambio, aunque también aparezca antes: eso sí parece hecho
  fs.writeFileSync(file, "  return resultado; // otra cosa\nfunction c() {\n  return result2;\n}\n  return resultado;\n");
  await run(ctx, "read_file", { path: "a.js" });
  result = await run(ctx, "edit_file", { path: "a.js", old_string: "return resultadoo;", new_string: "return resultado;" });
  assert.ok(!result.isError, result.output);
  assert.match(result.output, /ya aparece en la línea 5/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("anuncios: una frase final normal que empieza por «Ahora» no es un anuncio", () => {
  for (const text of ["Ahora los tests pasan.", "Ahora las pruebas pasan correctamente.", "Ahora lo tienes listo.", "Now I have finished the task."]) {
    assert.equal(announcesAction(text), false, text);
  }
  for (const text of ["Ahora lo arreglo.", "Ahora los reviso.", "Ahora reviso los tests.", "Voy a crear el fichero.", "Now I'll run it.", "Now I will run it.", "Let's start by reading the code.", "We can use read_file to see the bug."]) {
    assert.equal(announcesAction(text), true, text);
  }
});

// Un programa que se queda en marcha, apunta su número de proceso y va escribiendo
const SERVER = `
const fs = require("node:fs");
fs.writeFileSync("pid-" + process.argv[2] + ".txt", String(process.pid));
console.log("listo ñ");
let n = 0;
setInterval(() => console.log("tick " + ++n), 100);
`;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check, ms = 8000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

test("segundo plano: arranca, se mira lo nuevo, se para con todo lo que lanzó y no le afecta Esc después", async () => {
  const background = await import("../dist/background.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-bg-"));
  fs.writeFileSync(path.join(root, "srv.cjs"), SERVER);
  fs.writeFileSync(path.join(root, "falla.cjs"), 'console.log("me voy"); process.exit(3);');
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "srv.cjs"), SERVER);
  const requests = [];
  const controller = new AbortController();
  const ctx = { ...newCtx(root), signal: controller.signal, ask: async (request) => (requests.push(request), { allow: true }) };
  const pidOf = (name) => Number(fs.readFileSync(path.join(root, name), "utf8"));
  try {
    // Pide permiso como cualquier otro comando, y se ve que va en segundo plano
    let result = await run(ctx, "bash", { command: "node srv.cjs uno", background: true });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].kind, "bash");
    assert.equal(requests[0].subject, "node srv.cjs uno");
    assert.match(requests[0].preview, /en segundo plano/);
    const id = /id (bg\d+)/.exec(result.output)[1];
    // En un ordenador lento puede no haber escrito nada todavía
    assert.ok(await until(() => fs.existsSync(path.join(root, "pid-uno.txt"))));
    const pid = pidOf("pid-uno.txt");
    assert.ok(alive(pid));
    let written = result.output;
    assert.ok(await until(() => background.findJob(id).buffer.includes("listo ñ")));
    assert.equal(tools.describeCall("bash", JSON.stringify({ command: "node srv.cjs", background: true })), "(en segundo plano) node srv.cjs");

    // output: solo lo nuevo, y con wait_ms espera a que escriba algo
    result = await run(ctx, "background", { action: "output", id, wait_ms: 3000 });
    written += result.output;
    assert.match(written, /listo ñ/);
    assert.match(result.output, /en marcha desde hace/);
    assert.ok(await until(() => background.findJob(id).buffer.includes("tick")));
    result = await run(ctx, "background", { action: "output", id, wait_ms: 3000 });
    const first = Number(/tick (\d+)\s*$/.exec(result.output)[1]);
    result = await run(ctx, "background", { action: "output", id, wait_ms: 3000 });
    const ticks = [...result.output.matchAll(/tick (\d+)/g)].map((match) => Number(match[1]));
    assert.ok(ticks.length > 0 && ticks[0] === first + 1, result.output);

    // Sin id vale si solo hay uno; y un id que no es de vipcode no para nada
    result = await run(ctx, "background", { action: "output" });
    assert.match(result.output, new RegExp(id));
    result = await run(ctx, "background", { action: "stop", id: String(process.pid) });
    assert.ok(result.isError);
    assert.match(result.output, /no encuentro/);
    assert.ok(alive(process.pid));
    result = await run(ctx, "background", { action: "sopla" });
    assert.ok(result.isError);

    // Esc una vez en marcha no lo para: para eso está en segundo plano
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(alive(pid));
    const quiet = { ...ctx, signal: undefined };

    // Se para con lo que haya lanzado (aquí el proceso de node está por debajo de la shell)
    result = await run(quiet, "background", { action: "stop", id });
    assert.match(result.output, /parado/);
    assert.ok(await until(() => !alive(pid)), "sigue en marcha después de pararlo");
    result = await run(quiet, "background", { action: "list" });
    assert.match(result.output, new RegExp(`${id}: parado`));

    // Si termina enseguida se sabe ya, con su código y sin esperar más de la cuenta
    result = await run(quiet, "bash", { command: "node falla.cjs", background: true });
    // (en un ordenador muy lento puede no haberle dado tiempo: entonces se ve con «output»)
    if (!/^En marcha/.test(result.output)) {
      assert.match(result.output, /Código de salida: 3/);
      assert.match(result.output, /me voy/);
    }

    // En otra carpeta: lo aprobado para una carpeta no vale en otra, igual que sin segundo plano
    requests.length = 0;
    result = await run(quiet, "bash", { command: "node srv.cjs dos", background: true, workdir: "sub" });
    assert.equal(requests[0].workdir, "sub");
    assert.match(requests[0].preview, /en sub/);
    assert.ok(await until(() => fs.existsSync(path.join(root, "sub", "pid-dos.txt"))));
    await background.stopAllJobs();
    assert.ok(await until(() => !alive(Number(fs.readFileSync(path.join(root, "sub", "pid-dos.txt"), "utf8")))));

    // Si le dices que no, no arranca
    requests.length = 0;
    result = await run({ ...quiet, ask: async () => ({ allow: false }) }, "bash", { command: "node srv.cjs tres", background: true });
    assert.match(result.output, /ha rechazado/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!fs.existsSync(path.join(root, "pid-tres.txt")));

    // Esc mientras arranca sí lo cancela
    const cancel = new AbortController();
    const pending = run({ ...quiet, signal: cancel.signal }, "bash", { command: "node srv.cjs cuatro", background: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    cancel.abort();
    result = await pending;
    assert.match(result.output, /Cancelado/);
    assert.ok(await until(() => background.runningJobs().length === 0));
    if (fs.existsSync(path.join(root, "pid-cuatro.txt"))) {
      assert.ok(await until(() => !alive(pidOf("pid-cuatro.txt"))));
    }

    // Un modo de solo lectura no puede usarlo
    result = await tools.runTool(tools.CORE_TOOLS, "background", JSON.stringify({ action: "stop", id }), quiet, true);
    assert.match(result.output, /solo lectura/);
  } finally {
    await background.stopAllJobs();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("segundo plano: hay un límite, no se queda sin memoria y dice lo que se ha perdido", async () => {
  const background = await import("../dist/background.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-bg2-"));
  fs.writeFileSync(path.join(root, "srv.cjs"), SERVER);
  fs.writeFileSync(path.join(root, "mucho.cjs"), 'process.stdout.write("x".repeat(500000) + "\\nfinal\\n"); setInterval(() => {}, 1000);');
  const ctx = newCtx(root);
  try {
    for (let i = 0; i < background.MAX_RUNNING; i++) {
      await run(ctx, "bash", { command: `node srv.cjs n${i}`, background: true });
    }
    assert.equal(background.runningJobs().length, background.MAX_RUNNING);
    const asked = [];
    const result = await run({ ...ctx, ask: async (request) => (asked.push(request), { allow: true }) }, "bash", { command: "node srv.cjs otro", background: true });
    assert.ok(result.isError);
    assert.match(result.output, /ya hay 5 comandos/);
    // Ni siquiera se pregunta: no se podría hacer
    assert.equal(asked.length, 0);
    await background.stopAllJobs();
    assert.equal(background.runningJobs().length, 0);

    // Escribe más de lo que se guarda: lo último se conserva, se dice cuánto se ha perdido y lo que le llega al modelo es corto
    const start = await run(ctx, "bash", { command: "node mucho.cjs", background: true });
    const id = /id (bg\d+)/.exec(start.output)[1];
    assert.ok(start.output.length < 25000, String(start.output.length));
    const job = background.findJob(id);
    assert.ok(await until(() => job.buffer.includes("final"), 15000));
    assert.ok(job.buffer.length <= 200000);
    assert.equal(job.buffer.length + job.dropped, 500000 + "\nfinal\n".length);
    const rest = await run(ctx, "background", { action: "output", id });
    assert.ok(rest.output.length < 25000, String(rest.output.length));
    const seen = `${start.output}${rest.output}`;
    assert.match(seen, /caracteres perdidos/);
    assert.match(seen, /final/);
  } finally {
    await background.stopAllJobs();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Los 7 arreglos de la 0.4.1: cada prueba fallaba antes de arreglarlo

test("seguridad: lo que se aprueba solo no sale del proyecto, ni con rodeos, y sigue valiendo lo normal", async () => {
  const rules = (await import("../dist/config.js")).DEFAULT_PERMISSION;
  for (const command of [
    "git status",
    "git status --short",
    "git diff",
    "git diff --stat",
    "git diff HEAD~1..HEAD",
    "git diff main...feature -- src/a.ts",
    "git diff -- '*.md'",
    "git log --oneline -n 5",
    'git log --format="%h %s"',
    "git log --pretty=format:%h%n%s%d",
    'git log --since="2 days ago"',
    "git log --grep='fin$'",
    "git show HEAD:src/a.ts",
    "git show stash@{0}",
    "git show HEAD^{tree}",
    "ls",
    "ls -la src",
    "ls src/*.ts",
    "ls .github",
    "git status 2>&1",
  ]) {
    assert.equal(permissions.evaluate(rules, "bash", command), "allow", command);
  }
  for (const command of [
    "git diff ../secreto README.md",
    "git diff ./../secreto README.md",
    "git diff sub/../../secreto README.md",
    'git diff "./../secreto" README.md',
    'git diff "."./secreto README.md',
    "git diff .''./secreto README.md",
    "git diff .\\./secreto README.md",
    "git diff ..\\secreto README.md",
    "git diff $PWD/../secreto README.md",
    "git diff ${PWD}/../secreto README.md",
    'git diff "$PWD/../secreto" README.md',
    "git diff .{.,}/secreto README.md",
    "git diff .[.]/secreto README.md",
    "git diff .?/secreto README.md",
    "git diff %CD%\\..\\secreto README.md",
    "git diff --algorithm=../x",
    "git diff C:\\Users\\yo\\secreto README.md",
    "git diff C:..\\secreto README.md",
    "ls ./../",
    "ls sub/../..",
    "git log --all -- ./../secreto",
    "git diff -- ~/secreto",
  ]) {
    assert.equal(permissions.evaluate(rules, "bash", command), "ask", command);
  }
  // PowerShell ejecuta lo que hay entre paréntesis: tampoco vale un «sí siempre»
  for (const command of ["ls (Remove-Item -Recurse x)", "git status (calc.exe)", "git log @(Remove-Item x)", 'ls "a” (calc) "', 'ls x\\" "(calc)"']) {
    assert.equal(permissions.evaluate(rules, "bash", command), "ask", command);
  }
  const grants = new permissions.SessionGrants();
  grants.allowPattern("bash", "npm test*");
  grants.allowPattern("bash", "node*");
  assert.ok(grants.allows("bash", "npm test"));
  assert.ok(grants.allows("bash", 'node -e "console.log(1)"'), "entre comillas es texto");
  assert.ok(!grants.allows("bash", "npm test (Remove-Item x)"));
  assert.ok(!grants.allows("bash", 'npm test "a” (calc) "'));

  // De verdad, con git: no se ve el secreto y se pregunta
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-fuera-"));
  const root = path.join(casa, "proyectos", "app");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(casa, "secreto.txt"), "CLAVE-QUE-NO-DEBE-SALIR\n");
  fs.writeFileSync(path.join(root, "README.md"), "hola\n");
  spawnSync("git", ["init", "-q"], { cwd: root });
  const asked = [];
  const ask = permissions.createAsker(() => rules, new permissions.SessionGrants(), async (request) => (asked.push(request.subject), { allow: false }));
  const ctx = { ...newCtx(root), ask };
  for (const command of ["git diff ./../../secreto.txt README.md", "git diff proyectos/../../../secreto.txt README.md"]) {
    const result = await run(ctx, "bash", { command });
    assert.ok(!result.output.includes("CLAVE-QUE-NO-DEBE-SALIR"), command);
  }
  assert.equal(asked.length, 2);
  fs.rmSync(casa, { recursive: true, force: true });

  // Los datos de vipcode se preguntan siempre, también dando un rodeo
  const data = path.basename(process.env.VIPCODE_HOME);
  for (const command of [`cat ../../${data}/auth.json`, `cd ~ && cat ${data}/auth.json`, `cat $HOME/${data}/auth.json`]) {
    assert.ok(permissions.touchesVipcode(command), command);
  }
  assert.ok(!permissions.touchesVipcode("cat src/auth.json"));
});

test("/undo: lo que estaba ignorado no se borra aunque el modelo haya reescrito el .gitignore", async () => {
  const { Snapshots } = await import("../dist/snapshot.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-undo-ignorados-"));
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  };
  write(".gitignore", ".env\ndatos/\n");
  write(".env", "CLAVE=1\n");
  write("datos/foto.raw", "foto");
  write("a.txt", "uno\n");
  const snapshots = new Snapshots(root, true);
  const before = await snapshots.track();
  assert.ok(before);
  // El modelo reescribe el .gitignore sin esas líneas, cambia un fichero y crea otro
  write(".gitignore", "node_modules/\n");
  write("a.txt", "dos\n");
  write("nuevo.txt", "de esta tarea\n");
  const files = await snapshots.restore(before);
  // Lo tuyo sigue ahí
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), "CLAVE=1\n");
  assert.equal(fs.readFileSync(path.join(root, "datos/foto.raw"), "utf8"), "foto");
  // Y lo de esta tarea se deshace
  assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), ".env\ndatos/\n");
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "uno\n");
  assert.ok(!fs.existsSync(path.join(root, "nuevo.txt")));
  assert.deepEqual(files.sort(), [".gitignore", "a.txt", "nuevo.txt"]);
  // Las instantáneas siguientes ya no llevan lo ignorado (son tus claves)
  const after = await snapshots.track();
  assert.deepEqual(await snapshots.changes(before, after), []);
  // Un .gitignore que aparece en la tarea también se quita. Lo que él mismo ignora no se ve en las instantáneas: no se toca,
  // que siempre es mejor que borrar de más
  fs.rmSync(path.join(root, ".gitignore"));
  const noIgnore = await snapshots.track();
  write(".gitignore", "tarea.log\n");
  write("tarea.log", "x");
  write("otro.txt", "de la tarea\n");
  await snapshots.restore(noIgnore);
  assert.ok(!fs.existsSync(path.join(root, ".gitignore")));
  assert.ok(!fs.existsSync(path.join(root, "otro.txt")));
  assert.ok(fs.existsSync(path.join(root, "tarea.log")));
  assert.ok(fs.existsSync(path.join(root, ".env")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("edit_file: los ficheros que no están en UTF-8 conservan su codificación y sus letras", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-latin1-"));
  const file = path.join(root, "viejo.js");
  // En Windows-1252: «// Año nuevo: café 5 €» y otra línea
  const original = Buffer.concat([Buffer.from("// A"), Buffer.from([0xf1]), Buffer.from("o nuevo: caf"), Buffer.from([0xe9]), Buffer.from(" 5 "), Buffer.from([0x80]), Buffer.from("\nvalor = 1\n")]);
  fs.writeFileSync(file, original);
  const ctx = newCtx(root);
  let result = await run(ctx, "read_file", { path: "viejo.js" });
  assert.match(result.output, /Año nuevo: café 5 €/);
  result = await run(ctx, "edit_file", { path: "viejo.js", old_string: "valor = 1", new_string: "valor = 2" });
  assert.ok(!result.isError, result.output);
  assert.deepEqual(fs.readFileSync(file), Buffer.from(original.toString("latin1").replace("valor = 1", "valor = 2"), "latin1"));
  // Lo que escribe el modelo también va en esa codificación, y se puede buscar por el texto con tildes
  result = await run(ctx, "edit_file", { path: "viejo.js", old_string: "Año nuevo", new_string: "Año viejo ñ" });
  assert.ok(!result.isError, result.output);
  assert.ok(fs.readFileSync(file).includes(Buffer.from([0x20, 0x76, 0x69, 0x65, 0x6a, 0x6f, 0x20, 0xf1])));
  // Lo que no existe en esa codificación no se escribe a medias: se dice
  const before = fs.readFileSync(file);
  result = await run(ctx, "edit_file", { path: "viejo.js", old_string: "valor = 2", new_string: "valor = \u{1F600}" });
  assert.ok(result.isError);
  assert.match(result.output, /Windows-1252/);
  assert.deepEqual(fs.readFileSync(file), before);
  // write_file igual, y el diff que se enseña se lee bien
  const seen = [];
  result = await run({ ...ctx, ask: async (request) => (seen.push(request.preview), { allow: true }) }, "write_file", { path: "viejo.js", content: "// Niño\n" });
  assert.ok(!result.isError, result.output);
  assert.deepEqual(fs.readFileSync(file), Buffer.from("// Niño\n", "latin1"));
  assert.match(seen[0], /Año viejo ñ/);
  // Un fichero en UTF-8 sigue igual, con su BOM, y uno nuevo va en UTF-8
  const bom = path.join(root, "bom.txt");
  fs.writeFileSync(bom, "\ufeffaño\n");
  await run(ctx, "read_file", { path: "bom.txt" });
  await run(ctx, "edit_file", { path: "bom.txt", old_string: "año", new_string: "\u{1F600}" });
  assert.deepEqual(fs.readFileSync(bom), Buffer.from("\ufeff\u{1F600}\n"));
  await run(ctx, "write_file", { path: "nuevo.txt", content: "€\n" });
  assert.deepEqual(fs.readFileSync(path.join(root, "nuevo.txt")), Buffer.from("€\n"));
  // Un binario no se edita (se estropearía)
  const binary = Buffer.from([0x00, 0xff, 0x41, 0x0a, 0x42]);
  fs.writeFileSync(path.join(root, "x.bin"), binary);
  ctx.readTimes.set(path.join(root, "x.bin"), Date.now() + 1000);
  result = await run(ctx, "edit_file", { path: "x.bin", old_string: "A", new_string: "C" });
  assert.ok(result.isError);
  assert.match(result.output, /binario/);
  assert.deepEqual(fs.readFileSync(path.join(root, "x.bin")), binary);
  // Sin git, /undo devuelve los bytes de antes
  fs.writeFileSync(file, original);
  ctx.readTimes.clear();
  await run(ctx, "read_file", { path: "viejo.js" });
  tools.beginTurn();
  await run(ctx, "edit_file", { path: "viejo.js", old_string: "valor = 1", new_string: "valor = 3" });
  let undone = tools.undoLastTurn(root);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(undone, { files: ["viejo.js"], kept: [] });
  // Pero si lo has cambiado después, no se pisa: se deja como está y se dice
  ctx.readTimes.clear();
  await run(ctx, "read_file", { path: "viejo.js" });
  tools.beginTurn();
  await run(ctx, "edit_file", { path: "viejo.js", old_string: "valor = 1", new_string: "valor = 4" });
  const mine = Buffer.concat([fs.readFileSync(file), Buffer.from("// mío\n")]);
  fs.writeFileSync(file, mine);
  undone = tools.undoLastTurn(root);
  assert.deepEqual(fs.readFileSync(file), mine);
  assert.deepEqual(undone, { files: [], kept: ["viejo.js"] });
  fs.rmSync(root, { recursive: true, force: true });
});

test("secretos: se pregunta antes de leerlos, no se cuelan por otro camino y se puede cambiar", async () => {
  const { isSecretPath } = await import("../dist/secrets.js");
  for (const name of [".env", ".env.local", ".env.production", "config/.env", "prod.env", ".envrc", ".ssh/id_rsa", ".ssh/config", "id_ed25519", ".aws/credentials", ".npmrc", ".pypirc", ".netrc", ".git-credentials", ".pgpass", "certs/servidor.pem", "a.key", "almacen.p12", "credentials.json", "credentials", "secrets.yaml", ".docker/config.json", ".kube/config", "terraform.tfstate", ".zsh_history", ".ENV", "C:\\Users\\yo\\.ssh\\id_rsa"]) {
    assert.ok(isSecretPath(name), name);
  }
  for (const name of [".env.example", ".env.sample", ".env.template", "src/secrets.ts", "credentials.ts", "docs/credentials.md", "keys.ts", "monkey.js", "environment.ts", "id_rsa.pub", "README.md", "src/env.ts", "package.json", "a.keyboard"]) {
    assert.ok(!isSecretPath(name), name);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-secretos-"));
  fs.writeFileSync(path.join(root, ".env"), "STRIPE_KEY=sk_live_123\n");
  fs.writeFileSync(path.join(root, ".env.example"), "STRIPE_KEY=\n");
  fs.writeFileSync(path.join(root, "servidor.pem"), "BUSCAME-EN-PEM\n");
  fs.writeFileSync(path.join(root, "normal.txt"), "BUSCAME-EN-NORMAL\n");
  const asked = [];
  let answer = false;
  const ctx = { ...newCtx(root), ask: async (request) => (asked.push(request), { allow: answer }) };
  // Si dices que no, el modelo no ve nada
  let result = await run(ctx, "read_file", { path: ".env" });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, "secrets");
  assert.equal(asked[0].subject, ".env");
  assert.match(asked[0].preview, /se envía al modelo/);
  assert.match(result.output, /ha rechazado/);
  assert.ok(!result.output.includes("sk_live_123"));
  // Tampoco por el aviso de editar sin haber leído
  result = await run(ctx, "edit_file", { path: ".env", old_string: "x", new_string: "y" });
  assert.ok(!result.output.includes("sk_live_123"), result.output);
  // Un enlace a un secreto es un secreto
  if (process.platform !== "win32") {
    fs.symlinkSync(".env", path.join(root, "inocente.txt"));
    asked.length = 0;
    result = await run(ctx, "read_file", { path: "inocente.txt" });
    assert.equal(asked.length, 1);
    assert.ok(!result.output.includes("sk_live_123"));
    fs.rmSync(path.join(root, "inocente.txt"));
  }
  // Lo que no es secreto, como siempre
  asked.length = 0;
  result = await run(ctx, "read_file", { path: ".env.example" });
  assert.equal(asked.length, 0);
  assert.match(result.output, /STRIPE_KEY=/);
  // grep, con rg y sin él: no enseña lo de los secretos, y dice que hay más
  for (const rg of ["1", "0"]) {
    process.env.VIPCODE_RIPGREP = rg;
    result = await run(ctx, "grep", { pattern: "BUSCAME" });
    assert.match(result.output, /normal\.txt:1: BUSCAME-EN-NORMAL/);
    assert.ok(!result.output.includes("BUSCAME-EN-PEM"), result.output);
    assert.match(result.output, /se ha omitido 1 fichero/);
    asked.length = 0;
    result = await run(ctx, "grep", { pattern: "sk_live", path: ".env" });
    assert.equal(asked.length, 1);
    assert.ok(!result.output.includes("sk_live_123"));
  }
  // Si dices que sí, se lee, y no se vuelve a preguntar por el mismo
  answer = true;
  asked.length = 0;
  result = await run(ctx, "read_file", { path: ".env" });
  assert.match(result.output, /sk_live_123/);
  await run(ctx, "read_file", { path: ".env" });
  assert.equal(asked.length, 1);
  process.env.VIPCODE_RIPGREP = "0";
  result = await run(ctx, "grep", { pattern: "BUSCAME-EN-PEM", path: "servidor.pem" });
  assert.match(result.output, /servidor\.pem:1: BUSCAME-EN-PEM/);
  delete process.env.VIPCODE_RIPGREP;
  fs.rmSync(root, { recursive: true, force: true });

  // Las reglas: por defecto se pregunta, también con «sí a todo»; se puede permitir o prohibir
  const { DEFAULT_PERMISSION } = await import("../dist/config.js");
  const request = { kind: "secrets", title: "", preview: "", subject: ".env" };
  const decide = async (rules, setup = () => {}) => {
    const grants = new permissions.SessionGrants();
    setup(grants);
    let prompted = false;
    const reply = await permissions.createAsker(() => rules, grants, async () => ((prompted = true), { allow: false }))(request);
    return { allow: reply.allow, prompted };
  };
  assert.deepEqual(await decide(DEFAULT_PERMISSION), { allow: false, prompted: true });
  assert.deepEqual(await decide(DEFAULT_PERMISSION, (grants) => ["write", "bash", "web", "mcp"].forEach((kind) => grants.allowKind(kind))), { allow: false, prompted: true });
  assert.deepEqual(await decide(DEFAULT_PERMISSION, (grants) => grants.allowKind("secrets")), { allow: true, prompted: false });
  assert.deepEqual(await decide({ ...DEFAULT_PERMISSION, secrets: "allow" }), { allow: true, prompted: false });
  assert.deepEqual(await decide({ ...DEFAULT_PERMISSION, secrets: "deny" }), { allow: false, prompted: false });
  // Un comando que nombra un secreto no se aprueba solo; con «sí a todo» o con secrets: allow, sí
  const bash = async (subject, rules, setup = () => {}) => {
    const grants = new permissions.SessionGrants();
    setup(grants);
    let prompted = false;
    await permissions.createAsker(() => rules, grants, async () => ((prompted = true), { allow: false }))({ kind: "bash", title: "", preview: "", subject });
    return prompted;
  };
  assert.equal(await bash("git show HEAD:.env", DEFAULT_PERMISSION), true);
  assert.equal(await bash("git diff certs/a.pem", DEFAULT_PERMISSION), true);
  assert.equal(await bash("git show HEAD:README.md", DEFAULT_PERMISSION), false);
  assert.equal(await bash("cat .env", DEFAULT_PERMISSION, (grants) => grants.allowPattern("bash", "cat*")), true);
  assert.equal(await bash("cat .env", DEFAULT_PERMISSION, (grants) => grants.allowKind("bash")), false);
  assert.equal(await bash("git show HEAD:.env", { ...DEFAULT_PERMISSION, secrets: "allow" }), false);
  // La configuración de un proyecto que los deja leer se te cuenta antes de confiar en ella
  const { describeTrust } = await import("../dist/trustinfo.js");
  const { projectTrust } = await import("../dist/trust.js");
  const trusted = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-secretos-confianza-"));
  fs.writeFileSync(path.join(trusted, "vipcode.json"), JSON.stringify({ permission: { secrets: "allow" } }));
  assert.match(describeTrust(projectTrust(trusted)).changes.join("\n"), /leerá sin preguntarte ficheros que pueden guardar claves/);
  fs.rmSync(trusted, { recursive: true, force: true });
});

test("argumentos como texto: «false» no cuenta como verdadero", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-booleanos-"));
  const file = path.join(root, "a.txt");
  fs.writeFileSync(file, "uno\nuno\n");
  const ctx = newCtx(root);
  await run(ctx, "read_file", { path: "a.txt" });
  let result = await run(ctx, "edit_file", { path: "a.txt", old_string: "uno", new_string: "dos", replace_all: "false" });
  assert.ok(result.isError, result.output);
  assert.match(result.output, /aparece 2 veces/);
  assert.equal(fs.readFileSync(file, "utf8"), "uno\nuno\n");
  result = await run(ctx, "edit_file", { path: "a.txt", old_string: "uno", new_string: "dos", replace_all: "true" });
  assert.ok(!result.isError, result.output);
  assert.equal(fs.readFileSync(file, "utf8"), "dos\ndos\n");
  fs.writeFileSync(path.join(root, "b.txt"), "HOLA\n");
  for (const rg of ["1", "0"]) {
    process.env.VIPCODE_RIPGREP = rg;
    result = await run(ctx, "grep", { pattern: "hola", ignore_case: "false" });
    assert.equal(result.output, "Sin coincidencias.");
    result = await run(ctx, "grep", { pattern: "hola", ignore_case: "true" });
    assert.match(result.output, /b\.txt:1: HOLA/);
  }
  delete process.env.VIPCODE_RIPGREP;
  // Un background «false» tampoco deja nada en marcha
  result = await run(ctx, "bash", { command: "node -e \"console.log(7)\"", background: "false" });
  assert.match(result.output, /Código de salida: 0/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("grep sin rg: una expresión que tarda muchísimo no cuelga vipcode", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-regex-"));
  fs.writeFileSync(path.join(root, "a-bueno.txt"), "aaa encontrado\n");
  fs.writeFileSync(path.join(root, "b-malo.txt"), `${"a".repeat(45)}!\n`);
  process.env.VIPCODE_RIPGREP = "0";
  process.env.VIPCODE_GREP_STALL_MS = "1000";
  try {
    let beats = 0;
    const beat = setInterval(() => beats++, 50);
    const started = Date.now();
    let result = await run(newCtx(root), "grep", { pattern: "(a+)+$|encontrado" });
    clearInterval(beat);
    assert.ok(Date.now() - started < 8000, String(Date.now() - started));
    assert.ok(beats > 5, "vipcode tiene que seguir atendiendo mientras busca");
    assert.match(result.output, /a-bueno\.txt:1: aaa encontrado/, "lo encontrado hasta entonces se conserva");
    assert.match(result.output, /tarda demasiado/);
    assert.match(result.output, /b-malo\.txt/);
    // Sin nada encontrado, es un error que el modelo puede corregir
    result = await run(newCtx(root), "grep", { pattern: "(a+)+$", include: "b-*" });
    assert.ok(result.isError, result.output);
    assert.match(result.output, /tarda demasiado/);
    // Esc la para
    process.env.VIPCODE_GREP_STALL_MS = "60000";
    const controller = new AbortController();
    const pending = run({ ...newCtx(root), signal: controller.signal }, "grep", { pattern: "(a+)+$", include: "b-*" });
    setTimeout(() => controller.abort(), 200);
    const startedAbort = Date.now();
    result = await pending;
    assert.ok(Date.now() - startedAbort < 3000);
    assert.match(result.output, /Cancelado/);
    // Una búsqueda normal, como siempre, con su límite de resultados
    delete process.env.VIPCODE_GREP_STALL_MS;
    fs.writeFileSync(path.join(root, "muchas.txt"), "fila\n".repeat(500));
    result = await run(newCtx(root), "grep", { pattern: "fila" });
    assert.match(result.output, /limitado a 200 resultados/);
    assert.equal(result.output.split("\n").filter((line) => line.includes("muchas.txt")).length, 200);
    result = await run(newCtx(root), "grep", { pattern: "[" });
    assert.match(result.output, /inválida/);
  } finally {
    delete process.env.VIPCODE_RIPGREP;
    delete process.env.VIPCODE_GREP_STALL_MS;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
