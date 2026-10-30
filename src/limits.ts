import pc from "picocolors";
import type { ProviderConfig } from "./config.js";
import type { LimitSnapshot, LimitWindow, Router, Slot } from "./router.js";

// Cuánto te queda de cada plan gratis: lo que dice el proveedor en sus cabeceras y, si no lo dice, sus límites
// conocidos menos lo que ha pedido vipcode

const HOUR_MS = 60 * 60 * 1000;
const PERIOD: Record<string, string> = { day: "hoy", hour: "esta hora", minute: "por minuto" };

export interface Quota {
  text: string;
  // Para la barra de abajo: «quedan 991/1000 hoy»
  short: string;
  remaining: number;
  limit: number | null;
  period?: LimitWindow["period"];
}

function quota(remaining: number, limit: number | null, period: string, estimated = false): Quota {
  const mark = estimated ? "≈ " : "";
  const tail = period ? ` ${period}` : "";
  return {
    text: `${mark}quedan ${number(remaining)}${limit !== null ? ` de ${number(limit)}` : ""}${tail}`,
    short: `${mark}quedan ${number(remaining)}${limit !== null ? `/${number(limit)}` : ""}${tail}`,
    remaining,
    limit,
  };
}

// El nombre corto de un proveedor, para la barra de abajo («OpenRouter», sin «(modelos :free)»)
export function providerName(provider: ProviderConfig): string {
  return (provider.label || provider.name).replace(/\s*\([^)]*\)\s*$/, "") || provider.name;
}

function number(n: number): string {
  return n.toLocaleString("es-ES");
}

