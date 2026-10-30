import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CLI, ROOT, contentText, lastMessage, provider, startMock, systemEnv, tempWorkspace } from "./helpers/mock-llm.mjs";

const hasExpect = spawnSync("expect", ["-v"], { stdio: "ignore" }).status === 0;

// Lanza un guion de expect de test/fixtures contra la interfaz y devuelve lo que se vio (sin colores)
function runExpect(script, ws, env = {}, args = []) {
  return new Promise((resolve) => {
    const child = spawn("expect", [path.join(ROOT, "test", "fixtures", script), CLI, ...args], {
      cwd: ws.proj,
      env: { ...systemEnv(ws.home), VIPCODE_HOME: ws.home, TERM: "xterm-256color", ...env },
    });
    // Se junta todo antes de pasarlo a texto: una letra de varios bytes puede llegar partida entre dos trozos
    const chunks = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, plain: Buffer.concat(chunks).toString("utf8").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") });
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
    // Una respuesta más larga que la terminal, para ver que se parte bien
    // Un comando de 35 líneas: el diálogo de permiso tiene que enseñarlo entero (también la 35)
    if (text.startsWith("comando-largo")) {
      return { tools: [{ name: "bash", args: { command: Array.from({ length: 35 }, (_, i) => `echo LINEA-${i + 1}`).join("\n") } }] };
    }
    if (last.role === "tool" && contentText(last.content).includes("rechazado")) {
      return { text: "VALE-NO-LO-EJECUTO" };
    }
    if (text.startsWith("largo")) {
      return { text: "y".repeat(130) };
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
  // Con un límite diario conocido, la barra de abajo dice de quién es y cuántas peticiones quedan
  ws.writeConfig({
    providers: [provider("p", mock.url, ["m"], { label: "Proveedor P (gratis)", freeLimits: { perDay: 100 } })],
    enabledProviders: ["p"],
    autoUpdateModels: false,
    checkUpdates: false,
  });

  let result;
  try {
    result = await runExpect("tui.exp", ws);
  } finally {
    await mock.close();
  }
  assert.equal(result.code, 0, result.plain.slice(-3000));
  assert.match(result.plain, /TUI-OK/);
  assert.equal(ws.read("hola.txt"), "adios\n");
  ws.cleanup();
});

test("interfaz: versión nueva destacada y bienvenida la primera vez", { skip: !hasExpect && "falta el programa expect" }, async () => {
  const mock = await startMock(() => ({ text: "HOLA" }));
  const ws = tempWorkspace();
  // Un proveedor que no pide clave, como los anónimos, y una versión nueva ya comprobada hoy (no se mira internet)
  // En el modo de antes (sin pantalla completa), que así también queda probado
  ws.writeConfig({
    providers: [{ name: "anon", baseURL: `${mock.url}/anon/v1`, noKey: true, models: [{ id: "m", context: 100000 }] }],
    enabledProviders: ["anon"],
    autoUpdateModels: false,
    fullscreen: false,
  });
  // …con arreglos de seguridad, y vienes de una versión anterior (se enseñan las novedades)
  fs.writeFileSync(path.join(ws.home, "update.json"), JSON.stringify({ checked: Date.now(), latest: "99.0.0", security: true }));
  fs.writeFileSync(path.join(ws.home, "notices.json"), JSON.stringify({ lastVersion: "0.0.1" }));

  const result = await runExpect("tui-avisos.exp", ws);
  assert.equal(result.code, 0, result.plain.slice(-3000));
  assert.match(result.plain, /TUI-AVISOS-OK/);
  assert.match(result.plain, /pueden guardar lo que les escribes/);
  // «Empezar» deja la bienvenida contestada para las próximas veces
  assert.ok(JSON.parse(fs.readFileSync(path.join(ws.home, "notices.json"), "utf8")).privacy);
  await mock.close();
  ws.cleanup();
});

test("interfaz: /update enseña una barra de carga, avisa de que hay que reiniciar y sabe reiniciar", { skip: !hasExpect && "falta el programa expect" }, async () => {
  const ws = tempWorkspace();
  const quiet = { npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
  // Un paquete «vipcode 9.9.9» de mentira, publicado en un GitHub de prueba
  const fake = path.join(ws.dir, "paquete");
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, "package.json"), JSON.stringify({ name: "vipcode", version: "9.9.9", bin: { vipcode: "index.js" } }));
  // La versión nueva de mentira dice con qué argumentos la han abierto
  fs.writeFileSync(path.join(fake, "index.js"), "#!/usr/bin/env node\nconsole.log('NUEVA-9.9.9 args: ' + process.argv.slice(2).join(' '));\n");
  // Sin las variables npm_* del «npm test» que lanza las pruebas (apuntan a la carpeta real)
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_")));
  assert.equal(spawnSync("npm", ["pack", "--pack-destination", ws.dir], { cwd: fake, env: { ...clean, HOME: ws.home, ...quiet } }).status, 0);
  const tarball = fs.readFileSync(path.join(ws.dir, "vipcode-9.9.9.tgz"));
  const mock = await startMock(({ path: url }) => {
    if (url === "/repos/PabloVip/vipcode/releases/latest") {
      return { json: { tag_name: "v9.9.9", assets: [{ name: "vipcode.tgz", browser_download_url: `${mock.url}/descargas/vipcode.tgz` }] } };
    }
    if (url === "/descargas/vipcode.tgz") {
      return { body: tarball };
    }
    if (url.endsWith("/chat/completions")) {
      return { text: "HOLA" };
    }
    return { status: 404, json: {} };
  });
  // Un npm global de prueba con vipcode 0.2.0 «instalado»
  const prefix = path.join(ws.dir, "npm-global");
  const installed = path.join(prefix, "lib", "node_modules", "vipcode");
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "vipcode", version: "0.2.0" }));
  ws.writeConfig({ providers: [provider("p", mock.url, ["m"])], enabledProviders: ["p"], autoUpdateModels: false, checkUpdates: false });

  const env = {
    ...quiet,
    npm_config_prefix: prefix,
    VIPCODE_INSTALL_ROOT: installed,
    VIPCODE_UPDATE_URL: `${mock.url}/repos/PabloVip/vipcode`,
    VIPCODE_REGISTRY_URL: `${mock.url}/npm`,
  };
  try {
    // «Más tarde»: al salir se recuerda abrir la versión nueva
    let result = await runExpect("tui-update.exp", ws, env);
    assert.equal(result.code, 0, result.plain.slice(-3000));
    assert.match(result.plain, /TUI-UPDATE-OK/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8")).version, "9.9.9");
    // «Reiniciar ahora»: se abre la nueva en la misma conversación (otra vez desde la 0.2.0)
    fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "vipcode", version: "0.2.0" }));
    result = await runExpect("tui-reinicio.exp", ws, env);
    assert.equal(result.code, 0, result.plain.slice(-3000));
    assert.match(result.plain, /TUI-REINICIO-OK/);
  } finally {
    await mock.close();
    ws.cleanup();
  }
});

