import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Config, LspServerConfig } from "./config.js";
import { debugLog } from "./debug.js";
import { spawnProgram } from "./shell.js";

export interface Diagnostic {
  line: number;
  column: number;
  // 1 error, 2 aviso, 3 información, 4 pista
  severity: number;
  message: string;
  code?: string;
  source?: string;
}

interface ServerSpec {
  id: string;
  command: string[];
  extensions: string[];
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
  // Se calcula al arrancar (por ejemplo el TypeScript que trae vipcode)
  resolve?: () => Promise<string[] | null>;
}

const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescriptreact", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python", ".go": "go", ".rs": "rust",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp",
  ".php": "php", ".rb": "ruby", ".sh": "shellscript", ".bash": "shellscript",
  ".yaml": "yaml", ".yml": "yaml", ".css": "css", ".scss": "scss", ".less": "less",
  ".html": "html", ".htm": "html", ".json": "json", ".jsonc": "jsonc", ".lua": "lua",
  ".zig": "zig", ".dart": "dart", ".cs": "csharp", ".swift": "swift", ".kt": "kotlin", ".svelte": "svelte",
};

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

// TypeScript 7 trae su propio servidor de lenguaje (tsc --lsp --stdio); vipcode lo lleva como dependencia
async function bundledTypescript(): Promise<string[] | null> {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("typescript/package.json");
    const helper = path.join(path.dirname(pkg), "lib", "getExePath.js");
    if (!fs.existsSync(helper)) {
      return null;
    }
    const module = await import(pathToFileURL(helper).href);
    const exe = module.default();
    if (typeof exe === "string" && fs.existsSync(exe)) {
      return [exe, "--lsp", "--stdio"];
    }
  } catch (err) {
    debugLog("lsp typescript", err);
  }
  return null;
}

const BUILTIN_SERVERS: ServerSpec[] = [
  { id: "typescript", command: [], extensions: TS_EXTENSIONS, resolve: bundledTypescript },
  { id: "typescript-language-server", command: ["typescript-language-server", "--stdio"], extensions: TS_EXTENSIONS },
  { id: "basedpyright", command: ["basedpyright-langserver", "--stdio"], extensions: [".py", ".pyi"] },
  { id: "pyright", command: ["pyright-langserver", "--stdio"], extensions: [".py", ".pyi"] },
  { id: "pylsp", command: ["pylsp"], extensions: [".py"] },
  { id: "gopls", command: ["gopls"], extensions: [".go"] },
  { id: "rust-analyzer", command: ["rust-analyzer"], extensions: [".rs"] },
  { id: "clangd", command: ["clangd"], extensions: [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp"] },
  { id: "intelephense", command: ["intelephense", "--stdio"], extensions: [".php"] },
  { id: "phpactor", command: ["phpactor", "language-server"], extensions: [".php"] },
  { id: "ruby-lsp", command: ["ruby-lsp"], extensions: [".rb"] },
  { id: "solargraph", command: ["solargraph", "stdio"], extensions: [".rb"] },
  { id: "bash", command: ["bash-language-server", "start"], extensions: [".sh", ".bash"] },
  { id: "yaml", command: ["yaml-language-server", "--stdio"], extensions: [".yaml", ".yml"] },
  { id: "css", command: ["vscode-css-language-server", "--stdio"], extensions: [".css", ".scss", ".less"] },
  { id: "html", command: ["vscode-html-language-server", "--stdio"], extensions: [".html", ".htm"] },
  { id: "json", command: ["vscode-json-language-server", "--stdio"], extensions: [".json", ".jsonc"] },
  { id: "lua", command: ["lua-language-server"], extensions: [".lua"] },
  { id: "zls", command: ["zls"], extensions: [".zig"] },
  { id: "dart", command: ["dart", "language-server", "--protocol=lsp"], extensions: [".dart"] },
  { id: "csharp", command: ["csharp-ls"], extensions: [".cs"] },
  { id: "sourcekit", command: ["sourcekit-lsp"], extensions: [".swift"] },
  { id: "kotlin", command: ["kotlin-language-server"], extensions: [".kt"] },
  { id: "svelte", command: ["svelteserver", "--stdio"], extensions: [".svelte"] },
];

// Busca un ejecutable en node_modules/.bin del proyecto y en el PATH
function which(command: string, root: string): string | null {
  if (path.isAbsolute(command)) {
    return fs.existsSync(command) ? command : null;
  }
  const dirs = [path.join(root, "node_modules", ".bin"), ...(process.env.PATH || "").split(path.delimiter)];
  const names = process.platform === "win32" ? [`${command}.cmd`, `${command}.exe`, command] : [command];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // no está aquí
      }
    }
  }
  return null;
}

