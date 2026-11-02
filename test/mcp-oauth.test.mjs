import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { contentText, lastMessage, provider, startMock, tempWorkspace } from "./helpers/mock-llm.mjs";

const shared = tempWorkspace();
process.env.VIPCODE_HOME = shared.home;
process.env.HOME = shared.home;
delete process.env.FORCE_COLOR;
process.env.NO_COLOR = "1";
const { App } = await import("../dist/app.js");
const SESSIONS = path.join(shared.home, "mcp-auth.json");

// Un «navegador» de mentira: abre la dirección siguiendo las redirecciones, como haría uno de verdad
const BROWSER = path.join(shared.dir, "navegador.cjs");
fs.writeFileSync(
  BROWSER,
  `const fs = require("node:fs");
fs.appendFileSync(process.env.VIPCODE_PRUEBA_NAVEGADOR, process.argv[2] + "\\n");
fetch(process.argv[2]).catch(() => {});
`,
);
const OPENED = path.join(shared.dir, "abierto.txt");
process.env.VIPCODE_BROWSER = `"${process.execPath}" "${BROWSER}"`;
process.env.VIPCODE_PRUEBA_NAVEGADOR = OPENED;
const opened = () => (fs.existsSync(OPENED) ? fs.readFileSync(OPENED, "utf8").trim().split("\n").filter(Boolean) : []);

