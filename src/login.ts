import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { debugLog } from "./debug.js";

// Lo mínimo que necesita el inicio de sesión de la interfaz (terminal o TUI)
export interface LoginUi {
  info(text: string): void;
  prompt?(title: string, options?: { mask?: boolean; placeholder?: string }): Promise<string | null>;
}

// Abre una dirección en el navegador. VIPCODE_BROWSER permite usar otro comando ("firefox", "echo"…)
export function openBrowser(url: string): void {
  let command: string;
  let args: string[];
  const custom = (process.env.VIPCODE_BROWSER || "").split(/\s+/).filter(Boolean);
  if (custom.length > 0) {
    [command, ...args] = custom;
    args.push(url);
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    // Con «start» habría que escapar los & de la dirección
    command = "rundll32";
    args = ["url.dll,FileProtocolHandler", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", (err) => debugLog("navegador", err));
    child.unref();
  } catch (err) {
    debugLog("navegador", err);
  }
}

// Sin navegador en esta máquina (por ejemplo, conectado por SSH)
export function isRemoteSession(): boolean {
  return Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY);
}

// PKCE: el verificador se queda aquí y al proveedor solo le llega su hash
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function page(text: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>vipcode</title></head><body style="font-family:system-ui,sans-serif;margin:15vh auto;max-width:32rem;padding:0 1rem;text-align:center"><h1>vipcode</h1><p>${text}</p></body></html>`;
}

// Espera a que el navegador vuelva a http://localhost:<puerto>/callback con el código
async function callbackServer(state: string, timeoutMs: number) {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const handler: http.RequestListener = (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/callback") {
      res.writeHead(404);
      res.end();
      return;
    }
    const html = { "content-type": "text/html; charset=utf-8" };
    const returned = url.searchParams.get("state");
    if (returned && returned !== state) {
      res.writeHead(400, html);
      res.end(page("Esta respuesta no es de este inicio de sesión. Vuelve a intentarlo desde vipcode."));
      return;
    }
    const value = url.searchParams.get("code");
    if (!value) {
      res.writeHead(400, html);
      res.end(page("No se ha dado permiso. Ya puedes cerrar esta pestaña."));
      rejectCode(new Error("no has dado permiso en el navegador"));
      return;
    }
    res.writeHead(200, html);
    res.end(page("Listo. Ya puedes cerrar esta pestaña y volver a vipcode."));
    resolveCode(value);
  };

  const servers = [http.createServer(handler)];
  await new Promise<void>((resolve, reject) => {
    servers[0].once("error", reject);
    servers[0].listen(0, "127.0.0.1", () => resolve());
  });
  const port = (servers[0].address() as AddressInfo).port;
  // También en IPv6, porque el navegador puede resolver «localhost» como ::1
  const v6 = http.createServer(handler);
  await new Promise<void>((resolve) => {
    v6.once("error", () => resolve());
    v6.listen(port, "::1", () => {
      servers.push(v6);
      resolve();
    });
  });

  const timer = setTimeout(() => rejectCode(new Error(`se ha acabado el tiempo (${Math.round(timeoutMs / 60000)} min) sin iniciar sesión`)), timeoutMs);
  const close = () => {
    clearTimeout(timer);
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
  };
  return { url: `http://localhost:${port}/callback`, code, close };
}

// OpenRouter: inicio de sesión oficial con OAuth PKCE (https://openrouter.ai/docs/guides/overview/auth/oauth).
// Crea en tu cuenta una clave llamada «vipcode» y la devuelve; null si no se completa.
export async function loginOpenRouter(ui: LoginUi, baseURL: string, options: { headless?: boolean; timeoutMs?: number } = {}): Promise<string | null> {
  const api = baseURL.replace(/\/+$/, "");
  const site = new URL(api).origin;
  const { verifier, challenge } = pkcePair();
  const params = new URLSearchParams({ code_challenge: challenge, code_challenge_method: "S256", key_label: "vipcode" });
  let code: string | null = null;

  if (options.headless) {
    // Sin callback, OpenRouter enseña el código en pantalla para copiarlo aquí
    if (!ui.prompt) {
      return null;
    }
    ui.info(`Abre este enlace en cualquier navegador, inicia sesión y copia el código que te enseñe:\n${site}/auth?${params}`);
    const answer = await ui.prompt("Código de OpenRouter");
    code = answer?.trim() || null;
  } else {
    const state = crypto.randomBytes(16).toString("hex");
    const callback = await callbackServer(state, options.timeoutMs ?? 5 * 60 * 1000);
    params.set("callback_url", callback.url);
    params.set("state", state);
    const url = `${site}/auth?${params}`;
    ui.info(`Abro el navegador para que inicies sesión en OpenRouter (espero 5 minutos). Si no se abre, entra en:\n${url}`);
    openBrowser(url);
    try {
      code = await callback.code;
    } finally {
      callback.close();
    }
  }
  if (!code) {
    return null;
  }

  const response = await fetch(`${api}/auth/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenRouter no ha dado la clave (HTTP ${response.status} ${body.slice(0, 120)})`);
  }
  const json: any = await response.json();
  if (typeof json?.key !== "string" || !json.key) {
    throw new Error("OpenRouter no ha devuelto ninguna clave");
  }
  return json.key;
}