function uriKey(uri: string): string {
  // macOS y Windows no distinguen mayúsculas en las rutas, y algunos servidores las cambian
  if (process.platform === "darwin" || process.platform === "win32") {
    return decodeURIComponent(uri).toLowerCase();
  }
  return decodeURIComponent(uri);
}

// Un servidor de lenguaje hablando JSON-RPC por stdin/stdout
class LspClient {
  private child: ChildProcess;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private versions = new Map<string, number>();
  private published = new Map<string, { at: number; items: Diagnostic[] }>();
  private waiters: (() => void)[] = [];
  private pull = false;
  dead = false;
  files = new Set<string>();

  constructor(
    readonly spec: ServerSpec,
    command: string[],
    private root: string,
  ) {
    // En Windows muchos servidores son .cmd (instalados con npm)
    this.child = spawnProgram(command[0], command.slice(1), {
      cwd: root,
      env: { ...process.env, ...(spec.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.on("error", (err) => {
      debugLog("lsp error", spec.id, err);
      this.dead = true;
      this.failAll(err);
    });
    this.child.on("exit", () => {
      this.dead = true;
      this.failAll(new Error("el servidor de lenguaje se ha cerrado"));
    });
    this.child.stderr?.on("data", (d) => debugLog("lsp stderr", spec.id, d.toString().slice(0, 500)));
    this.child.stdout?.on("data", (d: Buffer) => this.onData(d));
  }

  private failAll(err: Error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private send(message: Record<string, unknown>) {
    if (this.dead || !this.child.stdin) {
      return;
    }
    const text = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  }

  request(method: string, params: unknown, timeoutMs = 10000): Promise<any> {
    if (this.dead) {
      return Promise.reject(new Error("servidor de lenguaje cerrado"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: sin respuesta`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.send({ method, params });
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString();
      const length = /Content-Length:\s*(\d+)/i.exec(header);
      if (!length) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const size = Number(length[1]);
      if (this.buffer.length < headerEnd + 4 + size) {
        return;
      }
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + size).toString();
      this.buffer = this.buffer.subarray(headerEnd + 4 + size);
      try {
        this.onMessage(JSON.parse(body));
      } catch (err) {
        debugLog("lsp mensaje inválido", this.spec.id, err);
      }
    }
  }

  private onMessage(message: any) {
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        if (message.error) {
          entry.reject(new Error(message.error.message || "error del servidor de lenguaje"));
        } else {
          entry.resolve(message.result);
        }
      }
      return;
    }
    if (message.method && message.id !== undefined) {
      // Petición del servidor: contestamos lo mínimo para que siga funcionando
      let result: unknown = null;
      if (message.method === "workspace/configuration") {
        result = (message.params?.items || []).map(() => this.spec.initialization?.settings ?? null);
      } else if (message.method === "workspace/workspaceFolders") {
        result = [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }];
      } else if (message.method === "workspace/applyEdit") {
        result = { applied: false };
      }
      this.send({ id: message.id, result });
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const items = (message.params?.diagnostics || []).map(toDiagnostic);
      this.published.set(uriKey(message.params.uri), { at: Date.now(), items });
      const waiters = this.waiters;
      this.waiters = [];
      for (const wake of waiters) {
        wake();
      }
    }
  }

  async initialize() {
    const rootUri = pathToFileURL(this.root).href;
    const result = await this.request(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "vipcode" },
        rootUri,
        rootPath: this.root,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }],
        initializationOptions: this.spec.initialization,
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true },
          textDocument: {
            synchronization: { didSave: true, dynamicRegistration: false },
            publishDiagnostics: { versionSupport: true, relatedInformation: false },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          },
          window: { workDoneProgress: false },
        },
      },
      30000,
    );
    this.pull = Boolean(result?.capabilities?.diagnosticProvider);
    this.notify("initialized", {});
    this.notify("workspace/didChangeConfiguration", { settings: this.spec.initialization?.settings ?? {} });
  }

  // Manda al servidor el contenido actual del fichero
  private sync(file: string, text: string) {
    const uri = pathToFileURL(file).href;
    const version = (this.versions.get(uri) || 0) + 1;
    this.versions.set(uri, version);
    if (version === 1) {
      const languageId = LANGUAGE_IDS[path.extname(file).toLowerCase()] || "plaintext";
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
    } else {
      this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    }
    this.notify("textDocument/didSave", { textDocument: { uri }, text });
    this.files.add(file);
    return uri;
  }

  async diagnostics(file: string, firstTime: boolean): Promise<Diagnostic[]> {
    const text = fs.readFileSync(file, "utf8");
    const since = Date.now();
    const uri = this.sync(file, text);
    if (this.pull) {
      const result = await this.request("textDocument/diagnostic", { textDocument: { uri } }, firstTime ? 20000 : 8000);
      if (result?.kind === "unchanged") {
        return this.published.get(uriKey(uri))?.items || [];
      }
      return (result?.items || []).map(toDiagnostic);
    }
    // Servidores que mandan los diagnósticos por su cuenta: esperamos a que lleguen
    const key = uriKey(uri);
    const deadline = Date.now() + (firstTime ? 15000 : 4000);
    while (Date.now() < deadline) {
      const found = this.published.get(key);
      if (found && found.at >= since) {
        // Un momento más por si llega una segunda tanda (algunos servidores mandan dos)
        await new Promise((resolve) => setTimeout(resolve, 300));
        return this.published.get(key)?.items || found.items;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.published.get(key)?.items || [];
  }

  async shutdown() {
    if (this.dead) {
      return;
    }
    try {
      await this.request("shutdown", null, 1500);
      this.notify("exit", null);
    } catch {
      // si no contesta, lo matamos
    }
    setTimeout(() => {
      if (!this.dead) {
        this.child.kill("SIGTERM");
      }
    }, 300).unref();
  }
}

function toDiagnostic(item: any): Diagnostic {
  return {
    line: (item?.range?.start?.line ?? 0) + 1,
    column: (item?.range?.start?.character ?? 0) + 1,
    severity: item?.severity ?? 1,
    message: String(item?.message || "").replace(/\s+/g, " ").trim(),
    code: item?.code !== undefined ? String(item.code) : undefined,
    source: item?.source,
  };
}

const SEVERITY = ["", "error", "aviso", "info", "pista"];

export interface LspStatus {
  id: string;
  state: string;
  files: number;
}

// Arranca los servidores de lenguaje cuando hacen falta y les pregunta por errores
export class LspManager {
  private clients = new Map<string, Promise<LspClient | null>>();
  private specs: ServerSpec[] = [];
  private failed = new Map<string, string>();

  constructor(
    private root: string,
    config: Config,
  ) {
    if (config.lsp === false) {
      return;
    }
    const overrides = config.lsp || {};
    const specs: ServerSpec[] = [];
    // Primero los tuyos del config, después los integrados que no hayas desactivado
    for (const [id, value] of Object.entries(overrides)) {
      if (value && !value.disabled && Array.isArray(value.command) && Array.isArray(value.extensions)) {
        const custom = value as LspServerConfig;
        specs.push({ id, command: custom.command, extensions: custom.extensions.map((ext) => ext.toLowerCase()), env: custom.env, initialization: custom.initialization });
      }
    }
    for (const spec of BUILTIN_SERVERS) {
      const override = overrides[spec.id];
      if (override === false || (override && override.disabled)) {
        continue;
      }
      if (specs.some((existing) => existing.id === spec.id)) {
        continue;
      }
      specs.push(spec);
    }
    this.specs = specs;
  }

  enabled(): boolean {
    return this.specs.length > 0;
  }

  private async commandFor(spec: ServerSpec): Promise<string[] | null> {
    if (spec.resolve) {
      return spec.resolve();
    }
    const exe = which(spec.command[0], this.root);
    if (!exe) {
      return null;
    }
    return [exe, ...spec.command.slice(1)];
  }

  private clientFor(file: string): Promise<LspClient | null> {
    const ext = path.extname(file).toLowerCase();
    const candidates = this.specs.filter((spec) => spec.extensions.includes(ext));
    if (candidates.length === 0) {
      return Promise.resolve(null);
    }
    const cacheKey = `ext:${ext}`;
    let client = this.clients.get(cacheKey);
    if (!client) {
      client = (async () => {
        for (const spec of candidates) {
          // Si ya está arrancado para otra extensión, lo reutilizamos
          const existing = [...this.clients.entries()].find(([key]) => key === `id:${spec.id}`);
          if (existing) {
            const running = await existing[1];
            if (running && !running.dead) {
              return running;
            }
          }
          const command = await this.commandFor(spec);
          if (!command) {
            continue;
          }
          try {
            const started = new LspClient(spec, command, this.root);
            const ready = started.initialize().then(() => started);
            this.clients.set(`id:${spec.id}`, ready.catch(() => null));
            await ready;
            return started;
          } catch (err) {
            this.failed.set(spec.id, (err as Error).message);
            debugLog("lsp arranque", spec.id, err);
          }
        }
        return null;
      })();
      this.clients.set(cacheKey, client);
    }
    return client;
  }

  async diagnostics(file: string): Promise<Diagnostic[] | null> {
    if (!this.enabled() || !fs.existsSync(file)) {
      return null;
    }
    const client = await this.clientFor(file);
    if (!client || client.dead) {
      return null;
    }
    const firstTime = !client.files.has(file);
    try {
      return await client.diagnostics(file, firstTime);
    } catch (err) {
      debugLog("lsp diagnósticos", client.spec.id, err);
      return null;
    }
  }

  // Texto para el modelo: errores (y avisos si all) con fichero:línea:columna
  async report(file: string, all: boolean): Promise<string> {
    const found = await this.diagnostics(file);
    if (!found) {
      return "";
    }
    const relevant = found.filter((item) => item.severity === 1 || (all && item.severity === 2));
    if (relevant.length === 0) {
      return "";
    }
    const name = path.relative(this.root, file);
    const lines = relevant.slice(0, 20).map((item) => {
      const code = item.code ? ` ${item.source || ""}${item.code}` : "";
      return `${name}:${item.line}:${item.column} ${SEVERITY[item.severity] || "error"}${code}: ${item.message}`;
    });
    if (relevant.length > 20) {
      lines.push(`[… y ${relevant.length - 20} más]`);
    }
    return lines.join("\n");
  }

  async status(): Promise<LspStatus[]> {
    const rows: LspStatus[] = [];
    for (const [key, promise] of this.clients.entries()) {
      if (!key.startsWith("id:")) {
        continue;
      }
      const client = await promise;
      rows.push({ id: key.slice(3), state: client && !client.dead ? "activo" : "cerrado", files: client ? client.files.size : 0 });
    }
    for (const [id, error] of this.failed.entries()) {
      rows.push({ id, state: `error: ${error}`, files: 0 });
    }
    return rows;
  }

  // Servidores que se podrían usar en este ordenador (para /lsp)
  async availableServers(): Promise<string[]> {
    const found: string[] = [];
    for (const spec of this.specs) {
      if (await this.commandFor(spec)) {
        found.push(`${spec.id} (${spec.extensions.join(" ")})`);
      }
    }
    return found;
  }

  async shutdown() {
    const clients = await Promise.all([...this.clients.values()]);
    await Promise.all(
      [...new Set(clients)].map((client) => {
        if (client) {
          return client.shutdown();
        }
        return Promise.resolve();
      }),
    );
  }
}
