import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Antes de cargar nada, una carpeta de datos temporal para no tocar ~/.vipcode
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-unit-"));
process.env.VIPCODE_HOME = HOME;
// Tampoco se leen las skills de ~/.claude ni de ~/.config/opencode de quien pasa las pruebas
process.env.HOME = HOME;

const tools = await import("../dist/tools.js");
const permissions = await import("../dist/permissions.js");
const { wildcardMatch } = await import("../dist/match.js");
const { parseFrontmatter } = await import("../dist/frontmatter.js");
const agents = await import("../dist/agents.js");
const commands = await import("../dist/commands.js");
const discovery = await import("../dist/discovery.js");
const config = await import("../dist/config.js");
const router = await import("../dist/router.js");
const editor = await import("../dist/tui/editor.js");
const { renderMarkdown } = await import("../dist/markdown.js");
const { CATALOG } = await import("../dist/catalog.js");
const auth = await import("../dist/auth.js");
const ranking = await import("../dist/ranking.js");
const skills = await import("../dist/skills.js");
const { RANKING_FIXTURE } = await import("./fixtures/ranking-data.mjs");

test("diff por líneas con contexto", () => {
  const old = Array.from({ length: 20 }, (_, i) => `linea ${i + 1}`).join("\n");
  const neu = old.replace("linea 5", "LINEA CINCO").replace("linea 15\n", "");
  const diff = tools.unifiedDiff(old, neu);
  assert.match(diff, /@@ línea 2 @@/);
  assert.match(diff, /- linea 5\n\+ LINEA CINCO/);
  assert.match(diff, /- linea 15/);
  assert.equal(tools.unifiedDiff("a\nb", "a\nb"), "(sin cambios)");
});

test("comodines", () => {
  assert.ok(wildcardMatch("gemini/*", "gemini/gemini-3.8-flash"));
  assert.ok(wildcardMatch("git status*", "git status --short"));
  assert.ok(!wildcardMatch("git status*", "git push"));
  assert.ok(wildcardMatch("a.b", "a.b"));
  assert.ok(!wildcardMatch("a.b", "axb"));
});

test("permisos: reglas, comandos encadenados y sustituciones", () => {
  const rules = { bash: { "*": "ask", "git status*": "allow", "rm *": "deny" }, edit: "allow", webfetch: "deny" };
  assert.equal(permissions.evaluate(rules, "bash", "git status"), "allow");
  assert.equal(permissions.evaluate(rules, "bash", "git status && rm -rf x"), "deny");
  assert.equal(permissions.evaluate(rules, "bash", "git status | less"), "ask");
  assert.equal(permissions.evaluate(rules, "bash", "git status $(rm -rf x)"), "ask");
  assert.equal(permissions.evaluate(rules, "write", "a.txt"), "allow");
  assert.equal(permissions.evaluate(rules, "web", "https://x"), "deny");
  assert.equal(permissions.evaluate({}, "mcp", "github_create"), "ask");
  assert.equal(permissions.evaluate({ mcp: { "github_*": "allow" } }, "mcp", "github_list"), "allow");
  assert.equal(permissions.suggestPattern("npm test -- --watch"), "npm test*");
  assert.equal(permissions.suggestPattern("ls -la"), "ls*");

  const grants = new permissions.SessionGrants();
  grants.allowPattern("bash", "npm test*");
  assert.ok(grants.allows("bash", "npm test"));
  assert.ok(!grants.allows("bash", "npm test && rm -rf /"));
  grants.allowKind("write");
  assert.ok(grants.allows("write", "x"));
});

test("permisos: createAsker respeta deny y allow antes de preguntar", async () => {
  let asked = 0;
  const ask = permissions.createAsker(
    () => ({ bash: { "*": "ask", "rm*": "deny", "ls*": "allow" } }),
    new permissions.SessionGrants(),
    async () => {
      asked++;
      return { allow: true };
    },
  );
  assert.deepEqual((await ask({ kind: "bash", title: "", preview: "", subject: "rm -rf x" })).allow, false);
  assert.equal((await ask({ kind: "bash", title: "", preview: "", subject: "ls" })).allow, true);
  assert.equal(asked, 0);
  assert.equal((await ask({ kind: "bash", title: "", preview: "", subject: "npm i" })).allow, true);
  assert.equal(asked, 1);
});

