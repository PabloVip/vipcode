// Copyright (C) 2026 Pablo Vicente Juan
// SPDX-License-Identifier: AGPL-3.0-or-later
import crypto from "node:crypto";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "./config.js";
import { debugLog } from "./debug.js";
import { type LoginUi, callbackServer, openBrowser } from "./login.js";
import { McpOAuthProvider, type McpOAuthOptions, forgetSession, hasSession } from "./mcp-auth.js";
import { VERSION } from "./meta.js";
import { findProgram } from "./shell.js";
import { CORE_TOOLS, type Tool, truncate } from "./tools.js";

// {env:NOMBRE} se cambia por esa variable de tu entorno (vacío si no existe): así se le pasa a un servidor solo lo que
// necesita, sin escribir la clave en la configuración
export function expandEnv(text: string): string {
  return text.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "");
}

// Además de lo imprescindible para arrancar (PATH, HOME…, lo mismo que deja el SDK de MCP): idioma, carpetas temporales,
// proxy y certificados, que no son claves
const EXTRA_INHERITED = ["LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "COMSPEC", "PATHEXT"];

// Variables de un servidor MCP local. No hereda tu entorno entero: si el paquete del servidor estuviera comprometido
// (como pasa a veces con paquetes de npm), se llevaría tus claves y todo lo demás. Lo que necesite, en "environment"
export function serverEnvironment(environment: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = getDefaultEnvironment();
  for (const name of EXTRA_INHERITED) {
    const value = process.env[name];
    if (value !== undefined && !value.startsWith("()")) {
      env[name] = value;
    }
  }
  for (const [name, value] of Object.entries(environment)) {
    env[name] = expandEnv(String(value));
  }
  return env;
}

export interface McpStatus {
  name: string;
  state: "conectando" | "conectado" | "error" | "desactivado";
  error?: string;
  tools: number;
}

interface ServerState {
  name: string;
  state: McpStatus["state"];
  error?: string;
  client?: Client;
  tools: Tool[];
}

// Los nombres de herramienta solo admiten letras, números, _ y - (máximo 64)
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

// Los de las herramientas de vipcode (más «task» y «skill», que se añaden según el agente)
const RESERVED = new Set([...CORE_TOOLS.map((tool) => tool.name), "task", "skill"]);

// Algunos proveedores (Gemini) rechazan palabras del JSON Schema que no conocen
function cleanSchema(schema: unknown): any {
  if (Array.isArray(schema)) {
    return schema.map(cleanSchema);
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (["$schema", "$id", "$comment", "additionalProperties", "examples"].includes(key)) {
      continue;
    }
    if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, unknown> = {};
      for (const [prop, propSchema] of Object.entries(value as Record<string, unknown>)) {
        props[prop] = cleanSchema(propSchema);
      }
      result[key] = props;
    } else {
      result[key] = cleanSchema(value);
    }
  }
  return result;
}

function toText(result: any): { output: string; images: string[] } {
  const parts: string[] = [];
  const images: string[] = [];
  for (const item of result?.content || []) {
    if (item.type === "text") {
      parts.push(item.text);
    } else if (item.type === "image" && item.data) {
      images.push(`data:${item.mimeType || "image/png"};base64,${item.data}`);
      parts.push("[imagen adjunta]");
    } else if (item.type === "resource") {
      parts.push(item.resource?.text || `[recurso ${item.resource?.uri || ""}]`);
    } else if (item.type === "resource_link") {
      parts.push(`[enlace ${item.uri}]`);
    } else {
      parts.push(JSON.stringify(item));
    }
  }
  if (parts.length === 0 && result?.structuredContent) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  let output = parts.join("\n").trim();
  if (output === "") {
    output = "(sin salida)";
  }
  return { output, images };
}

