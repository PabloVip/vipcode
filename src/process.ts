// Copyright (C) 2026 Pablo Vicente Juan
// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ChildProcess, type ChildProcessByStdio, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import type { Readable } from "node:stream";
import { system32 } from "./shell.js";

// Los comandos que lanza vipcode: cómo se paran con todo lo que hayan lanzado, cómo se espera a que terminen sin quedarse
// colgado y el registro de los que siguen vivos, para que al salir no quede ninguno

// Lo que se le da a un comando para parar por las buenas (SIGTERM) antes de pararlo a la fuerza, y lo que se le espera a que
// cierre su salida cuando ya ha terminado
const KILL_GRACE_MS = 2000;
const CLOSE_GRACE_MS = 2000;

const alive = new Set<ChildProcess>();
const stopping = new Map<ChildProcess, Promise<void>>();
let hooked = false;
let onInterrupt: (() => void) | null = null;

const EXIT_SIGNALS = ["SIGHUP", "SIGTERM", "SIGINT"] as const;

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function stopTree(child: ChildProcess) {
  if (!child.pid) {
    child.kill();
    return;
  }
  // En Windows no hay grupos de procesos: taskkill /T recorre los hijos
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const taskkill = spawn(system32("taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      taskkill.on("error", () => {
        child.kill();
        resolve();
      });
      taskkill.on("close", () => resolve());
    });
    return;
  }
  // En macOS y Linux, su grupo de procesos (si se lanzó con spawnGroup; si no, solo él)
  let group = true;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    group = false;
    child.kill("SIGTERM");
  }
  const running = () => (group ? groupAlive(child.pid!) : child.exitCode === null && child.signalCode === null);
  const deadline = Date.now() + KILL_GRACE_MS;
  while (running() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (running()) {
    try {
      if (group) {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      // acaba de terminar
    }
  }
}

// Para un programa y todo lo que haya lanzado. Termina cuando ya no queda nada, pero nadie tiene que esperarlo para seguir
export function killTree(child: ChildProcess): Promise<void> {
  const already = stopping.get(child);
  if (already) {
    return already;
  }
  const done = stopTree(child).finally(() => {
    stopping.delete(child);
    alive.delete(child);
  });
  stopping.set(child, done);
  return done;
}

// Igual, pero ya, sin esperar a nada: para cuando vipcode se está cerrando y no va a quedar quien lo termine
export function killTreeNow(child: ChildProcess) {
  if (!child.pid) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync(system32("taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // ya había terminado
  }
}

// Para todos los que siguen vivos, por las buenas (/exit, Ctrl+C dos veces)
export async function stopAllProcesses(): Promise<void> {
  await Promise.allSettled([...alive].map((child) => killTree(child)));
}

function killAllNow() {
  for (const child of alive) {
    killTreeNow(child);
  }
  alive.clear();
}

// Si cierras la ventana de la terminal (o alguien para vipcode), se paran también los comandos que estén en marcha. Después
// la señal hace lo de siempre: sin este oyente, cerrar vipcode, o lo que hagan los demás (Ink deja la terminal como estaba)
function onExitSignal(signal: NodeJS.Signals) {
  if (signal === "SIGINT" && onInterrupt) {
    onInterrupt();
    return;
  }
  killAllNow();
  unhookExit();
  process.kill(process.pid, signal);
}

function hookExit() {
  if (hooked) {
    return;
  }
  hooked = true;
  process.on("exit", killAllNow);
  for (const name of EXIT_SIGNALS) {
    process.on(name, onExitSignal);
  }
}

function unhookExit() {
  hooked = false;
  process.removeListener("exit", killAllNow);
  for (const name of EXIT_SIGNALS) {
    process.removeListener(name, onExitSignal);
  }
}

// vipcode run: el primer Ctrl+C cancela en vez de cerrar
export function setInterruptHandler(handler: () => void) {
  onInterrupt = handler;
  hookExit();
}

// Lanza un comando de la shell en su propio grupo de procesos (en macOS y Linux), para poder pararlo con todo lo que lance
// (npm test, un servidor…) con killTree. Se apunta en el registro: se para al cerrarse vipcode. Sin entrada, y su salida se
// lee por stdout y stderr
export function spawnGroup(file: string, args: string[], options: Omit<SpawnOptions, "stdio" | "detached">): ChildProcessByStdio<null, Readable, Readable> {
  const child = spawn(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  hookExit();
  alive.add(child);
  const forget = () => {
    // Si se está parando, sigue en el registro hasta que lo hayan parado del todo: su salida puede cerrarse antes
    if (!stopping.has(child)) {
      alive.delete(child);
    }
  };
  child.once("close", forget);
  child.once("error", forget);
  return child;
}

export interface WatchOptions {
  // Se para al llegar a este tiempo
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
  // Si lleva este tiempo sin escribir nada y «isIdle» dice que su salida es la de algo que ya no va a terminar, se para
  idleMs?: number;
  isIdle?: (output: string) => boolean;
}

export interface WatchResult {
  code: number | null;
  // Por qué se ha parado («null»: ha terminado solo)
  reason: "abort" | "timeout" | "idle" | null;
  output: string;
  // No se ha podido lanzar
  error?: string;
  // Ha terminado, pero dejó algo en marcha con su salida abierta, y se ha parado
  lingering: boolean;
}

// Espera a un comando sin quedarse nunca colgado. Lo normal es esperar a «close», pero «close» no llega mientras algo tenga
// abierta su salida, y un programa nieto que sobrevive (en Windows taskkill no siempre los alcanza) la tiene abierta para
// siempre. Por eso cancelar o pasarse de tiempo no espera a nada: se manda parar y se contesta ya con lo que haya
export function watchChild(child: ChildProcessByStdio<null, Readable, Readable>, options: WatchOptions): Promise<WatchResult> {
  return new Promise((resolve) => {
    let output = "";
    let lastOutput = Date.now();
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let idle: NodeJS.Timeout | undefined;
    let closing: NodeJS.Timeout | undefined;
    const finish = (result: Omit<WatchResult, "output" | "lingering"> & { lingering?: boolean }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(idle);
      clearTimeout(closing);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      // Sin esto, lo que siga con esa salida abierta no dejaría terminar a vipcode
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ output, lingering: false, ...result });
    };
    const stop = (reason: "abort" | "timeout" | "idle") => {
      void killTree(child);
      finish({ code: null, reason });
    };
    const onAbort = () => stop("abort");
    // Como texto: así una letra de varios bytes (ñ, á, €) no se rompe si llega partida entre dos trozos
    const onData = (text: string) => {
      lastOutput = Date.now();
      output += text;
      if (output.length > 5000000) {
        output = output.slice(-2000000);
      }
      options.onOutput?.(text);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => finish({ code: null, reason: null, error: err.message }));
    child.on("close", (code) => finish({ code, reason: null }));
    // Ya ha terminado, pero algo que dejó lanzado sigue con su salida: no se le espera, y no se queda ahí
    child.on("exit", (code) => {
      if (settled) {
        return;
      }
      closing = setTimeout(() => {
        void killTree(child);
        finish({ code, reason: null, lingering: true });
      }, CLOSE_GRACE_MS);
    });
    timeout = setTimeout(() => stop("timeout"), options.timeoutMs);
    if (options.idleMs && options.isIdle) {
      const { idleMs, isIdle } = options;
      idle = setInterval(() => {
        if (Date.now() - lastOutput >= idleMs && isIdle(output)) {
          stop("idle");
        }
      }, Math.min(1000, idleMs));
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }
  });
}
