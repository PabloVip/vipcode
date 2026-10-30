import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT, contentText, lastMessage, lastUserText, provider, startMock, tempWorkspace } from "./helpers/mock-llm.mjs";

// Una carpeta de datos para todo el fichero (los módulos la leen al cargarse)
const shared = tempWorkspace();
process.env.VIPCODE_HOME = shared.home;
process.env.HOME = shared.home;
// Sin colores aunque se ejecute en GitHub Actions (allí picocolors los activa por la variable CI);
// node --test pone FORCE_COLOR en una terminal y Node avisaría de que choca con NO_COLOR
delete process.env.FORCE_COLOR;
process.env.NO_COLOR = "1";
for (const name of Object.keys(process.env)) {
  if (/_API_KEY$|_TOKEN$/.test(name)) {
    delete process.env[name];
  }
}
const { App } = await import("../dist/app.js");
const sessions = await import("../dist/session.js");

function makeApp(ws, url, extra = {}) {
  fs.writeFileSync(
    path.join(shared.home, "config.json"),
    JSON.stringify({ providers: [provider("p", url, ["m"])], enabledProviders: ["p"], autoUpdateModels: false, ...extra }),
  );
  const app = new App(ws.proj);
  app.setYolo(true);
  const events = { text: "", tools: [], infos: [], notices: [] };
  app.agent.events = {
    onText: (chunk, depth) => {
      if (!depth) {
        events.text += chunk;
      }
    },
    onToolEnd: (event) => events.tools.push(event),
    onInfo: (message) => events.infos.push(message),
    onNotice: (message) => events.notices.push(message),
  };
  return { app, events };
}

const capture = () => {
  const out = { info: [], notice: [], error: [], block: [] };
  return {
    out,
    adapter: {
      info: (t) => out.info.push(t),
      notice: (t) => out.notice.push(t),
      error: (t) => out.error.push(t),
      block: (t) => out.block.push(t),
    },
  };
};

test("/undo y /redo deshacen ficheros (también lo que hizo bash) y la conversación", async () => {
  const mock = await startMock(({ body }) => {
    if (lastMessage(body).role === "user") {
      return {
        tools: [
          { name: "read_file", args: { path: "hola.txt" } },
          { name: "edit_file", args: { path: "hola.txt", old_string: "uno", new_string: "dos" } },
          { name: "bash", args: { command: "echo nuevo > creado.txt && mkdir -p sub && echo x > sub/y.txt" } },
        ],
      };
    }
    return { text: "listo" };
  });
  const ws = tempWorkspace({ "hola.txt": "uno\n" });
  const { app } = makeApp(ws, mock.url);
  await app.runPrompt({ text: "cambia" }, {});
  assert.equal(ws.read("hola.txt"), "dos\n");
  assert.ok(ws.exists("creado.txt") && ws.exists("sub/y.txt"));
  assert.equal(app.agent.session.messages.length, 6);

  const { out, adapter } = capture();
  await app.handleCommand("/diff", adapter);
  assert.match(out.block.join("\n"), /-uno[\s\S]*\+dos/);

  const undone = await app.agent.undo();
  assert.ok(undone.restoredMessages);
  assert.equal(undone.text, "cambia");
  assert.deepEqual(undone.files.sort(), ["creado.txt", "hola.txt", "sub/y.txt"]);
  assert.equal(ws.read("hola.txt"), "uno\n");
  assert.ok(!ws.exists("creado.txt") && !ws.exists("sub"));
  assert.equal(app.agent.session.messages.length, 0);

  await app.agent.redo();
  assert.equal(ws.read("hola.txt"), "dos\n");
  assert.ok(ws.exists("creado.txt"));
  assert.equal(app.agent.session.messages.length, 6);
  await app.shutdown();
  await mock.close();
  ws.cleanup();
});

