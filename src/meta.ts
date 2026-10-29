import { createRequire } from "node:module";

// La versión sale de package.json, para que al publicar solo haya que cambiarla allí
const require = createRequire(import.meta.url);
export const VERSION: string = require("../package.json").version;
export const REPO_URL = "https://github.com/PabloVip/vipcode";
// Nombre del paquete en npm
export const PACKAGE_NAME = "vipcode";
