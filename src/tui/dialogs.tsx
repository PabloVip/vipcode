// Copyright (C) 2026 Pablo Vicente Juan
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Box, Text, useInput, usePaste } from "ink";
import React, { useMemo, useRef, useState } from "react";
import type { SelectItem } from "../app.js";
import { type PermissionReply, type PermissionRequest, suggestPattern } from "../permissions.js";
import { showControl, stripControl } from "../sanitize.js";
import { colorPreview } from "../ui.js";
import { type EditorState, EMPTY, backspace, deleteWordBack, insert, moveLeft, moveRight, previousBoundary, splitAtCursor, splitEnter } from "./editor.js";
import { look } from "./theme.js";

const KIND_LABEL: Record<string, string> = {
  write: "ediciones de ficheros",
  bash: "comandos",
  web: "accesos a internet",
  mcp: "herramientas MCP",
  secrets: "ficheros con secretos",
};

interface Option {
  key: string;
  label: string;
}

// Respuestas escritas enteras en el diálogo de permiso: la letra de su opción
const ANSWER_WORDS: Record<string, string> = { no: "n", si: "s", sí: "s", y: "s", yes: "s" };

export type PermissionChoice = { reply: PermissionReply; grant?: "kind" | "pattern"; pattern?: string };

// Un valor que está siempre al día aunque lleguen varias teclas antes de volver a pintar (al escribir rápido, o en un ordenador
// lento): con el de React cada tecla partiría de lo último que se pintó, y se perderían las anteriores
function useLatest<T>(initial: T): [T, React.MutableRefObject<T>, (change: (current: T) => T) => void] {
  const [value, setValue] = useState(initial);
  const latest = useRef(value);
  const update = (change: (current: T) => T) => {
    latest.current = change(latest.current);
    setValue(latest.current);
  };
  return [value, latest, update];
}

// Varias teclas que han llegado juntas: se aplican en orden. Un borrado no es una letra
export function applyTyped<T>(state: T, input: string, onBackspace: (state: T) => T, onText: (state: T, text: string) => T): T {
  let next = state;
  let text = "";
  for (const letter of input) {
    if (letter === "\x7f" || letter === "\b") {
      if (text) {
        next = onText(next, text);
        text = "";
      }
      next = onBackspace(next);
    } else if (letter >= " " || letter === "\n") {
      text += letter;
    }
  }
  return text ? onText(next, text) : next;
}