test("LSP: tras editar un .ts el modelo recibe los errores de tipos", async () => {
  const mock = await startMock(({ body }) => {
    if (lastMessage(body).role === "user") {
      return {
        tools: [
          { name: "read_file", args: { path: "src/a.ts" } },
          { name: "edit_file", args: { path: "src/a.ts", old_string: "= 1", new_string: '= "uno"' } },
        ],
      };
    }
    return { text: "ya" };
  });
  const ws = tempWorkspace({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext" } }),
    "src/a.ts": "export const n: number = 1;\n",
  });
  const { app, events } = makeApp(ws, mock.url);
  await app.runPrompt({ text: "rompe el tipo" }, {});
  const edit = events.tools.find((tool) => tool.name === "edit_file");
  assert.match(edit.output, /src\/a\.ts:1:14 error ts2322: Type 'string' is not assignable to type 'number'/i);
  const { out, adapter } = capture();
  await app.handleCommand("/lsp", adapter);
  assert.match(out.block.join("\n"), /typescript +activo/);
  await app.shutdown();
  await mock.close();
  ws.cleanup();
});

test("MCP: conecta un servidor local y el agente usa su herramienta", async () => {
  const mock = await startMock(({ body }) => {
    const last = lastMessage(body);
    if (last.role === "user") {
      return { tools: [{ name: lastUserText(body).includes("entorno") ? "calc_entorno" : "calc_sumar", args: { a: 2, b: 3 } }] };
    }
    return { text: `resultado ${contentText(last.content)}` };
  });
  const ws = tempWorkspace();
  // Una clave en tu entorno que el servidor no debe recibir, y una variable que se le pasa a propósito
  process.env.GEMINI_API_KEY = "clave-que-no-debe-salir";
  process.env.VIPCODE_PRUEBA_MCP = "valor-pasado";
  const { app, events } = makeApp(ws, mock.url, {
    mcp: { calc: { type: "local", command: ["node", path.join(ROOT, "test", "fixtures", "mcp-server.mjs")], environment: { PASADA: "{env:VIPCODE_PRUEBA_MCP}" } } },
  });
  await app.startMcp();
  assert.deepEqual(
    app.mcp.status().map((s) => [s.name, s.state, s.tools]),
    [["calc", "conectado", 2]],
  );
  await app.runPrompt({ text: "suma 2 y 3" }, {});
  assert.match(events.text, /resultado 5/);
  // No hereda tu entorno entero: ni la clave de Gemini; sí PATH y lo que se le pasa con {env:…}
  events.text = "";
  await app.runPrompt({ text: "dime tu entorno" }, {});
  assert.match(events.text, /resultado \{"gemini":null,"pasada":"valor-pasado","path":true\}/);
  delete process.env.GEMINI_API_KEY;
  delete process.env.VIPCODE_PRUEBA_MCP;
  const definition = mock.chats()[0].body.tools.find((tool) => tool.function.name === "calc_sumar");
  assert.equal(definition.function.parameters.type, "object");
  assert.ok(!("$schema" in definition.function.parameters));
  // En modo plan solo entran las herramientas MCP marcadas como de solo lectura (esta lo está)
  app.agent.setAgent("plan");
  assert.ok(app.agent.toolsFor(app.agent.agent, 0).some((tool) => tool.name === "calc_sumar"));
  await app.shutdown();
  await mock.close();
  ws.cleanup();
});

