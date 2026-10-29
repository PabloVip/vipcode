// Vuelve a hacer la animación del README (docs/demo.svg) con una sesión real de vipcode y los modelos gratis sin clave:
//   npm run demo
// Necesita python3 (macOS o Linux). Todo pasa en una carpeta temporal: no toca ~/.vipcode ni el proyecto.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { castToSvg } from "./svg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
// Con la ruta real: en macOS la carpeta temporal es un enlace (/var → /private/var) y, si HOME y la carpeta del
// proyecto no se escriben igual, vipcode no la reconoce como tu carpeta personal y enseña la ruta entera
const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vipcode-demo-"));
// La carpeta personal de la sesión: así la ventana enseña ~/tienda
const home = path.join(work, "home");
const project = path.join(home, "tienda");
fs.mkdirSync(path.join(home, ".vipcode"), { recursive: true });
fs.mkdirSync(project);
// Sin buscar modelos ni versiones nuevas, y con la bienvenida ya vista
fs.writeFileSync(path.join(home, ".vipcode", "config.json"), JSON.stringify({ autoUpdateModels: false, checkUpdates: false }));
fs.writeFileSync(path.join(home, ".vipcode", "notices.json"), JSON.stringify({ privacy: new Date().toISOString() }));
// El proyecto de ejemplo: el descuento es un porcentaje, pero se resta tal cual
const BUG = "return suma - descuento;";
fs.writeFileSync(
  path.join(project, "carrito.js"),
  `// Precio final de un carrito con su descuento
export function total(productos, descuento) {
  let suma = 0;
  for (const producto of productos) {
    suma += producto.precio * producto.cantidad;
  }
  // descuento es un porcentaje: 10 significa un 10 %
  ${BUG}
}
`,
);
fs.writeFileSync(path.join(project, "package.json"), `${JSON.stringify({ name: "tienda", type: "module" }, null, 2)}\n`);

try {
  const cast = path.join(work, "demo.cast");
  const record = spawnSync("python3", ["-I", path.join(here, "grabar.py"), path.join(root, "dist", "index.js"), home, project, cast], { stdio: "inherit" });
  if (record.status !== 0) {
    throw new Error("La grabación ha fallado (mira el mensaje de arriba). Vuelve a probar: los modelos gratis a veces tardan o fallan.");
  }
  if (fs.readFileSync(path.join(project, "carrito.js"), "utf8").includes(BUG)) {
    throw new Error("El modelo no ha arreglado el fallo esta vez: vuelve a probar.");
  }
  const { svg, frames, seconds } = await castToSvg(cast);
  fs.writeFileSync(path.join(root, "docs", "demo.svg"), svg);
  console.log(`docs/demo.svg: ${frames} fotogramas, ${seconds.toFixed(1)} s, ${Math.round(svg.length / 1024)} KB`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
