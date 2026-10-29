// Navegador falso para las pruebas. Con VIPCODE_TEST_BROWSER_LOG solo apunta la dirección;
// si no, la abre y sigue las redirecciones, como haría el navegador al volver del inicio de sesión
import fs from "node:fs";

const url = process.argv[process.argv.length - 1];
if (process.env.VIPCODE_TEST_BROWSER_LOG) {
  fs.appendFileSync(process.env.VIPCODE_TEST_BROWSER_LOG, `${url}\n`);
} else {
  const response = await fetch(url);
  await response.text();
}
