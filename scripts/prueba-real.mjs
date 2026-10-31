#!/usr/bin/env node
// Prueba real: una conversación de verdad con los modelos gratis que no piden clave, como la de alguien que acaba de
// instalar vipcode. Lee tres ficheros con datos concretos, hace que la conversación deje de caber entera (para que
// vipcode tenga que resumirla), pregunta de memoria lo que leyó al principio y edita un fichero. Así se ve si algo deja
// de funcionar con los modelos de verdad (que cambian sin avisar) antes de que les pase a los usuarios.
//
//   npm run prueba-real                                    compila y hace la prueba (sale con error si algo falla)
//   node scripts/prueba-real.mjs --out resultado.json      además guarda el resultado
//   node scripts/prueba-real.mjs --github resultado.json   con un resultado guardado, abre, actualiza o cierra el aviso
//                                                          en GitHub (lo hace la tarea diaria, en un paso aparte)
//
// Los modelos de fuera solo pueden leer y editar en una carpeta temporal: los comandos, la web y MCP están prohibidos, y
// no ven ninguna clave ni el token de GitHub. La carpeta de datos también es temporal: no toca ~/.vipcode.
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Ojo: nada de dist/ se carga arriba. Los módulos de vipcode fijan su carpeta de datos al cargarse, y antes hay que
// cambiarla por la temporal
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (file) => import(pathToFileURL(path.join(root, "dist", file)).href);

export const LABEL = "prueba-real";
export const TITLE = "Prueba real: vipcode no hace bien una conversación con los modelos gratis";

// Para que la conversación deje de caber enseguida y vipcode tenga que resumirla
const CONTEXT_LIMIT = 8000;
// Lo que puede tardar cada petición (los modelos gratis a veces van lentos)
const STEP_MS = 4 * 60 * 1000;
// Lo que no es culpa de vipcode: no hay modelos gratis que contesten (eso ya lo vigila scripts/vigilar.mjs) o tardan
// demasiado. La prueba no dice nada en esos casos
const NO_MODELS = /agotados o en pausa|ha podido contestar|ningún proveedor configurado|no ha terminado en/i;

// El proyecto de prueba: datos concretos que luego hay que recordar (descuento 15 %, umbral 12, Canarias 18,50 € en 6 días)
export function writeProject(dir) {
  const tools = ["Martillo", "Destornillador", "Alicates", "Llave inglesa", "Sierra", "Taladro", "Nivel", "Cinta métrica", "Lija", "Brocha", "Rodillo", "Escalera"];
  const lines = (n, make) => Array.from({ length: n }, (_, i) => make(i)).join("\n");
  const code = (i) => `P${String(i).padStart(3, "0")}`;
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "precios.js"),
    `// Precios de la ferretería: IVA, descuento para socios y tarifa de cada producto
export const IVA = 0.21;
export const DESCUENTO_SOCIOS = 0.15;
export const PRODUCTOS = [
${lines(110, (i) => `  { codigo: "${code(i)}", nombre: "${tools[i % 12]} modelo ${i}", precio: ${(5.5 + ((i * 37) % 90)).toFixed(2)} },`)}
];
export function precioFinal(codigo, socio) {
  const producto = PRODUCTOS.find((p) => p.codigo === codigo);
  const base = producto.precio * (1 + IVA);
  return socio ? base * (1 - DESCUENTO_SOCIOS) : base;
}
`,
  );
  fs.writeFileSync(
    path.join(dir, "src", "stock.js"),
    `// Inventario: cuándo hay que pedir más de cada producto
export const UMBRAL_REPOSICION = 12;
export const STOCK = [
${lines(110, (i) => `  { codigo: "${code(i)}", unidades: ${(i * 53) % 70}, almacen: "${["Murcia", "Alicante", "Valencia"][i % 3]}" },`)}
];
export function hayQueReponer(codigo) {
  return STOCK.find((s) => s.codigo === codigo).unidades < UMBRAL_REPOSICION;
}
`,
  );
  fs.writeFileSync(
    path.join(dir, "src", "envios.js"),
    `// Envíos: coste por zona y plazo en días
export const ZONAS = [
  { zona: "Península", coste: 4.95, dias: 2 },
  { zona: "Baleares", coste: 9.9, dias: 3 },
  { zona: "Canarias", coste: 18.5, dias: 6 },
  { zona: "Ceuta y Melilla", coste: 14.0, dias: 5 },
];
export const CODIGOS_POSTALES = [
${lines(110, (i) => `  { cp: "${String(3000 + i * 7).padStart(5, "0")}", zona: "${i % 9 === 0 ? "Baleares" : "Península"}", reparto: "${["mañana", "tarde"][i % 2]}" },`)}
];
export function costeEnvio(zona) {
  return ZONAS.find((z) => z.zona === zona).coste;
}
`,
  );
}

