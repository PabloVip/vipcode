// El diálogo de permiso con las teclas llegando juntas, como pasa en un ordenador cargado o por SSH: Enter elige la opción a
// la que se ha bajado, lo que se escribe entero vale («no», «sí») y una respuesta solo cuenta una vez. Antes, ↓↓↓ y Enter en
// un mismo trozo aprobaban un comando que habías rechazado
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { render } from "ink";
import React from "react";

// Carpeta de datos temporal para no tocar ~/.vipcode (los módulos la leen al cargarse)
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vipcode-dialogos-"));
process.env.VIPCODE_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { PermissionDialog } = await import("../dist/tui/dialogs.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DOWN = "\x1b[B";

// Pinta el diálogo, le manda cada trozo tal cual (todo lo que va en un trozo llega junto) y devuelve lo que ha contestado
async function answers(chunks) {
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const stdout = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  Object.assign(stdout, { columns: 100, rows: 40, isTTY: true });
  const replies = [];
  const request = { kind: "bash", title: "Ejecutar un comando", subject: "touch marca.txt", preview: "touch marca.txt" };
  const app = render(React.createElement(PermissionDialog, { request, agent: "programar", onDone: (choice) => replies.push(choice) }), {
    stdin,
    stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await sleep(100);
  for (const chunk of chunks) {
    stdin.write(chunk);
    await sleep(100);
  }
  await sleep(150);
  app.unmount();
  return replies;
}

test("permiso: ↓↓↓ y Enter llegando juntos eligen «No», igual que tecla a tecla", async () => {
  for (const chunks of [[DOWN + DOWN + DOWN + "\r"], [DOWN, DOWN, DOWN, "\r"]]) {
    const replies = await answers(chunks);
    assert.equal(replies.length, 1, JSON.stringify(chunks));
    assert.equal(replies[0].reply.allow, false, JSON.stringify(chunks));
  }
  // ↓ y Enter juntos: la segunda opción («Sí, y no preguntar más por comandos»), no la primera
  const replies = await answers([DOWN + "\r"]);
  assert.deepEqual([replies[0].reply.allow, replies[0].grant], [true, "kind"]);
});

test("permiso: lo escrito entero vale, y un texto que no es ninguna opción no aprueba nada", async () => {
  for (const [typed, allow] of [
    ["no\r", false],
    ["n\r", false],
    ["sí\r", true],
    ["si\r", true],
    ["y\r", true],
    ["s", true],
    ["\x1b", false],
  ]) {
    const replies = await answers([typed]);
    assert.equal(replies.length, 1, JSON.stringify(typed));
    assert.equal(replies[0].reply.allow, allow, JSON.stringify(typed));
  }
  // Antes, «xyz» + Enter aprobaba la opción marcada (Sí)
  assert.deepEqual(await answers(["xyz\r"]), []);
});

test("permiso: nunca más de una respuesta aunque lleguen varias teclas detrás, y «e» deja explicar qué hacer", async () => {
  // Varios Enter de golpe (Ink los da como un solo texto): como mucho una respuesta. Ahora mismo, ninguna, que es lo seguro
  for (const chunks of [["\r\r\r"], ["s", "\r", "n"], ["n" + "\r" + "s"]]) {
    const replies = await answers(chunks);
    assert.ok(replies.length <= 1, `${JSON.stringify(chunks)}: ${replies.length} respuestas`);
  }
  const explained = await answers(["e", "usa npm test\r"]);
  assert.equal(explained.length, 1);
  assert.deepEqual(explained[0].reply, { allow: false, feedback: "usa npm test" });
});