function limited<T>(promise: Promise<T>, what: string, timeout: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: tiempo agotado`)), timeout);
  });
  // Sin limpiar el temporizador, el proceso no podría terminar hasta que venciera
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// El servidor pide iniciar sesión (lo dice el SDK o, sin sesión, el propio transporte con un 401)
function isUnauthorized(err: unknown): boolean {
  return err instanceof UnauthorizedError || (err as { code?: unknown } | null)?.code === 401;
}

const isRemoteConfig = (config: McpServerConfig) => config.type === "remote" || (!config.type && Boolean(config.url));

// Con una cabecera Authorization puesta por ti, o con oauth: false, vipcode no gestiona ninguna sesión
function usesOAuth(config: McpServerConfig): boolean {
  return config.oauth !== false && !Object.keys(config.headers || {}).some((name) => name.toLowerCase() === "authorization");
}

function oauthOptions(config: McpServerConfig): McpOAuthOptions {
  const oauth = config.oauth || {};
  return {
    clientId: oauth.clientId ? expandEnv(String(oauth.clientId)) : undefined,
    clientSecret: oauth.clientSecret ? expandEnv(String(oauth.clientSecret)) : undefined,
    scope: oauth.scope,
    callbackPort: oauth.callbackPort,
  };
}

// Conecta con los servidores MCP del config y ofrece sus herramientas al agente
export class McpManager {
  private servers = new Map<string, ServerState>();
  // Nombres de herramienta ya dados: dos iguales harían que los proveedores rechazaran todas las peticiones
  private names = new Set<string>();
  private onChange?: () => void;
  private closing = false;

  constructor(
    private configs: Record<string, McpServerConfig>,
    private root: string,
  ) {
    for (const [name, config] of Object.entries(configs || {})) {
      this.servers.set(name, { name, state: config?.enabled === false ? "desactivado" : "conectando", tools: [] });
    }
  }

  hasServers(): boolean {
    return this.servers.size > 0;
  }

  // Conecta con todos a la vez; los que fallan se quedan en "error" sin parar el resto
  async start(onChange?: () => void): Promise<void> {
    this.onChange = onChange;
    await Promise.allSettled(
      [...this.servers.values()]
        .filter((server) => server.state === "conectando")
        .map(async (server) => {
          try {
            await this.connect(server, this.configs[server.name]);
            server.state = "conectado";
          } catch (err) {
            server.state = "error";
            server.error = (err as Error).message;
            debugLog("mcp", server.name, err);
          }
          onChange?.();
        }),
    );
  }

  private async connect(server: ServerState, config: McpServerConfig) {
    const timeout = config.timeoutMs || 30000;
    const client = new Client({ name: "vipcode", version: VERSION });
    const isRemote = isRemoteConfig(config);
    const withTimeout = <T>(promise: Promise<T>, what: string): Promise<T> => limited(promise, what, timeout);

    if (isRemote) {
      if (!config.url) {
        throw new Error("falta la url del servidor remoto");
      }
      const url = new URL(config.url);
      const headers = Object.fromEntries(Object.entries(config.headers || {}).map(([name, value]) => [name, expandEnv(String(value))]));
      const requestInit = { headers };
      // Solo con una sesión ya iniciada. Sin ella se conecta como siempre, y si el servidor la pide se dice cómo iniciarla: ni
      // se registra nada en el servidor ni se abre el navegador sin que lo pidas
      const oauth = usesOAuth(config);
      const authProvider = oauth && hasSession(config.url) ? new McpOAuthProvider(config.url, oauthOptions(config), null) : undefined;
      const needsLogin = (err: unknown) => (oauth && isUnauthorized(err) ? new Error(`pide iniciar sesión: escribe /mcp login ${server.name}`) : err);
      try {
        await withTimeout(client.connect(new StreamableHTTPClientTransport(url, { requestInit, authProvider })), "conectar");
      } catch (err) {
        if (oauth && isUnauthorized(err)) {
          throw needsLogin(err);
        }
        // Servidores antiguos que solo hablan SSE
        debugLog("mcp streamable falló, pruebo SSE", server.name, err);
        await client.close().catch(() => {});
        const fallback = new Client({ name: "vipcode", version: VERSION });
        try {
          await withTimeout(fallback.connect(new SSEClientTransport(url, { requestInit, authProvider })), "conectar (SSE)");
        } catch (sseError) {
          throw needsLogin(sseError);
        }
        server.client = fallback;
      }
    } else {
      let command: string[] = [];
      if (Array.isArray(config.command)) {
        command = config.command.map(String);
      } else if (typeof config.command === "string") {
        command = [config.command];
      }
      command = [...command, ...(config.args || []).map(String)];
      if (command.length === 0) {
        throw new Error("falta el comando del servidor local");
      }
      const transport = new StdioClientTransport({
        // Por su ruta completa: en Windows, «npx» buscaría primero un npx.cmd en la carpeta del proyecto
        command: findProgram(command[0]) || command[0],
        args: command.slice(1),
        env: serverEnvironment(config.environment),
        cwd: config.cwd || this.root,
        // Su salida de errores no debe ensuciar la pantalla
        stderr: "pipe",
      });
      transport.stderr?.on("data", (d: Buffer) => debugLog("mcp stderr", server.name, d.toString().slice(0, 500)));
      await withTimeout(client.connect(transport), "arrancar");
    }

    if (!server.client) {
      server.client = client;
    }
    // Si el servidor se cierra (se cae, o se cierra la conexión), sus herramientas dejan de ofrecerse y /mcp lo dice
    server.client.onclose = () => {
      if (!this.closing && server.state !== "error") {
        server.state = "error";
        server.error = "se ha cerrado la conexión";
        this.onChange?.();
      }
    };
    const listed = await withTimeout(server.client.listTools(), "listar herramientas");
    server.tools = (listed.tools || []).map((tool: any) => this.wrapTool(server, tool));
  }

  // Vuelve a conectar desde cero (después de iniciar o cerrar sesión)
  private async reconnect(server: ServerState, config: McpServerConfig) {
    for (const tool of server.tools) {
      this.names.delete(tool.name);
    }
    server.tools = [];
    if (server.client) {
      server.client.onclose = undefined;
      await server.client.close().catch(() => {});
      server.client = undefined;
    }
    server.state = "conectando";
    server.error = undefined;
    try {
      await this.connect(server, config);
      server.state = "conectado";
    } catch (err) {
      server.state = "error";
      server.error = (err as Error).message;
      debugLog("mcp", server.name, err);
    }
    this.onChange?.();
  }

  private remoteServer(name: string): { server: ServerState; config: McpServerConfig & { url: string } } {
    const server = this.servers.get(name);
    const config = this.configs[name];
    if (!server || !config) {
      throw new Error(`No hay ningún servidor MCP llamado ${name}. /mcp enseña los que hay.`);
    }
    if (!isRemoteConfig(config) || !config.url) {
      throw new Error(`${name} es un servidor local: no hay que iniciar sesión.`);
    }
    return { server, config: config as McpServerConfig & { url: string } };
  }

  // /mcp login: lo pides tú, se abre el navegador, vuelve con un código (y el «state» que se mandó), se cambia por la sesión y
  // se vuelve a conectar. Devuelve el estado en el que queda
  async login(name: string, ui: LoginUi): Promise<McpStatus> {
    const { server, config } = this.remoteServer(name);
    if (!usesOAuth(config)) {
      throw new Error(`${name} tiene una cabecera Authorization o "oauth": false en la configuración: vipcode no gestiona su sesión.`);
    }
    const options = oauthOptions(config);
    const state = crypto.randomBytes(16).toString("hex");
    const callback = await callbackServer(state, 5 * 60 * 1000, { strict: true, port: options.callbackPort });
    // Si el navegador dice que no antes de que se espere el código, ya saltará al esperarlo: que no tumbe vipcode
    callback.code.catch(() => {});
    const provider = new McpOAuthProvider(config.url, options, {
      redirectUrl: callback.url,
      state,
      open: (target) => {
        ui.info(`Abro el navegador para que inicies sesión en ${name} (espero 5 minutos). Si no se abre, entra en:\n${target.href}`);
        openBrowser(target.href);
      },
    });
    const url = new URL(config.url);
    const requestInit = { headers: Object.fromEntries(Object.entries(config.headers || {}).map(([key, value]) => [key, expandEnv(String(value))])) };
    const timeout = config.timeoutMs || 30000;
    let lastError: unknown = null;
    let authorized = false;
    try {
      // Como al conectar: primero el transporte de ahora y, en los servidores antiguos, SSE
      for (const transport of [new StreamableHTTPClientTransport(url, { requestInit, authProvider: provider }), new SSEClientTransport(url, { requestInit, authProvider: provider })]) {
        const client = new Client({ name: "vipcode", version: VERSION });
        try {
          await limited(client.connect(transport), "conectar", timeout);
          authorized = true;
          await client.close().catch(() => {});
          break;
        } catch (err) {
          lastError = err;
          if (err instanceof UnauthorizedError) {
            const code = await callback.code;
            await limited(transport.finishAuth(code), "iniciar sesión", timeout);
            authorized = true;
            await client.close().catch(() => {});
            break;
          }
          await client.close().catch(() => {});
        }
      }
    } finally {
      callback.close();
    }
    if (!authorized) {
      throw lastError instanceof Error ? lastError : new Error("no se ha podido iniciar sesión");
    }
    await this.reconnect(server, config);
    return this.status().find((row) => row.name === name)!;
  }

  // /mcp logout: olvida la sesión guardada y vuelve a conectar (sin ella, si el servidor la pide, lo dice)
  async logout(name: string): Promise<McpStatus> {
    const { server, config } = this.remoteServer(name);
    forgetSession(config.url);
    await this.reconnect(server, config);
    return this.status().find((row) => row.name === name)!;
  }

  // El nombre que ve el modelo: servidor_herramienta, y si ya existe (o es uno de vipcode), con _2, _3…
  private uniqueName(server: string, tool: string): string {
    const base = sanitizeName(`${server}_${tool}`);
    let name = base;
    for (let n = 2; RESERVED.has(name) || this.names.has(name); n++) {
      name = `${base.slice(0, 64 - String(n).length - 1)}_${n}`;
    }
    this.names.add(name);
    return name;
  }

  private wrapTool(server: ServerState, tool: any): Tool {
    const fullName = this.uniqueName(server.name, String(tool.name));
    let parameters = cleanSchema(tool.inputSchema || { type: "object", properties: {} });
    if (!parameters || parameters.type !== "object") {
      parameters = { type: "object", properties: {} };
    }
    const description = String(tool.description || tool.title || tool.name).slice(0, 1024);
    return {
      name: fullName,
      description: `${description} (herramienta MCP de ${server.name})`,
      parameters,
      permission: "mcp",
      readOnly: tool.annotations?.readOnlyHint === true,
      run: async (args, ctx) => {
        const preview = truncate(JSON.stringify(args, null, 2), 2000);
        const reply = await ctx.ask({ kind: "mcp", title: `Usar ${server.name} → ${tool.name}`, preview, subject: fullName });
        if (!reply.allow) {
          if (reply.feedback) {
            return `El usuario ha rechazado usar ${fullName}. Motivo: ${reply.feedback}`;
          }
          return `El usuario ha rechazado usar ${fullName}.`;
        }
        if (!server.client) {
          return { output: `Error: el servidor MCP ${server.name} no está conectado.`, isError: true };
        }
        const result = await server.client.callTool({ name: tool.name, arguments: args }, undefined, {
          signal: ctx.signal,
          timeout: 300000,
        });
        const { output, images } = toText(result);
        if (result.isError) {
          return { output: `Error: ${truncate(output)}`, isError: true, images };
        }
        return { output: truncate(output), images };
      },
    };
  }

  tools(): Tool[] {
    const all: Tool[] = [];
    for (const server of this.servers.values()) {
      if (server.state === "conectado") {
        all.push(...server.tools);
      }
    }
    return all;
  }

  status(): McpStatus[] {
    return [...this.servers.values()].map((server) => ({
      name: server.name,
      state: server.state,
      error: server.error,
      tools: server.tools.length,
    }));
  }

  async close() {
    this.closing = true;
    await Promise.allSettled(
      [...this.servers.values()].map(async (server) => {
        if (server.client) {
          await server.client.close();
        }
      }),
    );
  }
}