// Las peticiones, en orden, y qué tiene que pasar en cada una: check devuelve null si está bien, o el problema
export const STEPS = [
  {
    prompt: "Lee src/precios.js y dime cuánto es el descuento para socios.",
    check: (answer) => (/15\s*%|15 por ciento|0[.,]15/.test(answer) ? null : "no dice que el descuento para socios es del 15 %"),
  },
  {
    prompt: "Ahora lee src/stock.js y dime cuál es el umbral de reposición.",
    check: (answer) => (/\b12\b/.test(answer) ? null : "no dice que el umbral de reposición es 12"),
  },
  {
    prompt: "Lee src/envios.js y dime cuánto cuesta enviar a Canarias y en cuántos días llega.",
    check: (answer) => (/18[.,]50?\b/.test(answer) && /\b6\b/.test(answer) ? null : "no dice que enviar a Canarias cuesta 18,50 € y tarda 6 días"),
  },
  {
    prompt: "Sin volver a leer ningún fichero, contesta de memoria: ¿cuánto era el descuento para socios y cuál el umbral de reposición?",
    check: (answer) => (/15/.test(answer) && /\b12\b/.test(answer) ? null : "no recuerda el descuento (15 %) ni el umbral (12) que leyó al principio"),
  },
  {
    prompt: "Añade al principio de src/envios.js un comentario de una línea que diga: // Revisado por vipcode",
    check: (_answer, project) => {
      const first = fs.readFileSync(path.join(project, "src", "envios.js"), "utf8").split("\n")[0].trim();
      return first === "// Revisado por vipcode" ? null : "no ha añadido el comentario al principio de src/envios.js";
    },
  },
];

// Carpeta de datos temporal, sin claves ni tokens, y solo leer y editar. Una vez por ejecución, antes de cargar vipcode
let prepared = null;
function prepareEnvironment() {
  if (prepared) {
    return prepared;
  }
  for (const name of Object.keys(process.env)) {
    if (/(_API_KEY|_TOKEN|_SECRET)$/.test(name) || name === "GH_TOKEN" || name === "GITHUB_TOKEN") {
      delete process.env[name];
    }
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-prueba-real-"));
  process.env.VIPCODE_HOME = home;
  process.env.HOME = home;
  process.env.NO_COLOR = "1";
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ autoCompactTokens: CONTEXT_LIMIT, checkUpdates: false, permission: { edit: "allow", bash: "deny", webfetch: "deny", mcp: "deny" } }),
  );
  prepared = { home };
  return prepared;
}