test("mensajes escritos mientras trabaja: se le entregan al acabar el paso", async () => {
  let first = true;
  const mock = await startMock(async ({ body }) => {
    if (first) {
      first = false;
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { tools: [{ name: "list_dir", args: {} }] };
    }
    return { text: `recibido: ${lastUserText(body)}` };
  });
  const ws = tempWorkspace({ "a.txt": "a" });
  const { app, events } = makeApp(ws, mock.url);
  const running = app.runPrompt({ text: "empieza" }, {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  app.agent.queue.push({ text: "y además revisa b" });
  await running;
  assert.match(events.text, /recibido: \[Mensaje nuevo del usuario mientras trabajabas\] y además revisa b/);
  assert.equal(app.agent.queue.length, 0);
  await app.shutdown();
  await mock.close();
  ws.cleanup();
});

test("resumen automático cuando la conversación no cabe", async () => {
  const mock = await startMock(({ body }) => {
    const text = lastUserText(body);
    if (text.includes("Summarize this conversation")) {
      return { text: "RESUMEN: el usuario leyó grande.txt" };
    }
    if (lastMessage(body).role === "user" && text.startsWith("lee")) {
      return { tools: [{ name: "read_file", args: { path: "grande.txt" } }] };
    }
    return { text: `vale (${body.messages.length} mensajes)` };
  });
  const ws = tempWorkspace({ "grande.txt": "palabra ".repeat(6000) });
  const { app, events } = makeApp(ws, mock.url, { autoCompactTokens: 7000 });
  await app.runPrompt({ text: "lee grande.txt" }, {});
  assert.equal(app.agent.session.messages.length, 4);
  await app.runPrompt({ text: "sigue" }, {});
  assert.ok(mock.chats().some((r) => lastUserText(r.body).includes("Summarize this conversation")));
  assert.match(contentText(app.agent.session.messages[0].content), /RESUMEN: el usuario leyó grande\.txt/);
  assert.equal(app.agent.session.epoch, 1);
  assert.ok(events.infos.some((m) => m.includes("Conversación resumida")));
  await app.shutdown();
  await mock.close();
  ws.cleanup();
});

test("comandos con plantilla, agentes y ayuda", async () => {
  const mock = await startMock(() => ({ text: "ok" }));
  const ws = tempWorkspace({ ".vipcode/commands/test.md": "---\ndescription: Pasa los tests\nagent: plan\n---\nEjecuta los tests de $ARGUMENTS" });
  const { app } = makeApp(ws, mock.url);
  const { out, adapter } = capture();
  let result = await app.handleCommand("/test src/app", adapter);
  // Al modelo le llega la plantilla; en el historial queda lo que escribiste
  assert.deepEqual(result.run, { input: { text: "Ejecuta los tests de src/app", display: "/test src/app" }, options: { agent: "plan", model: undefined, subtask: false } });
  // Los agentes tienen nombre propio; los de antes (/plan, /build) siguen valiendo
  result = await app.handleCommand("/plan", adapter);
  assert.equal(app.agent.agent.name, "planear");
  assert.equal(app.cycleAgent().name, "profe");
  assert.equal(app.cycleAgent().name, "programar");
  await app.handleCommand("/planear", adapter);
  assert.equal(app.agent.agent.name, "planear");
  await app.handleCommand("/agent build", adapter);
  assert.equal(app.agent.agent.name, "programar");
  await app.handleCommand("/help", adapter);
  assert.match(out.block.join("\n"), /\/test +Pasa los tests/);
  await app.handleCommand("/nada", adapter);
  assert.match(out.error.join("\n"), /Comando desconocido/);
  await app.handleCommand("/model p/m", adapter);
  assert.equal(app.router.pinned, "p/m");
  await app.shutdown();
  await mock.close();
  ws.cleanup();
});

test("un subagente lanzado desde el modo plan tampoco puede editar", async () => {
  const mock = await startMock(({ body }) => {
    const system = contentText(body.messages[0].content);
    const last = lastMessage(body);
    if (system.includes("You are a subagent")) {
      const names = body.tools.map((t) => t.function.name);
      return { text: `herramientas del subagente: ${names.includes("edit_file") || names.includes("bash") ? "con escritura" : "solo lectura"}` };
    }
    if (last.role === "user") {
      return { tools: [{ name: "task", args: { description: "probar", prompt: "haz algo", subagent_type: "general" } }] };
    }
    return { text: contentText(last.content) };
  });
  const ws = tempWorkspace();
  const { app, events } = makeApp(ws, mock.url);
  app.agent.setAgent("plan");
  await app.runPrompt({ text: "investiga" }, {});
  assert.match(events.text, /herramientas del subagente: solo lectura/);
  await app.shutdown();
  await mock.close();
  ws.cleanup();
});

test("varios task seguidos se ejecutan a la vez", async () => {
  const mock = await startMock(async ({ body }) => {
    const system = contentText(body.messages[0].content);
    const last = lastMessage(body);
    if (system.includes("exploration subagent")) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { text: `informe de ${lastUserText(body)}` };
    }
    if (last.role === "user") {
      return {
        tools: [
          { name: "task", args: { description: "uno", prompt: "A", subagent_type: "explore" } },
          { name: "task", args: { description: "dos", prompt: "B", subagent_type: "explore" } },
          { name: "task", args: { description: "tres", prompt: "C", subagent_type: "explore" } },
        ],
      };
    }
    return { text: "hecho" };
  });
  const ws = tempWorkspace();
  const { app } = makeApp(ws, mock.url);
  const started = Date.now();
  await app.runPrompt({ text: "reparte" }, {});
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 850, `tardó ${elapsed} ms`);
  const tools = app.agent.session.messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.deepEqual(tools, ["informe de A", "informe de B", "informe de C"]);
  await app.shutdown();
  await mock.close();
  ws.cleanup();
});

