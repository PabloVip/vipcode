// Servidor MCP mínimo para las pruebas: una herramienta que suma dos números
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "calc", version: "1.0.0" });

server.registerTool(
  "sumar",
  {
    description: "Suma dos números",
    inputSchema: { a: z.number(), b: z.number() },
    annotations: { readOnlyHint: true },
  },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);

// Qué le llega del entorno: no debe heredar tus claves, solo lo que se le pase en "environment"
server.registerTool(
  "entorno",
  { description: "Variables que recibe el servidor", inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: "text", text: JSON.stringify({ gemini: process.env.GEMINI_API_KEY ?? null, pasada: process.env.PASADA ?? null, path: Boolean(process.env.PATH) }) }] }),
);

await server.connect(new StdioServerTransport());