// Pregunta antes de editar, ejecutar o salir a internet, enseñando el diff o el comando
export function PermissionDialog(props: { request: PermissionRequest; agent: string; onDone: (choice: PermissionChoice) => void }) {
  const { request } = props;
  const pattern = request.kind === "bash" ? suggestPattern(request.subject) : "";
  const options: Option[] = [{ key: "s", label: "Sí" }];
  options.push({ key: "t", label: `Sí, y no preguntar más por ${KIND_LABEL[request.kind] || "esto"} en esta sesión` });
  if (pattern) {
    const where = request.workdir ? ` en ${stripControl(request.workdir)}` : "";
    options.push({ key: "p", label: `Sí, y permitir siempre «${pattern}»${where} en esta sesión` });
  }
  options.push({ key: "n", label: "No" });
  options.push({ key: "e", label: "No, y decirle qué hacer en su lugar" });

  // La opción marcada se lee de «latestSelected» y no de lo último pintado: si ↓↓↓ y Enter llegan juntos (el ordenador va
  // cargado, por SSH), Enter tiene que elegir la opción a la que se ha bajado, no la que estaba marcada antes («Sí»)
  const [selected, latestSelected, setSelected] = useLatest(0);
  const [explaining, latestExplaining, setExplaining] = useLatest(false);
  const [feedback, latestFeedback, setFeedback] = useLatest<EditorState>(EMPTY);
  // Una respuesta y solo una: lo que llegue detrás en el mismo trozo no puede contestar otra vez
  const answered = useRef(false);

  const choose = (key: string) => {
    if (answered.current) {
      return;
    }
    if (key !== "e") {
      answered.current = true;
    }
    if (key === "s") {
      props.onDone({ reply: { allow: true } });
    } else if (key === "t") {
      props.onDone({ reply: { allow: true }, grant: "kind" });
    } else if (key === "p") {
      props.onDone({ reply: { allow: true }, grant: "pattern", pattern });
    } else if (key === "n") {
      props.onDone({ reply: { allow: false } });
    } else if (key === "e") {
      setExplaining(() => true);
    }
  };

  useInput((input, key) => {
    if (answered.current) {
      return;
    }
    const { text, enter } = splitEnter(input, key.return);
    if (latestExplaining.current) {
      if (enter) {
        const value = insert(latestFeedback.current, text).value;
        answered.current = true;
        props.onDone({ reply: { allow: false, feedback: value.trim() || undefined } });
      } else if (key.escape) {
        setExplaining(() => false);
      } else if (key.backspace) {
        setFeedback(backspace);
      } else if (key.leftArrow) {
        setFeedback(moveLeft);
      } else if (key.rightArrow) {
        setFeedback(moveRight);
      } else if (key.ctrl && input === "w") {
        setFeedback(deleteWordBack);
      } else if (input && !key.ctrl && !key.meta) {
        setFeedback((current) => applyTyped(current, input, backspace, insert));
      }
      return;
    }
    const typed = text.trim().toLowerCase();
    // Lo que se escribe entero también vale («no», «sí»), como en el modo de texto
    const letter = ANSWER_WORDS[typed] ?? typed;
    if (key.upArrow) {
      setSelected((current) => (current - 1 + options.length) % options.length);
    } else if (key.downArrow || key.tab) {
      setSelected((current) => (current + 1) % options.length);
    } else if (key.escape) {
      choose("n");
    } else if (letter && options.some((option) => option.key === letter)) {
      choose(letter);
    } else if (letter) {
      // Un texto que no es ninguna opción no contesta nada, ni aunque lleve Enter detrás: si no, «no» + Enter llegando
      // juntos aprobaría la opción marcada
    } else if (enter) {
      choose(options[latestSelected.current].key);
    }
  });

  usePaste((text) => {
    if (latestExplaining.current) {
      setFeedback((current) => insert(current, text.replace(/\r?\n/g, " ")));
    }
  });

  // Un comando se enseña entero: si no, 30 líneas inofensivas podrían esconder una 31 maliciosa. Los diffs largos sí se
  // recortan (lo que se aprueba es exactamente ese cambio, y /diff lo enseña entero)
  const lines = request.preview.split("\n");
  const limit = request.kind === "bash" ? lines.length : 30;
  const shown = lines.slice(0, limit).join("\n");
  const hidden = lines.length - limit;
  const typed = splitAtCursor(feedback.value, feedback.cursor);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        ? {showControl(request.title)}
        {props.agent !== "programar" ? <Text dimColor> ({props.agent})</Text> : null}
      </Text>
      <Box marginY={look.gap} flexDirection="column">
        <Text>{colorPreview(shown)}</Text>
        {hidden > 0 ? <Text dimColor>… {hidden} líneas más</Text> : null}
      </Box>
      {explaining ? (
        <Box flexDirection="column">
          <Text>¿Qué debería hacer en su lugar? (Enter envía, Esc vuelve)</Text>
          <Text>
            <Text color="yellow">❯ </Text>
            {typed.before}
            <Text inverse>{typed.under}</Text>
            {typed.after}
          </Text>
        </Box>
      ) : (
        <>
          {options.map((option, index) => (
            <Text key={option.key} color={index === selected ? "cyan" : undefined}>
              {index === selected ? "❯ " : "  "}
              <Text dimColor>[{option.key}]</Text> {option.label}
            </Text>
          ))}
          <Text dimColor>↑↓ elige · Enter acepta · la letra es un atajo · Esc = no</Text>
        </>
      )}
    </Box>
  );
}

function matches<T>(item: SelectItem<T>, query: string): boolean {
  return `${item.label} ${item.description || ""}`.toLowerCase().includes(query);
}