// Un servidor MCP de verdad (el del SDK) con su propio servidor de OAuth delante: registro, PKCE, código, token y renovación
async function oauthServer(behaviour = {}) {
  const log = { register: 0, tokenRequests: [], bearer: [], authorize: [], calls: 0 };
  const valid = new Set();
  const refresh = new Set();
  const challenges = new Map();
  let counter = 0;
  const issue = () => {
    const access = `acceso-${++counter}`;
    const renew = `renovar-${counter}`;
    valid.add(access);
    refresh.add(renew);
    return { access_token: access, refresh_token: renew, token_type: "Bearer", expires_in: 3600 };
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const base = `http://${req.headers.host}`;
      const json = (status, body, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
        return json(200, {
          issuer: base,
          authorization_endpoint: behaviour.authorizationEndpoint || `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register") {
        log.register++;
        const body = JSON.parse(raw);
        return json(201, { client_id: `cliente-${log.register}`, redirect_uris: body.redirect_uris, token_endpoint_auth_method: "none" });
      }
      if (url.pathname === "/authorize") {
        log.authorize.push(Object.fromEntries(url.searchParams));
        const code = `codigo-${log.authorize.length}`;
        challenges.set(code, url.searchParams.get("code_challenge"));
        const back = new URL(url.searchParams.get("redirect_uri"));
        // Una página cualquiera que llama a la vuelta sin el «state» bueno: no tiene que valer
        if (behaviour.forgeState) {
          await fetch(`${back.origin}${back.pathname}?code=robado&state=otro`).catch(() => {});
          await fetch(`${back.origin}${back.pathname}?code=robado`).catch(() => {});
        }
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state"));
        res.writeHead(302, { location: back.href });
        return res.end();
      }
      if (url.pathname === "/token") {
        const form = new URLSearchParams(raw);
        log.tokenRequests.push(Object.fromEntries(form));
        if (form.get("grant_type") === "refresh_token") {
          if (!refresh.has(form.get("refresh_token")) || behaviour.refuseRefresh) {
            return json(400, { error: "invalid_grant" });
          }
          return json(200, issue());
        }
        const expected = challenges.get(form.get("code"));
        const got = crypto.createHash("sha256").update(form.get("code_verifier") || "").digest("base64url");
        if (!expected || expected !== got) {
          return json(400, { error: "invalid_grant" });
        }
        return json(200, issue());
      }
      if (url.pathname === "/mcp") {
        const bearer = (req.headers.authorization || "").replace(/^Bearer /, "");
        log.bearer.push(bearer);
        if (!valid.has(bearer)) {
          return json(401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
        }
        const mcp = new Server({ name: "privado", version: "1.0.0" }, { capabilities: { tools: {} } });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "saludo", description: "Saluda", inputSchema: { type: "object", properties: {} } }] }));
        mcp.setRequestHandler(CallToolRequestSchema, async () => {
          log.calls++;
          return { content: [{ type: "text", text: "hola desde el servidor privado" }] };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await mcp.connect(transport);
        return transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    log,
    valid,
    behaviour,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function makeApp(ws, llmUrl, mcp) {
  fs.writeFileSync(path.join(shared.home, "config.json"), JSON.stringify({ providers: [provider("p", llmUrl, ["m"])], enabledProviders: ["p"], autoUpdateModels: false, mcp }));
  const app = new App(ws.proj);
  app.setYolo(true);
  return app;
}

const ui = () => {
  const out = { info: [], error: [], block: [], notice: [] };
  return { out, adapter: { info: (t) => out.info.push(t), error: (t) => out.error.push(t), block: (t) => out.block.push(t), notice: (t) => out.notice.push(t) } };
};

function reset() {
  fs.rmSync(SESSIONS, { force: true });
  fs.rmSync(OPENED, { force: true });
}

test("MCP con OAuth: sin sesión no hace nada solo, /mcp login la inicia, se recuerda, se renueva y /mcp logout la olvida", async () => {
  reset();
  const remote = await oauthServer();
  const llm = await startMock(({ body }) => {
    const last = lastMessage(body);
    return last.role === "user" ? { tools: [{ name: "privado_saludo", args: {} }] } : { text: `resultado: ${contentText(last.content)}` };
  });
  const ws = tempWorkspace();
  let app = makeApp(ws, llm.url, { privado: { url: remote.url } });
  await app.startMcp();

  // Al arrancar, sin sesión: dice cómo iniciarla, y ni abre el navegador ni se registra en el servidor sin que lo pidas
  let status = app.mcp.status()[0];
  assert.equal(status.state, "error");
  assert.match(status.error, /pide iniciar sesión: escribe \/mcp login privado/);
  assert.equal(remote.log.register, 0);
  assert.deepEqual(opened(), []);
  assert.ok(!fs.existsSync(SESSIONS));

  // /mcp login: abre el navegador con PKCE y state, vuelve y se conecta
  let { out, adapter } = ui();
  await app.handleCommand("/mcp login privado", adapter);
  assert.deepEqual(out.error, []);
  assert.match(out.info.join("\n"), /Abro el navegador para que inicies sesión en privado/);
  assert.match(out.info.at(-1), /privado: conectado \(1 herramientas\)/);
  assert.equal(opened().length, 1);
  assert.equal(new URL(opened()[0]).origin, new URL(remote.url).origin);
  const asked = remote.log.authorize[0];
  assert.equal(asked.code_challenge_method, "S256");
  assert.ok(asked.state && asked.code_challenge);
  assert.match(asked.redirect_uri, /^http:\/\/localhost:\d+\/callback$/);

  // La sesión se guarda solo para ti y las herramientas de vipcode no pueden leerla
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(SESSIONS).mode & 0o777, 0o600);
  }
  assert.match(fs.readFileSync(SESSIONS, "utf8"), /acceso-1/);

  // El agente usa la herramienta con esa sesión
  await app.runPrompt({ text: "saluda" }, {});
  assert.equal(remote.log.calls, 1);
  assert.equal(remote.log.bearer.at(-1), "acceso-1");
  await app.shutdown();

  // Al volver a abrir vipcode: conecta solo, sin navegador
  fs.rmSync(OPENED, { force: true });
  app = makeApp(ws, llm.url, { privado: { url: remote.url } });
  await app.startMcp();
  assert.equal(app.mcp.status()[0].state, "conectado");
  assert.deepEqual(opened(), []);
  await app.shutdown();

  // Se le caduca la sesión: la renueva sola, sin navegador, y guarda la nueva
  remote.valid.clear();
  app = makeApp(ws, llm.url, { privado: { url: remote.url } });
  await app.startMcp();
  assert.equal(app.mcp.status()[0].state, "conectado", app.mcp.status()[0].error);
  assert.ok(remote.log.tokenRequests.some((request) => request.grant_type === "refresh_token"));
  assert.match(fs.readFileSync(SESSIONS, "utf8"), /acceso-2/);
  assert.deepEqual(opened(), []);

  // Con la sesión buena, /mcp login no pide nada más; si ya no se puede renovar, se vuelve a iniciar con el navegador
  ({ out, adapter } = ui());
  await app.handleCommand("/mcp login privado", adapter);
  assert.match(out.info.at(-1), /privado: conectado/);
  assert.deepEqual(opened(), []);
  remote.valid.clear();
  remote.behaviour.refuseRefresh = true;
  ({ out, adapter } = ui());
  await app.handleCommand("/mcp login privado", adapter);
  assert.deepEqual(out.error, []);
  assert.match(out.info.at(-1), /privado: conectado/);
  assert.equal(opened().length, 1);
  assert.equal(remote.log.register, 2, "se registra otra vez: vuelve a otro puerto");
  remote.behaviour.refuseRefresh = false;

  // /mcp logout: la olvida, deja de ofrecer sus herramientas y dice cómo volver
  ({ out, adapter } = ui());
  await app.handleCommand("/mcp logout privado", adapter);
  status = app.mcp.status()[0];
  assert.equal(status.state, "error");
  assert.equal(app.mcp.tools().length, 0);
  assert.match(out.info.at(-1), /pide iniciar sesión/);
  assert.doesNotMatch(fs.readFileSync(SESSIONS, "utf8"), /acceso/);
  await app.shutdown();
  await remote.close();
  await llm.close();
  ws.cleanup();
});

test("MCP con OAuth (seguridad): la sesión es de esa dirección, el state es obligatorio y solo se abren páginas web", async () => {
  reset();
  const remote = await oauthServer({ forgeState: true });
  const llm = await startMock(() => ({ text: "ok" }));
  const ws = tempWorkspace();
  let app = makeApp(ws, llm.url, { privado: { url: remote.url } });
  await app.startMcp();
  // Una página llama a la vuelta sin el «state» bueno, antes que el de verdad: no vale y el inicio de sesión sigue bien
  let { out, adapter } = ui();
  await app.handleCommand("/mcp login privado", adapter);
  assert.deepEqual(out.error, []);
  assert.equal(app.mcp.status()[0].state, "conectado");
  assert.ok(!remote.log.tokenRequests.some((request) => request.code === "robado"));
  await app.shutdown();

  // Otro servidor con el mismo nombre (la configuración de un proyecto, por ejemplo) no recibe tu sesión
  const other = await oauthServer();
  app = makeApp(ws, llm.url, { privado: { url: other.url } });
  await app.startMcp();
  assert.match(app.mcp.status()[0].error, /pide iniciar sesión/);
  assert.ok(other.log.bearer.every((bearer) => bearer === ""), other.log.bearer.join(","));
  await app.shutdown();

  // Con tu propia cabecera Authorization o con oauth: false, vipcode no se mete: el error es el del servidor
  app = makeApp(ws, llm.url, { privado: { url: other.url, headers: { Authorization: "Bearer mia" } }, otro: { url: other.url, oauth: false } });
  await app.startMcp();
  for (const row of app.mcp.status()) {
    assert.equal(row.state, "error");
    assert.doesNotMatch(row.error, /mcp login/);
  }
  ({ out, adapter } = ui());
  await app.handleCommand("/mcp login privado", adapter);
  assert.match(out.error.at(-1), /no gestiona su sesión/);
  await app.handleCommand("/mcp login no-existe", adapter);
  assert.match(out.error.at(-1), /No hay ningún servidor MCP llamado no-existe/);
  await app.shutdown();
  await other.close();

  // Un servidor que manda iniciar sesión en file: o en otro programa del ordenador: no se abre
  reset();
  const evil = await oauthServer({ authorizationEndpoint: "file:///etc/passwd" });
  app = makeApp(ws, llm.url, { malo: { url: evil.url } });
  await app.startMcp();
  ({ out, adapter } = ui());
  await app.handleCommand("/mcp login malo", adapter);
  assert.equal(out.error.length, 1, out.info.join("\n"));
  assert.deepEqual(opened(), []);
  await app.shutdown();
  await evil.close();

  // Un inicio de sesión que falla no se lleva la sesión que ya había
  const first = await oauthServer();
  app = makeApp(ws, llm.url, { privado: { url: first.url } });
  await app.startMcp();
  ({ adapter } = ui());
  await app.handleCommand("/mcp login privado", adapter);
  assert.equal(app.mcp.status()[0].state, "conectado");
  first.valid.clear();
  first.behaviour.refuseRefresh = true;
  first.behaviour.authorizationEndpoint = "file:///etc/passwd";
  ({ out, adapter } = ui());
  await app.handleCommand("/mcp login privado", adapter);
  assert.equal(out.error.length, 1, out.info.join("\n"));
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(SESSIONS, "utf8"))).includes(first.url));
  await app.shutdown();
  await first.close();

  // Un servidor local no tiene sesión que iniciar
  app = makeApp(ws, llm.url, { local: { command: ["no-existe-este-programa"] } });
  ({ out, adapter } = ui());
  await app.handleCommand("/mcp login local", adapter);
  assert.match(out.error.at(-1), /servidor local/);
  await app.shutdown();
  await remote.close();
  await llm.close();
  ws.cleanup();
});
