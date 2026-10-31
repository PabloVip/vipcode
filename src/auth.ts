import fs from "node:fs";
import { type ProviderConfig, configNotices, jsonProblem } from "./config.js";
import { AUTH_PATH, ensureHomeDir, writeFileAtomic } from "./paths.js";

// Lo que guarda "vipcode auth login" para cada proveedor
export interface AuthEntry {
  key?: string;
  // Variables extra, por ejemplo CLOUDFLARE_ACCOUNT_ID
  vars?: Record<string, string>;
}

export type AuthFile = Record<string, AuthEntry>;

export interface Credentials {
  apiKey: string;
  baseURL: string;
  // De dónde salió la clave, para enseñarlo en "vipcode auth list"
  source: "config" | "auth" | "env" | "sin clave";
}

// Lo que hay en auth.json, y si está roto (por ejemplo, editado a mano con un error), por qué
function loadAuth(): { data: AuthFile; broken: string | null } {
  let text: string;
  try {
    text = fs.readFileSync(AUTH_PATH, "utf8");
  } catch {
    // sin fichero todavía
    return { data: {}, broken: null };
  }
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return { data: data as AuthFile, broken: null };
    }
    return { data: {}, broken: "no es un objeto JSON" };
  } catch (err) {
    return { data: {}, broken: jsonProblem(err) };
  }
}

export function readAuth(): AuthFile {
  const { data, broken } = loadAuth();
  if (broken) {
    // Sin las claves guardadas vipcode sigue funcionando (con las IAs sin registro), pero que no pase desapercibido
    const notice = `No puedo leer ${AUTH_PATH} (${broken}): las claves guardadas no se usan. Arréglalo, o bórralo y vuelve a conectar tus cuentas con /connect.`;
    if (!configNotices.includes(notice)) {
      configNotices.push(notice);
    }
  }
  return data;
}

// Para cambiarlo hay que poder leerlo: si está roto no se sobrescribe, que se perderían las demás claves
function editableAuth(): AuthFile {
  const { data, broken } = loadAuth();
  if (broken) {
    throw new Error(`No puedo leer ${AUTH_PATH} (${broken}) y, si lo guardo, se perderían las claves que tiene. Arréglalo, o bórralo y vuelve a conectar tus cuentas.`);
  }
  return data;
}

function writeAuth(data: AuthFile) {
  ensureHomeDir();
  // 0600: solo tu usuario puede leer las claves
  writeFileAtomic(AUTH_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(AUTH_PATH, 0o600);
}

export function saveAuth(provider: string, entry: AuthEntry) {
  const data = editableAuth();
  const previous = data[provider] || {};
  data[provider] = { ...previous, ...entry, vars: { ...(previous.vars || {}), ...(entry.vars || {}) } };
  if (Object.keys(data[provider].vars || {}).length === 0) {
    delete data[provider].vars;
  }
  writeAuth(data);
}

export function removeAuth(provider: string): boolean {
  const data = editableAuth();
  if (!data[provider]) {
    return false;
  }
  delete data[provider];
  writeAuth(data);
  return true;
}

export function envNames(provider: ProviderConfig): string[] {
  if (!provider.apiKeyEnv) {
    return [];
  }
  if (Array.isArray(provider.apiKeyEnv)) {
    return provider.apiKeyEnv;
  }
  return [provider.apiKeyEnv];
}

// Variables que usa la URL, por ejemplo ${CLOUDFLARE_ACCOUNT_ID}
export function urlVars(provider: ProviderConfig): string[] {
  const names = new Set(provider.requiredVars || []);
  for (const match of provider.baseURL.matchAll(/\$\{(\w+)\}/g)) {
    names.add(match[1]);
  }
  return [...names];
}

// Devuelve la clave y la URL final del proveedor, o null si falta algo
export function resolveCredentials(provider: ProviderConfig, auth: AuthFile = readAuth()): Credentials | null {
  const entry = auth[provider.name] || {};
  let apiKey = "";
  let source: Credentials["source"] = "config";

  if (provider.apiKey) {
    apiKey = provider.apiKey;
  } else if (entry.key) {
    apiKey = entry.key;
    source = "auth";
  } else {
    for (const name of envNames(provider)) {
      if (process.env[name]) {
        apiKey = String(process.env[name]);
        source = "env";
        break;
      }
    }
  }

  if (!apiKey) {
    // Sin clave solo valen los anónimos de internet y los locales
    if (!provider.noKey) {
      return null;
    }
    apiKey = "no-key";
    source = "sin clave";
  }

  let missing = false;
  const baseURL = provider.baseURL.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
    const value = entry.vars?.[name] || process.env[name];
    if (!value) {
      missing = true;
      return "";
    }
    return value;
  });
  if (missing) {
    return null;
  }
  return { apiKey, baseURL, source };
}

// Oculta una clave para enseñarla en pantalla: sk-ab…wxyz
export function maskKey(key: string): string {
  if (key === "no-key") {
    return "(sin clave)";
  }
  if (key.length <= 10) {
    return "…";
  }
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}
