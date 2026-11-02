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
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
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
  for (const workdir of [".git", ".git/hooks", ".GIT/hooks", ...(process.platform === "win32" ? [] : ["enlace/hooks"])]) {
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
  for (const text of ["Ahora lo arreglo.", "Ahora los reviso.", "Ahora reviso los tests.", "Voy a crear el fichero.", "Now I'll run it.", "Now I will run it."]) {
    assert.equal(announcesAction(text), true, text);
  }
});