test("sesiones: el historial guarda toda la conversación aunque se resuma, y se escribe solo en .md", async () => {
  const mock = await startMock(({ body }) => {
    const last = lastMessage(body);
    const text = contentText(last.content);
    if (last.role === "tool") {
      return { text: "LISTO-DESPUES-DE-LEER" };
    }
    if (text.includes("Summarize this conversation")) {
      return { text: "RESUMEN-CORTO" };
    }
    if (text.startsWith("lee")) {
      return { tools: [{ name: "read_file", args: { path: "nota.txt" } }] };
    }
    return { text: "RESPUESTA-NORMAL" };
  });
  const ws = tempWorkspace({ "nota.txt": "hola\n" });
  const { app } = makeApp(ws, mock.url);
  await app.runPrompt({ text: "lee nota.txt" }, {});
  // Un comando: al modelo le llega su plantilla y en el historial queda lo que escribiste
  await app.runPrompt({ text: "PLANTILLA-LARGA del comando", display: "/mi-comando" }, {});
  await app.agent.compact();
  await app.runPrompt({ text: "después del resumen" }, {});

  const session = app.agent.session;
  const log = session.log.map((entry) => `${entry.role}:${entry.tool ? entry.tool.name : entry.text.slice(0, 22)}`);
  assert.deepEqual(log, [
    "user:lee nota.txt",
    "tool:read_file",
    "assistant:LISTO-DESPUES-DE-LEER",
    "user:/mi-comando",
    "assistant:RESPUESTA-NORMAL",
    "info:Conversación resumida ",
    "user:después del resumen",
    "assistant:RESPUESTA-NORMAL",
  ]);
  assert.equal(session.log[2].model, "p/m");
  // El modelo ya no tiene lo de antes del resumen, pero el historial sí
  assert.ok(!JSON.stringify(session.messages).includes("lee nota.txt"));
  const md = fs.readFileSync(sessions.sessionMarkdownPath(session), "utf8");
  for (const piece of ["# lee nota.txt", "### Tú", "lee nota.txt", "- **Lee** `nota.txt`", "### vipcode · p/m", "LISTO-DESPUES-DE-LEER", "/mi-comando", "_Conversación resumida", "después del resumen"]) {
    assert.ok(md.includes(piece), `falta «${piece}» en:\n${md}`);
  }
  assert.ok(!md.includes("PLANTILLA-LARGA"));

  // Volver a ella con /sessions
  app.newSession();
  assert.equal(app.agent.session.log.length, 0);
  const result = await app.handleCommand("/sessions", { ...capture().adapter, select: async (_title, items) => items[0].value });
  assert.equal(result.loaded, true);
  assert.equal(app.agent.session.id, session.id);
  assert.ok(app.agent.session.log.some((entry) => entry.text === "lee nota.txt"));

  // Una sesión de antes, sin historial, lo saca de sus mensajes
  const old = {
    id: "20260101-000000-old",
    title: "vieja",
    cwd: ws.proj,
    created: 1,
    updated: 2,
    messages: [
      { role: "user", content: "pregunta vieja" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } }] },
      { role: "tool", tool_call_id: "c1", content: "contenido" },
      { role: "assistant", content: "respuesta vieja" },
    ],
  };
  fs.mkdirSync(path.join(shared.home, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(shared.home, "sessions", `${old.id}.json`), JSON.stringify(old));
  const loaded = sessions.loadSession(old.id);
  assert.deepEqual(
    loaded.log.map((entry) => `${entry.role}:${entry.tool ? `${entry.tool.name} ${entry.tool.summary}` : entry.text}`),
    ["user:pregunta vieja", "tool:read_file a.txt", "assistant:respuesta vieja"],
  );
  // Y al listar las sesiones también le aparece su .md
  sessions.listSessions(ws.proj);
  assert.match(fs.readFileSync(sessions.sessionMarkdownPath(loaded), "utf8"), /### Tú · [^\n]+\n\npregunta vieja[\s\S]*respuesta vieja/);
  await mock.close();
  ws.cleanup();
});


