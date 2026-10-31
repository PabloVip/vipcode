import { Box, Text, useInput, usePaste } from "ink";
import React, { useMemo, useState } from "react";
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
};

interface Option {
  key: string;
  label: string;
}

export type PermissionChoice = { reply: PermissionReply; grant?: "kind" | "pattern"; pattern?: string };

// Pregunta antes de editar, ejecutar o salir a internet, enseñando el diff o el comando
export function PermissionDialog(props: { request: PermissionRequest; agent: string; onDone: (choice: PermissionChoice) => void }) {
  const { request } = props;
  const pattern = request.kind === "bash" ? suggestPattern(request.subject) : "";
  const options: Option[] = [{ key: "s", label: "Sí" }];
  options.push({ key: "t", label: `Sí, y no preguntar más por ${KIND_LABEL[request.kind] || "esto"} en esta sesión` });
  if (pattern) {
    options.push({ key: "p", label: `Sí, y permitir siempre «${pattern}» en esta sesión` });
  }
  options.push({ key: "n", label: "No" });
  options.push({ key: "e", label: "No, y decirle qué hacer en su lugar" });

  const [selected, setSelected] = useState(0);
  const [explaining, setExplaining] = useState(false);
  const [feedback, setFeedback] = useState<EditorState>(EMPTY);

  const choose = (key: string) => {
    if (key === "s") {
      props.onDone({ reply: { allow: true } });
    } else if (key === "t") {
      props.onDone({ reply: { allow: true }, grant: "kind" });
    } else if (key === "p") {
      props.onDone({ reply: { allow: true }, grant: "pattern", pattern });
    } else if (key === "n") {
      props.onDone({ reply: { allow: false } });
    } else if (key === "e") {
      setExplaining(true);
    }
  };

  useInput((input, key) => {
    const { text, enter } = splitEnter(input, key.return);
    if (explaining) {
      if (enter) {
        const value = insert(feedback, text).value;
        props.onDone({ reply: { allow: false, feedback: value.trim() || undefined } });
      } else if (key.escape) {
        setExplaining(false);
      } else if (key.backspace) {
        setFeedback(backspace(feedback));
      } else if (key.leftArrow) {
        setFeedback(moveLeft(feedback));
      } else if (key.rightArrow) {
        setFeedback(moveRight(feedback));
      } else if (key.ctrl && input === "w") {
        setFeedback(deleteWordBack(feedback));
      } else if (input && !key.ctrl && !key.meta) {
        setFeedback(insert(feedback, input));
      }
      return;
    }
    const letter = text.trim().toLowerCase();
    if (key.upArrow) {
      setSelected((selected - 1 + options.length) % options.length);
    } else if (key.downArrow || key.tab) {
      setSelected((selected + 1) % options.length);
    } else if (key.escape) {
      choose("n");
    } else if (letter && options.some((option) => option.key === letter)) {
      choose(letter);
    } else if (letter === "y") {
      choose("s");
    } else if (enter) {
      choose(options[selected].key);
    }
  });

  usePaste((text) => {
    if (explaining) {
      setFeedback(insert(feedback, text.replace(/\r?\n/g, " ")));
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
export function SelectDialog<T>(props: { title: string; items: SelectItem<T>[]; onDone: (value: T | null) => void }) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const filtered = useMemo(() => {
    const query = filter.toLowerCase();
    if (!query) {
      return props.items;
    }
    return props.items.filter((item) => matches(item, query));
  }, [filter, props.items]);

  useInput((input, key) => {
    const { text, enter } = splitEnter(input, key.return);
    if (key.escape) {
      props.onDone(null);
    } else if (enter) {
      // Si el Enter vino pegado a texto, ese texto también filtra
      let list = filtered;
      let index = selected;
      if (text) {
        const query = (filter + text).toLowerCase();
        list = props.items.filter((item) => matches(item, query));
        index = 0;
      }
      const item = list[index];
      props.onDone(item ? item.value : null);
    } else if (key.upArrow) {
      setSelected(Math.max(0, selected - 1));
    } else if (key.downArrow || key.tab) {
      setSelected(Math.min(filtered.length - 1, selected + 1));
    } else if (key.pageUp) {
      setSelected(Math.max(0, selected - 10));
    } else if (key.pageDown) {
      setSelected(Math.min(filtered.length - 1, selected + 10));
    } else if (key.backspace) {
      setFilter(filter.slice(0, previousBoundary(filter, filter.length)));
      setSelected(0);
    } else if (input && !key.ctrl && !key.meta) {
      setFilter(filter + input);
      setSelected(0);
    }
  });

  const windowSize = 12;
  const start = Math.max(0, Math.min(selected - Math.floor(windowSize / 2), filtered.length - windowSize));
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
        {filter ? `Filtro: ${filter}` : "Escribe para filtrar · ↑↓ elegir · Enter aceptar · Esc salir"}
      </Text>
      {visible.length === 0 ? <Text dimColor>(nada coincide)</Text> : null}
      {visible.map((item, index) => {
        const active = start + index === selected;
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
          {selected + 1}/{filtered.length}
        </Text>
      ) : null}
    </Box>
  );
}

// Pide un texto (las claves se ven como •••)
export function PromptDialog(props: { title: string; mask?: boolean; placeholder?: string; onDone: (value: string | null) => void }) {
  const [state, setState] = useState<EditorState>(EMPTY);

  useInput((input, key) => {
    const { text, enter } = splitEnter(input, key.return);
    if (key.escape) {
      props.onDone(null);
    } else if (enter) {
      props.onDone(insert(state, text).value);
    } else if (key.backspace) {
      setState(backspace(state));
    } else if (key.leftArrow) {
      setState(moveLeft(state));
    } else if (key.rightArrow) {
      setState(moveRight(state));
    } else if (key.ctrl && input === "u") {
      setState(EMPTY);
    } else if (input && !key.ctrl && !key.meta) {
      setState(insert(state, input));
    }
  });

  usePaste((text) => {
    setState(insert(state, text.replace(/\r?\n/g, "").trim()));
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
