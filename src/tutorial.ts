import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// /tutorial y «vipcode tutorial»: cinco pasos para aprender lo básico en una carpeta de prácticas, sin tocar tus
// ficheros. Cada paso se da por hecho solo, cuando haces lo que pide

export interface TutorialEvent {
  // Un mensaje al agente, un !comando o un comando /
  kind: "message" | "shell" | "command";
  text: string;
  // El agente con el que se ha hecho
  agent: string;
}

export interface TutorialCard {
  // 1…total; total + 1 es el final
  step: number;
  total: number;
  title: string;
  text: string;
}

interface Step {
  title: string;
  text: string;
  done: (event: TutorialEvent) => boolean;
}

const STEPS: Step[] = [
  {
    title: "Pídele algo con tus palabras",
    text: "Escribe, por ejemplo: ¿qué hace saludo.js?\nvipcode lo lee y te lo explica.",
    done: (event) => event.kind === "message",
  },
  {
    title: "Señala un fichero con @",
    text: "Escribe «arregla el fallo de @sal», pulsa Tab para completar @saludo.js y luego Enter.\nAntes de cambiar el fichero te pedirá permiso: así ves qué va a tocar.",
    done: (event) => event.kind === "message" && event.text.includes("@saludo.js"),
  },
  {
    title: "Ejecuta un comando con !",
    text: "Escribe: !node saludo.js\nEl ! ejecuta el comando aquí mismo, y el agente verá lo que ha salido.",
    done: (event) => event.kind === "shell",
  },
  {
    title: "Deshaz con /undo",
    text: "Escribe: /undo\nvipcode deshace el último cambio: deja saludo.js como estaba y te devuelve tu mensaje a la caja de escritura, por si quieres cambiarlo (/redo lo vuelve a poner todo).",
    done: (event) => event.kind === "command" && /^\/undo\b/.test(event.text),
  },
  {
    title: "Aprende con el profe",
    text: "Borra el mensaje que ha vuelto a la caja de escritura (Ctrl+U lo borra de golpe), pulsa Tab hasta que abajo ponga «profe» y pregúntale: ¿cómo arreglo yo el fallo de saludo.js?\nEl profe te lo explica paso a paso para que lo hagas tú.",
    done: (event) => event.kind === "message" && event.agent === "profe",
  },
];

const END =
  "¡Ya sabes lo básico! /help enseña todo lo que hay y /tutorial lo repite.\nPara trabajar en tus cosas, sal con /exit y abre vipcode en la carpeta de tu proyecto.";

export function tutorialCard(index: number): TutorialCard {
  if (index >= STEPS.length) {
    return { step: STEPS.length + 1, total: STEPS.length, title: "Tutorial terminado", text: END };
  }
  return { step: index + 1, total: STEPS.length, title: STEPS[index].title, text: STEPS[index].text };
}

// ¿Lo que acaba de pasar completa el paso «index»?
export function tutorialDone(index: number, event: TutorialEvent): boolean {
  return index < STEPS.length && STEPS[index].done(event);
}

// Lo que se deja en la carpeta de prácticas: un programa con un fallo a propósito
const FILES: Record<string, string> = {
  "saludo.js": `// Saluda a cada persona de la lista
const personas = ["Ana", "Luis", "Marta"];

for (let i = 0; i <= personas.length; i++) {
  console.log("¡Hola, " + personas[i] + "!");
}
`,
  "LEEME.md": `# Carpeta de prácticas de vipcode

La ha creado \`vipcode tutorial\` para que aprendas sin tocar tus ficheros: cambia lo que quieras o bórrala cuando acabes.

\`saludo.js\` tiene un fallo a propósito: al ejecutarlo, también saluda a «undefined».
`,
};

// Así se sabe que una carpeta es de prácticas (y que se puede volver a preparar sin perder nada tuyo)
const MARKER = ".vipcode-tutorial";

export function isTutorialDir(dir: string): boolean {
  try {
    return fs.lstatSync(path.join(dir, MARKER)).isFile();
  } catch {
    return false;
  }
}

// ~/vipcode-tutorial con los ficheros del principio. Si ya hay una carpeta con ese nombre que no es de prácticas, no se
// toca: se usa ~/vipcode-tutorial-2, -3…
export function prepareTutorial(): string {
  for (let n = 1; n < 100; n++) {
    const dir = path.join(os.homedir(), n === 1 ? "vipcode-tutorial" : `vipcode-tutorial-${n}`);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      // no existe: se crea
    }
    if (stat && (!stat.isDirectory() || !isTutorialDir(dir))) {
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries({ [MARKER]: "Carpeta de prácticas de vipcode tutorial\n", ...FILES })) {
      // Antes se quita lo que haya (si fuera un enlace, se quita el enlace: nunca se escribe al otro lado)
      const file = path.join(dir, name);
      fs.rmSync(file, { force: true, recursive: true });
      fs.writeFileSync(file, text);
    }
    return dir;
  }
  throw new Error("No he podido preparar la carpeta de prácticas en tu carpeta personal.");
}
