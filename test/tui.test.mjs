import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CLI, ROOT, contentText, lastMessage, provider, startMock, systemEnv, tempWorkspace } from "./helpers/mock-llm.mjs";

const hasExpect = spawnSync("expect", ["-v"], { stdio: "ignore" }).status === 0;

// Lanza un guion de expect de test/fixtures contra la interfaz y devuelve lo que se vio (sin colores)
function runExpect(script, ws) {
  return new Promise((resolve) => {
    const child = spawn("expect", [path.join(ROOT, "test", "fixtures", script), CLI], {
      cwd: ws.proj,
      env: { ...systemEnv(ws.home), VIPCODE_HOME: ws.home, TERM: "xterm-256color" },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, plain: output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") });
    });
  });
}

test("interfaz completa en una pseudo-terminal", { skip: !hasExpect && "falta el programa expect" }, async () => {
  const mock = await startMock(({ body }) => {
    const last = lastMessage(body);
    const text = contentText(last.content);
    if (last.role === "tool") {
      return { text: "RESPUESTA-DOS" };
    }
    if (text.includes('<fichero ruta="hola.txt">')) {
      return { text: "ADJUNTO-OK" };
    }
    if (text.startsWith("cambia")) {
      return {
        tools: [
          { name: "read_file", args: { path: "hola.txt" } },
          { name: "edit_file", args: { path: "hola.txt", old_string: "hola", new_string: "adios" } },
        ],
      };
    }
    return { text: "RESPUESTA-UNO" };
  });
  const ws = tempWorkspace({ "hola.txt": "hola\n" });
  ws.writeConfig({ providers: [provider("p", mock.url, ["m"])], enabledProviders: ["p"], autoUpdateModels: false, checkUpdates: false });

  const result = await runExpect("tui.exp", ws);
  assert.equal(result.code, 0, result.plain.slice(-3000));
  assert.match(result.plain, /TUI-OK/);
  assert.equal(ws.read("hola.txt"), "adios\n");
  await mock.close();
  ws.cleanup();
});

test("interfaz: versión nueva destacada y bienvenida la primera vez", { skip: !hasExpect && "falta el programa expect" }, async () => {
  const mock = await startMock(() => ({ text: "HOLA" }));
  const ws = tempWorkspace();
  // Un proveedor que no pide clave, como los anónimos, y una versión nueva ya comprobada hoy (no se mira internet)
  ws.writeConfig({
    providers: [{ name: "anon", baseURL: `${mock.url}/anon/v1`, noKey: true, models: [{ id: "m", context: 100000 }] }],
    enabledProviders: ["anon"],
    autoUpdateModels: false,
  });
  fs.writeFileSync(path.join(ws.home, "update.json"), JSON.stringify({ checked: Date.now(), latest: "99.0.0" }));

  const result = await runExpect("tui-avisos.exp", ws);
  assert.equal(result.code, 0, result.plain.slice(-3000));
  assert.match(result.plain, /TUI-AVISOS-OK/);
  assert.match(result.plain, /pueden guardar lo que les escribes/);
  // «Empezar» deja la bienvenida contestada para las próximas veces
  assert.ok(JSON.parse(fs.readFileSync(path.join(ws.home, "notices.json"), "utf8")).privacy);
  await mock.close();
  ws.cleanup();
});
