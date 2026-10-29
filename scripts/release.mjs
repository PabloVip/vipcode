#!/usr/bin/env node
// Publica una versión nueva de vipcode: sube el número, pasa las pruebas, crea el commit y la etiqueta,
// lo sube a GitHub, crea la release con el paquete ya compilado y lo publica en npm.
//
//   npm run release -- 0.3.0             (o patch, minor, major)
//   npm run release -- 0.3.0 --dry-run   solo comprueba y enseña lo que haría
//
// Necesita la sesión iniciada en npm (npm login) y en GitHub (gh auth login).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const wanted = args.find((arg) => !arg.startsWith("--"));

function run(command, commandArgs, { show = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    stdio: show ? "inherit" : "pipe",
    shell: process.platform === "win32",
  });
  return { ok: result.status === 0, out: `${result.stdout || ""}${result.stderr || ""}`.trim() };
}

function fail(text) {
  console.error(`\n✖ ${text}`);
  process.exit(1);
}

function step(text) {
  console.log(`\n▸ ${text}`);
}

// Ejecuta un paso que cambia algo (en --dry-run solo lo enseña)
function act(text, command, commandArgs, options) {
  step(text);
  if (dryRun) {
    console.log(`  (simulación) ${command} ${commandArgs.join(" ")}`);
    return;
  }
  const result = run(command, commandArgs, { show: true, ...options });
  if (!result.ok) {
    fail(`Ha fallado: ${command} ${commandArgs.join(" ")}`);
  }
}

function nextVersion(current, request) {
  const [major, minor, patch] = current.split(".").map(Number);
  if (request === "patch") {
    return `${major}.${minor}.${patch + 1}`;
  }
  if (request === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  if (request === "major") {
    return `${major + 1}.0.0`;
  }
  if (/^\d+\.\d+\.\d+$/.test(request)) {
    return request;
  }
  fail(`«${request}» no es una versión: usa algo como 0.3.0, o patch, minor o major.`);
}

if (!wanted) {
  fail("Uso: npm run release -- <versión | patch | minor | major> [--dry-run]");
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const current = pkg.version;
const next = nextVersion(current, wanted);
const tag = `v${next}`;
console.log(`vipcode ${current} → ${next}${dryRun ? " (simulación: no se cambia ni se publica nada)" : ""}`);

// 1. Comprobaciones antes de tocar nada
step("Comprobando que todo está en orden");
if (run("git", ["status", "--porcelain"]).out !== "") {
  fail("Hay cambios sin guardar: haz commit (o descártalos) antes de publicar.");
}
const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).out;
if (branch !== "main") {
  fail(`Estás en la rama «${branch}»: las versiones se publican desde main.`);
}
if (!run("git", ["fetch", "--quiet", "origin"]).ok) {
  fail("No he podido conectar con GitHub (git fetch).");
}
if (run("git", ["rev-list", "--count", "HEAD..origin/main"]).out !== "0") {
  fail("GitHub tiene cambios que tú no: haz git pull antes de publicar.");
}
if (run("git", ["tag", "-l", tag]).out !== "" || run("git", ["ls-remote", "--tags", "origin", tag]).out !== "") {
  fail(`La etiqueta ${tag} ya existe: elige otra versión.`);
}
const published = run("npm", ["view", pkg.name, "version"]);
if (published.ok && published.out) {
  const [a, b] = [published.out, next].map((version) => version.split(".").map(Number));
  const newer = b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
  if (newer <= 0) {
    fail(`En npm ya está la ${published.out}: la nueva tiene que ser mayor.`);
  }
}
const problems = [];
if (!run("npm", ["whoami"]).ok) {
  problems.push("No tienes la sesión iniciada en npm: ejecuta «npm login».");
}
if (!run("gh", ["auth", "status"]).ok) {
  problems.push("No tienes la sesión iniciada en GitHub: ejecuta «gh auth login».");
}
if (problems.length > 0) {
  if (!dryRun) {
    fail(problems.join("\n  "));
  }
  for (const problem of problems) {
    console.log(`  ⚠ ${problem}`);
  }
} else {
  console.log("  ✓ todo listo");
}

// 2. Número de versión (package.json y package-lock.json)
if (next !== current) {
  act(`Subiendo la versión a ${next}`, "npm", ["version", next, "--no-git-tag-version"]);
}

// 3. Pruebas (también compila dist/)
if (dryRun) {
  step("Pruebas: en la simulación no se pasan (npm test)");
} else {
  act("Pasando las pruebas", "npm", ["test"]);
}

// 4. Commit y etiqueta
if (next !== current) {
  act("Guardando el cambio de versión", "git", ["commit", "-q", "-am", `vipcode ${next}`]);
}
act(`Creando la etiqueta ${tag}`, "git", ["tag", "-a", tag, "-m", `vipcode ${next}`]);

// 5. Subir a GitHub
act("Subiendo a GitHub", "git", ["push", "--quiet", "origin", "main", "--follow-tags"]);

// 6. Release de GitHub con el paquete compilado (vipcode.tgz siempre apunta a la última)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-release-"));
step("Preparando el paquete");
const pack = run("npm", ["pack", ...(dryRun ? ["--dry-run"] : []), "--pack-destination", dir]);
if (!pack.ok) {
  fail(`npm pack ha fallado:\n${pack.out}`);
}
if (dryRun) {
  console.log(pack.out.split("\n").filter((line) => /npm notice (\d|package size|total files)/.test(line)).join("\n"));
} else {
  fs.copyFileSync(path.join(dir, `${pkg.name}-${next}.tgz`), path.join(dir, "vipcode.tgz"));
}
act(`Creando la release ${tag} en GitHub`, "gh", [
  "release",
  "create",
  tag,
  "--verify-tag",
  "--title",
  `vipcode ${next}`,
  "--generate-notes",
  path.join(dir, "vipcode.tgz"),
  path.join(dir, `${pkg.name}-${next}.tgz`),
]);

// 7. npm (puede pedirte el código de verificación en dos pasos)
step("Publicando en npm");
if (dryRun) {
  console.log("  (simulación) npm publish");
} else if (!run("npm", ["publish"], { show: true }).ok) {
  fail(`La release de GitHub ya está creada, pero npm publish ha fallado. Arréglalo y vuelve a ejecutar solo «npm publish».`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ vipcode ${next} ${dryRun ? "se publicaría" : "publicado"}:`);
console.log(`  npm install -g vipcode`);
console.log(`  https://github.com/PabloVip/vipcode/releases/tag/${tag}`);
console.log(`  https://www.npmjs.com/package/vipcode`);
