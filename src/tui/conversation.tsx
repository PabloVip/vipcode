import fs from "node:fs";
import { Box, type DOMElement, Text, renderToString, useBoxMetrics, useInput } from "ink";
import pc from "picocolors";
import React, { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import sliceAnsi from "slice-ansi";
import type { App } from "../app.js";
import { copyToClipboard } from "../clipboard.js";
import { stripControl } from "../sanitize.js";
import { type Item, ItemView } from "./items.js";
import { MOUSE_OFF, MOUSE_ON, type TextPos, lineColumns, mouseEvents, selectedColumns, selectedText, wordAt } from "./mouse.js";
import { type Match, findMatches, scrollThumb } from "./view.js";
import { look } from "./theme.js";

// La conversación en pantalla completa: cada mensaje se pinta una vez y se enseña línea a línea, con su propio scroll
// (rueda, AvPág/RePág, barra de desplazamiento, Ctrl+Inicio/Fin), la selección con el ratón (se copia al soltar; doble
// clic, una palabra; triple, la línea), Ctrl+F y las herramientas que se despliegan con un clic

// Ancho al que se pinta la conversación en pantalla completa: la última columna es para la barra de desplazamiento
function paintWidth(columns: number): number {
  return Math.max(20, columns - 1);
}

// Ctrl+F: lo que buscas y cuántas veces sale
function SearchBar(props: { query: string; index: number; total: number }) {
  let count = "";
  if (props.query !== "") {
    count = props.total === 0 ? "no sale" : `${props.index + 1} de ${props.total}`;
  }
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="yellow" paddingX={1} justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text color="yellow">Buscar: </Text>
          {stripControl(props.query)}
          <Text color="yellow">▍</Text>
        </Text>
        <Text dimColor>{count}</Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        {"  "}Enter o ↑ la anterior · ↓ la siguiente · Esc cierra
      </Text>
    </Box>
  );
}

export interface Conversation {
  // Lo que se ve de la conversación, con su barra de desplazamiento
  viewport: ReactNode;
  // La caja de Ctrl+F (en lugar de la de escribir), o null si no se está buscando
  searchBar: ReactNode | null;
  // Un aviso corto para la barra de abajo («✓ copiado»)
  flash: string | null;
  // Al momento, sin esperar a que se pinte: si el teclado es de la búsqueda
  searching: React.RefObject<boolean>;
  openSearch: () => void;
  // Abajo del todo, siguiendo lo que llega, y sin nada seleccionado (al escribir)
  toBottom: () => void;
  // Que ese mensaje se vea desde su principio en cuanto esté pintado (si no cabe con lo que tiene debajo)
  reveal: (id: number) => void;
}

