// Copyright (C) 2026 Pablo Vicente Juan
// SPDX-License-Identifier: AGPL-3.0-or-later
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { HOME_DIR, ensureHomeDir, writeFileAtomic } from "./paths.js";

// Las sesiones de los servidores MCP que piden iniciar sesión con OAuth. Van en tu carpeta de datos, donde las herramientas
// no pueden leer, y por la dirección del servidor, no por su nombre: si la configuración de un proyecto llama igual a otro
// servidor, ese otro no recibe tu sesión
const SESSIONS_PATH = path.join(HOME_DIR, "mcp-auth.json");

interface StoredSession {
  tokens?: OAuthTokens;
  client?: OAuthClientInformationMixed;
  verifier?: string;
}

function readAll(): Record<string, StoredSession> {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function update(url: string, change: (session: StoredSession) => void) {
  const all = readAll();
  const session = (all[url] ??= {});
  change(session);
  if (Object.keys(session).length === 0) {
    delete all[url];
  }
  ensureHomeDir();
  writeFileAtomic(SESSIONS_PATH, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.chmodSync(SESSIONS_PATH, 0o600);
}

export function hasSession(url: string): boolean {
  return Boolean(readAll()[url]?.tokens);
}

export function forgetSession(url: string) {
  update(url, (session) => {
    delete session.tokens;
    delete session.client;
    delete session.verifier;
  });
}

// Lo que se puede poner en la configuración para los servidores que no dejan registrarse solo (los que dan un error de
// «dynamic client registration»): tu aplicación en ese servicio y, si lo pide, en qué puerto volver
export interface McpOAuthOptions {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  callbackPort?: number;
}

// Para iniciar sesión de verdad: dónde vuelve el navegador, el «state» que tiene que volver igual y qué hacer con la dirección.
// Sin esto (al arrancar, con una sesión guardada) solo se usa o se renueva lo que hay: nunca se abre el navegador solo
export interface McpLogin {
  redirectUrl: string;
  state: string;
  open: (url: URL) => void;
}

export class McpOAuthProvider implements OAuthClientProvider {
  constructor(
    private url: string,
    private options: McpOAuthOptions,
    private login: McpLogin | null,
  ) {}

  get redirectUrl(): string {
    return this.login?.redirectUrl || "http://localhost/callback";
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "vipcode",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.options.clientSecret ? "client_secret_post" : "none",
      ...(this.options.scope ? { scope: this.options.scope } : {}),
    };
  }

  state(): string {
    return this.login?.state || crypto.randomBytes(16).toString("hex");
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.options.clientId) {
      return { client_id: this.options.clientId, ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {}) };
    }
    const client = readAll()[this.url]?.client;
    // Al iniciar sesión el navegador vuelve a otro puerto: lo registrado para el anterior ya no vale y se registra de nuevo
    const registered = (client as { redirect_uris?: unknown } | undefined)?.redirect_uris;
    if (this.login && Array.isArray(registered) && !registered.map(String).includes(this.redirectUrl)) {
      return undefined;
    }
    return client;
  }

  saveClientInformation(information: OAuthClientInformationMixed) {
    update(this.url, (session) => {
      session.client = information;
    });
  }

  tokens(): OAuthTokens | undefined {
    return readAll()[this.url]?.tokens;
  }

  saveTokens(tokens: OAuthTokens) {
    update(this.url, (session) => {
      session.tokens = tokens;
    });
  }

  // La dirección la decide el servidor: un servidor malicioso podría mandar file: u otro programa de tu ordenador, y abrirla
  // sería ejecutarlo. Solo páginas web
  redirectToAuthorization(authorizationUrl: URL) {
    if (authorizationUrl.protocol !== "https:" && authorizationUrl.protocol !== "http:") {
      throw new Error(`el servidor pide iniciar sesión en una dirección que no es una página web (${authorizationUrl.protocol})`);
    }
    this.login?.open(authorizationUrl);
  }

  saveCodeVerifier(verifier: string) {
    update(this.url, (session) => {
      session.verifier = verifier;
    });
  }

  codeVerifier(): string {
    const verifier = readAll()[this.url]?.verifier;
    if (!verifier) {
      throw new Error("no hay ningún inicio de sesión en marcha");
    }
    return verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    update(this.url, (session) => {
      if (scope === "all" || scope === "tokens") {
        delete session.tokens;
      }
      if (scope === "all" || scope === "client") {
        delete session.client;
      }
      if (scope === "all" || scope === "verifier") {
        delete session.verifier;
      }
    });
  }
}
