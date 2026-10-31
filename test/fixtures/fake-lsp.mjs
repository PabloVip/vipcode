// Servidor de lenguaje de mentira para las pruebas. Apunta su número de proceso en el fichero que diga FAKE_LSP_PIDS y
// hace lo que diga FAKE_LSP_MODE: «cae» publica un error que dice su número de proceso y enseguida se cierra (como uno
// que se queda sin memoria); «falla» contesta con un error al arrancar y se queda esperando
import fs from "node:fs";

const mode = process.env.FAKE_LSP_MODE || "cae";
if (process.env.FAKE_LSP_PIDS) {
  fs.appendFileSync(process.env.FAKE_LSP_PIDS, `${process.pid}\n`);
}

const send = (message) => {
  const text = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
};

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) {
      return;
    }
    const size = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + size) {
      return;
    }
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString());
    buffer = buffer.subarray(end + 4 + size);
    if (message.method === "initialize") {
      if (mode === "falla") {
        send({ id: message.id, error: { code: -32603, message: "no arranco" } });
      } else {
        send({ id: message.id, result: { capabilities: {} } });
      }
    } else if (message.method === "shutdown") {
      send({ id: message.id, result: null });
    } else if (message.method === "exit") {
      process.exit(0);
    } else if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
      const uri = message.params.textDocument.uri;
      const diagnostic = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: `fallo del proceso ${process.pid}` };
      send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [diagnostic] } });
      setTimeout(() => process.exit(1), 100);
    }
  }
});
