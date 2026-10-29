import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { CLI, ROOT, contentText, lastMessage, provider, startMock, tempWorkspace } from "./helpers/mock-llm.mjs";

const hasExpect = spawnSync("expect", ["-v"], { stdio: "ignore" }).status === 0;

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

  const result = await new Promise((resolve) => {
    const child = spawn("expect", [path.join(ROOT, "test", "fixtures", "tui.exp"), CLI], {
      cwd: ws.proj,
      env: { PATH: process.env.PATH, HOME: ws.home, VIPCODE_HOME: ws.home, TERM: "xterm-256color" },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });

  const plain = result.output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  assert.equal(result.code, 0, plain.slice(-3000));
  assert.match(plain, /TUI-OK/);
  assert.equal(ws.read("hola.txt"), "adios\n");
  await mock.close();
  ws.cleanup();
});
