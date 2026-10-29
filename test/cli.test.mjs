import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT, contentText, lastMessage, lastUserText, provider, runVip, startMock, tempWorkspace } from "./helpers/mock-llm.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function state(ws) {
  return JSON.parse(fs.readFileSync(path.join(ws.home, "state.json"), "utf8"));
}

function sessionFile(ws) {
  const dir = path.join(ws.home, "sessions");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
}

test("prueba del documento: límite diario en «a», sigue con «b» y edita el fichero", async () => {
  const mock = await startMock(({ path: url, body }) => {
    if (url.startsWith("/a/")) {
      return { status: 429, json: { error: { message: "Rate limit reached for model on requests per day (RPD)" } } };
    }
    if (lastMessage(body).role === "user") {
      return {
        text: "Voy a leerlo. ",
        tools: [
          { name: "read_file", args: { path: "hello.txt" } },
          { name: "edit_file", args: { path: "hello.txt", old_string: "mundo", new_string: "Murcia" } },
        ],
      };
    }
    return { text: "Hecho." };
  });
  const ws = tempWorkspace({ "hello.txt": "hola mundo\n" });
  ws.writeConfig({ providers: [provider("a", mock.url, ["ma"]), provider("b", mock.url, ["mb"])], enabledProviders: ["a", "b"] });
  const result = await runVip(["run", "cambia mundo por Murcia", "--yolo"], { cwd: ws.proj, home: ws.home });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /a\/ma: límite diario agotado → pausa hasta/);
  assert.match(result.output, /● read_file hello\.txt/);
  assert.match(result.output, /● edit_file hello\.txt/);
  assert.match(result.output, /\+ hola Murcia/);
  assert.equal(ws.read("hello.txt"), "hola Murcia\n");
  assert.ok(state(ws).cooldowns["a/ma"] > Date.now());
  await mock.close();
  ws.cleanup();
});

test("límite de toda la cuenta: pausa todos los modelos del proveedor con el Retry-After", async () => {
  const mock = await startMock(({ path: url }) => {
    if (url.startsWith("/c/")) {
      return { status: 429, headers: { "retry-after": "120" }, json: { error: { message: "Rate limit exceeded" } } };
    }
    return { text: "Respuesta de d." };
  });
  const ws = tempWorkspace();
  ws.writeConfig({
    providers: [provider("c", mock.url, ["c1", "c2"], { limitScope: "provider" }), provider("d", mock.url, ["d1"])],
    enabledProviders: ["c", "d"],
  });
  const result = await runVip(["run", "hola"], { cwd: ws.proj, home: ws.home });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /c\/c1: límite por minuto → pausa 120 s/);
  assert.match(result.output, /Respuesta de d\./);
  assert.equal(mock.chats().filter((r) => r.body.model === "c2").length, 0);
  const s = state(ws);
  assert.ok(s.cooldowns["c/c1"] - Date.now() > 100000);
  assert.ok(s.cooldowns["c/c2"] - Date.now() > 100000);
  await mock.close();
  ws.cleanup();
});

test("modelo que no existe: se descarta y se recuerda en disco", async () => {
  const mock = await startMock(({ path: url }) => {
    if (url.startsWith("/e/")) {
      return { status: 404, json: { error: { message: "The model `m` does not exist" } } };
    }
    return { text: "ok" };
  });
  const ws = tempWorkspace();
  ws.writeConfig({ providers: [provider("e", mock.url, ["m"]), provider("f", mock.url, ["n"])], enabledProviders: ["e", "f"] });
  let result = await runVip(["run", "hola"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /e\/m: modelo no disponible .* → modelo descartado/);
  assert.ok(state(ws).unsupported["e/m"] > Date.now());
  const before = mock.chats().length;
  result = await runVip(["run", "otra vez"], { cwd: ws.proj, home: ws.home });
  assert.equal(result.code, 0);
  const second = mock.chats().slice(before);
  assert.deepEqual(
    second.map((r) => r.body.model),
    ["n"],
  );
  await mock.close();
  ws.cleanup();
});

test("proveedor que no acepta stream_options: reintenta sin ellas y lo aprende", async () => {
  const mock = await startMock(({ body }) => {
    if (body.stream_options) {
      return { status: 400, json: { error: { message: "Unrecognized request argument supplied: stream_options" } } };
    }
    return { text: "sin stream_options", usage: { prompt_tokens: 50, completion_tokens: 5 } };
  });
  const ws = tempWorkspace();
  ws.writeConfig({ providers: [provider("g", mock.url, ["m"])], enabledProviders: ["g"] });
  const result = await runVip(["run", "hola"], { cwd: ws.proj, home: ws.home });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /sin stream_options/);
  assert.equal(state(ws).noStreamUsage.g, true);
  const chats = mock.chats();
  assert.ok(chats[0].body.stream_options);
  assert.equal(chats[1].body.stream_options, undefined);
  await mock.close();
  ws.cleanup();
});