test("interfaz: vipcode tutorial abre la carpeta de prácticas y lleva paso a paso hasta el final", { skip: !hasExpect && "falta el programa expect" }, async () => {
  const mock = await startMock(() => ({ text: "VALE" }));
  const ws = tempWorkspace();
  ws.writeConfig({ providers: [provider("p", mock.url, ["m"])], enabledProviders: ["p"], autoUpdateModels: false, checkUpdates: false });
  try {
    const result = await runExpect("tui-tutorial.exp", ws);
    assert.equal(result.code, 0, result.plain.slice(-3000));
    assert.match(result.plain, /TUI-TUTORIAL-OK/);
    // La carpeta de prácticas está en tu carpeta personal, no en la que lo abriste
    assert.ok(fs.existsSync(path.join(ws.home, "vipcode-tutorial", "saludo.js")));
    assert.ok(!fs.existsSync(path.join(ws.proj, "saludo.js")));
  } finally {
    await mock.close();
    ws.cleanup();
  }
});

test("interfaz: en pantalla completa, arrastrar con el ratón selecciona y copia al soltar", { skip: !hasExpect && "falta el programa expect" }, async () => {
  const answer = Array.from({ length: 80 }, (_, i) => `LINEA-${i + 1}`).join("\n");
  const mock = await startMock(() => ({ text: answer }));
  const ws = tempWorkspace();
  ws.writeConfig({ providers: [provider("p", mock.url, ["m"])], enabledProviders: ["p"], autoUpdateModels: false, checkUpdates: false });
  // Un «portapapeles» que guarda en un fichero lo que le llega
  const copied = path.join(ws.dir, "portapapeles.txt");
  const script = path.join(ws.dir, "copiar.mjs");
  fs.writeFileSync(script, `import fs from "node:fs";\nlet text = "";\nprocess.stdin.on("data", (d) => (text += d));\nprocess.stdin.on("end", () => fs.writeFileSync(${JSON.stringify(copied)}, text));\n`);
  try {
    const result = await runExpect("tui-seleccion.exp", ws, { VIPCODE_CLIPBOARD: `"${process.execPath}" "${script}"` });
    assert.equal(result.code, 0, result.plain.slice(-3000));
    assert.match(result.plain, /TUI-SELECCION-OK/);
    // Tres líneas de la respuesta, desde donde empezó el arrastre, sin colores ni espacios al final
    assert.match(fs.readFileSync(copied, "utf8"), /^LINEA-\d+\n {2}LINEA-\d+\n {2}LINEA-\d+$/);
  } finally {
    await mock.close();
    ws.cleanup();
  }
});

