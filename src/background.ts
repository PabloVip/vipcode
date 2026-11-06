// Copyright (C) 2026 Pablo Vicente Juan
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { killTree, spawnGroup } from "./process.js";
import { decodeClixml } from "./shell.js";

// Comandos que siguen en marcha mientras el agente hace otras cosas (unas pruebas largas, un build grande). Se
// aprueban igual que cualquier otro comando, puedes verlos y pararlos con /procesos y se paran todos al cerrar vipcode

// Los que pueden estar en marcha a la vez, y lo último que se guarda de lo que escribe cada uno (un comando puede escribir
// sin parar, y esto se queda en memoria)
export const MAX_RUNNING = 5;
const MAX_KEPT = 200000;
// Los que ya han terminado que se recuerdan, para poder ver cómo acabaron
const MAX_FINISHED = 20;

export interface BackgroundJob {
  id: string;
  command: string;
  // La carpeta, si no es la raíz del proyecto
  workdir?: string;
  started: number;
  // Cuándo terminó, con qué código y si lo paró alguien
  finished: number | null;
  code: number | null;
  stopped: boolean;
  child: ChildProcessByStdio<null, Readable, Readable>;
  // Lo último que ha escrito, cuánto se ha perdido por delante y hasta dónde lo ha leído ya el agente
  buffer: string;
  dropped: number;
  read: number;
  waiters: Set<() => void>;
}

export interface StartOptions {
  command: string;
  workdir?: string;
  cwd: string;
  file: string;
  args: string[];
  env: Record<string, string | undefined>;
  // Si se le ha puesto un límite, se para al llegar
  timeoutMs?: number;
}

const jobs = new Map<string, BackgroundJob>();
let counter = 0;
export function runningJobs(): BackgroundJob[] {
  return [...jobs.values()].filter((job) => job.finished === null);
}

export function allJobs(): BackgroundJob[] {
  return [...jobs.values()];
}

export function findJob(id: string): BackgroundJob | undefined {
  return jobs.get(id);
}

function wake(job: BackgroundJob) {
  for (const waiter of job.waiters) {
    waiter();
  }
}

function forgetOldJobs() {
  const finished = allJobs().filter((job) => job.finished !== null);
  for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) {
    jobs.delete(job.id);
  }
}

// Lo lanza en su propio grupo de procesos, para poder pararlo con todo lo que lance. Quien llama ya ha pedido permiso
export function startJob(options: StartOptions): BackgroundJob {
  const child = spawnGroup(options.file, options.args, { cwd: options.cwd, env: options.env, windowsHide: true });
  const job: BackgroundJob = {
    id: `bg${++counter}`,
    command: options.command,
    workdir: options.workdir,
    started: Date.now(),
    finished: null,
    code: null,
    stopped: false,
    child,
    buffer: "",
    dropped: 0,
    read: 0,
    waiters: new Set(),
  };
  jobs.set(job.id, job);
  let timer: NodeJS.Timeout | null = null;
  if (options.timeoutMs) {
    timer = setTimeout(() => {
      job.stopped = true;
      killTree(child);
    }, options.timeoutMs);
    timer.unref();
  }
  // Como texto: así una letra de varios bytes (ñ, á, €) no se rompe si llega partida entre dos trozos
  const add = (text: string) => {
    job.buffer += text;
    if (job.buffer.length > MAX_KEPT) {
      job.dropped += job.buffer.length - MAX_KEPT;
      job.buffer = job.buffer.slice(-MAX_KEPT);
    }
    wake(job);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", add);
  child.stderr.on("data", add);
  const finish = (code: number | null) => {
    if (job.finished !== null) {
      return;
    }
    job.finished = Date.now();
    job.code = code;
    if (timer) {
      clearTimeout(timer);
    }
    wake(job);
    forgetOldJobs();
  };
  child.on("error", (err) => {
    add(`No se pudo ejecutar: ${err.message}\n`);
    finish(null);
  });
  // «close» y no «exit»: mientras quede algo vivo de lo que lanzó con su salida abierta, sigue en marcha (y se puede parar)
  child.on("close", (code) => finish(code));
  return job;
}

// Lo que ha escrito desde la última vez que se miró, sin los colores de la terminal
export function readJob(job: BackgroundJob): string {
  const from = Math.max(0, job.read - job.dropped);
  const lost = Math.max(0, job.dropped - job.read);
  const text = decodeClixml(job.buffer.slice(from)).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  job.read = job.dropped + job.buffer.length;
  return lost > 0 ? `[… ${lost} caracteres perdidos: escribe más deprisa de lo que se ha mirado …]\n${text}` : text;
}

// Espera a que termine o, con «news», a que escriba algo; como mucho «ms», y lo que dure Esc
export function waitForJob(job: BackgroundJob, ms: number, signal: AbortSignal | undefined, news: boolean): Promise<void> {
  const hasNews = () => news && job.dropped + job.buffer.length > job.read;
  if (job.finished !== null || hasNews() || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settle: NodeJS.Timeout | null = null;
    const done = () => {
      clearTimeout(timer);
      if (settle) {
        clearTimeout(settle);
      }
      job.waiters.delete(check);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const check = () => {
      if (job.finished !== null) {
        done();
      } else if (hasNews() && !settle) {
        // Un momento más: lo normal es que lo que escribe venga en varios trozos seguidos
        settle = setTimeout(done, 200);
      }
    };
    const timer = setTimeout(done, ms);
    job.waiters.add(check);
    signal?.addEventListener("abort", done, { once: true });
  });
}

// Lo para con todo lo que haya lanzado y espera a que termine (killTree lo hace a la fuerza a los 3 s)
export async function stopJob(job: BackgroundJob): Promise<void> {
  if (job.finished !== null) {
    return;
  }
  job.stopped = true;
  // (en Windows, si acaba de arrancar, killTree le da tiempo a lanzar su programa antes de pararlo)
  await killTree(job.child);
  await waitForJob(job, 500, undefined, false);
  // Algo que no se ha podido parar sigue con su salida abierta: para vipcode, este ya ha terminado
  if (job.finished === null) {
    job.finished = Date.now();
    job.child.stdout.destroy();
    job.child.stderr.destroy();
    wake(job);
  }
}

export async function stopAllJobs(): Promise<void> {
  await Promise.allSettled(runningJobs().map((job) => stopJob(job)));
}

function elapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// En qué está: «en marcha desde hace 3 min», «terminó con código 1», «parado»
export function jobState(job: BackgroundJob): string {
  if (job.finished === null) {
    return `en marcha desde hace ${elapsed(Date.now() - job.started)}`;
  }
  if (job.stopped) {
    return "parado";
  }
  return `terminó con código ${job.code ?? "desconocido"}`;
}
