// La API propia de Anthropic (Claude) contra un servidor de mentira que contesta en su formato: la clave con el SDK oficial, la
// conversación traducida (sistema aparte, resultados de herramientas detrás de su llamada), el razonamiento firmado
// devuelto tal cual en el paso siguiente y nunca a otros proveedores, la caché pedida, y los errores tratados como los demás
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { provider, runVip, startMock, tempWorkspace } from "./helpers/mock-llm.mjs";

const claude = (url, models, extra = {}) => provider("claude", url, models, { api: "anthropic", apiKey: "sk-ant-prueba", ...extra });

function sessionFile(ws) {
  const dir = path.join(ws.home, "sessions");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
}

test("anthropic: una tarea con herramientas, con la clave, caché y el razonamiento devuelto tal cual", async () => {
  const mock = await startMock(({ body }) => {
    const results = body.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block.type === "tool_result");
    if (results.length === 0) {
      return {
        reasoning: "miro el fichero",
        signature: "FIRMA-1",
        text: "Voy a cambiarlo.",
        tools: [
          { name: "read_file", args: { path: "hola.txt" } },
          { name: "edit_file", args: { path: "hola.txt", old_string: "mundo", new_string: "Murcia" } },
        ],
      };
    }
    return { text: "Hecho: ya pone Murcia.", usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 20 } };
  });
  const ws = tempWorkspace({ "hola.txt": "hola mundo\n" });
  ws.writeConfig({ providers: [claude(mock.url, [{ id: "claude-opus-5-5", context: 200000, reasoningEffort: "high" }])], enabledProviders: ["claude"] });
  const result = await runVip(["run", "cambia mundo por Murcia", "--yolo"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /ya pone Murcia/);
  assert.equal(ws.read("hola.txt"), "hola Murcia\n");

  const calls = mock.claude();
  assert.equal(calls.length, 2);
  const [first, second] = calls;
  // La clave, en la cabecera que pone el SDK oficial (x-api-key o Authorization), y la versión de la API
  assert.ok(first.headers["x-api-key"] === "sk-ant-prueba" || first.headers.authorization === "Bearer sk-ant-prueba", JSON.stringify(first.headers));
  assert.ok(first.headers["anthropic-version"]);
  // Sistema aparte, caché sobre toda la conversación, razonamiento adaptativo con su resumen y el esfuerzo del modelo
  assert.ok(first.body.system.length > 0);
  assert.ok(!first.body.messages.some((message) => message.role === "system"));
  assert.deepEqual(first.body.cache_control, { type: "ephemeral" });
  assert.equal(first.body.thinking.type, "adaptive");
  assert.equal(first.body.thinking.display, "summarized");
  assert.deepEqual(first.body.output_config, { effort: "high" });
  assert.ok(!("temperature" in first.body));
  assert.ok(first.body.tools.every((tool) => tool.input_schema?.type === "object" && tool.name && !tool.function));
  assert.equal(first.body.messages[0].role, "user");
  // Segundo paso: el razonamiento firmado vuelve tal cual, delante de la llamada, y el resultado va justo detrás
  const assistant = second.body.messages.find((message) => message.role === "assistant");
  assert.equal(assistant.content[0].type, "thinking");
  assert.equal(assistant.content[0].signature, "FIRMA-1");
  // Las dos llamadas del mismo paso, con sus dos resultados juntos en el mensaje siguiente y en el mismo orden
  const ids = assistant.content.filter((block) => block.type === "tool_use").map((block) => block.id);
  assert.equal(ids.length, 2);
  const next = second.body.messages[second.body.messages.indexOf(assistant) + 1];
  assert.equal(next.role, "user");
  assert.deepEqual(next.content.slice(0, 2).map((block) => [block.type, block.tool_use_id]), ids.map((id) => ["tool_result", id]));
  // Los tokens cuentan también los leídos de la caché
  assert.deepEqual(sessionFile(ws).usage, { prompt: 100 + 10 + 900, completion: 20 + 5 });
  await mock.close();
  ws.cleanup();
});