test("imágenes: van solo a modelos que las aceptan", async () => {
  const mock = await startMock(({ body }) => {
    const user = body.messages.find((m) => m.role === "user");
    const hasImage = Array.isArray(user.content) && user.content.some((p) => p.type === "image_url" && p.image_url.url.startsWith("data:image/png;base64,"));
    return { text: hasImage ? `veo la imagen (${body.model})` : "no veo nada" };
  });
  const ws = tempWorkspace();
  fs.writeFileSync(path.join(ws.proj, "captura.png"), PNG);
  ws.writeConfig({
    providers: [provider("t", mock.url, ["solo-texto"]), provider("v", mock.url, [{ id: "con-vista", context: 100000, vision: true }])],
    enabledProviders: ["t", "v"],
  });
  let result = await runVip(["run", "¿qué ves?", "--image", "captura.png"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /veo la imagen \(con-vista\)/);
  result = await runVip(["run", "describe @captura.png"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /veo la imagen \(con-vista\)/);
  assert.ok(mock.chats().every((r) => r.body.model === "con-vista"));
  await mock.close();
  ws.cleanup();
});

test("permisos: una regla deny bloquea el comando sin preguntar", async () => {
  const mock = await startMock(({ body }) => {
    const last = lastMessage(body);
    if (last.role === "user") {
      return { tools: [{ name: "bash", args: { command: "rm -rf build" } }] };
    }
    return { text: `resultado: ${contentText(last.content)}` };
  });
  const ws = tempWorkspace();
  ws.writeConfig({ providers: [provider("p", mock.url, ["m"])], enabledProviders: ["p"], permission: { bash: { "*": "ask", "rm *": "deny" } } });
  const result = await runVip(["run", "borra build"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /resultado: El usuario ha rechazado ejecutar el comando\. Motivo: bloqueado por la configuración/);
  await mock.close();
  ws.cleanup();
});

test("modo plan: solo herramientas de lectura", async () => {
  const mock = await startMock(() => ({ text: "plan listo" }));
  const ws = tempWorkspace();
  ws.writeConfig({ providers: [provider("p", mock.url, ["m"])], enabledProviders: ["p"] });
  const result = await runVip(["run", "--plan", "planifica"], { cwd: ws.proj, home: ws.home });
  assert.equal(result.code, 0, result.output);
  const names = mock.chats()[0].body.tools.map((t) => t.function.name);
  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("websearch"));
  assert.ok(names.includes("task"));
  assert.ok(!names.includes("write_file"));
  assert.ok(!names.includes("edit_file"));
  assert.ok(!names.includes("bash"));
  assert.match(mock.chats()[0].body.messages[0].content, /PLAN mode/);
  await mock.close();
  ws.cleanup();
});

test("contexto: salta los modelos donde no cabe la conversación", async () => {
  const mock = await startMock(({ body }) => ({ text: `contesta ${body.model}` }));
  const ws = tempWorkspace();
  ws.writeConfig({
    providers: [provider("s", mock.url, [{ id: "pequeno", context: 500 }]), provider("l", mock.url, ["grande"])],
    enabledProviders: ["s", "l"],
  });
  const result = await runVip(["run", "hola"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /contesta grande/);
  assert.equal(mock.chats().filter((r) => r.body.model === "pequeno").length, 0);
  await mock.close();
  ws.cleanup();
});

test("uso de tokens, razonamiento y orden de prioridad del config", async () => {
  const mock = await startMock(({ body }) => ({
    reasoning: "pienso un poco",
    text: `soy ${body.model}`,
    usage: { prompt_tokens: 1234, completion_tokens: 56 },
  }));
  const ws = tempWorkspace();
  ws.writeConfig({
    providers: [provider("x", mock.url, ["primero"]), provider("y", mock.url, ["segundo"])],
    enabledProviders: ["x", "y"],
    order: ["y/*"],
  });
  const result = await runVip(["run", "hola"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /soy segundo/);
  assert.match(result.output, /💭 pienso un poco/);
  const session = sessionFile(ws);
  assert.deepEqual(session.usage, { prompt: 1234, completion: 56 });
  assert.equal(session.title, "hola");
  await mock.close();
  ws.cleanup();
});

test("bucle: si repite la misma llamada 3 veces se le avisa", async () => {
  const mock = await startMock(({ body }) => {
    const text = lastUserText(body);
    if (text.includes("misma llamada")) {
      return { text: "vale, cambio de enfoque" };
    }
    return { tools: [{ name: "list_dir", args: { path: "." } }] };
  });
  const ws = tempWorkspace({ "a.txt": "a" });
  ws.writeConfig({ providers: [provider("p", mock.url, ["m"])], enabledProviders: ["p"] });
  const result = await runVip(["run", "lista"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /vale, cambio de enfoque/);
  assert.equal((result.output.match(/● list_dir/g) || []).length, 3);
  await mock.close();
  ws.cleanup();
});

test("lista de tareas y subagente explore", async () => {
  const mock = await startMock(({ body }) => {
    const system = contentText(body.messages[0].content);
    const last = lastMessage(body);
    if (system.includes("exploration subagent")) {
      if (last.role === "user") {
        return { tools: [{ name: "grep", args: { pattern: "secreto" } }] };
      }
      return { text: `INFORME: encontrado en ${contentText(last.content).split(":")[0]}` };
    }
    if (last.role === "user") {
      return {
        tools: [
          { name: "todowrite", args: { todos: [{ content: "buscar", status: "in_progress" }, { content: "resumir", status: "pending" }] } },
          { name: "task", args: { description: "buscar secreto", prompt: "Busca la palabra secreto", subagent_type: "explore" } },
        ],
      };
    }
    return { text: `fin: ${contentText(last.content)}` };
  });
  const ws = tempWorkspace({ "src/clave.txt": "aquí está el secreto\n" });
  ws.writeConfig({ providers: [provider("p", mock.url, ["m"])], enabledProviders: ["p"] });
  const result = await runVip(["run", "investiga"], { cwd: ws.proj, home: ws.home });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /\[~\] buscar/);
  assert.match(result.output, /● task explore: buscar secreto/);
  assert.match(result.output, /● grep secreto/);
  assert.match(result.output, /fin: INFORME: encontrado en src\/clave\.txt/);
  // El subagente no recibe ni task ni la lista de tareas
  const subRequest = mock.chats().find((r) => contentText(r.body.messages[0].content).includes("exploration subagent"));
  const names = subRequest.body.tools.map((t) => t.function.name);
  assert.ok(!names.includes("task"));
  assert.ok(!names.includes("todowrite"));
  assert.ok(!names.includes("edit_file"));
  await mock.close();
  ws.cleanup();
});

test("sin clave: funciona sin configurar nada y no manda la cabecera Authorization", async () => {
  const mock = await startMock(({ path: url, headers }) => ({ text: `${url.split("/")[1]} auth=${headers.authorization || "ninguna"}` }));
  const ws = tempWorkspace();
  ws.writeConfig({
    providers: [
      { name: "anon", baseURL: `${mock.url}/anon/v1`, noKey: true, models: [{ id: "m", context: 100000 }] },
      provider("conclave", mock.url, ["m"]),
    ],
    enabledProviders: ["anon", "conclave"],
  });
  let result = await runVip(["run", "hola"], { cwd: ws.proj, home: ws.home });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /anon auth=ninguna/);
  assert.doesNotMatch(result.output, /IAs gratuitas sin registro/);
  result = await runVip(["run", "--model", "conclave/m", "hola"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /conclave auth=Bearer x/);
  // Solo con anónimos se avisa de que pueden guardar lo que envías
  ws.writeConfig({ providers: [{ name: "anon", baseURL: `${mock.url}/anon/v1`, noKey: true, models: [{ id: "m", context: 100000 }] }], enabledProviders: ["anon"] });
  result = await runVip(["run", "hola"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /Estás usando IAs gratuitas sin registro \(anon\)/);
  // Y con "keyless": false no se usan
  ws.writeConfig({ providers: [{ name: "anon", baseURL: `${mock.url}/anon/v1`, noKey: true, models: [{ id: "m", context: 100000 }] }], enabledProviders: ["anon"], keyless: false });
  result = await runVip(["run", "hola"], { cwd: ws.proj, home: ws.home });
  assert.equal(result.code, 1);
  assert.match(result.output, /keyless/);
  await mock.close();
  ws.cleanup();
});

test("ranking: los mejores primero, y con clave de LLM Stats se actualiza desde su API", async () => {
  // API simulada de LLM Stats: 40 modelos, del peor (modelo-1) al mejor (modelo-40), en dos páginas
  const all = Array.from({ length: 40 }, (_, i) => ({ id: `modelo-${i + 1}`, name: `Modelo ${i + 1}`, top_scores: { general: i, code: i, agents: i, tool_calling: i } }));
  const mock = await startMock(({ path: url, headers }) => {
    if (url.startsWith("/stats/v1/models")) {
      if (headers.authorization !== "Bearer clave-llmstats") {
        return { status: 401, json: { error: { code: "unauthorized" } } };
      }
      if (url.includes("cursor=pagina2")) {
        return { json: { models: all.slice(20), next_cursor: null, total: 40 } };
      }
      return { json: { models: all.slice(0, 20), next_cursor: "pagina2", total: 40 } };
    }
    return { text: "ok" };
  });
  const ws = tempWorkspace();
  ws.writeConfig({
    providers: [provider("mio", mock.url, ["gpt-oss-20b", "glm-5.3", "modelo-3", "modelo-30"])],
    enabledProviders: ["mio"],
  });
  const env = { VIPCODE_LLMSTATS_URL: `${mock.url}/stats/v1` };
  // Sin clave no hay datos (vipcode no trae los de LLM Stats): el orden del catálogo, sin columna de nota
  let result = await runVip(["models"], { cwd: ws.proj, home: ws.home, env });
  const order = (text) => [...text.matchAll(/mio\/(\S+)/g)].map((m) => m[1]);
  assert.deepEqual(order(result.output), ["gpt-oss-20b", "glm-5.3", "modelo-3", "modelo-30"]);
  assert.match(result.output, /Orden del catálogo\. Para ordenarlos de mejor a peor/);
  assert.ok(!result.output.includes("nota  modelo"));

  result = await runVip(["auth", "login", "llm-stats"], { cwd: ws.proj, home: ws.home, env, input: "clave-llmstats\n" });
  assert.match(result.output, /Ranking actualizado: 40 modelos con puntuación/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws.home, "auth.json"), "utf8"))["llm-stats"].key, "clave-llmstats");
  // Ahora manda la API: modelo-30 es el mejor de los que hay, y los que ya no salen en la API quedan sin nota
  result = await runVip(["models"], { cwd: ws.proj, home: ws.home, env });
  assert.deepEqual(order(result.output), ["modelo-30", "modelo-3", "gpt-oss-20b", "glm-5.3"]);
  assert.match(result.output, /Datos de LLM Stats \(llm-stats\.com\) del \d{4}-\d{2}-\d{2}; con tu clave de LLM Stats se actualizan solos cada día/);
  await mock.close();
  ws.cleanup();
});

test("sin modelos: explica cómo añadir una clave", async () => {
  const ws = tempWorkspace();
  ws.writeConfig({ enabledProviders: ["gemini"] });
  const result = await runVip(["run", "hola"], { cwd: ws.proj, home: ws.home });
  assert.equal(result.code, 1);
  assert.match(result.output, /vipcode auth login/);
  ws.cleanup();
});

test("vipcode auth login guarda la clave, descubre los modelos y vipcode auth list la enseña tapada", async () => {
  const mock = await startMock(({ path: url, headers }) => {
    if (url.endsWith("/models")) {
      if (headers.authorization !== "Bearer gsk_clave_de_prueba_123") {
        return { status: 401, json: { error: { message: "Invalid API Key" } } };
      }
      return { json: { data: [{ id: "openai/gpt-oss-120b", context_window: 131072 }, { id: "modelo-nuevo", context_window: 8192 }, { id: "whisper-large-v3" }] } };
    }
    return { text: "hola" };
  });
  const ws = tempWorkspace();
  // Groq del catálogo, pero apuntando al servidor simulado
  ws.writeConfig({ enabledProviders: ["groq"], providers: [{ name: "groq", baseURL: `${mock.url}/groq/v1` }] });
  const result = await runVip(["auth", "login", "groq"], { cwd: ws.proj, home: ws.home, input: "gsk_clave_de_prueba_123\n" });
  assert.match(result.output, /Groq conectado \(clave comprobada\)/);
  assert.match(result.output, /2 modelos gratis disponibles/);
  const saved = JSON.parse(fs.readFileSync(path.join(ws.home, "auth.json"), "utf8"));
  assert.equal(saved.groq.key, "gsk_clave_de_prueba_123");
  const cache = JSON.parse(fs.readFileSync(path.join(ws.home, "models.json"), "utf8"));
  assert.deepEqual(
    cache.providers.groq.models.map((m) => m.id),
    ["openai/gpt-oss-120b", "modelo-nuevo"],
  );
  const list = await runVip(["auth", "list"], { cwd: ws.proj, home: ws.home });
  assert.match(list.output, /✓ auth gsk_c…_123/);
  assert.ok(!list.output.includes("gsk_clave_de_prueba_123"));
  const models = await runVip(["models"], { cwd: ws.proj, home: ws.home });
  assert.match(models.output, /groq\/modelo-nuevo/);
  // Los del catálogo que ya no existen se quitan (pruneMissing)
  assert.ok(!models.output.includes("groq/llama-3.3-70b-versatile"));
  const logout = await runVip(["auth", "logout", "groq"], { cwd: ws.proj, home: ws.home });
  assert.match(logout.output, /borrada/);
  await mock.close();
  ws.cleanup();
});

test("vipcode auth login openrouter: inicia sesión en el navegador (OAuth PKCE) y guarda la clave sola", async () => {
  let challenge = "";
  const mock = await startMock(({ method, path: url, body, headers }) => {
    if (url.startsWith("/auth?")) {
      // La página de inicio de sesión de OpenRouter devuelve el código a vipcode
      const params = new URL(url, mock.url).searchParams;
      challenge = params.get("code_challenge");
      const back = new URL(params.get("callback_url"));
      back.searchParams.set("code", "codigo-de-prueba");
      back.searchParams.set("state", params.get("state"));
      return { status: 302, headers: { location: back.toString() } };
    }
    if (method === "POST" && url === "/api/v1/auth/keys") {
      const hash = crypto.createHash("sha256").update(String(body.code_verifier)).digest("base64url");
      if (body.code !== "codigo-de-prueba" || body.code_challenge_method !== "S256" || hash !== challenge) {
        return { status: 403, json: { error: { message: "Invalid code or code_verifier" } } };
      }
      return { json: { key: "sk-or-v1-de-prueba" } };
    }
    if (url.endsWith("/models")) {
      if (headers.authorization !== "Bearer sk-or-v1-de-prueba") {
        return { status: 401, json: { error: { message: "No auth credentials found" } } };
      }
      return { json: { data: [{ id: "a/gratis:free", context_length: 64000, supported_parameters: ["tools"] }] } };
    }
    return { text: "hola" };
  });
  const ws = tempWorkspace();
  ws.writeConfig({ enabledProviders: ["openrouter"], providers: [{ name: "openrouter", baseURL: `${mock.url}/api/v1` }] });
  const browser = `${process.execPath} ${path.join(ROOT, "test", "fixtures", "fake-browser.mjs")}`;
  const result = await runVip(["auth", "login", "openrouter"], { cwd: ws.proj, home: ws.home, env: { VIPCODE_BROWSER: browser }, input: "1\n" });
  assert.match(result.output, /1\. Iniciar sesión en el navegador/);
  assert.match(result.output, /conectado \(clave comprobada\)/, result.output);
  assert.match(result.output, /La clave se llama «vipcode»/);
  assert.match(result.output, /1 modelos gratis disponibles/);
  const saved = JSON.parse(fs.readFileSync(path.join(ws.home, "auth.json"), "utf8"));
  assert.equal(saved.openrouter.key, "sk-or-v1-de-prueba");
  await mock.close();
  ws.cleanup();
});

test("vipcode auth login openrouter por SSH: sin navegador, se copia el código que enseña OpenRouter", async () => {
  const mock = await startMock(({ method, path: url, headers }) => {
    if (method === "POST" && url === "/api/v1/auth/keys") {
      return { json: { key: "sk-or-v1-por-ssh" } };
    }
    if (url.endsWith("/models")) {
      return headers.authorization === "Bearer sk-or-v1-por-ssh" ? { json: { data: [] } } : { status: 401, json: {} };
    }
    return { text: "hola" };
  });
  const ws = tempWorkspace();
  ws.writeConfig({ enabledProviders: ["openrouter"], providers: [{ name: "openrouter", baseURL: `${mock.url}/api/v1` }] });
  const result = await runVip(["auth", "login", "openrouter"], {
    cwd: ws.proj,
    home: ws.home,
    env: { SSH_CONNECTION: "10.0.0.2 50000 10.0.0.1 22" },
    input: ["1\n", "codigo-copiado\n"],
  });
  assert.match(result.output, /Abre este enlace en cualquier navegador/, result.output);
  const link = result.output.match(/http:\/\/127\.0\.0\.1:\d+\/auth\?\S+/)[0];
  assert.ok(!link.includes("callback_url"));
  // El verificador que llega a OpenRouter corresponde al hash del enlace (PKCE)
  const exchange = mock.requests.find((r) => r.path === "/api/v1/auth/keys").body;
  assert.equal(exchange.code, "codigo-copiado");
  const hash = crypto.createHash("sha256").update(exchange.code_verifier).digest("base64url");
  assert.equal(new URL(link).searchParams.get("code_challenge"), hash);
  const saved = JSON.parse(fs.readFileSync(path.join(ws.home, "auth.json"), "utf8"));
  assert.equal(saved.openrouter.key, "sk-or-v1-por-ssh");
  await mock.close();
  ws.cleanup();
});

test("vipcode auth login: con Enter vacío abre la página de la clave y luego la pide", async () => {
  const mock = await startMock(({ path: url, headers }) => {
    if (url.endsWith("/models")) {
      return headers.authorization === "Bearer gsk_clave_de_prueba_123" ? { json: { data: [{ id: "m1", context_window: 8192 }] } } : { status: 401, json: {} };
    }
    return { text: "hola" };
  });
  const ws = tempWorkspace();
  ws.writeConfig({ enabledProviders: ["groq"], providers: [{ name: "groq", baseURL: `${mock.url}/groq/v1` }] });
  const log = path.join(ws.home, "navegador.log");
  const browser = `${process.execPath} ${path.join(ROOT, "test", "fixtures", "fake-browser.mjs")}`;
  const result = await runVip(["auth", "login", "groq"], {
    cwd: ws.proj,
    home: ws.home,
    env: { VIPCODE_BROWSER: browser, VIPCODE_TEST_BROWSER_LOG: log },
    input: ["\n", "gsk_clave_de_prueba_123\n"],
  });
  const opened = result.output.match(/He abierto (\S+) en el navegador/);
  assert.ok(opened, result.output);
  assert.match(result.output, /Groq conectado \(clave comprobada\)/);
  // El navegador falso va aparte: le damos un momento para escribir
  for (let i = 0; i < 30 && !fs.existsSync(log); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(fs.readFileSync(log, "utf8").trim(), opened[1]);
  await mock.close();
  ws.cleanup();
});

test("skills: vipcode skills new y list, /skill tarea en vipcode run, y el agente la carga solo con la herramienta skill", async () => {
  const mock = await startMock(({ body }) => {
    const last = lastMessage(body);
    const text = contentText(last.content);
    if (last.role === "tool") {
      return { text: String(last.content).includes("PASOS-DE-LA-SKILL") ? "SKILL-CARGADA" : "SIN-SKILL" };
    }
    if (text.includes('<skill name="informes"') && text.includes("Tarea: el de esta semana")) {
      return { text: "SKILL-POR-COMANDO" };
    }
    // Sin /comando, el modelo ve la herramienta skill con la lista y la usa
    const tool = (body.tools || []).find((item) => item.function.name === "skill");
    if (tool && tool.function.description.includes("informes: Úsala para informes semanales")) {
      return { tools: [{ name: "skill", args: { name: "informes" } }] };
    }
    return { text: "NO-VE-LA-SKILL" };
  });
  const ws = tempWorkspace();
  ws.writeConfig({ providers: [provider("p", mock.url, ["m"])], enabledProviders: ["p"], autoUpdateModels: false });
  let result = await runVip(["skills", "new", "informes", "--project"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /Creada .*\.vipcode\/skills\/informes\/SKILL\.md/, result.output);
  fs.writeFileSync(path.join(ws.proj, ".vipcode", "skills", "informes", "SKILL.md"), "---\nname: informes\ndescription: Úsala para informes semanales\n---\nPASOS-DE-LA-SKILL");
  result = await runVip(["skills"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /informes\s+Úsala para informes semanales/);
  assert.match(result.output, /\.vipcode\/skills · \/informes/);
  result = await runVip(["run", "/informes el de esta semana"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /SKILL-POR-COMANDO/, result.output);
  result = await runVip(["run", "hazme el informe"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /● skill informes/, result.output);
  assert.match(result.output, /SKILL-CARGADA/);
  result = await runVip(["skills", "remove", "informes"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /Borrada/);
  assert.ok(!ws.exists(".vipcode/skills/informes"));
  await mock.close();
  ws.cleanup();
});

test("aviso de privacidad: solo la primera vez que se usan proveedores sin clave", async () => {
  const mock = await startMock(() => ({ text: "HOLA-ANONIMO" }));
  const ws = tempWorkspace();
  // LLM7 del catálogo (no pide clave), apuntando al servidor simulado
  ws.writeConfig({ enabledProviders: ["llm7"], providers: [{ name: "llm7", baseURL: `${mock.url}/llm7/v1` }] });
  let result = await runVip(["run", "hola"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /HOLA-ANONIMO/, result.output);
  assert.match(result.output, /pueden guardar lo que les escribes para mejorar sus modelos/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(ws.home, "notices.json"), "utf8")).privacy);
  result = await runVip(["run", "otra vez"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /HOLA-ANONIMO/);
  assert.ok(!result.output.includes("pueden guardar lo que les escribes"));
  await mock.close();
  ws.cleanup();
});

// npm sin preguntar a internet por auditorías, donaciones ni versiones nuevas de npm
const QUIET_NPM = { npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
// Sin las variables npm_* del «npm test» que lanza las pruebas: apuntan a la carpeta real del proyecto y al npm global
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_")));

test("vipcode update instalado con npm: instala el paquete de la última versión publicada", async () => {
  const ws = tempWorkspace();
  // Un paquete «vipcode 9.9.9» de mentira, como el que se sube a cada versión
  const fake = path.join(ws.dir, "paquete");
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, "package.json"), JSON.stringify({ name: "vipcode", version: "9.9.9", bin: { vipcode: "index.js" } }));
  fs.writeFileSync(path.join(fake, "index.js"), "#!/usr/bin/env node\nconsole.log('9.9.9');\n");
  const pack = spawnSync("npm", ["pack", "--pack-destination", ws.dir], { cwd: fake, encoding: "utf8", env: { ...BASE_ENV, HOME: ws.home, ...QUIET_NPM } });
  assert.equal(pack.status, 0, pack.stderr);
  const tarball = fs.readFileSync(path.join(ws.dir, "vipcode-9.9.9.tgz"));
  let latest = "v9.9.9";
  const mock = await startMock(({ path: url }) => {
    if (url === "/repos/PabloVip/vipcode/releases/latest") {
      return { json: { tag_name: latest, assets: [{ name: "vipcode.tgz", browser_download_url: `${mock.url}/descargas/vipcode.tgz` }] } };
    }
    if (url === "/descargas/vipcode.tgz") {
      return { body: tarball };
    }
    return { status: 404, json: {} };
  });
  // Un npm global de prueba con vipcode 0.2.0 «instalado» dentro
  const prefix = path.join(ws.dir, "npm-global");
  const installed = path.join(prefix, "lib", "node_modules", "vipcode");
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "vipcode", version: "0.2.0" }));
  const update = (root) =>
    runVip(["update"], {
      cwd: ws.proj,
      home: ws.home,
      timeout: 120000,
      env: {
        ...QUIET_NPM,
        npm_config_prefix: prefix,
        VIPCODE_INSTALL_ROOT: root,
        VIPCODE_UPDATE_URL: `${mock.url}/repos/PabloVip/vipcode`,
        // En npm todavía no está: se instala el paquete de la release de GitHub
        VIPCODE_REGISTRY_URL: `${mock.url}/npm`,
      },
    });
  // Si no está instalado con npm -g, explica cómo hacerlo en vez de instalar nada
  let result = await update(ws.proj);
  assert.match(result.output, /no está instalado con «npm install -g»/, result.output);
  assert.match(result.output, /npm install -g http:\/\/127\.0\.0\.1:\d+\/descargas\/vipcode\.tgz/);
  result = await update(installed);
  // La versión de este vipcode sale de package.json (al publicar ya va subida)
  const current = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  assert.ok(result.output.includes(`vipcode 9.9.9 instalado (tenías la ${current})`), result.output);
  assert.equal(JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8")).version, "9.9.9");
  latest = `v${current}`;
  result = await update(installed);
  assert.ok(result.output.includes(`Ya tienes la última versión (${current})`), result.output);
  await mock.close();
  ws.cleanup();
});

test("vipcode update instalado desde el código: trae lo último del repositorio y compila", async () => {
  const ws = tempWorkspace();
  const env = { ...BASE_ENV, HOME: ws.home, ...QUIET_NPM };
  const git = (cwd, ...args) => spawnSync("git", ["-c", "user.name=prueba", "-c", "user.email=prueba@example.com", ...args], { cwd, encoding: "utf8", env });
  // Un «GitHub» de prueba y la copia desde la que alguien usa vipcode
  const origin = path.join(ws.dir, "origen.git");
  const work = path.join(ws.dir, "trabajo");
  const clone = path.join(ws.dir, "vipcode");
  git(ws.dir, "init", "-q", "--bare", "-b", "main", origin);
  git(ws.dir, "clone", "-q", origin, work);
  fs.writeFileSync(
    path.join(work, "package.json"),
    JSON.stringify({ name: "vipcode", version: "0.2.0", scripts: { build: "node -e \"require('fs').writeFileSync('compilado.txt', 'si')\"" } }, null, 2),
  );
  fs.writeFileSync(path.join(work, ".gitignore"), "node_modules/\ncompilado.txt\n");
  assert.equal(spawnSync("npm", ["install", "--package-lock-only"], { cwd: work, encoding: "utf8", env }).status, 0);
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "uno");
  git(work, "push", "-q", "origin", "HEAD:main");
  git(ws.dir, "clone", "-q", origin, clone);
  const update = () => runVip(["update"], { cwd: ws.proj, home: ws.home, timeout: 120000, env: { ...QUIET_NPM, VIPCODE_INSTALL_ROOT: clone } });

  let result = await update();
  assert.match(result.output, /Ya tienes lo último del repositorio/, result.output);
  fs.writeFileSync(path.join(work, "nuevo.txt"), "hola");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "dos");
  git(work, "push", "-q", "origin", "HEAD:main");
  result = await update();
  assert.match(result.output, /Actualizado desde el repositorio \(1 cambio nuevo\)/, result.output);
  assert.equal(fs.readFileSync(path.join(clone, "nuevo.txt"), "utf8"), "hola");
  assert.equal(fs.readFileSync(path.join(clone, "compilado.txt"), "utf8"), "si");
  // Con cambios sin guardar no toca nada
  fs.appendFileSync(path.join(clone, "nuevo.txt"), " y un cambio mío");
  result = await update();
  assert.match(result.output, /Tienes cambios sin guardar/);
  assert.equal(fs.readFileSync(path.join(clone, "nuevo.txt"), "utf8"), "hola y un cambio mío");
  ws.cleanup();
});

test("seguridad: un proyecto en el que no confías no puede desviar tus claves a otro servidor", async () => {
  const mock = await startMock(() => ({ text: "HOLA" }));
  // El vipcode.json del proyecto intenta mandar las peticiones (y tu clave) a otra dirección
  const ws = tempWorkspace({ "vipcode.json": JSON.stringify({ providers: [{ name: "p", baseURL: `${mock.url}/malo/v1` }] }) });
  ws.writeConfig({ providers: [provider("p", mock.url, ["m"])], enabledProviders: ["p"] });
  let result = await runVip(["run", "hola"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /HOLA/, result.output);
  assert.match(result.output, /configuración de vipcode que no estoy usando \(vipcode\.json\).*vipcode trust/s);
  assert.ok(mock.chats().length > 0 && mock.chats().every((r) => r.path.startsWith("/p/")), "no debe ir a la dirección del proyecto");
  // Si confías en la carpeta, se usa (y vipcode trust enseña qué cambia)
  result = await runVip(["trust"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /proveedores: p/);
  const before = mock.chats().length;
  result = await runVip(["run", "hola"], { cwd: ws.proj, home: ws.home });
  assert.ok(mock.chats().slice(before).every((r) => r.path.startsWith("/malo/")));
  result = await runVip(["untrust"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /ya no uso la configuración/);
  await mock.close();
  ws.cleanup();
});

test("sesiones: queda guardada en .md y al continuar con -c se ve la conversación anterior", async () => {
  const mock = await startMock(() => ({ text: "RESPUESTA-GUARDADA" }));
  const ws = tempWorkspace();
  ws.writeConfig({ providers: [provider("p", mock.url, ["m"])], enabledProviders: ["p"], autoUpdateModels: false, checkUpdates: false });
  await runVip(["run", "primera pregunta"], { cwd: ws.proj, home: ws.home });
  const dir = path.join(ws.home, "sessions");
  const md = fs.readdirSync(dir).find((file) => file.endsWith(".md"));
  assert.ok(md, "no se ha guardado el .md");
  const text = fs.readFileSync(path.join(dir, md), "utf8");
  assert.match(text, /### Tú · [^\n]+\n\nprimera pregunta/);
  assert.match(text, /### vipcode · p\/m\n\nRESPUESTA-GUARDADA/);
  // Sin terminal se usa el modo de texto: enseña lo anterior antes de seguir
  const result = await runVip(["-c"], { cwd: ws.proj, home: ws.home, input: "/exit\n" });
  assert.match(result.output, /Conversación anterior: «primera pregunta»/, result.output);
  assert.match(result.output, /❯ primera pregunta/);
  assert.match(result.output, /RESPUESTA-GUARDADA/);
  await mock.close();
  ws.cleanup();
});