function short(n: number): string {
  if (n >= 1e6) {
    return `${(n / 1e6).toLocaleString("es-ES", { maximumFractionDigits: 1 })} M`;
  }
  if (n >= 1e4) {
    return `${Math.round(n / 1e3).toLocaleString("es-ES")} k`;
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toLocaleString("es-ES", { maximumFractionDigits: 1 })} k`;
  }
  return String(n);
}

function clock(time: number, now: number): string {
  const hour = new Date(time).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  const day = new Date(time).toDateString();
  if (day === new Date(now).toDateString()) {
    return `las ${hour}`;
  }
  if (day === new Date(now + 24 * HOUR_MS).toDateString()) {
    return `mañana a las ${hour}`;
  }
  return `el ${new Date(time).toLocaleDateString("es-ES", { weekday: "long" })} a las ${hour}`;
}

// Lo que dijo el proveedor, si todavía vale (pasada la hora de recuperarse ya no)
function fromHeaders(window: LimitWindow | undefined, now: number, unit = ""): Quota | null {
  if (!window || (window.resetAt !== null && window.resetAt <= now)) {
    return null;
  }
  const period = window.period ? PERIOD[window.period] : "";
  if (unit) {
    const text = `quedan ${short(window.remaining)}${window.limit !== null ? ` de ${short(window.limit)}` : ""}${unit}${period ? ` ${period}` : ""}`;
    return { text, short: text, remaining: window.remaining, limit: window.limit, period: window.period };
  }
  return { ...quota(window.remaining, window.limit, period), period: window.period };
}

// Lo último que ha dicho el proveedor de este modelo (o de cualquiera de los suyos si el límite es de toda la cuenta)
function snapshotFor(router: Router, slot: Slot): LimitSnapshot | undefined {
  if (slot.provider.limitScope !== "provider") {
    return router.limits[slot.key];
  }
  let latest: LimitSnapshot | undefined;
  for (const other of router.slots) {
    const snapshot = other.provider.name === slot.provider.name ? router.limits[other.key] : undefined;
    if (snapshot && (!latest || snapshot.at > latest.at)) {
      latest = snapshot;
    }
  }
  return latest;
}

// Peticiones que te quedan en este modelo (o en su proveedor), o null si no se sabe
export function quotaFor(router: Router, slot: Slot, now = Date.now()): Quota | null {
  const header = fromHeaders(snapshotFor(router, slot)?.requests, now);
  // El límite por minuto se recupera enseguida: si hay uno diario u horario conocido, es más útil
  if (header && header.period !== "minute") {
    return header;
  }
  const limits = slot.provider.freeLimits;
  if (!limits || (limits.keyless && !slot.anonymous)) {
    return header;
  }
  const usage = router.today().providers[slot.provider.name];
  if (limits.perDay) {
    const used = slot.provider.limitScope === "provider" ? usage?.requests || 0 : usage?.models[slot.model.id] || 0;
    // Si ya llevas más de las que dice el plan, es que tu límite es mayor (por ejemplo OpenRouter con créditos)
    if (used <= limits.perDay) {
      return { ...quota(limits.perDay - used, limits.perDay, PERIOD.day, true), period: "day" };
    }
  }
  if (limits.perHour) {
    const used = (router.recent[slot.provider.name] || []).filter((time) => now - time < HOUR_MS).length;
    if (used <= limits.perHour) {
      return { ...quota(limits.perHour - used, limits.perHour, PERIOD.hour, true), period: "hour" };
    }
  }
  return header;
}

function pausedUntil(router: Router, slot: Slot, now: number): number | null {
  const until = router.cooldowns[slot.key] || 0;
  return until > now ? until : null;
}

function plural(n: number, one: string, many: string): string {
  return `${number(n)} ${n === 1 ? one : many}`;
}

// Informe de /limites: uso de hoy por proveedor y modelo, lo que queda y las pausas
export function limitsReport(router: Router, now = Date.now()): string {
  const day = router.today();
  const totals = Object.values(day.providers).reduce((sum, entry) => ({ requests: sum.requests + entry.requests, tokens: sum.tokens + entry.tokens }), { requests: 0, tokens: 0 });
  const today = new Date(now);
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1);
  const lines = [
    `Hoy llevas ${plural(totals.requests, "petición", "peticiones")}${totals.tokens > 0 ? ` y ${short(totals.tokens)} tokens` : ""} ${pc.dim(`(el día cuenta en hora UTC: vuelve a empezar ${clock(midnight, now)})`)}`,
    "",
  ];
  const providers: ProviderConfig[] = [];
  for (const slot of router.slots) {
    if (!providers.includes(slot.provider)) {
      providers.push(slot.provider);
    }
  }
  const unused: string[] = [];
  for (const provider of providers) {
    const label = provider.label || provider.name;
    const slots = router.slots.filter((slot) => slot.provider === provider);
    const usage = day.providers[provider.name];
    const shown = slots.filter((slot) => (usage?.models[slot.model.id] || 0) > 0 || pausedUntil(router, slot, now) || router.limits[slot.key]);
    if (!usage && shown.length === 0) {
      unused.push(label);
      continue;
    }
    const whole = provider.limitScope === "provider";
    const head = [`${pc.bold(label)}: ${plural(usage?.requests || 0, "petición", "peticiones")}`];
    if (usage?.tokens) {
      head.push(`${short(usage.tokens)} tokens`);
    }
    if (whole) {
      const quota = quotaFor(router, slots[0], now);
      if (quota) {
        head.push(quota.remaining <= 0 ? pc.red(quota.text) : quota.text);
      }
      const until = slots.map((slot) => pausedUntil(router, slot, now)).find((value) => value !== null);
      if (until) {
        head.push(pc.yellow(`en pausa hasta ${clock(until, now)}`));
      }
    }
    lines.push(head.join(" · "));
    const width = Math.min(40, Math.max(...shown.map((slot) => slot.model.id.length)));
    for (const slot of shown) {
      const parts = [`  ${slot.model.id.padEnd(width)}  ${plural(usage?.models[slot.model.id] || 0, "petición", "peticiones")}`];
      if (!whole) {
        const quota = quotaFor(router, slot, now);
        if (quota) {
          parts.push(quota.remaining <= 0 ? pc.red(quota.text) : quota.text);
        }
        const until = pausedUntil(router, slot, now);
        if (until) {
          parts.push(pc.yellow(`en pausa hasta ${clock(until, now)}`));
        }
      }
      const tokens = fromHeaders(router.limits[slot.key]?.tokens, now, " tokens");
      if (tokens) {
        parts.push(pc.dim(tokens.text));
      }
      lines.push(parts.join(" · "));
    }
    if (provider.freeInfo) {
      lines.push(pc.dim(`  ${provider.freeInfo}`));
    }
  }
  if (unused.length > 0) {
    lines.push("", `Sin usar hoy: ${unused.join(", ")}`);
  }
  lines.push(
    "",
    pc.dim("«quedan» es lo que dice el proveedor; «≈ quedan», la cuenta de vipcode con los límites de su plan gratis, contando solo lo que ha pedido vipcode en este ordenador."),
  );
  return lines.join("\n");
}