// Lista para elegir (modelos, sesiones, agentes, proveedores); escribir filtra
export function SelectDialog<T>(props: { title: string; items: SelectItem<T>[]; onDone: (value: T | null) => void; onPick?: (value: T) => void }) {
  const [filter, latestFilter, setFilter] = useLatest("");
  const [selected, latestSelected, setSelected] = useLatest(0);
  const filtered = useMemo(() => {
    const query = filter.toLowerCase();
    if (!query) {
      return props.items;
    }
    return props.items.filter((item) => matches(item, query));
  }, [filter, props.items]);
  // Al marcar con un filtro puesto, la lista puede encoger
  const cursor = Math.max(0, Math.min(selected, filtered.length - 1));

  useInput((input, key) => {
    const { text, enter } = splitEnter(input, key.return);
    // Lo que hay ahora de verdad, aunque todavía no se haya pintado
    const current = () => {
      const query = latestFilter.current.toLowerCase();
      return query ? props.items.filter((item) => matches(item, query)) : props.items;
    };
    const position = () => Math.max(0, Math.min(latestSelected.current, current().length - 1));
    if (key.escape) {
      props.onDone(null);
    } else if (enter || (props.onPick && input === " ")) {
      // Si el Enter vino pegado a texto, ese texto también filtra
      if (enter && text) {
        setFilter((value) => value + text);
        setSelected(() => 0);
      }
      const item = current()[position()];
      if (!props.onPick) {
        props.onDone(item ? item.value : null);
      } else if (item) {
        // Con casillas: marca o desmarca y la lista sigue abierta, con su filtro y en el mismo sitio
        props.onPick(item.value);
      }
    } else if (key.upArrow) {
      setSelected(() => Math.max(0, position() - 1));
    } else if (key.downArrow || key.tab) {
      setSelected(() => Math.min(current().length - 1, position() + 1));
    } else if (key.pageUp) {
      setSelected(() => Math.max(0, position() - 10));
    } else if (key.pageDown) {
      setSelected(() => Math.min(current().length - 1, position() + 10));
    } else if (key.backspace) {
      setFilter((value) => value.slice(0, previousBoundary(value, value.length)));
      setSelected(() => 0);
    } else if (input && !key.ctrl && !key.meta) {
      setFilter((value) =>
        applyTyped(
          value,
          input,
          (state) => state.slice(0, previousBoundary(state, state.length)),
          (state, typed) => state + typed,
        ),
      );
      setSelected(() => 0);
    }
  });

  const windowSize = 12;
  const start = Math.max(0, Math.min(cursor - Math.floor(windowSize / 2), filtered.length - windowSize));
  const visible = filtered.slice(start, start + windowSize);
  // La primera línea del título va destacada; las siguientes, si las hay, explican la pregunta
  const [heading, ...body] = props.title.split("\n");

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {heading}
      </Text>
      {body.length > 0 ? (
        <Box marginBottom={1}>
          <Text>{body.join("\n")}</Text>
        </Box>
      ) : null}
      <Text dimColor>
        {filter ? `Filtro: ${filter}` : props.onPick ? "Escribe para filtrar · ↑↓ elegir · Enter o espacio marca y desmarca · Esc termina" : "Escribe para filtrar · ↑↓ elegir · Enter aceptar · Esc salir"}
      </Text>
      {visible.length === 0 ? <Text dimColor>(nada coincide)</Text> : null}
      {visible.map((item, index) => {
        const active = start + index === cursor;
        return (
          <Text key={`${start + index}-${item.label}`} color={active ? "cyan" : undefined} wrap="truncate-end">
            {active ? "❯ " : "  "}
            {stripControl(item.label)}
            {item.description ? <Text dimColor> {stripControl(item.description)}</Text> : null}
          </Text>
        );
      })}
      {filtered.length > windowSize ? (
        <Text dimColor>
          {cursor + 1}/{filtered.length}
        </Text>
      ) : null}
    </Box>
  );
}

// Lista con casillas: marcas y desmarcas varios sin que se cierre, y Esc termina
export function ChecklistDialog<T>(props: { title: string; items: () => SelectItem<T>[]; onToggle: (value: T) => void; onDone: () => void }) {
  const [items, setItems] = useState(props.items);
  return (
    <SelectDialog
      title={props.title}
      items={items}
      onDone={() => props.onDone()}
      onPick={(value) => {
        props.onToggle(value);
        setItems(props.items());
      }}
    />
  );
}

// Pide un texto (las claves se ven como •••)
export function PromptDialog(props: { title: string; mask?: boolean; placeholder?: string; onDone: (value: string | null) => void }) {
  const [state, latestState, setState] = useLatest<EditorState>(EMPTY);

  useInput((input, key) => {
    const { text, enter } = splitEnter(input, key.return);
    if (key.escape) {
      props.onDone(null);
    } else if (enter) {
      props.onDone(insert(latestState.current, text).value);
    } else if (key.backspace) {
      setState(backspace);
    } else if (key.leftArrow) {
      setState(moveLeft);
    } else if (key.rightArrow) {
      setState(moveRight);
    } else if (key.ctrl && input === "u") {
      setState(() => EMPTY);
    } else if (input && !key.ctrl && !key.meta) {
      setState((current) => applyTyped(current, input, backspace, insert));
    }
  });

  usePaste((text) => {
    setState((current) => insert(current, text.replace(/\r?\n/g, "").trim()));
  });

  let shown = state.value;
  if (props.mask) {
    shown = "•".repeat(state.value.length);
  }
  const cursor = splitAtCursor(shown, state.cursor);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">
        {props.title}
      </Text>
      <Text>
        <Text color="magenta">❯ </Text>
        {shown.length === 0 && props.placeholder ? <Text dimColor>{props.placeholder}</Text> : null}
        {cursor.before}
        <Text inverse>{cursor.under}</Text>
        {cursor.after}
      </Text>
      <Text dimColor>Enter acepta · Esc cancela{props.mask ? " · pega la clave con Cmd+V" : ""}</Text>
    </Box>
  );
}
