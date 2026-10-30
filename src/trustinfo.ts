import fs from "node:fs";
import path from "node:path";
import { CATALOG } from "./catalog.js";
import { DEFAULT_CONFIG } from "./config.js";
import { parseFrontmatter } from "./frontmatter.js";
import { CONFIG_PATH } from "./paths.js";
import { showLine } from "./sanitize.js";
import type { ProjectTrust } from "./trust.js";

// Qué cambiaría la configuración que trae una carpeta, contado para cualquiera antes de confiar en ella. En «changes»
// va lo que puede hacerte daño (arrancar programas, mandar lo que escribes a otro sitio, dejar de preguntarte) y en
// «settings», los ajustes sin riesgo. Solo se cuenta lo que es distinto de lo que ya tienes.

export interface TrustReport {
  changes: string[];
  settings: string[];
}

type Json = Record<string, unknown>;

const SETTINGS: Record<string, string> = {
  model: "el modelo",
  order: "el orden de los modelos",
  enabledProviders: "qué IAs se usan",
  disabledProviders: "qué IAs se usan",
  maxSteps: "los pasos por mensaje",
  autoCompactTokens: "cuándo se resume la conversación",
  bashTimeoutMs: "cuánto pueden durar los comandos",
  maxWaitMs: "cuánto se espera a una IA ocupada",
  firstResponseMs: "cuánto se espera a que una IA empiece a contestar",
  autoUpdateModels: "la búsqueda de modelos nuevos",
  checkUpdates: "los avisos de versiones nuevas",
  ranking: "el orden por puntuación",
  showReasoning: "si se ve lo que piensa el modelo",
  fullscreen: "la pantalla completa",
};

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function short(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : String(JSON.stringify(value));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// «a, b y c», o «a, b, c y 3 más» si son muchos (lo que puede hacerte daño se enseña entero: max = Infinity)
export function joinList(items: string[], max = 5): string {
  if (items.length > max) {
    return `${items.slice(0, max).join(", ")} y ${items.length - max} más`;
  }
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}` : items.join("");
}

// Lo que pone tu ~/.vipcode/config.json
function readMine(): Json {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}

// El valor de serie con el tuyo encima, como al cargar la config (los objetos se mezclan)
function layer(base: unknown, over: unknown): unknown {
  if (isObject(base) && isObject(over)) {
    const result: Json = { ...base };
    for (const [key, value] of Object.entries(over)) {
      result[key] = layer(base[key], value);
    }
    return result;
  }
  return over === undefined ? base : over;
}

// Lo que tienes ahora en ese ajuste
function current(mine: Json, key: string): unknown {
  return layer((DEFAULT_CONFIG as unknown as Json)[key], mine[key]);
}

// ¿Cambia algo de lo que tienes? En los objetos, cada valor por separado: se mezclan con los tuyos
function differs(value: unknown, now: unknown): boolean {
  if (isObject(value)) {
    return Object.entries(value).some(([key, item]) => differs(item, isObject(now) ? now[key] : undefined));
  }
  return !same(value, now);
}

// ¿Una ruta o un patrón que sale de la carpeta? (absoluta, con ~ o con ..)
function outside(pattern: string): boolean {
  return path.isAbsolute(pattern) || path.win32.isAbsolute(pattern) || pattern.startsWith("~") || pattern.split(/[\\/]/).includes("..");
}

// El servidor de una dirección («api.ejemplo.com»), que es lo que importa
function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

// Variables de tu entorno que se pasarían: {env:NOMBRE} en los servidores MCP, ${NOMBRE} en la dirección de un proveedor
function envVars(value: unknown, pattern = /\{env:([A-Za-z_]\w*)\}/g): string[] {
  return [...new Set([...String(JSON.stringify(value)).matchAll(pattern)].map((match) => match[1]))];
}

// ¿Las reglas de ahora ya dejan hacerlo sin preguntar? (una acción para todo, o patrón → acción)
function allowedNow(rules: unknown, pattern: string): boolean {
  if (!isObject(rules)) {
    return rules === "allow";
  }
  return rules[pattern] === "allow" || (rules[pattern] === undefined && rules["*"] === "allow");
}

// Lo que unos permisos dejarían hacer sin preguntarte y ahora no
function newAllows(permission: unknown, mine: Json): string[] {
  if (!isObject(permission)) {
    return [];
  }
  const now = current(mine, "permission") as Json;
  const found: string[] = [];
  if (permission.edit === "allow" && now.edit !== "allow") {
    found.push("cambiará ficheros sin preguntarte");
  }
  if (permission.webfetch === "allow" && now.webfetch !== "allow") {
    found.push("entrará en páginas web sin preguntarte");
  }
  const kinds: [string, string, string][] = [
    ["bash", "ejecutará cualquier comando sin preguntarte", "ejecutará sin preguntarte"],
    ["mcp", "usará las herramientas de los servidores MCP sin preguntarte", "usará sin preguntarte las herramientas MCP"],
  ];
  for (const [kind, everything, some] of kinds) {
    const rules = permission[kind];
    if (allowedNow(rules, "*")) {
      if (!allowedNow(now[kind], "*")) {
        found.push(everything);
      }
    } else if (isObject(rules)) {
      const extra = Object.keys(rules).filter((pattern) => rules[pattern] === "allow" && !allowedNow(now[kind], pattern));
      if (extra.length > 0) {
        found.push(`${some}: ${joinList(extra, Infinity)}`);
      }
    }
  }
  return found;
}

function describeProvider(item: Json, mine: Json, report: TrustReport) {
  const name = String(item.name);
  // Lo que ya tiene: el del catálogo con lo tuyo encima
  const own = (Array.isArray(mine.providers) ? mine.providers : []).find((provider) => isObject(provider) && provider.name === name);
  const before: Json = { ...(CATALOG.find((provider) => provider.name === name) || {}), ...(isObject(own) ? own : {}) };
  if (!differs(item, before)) {
    return;
  }
  const keys = [item.apiKeyEnv].flat().filter((value): value is string => typeof value === "string" && ![before.apiKeyEnv].flat().includes(value));
  const list = (items: string[]) => joinList(items, Infinity);
  const apiKey = typeof item.apiKey === "string" && item.apiKey !== before.apiKey;
  if (typeof item.baseURL === "string" && item.baseURL !== before.baseURL) {
    let key = `con tu clave de «${name}» si tienes una`;
    if (keys.length > 0) {
      key = `con tu variable ${list(keys)} como clave`;
    } else if (apiKey) {
      key = "con una clave que trae la carpeta";
    }
    const vars = envVars(item.baseURL, /\$\{(\w+)\}/g);
    report.changes.push(`mandará lo que escribes y tu código a ${host(item.baseURL)} (proveedor «${name}», ${key})${vars.length > 0 ? `, y tus variables ${list(vars)}` : ""}`);
  } else if (keys.length > 0) {
    report.changes.push(`mandará tu variable ${list(keys)} como clave al proveedor «${name}»`);
  } else if (apiKey) {
    report.changes.push(`usará en el proveedor «${name}» una clave que trae la carpeta (quien la puso podría ver lo que escribes)`);
  } else {
    report.settings.push(`el proveedor «${name}»`);
  }
}

function describeMcp(value: unknown, mine: Json, report: TrustReport) {
  const own = isObject(mine.mcp) ? mine.mcp : {};
  for (const [name, server] of Object.entries(isObject(value) ? value : {})) {
    if (!isObject(server) || !differs(server, own[name])) {
      continue;
    }
    const yours = own[name];
    const merged = isObject(yours) ? { ...yours, ...server } : server;
    if (merged.enabled === false) {
      report.settings.push("los servidores MCP");
      continue;
    }
    const vars = envVars(server);
    const tail = vars.length > 0 ? `, y le pasará tus variables ${joinList(vars, Infinity)}` : "";
    if (typeof merged.url === "string" && merged.command === undefined) {
      report.changes.push(`se conectará a ${host(merged.url)} (servidor MCP «${name}»)${tail}`);
    } else {
      const parts = [merged.command, merged.args].flat().filter((part) => typeof part === "string");
      report.changes.push(`arrancará este programa al abrirse: ${parts.join(" ")} (servidor MCP «${name}»)${tail}`);
    }
  }
}

function describeLsp(value: unknown, mine: Json, report: TrustReport) {
  if (value === false) {
    if (current(mine, "lsp") !== false) {
      report.settings.push("los servidores de lenguaje");
    }
    return;
  }
  const own = isObject(mine.lsp) ? mine.lsp : {};
  for (const [name, server] of Object.entries(isObject(value) ? value : {})) {
    if (!differs(server, own[name])) {
      continue;
    }
    if (server === false || (isObject(server) && server.disabled === true)) {
      report.settings.push("los servidores de lenguaje");
    } else if (isObject(server) && Array.isArray(server.command) && server.command.length > 0) {
      report.changes.push(`arrancará este programa al abrir ficheros de código: ${server.command.map(String).join(" ")} (servidor de lenguaje «${name}»)`);
    } else {
      // Sus variables u opciones también pueden hacer que ejecute otra cosa (NODE_OPTIONS, plugins…)
      report.changes.push(`cambiará cómo arranca el servidor de lenguaje «${name}», y con eso puede ejecutar programas`);
    }
  }
}

function describeAgent(name: string, input: unknown, mine: Json, report: TrustReport) {
  const found = isObject(input) ? newAllows(input.permission, mine) : [];
  if (isObject(input) && input.readOnly === false) {
    found.push("podrá cambiar ficheros");
  }
  if (found.length > 0) {
    report.changes.push(...found.map((text) => `el agente «${name}» ${text}`));
  } else {
    report.settings.push(`el agente «${name}»`);
  }
}

// Las órdenes !`…` de un comando se ejecutan en tu terminal al usarlo
function describeCommand(name: string, template: unknown, report: TrustReport) {
  const orders = typeof template === "string" ? [...template.matchAll(/!`([^`]+)`/g)].map((match) => match[1]) : [];
  if (orders.length > 0) {
    report.changes.push(`el comando /${name} ejecutará en tu terminal, cada vez que lo uses: ${joinList(orders, Infinity)}`);
  } else {
    report.settings.push(`el comando /${name}`);
  }
}

