// Copyright (C) 2026 Pablo Vicente Juan
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { debugLog } from "./debug.js";
import { SNAPSHOTS_DIR } from "./paths.js";
import { findProgram } from "./shell.js";

// Carpetas que no se guardan en las instantáneas (además de lo que diga el .gitignore del proyecto)
const DEFAULT_EXCLUDES = [
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  ".cache/",
  "target/",
  "dist/",
  "build/",
  "coverage/",
  ".DS_Store",
  "*.log",
];

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Instantáneas del proyecto en un repositorio git aparte (~/.vipcode/snapshots), sin tocar tu .git
export class Snapshots {
  private gitDir: string;
  private ready: Promise<boolean> | null = null;
  disabledReason = "";

  constructor(
    private root: string,
    private enabled: boolean,
  ) {
    const hash = crypto.createHash("sha1").update(root).digest("hex").slice(0, 16);
    this.gitDir = path.join(SNAPSHOTS_DIR, hash);
  }

  private git(args: string[], timeoutMs = 30000, input?: string): Promise<GitResult> {
    return new Promise((resolve) => {
      const child = execFile(
        findProgram("git") || "git",
        ["--git-dir", this.gitDir, "--work-tree", this.root, "-c", "core.autocrlf=false", "-c", "core.quotepath=false", ...args],
        {
          cwd: this.root,
          timeout: timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        },
        (err, stdout, stderr) => {
          let code = 0;
          if (err) {
            code = typeof (err as any).code === "number" ? (err as any).code : 1;
          }
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
      if (input !== undefined) {
        child.stdin?.end(input);
      }
    });
  }

  available(): Promise<boolean> {
    if (!this.ready) {
      this.ready = this.init();
    }
    return this.ready;
  }

  private async init(): Promise<boolean> {
    if (!this.enabled) {
      this.disabledReason = "desactivadas en la configuración (snapshot: false)";
      return false;
    }
    const resolved = path.resolve(this.root);
    if (resolved === path.resolve(os.homedir()) || resolved === path.parse(resolved).root) {
      this.disabledReason = "la carpeta es demasiado grande (tu carpeta personal o la raíz)";
      return false;
    }
    const git = findProgram("git");
    const version = git !== null && (await new Promise<boolean>((resolve) => execFile(git, ["--version"], (err) => resolve(!err))));
    if (!version) {
      this.disabledReason = "git no está instalado";
      return false;
    }
    if (!fs.existsSync(path.join(this.gitDir, "HEAD"))) {
      fs.mkdirSync(this.gitDir, { recursive: true });
      const result = await this.git(["init", "--quiet"]);
      if (result.code !== 0) {
        this.disabledReason = `no se pudo crear el repositorio de instantáneas: ${result.stderr.trim()}`;
        return false;
      }
      fs.mkdirSync(path.join(this.gitDir, "info"), { recursive: true });
      fs.writeFileSync(path.join(this.gitDir, "info", "exclude"), `${DEFAULT_EXCLUDES.join("\n")}\n`);
      fs.writeFileSync(path.join(this.gitDir, "vipcode-root"), this.root);
    }
    return true;
  }

  // Guarda el estado actual de los ficheros; devuelve el id del árbol
  async track(): Promise<string | null> {
    if (!(await this.available())) {
      return null;
    }
    const add = await this.git(["add", "--all", "--", "."], 60000);
    if (add.code !== 0) {
      debugLog("snapshot add", add.stderr);
      if (/timed out|ETIMEDOUT/i.test(add.stderr) || add.code === 143) {
        this.disabledReason = "el proyecto es demasiado grande para hacer instantáneas rápido";
        this.ready = Promise.resolve(false);
      }
      return null;
    }
    const tree = await this.git(["write-tree"]);
    if (tree.code !== 0) {
      debugLog("snapshot write-tree", tree.stderr);
      return null;
    }
    return tree.stdout.trim();
  }

  // Ficheros que cambian entre dos instantáneas: A añadido, M modificado, D borrado
  async changes(from: string, to: string): Promise<{ status: string; file: string }[]> {
    const result = await this.git(["diff-tree", "-r", "--name-status", "--no-renames", "-z", from, to]);
    if (result.code !== 0) {
      return [];
    }
    const parts = result.stdout.split("\0").filter((part) => part.length > 0);
    const changes: { status: string; file: string }[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      changes.push({ status: parts[i], file: parts[i + 1] });
    }
    return changes;
  }

  // Deja los ficheros como estaban en la instantánea; devuelve los que han cambiado
  async restore(tree: string): Promise<string[]> {
    const current = await this.track();
    if (!current) {
      throw new Error(`No se pueden restaurar las instantáneas: ${this.disabledReason || "error de git"}`);
    }
    const changes = await this.changes(tree, current);
    if (changes.length === 0) {
      return [];
    }
    await this.apply(tree, changes);
    // Lo ignorado no se queda en las instantáneas siguientes
    await this.git(["read-tree", tree]);
    return changes.map((change) => change.file).filter((file) => !this.lastIgnored.has(file));
  }

  // /undo y /redo: deshace solo lo que cambió entre dos instantáneas (de «expected» a «target»), y solo en los ficheros que
  // siguen como los dejó «expected». Lo que ha cambiado después (lo has editado tú, o lo cambió algo que siguió en marcha)
  // no se toca: se devuelve en «kept» para decirlo. Volver todo el proyecto a «target» borraría tu trabajo
  async revert(target: string, expected: string): Promise<{ files: string[]; kept: string[] }> {
    const current = await this.track();
    if (!current) {
      throw new Error(`No se pueden restaurar las instantáneas: ${this.disabledReason || "error de git"}`);
    }
    const changes = await this.changes(target, expected);
    const since = new Set((await this.changes(expected, current)).map((change) => change.file));
    const apply = changes.filter((change) => !since.has(change.file));
    await this.apply(target, apply);
    // Lo que vuelve a estar ignorado (tu .env, si el modelo había tocado el .gitignore) no se queda en las instantáneas siguientes
    const ignoredNow = [...this.lastIgnored];
    for (let i = 0; i < ignoredNow.length; i += 200) {
      await this.git(["rm", "--cached", "--quiet", "--ignore-unmatch", "--", ...ignoredNow.slice(i, i + 200)]);
    }
    return {
      files: apply.map((change) => change.file).filter((file) => !this.lastIgnored.has(file)),
      kept: changes.filter((change) => since.has(change.file)).map((change) => change.file),
    };
  }

  // Los ficheros nuevos que la última vuelta atrás no ha borrado porque las reglas de ahora los ignoran (tu .env, tus datos)
  private lastIgnored = new Set<string>();

  // Pone estos ficheros como están en «tree»: los que no existen allí (A) se borran y los demás se sacan de ella
  private async apply(tree: string, changes: { status: string; file: string }[]) {
    this.lastIgnored = new Set();
    if (changes.length === 0) {
      return;
    }
    const remove = (file: string) => {
      const abs = path.join(this.root, file);
      fs.rmSync(abs, { force: true });
      this.removeEmptyParents(path.dirname(abs));
    };
    const added = changes.filter((change) => change.status === "A").map((change) => change.file);
    // Primero el .gitignore tal como estaba: lo que aparece como nuevo puede ser solo lo que ignoraba, si el modelo lo ha
    // reescrito. Eso no es de esta tarea (tu .env, tus datos) y no está en la instantánea: borrarlo sería perderlo
    for (const file of added.filter((name) => path.basename(name) === ".gitignore")) {
      remove(file);
    }
    const toCheckout = changes.filter((change) => change.status !== "A").map((change) => change.file);
    // De 200 en 200 para no pasarnos del límite de argumentos
    for (let i = 0; i < toCheckout.length; i += 200) {
      const result = await this.git(["checkout", tree, "--", ...toCheckout.slice(i, i + 200)]);
      if (result.code !== 0) {
        throw new Error(`git checkout falló: ${result.stderr.trim()}`);
      }
    }
    const ignored = await this.ignored(added.filter((name) => path.basename(name) !== ".gitignore"));
    for (const file of added) {
      if (path.basename(file) !== ".gitignore" && !ignored.has(file)) {
        remove(file);
      }
    }
    this.lastIgnored = ignored;
  }

  // Cuáles de estos ficheros ignoran las reglas de ahora
  private async ignored(files: string[]): Promise<Set<string>> {
    if (files.length === 0) {
      return new Set();
    }
    const result = await this.git(["check-ignore", "--no-index", "--stdin", "-z"], 30000, `${files.join("\0")}\0`);
    // 0: alguno lo está; 1: ninguno. Con cualquier otra cosa no se puede saber: mejor no borrar nada
    if (result.code !== 0 && result.code !== 1) {
      debugLog("snapshot check-ignore", result.stderr);
      return new Set(files);
    }
    return new Set(result.stdout.split("\0").filter(Boolean));
  }

  private removeEmptyParents(dir: string) {
    let current = dir;
    while (current.startsWith(this.root + path.sep)) {
      try {
        if (fs.readdirSync(current).length > 0) {
          return;
        }
        fs.rmdirSync(current);
      } catch {
        return;
      }
      current = path.dirname(current);
    }
  }

  // Diff entre una instantánea y otra (o el estado actual)
  async diff(from: string, to?: string): Promise<string> {
    let target = to;
    if (!target) {
      target = (await this.track()) || undefined;
    }
    if (!target) {
      return "";
    }
    const result = await this.git(["diff", "--no-color", "--no-ext-diff", "--stat", "--patch", from, target]);
    return result.stdout;
  }

  // Limpia objetos viejos de vez en cuando para que no crezca sin fin
  async cleanup() {
    if (!(await this.available())) {
      return;
    }
    const stamp = path.join(this.gitDir, "vipcode-gc");
    try {
      if (Date.now() - fs.statSync(stamp).mtimeMs < 24 * 60 * 60 * 1000) {
        return;
      }
    } catch {
      // primera vez
    }
    fs.writeFileSync(stamp, String(Date.now()));
    await this.git(["gc", "--quiet", "--prune=7.days.ago"], 120000);
  }
}