test("límites: cuánto queda de cada plan gratis (/limites y la barra de abajo)", async () => {
  const { quotaFor } = await import("../dist/limits.js");
  const mock = await startMock(({ path: url }) => {
    // Como Groq: dice en las cabeceras cuántas peticiones le quedan hoy y cuántos tokens por minuto
    if (url.startsWith("/cabeceras/")) {
      return {
        text: "uno",
        headers: {
          "x-ratelimit-limit-requests": "1000",
          "x-ratelimit-remaining-requests": "997",
          "x-ratelimit-reset-requests": "2m59.56s",
          "x-ratelimit-limit-tokens": "12000",
          "x-ratelimit-remaining-tokens": "11200",
          "x-ratelimit-reset-tokens": "6s",
        },
      };
    }
    if (url.startsWith("/lleno/")) {
      return { status: 429, json: { error: { message: "Rate limit exceeded" } }, headers: { "retry-after": "600" } };
    }
    return { text: "dos" };
  });
  const ws = tempWorkspace();
  const { app } = makeApp(ws, mock.url, {
    providers: [
      provider("cabeceras", mock.url, ["m"], { rateHeaders: { requests: "day", tokens: "minute" } }),
      // No dice nada: se cuenta con el límite conocido de su plan
      provider("contado", mock.url, ["m"], { freeLimits: { perDay: 50 }, limitScope: "provider" }),
      provider("lleno", mock.url, ["m"]),
    ],
    enabledProviders: ["cabeceras", "contado", "lleno"],
  });
  // El último se queda sin peticiones y vipcode salta a otro
  for (const key of ["cabeceras/m", "contado/m", "contado/m", "lleno/m"]) {
    app.router.pinned = key;
    await app.runPrompt({ text: "hola" }, {});
  }
  const { out, adapter } = capture();
  await app.handleCommand("/limites", adapter);
  const report = out.block.join("\n");
  assert.match(report, /cabeceras: 2 peticiones/);
  assert.match(report, /quedan 997 de 1000 hoy/);
  assert.match(report, /quedan 11 k de 12 k tokens por minuto/);
  assert.match(report, /contado: 2 peticiones · ≈ quedan 48 de 50 hoy/);
  // Cerca de la medianoche la pausa acaba «mañana a las…»
  assert.match(report, /lleno: 1 petición\n +m +1 petición · en pausa hasta (mañana a )?las \d\d:\d\d/);
  // Lo que se enseña en la barra de abajo
  assert.equal(quotaFor(app.router, app.router.slotFor("contado/m")).text, "≈ quedan 48 de 50 hoy");
  // Se guarda para la próxima vez que abras vipcode
  const again = new App(ws.proj);
  assert.equal(again.router.today().providers.contado.requests, 2);
  assert.equal(quotaFor(again.router, again.router.slotFor("cabeceras/m")).text, "quedan 997 de 1000 hoy");
  await app.shutdown();
  await again.shutdown();
  await mock.close();
  ws.cleanup();
});

