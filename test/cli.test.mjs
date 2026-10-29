import assert from "node:assert/strict";
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
  assert.doesNotMatch(result.output, /Sin claves/);
  result = await runVip(["run", "--model", "conclave/m", "hola"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /conclave auth=Bearer x/);
  // Solo con anónimos se avisa de que pueden guardar lo que envías
  ws.writeConfig({ providers: [{ name: "anon", baseURL: `${mock.url}/anon/v1`, noKey: true, models: [{ id: "m", context: 100000 }] }], enabledProviders: ["anon"] });
  result = await runVip(["run", "hola"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /Sin claves: usando modelos gratis anónimos \(anon\)/);
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
  assert.match(result.output, /Pueden guardar lo que les envías y usarlo para mejorar sus modelos/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(ws.home, "notices.json"), "utf8")).privacy);
  result = await runVip(["run", "otra vez"], { cwd: ws.proj, home: ws.home });
  assert.match(result.output, /HOLA-ANONIMO/);
  assert.ok(!result.output.includes("Pueden guardar lo que les envías y usarlo"));
  await mock.close();
  ws.cleanup();
});