// Una vuelta de la conversación, en un proyecto nuevo. Devuelve lo que pasó en cada paso
export async function runScenario() {
  prepareEnvironment();
  const { App } = await load("app.js");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-prueba-proyecto-"));
  writeProject(project);
  const app = new App(project);
  app.acceptPrivacyNotice();
  const notices = [];
  let answer = "";
  let tools = [];
  let model = "";
  app.agent.events = {
    onText: (chunk, depth) => {
      if (!depth) {
        answer += chunk;
      }
    },
    onNotice: (text) => notices.push(text.trim()),
    onToolEnd: (event) => tools.push(event.name),
    onAnswer: (slot) => {
      model = slot;
    },
  };
  const steps = [];
  try {
    for (const step of STEPS) {
      answer = "";
      tools = [];
      model = "";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), STEP_MS);
      const started = Date.now();
      let error = null;
      try {
        await app.runPrompt({ text: step.prompt }, {}, controller.signal);
      } catch (err) {
        error = controller.signal.aborted ? `no ha terminado en ${STEP_MS / 60000} minutos` : String(err?.message || err);
      } finally {
        clearTimeout(timer);
      }
      const problem = error || step.check(answer, project);
      steps.push({ prompt: step.prompt, ok: !problem, problem, answer: answer.trim().slice(0, 800), model, tools, seconds: Math.round((Date.now() - started) / 1000) });
      // Sin respuesta no tiene sentido seguir
      if (error) {
        break;
      }
    }
    const session = app.agent.session;
    return {
      steps,
      // Tiene que haber llegado a resumir: si no, la prueba no ha probado lo que tiene que probar
      summarized: notices.some((notice) => notice.includes("no cabe entera")),
      summary: session.summary?.text ? session.summary.text.slice(0, 2000) : null,
      // La conversación sigue entera aunque se haya resumido
      complete: String(session.messages[0]?.content ?? "") === STEPS[0].prompt,
      tokenScale: Math.round(app.router.tokenScale() * 100) / 100,
      notices: notices.slice(-15),
    };
  } finally {
    await app.shutdown();
    fs.rmSync(project, { recursive: true, force: true });
  }
}

// Lo que ha salido mal (vacío si nada)
export function problems(result) {
  const list = result.steps.filter((step) => !step.ok).map((step) => `Paso ${result.steps.indexOf(step) + 1}: ${step.problem}`);
  if (result.steps.length === STEPS.length && result.steps.every((step) => step.ok)) {
    if (!result.summarized) {
      list.push("La conversación no ha llegado a resumirse: la prueba no ha probado los resúmenes");
    }
    if (!result.complete) {
      list.push("La conversación guardada ya no empieza por la primera petición: se ha perdido el historial");
    }
  }
  return list;
}

// «bien», «fallo» (algo que vipcode hace mal) o «sin-modelos» (no hay modelos gratis que contesten a tiempo: no es
// culpa de vipcode y ya lo vigila la otra comprobación)
export function judge(result) {
  if (!result) {
    return "fallo";
  }
  if (result.steps.some((step) => step.problem && NO_MODELS.test(step.problem))) {
    return "sin-modelos";
  }
  return problems(result).length > 0 ? "fallo" : "bien";
}

// Para comentar en el aviso solo cuando cambia lo que falla (no cada día)
export function fingerprint(result) {
  const failing = result ? problems(result).map((line) => line.replace(/\s+/g, " ")) : ["sin resultado"];
  return crypto.createHash("sha256").update(failing.join("|")).digest("hex").slice(0, 12);
}

// Un texto que viene de un modelo, en un bloque que no se puede romper y sin claves (el aviso es público)
function block(text, redact) {
  return `\`\`\`text\n${redact(text || "(sin texto)").replace(/```/g, "'''")}\n\`\`\``;
}