function describeConfig(data: Json, mine: Json, report: TrustReport) {
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("$") || value === undefined) {
      continue;
    }
    if (key === "providers") {
      for (const item of Array.isArray(value) ? value : []) {
        if (isObject(item) && typeof item.name === "string") {
          describeProvider(item, mine, report);
        }
      }
    } else if (key === "mcp") {
      describeMcp(value, mine, report);
    } else if (key === "lsp") {
      describeLsp(value, mine, report);
    } else if (key === "permission") {
      const found = newAllows(value, mine);
      report.changes.push(...found);
      if (found.length === 0 && differs(value, current(mine, key))) {
        report.settings.push("los permisos (sin quitarte ninguna pregunta)");
      }
    } else if (key === "agents" || key === "commands") {
      const yours = mine[key];
      const own = isObject(yours) ? yours : {};
      for (const [name, input] of Object.entries(isObject(value) ? value : {})) {
        if (!differs(input, own[name])) {
          continue;
        }
        if (key === "agents") {
          describeAgent(name, input, mine, report);
        } else {
          describeCommand(name, isObject(input) ? input.template : undefined, report);
        }
      }
    } else if ((key === "instructions" || key === "disabledProviders") && Array.isArray(value)) {
      // Se suman a los tuyos
      const now = current(mine, key);
      const have = new Set(Array.isArray(now) ? now.map(String) : []);
      const extra = value.map(String).filter((item) => !have.has(item));
      const far = key === "instructions" ? extra.filter(outside) : [];
      const near = extra.filter((item) => !far.includes(item));
      if (far.length > 0) {
        report.changes.push(`le pasará a la IA ficheros de fuera de esta carpeta: ${joinList(far, Infinity)}`);
      }
      if (near.length > 0) {
        report.settings.push(key === "instructions" ? `instrucciones extra (${joinList(near.map((item) => short(item, 40)))})` : SETTINGS[key]);
      }
    } else if (key === "skills") {
      const now = current(mine, key) as Json;
      const had = Array.isArray(now?.paths) ? now.paths.map(String) : [];
      const far = (isObject(value) && Array.isArray(value.paths) ? value.paths.map(String) : []).filter((item) => outside(item) && !had.includes(item));
      if (far.length > 0) {
        report.changes.push(`cargará skills de fuera de esta carpeta: ${joinList(far, Infinity)}`);
      } else if (differs(value, now)) {
        report.settings.push("las skills");
      }
    } else if (key === "keyless") {
      const now = current(mine, key) !== false;
      if (value === true && !now) {
        report.changes.push("usará también las IAs que no piden clave, que pueden guardar lo que envías");
      } else if (value === false && now) {
        report.settings.push("no usar las IAs sin clave");
      }
    } else if (key === "snapshot") {
      const now = current(mine, key) !== false;
      if (value === false && now) {
        report.changes.push("no guardará copias para deshacer con /undo");
      } else if (value !== false && !now) {
        report.settings.push("/undo");
      }
    } else if (Object.hasOwn(SETTINGS, key)) {
      if (differs(value, current(mine, key))) {
        if (key === "model") {
          report.settings.push(`el modelo (${value ? short(value, 40) : "rotación automática"})`);
        } else {
          report.settings.push(key === "maxSteps" ? `los pasos por mensaje (${short(value, 10)})` : SETTINGS[key]);
        }
      }
    } else {
      unknown.push(short(key, 30));
    }
  }
  if (unknown.length > 0) {
    report.settings.push(`otros ajustes (${joinList(unknown)})`);
  }
}

// Con el mismo texto que se leyó para decidir si confías: lo que se te cuenta es justo lo que apruebas. Lo que puede
// hacerte daño va entero, sin recortar, y con los caracteres invisibles a la vista: nada puede esconderse ni fingir otra
// línea
export function describeTrust(trust: ProjectTrust): TrustReport {
  const mine = readMine();
  const report: TrustReport = { changes: [], settings: [] };
  for (const source of trust.sources) {
    const name = path.posix.basename(source.file, ".md");
    if (source.kind === "agent") {
      describeAgent(name, parseFrontmatter(source.text).data, mine, report);
    } else if (source.kind === "command") {
      describeCommand(name, source.text, report);
    } else {
      let data: unknown = null;
      try {
        data = JSON.parse(source.text);
      } catch {
        // se cuenta abajo
      }
      if (isObject(data)) {
        describeConfig(data, mine, report);
      } else {
        report.changes.push(`leerá ${source.file}, que tiene un error (no es un JSON válido)`);
      }
    }
  }
  return { changes: [...new Set(report.changes.map(showLine))], settings: [...new Set(report.settings.map(showLine))] };
}
