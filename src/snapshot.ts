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

  private git(args: string[], timeoutMs = 30000): Promise<GitResult> {
    return new Promise((resolve) => {
      execFile(
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
    const toCheckout: string[] = [];
    for (const change of changes) {
      if (change.status === "A") {
        // No existía en la instantánea: se borra
        const abs = path.join(this.root, change.file);
        fs.rmSync(abs, { force: true });
        this.removeEmptyParents(path.dirname(abs));
      } else {
        toCheckout.push(change.file);
      }
    }
    // De 200 en 200 para no pasarnos del límite de argumentos
    for (let i = 0; i < toCheckout.length; i += 200) {
      const result = await this.git(["checkout", tree, "--", ...toCheckout.slice(i, i + 200)]);
      if (result.code !== 0) {
        throw new Error(`git checkout falló: ${result.stderr.trim()}`);
      }
    }
    return changes.map((change) => change.file);
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
