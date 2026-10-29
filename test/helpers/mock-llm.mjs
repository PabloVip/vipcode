import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI = path.join(ROOT, "dist", "index.js");

export function contentText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  }
  return "";
}

export function lastMessage(body) {
  return body.messages[body.messages.length - 1];
}

export function lastUserText(body) {
  const users = body.messages.filter((m) => m.role === "user");
  return contentText(users[users.length - 1]?.content);
}

export function systemText(body) {
  return contentText(body.messages.find((m) => m.role === "system")?.content);
}

// Servidor que imita la API de OpenAI; "handler" decide qué contestar en cada petición:
// { text, tools: [{ name, args }], reasoning, usage } en streaming, { status, json } para errores, { json } para /models
export async function startMock(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      const request = { method: req.method, path: req.url, body, headers: req.headers };
      requests.push(request);
      let reply;
      try {
        reply = await handler(request);
      } catch (err) {
        reply = { status: 500, json: { error: { message: String(err) } } };
      }
      if (!reply) {
        reply = { text: "ok" };
      }
      if (reply.status && reply.status !== 200) {
        res.writeHead(reply.status, { "content-type": "application/json", ...(reply.headers || {}) });
        res.end(JSON.stringify(reply.json || {}));
        return;
      }
      if (reply.json) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.json));
        return;
      }
      // Ficheros (por ejemplo un paquete .tgz)
      if (reply.body) {
        res.writeHead(200, { "content-type": reply.contentType || "application/octet-stream" });
        res.end(reply.body);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (reply.reasoning) {
        send({ choices: [{ delta: { reasoning: reply.reasoning } }] });
      }
      if (reply.text) {
        send({ choices: [{ delta: { content: reply.text } }] });
      }
      (reply.tools || []).forEach((tool, index) => {
        send({
          choices: [{ delta: { tool_calls: [{ index, id: `c${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args || {}) } }] } }],
        });
      });
      if (reply.usage) {
        send({ choices: [], usage: reply.usage });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    chats: () => requests.filter((r) => r.path.endsWith("/chat/completions")),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Carpeta temporal con un proyecto y un VIPCODE_HOME propios
export function tempWorkspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-test-"));
  const home = path.join(dir, "home");
  const proj = path.join(dir, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(proj, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return {
    dir,
    home,
    proj,
    writeConfig(config) {
      fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config, null, 2));
    },
    read(name) {
      return fs.readFileSync(path.join(proj, name), "utf8");
    },
    exists(name) {
      return fs.existsSync(path.join(proj, name));
    },
    cleanup() {
      // En Windows una carpeta no se puede borrar mientras algún programa la use: se reintenta un poco
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

// Un proveedor de pruebas que apunta al servidor simulado
export function provider(name, url, models, extra = {}) {
  return {
    name,
    baseURL: `${url}/${name}/v1`,
    apiKey: "x",
    models: models.map((model) => (typeof model === "string" ? { id: model, context: 100000 } : model)),
    ...extra,
  };
}

// Lo mínimo para lanzar programas sin las claves de tu entorno: PATH y una carpeta personal de prueba. En Windows hacen
// falta además algunas variables del sistema (sin SystemRoot, por ejemplo, Node no puede ni abrir conexiones), y la
// carpeta personal sale de USERPROFILE
const WINDOWS_ENV = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"];
export function systemEnv(home) {
  const env = { PATH: process.env.PATH, HOME: home };
  if (process.platform === "win32") {
    for (const name of WINDOWS_ENV) {
      if (process.env[name] !== undefined) {
        env[name] = process.env[name];
      }
    }
    env.USERPROFILE = home;
  }
  return env;
}

// Ejecuta "vipcode ..." sin las claves de tu entorno (solo PATH y HOME), sin colores y sin abrir el navegador.
// Con input como lista, escribe cada respuesta cuando vipcode ha enseñado su pregunta (readline pierde las líneas que llegan antes)
export function runVip(args, { cwd, home, env = {}, timeout = 60000, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...systemEnv(home), VIPCODE_HOME: home, NO_COLOR: "1", VIPCODE_BROWSER: "true", ...env },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const answers = Array.isArray(input) ? [...input] : null;
    child.stdout.on("data", (d) => {
      stdout += d;
      // Cada pregunta acaba en ": " y espera respuesta
      if (answers && /: $/.test(stdout)) {
        const next = answers.shift();
        if (next === undefined) {
          child.stdin.end();
        } else {
          child.stdin.write(next);
          if (answers.length === 0) {
            child.stdin.end();
          }
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    if (input !== undefined && !answers) {
      child.stdin.end(input);
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, output: stdout + stderr });
    });
  });
}