// El informe en Markdown (para la terminal y para el aviso de GitHub)
export function renderReport(result, { when = new Date(), redact = (text) => text } = {}) {
  const verdict = judge(result);
  const lines = ["# Prueba real de vipcode con los modelos gratis", "", `<!-- huella: ${fingerprint(result)} -->`];
  lines.push(`Fecha: ${when.toISOString().slice(0, 16).replace("T", " ")} UTC${result?.attempt ? ` · intento ${result.attempt} de 2` : ""}`, "");
  if (!result) {
    lines.push("## ✗ La prueba no ha llegado a terminar", "", "Mira el registro de la tarea en la pestaña Actions.");
    return lines.join("\n");
  }
  const titles = { bien: "## ✓ Todo bien", fallo: "## ✗ Algo ha salido mal", "sin-modelos": "## … No se ha podido probar: no hay modelos gratis que contesten a tiempo" };
  lines.push(titles[verdict], "", "| Paso | Resultado | Modelo | Tiempo |", "|---|---|---|---|");
  result.steps.forEach((step, index) => {
    lines.push(`| ${index + 1}. ${step.prompt.replace(/\|/g, "/")} | ${step.ok ? "✓" : "✗"} | ${step.model || "-"} | ${step.seconds} s |`);
  });
  const list = problems(result);
  if (list.length > 0) {
    lines.push("", "### Lo que ha fallado", "", ...list.map((line) => `- ${redact(line)}`));
  }
  lines.push("", `Ha resumido la conversación: ${result.summarized ? "sí" : "no"} · ajuste de tokens aprendido: ${result.tokenScale}`);
  lines.push("", "<details><summary>Respuestas, resumen y avisos</summary>", "");
  result.steps.forEach((step, index) => {
    lines.push(`**Paso ${index + 1}**${step.tools.length > 0 ? ` (herramientas: ${step.tools.join(", ")})` : ""}`, "", block(step.answer, redact), "");
  });
  lines.push("**Resumen guardado**", "", block(result.summary, redact), "", "**Últimos avisos**", "", block(result.notices.join("\n"), redact), "", "</details>");
  return lines.join("\n");
}

// --github: con un resultado guardado, abre el aviso si algo falla, lo actualiza si sigue fallando (y lo comenta si ha
// cambiado lo que falla) y lo cierra cuando todo va bien. Si no hay modelos, no toca nada. Con gh y el GH_TOKEN de la tarea
function gh(args, input) {
  const run = spawnSync("gh", args, { encoding: "utf8", input });
  if (run.status !== 0) {
    throw new Error(`gh ${args[0]} ${args[1] || ""}: ${(run.stderr || run.stdout || "").trim()}`);
  }
  return run.stdout;
}

function updateIssue(result, report) {
  const verdict = judge(result);
  if (verdict === "sin-modelos") {
    console.log("No había modelos gratis que contestaran a tiempo: el aviso se queda como estaba.");
    return;
  }
  gh(["label", "create", LABEL, "--color", "D93F0B", "--description", "Aviso de la prueba real diaria con los modelos gratis", "--force"]);
  const [open] = JSON.parse(gh(["issue", "list", "--label", LABEL, "--state", "open", "--limit", "1", "--json", "number,body"]) || "[]");
  if (verdict === "fallo" && !open) {
    console.log(gh(["issue", "create", "--title", TITLE, "--label", LABEL, "--body-file", "-"], report).trim());
  } else if (verdict === "fallo") {
    const before = /<!-- huella: (\w*) -->/.exec(open.body || "")?.[1] || "";
    gh(["issue", "edit", String(open.number), "--body-file", "-"], report);
    if (before !== fingerprint(result)) {
      gh(["issue", "comment", String(open.number), "--body", "Ha cambiado lo que falla: el informe de arriba está actualizado."]);
    }
    console.log(`Aviso #${open.number} actualizado.`);
  } else if (open) {
    gh(["issue", "close", String(open.number), "--comment", "✓ La prueba real vuelve a ir bien."]);
    console.log(`Aviso #${open.number} cerrado.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  const githubFile = valueOf("--github");
  if (githubFile) {
    let result = null;
    try {
      result = JSON.parse(fs.readFileSync(githubFile, "utf8"));
    } catch {
      // Sin resultado: la prueba no llegó a terminar
    }
    const { redactSecrets } = await load("debug.js");
    updateIssue(result, renderReport(result, { redact: redactSecrets }));
    return;
  }
  // Dos intentos: los modelos gratis a veces fallan una vez sin que sea culpa de vipcode
  let result = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    result = { ...(await runScenario()), attempt };
    if (judge(result) === "bien") {
      break;
    }
  }
  const { redactSecrets } = await load("debug.js");
  console.log(renderReport(result, { redact: redactSecrets }));
  const out = valueOf("--out");
  if (out) {
    fs.writeFileSync(out, JSON.stringify(result, null, 2));
  }
  fs.rmSync(prepared.home, { recursive: true, force: true });
  process.exitCode = judge(result) === "fallo" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