test("anthropic: lo guardado para Claude no se le manda a otro proveedor, y si Claude falla se sigue con otro", async () => {
  let claudeCalls = 0;
  const mock = await startMock(({ path: url, body }) => {
    if (url.endsWith("/v1/messages")) {
      claudeCalls++;
      if (claudeCalls === 1) {
        return { reasoning: "pienso", text: "Lo leo.", tools: [{ name: "read_file", args: { path: "hola.txt" } }] };
      }
      // Sin saldo: se pasa al siguiente
      return { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } } };
    }
    return { text: `sigo yo (${body.messages.length} mensajes)` };
  });
  const ws = tempWorkspace({ "hola.txt": "hola\n" });
  ws.writeConfig({ providers: [claude(mock.url, ["claude-sonnet-5-5"]), provider("otro", mock.url, ["m"])], enabledProviders: ["claude", "otro"], order: ["claude/*"] });
  const result = await runVip(["run", "lee hola.txt", "--yolo"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /sigo yo/);
  const other = mock.chats();
  assert.ok(other.length >= 1);
  for (const request of other) {
    assert.ok(!JSON.stringify(request.body).includes("anthropic_content"), "lo de Claude ha llegado a otro proveedor");
    assert.ok(!JSON.stringify(request.body).includes("signature"));
  }
  assert.match(result.output, /sin créditos|credit balance/i);
  await mock.close();
  ws.cleanup();
});

test("anthropic: si la API no acepta lo nuevo (betas, relevo), se repite sin ello y se recuerda", async () => {
  const mock = await startMock(({ body }) => {
    if (body.betas || body.fallbacks || body.thinking?.block_binding) {
      return { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "fallbacks: Extra inputs are not permitted" } } };
    }
    return { text: "contesto sin extras" };
  });
  const ws = tempWorkspace();
  ws.writeConfig({ providers: [claude(mock.url, ["claude-opus-5-5"])], enabledProviders: ["claude"] });
  const result = await runVip(["run", "hola"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /contesto sin extras/);
  const calls = mock.claude();
  assert.equal(calls.length, 2);
  // El primero pedía relevo a otro Claude y descartar el razonamiento que ya no valga; el segundo, no
  assert.equal(calls[0].body.fallbacks, "default");
  assert.equal(calls[0].body.thinking.block_binding.prefix_mismatch_behavior, "drop_block");
  assert.ok(!calls[1].body.fallbacks && !calls[1].body.thinking.block_binding);
  await mock.close();
  ws.cleanup();
});

