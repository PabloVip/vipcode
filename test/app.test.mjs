import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT, contentText, lastMessage, lastUserText, provider, startMock, tempWorkspace } from "./helpers/mock-llm.mjs";

// Una carpeta de datos para todo el fichero (los módulos la leen al cargarse)
const shared = tempWorkspace();
process.env.VIPCODE_HOME = shared.home;
process.env.HOME = shared.home;
for (const name of Object.keys(process.env)) {
  if (/_API_KEY$|_TOKEN$/.test(name)) {
    delete process.env[name];
  }
}
const { App } = await import("../dist/app.js");

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
      return { tools: [{ name: "calc_sumar", args: { a: 2, b: 3 } }] };
    }
    return { text: `resultado ${contentText(last.content)}` };
  });
  const ws = tempWorkspace();
  const { app, events } = makeApp(ws, mock.url, {
    mcp: { calc: { type: "local", command: ["node", path.join(ROOT, "test", "fixtures", "mcp-server.mjs")] } },
  });
  await app.startMcp();
  assert.deepEqual(
    app.mcp.status().map((s) => [s.name, s.state, s.tools]),
    [["calc", "conectado", 1]],
  );
  await app.runPrompt({ text: "suma 2 y 3" }, {});
  assert.match(events.text, /resultado 5/);
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
  assert.deepEqual(result.run, { input: { text: "Ejecuta los tests de src/app" }, options: { agent: "plan", model: undefined, subtask: false } });
  result = await app.handleCommand("/plan", adapter);
  assert.equal(app.agent.agent.name, "plan");
  assert.equal(app.cycleAgent().name, "build");
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
