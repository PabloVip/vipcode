import { createRequire } from "node:module";

// La versión sale de package.json, para que al publicar solo haya que cambiarla allí
const require = createRequire(import.meta.url);
export const VERSION: string = require("../package.json").version;
export const REPO_URL = "https://github.com/PabloVip/vipcode";
// Lo que pide la licencia AGPL que se vea en la interfaz (en /help y en vipcode --help): de quién es, que no tiene
// garantía y con qué licencia se puede usar
export const LEGAL_NOTICE = `vipcode ${VERSION} · © 2026 Pablo Vicente Juan · licencia AGPL-3.0 o posterior, sin ninguna garantía · ${REPO_URL}`;
// Nombre del paquete en npm
export const PACKAGE_NAME = "vipcode";