test("interfaz: Ctrl+F, doble clic, barra de desplazamiento, herramientas que se despliegan y Ctrl+Fin", { skip: !hasExpect && "falta el programa expect" }, async () => {
  const answer = Array.from({ length: 80 }, (_, i) => `LINEA-${i + 1}`).join("\n");
  const mock = await startMock(({ body }) => {
    const last = lastMessage(body);
    if (last.role === "tool") {
      return { text: "HECHO" };
    }
    // «ls» se aprueba solo: 20 ficheros, de los que el resumen solo enseña los últimos
    return contentText(last.content).includes("lista") ? { tools: [{ name: "bash", args: { command: "ls -1" } }] } : { text: answer };
  });
  const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`fichero-${String(i + 1).padStart(2, "0")}.txt`, "x"]));
  const ws = tempWorkspace(files);
  ws.writeConfig({ providers: [provider("p", mock.url, ["m"])], enabledProviders: ["p"], autoUpdateModels: false, checkUpdates: false });
  const copied = path.join(ws.dir, "portapapeles.txt");
  const script = path.join(ws.dir, "copiar.mjs");
  fs.writeFileSync(script, `import fs from "node:fs";\nlet text = "";\nprocess.stdin.on("data", (d) => (text += d));\nprocess.stdin.on("end", () => fs.writeFileSync(${JSON.stringify(copied)}, text));\n`);
  try {
    const result = await runExpect("tui-vista.exp", ws, { VIPCODE_CLIPBOARD: `"${process.execPath}" "${script}"` });
    assert.equal(result.code, 0, result.plain.slice(-3000));
    assert.match(result.plain, /TUI-VISTA-OK/);
    // El doble clic copió una palabra entera, sin los espacios de delante
    assert.match(fs.readFileSync(copied, "utf8"), /^LINEA-\d+$/);
  } finally {
    await mock.close();
    ws.cleanup();
  }
});

test("interfaz: /interfaz cambia a la compacta al momento, y a la clásica y de vuelta con la misma conversación", { skip: !hasExpect && "falta el programa expect" }, async () => {
  const mock = await startMock(() => ({ text: "HOLA" }));
  const ws = tempWorkspace();
  ws.writeConfig({ providers: [provider("p", mock.url, ["m"])], enabledProviders: ["p"], autoUpdateModels: false, checkUpdates: false });
  try {
    const result = await runExpect("tui-interfaz.exp", ws);
    assert.equal(result.code, 0, result.plain.slice(-3000));
    assert.match(result.plain, /TUI-INTERFAZ-OK/);
    // Se guarda para la próxima vez
    assert.equal(JSON.parse(fs.readFileSync(path.join(ws.home, "config.json"), "utf8")).interfaz, "completa");
  } finally {
    await mock.close();
    ws.cleanup();
  }
});

test("interfaz: la de criaturas pone un monstruito a la derecha que cambia con cada respuesta y al pincharlo", { skip: !hasExpect && "falta el programa expect" }, async () => {
  const mock = await startMock(() => ({ text: "HOLA" }));
  try {
    // La pequeña, la grande (terminal ancha y alta) y la pintada con fondos (la del Terminal del Mac)
    for (const [size, env] of [[["100", "30"], {}], [["130", "36"], {}], [["100", "34"], { TERM_PROGRAM: "Apple_Terminal" }]]) {
      const ws = tempWorkspace();
      ws.writeConfig({ providers: [provider("p", mock.url, ["m"])], enabledProviders: ["p"], autoUpdateModels: false, checkUpdates: false });
      try {
        const result = await runExpect("tui-criaturas.exp", ws, env, size);
        const where = `${size.join("×")} ${env.TERM_PROGRAM || ""}`;
        assert.equal(result.code, 0, `${where}\n${result.plain.slice(-3000)}`);
        assert.match(result.plain, /TUI-CRIATURAS-OK/);
        // Al elegirla, la que había; otra al terminar la respuesta y otra al pincharla: sus nombres, entre los bordes
        const names = new Set([...result.plain.matchAll(/│ +(?:★ )?([A-Z][a-zñáéíóú]+) +│/g)].map((match) => match[1]));
        assert.ok(names.size >= 3, `${where}: criaturas vistas: ${[...names].join(", ")}`);
        // Se guarda para la próxima vez
        assert.equal(JSON.parse(fs.readFileSync(path.join(ws.home, "config.json"), "utf8")).interfaz, "criaturas");
      } finally {
        ws.cleanup();
      }
    }
  } finally {
    await mock.close();
  }
});