test("novedades al abrir una versión nueva y /copiar (sin caracteres invisibles)", async () => {
  const { VERSION } = await import("../dist/meta.js");
  const changelog = await import("../dist/changelog.js");
  const notices = path.join(shared.home, "notices.json");
  const before = fs.existsSync(notices) ? fs.readFileSync(notices, "utf8") : null;
  // Un modelo que intenta colar una secuencia para salir del pegado seguro y texto al revés
  const mock = await startMock(() => ({ text: "Mira:\n```js\nconst x = 1;\u001b[201~\u202eecho hack\n```\nListo." }));
  const ws = tempWorkspace();
  const { app } = makeApp(ws, mock.url);

  // La primera vez que se abre vipcode no hay novedades que contar, pero se apunta la versión
  fs.rmSync(notices, { force: true });
  assert.equal(app.takeNews(), null);
  assert.equal(JSON.parse(fs.readFileSync(notices, "utf8")).lastVersion, VERSION);
  // Vienes de una versión anterior: lo que traen las nuevas (una sola vez)
  fs.writeFileSync(notices, JSON.stringify({ privacy: "x", lastVersion: "0.2.5" }));
  const news = app.takeNews();
  assert.equal(news.version, VERSION);
  assert.match(news.markdown, /\*\*\d+\.\d+\.\d+\*\*/);
  assert.equal(news.security, changelog.hasSecurity(changelog.sectionsBetween(changelog.localChangelog(), "0.2.5", VERSION).slice(0, 5)));
  assert.equal(app.takeNews(), null);
  // Ya usabas vipcode antes de que se apuntara la versión: lo de esta, y nada más
  fs.writeFileSync(notices, JSON.stringify({ privacy: "x" }));
  const current = app.takeNews();
  assert.ok(current === null || current.markdown.match(/\*\*\d+\.\d+\.\d+\*\*/g).length === 1);

  // /copiar con un «portapapeles» de prueba (para no tocar el tuyo)
  const copied = path.join(ws.dir, "copiado.txt");
  process.env.VIPCODE_CLIPBOARD = `"${process.execPath}" "${path.join(ROOT, "test", "fixtures", "copiar.mjs")}" "${copied}"`;
  const { out, adapter } = capture();
  await app.handleCommand("/copiar", adapter);
  assert.match(out.error.join("\n"), /Todavía no hay ninguna respuesta/);
  await app.runPrompt({ text: "dame código" }, {});
  await app.handleCommand("/copiar código", adapter);
  assert.equal(fs.readFileSync(copied, "utf8"), "const x = 1;echo hack");
  assert.match(out.info.join("\n"), /Copiado el último bloque de código al portapapeles \(21 caracteres\)/);
  await app.handleCommand("/copiar", adapter);
  assert.equal(fs.readFileSync(copied, "utf8"), "Mira:\n```js\nconst x = 1;echo hack\n```\nListo.");
  delete process.env.VIPCODE_CLIPBOARD;
  if (before === null) {
    fs.rmSync(notices, { force: true });
  } else {
    fs.writeFileSync(notices, before);
  }
  await app.shutdown();
  await mock.close();
  ws.cleanup();
});