export function useConversation(props: {
  app: App;
  items: Item[];
  columns: number;
  rows: number;
  dialog: { kind: string } | null;
  // La interfaz con la que se pinta: si cambia (/interfaz), se vuelve a pintar todo
  interfaceId: string;
  // Un panel a la derecha de la conversación (el de la interfaz Criaturas), que le quita ese ancho: cómo se pinta con el
  // alto que tiene y qué hacer si lo pinchas
  side?: { width: number; render: (height: number) => ReactNode; onClick: () => void } | null;
}): Conversation {
  const { app, items, rows, dialog, interfaceId, side } = props;
  // El ancho de la conversación, con su barra de desplazamiento
  const columns = props.columns - (side?.width ?? 0);
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const sideRef = useRef(side);
  sideRef.current = side;
  // Pantalla completa: la conversación ya pintada, línea a línea (cada mensaje se pinta una vez para cada ancho), y
  // hasta dónde se ha subido (null: abajo del todo, siguiendo lo que llega)
  const painted = useRef(new Map<number, { width: number; open: boolean; look: string; lines: string[] }>());
  const [scrollTop, setScrollTop] = useState<number | null>(null);
  const historyRef = useRef<DOMElement>(null);
  const historyBox = useBoxMetrics(historyRef);
  const scrollState = useRef({ lines: 0, height: 1 });
  // Lo seleccionado arrastrando con el ratón sobre la conversación (se copia al soltar), dónde empezó el arrastre y lo
  // que se ve ahora (para saber qué línea hay bajo el ratón)
  const [selection, setSelection] = useState<{ from: TextPos; to: TextPos } | null>(null);
  const dragStart = useRef<TextPos | null>(null);
  const view = useRef({ lines: [] as string[], owners: [] as { id: number; first: boolean }[], top: 0, height: 1, bar: false });
  // Herramientas desplegadas con un clic, Ctrl+F (lo que se busca y cuál de las coincidencias es la actual; -1, la última)
  // y los clics seguidos (doble clic: palabra; triple: línea)
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const [search, setSearch] = useState<{ query: string; current: number } | null>(null);
  // Al momento (sin esperar a que se pinte): qué teclado manda, el de la búsqueda o el de la caja de escribir
  const searchOpen = useRef(false);
  const lastClick = useRef({ time: 0, line: -1, col: -1, count: 0 });
  const pendingToggle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggingBar = useRef(false);
  // Un aviso corto en la barra de abajo («✓ copiado»)
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showFlash = (text: string) => {
    clearTimeout(flashTimer.current ?? undefined);
    setFlash(text);
    flashTimer.current = setTimeout(() => setFlash(null), 2500);
  };
  const copies = useRef<Promise<unknown>>(Promise.resolve());
  const copySelection = (lines: string[], from: TextPos, to: TextPos) => {
    const text = selectedText(lines, from, to);
    if (text.trim() !== "") {
      // En fila: en un triple clic, la línea se copia después de la palabra del doble clic
      copies.current = copies.current
        .then(() => copyToClipboard(text))
        .then((how) => showFlash(how ? "✓ copiado" : "No he podido copiarlo: prueba con /copiar"));
    }
  };

  // La conversación, línea a línea, para la pantalla completa. Cada mensaje se pinta con renderToString en un
  // temporizador, fuera de React: mientras Ink pinta (o en sus efectos) no se puede, y rompe su cálculo de tamaños
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const [paintedCount, setPaintedCount] = useState(0);
  const paintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (paintTimer.current) {
      return;
    }
    paintTimer.current = setTimeout(() => {
      paintTimer.current = null;
      const width = paintWidth(columnsRef.current);
      let changed = false;
      for (const item of itemsRef.current) {
        const open = expandedRef.current.has(item.id);
        const done = painted.current.get(item.id);
        if (done && done.width === width && done.open === open && done.look === look.interface.id) {
          continue;
        }
        const text = renderToString(
          <Box width={width} flexDirection="column">
            <ItemView item={item} app={app} width={width} fold={item.kind === "tool" ? (open ? "open" : "folded") : undefined} />
          </Box>,
          { columns: width },
        );
        // Lo que no pinta nada (la bienvenida en la zen) no deja una línea en blanco
        painted.current.set(item.id, { width, open, look: look.interface.id, lines: text === "" ? [] : text.split("\n") });
        changed = true;
      }
      // Lo pintado de lo que ya no está en la conversación (tras /new) se olvida
      const ids = new Set(itemsRef.current.map((item) => item.id));
      for (const id of painted.current.keys()) {
        if (!ids.has(id)) {
          painted.current.delete(id);
        }
      }
      if (changed) {
        setPaintedCount((count) => count + 1);
      }
    }, 0);
  }, [items, columns, expanded, interfaceId]);
  useEffect(
    () => () => {
      clearTimeout(paintTimer.current ?? undefined);
      clearTimeout(flashTimer.current ?? undefined);
      clearTimeout(pendingToggle.current ?? undefined);
    },
    [],
  );
  // Las líneas y de qué mensaje es cada una (la primera de una herramienta se pincha para desplegarla)
  const history = useMemo(() => {
    const lines: string[] = [];
    const owners: { id: number; first: boolean }[] = [];
    for (const item of items) {
      const done = painted.current.get(item.id);
      if (done && done.width === paintWidth(columns) && done.look === interfaceId) {
        done.lines.forEach((line, index) => {
          lines.push(line);
          owners.push({ id: item.id, first: index === 0 });
        });
      }
    }
    return { lines, owners };
  }, [items, columns, paintedCount, interfaceId]);
  const historyLines = history.lines;
  const viewHeight = historyBox.hasMeasured ? Math.max(1, historyBox.height) : Math.max(3, rows - 8);
  scrollState.current = { lines: historyLines.length, height: viewHeight };
  // La primera línea que se ve: abajo del todo si no has subido
  const maxTop = Math.max(0, historyLines.length - viewHeight);
  const top = scrollTop === null ? maxTop : Math.min(scrollTop, maxTop);
  const thumb = scrollThumb(historyLines.length, viewHeight, top);
  view.current = { lines: historyLines, owners: history.owners, top, height: viewHeight, bar: thumb !== null };

  // Un mensaje que se tiene que ver desde su principio (las novedades al abrir una versión nueva: si no, con lo que llega
  // después solo se vería su final). Se coloca arriba en cuanto está pintado, y desde ahí se baja como siempre
  const pendingReveal = useRef<number | null>(null);
  useEffect(() => {
    const id = pendingReveal.current;
    const first = id === null ? -1 : history.owners.findIndex((owner) => owner.id === id);
    if (first < 0) {
      return;
    }
    pendingReveal.current = null;
    const { lines, height } = scrollState.current;
    const max = Math.max(0, lines - height);
    setScrollTop(first >= max ? null : first);
  }, [history]);

  // Ctrl+F: las coincidencias y la actual (al cambiar lo buscado, la de más abajo)
  const matches = useMemo(() => (search ? findMatches(historyLines, search.query) : []), [historyLines, search?.query]);
  const current = search && matches.length > 0 ? (search.current < 0 ? matches.length - 1 : Math.min(search.current, matches.length - 1)) : -1;
  useEffect(() => {
    if (current < 0) {
      return;
    }
    // Que se vea, más o menos en el centro
    const { lines, height } = scrollState.current;
    const max = Math.max(0, lines - height);
    const target = Math.max(0, Math.min(matches[current].line - Math.floor(height / 2), max));
    setScrollTop(target >= max ? null : target);
  }, [search?.query, current, matches.length]);

  // Sube o baja la conversación; al llegar abajo del todo vuelve a seguir lo que llega
  const scrollBy = (delta: number) => {
    const { lines, height } = scrollState.current;
    const max = Math.max(0, lines - height);
    setScrollTop((current) => {
      const next = (current ?? max) + delta;
      return next >= max ? null : Math.max(0, next);
    });
  };

  // AvPág/RePág, también con un diálogo abierto (para leer lo de arriba antes de contestar), salvo en las listas, que
  // los usan para moverse por ellas
  useInput(
    (_input, key) => {
      if (dialog?.kind !== "select" && (key.pageUp || key.pageDown)) {
        scrollBy((key.pageUp ? -1 : 1) * Math.max(1, scrollState.current.height - 2));
      } else if (key.ctrl && (key.home || key.end)) {
        // Ctrl+Inicio y Ctrl+Fin: al principio o al final de la conversación
        const { lines, height } = scrollState.current;
        setScrollTop(key.home && lines > height ? 0 : null);
      }
    },
  );

  // Con la pantalla completa, la terminal le manda el ratón a vipcode (la rueda mueve la conversación); al salir, también
  // si sale de golpe, deja de hacerlo
  useEffect(() => {
    if (!process.stdout.isTTY) {
      return;
    }
    process.stdout.write(MOUSE_ON);
    // Lo que lee Ink de la terminal pasa también por aquí (envolviendo stdin.read), sin quitárselo. No vale escuchar
    // «data»: cuando Ink cambia su oyente de «readable», Node puede ponerse a dar las teclas solo a ese oyente
    const onData = (chunk: Buffer | string) => {
      for (const event of mouseEvents(String(chunk))) {
        if (event.kind === "wheel") {
          scrollBy(event.delta * 3);
          continue;
        }
        const { lines, owners, top, height, bar } = view.current;
        // El panel de la derecha: un clic es para él (salvo si vienes arrastrando desde la conversación)
        if (sideRef.current && !dragStart.current && !draggingBar.current && event.x >= columnsRef.current && event.y < height) {
          if (event.kind === "press") {
            sideRef.current.onClick();
          }
          continue;
        }
        // La barra de desplazamiento (la última columna): pinchar o arrastrar lleva a esa altura
        if (event.kind === "press" && bar && event.y < height && event.x >= columnsRef.current - 1) {
          draggingBar.current = true;
        }
        if (draggingBar.current) {
          if (event.kind === "release") {
            draggingBar.current = false;
          } else {
            const max = Math.max(0, lines.length - height);
            const target = Math.round((Math.max(0, Math.min(event.y, height - 1)) / Math.max(1, height - 1)) * max);
            setScrollTop(target >= max ? null : target);
          }
          continue;
        }
        // La línea de la conversación que hay bajo el ratón (si está más abajo, la última que se ve)
        const pos = { line: Math.max(0, Math.min(top + Math.min(event.y, height - 1), lines.length - 1)), col: event.x };
        if (event.kind === "press") {
          // Fuera de la conversación (en la caja o la barra de abajo) no se selecciona; un clic quita lo seleccionado
          if (event.y >= height) {
            dragStart.current = null;
            setSelection(null);
            continue;
          }
          const now = Date.now();
          const last = lastClick.current;
          const count = now - last.time < 450 && last.line === pos.line && Math.abs(last.col - pos.col) <= 1 ? last.count + 1 : 1;
          lastClick.current = { time: now, line: pos.line, col: pos.col, count };
          if (count >= 2) {
            // Doble clic: la palabra; triple: la línea entera. Se copia enseguida (y no despliega nada)
            clearTimeout(pendingToggle.current ?? undefined);
            dragStart.current = null;
            const range = count === 2 ? wordAt(lines[pos.line] || "", pos.col) : lineColumns(lines[pos.line] || "");
            if (range && range[1] > range[0]) {
              const from = { line: pos.line, col: range[0] };
              const to = { line: pos.line, col: range[1] - 1 };
              setSelection({ from, to });
              copySelection(lines, from, to);
            }
            continue;
          }
          dragStart.current = pos;
          setSelection({ from: pos, to: pos });
        } else if (event.kind === "drag" && dragStart.current) {
          // Contra el borde de arriba o por debajo de la conversación, se va moviendo para seguir seleccionando
          if (event.y <= 0) {
            scrollBy(-1);
          } else if (event.y >= height) {
            scrollBy(1);
          }
          setSelection({ from: dragStart.current, to: pos });
        } else if (event.kind === "release" && dragStart.current) {
          const start = dragStart.current;
          dragStart.current = null;
          if (start.line === pos.line && start.col === pos.col) {
            setSelection(null);
            // Un clic en la primera línea de una herramienta despliega (o pliega) su salida; se espera un momento por si
            // es un doble clic
            const owner = owners[pos.line];
            if (owner?.first && itemsRef.current.find((item) => item.id === owner.id)?.kind === "tool") {
              clearTimeout(pendingToggle.current ?? undefined);
              pendingToggle.current = setTimeout(() => {
                pendingToggle.current = null;
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (!next.delete(owner.id)) {
                    next.add(owner.id);
                  }
                  return next;
                });
              }, 300);
            }
            continue;
          }
          setSelection({ from: start, to: pos });
          copySelection(lines, start, pos);
        }
      }
    };
    const stdin = process.stdin;
    const read = stdin.read;
    stdin.read = ((size?: number) => {
      const chunk = read.call(stdin, size);
      if (chunk !== null && chunk !== undefined) {
        onData(chunk);
      }
      return chunk;
    }) as typeof stdin.read;
    const off = () => {
      try {
        fs.writeSync(process.stdout.fd, MOUSE_OFF);
      } catch {
        // la terminal ya no está
      }
    };
    process.on("exit", off);
    return () => {
      stdin.read = read;
      off();
      process.off("exit", off);
    };
  }, []);

  // Ctrl+F abierta: lo que escribes es lo que se busca
  useInput(
    (input, key) => {
      if (!searchOpen.current || dialogRef.current) {
        return;
      }
      if (key.escape || (key.ctrl && (input === "f" || input === "c"))) {
        searchOpen.current = false;
        setSearch(null);
      } else if (key.return || key.upArrow || key.downArrow) {
        if (matches.length > 0) {
          const step = key.downArrow ? 1 : -1;
          setSearch((previous) => previous && { ...previous, current: (current + step + matches.length) % matches.length });
        }
      } else if (key.backspace || key.delete) {
        setSearch((previous) => previous && { query: [...previous.query].slice(0, -1).join(""), current: -1 });
      } else if (input && !key.ctrl && !key.meta) {
        const text = stripControl(input).replace(/[\r\n\t]/g, "");
        if (text) {
          setSearch((previous) => previous && { query: previous.query + text, current: -1 });
        }
      }
    },
  );

  // Lo que se ve de la conversación: lo buscado resaltado (lo actual en amarillo) y lo seleccionado en vídeo inverso; si
  // has subido, la última línea dice cuánto queda por debajo
  const mark = (line: string, from: number, to: number, paint: (text: string) => string) =>
    `${sliceAnsi(line, 0, from)}${paint(stripControl(sliceAnsi(line, from, to)))}${sliceAnsi(line, to)}`;
  const found = new Map<number, Match[]>();
  for (const match of matches) {
    found.set(match.line, [...(found.get(match.line) || []), match]);
  }
  let visible = historyLines.slice(top, top + viewHeight).map((line, index) => {
    let out = line;
    for (const match of found.get(top + index) || []) {
      out = mark(out, match.col, match.col + match.width, match === matches[current] ? (text) => pc.black(pc.bgYellow(text)) : pc.inverse);
    }
    const range = selection ? selectedColumns(top + index, selection.from, selection.to) : null;
    if (range && !(selection!.from.line === selection!.to.line && selection!.from.col === selection!.to.col)) {
      out = mark(out, range[0], range[1], pc.inverse);
    }
    return out;
  });
  const below = historyLines.length - (top + viewHeight);
  if (scrollTop !== null && below > 0) {
    visible = [...visible.slice(0, -1), pc.dim(`↓ ${below} líneas más · rueda del ratón o AvPág para bajar`)];
  }
  const viewport = (
    <Box ref={historyRef} flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
      <Box flexDirection="column" width={paintWidth(columns)}>
        {visible.map((line, index) => (
          <Text key={index} wrap="truncate-end">
            {line || " "}
          </Text>
        ))}
      </Box>
      {thumb ? (
        // La barra de desplazamiento: dónde estás en la conversación (se puede pinchar y arrastrar)
        <Box flexDirection="column" width={1}>
          {Array.from({ length: viewHeight }, (_, row) => (
            <Text key={row}>{row >= thumb.start && row < thumb.start + thumb.size ? "┃" : pc.dim("│")}</Text>
          ))}
        </Box>
      ) : side ? (
        <Box width={1} />
      ) : null}
      {side?.render(viewHeight)}
    </Box>
  );

  return {
    viewport,
    searchBar: search ? <SearchBar query={search.query} index={current} total={matches.length} /> : null,
    flash,
    searching: searchOpen,
    openSearch: () => {
      searchOpen.current = true;
      setSelection(null);
      setSearch({ query: "", current: -1 });
    },
    toBottom: () => {
      setScrollTop(null);
      setSelection(null);
    },
    reveal: (id: number) => {
      pendingReveal.current = id;
    },
  };
}
