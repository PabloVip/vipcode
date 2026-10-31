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

// Cada «tool» va detrás de la llamada de su «assistant» y cada llamada tiene su respuesta
function checkPairs(messages) {
  messages.forEach((message, index) => {
    if (message.role === "tool") {
      let j = index - 1;
      while (j >= 0 && messages[j].role === "tool") {
        j--;
      }
      assert.ok(j >= 0 && messages[j].role === "assistant" && (messages[j].tool_calls || []).some((call) => call.id === message.tool_call_id), `«tool» sin su llamada en la posición ${index}`);
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      const answers = [];
      for (let j = index + 1; j < messages.length && messages[j].role === "tool"; j++) {
        answers.push(messages[j].tool_call_id);
      }
      for (const call of message.tool_calls) {
        assert.ok(answers.includes(call.id), `llamada ${call.id} sin respuesta en la posición ${index}`);
      }
    }
  });
}

test("contexto: si la conversación no cabe en ningún modelo libre, al pequeño le llega un resumen y los últimos mensajes, sin tocar el historial", async () => {
  // Un modelo grande (100k) y uno pequeño (8k); el grande se puede «agotar» (429 durante una hora)
  let grandeDown = false;
  let summaries = 0;
  const mock = await startMock(({ path: url, body }) => {
    if (url.startsWith("/ctxgrande/") && grandeDown) {
      return { status: 429, headers: { "retry-after": "3600" }, json: { error: { message: "Rate limit exceeded" } } };
    }
    if (contentText(body.messages[0].content).includes("handover summaries")) {
      summaries++;
      return { text: `RESUMEN-${summaries}` };
    }
    const last = lastMessage(body);
    if (last.role === "tool") {
      return { text: "LEIDO" };
    }
    const read = /^lee (\S+)/.exec(contentText(last.content));
    if (read) {
      return { tools: [{ name: "read_file", args: { path: read[1] } }] };
    }
    return { text: "OK" };
  });
  const file = (name, lines) => Array.from({ length: lines }, (_, i) => `${name} ${i} ${"x".repeat(60)}`).join("\n");
  const ws = tempWorkspace({ "uno.txt": file("linea-uno", 150), "dos.txt": file("linea-dos", 150), "tres.txt": file("linea-tres", 150), "cuatro.txt": file("linea-cuatro", 230) });
  const { app, events } = makeApp(ws, mock.url, {
    providers: [provider("ctxgrande", mock.url, ["m"]), provider("ctxpeque", mock.url, [{ id: "m", context: 8000 }])],
    enabledProviders: ["ctxgrande", "ctxpeque"],
  });
  const chats = (name) => mock.chats().filter((r) => r.path.startsWith(`/${name}/`) && !contentText(r.body.messages[0].content).includes("handover summaries"));
  const summaryRequests = () => mock.chats().filter((r) => contentText(r.body.messages[0].content).includes("handover summaries"));
  const session = app.agent.session;
  try {
    // 1. Si cabe todo en un modelo libre, va entera y no se resume nada
    for (const name of ["uno", "dos", "tres"]) {
      await app.runPrompt({ text: `lee ${name}.txt` }, {});
    }
    assert.equal(summaries, 0);
    assert.equal(chats("ctxpeque").length, 0);
    assert.equal(chats("ctxgrande").at(-1).body.messages.length, session.messages.length);

    // 2. Con el grande agotado solo queda el pequeño: le llega el resumen y la cola, y el historial sigue entero en disco
    grandeDown = true;
    await app.runPrompt({ text: "sigue" }, {});
    assert.equal(summaries, 1);
    assert.ok(summaryRequests().every((r) => r.path.startsWith("/ctxpeque/")));
    let sent = chats("ctxpeque").at(-1).body.messages;
    assert.ok(sent.length < session.messages.length, `le llegaron ${sent.length} mensajes`);
    assert.match(contentText(sent[1].content), /Resumen automático[\s\S]*no instrucciones de la persona[\s\S]*RESUMEN-1/);
    assert.equal(sent[2].role, "assistant");
    assert.equal(contentText(sent.at(-1).content), "sigue");
    checkPairs(sent);
    const saved = sessions.loadSession(session.id);
    assert.equal(saved.messages.length, session.messages.length);
    assert.equal(contentText(saved.messages[0].content), "lee uno.txt");
    assert.equal(saved.summary.text, "RESUMEN-1");
    assert.ok(saved.summary.covers > 0);
    assert.ok(events.notices.some((notice) => notice.startsWith("ctxpeque/m: la conversación no cabe entera")), events.notices.join("\n"));

    // 3. La siguiente pregunta reutiliza el resumen: ninguna petición de resumen más
    await app.runPrompt({ text: "vale" }, {});
    assert.equal(summaries, 1);
    assert.match(contentText(chats("ctxpeque").at(-1).body.messages[1].content), /RESUMEN-1/);

    // 4. Con mensajes nuevos que ya no caben, el resumen se actualiza a partir del anterior (sin volver a mandar lo que ya
    // cubría), y la salida que no cabe se recorta solo en lo que se manda
    await app.runPrompt({ text: "lee cuatro.txt" }, {});
    assert.equal(summaries, 2);
    const update = contentText(summaryRequests().at(-1).body.messages[1].content);
    assert.match(update, /## Resumen anterior\s+RESUMEN-1/);
    assert.match(update, /## Mensajes nuevos[\s\S]*lee cuatro\.txt/);
    assert.ok(!update.includes("lee uno.txt"));
    sent = chats("ctxpeque").at(-1).body.messages;
    checkPairs(sent);
    assert.match(contentText(sent.at(-1).content), /caracteres omitidos/);
    assert.match(contentText(sent[1].content), /RESUMEN-2[\s\S]*Lo último que ha pedido la persona: «lee cuatro\.txt»/);
    const output = session.messages.findLast((message) => message.role === "tool");
    assert.ok(!output.content.includes("caracteres omitidos") && output.content.includes("linea-cuatro 229"));

    // 5. Cuando vuelve el grande, le llega otra vez el historial entero
    grandeDown = false;
    app.router.resetCooldowns();
    await app.runPrompt({ text: "ya" }, {});
    sent = chats("ctxgrande").at(-1).body.messages;
    assert.equal(sent.length, session.messages.length);
    assert.equal(contentText(sent[1].content), "lee uno.txt");
    assert.ok(JSON.stringify(sent).includes("linea-cuatro 125"));
    assert.equal(summaries, 2);

    // 6. Si se deshace lo que cubría el resumen, ya no vale: se hace otro desde el principio
    while (session.messages.length >= session.summary.covers) {
      await app.agent.undo();
    }
    grandeDown = true;
    await app.runPrompt({ text: "otra vez" }, {});
    assert.equal(summaries, 3);
    const fresh = contentText(summaryRequests().at(-1).body.messages[1].content);
    assert.ok(!fresh.includes("## Resumen anterior"));
    assert.match(fresh, /lee uno\.txt/);
  } finally {
    app.router.resetCooldowns();
    await app.shutdown();
    await mock.close();
    ws.cleanup();
  }
});

test("contexto: si el modelo no da un resumen de verdad, se pide otra vez y, si tampoco, se hace uno sencillo sin perder el anterior", async () => {
  const { hashMessages } = await import("../dist/context.js");
  let mode = "siempre";
  const summaryBodies = [];
  const mock = await startMock(({ body }) => {
    if (contentText(body.messages[0].content).includes("handover summaries")) {
      summaryBodies.push(contentText(body.messages[1].content));
      // Como pasó con un modelo de verdad: en vez de resumir, sigue la conversación
      if (mode === "siempre" || summaryBodies.length === 1) {
        return { text: '→ llama a read_file({"path":"src/envios.js"})' };
      }
      return { text: "RESUMEN-NUEVO: descuento del 15 % y umbral de 12" };
    }
    return { text: "OK" };
  });
  const ws = tempWorkspace();
  const { app, events } = makeApp(ws, mock.url, { providers: [provider("ctxmalo", mock.url, [{ id: "m", context: 8000 }])], enabledProviders: ["ctxmalo"] });
  // Una conversación que no cabe, con un resumen bueno de sus 10 primeros mensajes
  const prepare = () => {
    const session = app.agent.session;
    session.messages = [];
    for (let i = 0; i < 20; i++) {
      session.messages.push({ role: "user", content: `pregunta ${i}: ${"p".repeat(600)}` }, { role: "assistant", content: `respuesta ${i}: ${"r".repeat(600)}` });
    }
    session.summary = { text: "RESUMEN-BUENO: el descuento para socios es del 15 %", covers: 10, hash: hashMessages(session.messages, 10) };
    summaryBodies.length = 0;
  };
  try {
    // Siempre devuelve un trozo de conversación: se pide dos veces y luego se hace uno sencillo que conserva el anterior
    prepare();
    await app.runPrompt({ text: "sigue" }, {});
    assert.equal(summaryBodies.length, 2);
    // La conversación va entre marcas y las instrucciones, al final
    assert.match(summaryBodies[0], /<conversacion>[\s\S]*<\/conversacion>[\s\S]*## Tarea[\s\S]*Do not continue the conversation/);
    const kept = app.agent.session.summary.text;
    assert.match(kept, /^RESUMEN-BUENO: el descuento para socios es del 15 %/);
    assert.match(kept, /La persona pidió: pregunta 5:/);
    assert.ok(events.notices.some((notice) => notice.includes("uso un resumen sencillo")), events.notices.join("\n"));
    assert.match(contentText(mock.chats().at(-1).body.messages[1].content), /RESUMEN-BUENO/);

    // Si a la segunda sí lo da, se queda con ese
    mode = "una-vez";
    prepare();
    await app.runPrompt({ text: "sigue" }, {});
    assert.equal(summaryBodies.length, 2);
    assert.equal(app.agent.session.summary.text, "RESUMEN-NUEVO: descuento del 15 % y umbral de 12");
  } finally {
    await app.shutdown();
    await mock.close();
    ws.cleanup();
  }
});

test("/compact resume por trozos aunque la conversación no quepa en ningún modelo, y sustituye el historial", async () => {
  const requests = [];
  const mock = await startMock(({ body }) => {
    const text = contentText(body.messages[1]?.content);
    requests.push(text);
    return { text: `RESUMEN-${requests.length}` };
  });
  const ws = tempWorkspace();
  const { app } = makeApp(ws, mock.url, { providers: [provider("ctxsolo", mock.url, [{ id: "m", context: 8000 }])], enabledProviders: ["ctxsolo"] });
  const session = app.agent.session;
  for (let i = 0; i < 40; i++) {
    session.messages.push({ role: "user", content: `pregunta ${i}: ${"p".repeat(600)}` }, { role: "assistant", content: `respuesta ${i}: ${"r".repeat(600)}` });
  }
  await app.agent.compact();
  // Por trozos: cada uno lleva el resumen del anterior
  assert.ok(requests.length >= 3, `${requests.length} peticiones`);
  assert.ok(!requests[0].includes("## Resumen anterior"));
  for (let i = 1; i < requests.length; i++) {
    assert.match(requests[i], new RegExp(`## Resumen anterior\\s+RESUMEN-${i}`));
  }
  assert.match(requests[0], /pregunta 0:/);
  assert.match(requests.at(-1), /respuesta 39:/);
  assert.equal(session.messages.length, 2);
  assert.match(contentText(session.messages[0].content), new RegExp(`RESUMEN-${requests.length}$`));
  assert.equal(session.epoch, 1);
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

test("velocidad: si una IA no empieza a contestar a tiempo se prueba otra, y las lentas pasan detrás", async () => {
  const mock = await startMock(async ({ path: url }) => {
    if (url.startsWith("/lento/")) {
      // No contesta nada hasta mucho después
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { text: "LENTO" };
    }
    if (url.startsWith("/pensando/")) {
      // Empieza enseguida (razona) y el texto tarda más de lo que se espera a la primera respuesta
      return { reasoning: "pienso…", pauseMs: 600, text: "PENSADO" };
    }
    return { text: "RAPIDO" };
  });
  const ws = tempWorkspace();
  const { app, events } = makeApp(ws, mock.url, {
    providers: [provider("lento", mock.url, ["m"]), provider("rapido", mock.url, ["m"]), provider("pensando", mock.url, ["m"])],
    enabledProviders: ["lento", "rapido", "pensando"],
    firstResponseMs: 300,
  });
  // El primero no empieza a contestar en 0,3 s: se prueba el siguiente, y el lento se queda un rato en pausa
  await app.runPrompt({ text: "hola" }, {});
  assert.match(events.text, /RAPIDO/);
  assert.ok(events.notices.some((notice) => /lento\/m: no ha empezado a contestar en 0 s → pausa 5 min/.test(notice)), events.notices.join("\n"));
  // Aunque se le quite la pausa, va detrás de los que van rápido mientras se recuerde que es lento
  app.router.resetCooldowns();
  const before = mock.chats().length;
  await app.runPrompt({ text: "otra" }, {});
  assert.ok(mock.chats()[before].path.startsWith("/rapido/"), mock.chats()[before].path);
  assert.match(app.router.describe().find((row) => row.key === "lento/m").status, /lento: ~0 s en empezar a contestar/);
  // Si ya ha empezado a contestar, se le espera aunque tarde más
  events.text = "";
  app.router.pinned = "pensando/m";
  await app.runPrompt({ text: "piensa" }, {});
  assert.match(events.text, /PENSADO/);
  await app.shutdown();
  await mock.close();
  ws.cleanup();
});

test("velocidad: si dos modelos del mismo proveedor no contestan, se pausa el proveedor entero (y no se espera a cada uno)", async () => {
  // Como pasó con NVIDIA: ninguno de sus modelos manda nada. En «mixto», en cambio, solo hay uno atascado
  const mock = await startMock(async ({ path: url, body }) => {
    if (url.startsWith("/caido/") || (url.startsWith("/mixto/") && body.model === "atascado")) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { text: "TARDE" };
    }
    return { text: url.startsWith("/mixto/") ? "MIXTO" : "VIVO" };
  });
  const ws = tempWorkspace();
  let { app, events } = makeApp(ws, mock.url, {
    providers: [provider("caido", mock.url, ["a", "b", "c"]), provider("vivo", mock.url, ["m"])],
    enabledProviders: ["caido", "vivo"],
    firstResponseMs: 300,
  });
  try {
    await app.runPrompt({ text: "hola" }, {});
    assert.match(events.text, /VIVO/);
    // Al segundo modelo que no contesta se pausa todo el proveedor: al tercero ni se le pregunta
    const asked = mock.chats().filter((r) => r.path.startsWith("/caido/")).map((r) => r.body.model);
    assert.deepEqual(asked, ["a", "b"]);
    assert.ok(events.notices.some((notice) => /caido\/b: no ha empezado a contestar en 0 s → pausa 5 min a todo caido \(no contesta ninguno de sus modelos\)/.test(notice)), events.notices.join("\n"));
    assert.match(app.router.describe().find((row) => row.key === "caido/c").status, /en pausa/);
    app.router.resetCooldowns();
    await app.shutdown();

    // Un solo modelo atascado no basta: se pausa ese y se sigue con otro del mismo proveedor
    ({ app, events } = makeApp(ws, mock.url, {
      providers: [provider("mixto", mock.url, ["atascado", "bien"]), provider("vivo", mock.url, ["m"])],
      enabledProviders: ["mixto", "vivo"],
      firstResponseMs: 300,
    }));
    await app.runPrompt({ text: "hola" }, {});
    assert.match(events.text, /MIXTO/);
    assert.ok(!events.notices.some((notice) => notice.includes("a todo mixto")), events.notices.join("\n"));
    assert.match(app.router.describe().find((row) => row.key === "mixto/bien").status, /^disponible/);
  } finally {
    app.router.resetCooldowns();
    await app.shutdown();
    await mock.close();
    ws.cleanup();
  }
});


test("si todos los modelos fallan no se dice que la conversación es demasiado larga (solo si de verdad no cabe)", async () => {
  // Los dos contestan siempre con un error raro (ni de límites ni de contexto)
  const mock = await startMock(() => ({ status: 400, json: { error: { message: "algo raro ha pasado" } } }));
  const ws = tempWorkspace();
  const { app, events } = makeApp(ws, mock.url, {
    providers: [provider("uno", mock.url, ["m"]), provider("dos", mock.url, [{ id: "m", context: 100 }])],
    enabledProviders: ["uno", "dos"],
  });
  await assert.rejects(app.runPrompt({ text: "hola" }, {}), (err) => {
    assert.match(err.message, /Ningún modelo ha podido contestar/);
    assert.doesNotMatch(err.message, /compact/);
    return true;
  });
  assert.ok(events.notices.some((notice) => /uno\/m: 400 algo raro/.test(notice)), events.notices.join("\n"));
  // Una conversación que no cabe en ninguno sí lo dice
  await assert.rejects(app.runPrompt({ text: "x".repeat(2000000) }, {}), /Ningún modelo admite una conversación de ~\d+ tokens\. Usa \/compact o \/new\./);
  await app.shutdown();
  await mock.close();
  ws.cleanup();
});

test("los datos se guardan de golpe (sin ficheros a medias) y la salida de los comandos no rompe las tildes", async () => {
  const { writeFileAtomic } = await import("../dist/paths.js");
  const ws = tempWorkspace();
  const file = path.join(ws.dir, "datos.json");
  writeFileAtomic(file, "uno", { mode: 0o600 });
  writeFileAtomic(file, "dos", { mode: 0o600 });
  assert.equal(fs.readFileSync(file, "utf8"), "dos");
  assert.deepEqual(fs.readdirSync(ws.dir).filter((name) => name.endsWith(".tmp")), []);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // Si es un enlace (por ejemplo a tu repositorio de configuración), se escribe en el fichero de verdad y el enlace sigue
    const real = path.join(ws.dir, "real.json");
    fs.writeFileSync(real, "antes");
    const link = path.join(ws.dir, "enlace.json");
    fs.symlinkSync(real, link);
    writeFileAtomic(link, "después");
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readFileSync(real, "utf8"), "después");
  }

  // Una «a» y muchas letras de dos bytes: alguna cae partida entre dos trozos de la salida y tiene que llegar entera (la
  // ñ va escrita como \u00f1: en Windows, una letra así en la línea de órdenes depende de la página de códigos)
  const enes = "node -e \"process.stdout.write('a' + '\\u00f1'.repeat(200000))\"";
  const mock = await startMock(({ body }) => (lastMessage(body).role === "tool" ? { text: "listo" } : { tools: [{ name: "bash", args: { command: enes } }] }));
  const { app, events } = makeApp(ws, mock.url);
  await app.runPrompt({ text: "tildes" }, {});
  const output = events.tools.find((event) => event.name === "bash").output;
  assert.ok(!output.includes("\ufffd"), "hay letras rotas en la salida");
  assert.match(output, /ññññ/);
  const shell = await app.runShell(enes);
  assert.ok(!shell.output.includes("\ufffd") && shell.output.length === 200001);
  await app.shutdown();
  await mock.close();
  ws.cleanup();
});

test("parar un !comando (Esc o porque se pasa de tiempo) para también todo lo que haya lanzado", async () => {
  const mock = await startMock(() => ({ text: "ok" }));
  const ws = tempWorkspace();
  const { app } = makeApp(ws, mock.url);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitFor = async (check) => {
    for (let i = 0; i < 200 && !check(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return check();
  };
  // Un programa que apunta su número de proceso y se queda esperando, detrás de otro (así la shell no se sustituye por
  // él: es un hijo suyo, como el servidor de «!npm run dev»)
  const run = async (name, signal) => {
    const file = path.join(ws.proj, `${name}.pid`);
    const command = `node -e "require('fs').writeFileSync('${name}.pid', String(process.pid)); setInterval(() => {}, 1000)" && echo fin`;
    const running = app.runShell(command, undefined, signal);
    assert.ok(await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, "utf8") !== ""), "el programa no arranca");
    return { running, pid: Number(fs.readFileSync(file, "utf8")) };
  };
  // Esc
  const controller = new AbortController();
  const first = await run("esc", controller.signal);
  controller.abort();
  const stopped = await first.running;
  assert.match(stopped.output, /\(interrumpido\)$/);
  assert.equal(await waitFor(() => !alive(first.pid)), true, "el programa sigue en marcha tras Esc");
  // Se pasa de tiempo
  app.config.bashTimeoutMs = 1500;
  const second = await run("tiempo");
  const late = await second.running;
  assert.match(late.output, /\(cancelado por tiempo \(2 s\)\)$/);
  assert.equal(await waitFor(() => !alive(second.pid)), true, "el programa sigue en marcha tras pasarse de tiempo");
  await app.shutdown();
  await mock.close();
  ws.cleanup();
});

test("MCP: los nombres de herramienta no se repiten (tampoco con los de vipcode) y un servidor que se cae deja de ofrecer las suyas", async () => {
  const { McpManager } = await import("../dist/mcp.js");
  const ws = tempWorkspace();
  const fixture = path.join(ROOT, "test", "fixtures", "mcp-server.mjs");
  // «c.a» y «c_a» darían los mismos nombres (el punto no vale y se cambia por _): los proveedores rechazarían todas las
  // peticiones por tener dos herramientas iguales
  const manager = new McpManager({ "c.a": { command: ["node", fixture] }, c_a: { command: ["node", fixture] } }, ws.proj);
  let changes = 0;
  await manager.start(() => changes++);
  const names = manager.tools().map((tool) => tool.name).sort();
  assert.deepEqual(names, ["c_a_entorno", "c_a_entorno_2", "c_a_sumar", "c_a_sumar_2"]);
  // Uno que se llamaría como una herramienta de vipcode tampoco la pisa, y los largos siguen cabiendo en 64
  assert.equal(manager.uniqueName("read", "file"), "read_file_2");
  const long = manager.uniqueName("s".repeat(40), "t".repeat(40));
  assert.equal(long.length, 64);
  assert.equal(manager.uniqueName("s".repeat(40), "t".repeat(40)), `${long.slice(0, 62)}_2`);
  // Si un servidor se cae, /mcp lo dice y sus herramientas dejan de ofrecerse
  const before = changes;
  const dying = [...manager.servers.values()].find((server) => server.name === "c_a");
  process.kill(dying.client.transport.pid, "SIGKILL");
  for (let i = 0; i < 100 && manager.status().find((server) => server.name === "c_a").state !== "error"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(manager.status().find((server) => server.name === "c_a"), { name: "c_a", state: "error", error: "se ha cerrado la conexión", tools: 2 });
  assert.ok(changes > before);
  assert.equal(manager.tools().length, 2);
  await manager.close();
  // Al cerrar vipcode no se marca como caído
  assert.equal(manager.status().find((server) => server.name === "c.a").state, "conectado");
  ws.cleanup();
});

test("LSP: un servidor de lenguaje que se cae se vuelve a arrancar (unas pocas veces) y uno que no arranca no se queda encendido", async () => {
  const { LspManager } = await import("../dist/lsp.js");
  const ws = tempWorkspace({ "a.fake": "hola\n" });
  const pids = path.join(ws.dir, "pids.txt");
  const fake = path.join(ROOT, "test", "fixtures", "fake-lsp.mjs");
  const lsp = new LspManager(ws.proj, { lsp: { fake: { command: [process.execPath, fake], extensions: [".fake"], env: { FAKE_LSP_PIDS: pids } } } });
  const file = path.join(ws.proj, "a.fake");
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const started = () => (fs.existsSync(pids) ? fs.readFileSync(pids, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);
  // Cada vez contesta con el error y se cae: la siguiente vez lo contesta otro (arrancado de nuevo), hasta 3 veces más
  const seen = [];
  for (let round = 0; round < 5; round++) {
    const report = await lsp.report(file, false);
    seen.push(report);
    const last = started().at(-1);
    for (let i = 0; i < 100 && last && alive(last); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.equal(started().length, 4, seen.join("\n"));
  for (const [index, pid] of started().entries()) {
    assert.match(seen[index], new RegExp(`^a\\.fake:1:1 error: fallo del proceso ${pid}$`));
  }
  assert.equal(seen[4], "");
  await lsp.shutdown();

  // Uno que contesta con un error al arrancar: no se queda encendido esperando
  fs.rmSync(pids, { force: true });
  const broken = new LspManager(ws.proj, { lsp: { fake: { command: [process.execPath, fake], extensions: [".fake"], env: { FAKE_LSP_PIDS: pids, FAKE_LSP_MODE: "falla" } } } });
  assert.equal(await broken.report(file, false), "");
  const [pid] = started();
  for (let i = 0; i < 100 && alive(pid); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(alive(pid), false, "el servidor que no arranca sigue encendido");
  assert.match((await broken.status()).map((row) => `${row.id} ${row.state}`).join("\n"), /fake error: no arranco/);
  await broken.shutdown();
  ws.cleanup();
});

test("skills y claves: un fichero enorme no se lee entero, un enlace con .. no sale del repositorio y un auth.json roto no se pisa", async () => {
  const skills = await import("../dist/skills.js");
  const auth = await import("../dist/auth.js");
  const config = await import("../dist/config.js");
  const ws = tempWorkspace({ ".vipcode/skills/grande/SKILL.md": "---\nname: grande\ndescription: con un fichero enorme\n---\nNada" });
  const dir = path.join(ws.proj, ".vipcode", "skills", "grande");
  // De 21 MB (sin ocupar disco de verdad)
  fs.closeSync(fs.openSync(path.join(dir, "datos.bin"), "w"));
  fs.truncateSync(path.join(dir, "datos.bin"), 21 * 1024 * 1024);
  const skill = skills.loadSkills(ws.proj, { ...config.DEFAULT_CONFIG }).find((item) => item.name === "grande");
  assert.match(skills.readSkillFile(skill, "datos.bin"), /datos\.bin ocupa más de 20 MB: no se lee entero/);
  // Un enlace de GitHub cuya carpeta sale del repositorio no se descarga
  assert.throws(() => skills.installSkills("https://github.com/alguien/repo/tree/main/../../../etc", ws.proj), /sale del repositorio/);

  // auth.json roto (por ejemplo, editado a mano): no se usan sus claves, se avisa, y no se sobrescribe al conectar otra
  const file = path.join(shared.home, "auth.json");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  try {
    // Sin comillas en la clave: el error de JSON.parse citaría un trozo («"key": gsk_mia_sec…»), y no se enseña
    const broken = '{ "groq": { "key": gsk_mia_secreta } }';
    fs.writeFileSync(file, broken);
    config.configNotices.length = 0;
    assert.deepEqual(auth.readAuth(), {});
    const notices = config.configNotices.filter((notice) => notice.includes("las claves guardadas no se usan"));
    assert.equal(notices.length, 1);
    assert.match(notices[0], /no es JSON válido/);
    assert.doesNotMatch(notices[0], /gsk_/);
    assert.throws(() => auth.saveAuth("gemini", { key: "nueva" }), (err) => /se perderían las claves que tiene/.test(err.message) && !err.message.includes("gsk_"));
    assert.throws(() => auth.removeAuth("groq"), /se perderían las claves que tiene/);
    assert.equal(fs.readFileSync(file, "utf8"), broken);
    // Igual con la configuración: dice dónde está el error, sin citar lo que hay
    const configFile = path.join(shared.home, "config.json");
    const savedConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : null;
    try {
      fs.writeFileSync(configFile, '{\n  "providers": [{ "name": "x", "apiKey": sk-mi-clave-secreta }]\n}');
      assert.throws(() => config.loadConfig(ws.proj), (err) => /config\.json: no es JSON válido/.test(err.message) && !err.message.includes("sk-mi"));
      fs.writeFileSync(configFile, '{\n  "maxSteps": 3,\n}');
      assert.throws(() => config.loadConfig(ws.proj), /no es JSON válido \(línea 3, columna 1\)/);
    } finally {
      if (savedConfig === null) {
        fs.rmSync(configFile, { force: true });
      } else {
        fs.writeFileSync(configFile, savedConfig);
      }
    }
  } finally {
    if (before === null) {
      fs.rmSync(file, { force: true });
    } else {
      fs.writeFileSync(file, before);
    }
    config.configNotices.length = 0;
  }
  ws.cleanup();
});

test("modelos que piensan: se les pide el nivel de razonamiento que lleven en el catálogo (y a los demás nada)", async () => {
  const mock = await startMock(() => ({ text: "ok" }));
  const ws = tempWorkspace();
  const { app } = makeApp(ws, mock.url, {
    providers: [provider("p", mock.url, [{ id: "piensa", context: 100000, reasoningEffort: "medium" }, { id: "normal", context: 100000 }])],
    enabledProviders: ["p"],
  });
  app.router.pinned = "p/piensa";
  await app.runPrompt({ text: "hola" }, {});
  app.router.pinned = "p/normal";
  await app.runPrompt({ text: "otra" }, {});
  const [first, second] = mock.chats().map((chat) => chat.body);
  assert.equal(first.model, "piensa");
  assert.equal(first.reasoning_effort, "medium");
  assert.equal(second.model, "normal");
  assert.ok(!("reasoning_effort" in second));
  await app.shutdown();
  await mock.close();
  ws.cleanup();
});

test("vigilancia: dice qué modelos del catálogo ya no existen o no contestan, sin enseñar nunca las claves", async () => {
  const vigilar = await import("../scripts/vigilar.mjs");
  const secret = "clave-de-groq-que-no-se-ve";
  const mock = await startMock(({ path: url, body }) => {
    if (url.endsWith("/models")) {
      return { json: { data: [{ id: "vivo" }, { id: "roto" }, { id: "limitado" }] } };
    }
    if (body.model === "roto") {
      return { status: 404, json: { error: { message: `The model roto does not exist (usaste ${secret})` } } };
    }
    if (body.model === "limitado") {
      return { status: 429, json: { error: { message: "Rate limit reached for requests per minute" } } };
    }
    return { json: { choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] } };
  });
  const provider = {
    name: "prueba",
    baseURL: `${mock.url}/prueba/v1`,
    apiKeyEnv: "GROQ_API_KEY",
    models: [{ id: "vivo", context: 1000, reasoningEffort: "medium" }, { id: "roto", context: 1000 }, { id: "limitado", context: 1000 }, { id: "desaparecido", context: 1000 }],
  };
  const result = await vigilar.checkProvider(provider, { env: { GROQ_API_KEY: secret }, pauseMs: 0, timeoutMs: 5000 });
  assert.deepEqual(
    result.problems.map((problem) => [problem.model, problem.detail.split(":")[0]]),
    [
      ["desaparecido", "ya no está en su lista de modelos"],
      ["roto", "no existe o ya no está disponible"],
    ],
  );
  assert.deepEqual(result.warnings, [{ model: "limitado", detail: "límite de peticiones" }]);
  // Se le pregunta como lo hace vipcode: con una herramienta, con su nivel de razonamiento y con la clave
  const chats = mock.chats();
  assert.deepEqual(chats.map((chat) => chat.body.model), ["vivo", "roto", "limitado"]);
  assert.equal(chats[0].body.tools[0].function.name, "leer_fichero");
  assert.equal(chats[0].body.reasoning_effort, "medium");
  assert.ok(!("reasoning_effort" in chats[1].body));
  assert.equal(chats[0].headers.authorization, `Bearer ${secret}`);
  // El informe (que va a un aviso público) nunca lleva la clave, y su huella solo cambia si cambia lo que falla
  const report = vigilar.renderReport([result], new Date("2026-10-31T06:17:00Z"));
  assert.match(report, /## ✖ 2 modelos del catálogo no funcionan/);
  assert.match(report, /\| prueba \| `roto` \| no existe o ya no está disponible: .*\[clave\]/);
  assert.match(report, /Comprobado el 2026-10-31 a las 06:17 \(UTC\)/);
  assert.ok(!report.includes(secret));
  assert.equal(vigilar.fingerprint([result]), vigilar.fingerprint([{ ...result, warnings: [] }]));
  assert.notEqual(vigilar.fingerprint([result]), vigilar.fingerprint([{ ...result, problems: result.problems.slice(1) }]));
  assert.match(vigilar.renderReport([{ name: "prueba", how: "sin clave", problems: [], warnings: [] }]), /✓ Todos los modelos del catálogo que se han podido comprobar funcionan[\s\S]*<!-- huella:  -->/);
  // Sin clave, una lista privada no se comprueba (y dice qué secreto falta); los que funcionan sin clave, sí
  const closed = await vigilar.checkProvider({ ...provider, baseURL: `${mock.url}/cerrado/v1` }, { env: {}, pauseMs: 0, fetchImpl: async () => new Response("no", { status: 401 }) });
  assert.equal(closed.how, "sin comprobar: añade el secreto GROQ_API_KEY");
  assert.equal(vigilar.credentialsFor({ ...provider, noKey: true }, {}).key, "no-key");
  assert.equal(vigilar.credentialsFor({ ...provider, baseURL: "https://x/${CUENTA}/v1" }, {}).missing, "CUENTA");
  // Qué se considera un problema del catálogo y qué puede ser pasajero
  assert.equal(vigilar.classifyProbe(429, '{"error":{"message":"Quota exceeded, limit: 0"}}').detail, "fuera del plan gratis");
  assert.equal(vigilar.classifyProbe(503, "overloaded").kind, "pasajero");
  assert.equal(vigilar.classifyProbe(400, "This model does not support tools").detail, "no acepta herramientas");
  await mock.close();
});

test("prueba real: qué se comprueba en cada paso, cuándo es un fallo y el informe (sin claves)", async () => {
  const real = await import("../scripts/prueba-real.mjs");
  const { redactSecrets } = await import("../dist/debug.js");
  // El proyecto de prueba tiene los datos que luego se preguntan
  const ws = tempWorkspace();
  real.writeProject(ws.proj);
  const envios = path.join(ws.proj, "src", "envios.js");
  assert.match(fs.readFileSync(path.join(ws.proj, "src", "precios.js"), "utf8"), /DESCUENTO_SOCIOS = 0\.15/);
  assert.match(fs.readFileSync(path.join(ws.proj, "src", "stock.js"), "utf8"), /UMBRAL_REPOSICION = 12/);
  assert.match(fs.readFileSync(envios, "utf8"), /zona: "Canarias", coste: 18\.5, dias: 6/);
  // Lo que tiene que salir en cada respuesta
  const [descuento, umbral, canarias, memoria, editar] = real.STEPS;
  assert.equal(descuento.check("El descuento para socios es del **15 %**."), null);
  assert.ok(descuento.check("No lo sé"));
  assert.equal(umbral.check("El umbral es de 12 unidades"), null);
  assert.ok(umbral.check("El umbral es 120"));
  assert.equal(canarias.check("Cuesta 18,50 € y tarda 6 días"), null);
  assert.equal(canarias.check("18.5 € en 6 días"), null);
  assert.ok(canarias.check("Cuesta 18 € y tarda 6 días"));
  assert.equal(memoria.check("Descuento: 15 % · umbral: 12"), null);
  assert.ok(memoria.check("No tengo esa información: solo he leído src/envios.js"));
  assert.ok(editar.check("hecho", ws.proj));
  fs.writeFileSync(envios, `// Revisado por vipcode\n${fs.readFileSync(envios, "utf8")}`);
  assert.equal(editar.check("hecho", ws.proj), null);
  ws.cleanup();

  // Cuándo ha ido bien, cuándo es un fallo y cuándo no se ha podido probar
  const step = (ok, problem = null) => ({ prompt: "p", ok, problem, answer: "", model: "kilo/m", tools: [], seconds: 3 });
  const good = { steps: real.STEPS.map(() => step(true)), summarized: true, summary: "R", complete: true, tokenScale: 1.4, notices: [] };
  assert.equal(real.judge(good), "bien");
  assert.equal(real.judge({ ...good, summarized: false }), "fallo");
  assert.equal(real.judge({ ...good, complete: false }), "fallo");
  assert.equal(real.judge({ ...good, steps: [step(true), step(false, "no dice que el umbral de reposición es 12")] }), "fallo");
  assert.equal(real.judge({ ...good, steps: [step(false, "Todos los proveedores están agotados o en pausa.")] }), "sin-modelos");
  assert.equal(real.judge({ ...good, steps: [step(false, "no ha terminado en 4 minutos")] }), "sin-modelos");
  assert.equal(real.judge(null), "fallo");
  // La huella solo cambia si cambia lo que falla
  assert.equal(real.fingerprint(good), real.fingerprint({ ...good, tokenScale: 2 }));
  assert.notEqual(real.fingerprint(good), real.fingerprint({ ...good, summarized: false }));

  // El informe es público: sin claves, y lo que escribe un modelo no puede romper el Markdown
  const secret = "sk-or-v1-0123456789abcdef0123456789abcdef";
  const failed = { ...good, attempt: 2, steps: [step(true), { ...step(false, "no dice que el umbral de reposición es 12"), answer: `mi clave es ${secret} \`\`\`fin` }] };
  const report = real.renderReport(failed, { when: new Date("2026-11-01T06:17:00Z"), redact: redactSecrets });
  assert.match(report, /## ✗ Algo ha salido mal/);
  assert.match(report, /Paso 2: no dice que el umbral de reposición es 12/);
  assert.match(report, /2026-11-01 06:17 UTC · intento 2 de 2/);
  assert.match(report, /<!-- huella: \w+ -->/);
  assert.ok(!report.includes(secret));
  assert.ok(!report.includes("```fin"));
  assert.match(real.renderReport(good), /## ✓ Todo bien/);
  assert.match(real.renderReport(null), /no ha llegado a terminar/);
});

test("velocidad: a un proveedor que suele tardar en empezar (Gemini) se le espera más que al resto", async () => {
  // Los dos tardan 1 s en empezar a contestar; a «paciente» se le esperan 3 s, al otro lo de la config (0,3 s)
  const mock = await startMock(async ({ path: url }) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { text: url.startsWith("/paciente/") ? "PACIENTE" : "NORMAL" };
  });
  const ws = tempWorkspace();
  const { app, events } = makeApp(ws, mock.url, {
    providers: [provider("normal", mock.url, ["m"]), provider("paciente", mock.url, ["m"], { firstResponseMs: 3000 })],
    enabledProviders: ["normal", "paciente"],
    firstResponseMs: 300,
  });
  await app.runPrompt({ text: "hola" }, {});
  assert.match(events.text, /PACIENTE/);
  assert.ok(events.notices.some((notice) => /normal\/m: no ha empezado a contestar/.test(notice)), events.notices.join("\n"));
  assert.ok(!events.notices.some((notice) => /paciente\/m/.test(notice)), events.notices.join("\n"));
  await app.shutdown();
  await mock.close();
  ws.cleanup();
});

test("un modelo saturado (503) se dice así, no como un error, se deja un rato y se pasa a otro", async () => {
  const mock = await startMock(({ path: url }) => {
    if (url.startsWith("/lleno/")) {
      return { status: 503, json: { error: { code: 503, message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.", status: "UNAVAILABLE" } } };
    }
    if (url.startsWith("/roto/")) {
      return { status: 500, json: { error: { message: "Internal error" } } };
    }
    return { text: "OTRO" };
  });
  const ws = tempWorkspace();
  const { app, events } = makeApp(ws, mock.url, {
    providers: [provider("lleno", mock.url, ["m"]), provider("roto", mock.url, ["m"]), provider("bien", mock.url, ["m"])],
    enabledProviders: ["lleno", "roto", "bien"],
  });
  await app.runPrompt({ text: "hola" }, {});
  assert.match(events.text, /OTRO/);
  // Un pico de demanda dura minutos: se deja 2 min (a los 30 s volvería a fallar)
  assert.ok(events.notices.includes("lleno/m: saturado (503) → pausa 2 min"), events.notices.join("\n"));
  assert.ok(events.notices.includes("roto/m: error del servidor (500) → pausa 30 s"), events.notices.join("\n"));
  await app.shutdown();
  await mock.close();
  ws.cleanup();
});
