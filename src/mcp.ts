import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "./config.js";
import { debugLog } from "./debug.js";
import { type Tool, truncate } from "./tools.js";

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

// Conecta con los servidores MCP del config y ofrece sus herramientas al agente
export class McpManager {
  private servers = new Map<string, ServerState>();

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
    const client = new Client({ name: "vipcode", version: "0.2.0" });
    const isRemote = config.type === "remote" || (!config.type && Boolean(config.url));

    const withTimeout = <T>(promise: Promise<T>, what: string): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: tiempo agotado`)), timeout);
      });
      // Sin limpiar el temporizador, el proceso no podría terminar hasta que venciera
      return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
    };

    if (isRemote) {
      if (!config.url) {
        throw new Error("falta la url del servidor remoto");
      }
      const url = new URL(config.url);
      const requestInit = { headers: config.headers || {} };
      try {
        await withTimeout(client.connect(new StreamableHTTPClientTransport(url, { requestInit })), "conectar");
      } catch (err) {
        // Servidores antiguos que solo hablan SSE
        debugLog("mcp streamable falló, pruebo SSE", server.name, err);
        const fallback = new Client({ name: "vipcode", version: "0.2.0" });
        await withTimeout(fallback.connect(new SSEClientTransport(url, { requestInit })), "conectar (SSE)");
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
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
      Object.assign(env, config.environment || {});
      const transport = new StdioClientTransport({
        command: command[0],
        args: command.slice(1),
        env,
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
    const listed = await withTimeout(server.client.listTools(), "listar herramientas");
    server.tools = (listed.tools || []).map((tool: any) => this.wrapTool(server, tool));
  }

  private wrapTool(server: ServerState, tool: any): Tool {
    const fullName = sanitizeName(`${server.name}_${tool.name}`);
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
    await Promise.allSettled(
      [...this.servers.values()].map(async (server) => {
        if (server.client) {
          await server.client.close();
        }
      }),
    );
  }
}