test("anthropic: la conversación se traduce bien aunque esté cortada o venga de otro modelo", async () => {
  const { toClaude, toClaudeTools, claudeBaseURL } = await import("../dist/anthropic.js");
  const call = (id, name = "read_file") => ({ id, type: "function", function: { name, arguments: '{"path":"a"}' } });
  const { system, messages } = toClaude([
    { role: "system", content: "eres vipcode" },
    // Empieza por el asistente (tras un resumen): se pone un mensaje del usuario delante
    { role: "assistant", content: "resumen" },
    { role: "user", content: [{ type: "text", text: "mira" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    // Dos llamadas: una con resultado y otra sin él (se canceló), y un resultado suelto de otra llamada
    { role: "assistant", content: "", tool_calls: [call("a1"), call("a2")] },
    { role: "tool", tool_call_id: "a1", content: "contenido" },
    { role: "tool", tool_call_id: "zz", content: "suelto" },
    { role: "system", content: "aviso a mitad" },
    // Una llamada de otro modelo con argumentos rotos
    { role: "assistant", content: null, tool_calls: [{ id: "b1", type: "function", function: { name: "bash", arguments: "{roto" } }] },
    { role: "tool", tool_call_id: "b1", content: [{ type: "text", text: "salida" }] },
    { role: "user", content: "   " },
    // Acaba en el asistente: se añade «Continúa.»
    { role: "assistant", content: "fin" },
  ]);
  assert.equal(system, "eres vipcode");
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant", "user"],
  );
  assert.equal(messages[2].content[1].type, "image");
  assert.deepEqual(messages[2].content[1].source, { type: "base64", media_type: "image/png", data: "AAAA" });
  // Sin texto vacío en el asistente; las dos llamadas con su resultado (la cancelada, como error) y lo suelto como texto detrás
  assert.deepEqual(messages[3].content.map((block) => block.type), ["tool_use", "tool_use"]);
  assert.deepEqual(messages[4].content.map((block) => block.type), ["tool_result", "tool_result", "text", "text"]);
  assert.equal(messages[4].content[1].is_error, true);
  assert.match(messages[4].content[2].text, /suelto/);
  assert.match(messages[4].content[3].text, /aviso-del-sistema/);
  assert.deepEqual(messages[5].content[0].input, { argumentos_no_validos: "{roto" });
  assert.equal(messages[6].content.length, 1, "el texto en blanco no se manda");
  assert.equal(messages[8].content[0].text, "Continúa.");
  // Lo guardado de Claude se usa tal cual solo si las llamadas siguen siendo las mismas
  const saved = [{ type: "thinking", thinking: "", signature: "S" }, { type: "tool_use", id: "c1", name: "read_file", input: { path: "a" } }];
  const same = toClaude([{ role: "user", content: "x" }, { role: "assistant", content: null, tool_calls: [call("c1")], anthropic_content: saved }, { role: "tool", tool_call_id: "c1", content: "y" }]);
  assert.equal(same.messages[1].content[0].signature, "S");
  const changed = toClaude([{ role: "user", content: "x" }, { role: "assistant", content: null, tool_calls: [call("c9")], anthropic_content: saved }, { role: "tool", tool_call_id: "c9", content: "y" }]);
  assert.deepEqual(changed.messages[1].content.map((block) => block.type), ["tool_use"]);
  assert.equal(changed.messages[1].content[0].id, "c9");
  // Herramientas y URL
  const tools = toClaudeTools([{ type: "function", function: { name: "t", description: "d" } }]);
  assert.deepEqual(tools, [{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }]);
  assert.equal(claudeBaseURL("https://api.anthropic.com/v1/"), "https://api.anthropic.com");
  assert.equal(claudeBaseURL("https://api.anthropic.com"), "https://api.anthropic.com");
});

test("anthropic: a los Claude anteriores no se les pide razonamiento adaptativo ni esfuerzo", async () => {
  const { claudeParams } = await import("../dist/anthropic.js");
  const old = claudeParams({ id: "claude-haiku-4-5", context: 200000, reasoningEffort: "low" }, { messages: [{ role: "user", content: "hola" }] });
  assert.ok(!old.thinking && !old.output_config && !old.betas && !old.fallbacks);
  const haiku = claudeParams({ id: "claude-haiku-5-5", context: 200000 }, { messages: [{ role: "user", content: "hola" }] });
  assert.equal(haiku.thinking.type, "adaptive");
  assert.ok(!haiku.fallbacks, "Haiku 5.5 no tiene relevo en el servidor");
  assert.deepEqual(haiku.betas, ["thinking-binding-controls-2026-08-01"]);
});

test("anthropic: está en el catálogo como de pago y /connect comprueba la clave con x-api-key", async () => {
  const { CATALOG } = await import("../dist/catalog.js");
  const entry = CATALOG.find((one) => one.name === "anthropic");
  assert.equal(entry.api, "anthropic");
  assert.equal(entry.paid, true);
  assert.ok(entry.models.some((model) => model.id === "claude-opus-5-5"));
  const mock = await startMock(({ path: url, headers }) => {
    if (url.endsWith("/v1/models")) {
      return headers["x-api-key"] === "sk-ant-buena" && headers["anthropic-version"] ? { json: { data: [] } } : { status: 401, json: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } };
    }
  });
  const ws = tempWorkspace();
  ws.writeConfig({ providers: [{ name: "anthropic", baseURL: `${mock.url}/` }] });
  const good = await runVip(["auth", "login", "anthropic"], { cwd: ws.proj, home: ws.home, input: ["sk-ant-buena\n"] });
  assert.match(good.output, /clave comprobada/);
  assert.match(good.output, /cobra por uso/);
  const bad = await runVip(["auth", "login", "anthropic"], { cwd: ws.proj, home: ws.home, input: ["sk-ant-mala\n"] });
  assert.match(bad.output, /no es válida/);
  await mock.close();
  ws.cleanup();
});
