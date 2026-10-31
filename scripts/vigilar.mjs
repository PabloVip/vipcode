#!/usr/bin/env node
// Vigila los proveedores del catálogo: pide a cada uno su lista de modelos y, si se puede usar (con clave o sin ella),
// le hace a cada modelo una pregunta mínima con una herramienta, como las hace vipcode. Dice qué modelos del catálogo ya
// no existen o no contestan, para quitarlos o cambiarlos en src/catalog.ts antes de que les pase a los usuarios.
//
//   npm run vigilar                      compila y enseña el informe
//   node scripts/vigilar.mjs --github    además abre, actualiza o cierra el aviso en GitHub (lo hace la tarea diaria)
//
// Las claves salen del entorno (en GitHub, de los secretos del repositorio). Un proveedor sin clave solo se comprueba si
// funciona sin ella o si su lista de modelos es pública. Las claves nunca salen en el informe: el aviso es público.
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (file) => import(pathToFileURL(path.join(root, "dist", file)).href);
const { CATALOG } = await load("catalog.js");
const { parseModels } = await load("discovery.js");
const { redactSecrets } = await load("debug.js");

// La herramienta de la pregunta: un modelo que no acepta herramientas no le sirve a vipcode
const PROBE_TOOL = {
  type: "function",
  function: {
    name: "leer_fichero",
    description: "Lee un fichero del proyecto",
    parameters: { type: "object", properties: { ruta: { type: "string" } }, required: ["ruta"] },
  },
};

export const LABEL = "vigilancia";
export const TITLE = "Vigilancia: hay modelos del catálogo que no funcionan";

function envNames(provider) {
  if (!provider.apiKeyEnv) {
    return [];
  }
  return Array.isArray(provider.apiKeyEnv) ? provider.apiKeyEnv : [provider.apiKeyEnv];
}

// Lo que no puede salir en el informe: las claves y las variables de la URL (por ejemplo el id de tu cuenta de Cloudflare)
function secretNames(provider) {
  return [...envNames(provider), ...(provider.requiredVars || [])];
}

// La clave (la primera variable que tenga valor; «no-key» si funciona sin ella) y la URL con sus variables puestas
export function credentialsFor(provider, env = process.env) {
  const name = envNames(provider).find((item) => env[item]);
  let key = name ? env[name] : null;
  if (!key && provider.noKey) {
    key = "no-key";
  }
  let missing = null;
  const baseURL = provider.baseURL.replace(/\$\{(\w+)\}/g, (_match, variable) => {
    if (!env[variable]) {
      missing = variable;
      return "";
    }
    return env[variable];
  });
  return { key, baseURL: missing ? null : baseURL.replace(/\/+$/, ""), missing, keyName: envNames(provider)[0] || null };
}

// Lo que se puede enseñar de un error: sin claves (ni las del entorno ni nada con pinta de clave), sin caracteres de
// control, corto y entre comillas de código (lo escribe el proveedor: en el aviso no puede convertirse en enlaces o
// imágenes)
export function redact(text, env = process.env) {
  let clean = String(text || "");
  for (const provider of CATALOG) {
    for (const name of secretNames(provider)) {
      if (env[name] && env[name].length >= 6) {
        clean = clean.split(env[name]).join("[clave]");
      }
    }
  }
  clean = redactSecrets(clean).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return `\`${clean.length > 140 ? `${clean.slice(0, 139)}…` : clean}\``;
}

// Qué ha pasado al preguntar a un modelo: «ok», «problema» (hay que cambiar el catálogo) o «pasajero» (límites, errores
// del servidor: no se avisa solo por eso)
export function classifyProbe(status, text) {
  const lower = String(text || "").toLowerCase();
  if (status >= 200 && status < 300) {
    return { kind: "ok" };
  }
  if (status === 404 || /not found|does not exist|no longer available|decommissioned|deprecated|unknown model|invalid model|model_not_found/.test(lower)) {
    return { kind: "problema", detail: "no existe o ya no está disponible" };
  }
  if (status === 401) {
    return { kind: "problema", detail: "la clave no vale" };
  }
  if (status === 402 || status === 403) {
    return { kind: "problema", detail: "sin acceso (de pago o sin permiso)" };
  }
  if (status === 429) {
    if (/limit:\s*0\b|"limit":\s*0\b|not included|free tier|no free/.test(lower)) {
      return { kind: "problema", detail: "fuera del plan gratis" };
    }
    return { kind: "pasajero", detail: "límite de peticiones" };
  }
  if (status === 400 && /tool|function/.test(lower)) {
    return { kind: "problema", detail: "no acepta herramientas" };
  }
  if (status >= 500 || status === 408) {
    return { kind: "pasajero", detail: status === 503 ? "saturado (503)" : `error del servidor (${status})` };
  }
  return { kind: "problema", detail: `error ${status}` };
}

