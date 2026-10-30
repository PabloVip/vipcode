// «Portapapeles» de las pruebas: guarda en el fichero que se le pasa lo que le llega por la entrada
import fs from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
fs.writeFileSync(process.argv[2], Buffer.concat(chunks));