test("frontmatter y agentes en .md", () => {
  const { data, body } = parseFrontmatter("---\ndescription: Revisor\nmode: subagent\ntools:\n  write: false\n  bash: false\n---\nRevisa con cuidado.\n");
  assert.equal(data.description, "Revisor");
  assert.equal(body.trim(), "Revisa con cuidado.");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-agents-"));
  fs.mkdirSync(path.join(root, ".vipcode", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".vipcode", "agents", "revisor.md"), "---\ndescription: Revisor\nmode: subagent\ntools:\n  write: false\n  edit: false\n---\nRevisa.");
  fs.mkdirSync(path.join(root, ".opencode", "agent"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opencode", "agent", "docs.md"), "---\ndescription: Escribe documentación\nmode: primary\n---\nEscribe docs.");
  const list = agents.loadAgents(root, { ...config.DEFAULT_CONFIG, agents: { plan: { model: "groq/*" } } });
  const revisor = list.find((a) => a.name === "revisor");
  assert.ok(revisor);
  assert.equal(revisor.mode, "subagent");
  assert.equal(agents.toolEnabled(revisor, "write_file"), false);
  assert.equal(agents.toolEnabled(revisor, "edit_file"), false);
  assert.equal(agents.toolEnabled(revisor, "read_file"), true);
  assert.ok(list.find((a) => a.name === "docs" && a.mode === "primary"));
  assert.equal(list.find((a) => a.name === "plan").model, "groq/*");
  assert.deepEqual(
    agents.primaryAgents(list).map((a) => a.name),
    ["build", "plan", "docs"],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("comandos con plantilla: $ARGUMENTS, $1 y !`comando`", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-cmd-"));
  fs.mkdirSync(path.join(root, ".vipcode", "commands"), { recursive: true });
  fs.writeFileSync(path.join(root, ".vipcode", "commands", "saluda.md"), "---\ndescription: Saluda\nagent: plan\n---\nSaluda a $1 ($ARGUMENTS). Hoy: !`echo martes`");
  const list = commands.loadCommands(root, config.DEFAULT_CONFIG);
  const saluda = list.find((c) => c.name === "saluda");
  assert.equal(saluda.agent, "plan");
  const text = await commands.expandCommand(saluda, '"Ana López" y $& más', root);
  assert.equal(text, 'Saluda a Ana López ("Ana López" y $& más). Hoy: martes');
  assert.ok(list.find((c) => c.name === "init"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("edit_file: exacto, aproximado (sangría) y protección de leer antes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-edit-"));
  const file = path.join(root, "a.js");
  fs.writeFileSync(file, "function f() {\n    return 1;\n}\n");
  const readTimes = new Map();
  const ctx = { root, bashTimeoutMs: 1000, readTimes, ask: async () => ({ allow: true }) };
  const list = tools.CORE_TOOLS;

  let result = await tools.runTool(list, "edit_file", JSON.stringify({ path: "a.js", old_string: "return 1;", new_string: "return 2;" }), ctx, false);
  assert.ok(result.isError);
  assert.match(result.output, /lee a\.js con read_file/);

  await tools.runTool(list, "read_file", JSON.stringify({ path: "a.js" }), ctx, false);
  result = await tools.runTool(list, "edit_file", JSON.stringify({ path: "a.js", old_string: "return 1;", new_string: "return 2;" }), ctx, false);
  assert.ok(!result.isError, result.output);
  assert.match(result.display, /- {5}return 1;\n\+ {5}return 2;/);

  // Sin la sangría: la encuentra igual y se la devuelve
  result = await tools.runTool(list, "edit_file", JSON.stringify({ path: "a.js", old_string: "function f() {\nreturn 2;\n}", new_string: "function f() {\nreturn 3;\n}" }), ctx, false);
  assert.ok(!result.isError, result.output);
  assert.match(result.output, /aproximada/);
  assert.equal(fs.readFileSync(file, "utf8"), "function f() {\n    return 3;\n}\n");

  // Si alguien cambia el fichero por fuera, hay que volver a leerlo
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(file, "otro contenido\n");
  result = await tools.runTool(list, "edit_file", JSON.stringify({ path: "a.js", old_string: "otro", new_string: "x" }), ctx, false);
  assert.match(result.output, /ha cambiado desde que lo leíste/);

  // Fuera del proyecto no se puede
  result = await tools.runTool(list, "read_file", JSON.stringify({ path: "../../etc/passwd" }), ctx, false);
  assert.match(result.output, /fuera del proyecto/);

  // En modo solo lectura no se puede escribir
  result = await tools.runTool(list, "write_file", JSON.stringify({ path: "b.txt", content: "x" }), ctx, true);
  assert.match(result.output, /solo lectura/);

  // Si falta un argumento obligatorio se le dice cuál (y new_string vacío sí vale: es borrar texto)
  result = await tools.runTool(list, "edit_file", JSON.stringify({ old_string: "a", new_string: "b" }), ctx, false);
  assert.match(result.output, /le faltan argumentos obligatorios: path/);
  result = await tools.runTool(list, "edit_file", JSON.stringify({ path: "", old_string: "a" }), ctx, false);
  assert.match(result.output, /le faltan argumentos obligatorios: path, new_string/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("grep, glob, todowrite y menciones @", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-grep-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "uno.ts"), "export const hola = 1;\n");
  fs.writeFileSync(path.join(root, "src", "dos.ts"), "const adios = 2;\n");
  const ctx = { root, bashTimeoutMs: 5000, readTimes: new Map(), ask: async () => ({ allow: true }) };
  const grep = await tools.runTool(tools.CORE_TOOLS, "grep", JSON.stringify({ pattern: "hola" }), ctx, false);
  assert.match(grep.output, /src\/uno\.ts:1: export const hola/);
  const glob = await tools.runTool(tools.CORE_TOOLS, "glob", JSON.stringify({ pattern: "**/*.ts" }), ctx, false);
  assert.equal(glob.output, "src/dos.ts\nsrc/uno.ts");

  let todos = [];
  const todoCtx = { ...ctx, todos: { get: () => todos, set: (list) => (todos = list) } };
  await tools.runTool(tools.CORE_TOOLS, "todowrite", JSON.stringify({ todos: [{ content: "uno", status: "in_progress" }, { content: "dos", status: "raro" }] }), todoCtx, false);
  assert.deepEqual(todos, [
    { content: "uno", status: "in_progress" },
    { content: "dos", status: "pending" },
  ]);

  const mentions = tools.expandMentions("mira @src/uno.ts.", root, ctx.readTimes);
  assert.deepEqual(mentions.files, ["src/uno.ts"]);
  assert.match(mentions.text, /<fichero ruta="src\/uno.ts">\n1\texport const hola/);
  assert.ok(ctx.readTimes.has(path.join(root, "src", "uno.ts")));
  assert.deepEqual(tools.suggestFiles(root, "uno"), ["src/uno.ts"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("bash: salida, código y tiempo límite", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-bash-"));
  const ctx = { root, bashTimeoutMs: 5000, readTimes: new Map(), ask: async () => ({ allow: true }) };
  let result = await tools.runTool(tools.CORE_TOOLS, "bash", JSON.stringify({ command: "echo hola; exit 3" }), ctx, false);
  assert.equal(result.output, "Código de salida: 3\nhola");
  result = await tools.runTool(tools.CORE_TOOLS, "bash", JSON.stringify({ command: "sleep 5", timeout_ms: 300 }), ctx, false);
  assert.match(result.output, /Cancelado por tiempo/);
  const denied = { ...ctx, ask: async () => ({ allow: false, feedback: "usa npm" }) };
  result = await tools.runTool(tools.CORE_TOOLS, "bash", JSON.stringify({ command: "yarn" }), denied, false);
  assert.match(result.output, /rechazado.*Motivo: usa npm/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("HTML a texto y resultados de búsqueda", () => {
  assert.equal(tools.htmlToText("<h1>Hola</h1><p>adi&oacute;s &amp; <b>más</b></p><script>x()</script>"), "# Hola\n\nadiós & más");
  const html = `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffs.html&rut=x">File <b>system</b></a>
  <a class="result__snippet" href="x">The <b>fs</b> module</a>
  <a class="result__a" href="https://example.com">Example</a>`;
  const results = tools.parseSearchResults(html, 5);
  assert.deepEqual(results[0], { title: "File system", url: "https://nodejs.org/api/fs.html", snippet: "The fs module" });
  assert.equal(results[1].url, "https://example.com");
});

test("descubrimiento: formatos de OpenRouter, Groq, Mistral y Gemini", () => {
  const openrouter = CATALOG.find((p) => p.name === "openrouter");
  const models = discovery.parseModels(
    {
      data: [
        { id: "a/b:free", context_length: 50000, supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"] } },
        { id: "a/c:free", context_length: 50000, supported_parameters: [] },
        { id: "a/pago", context_length: 50000, supported_parameters: ["tools"], pricing: { prompt: "0.1", completion: "0.2" } },
        { id: "a/gratis", context_length: 9000, supported_parameters: ["tools"], pricing: { prompt: "0", completion: "0" } },
        { id: "openrouter/auto", supported_parameters: ["tools"], pricing: { prompt: "-1", completion: "-1" } },
      ],
    },
    openrouter,
  );
  assert.deepEqual(models, [
    { id: "a/b:free", context: 50000, vision: true },
    { id: "a/gratis", context: 9000, vision: false },
  ]);

  const groq = CATALOG.find((p) => p.name === "groq");
  const groqModels = discovery.parseModels({ data: [{ id: "nuevo", context_window: 131072 }, { id: "viejo", active: false }, { id: "whisper-large-v3" }] }, groq);
  assert.deepEqual(groqModels, [{ id: "nuevo", context: 11000, vision: false }]);

  const mistral = CATALOG.find((p) => p.name === "mistral");
  const mistralModels = discovery.parseModels(
    {
      data: [
        { id: "m1", max_context_length: 32000, capabilities: { function_calling: true, vision: true } },
        { id: "m2", capabilities: { function_calling: false } },
        { id: "mistral-embed", capabilities: { function_calling: true } },
      ],
    },
    mistral,
  );
  assert.deepEqual(mistralModels, [{ id: "m1", context: 32000, vision: true }]);

  const gemini = CATALOG.find((p) => p.name === "gemini");
  const geminiModels = discovery.parseModels({ data: [{ id: "models/gemini-9-flash" }, { id: "models/gemini-9-flash-image" }, { id: "models/text-embedding" }] }, gemini);
  assert.deepEqual(geminiModels, [{ id: "gemini-9-flash", context: 250000, vision: false }]);

  // OVHcloud lista también modelos de vectores, voz e imágenes (sin max_completion_tokens)
  const ovh = CATALOG.find((p) => p.name === "ovhcloud");
  const ovhModels = discovery.parseModels(
    {
      data: [
        { id: "Qwen9-27B", context_length: 262144, max_completion_tokens: 262144 },
        { id: "bge-m3", context_length: 8192, max_completion_tokens: 0 },
        { id: "vectores-nuevos", context_length: 8192, max_completion_tokens: 0 },
      ],
    },
    ovh,
  );
  assert.deepEqual(ovhModels, [{ id: "Qwen9-27B", context: 262144, vision: false }]);

  // LLM7: solo los gratis (no "pro"), de chat y con herramientas
  const llm7 = CATALOG.find((p) => p.name === "llm7");
  const llm7Models = discovery.parseModels(
    {
      data: [
        { id: "gratis-turbo", model_type: "chat", tier: "turbo", context_window: { tokens: 200000 }, capabilities: { tools: true, vision: false } },
        { id: "de-pago", model_type: "chat", tier: "pro", usage_based_only: true, capabilities: { tools: true } },
        { id: "sin-herramientas", model_type: "chat", tier: "turbo", tools_calling: false, capabilities: { tools: false } },
        { id: "dibujos", model_type: "image", tier: "turbo", capabilities: { tools: true } },
      ],
    },
    llm7,
  );
  assert.deepEqual(llm7Models, [{ id: "gratis-turbo", context: 200000, vision: false }]);
});

test("proveedores: los tuyos primero, fusión por nombre, retirados y filtros", () => {
  const cfg = {
    ...config.DEFAULT_CONFIG,
    providers: [
      { name: "mio", baseURL: "http://x/v1", apiKey: "k", models: [{ id: "m", context: 1000 }] },
      { name: "groq", models: [{ id: "openai/gpt-oss-120b", context: 5000 }, { id: "extra", context: 4000 }] },
      { name: "github", baseURL: "https://models.github.ai/inference", apiKeyEnv: "GITHUB_TOKEN", models: [{ id: "openai/gpt-4.1", context: 7500 }] },
    ],
    disabledProviders: ["cohere"],
  };
  const list = discovery.buildProviders(cfg);
  assert.equal(list[0].name, "mio");
  assert.ok(!list.some((p) => p.name === "github"));
  assert.ok(!list.some((p) => p.name === "cohere"));
  const groq = list.find((p) => p.name === "groq");
  assert.equal(groq.models.find((m) => m.id === "openai/gpt-oss-120b").context, 5000);
  assert.ok(groq.models.some((m) => m.id === "extra"));
  assert.ok(config.configNotices.some((n) => n.includes("GitHub Models")));

  const only = discovery.buildProviders({ ...config.DEFAULT_CONFIG, enabledProviders: ["gemini"] });
  assert.deepEqual(only.map((p) => p.name), ["gemini"]);
});

test("descubrimiento: quita los que ya no existen, pero nunca los añadidos a mano", () => {
  const cachePath = path.join(HOME, "models.json");
  const found = [{ id: "nuevo:free", context: 9000, vision: false }];
  fs.writeFileSync(cachePath, JSON.stringify({ updated: Date.now(), providers: { kilo: { updated: Date.now(), models: found } } }));
  try {
    const cfg = { ...config.DEFAULT_CONFIG, providers: [{ name: "kilo", models: [{ id: "mio/a-mano", context: 5000 }] }] };
    const kilo = discovery.buildProviders(cfg).find((p) => p.name === "kilo");
    assert.deepEqual(kilo.models.map((m) => m.id), ["mio/a-mano", "nuevo:free"]);
  } finally {
    fs.rmSync(cachePath, { force: true });
  }
});

test("claves: entorno, auth.json, proveedores sin clave y variables en la URL", () => {
  const gemini = CATALOG.find((p) => p.name === "gemini");
  delete process.env.GEMINI_API_KEY;
  assert.equal(auth.resolveCredentials(gemini, {}), null);
  process.env.GOOGLE_API_KEY = "env-key";
  assert.equal(auth.resolveCredentials(gemini, {}).apiKey, "env-key");
  assert.equal(auth.resolveCredentials(gemini, { gemini: { key: "auth-key" } }).apiKey, "auth-key");
  delete process.env.GOOGLE_API_KEY;

  // Los anónimos funcionan sin nada; si les pones clave, se usa
  for (const name of ["kilo", "ovhcloud", "llm7", "pollinations"]) {
    const anonymous = CATALOG.find((p) => p.name === name);
    assert.equal(auth.resolveCredentials(anonymous, {}).apiKey, "no-key", name);
    assert.ok(config.isAnonymous(anonymous), name);
  }
  const llm7 = CATALOG.find((p) => p.name === "llm7");
  assert.equal(auth.resolveCredentials(llm7, { llm7: { key: "tok" } }).apiKey, "tok");
  // Los de pago-con-plan-gratis siguen necesitando clave, y los locales no cuentan como anónimos
  assert.ok(!config.isAnonymous(CATALOG.find((p) => p.name === "groq")));
  assert.ok(!config.isAnonymous(CATALOG.find((p) => p.name === "ollama")));
  // Con "keyless": false los anónimos dejan de estar disponibles sin clave
  const strict = discovery.buildProviders({ ...config.DEFAULT_CONFIG, keyless: false });
  assert.equal(auth.resolveCredentials(strict.find((p) => p.name === "kilo"), {}), null);
  assert.ok(auth.resolveCredentials(strict.find((p) => p.name === "ollama"), {}));

  const cloudflare = CATALOG.find((p) => p.name === "cloudflare");
  assert.equal(auth.resolveCredentials(cloudflare, { cloudflare: { key: "k" } }), null);
  const creds = auth.resolveCredentials(cloudflare, { cloudflare: { key: "k", vars: { CLOUDFLARE_ACCOUNT_ID: "abc" } } });
  assert.equal(creds.baseURL, "https://api.cloudflare.com/client/v4/accounts/abc/ai/v1");

  auth.saveAuth("groq", { key: "gsk_123456789" });
  assert.equal(auth.readAuth().groq.key, "gsk_123456789");
  assert.equal((fs.statSync(path.join(HOME, "auth.json")).mode & 0o777).toString(8), "600");
  assert.equal(auth.maskKey("gsk_123456789"), "gsk_1…6789");
  assert.ok(auth.removeAuth("groq"));
});

test("config: migración del config antiguo y config del proyecto", () => {
  const old = {
    maxSteps: 40,
    autoCompactTokens: 90000,
    bashTimeoutMs: 120000,
    maxWaitMs: 90000,
    providers: ["gemini", "openrouter", "cerebras", "groq", "mistral", "github", "ollama"].map((name) => ({ name, baseURL: "x", models: [] })),
  };
  fs.writeFileSync(path.join(HOME, "config.json"), JSON.stringify(old));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-proj-"));
  fs.writeFileSync(path.join(root, "vipcode.json"), JSON.stringify({ maxSteps: 7, permission: { bash: { "npm test*": "allow" } } }));
  const loaded = config.loadConfig(root);
  assert.ok(fs.existsSync(path.join(HOME, "config.json.bak")));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(HOME, "config.json"), "utf8")).providers, []);
  assert.equal(loaded.maxSteps, 7);
  assert.equal(loaded.permission.bash["npm test*"], "allow");
  assert.equal(loaded.permission.bash["git status*"], "allow");
  fs.rmSync(root, { recursive: true, force: true });
});

test("tokens: las imágenes no cuentan como texto enorme", () => {
  const image = `data:image/png;base64,${"A".repeat(500000)}`;
  const tokens = router.estimateTokens([{ role: "user", content: [{ type: "text", text: "hola" }, { type: "image_url", image_url: { url: image } }] }]);
  assert.ok(tokens < 2000, String(tokens));
  const stripped = router.stripImages([{ role: "user", content: [{ type: "image_url", image_url: { url: image } }] }]);
  assert.match(JSON.stringify(stripped), /imagen omitida/);
});

test("editor del cuadro de texto", () => {
  let state = editor.insert(editor.EMPTY, "hola mundo");
  state = editor.moveLeft(state, true);
  assert.equal(state.cursor, 5);
  state = editor.deleteWordBack(editor.lineEnd(state));
  assert.equal(state.value, "hola ");
  state = editor.insert(state, "\nsegunda");
  assert.equal(editor.moveVertical(state, 1), null);
  const up = editor.moveVertical(state, -1);
  assert.equal(up.cursor, 5);
  const mention = editor.mentionAtCursor(editor.insert(editor.EMPTY, "mira @src/u"));
  assert.deepEqual(mention, { start: 5, text: "src/u" });
  assert.equal(editor.mentionAtCursor(editor.insert(editor.EMPTY, "correo a@b")), null);
  // Enter pegado al texto o enviado como \n
  assert.deepEqual(editor.splitEnter("pollin\r", false), { text: "pollin", enter: true });
  assert.deepEqual(editor.splitEnter("\n", false), { text: "", enter: true });
  assert.deepEqual(editor.splitEnter("", true), { text: "", enter: true });
  assert.deepEqual(editor.splitEnter("dos\nlíneas\n", false), { text: "dos\nlíneas\n", enter: false });
  assert.deepEqual(editor.splitEnter("abc", false), { text: "abc", enter: false });
});

test("ranking de LLM Stats: empareja los nombres de cada proveedor", () => {
  // Sin descargar nada no hay datos (vipcode no trae los de LLM Stats); con ranking.json, sí
  assert.equal(ranking.loadRankingData(), null);
  fs.writeFileSync(path.join(HOME, "ranking.json"), JSON.stringify(RANKING_FIXTURE));
  assert.equal(ranking.loadRankingData().models.length, RANKING_FIXTURE.models.length);
  fs.rmSync(path.join(HOME, "ranking.json"));
  const rank = new ranking.Ranking(RANKING_FIXTURE);
  const cases = {
    "z-ai/glm-5.3": "glm-5.3",
    "zai-glm-5-3": "glm-5.3",
    "nvidia/nemotron-3-ultra-550b-a55b:free": "nemotron-3-ultra-550b-a55b",
    "qwen-3.8-27b": "qwen3.8-27b",
    "Meta-Llama-3_3-70B-Instruct": "llama-3.3-70b-instruct",
    "llama-3.3-70b-versatile": "llama-3.3-70b-instruct",
    "gpt-oss:120b": "gpt-oss-120b",
    "@cf/meta/llama-4-scout-17b-16e-instruct": "llama-4-scout",
    "reflection/beam-free": "beam-1.0-501b-a23b",
    "nova-2-pro-v1": "nova-2-pro",
    "openai-fast": "gpt-oss-20b",
    "gemini-flash-latest": "gemini-3.8-flash",
  };
  for (const [id, expected] of Object.entries(cases)) {
    assert.equal(rank.find(id)?.id, expected, id);
  }
  assert.equal(rank.find("kilo-auto/free"), null);
  assert.equal(rank.score("modelo-inventado"), null);
  // Más nota a los mejores y siempre entre 0 y 100
  const best = rank.score("deepseek-v4.1-flash").score;
  const weak = rank.score("gpt-oss-20b").score;
  assert.ok(best > weak, `${best} > ${weak}`);
  assert.ok(best <= 100 && weak >= 0);
  assert.equal(rank.score("z-ai/glm-5.3").score, rank.score("zai-glm-5-3").score);
});

test("ranking: los tuyos primero y después todos por nota (con anonymousLast, los anónimos al final)", async () => {
  const { Router } = await import("../dist/router.js");
  const rank = new ranking.Ranking(RANKING_FIXTURE);
  const cfg = { ...config.DEFAULT_CONFIG };
  const providers = [
    { name: "mio", baseURL: "http://x/v1", apiKey: "k", custom: true, models: [{ id: "gpt-oss-20b", context: 1000 }, { id: "glm-5.3", context: 1000 }] },
    { name: "conclave", baseURL: "http://x/v1", apiKey: "k", models: [{ id: "gpt-oss-120b", context: 1000 }, { id: "deepseek-v4.1-flash", context: 1000 }, { id: "sin-nota", context: 1000 }] },
    { name: "anon", baseURL: "http://x/v1", noKey: true, models: [{ id: "glm-5.3", context: 1000 }] },
  ];
  // De serie, el anónimo compite por nota con los que tienen clave
  let router = new Router(cfg, providers, rank);
  assert.deepEqual(
    router.slots.map((s) => s.key),
    ["mio/glm-5.3", "mio/gpt-oss-20b", "conclave/deepseek-v4.1-flash", "anon/glm-5.3", "conclave/gpt-oss-120b", "conclave/sin-nota"],
  );
  router = new Router({ ...cfg, ranking: { enabled: true, metric: "coding", anonymousLast: true } }, providers, rank);
  assert.deepEqual(
    router.slots.map((s) => s.key),
    ["mio/glm-5.3", "mio/gpt-oss-20b", "conclave/deepseek-v4.1-flash", "conclave/gpt-oss-120b", "conclave/sin-nota", "anon/glm-5.3"],
  );
  // "order" del config manda sobre todo
  router = new Router({ ...cfg, order: ["conclave/sin-nota"] }, providers, rank);
  assert.deepEqual(
    router.slots.map((s) => s.key),
    ["conclave/sin-nota", "mio/glm-5.3", "mio/gpt-oss-20b", "conclave/deepseek-v4.1-flash", "anon/glm-5.3", "conclave/gpt-oss-120b"],
  );
  // Sin ranking, el orden del catálogo
  router = new Router(cfg, providers, null);
  assert.deepEqual(
    router.slots.map((s) => s.key),
    ["mio/gpt-oss-20b", "mio/glm-5.3", "conclave/gpt-oss-120b", "conclave/deepseek-v4.1-flash", "conclave/sin-nota", "anon/glm-5.3"],
  );
});

test("markdown en la terminal", () => {
  const out = renderMarkdown("# Título\n\nTexto **negrita** y `código`.\n\n```js\nconst a = 1;\n```\n\n- uno\n- dos\n\n| a | b |\n|---|---|\n| 1 | 2 |", 60);
  const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /Título/);
  assert.match(plain, /Texto negrita y código\./);
  assert.match(plain, /const a = 1;/);
  assert.match(plain, /• uno/);
  assert.match(plain, /1 │ 2/);
});

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test("skills: se buscan en sus carpetas, las del proyecto ganan y el agente las carga con la herramienta skill", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-skills-"));
  writeFile(path.join(HOME, "skills", "informes", "SKILL.md"), "---\nname: informes\ndescription: versión global\n---\nGLOBAL");
  // La del proyecto gana a la global con el mismo nombre, y trae un documento
  writeFile(
    path.join(root, ".vipcode", "skills", "informes", "SKILL.md"),
    "---\nname: informes\ndescription: Úsala para escribir informes semanales\n---\n# Informes\nLee references/plantilla.md y rellénala.",
  );
  writeFile(path.join(root, ".vipcode", "skills", "informes", "references", "plantilla.md"), "PLANTILLA-SECRETA");
  // De Claude Code (en la carpeta personal de prueba) y sin descripción: vale su primera línea
  writeFile(path.join(HOME, ".claude", "skills", "Revisar Código", "SKILL.md"), "# Revisa el código con cuidado\nPasos…");
  writeFile(path.join(root, ".claude", "skills", "interna", "SKILL.md"), "---\nname: interna\ndescription: solo agente\nuser-invocable: false\n---\nx");
  writeFile(path.join(root, ".agents", "skills", "apagada", "SKILL.md"), "---\nname: apagada\ndescription: no se carga\n---\nx");
  const cfg = { ...config.DEFAULT_CONFIG, skills: { ...config.DEFAULT_CONFIG.skills, disabled: ["apagada"] } };
  const list = skills.loadSkills(root, cfg);
  assert.deepEqual(
    list.map((s) => s.name),
    ["informes", "interna", "revisar-codigo"],
  );
  const informes = list.find((s) => s.name === "informes");
  assert.equal(informes.description, "Úsala para escribir informes semanales");
  assert.equal(informes.where, ".vipcode/skills");
  assert.equal(list.find((s) => s.name === "revisar-codigo").description, "Revisa el código con cuidado");
  assert.equal(list.find((s) => s.name === "interna").userInvocable, false);
  // Sin las carpetas de otros programas solo quedan las de vipcode
  assert.deepEqual(
    skills.loadSkills(root, { ...cfg, skills: { ...cfg.skills, external: false } }).map((s) => s.name),
    ["informes"],
  );

  const tool = skills.skillTool(list);
  assert.match(tool.description, /- informes: Úsala para escribir informes semanales/);
  const loaded = await tool.run({ name: "informes" });
  assert.match(loaded, /<skill name="informes"/);
  assert.match(loaded, /Lee references\/plantilla\.md/);
  assert.match(loaded, /- references\/plantilla\.md/);
  assert.match(await tool.run({ name: "informes", file: "references/plantilla.md" }), /PLANTILLA-SECRETA/);
  assert.match(await tool.run({ name: "informes", file: "../../.." }), /fuera de la carpeta/);
  assert.match(await tool.run({ name: "no-existe" }), /^Error: no hay ninguna skill/);
  fs.rmSync(path.join(HOME, "skills"), { recursive: true, force: true });
  fs.rmSync(path.join(HOME, ".claude"), { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("skills: instalar desde una carpeta o un repositorio git, crear y borrar", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-skills-"));
  const source = path.join(root, "descargadas");
  writeFile(path.join(source, "skills", "uno", "SKILL.md"), "---\nname: uno\ndescription: primera\n---\nUNO");
  writeFile(path.join(source, "skills", "uno", "scripts", "hola.sh"), "echo hola");
  writeFile(path.join(source, "skills", "dos", "SKILL.md"), "---\nname: dos\ndescription: segunda\n---\nDOS");
  let result = skills.installSkills(source, root);
  assert.deepEqual(result.installed.map((item) => item.name).sort(), ["dos", "uno"]);
  assert.ok(fs.existsSync(path.join(HOME, "skills", "uno", "scripts", "hola.sh")));
  // Otra vez: ya existen, salvo con force
  result = skills.installSkills(source, root);
  assert.equal(result.installed.length, 0);
  assert.equal(result.skipped.length, 2);
  assert.equal(skills.installSkills(path.join(source, "skills", "uno"), root, { force: true }).installed.length, 1);

  // Desde un repositorio git; con project va a .vipcode/skills del proyecto y sin la carpeta .git
  const repo = path.join(root, "remoto");
  writeFile(path.join(repo, "tres", "SKILL.md"), "---\nname: tres\ndescription: del repositorio\n---\nTRES");
  const git = (...args) => spawnSync("git", ["-c", "user.name=prueba", "-c", "user.email=prueba@example.com", ...args], { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("add", ".");
  assert.equal(git("commit", "-q", "-m", "skills").status, 0);
  result = skills.installSkills(`file://${repo}`, root, { project: true });
  assert.deepEqual(
    result.installed.map((item) => item.name),
    ["tres"],
  );
  assert.ok(fs.existsSync(path.join(root, ".vipcode", "skills", "tres", "SKILL.md")));
  assert.throws(() => skills.installSkills(`file://${path.join(root, "no-existe")}`, root), /No he podido descargar/);

  const dir = skills.createSkill("Mi Skill", root, false);
  assert.equal(dir, path.join(HOME, "skills", "mi-skill"));
  assert.match(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), /^---\nname: mi-skill\ndescription: /);
  assert.throws(() => skills.createSkill("mi-skill", root, false), /Ya existe/);
  assert.equal(skills.removeSkill("mi-skill", root, config.DEFAULT_CONFIG), dir);
  assert.ok(!fs.existsSync(dir));
  assert.throws(() => skills.removeSkill("no-existe", root, config.DEFAULT_CONFIG), /No hay ninguna skill/);
  fs.rmSync(path.join(HOME, "skills"), { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("actualizaciones: comparar versiones y mirar en GitHub como mucho una vez al día", async () => {
  const update = await import("../dist/update.js");
  assert.ok(update.compareVersions("v0.10.1", "0.9.3") > 0);
  assert.equal(update.compareVersions("0.2.0", "v0.2.0"), 0);
  assert.ok(update.compareVersions("0.2.0", "0.3.0-beta.1") < 0);
  assert.ok(update.compareVersions("1.0", "0.99.99") > 0);
  const { startMock } = await import("./helpers/mock-llm.mjs");
  // npm y GitHub simulados: cada prueba cambia lo que responden
  let npm = { status: 404, json: {} };
  let github = { status: 404, json: {} };
  const tarball = (version) => ({ json: { tag_name: `v${version}`, assets: [{ name: "vipcode.tgz", browser_download_url: `https://descargas/${version}/vipcode.tgz` }] } });
  const ours = (version) => ({ json: { name: "vipcode", version, repository: { url: "git+https://github.com/PabloVip/vipcode.git" } } });
  const mock = await startMock(({ path: url }) => (url === "/npm/vipcode/latest" ? npm : url.endsWith("/releases/latest") ? github : { status: 404, json: {} }));
  process.env.VIPCODE_UPDATE_URL = `${mock.url}/repos/PabloVip/vipcode`;
  process.env.VIPCODE_REGISTRY_URL = `${mock.url}/npm`;
  try {
    github = tarball("9.9.9");
    assert.equal(await update.checkForUpdate(), "9.9.9");
    // La segunda vez sale de la caché, sin preguntar a nadie
    assert.equal(await update.checkForUpdate(), "9.9.9");
    assert.equal(mock.requests.length, 2);

    // Con la misma versión en los dos sitios se instala la de npm; si GitHub va por delante, la de GitHub
    npm = ours("9.9.9");
    assert.deepEqual(await update.latestRelease(), { version: "9.9.9", spec: "vipcode@9.9.9", source: "npm" });
    github = tarball("10.0.0");
    assert.deepEqual(await update.latestRelease(), { version: "10.0.0", spec: "https://descargas/10.0.0/vipcode.tgz", source: "GitHub" });
    // Un paquete «vipcode» de npm que no es este proyecto no cuenta
    npm = { json: { name: "vipcode", version: "99.0.0", repository: "https://github.com/otra-persona/vipcode" } };
    assert.equal((await update.latestRelease()).source, "GitHub");
    // Sin nada publicado, null; si no responde ninguno, error
    github = { status: 404, json: {} };
    assert.equal(await update.latestRelease(), null);
    npm = { status: 500, json: {} };
    github = { status: 500, json: {} };
    await assert.rejects(update.latestRelease(), /no he podido consultar npm ni GitHub/);
  } finally {
    delete process.env.VIPCODE_UPDATE_URL;
    delete process.env.VIPCODE_REGISTRY_URL;
    fs.rmSync(path.join(HOME, "update.json"), { force: true });
    await mock.close();
  }
});