function headersFor(provider, key) {
  const headers = { accept: "application/json", "content-type": "application/json", ...(provider.headers || {}) };
  if (key && key !== "no-key") {
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

async function readBody(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// Comprueba un proveedor: su lista de modelos y, si se puede usar, una pregunta a cada modelo del catálogo
export async function checkProvider(provider, { env = process.env, fetchImpl = fetch, pauseMs = 1500, timeoutMs = 60000 } = {}) {
  const result = { name: provider.name, how: "", problems: [], warnings: [] };
  const { key, baseURL, missing, keyName } = credentialsFor(provider, env);
  if (!baseURL) {
    result.how = `sin comprobar: falta el secreto ${missing}`;
    return result;
  }
  const headers = headersFor(provider, key);

  // 1. La lista de modelos: los del catálogo que ya no están
  let listed = null;
  try {
    const response = await fetchImpl(`${baseURL}/models`, { headers, signal: AbortSignal.timeout(30000) });
    const text = await readBody(response);
    if (response.ok) {
      const json = JSON.parse(text);
      const items = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
      listed = new Set(items.map((item) => String(item?.id || item?.name || "").replace(/^models\//, "")));
      const useful = new Set(parseModels(json, provider).map((model) => model.id));
      for (const model of provider.models) {
        if (!listed.has(model.id)) {
          result.problems.push({ model: model.id, detail: "ya no está en su lista de modelos" });
        } else if (provider.freeOnly && !useful.has(model.id)) {
          result.problems.push({ model: model.id, detail: "ya no es gratis o no acepta herramientas" });
        }
      }
    } else if (key && key !== "no-key" && response.status === 401) {
      result.problems.push({ model: "(todos)", detail: `la clave del secreto ${keyName} no vale: ${redact(text, env)}` });
      result.how = "con clave";
      return result;
    }
  } catch (err) {
    result.warnings.push({ model: "(lista de modelos)", detail: `no se ha podido leer: ${redact(err.message, env)}` });
  }

  // 2. Una pregunta a cada modelo (uno detrás de otro: los límites suelen ser por minuto)
  if (!key) {
    result.how = listed ? `lista pública de modelos (con el secreto ${keyName}, también se le pregunta a cada uno)` : `sin comprobar: añade el secreto ${keyName}`;
    return result;
  }
  result.how = key === "no-key" ? "sin clave: lista de modelos y una pregunta a cada uno" : "con clave: lista de modelos y una pregunta a cada uno";
  const gone = new Set(result.problems.map((problem) => problem.model));
  for (const [index, model] of provider.models.entries()) {
    if (gone.has(model.id)) {
      continue;
    }
    if (index > 0 && pauseMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    const body = { model: model.id, messages: [{ role: "user", content: "Contesta solo «ok»." }], tools: [PROBE_TOOL], tool_choice: "auto" };
    if (model.reasoningEffort) {
      body.reasoning_effort = model.reasoningEffort;
    }
    try {
      const response = await fetchImpl(`${baseURL}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      const text = await readBody(response);
      const verdict = classifyProbe(response.status, text);
      if (verdict.kind === "problema") {
        result.problems.push({ model: model.id, detail: `${verdict.detail}: ${redact(text, env)}` });
      } else if (verdict.kind === "pasajero") {
        result.warnings.push({ model: model.id, detail: verdict.detail });
      }
    } catch (err) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      result.warnings.push({ model: model.id, detail: timedOut ? `no ha contestado en ${Math.round(timeoutMs / 1000)} s` : `sin conexión: ${redact(err.message, env)}` });
    }
  }
  return result;
}

// La huella de lo que falla: si no cambia de un día a otro, el aviso se actualiza sin volver a notificar
export function fingerprint(results) {
  const keys = results.flatMap((result) => result.problems.map((problem) => `${result.name}/${problem.model}`)).sort();
  return keys.length === 0 ? "" : crypto.createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 16);
}

const cell = (text) => String(text).replace(/\|/g, "\\|");

export function renderReport(results, when = new Date()) {
  const problems = results.flatMap((result) => result.problems.map((problem) => ({ ...problem, provider: result.name })));
  const warnings = results.flatMap((result) => result.warnings.map((warning) => ({ ...warning, provider: result.name })));
  const lines = ["# Vigilancia de los proveedores de vipcode", "", `Comprobado el ${when.toISOString().slice(0, 16).replace("T", " a las ")} (UTC).`, ""];
  if (problems.length > 0) {
    lines.push(`## ✖ ${problems.length} ${problems.length === 1 ? "modelo del catálogo no funciona" : "modelos del catálogo no funcionan"}`, "");
    lines.push("| Proveedor | Modelo | Qué pasa |", "|---|---|---|");
    for (const problem of problems) {
      lines.push(`| ${cell(problem.provider)} | \`${cell(problem.model)}\` | ${cell(problem.detail)} |`);
    }
    lines.push("", "Hay que quitarlos o cambiarlos en `src/catalog.ts` (los proveedores que buscan sus modelos solos los quitan en el vipcode de cada usuario, pero hasta entonces se prueban).", "");
  } else {
    lines.push("## ✓ Todos los modelos del catálogo que se han podido comprobar funcionan", "");
  }
  if (warnings.length > 0) {
    lines.push("## Avisos que pueden ser pasajeros", "");
    for (const warning of warnings) {
      lines.push(`- ${warning.provider} · \`${warning.model}\`: ${warning.detail}`);
    }
    lines.push("");
  }
  lines.push("## Cómo se ha comprobado cada proveedor", "", "| Proveedor | Cómo |", "|---|---|");
  for (const result of results) {
    lines.push(`| ${cell(result.name)} | ${cell(result.how)} |`);
  }
  lines.push("", `<!-- huella: ${fingerprint(results)} -->`);
  return lines.join("\n");
}

// --github: abre el aviso si algo falla, lo actualiza si sigue fallando (y lo comenta si ha cambiado lo que falla) y lo
// cierra cuando todo vuelve a funcionar. Con gh y el GH_TOKEN de la tarea
function gh(args, input) {
  const run = spawnSync("gh", args, { encoding: "utf8", input });
  if (run.status !== 0) {
    throw new Error(`gh ${args[0]} ${args[1] || ""}: ${(run.stderr || run.stdout || "").trim()}`);
  }
  return run.stdout;
}

function updateIssue(report, results) {
  const failing = results.some((result) => result.problems.length > 0);
  gh(["label", "create", LABEL, "--color", "FBCA04", "--description", "Aviso de la vigilancia diaria de los proveedores", "--force"]);
  const [open] = JSON.parse(gh(["issue", "list", "--label", LABEL, "--state", "open", "--limit", "1", "--json", "number,body"]) || "[]");
  if (failing && !open) {
    console.log(gh(["issue", "create", "--title", TITLE, "--label", LABEL, "--body-file", "-"], report).trim());
  } else if (failing) {
    const before = /<!-- huella: (\w*) -->/.exec(open.body || "")?.[1] || "";
    gh(["issue", "edit", String(open.number), "--body-file", "-"], report);
    if (before !== fingerprint(results)) {
      gh(["issue", "comment", String(open.number), "--body", "Ha cambiado lo que falla: el informe de arriba está actualizado."]);
    }
    console.log(`Aviso #${open.number} actualizado.`);
  } else if (open) {
    gh(["issue", "close", String(open.number), "--comment", "✓ Todo lo que se puede comprobar vuelve a funcionar."]);
    console.log(`Aviso #${open.number} cerrado.`);
  }
}

async function main() {
  // Todos a la vez (cada uno pregunta a sus modelos de uno en uno)
  const providers = CATALOG.filter((provider) => !provider.local);
  const results = await Promise.all(providers.map((provider) => checkProvider(provider)));
  const report = renderReport(results);
  console.log(report);
  if (process.argv.includes("--github")) {
    updateIssue(report, results);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