test("límites: si quedan pocas peticiones gratis hoy, se sugiere una cuenta gratis que da más (una vez)", async () => {
  const mock = await startMock(() => ({ text: "HOLA" }));
  const ws = tempWorkspace();
  const { quotaFor } = await import("../dist/limits.js");
  // Con un nombre que no usa ninguna otra prueba: lo gastado hoy se guarda en la carpeta de datos compartida
  const { app } = makeApp(ws, mock.url, {
    providers: [provider("pocas", mock.url, ["m"], { label: "Proveedor P (gratis)", limitScope: "provider", freeLimits: { perDay: 10 } })],
    enabledProviders: ["pocas"],
  });
  let tip = null;
  for (let i = 0; i < 10 && !tip; i++) {
    await app.runPrompt({ text: `hola ${i}` }, {});
    tip = app.lowQuotaTip();
    // Solo cuando quedan pocas: 3 o menos de 10
    const left = quotaFor(app.router, app.router.slotFor("pocas/m")).remaining;
    assert.equal(tip !== null, left <= 3, `quedan ${left}: ${tip}`);
  }
  assert.match(tip, /^Te queda(n \d+ peticiones| 1 petición) gratis hoy en Proveedor P\. Cuando se acaben, vipcode seguirá solo con otro proveedor\./, tip);
  assert.match(tip, /\/connect cerebras \(14\.400 al día por modelo\) o \/connect groq \(1000 al día por modelo\)/, tip);
  // Una vez por proveedor
  await app.runPrompt({ text: "otra" }, {});
  assert.equal(app.lowQuotaTip(), null);
  await app.shutdown();
  await mock.close();
  ws.cleanup();
});

test("/bug abre GitHub con el informe de /doctor ya puesto, sin claves ni colores", async () => {
  const mock = await startMock(({ path: url }) => (url.endsWith("/models") ? { json: { data: [{ id: "m" }] } } : { status: 404, json: {} }));
  const ws = tempWorkspace();
  const { app } = makeApp(ws, mock.url);
  // Un «navegador» que apunta el enlace que le llega
  const file = path.join(ws.dir, "enlace.txt");
  const script = path.join(ws.dir, "navegador.mjs");
  fs.writeFileSync(script, `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(file)}, process.argv[2]);\n`);
  process.env.VIPCODE_BROWSER = `"${process.execPath}" "${script}"`;
  process.env.VIPCODE_UPDATE_URL = `${mock.url}/repos/PabloVip/vipcode`;
  process.env.VIPCODE_REGISTRY_URL = `${mock.url}/npm`;
  try {
    const { out, adapter } = capture();
    await app.handleCommand("/bug se cuelga con mi clave sk-abcdefghijklmnopqrst", adapter);
    for (let i = 0; i < 100 && !fs.existsSync(file); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(out.info.join("\n"), /He abierto GitHub en tu navegador/);
    const url = new URL(fs.readFileSync(file, "utf8"));
    assert.equal(`${url.origin}${url.pathname}`, "https://github.com/PabloVip/vipcode/issues/new");
    assert.equal(url.searchParams.get("title"), "se cuelga con mi clave [clave oculta]");
    const body = url.searchParams.get("body");
    assert.match(body, /### Qué ha pasado\n\nse cuelga con mi clave \[clave oculta\]/);
    assert.match(body, /### Informe de vipcode doctor[\s\S]*vipcode \d+\.\d+\.\d+/);
    assert.match(body, /p: clave correcta/);
    assert.ok(!url.href.includes("abcdefghijklmnopqrst") && !body.includes("\x1b"), body);
  } finally {
    delete process.env.VIPCODE_BROWSER;
    delete process.env.VIPCODE_UPDATE_URL;
    delete process.env.VIPCODE_REGISTRY_URL;
    await app.shutdown();
    await mock.close();
    ws.cleanup();
  }
});

