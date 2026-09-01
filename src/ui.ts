import { Container, Text } from "@earendil-works/pi-tui";

import type { Activity, RunDetails, ToolLookupDetails } from "./types.js";

interface Palette {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const countLines = (text: string) => {
  let count = 1;
  let cursor = 0;
  while ((cursor = text.indexOf("\n", cursor)) >= 0) {
    count += 1;
    cursor += 1;
  }
  return count;
};

const headBoundary = (text: string, lines: number) => {
  let cursor = -1;
  for (let index = 0; index < lines; index += 1) {
    cursor = text.indexOf("\n", cursor + 1);
    if (cursor < 0) return text.length;
  }
  return cursor;
};

const tailBoundary = (text: string, lines: number) => {
  let cursor = text.length;
  for (let index = 0; index < lines; index += 1) {
    cursor = text.lastIndexOf("\n", cursor - 1);
    if (cursor < 0) return 0;
  }
  return cursor + 1;
};

const compactCount = (value: number) => {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) {
    const digits = value < 100_000 ? 1 : 0;
    return `${(value / 1_000).toFixed(digits)}k`;
  }
  const digits = value < 10_000_000 ? 1 : 0;
  return `${(value / 1_000_000).toFixed(digits)}m`;
};

const collapse = (
  text: string,
  lineLimit: number,
  charLimit: number,
  dim: (text: string) => string,
) => {
  if (text.length > charLimit) {
    const headBudget = Math.ceil(charLimit / 2);
    const tailBudget = Math.floor(charLimit / 2);
    const head = text.slice(0, headBudget);
    const tail = text.slice(-tailBudget);
    const hiddenChars = text.length - head.length - tail.length;
    return `${head}\n${dim(`… ${compactCount(hiddenChars)} characters hidden`)}\n${tail}`;
  }

  const totalLines = countLines(text);
  if (totalLines <= lineLimit) return text;
  const head = text.slice(0, headBoundary(text, Math.ceil(lineLimit / 2)));
  const tail = text.slice(tailBoundary(text, Math.floor(lineLimit / 2)));
  return `${head}\n${dim(`… ${totalLines - lineLimit} lines hidden`)}\n${tail}`;
};

const ACTION_LABELS = new Map([
  ["read", "Read"],
  ["write", "Write"],
  ["edit", "Edit"],
  ["search", "Search"],
  ["find", "Find"],
  ["list", "List"],
  ["run", "Run"],
  ["http", "Fetch"],
  ["wait", "Wait"],
  ["think", "Think"],
  ["snapshot", "Snapshot"],
  ["undo", "Undo"],
]);

const MAX_JSON_PARSE_CHARS = 262_144;
const MAX_EXPANDED_DEPTH = 6;
const MAX_EXPANDED_CHILDREN = 50;

const scriptCallCount = (script: string) =>
  Array.from(
    script.matchAll(/\b(read|write|edit|search|find|list|run|http|wait|think|snapshot|undo)\s*\(/g),
  ).length;

export type CallPhase = "ready" | "running" | "settled";

export const renderScriptCall = (
  script: string,
  expanded: boolean,
  phase: CallPhase,
  theme: Palette,
) => {
  const source = script.trim() || "No script";
  const planned = scriptCallCount(source);
  const state = phase === "ready" ? " · starting" : "";
  const count = planned > 0 ? ` · ${planned} planned` : "";
  const title = `${theme.fg("toolTitle", theme.bold("CallScript"))}${theme.fg("dim", `${count}${state}`)}`;
  if (!expanded) return new Text(title, 0, 0);
  const body = collapse(source, 40, 24_000, (text) => theme.fg("dim", text));
  return new Text(`${title}\n${theme.fg("dim", body)}`, 0, 0);
};

const isString = <T>(value: T): value is T & string => typeof value === "string";
const isNumber = <T>(value: T): value is T & number => typeof value === "number";
const isBoolean = <T>(value: T): value is T & boolean => typeof value === "boolean";
const isDisplayObject = <T>(value: T): value is T & object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsedJson = (text: string): { parsed: true; value: unknown } | { parsed: false } => {
  if (text.length > MAX_JSON_PARSE_CHARS) return { parsed: false };
  try {
    const value: unknown = JSON.parse(text);
    return { parsed: true, value };
  } catch {
    return { parsed: false };
  }
};

const humanKey = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((word) => {
      const lower = word.toLowerCase();
      if (["api", "cwd", "http", "id", "rpc", "ui", "url"].includes(lower))
        return lower.toUpperCase();
      return lower;
    })
    .join(" ");

const shortText = (text: string, limit = 96) => {
  const sampled =
    text.length <= limit * 4 ? text : `${text.slice(0, limit * 2)} ${text.slice(-limit * 2)}`;
  const compact = sampled.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return "—";
  if (compact.length <= limit) return compact;
  const head = Math.ceil((limit - 1) / 2);
  const tail = Math.floor((limit - 1) / 2);
  return `${compact.slice(0, head).trimEnd()}…${compact.slice(-tail).trimStart()}`;
};

const scalar = <T>(value: T, theme: Palette) => {
  if (value === null) return theme.fg("dim", "—");
  if (isBoolean(value)) return theme.fg(value ? "success" : "error", value ? "✓" : "×");
  if (isNumber(value)) return theme.fg("accent", String(value));
  if (isString(value)) return shortText(value, 64);
  if (Array.isArray(value)) return theme.fg("muted", `${value.length} items`);
  if (isDisplayObject(value)) return theme.fg("muted", `${Object.keys(value).length} fields`);
  return theme.fg("dim", "—");
};

const compactValue = <T>(value: T, theme: Palette) => {
  if (!isDisplayObject(value)) return scalar(value, theme);
  const entries = Object.entries(value);
  if (entries.length === 0) return theme.fg("dim", "No output");
  const visible = entries.slice(0, 8).map(([key, entry]) => {
    const label = theme.fg("muted", humanKey(key));
    return `${label} ${scalar(entry, theme)}`;
  });
  if (entries.length > visible.length)
    visible.push(theme.fg("dim", `+${entries.length - visible.length} more`));
  return visible.join(theme.fg("dim", " · "));
};

const expandedValueLines = <T>(value: T, theme: Palette, depth = 0): string[] => {
  const indent = "  ".repeat(depth);
  if (depth >= MAX_EXPANDED_DEPTH) return [`${indent}${theme.fg("dim", "Further detail hidden")}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}${theme.fg("dim", "No items")}`];
    const visible = value.slice(0, MAX_EXPANDED_CHILDREN).flatMap((entry) => {
      if (isDisplayObject(entry) || Array.isArray(entry)) {
        return [
          `${indent}${theme.fg("muted", "•")}`,
          ...expandedValueLines(entry, theme, depth + 1),
        ];
      }
      return [`${indent}${theme.fg("muted", "•")} ${scalar(entry, theme)}`];
    });
    if (value.length > MAX_EXPANDED_CHILDREN)
      visible.push(`${indent}${theme.fg("dim", `+${value.length - MAX_EXPANDED_CHILDREN} more`)}`);
    return visible;
  }
  if (isDisplayObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${indent}${theme.fg("dim", "No output")}`];
    const visible = entries.slice(0, MAX_EXPANDED_CHILDREN).flatMap(([key, entry]) => {
      const label = theme.fg("muted", humanKey(key));
      if (isDisplayObject(entry) || Array.isArray(entry)) {
        return [`${indent}${label}`, ...expandedValueLines(entry, theme, depth + 1)];
      }
      return [`${indent}${label}  ${scalar(entry, theme)}`];
    });
    if (entries.length > MAX_EXPANDED_CHILDREN)
      visible.push(
        `${indent}${theme.fg("dim", `+${entries.length - MAX_EXPANDED_CHILDREN} more`)}`,
      );
    return visible;
  }
  return [`${indent}${scalar(value, theme)}`];
};

const outputLines = (text: string, expanded: boolean, theme: Palette) => {
  const backgroundAt = text.indexOf("\n\nBackground\n");
  const visibleText = (backgroundAt < 0 ? text : text.slice(0, backgroundAt)).trim();
  if (visibleText.length === 0 || visibleText === "done") return [];
  const structured = visibleText.startsWith("{") || visibleText.startsWith("[");
  if (structured && visibleText.length > MAX_JSON_PARSE_CHARS) {
    if (!expanded)
      return [
        theme.fg("muted", `Structured result · ${compactCount(visibleText.length)} characters`),
      ];
    return collapse(visibleText, 24, 16_000, (line) => theme.fg("dim", line)).split("\n");
  }
  const decoded = parsedJson(visibleText);
  if (decoded.parsed)
    return expanded
      ? expandedValueLines(decoded.value, theme)
      : [compactValue(decoded.value, theme)];
  if (!expanded) return [shortText(visibleText, 160)];
  return collapse(visibleText, 24, 16_000, (line) => theme.fg("dim", line)).split("\n");
};

const duration = (milliseconds: number) => {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  const totalSeconds = Math.round(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
};

interface Trace {
  queued?: Activity;
  start?: Activity;
  end?: Activity;
}

const traceKey = (event: Activity) => `${event.step}:${event.item ?? "single"}`;

const traceLead = (trace: Trace) => trace.start ?? trace.queued ?? trace.end;

const tracesFrom = (activity: readonly Activity[]) => {
  const traces = new Map<string, Trace>();
  for (const event of activity) {
    const key = traceKey(event);
    if (event.phase === "queued") {
      traces.set(key, { queued: event });
      continue;
    }
    if (event.phase === "start") {
      if (event.item !== undefined) {
        const placeholderKey = `${event.step}:single`;
        const placeholder = traces.get(placeholderKey);
        if (placeholder?.start === undefined && placeholder?.end === undefined)
          traces.delete(placeholderKey);
      }
      traces.set(key, { ...traces.get(key), start: event });
      continue;
    }
    const trace = traces.get(key);
    if (trace !== undefined) trace.end = event;
  }
  return Array.from(traces.values())
    .filter((trace) => traceLead(trace) !== undefined)
    .sort((left, right) => (traceLead(left)?.sequence ?? 0) - (traceLead(right)?.sequence ?? 0));
};

const activeSummary = (trace: Trace, elapsedMs: number) => {
  const start = trace.start;
  if (start === undefined) return "ready";
  const age = Math.max(0, elapsedMs - start.atMs);
  if (start.expectedMs !== undefined)
    return `waiting ${duration(age)} of ${duration(start.expectedMs)}`;
  if (start.timeoutMs !== undefined) {
    if (age >= start.timeoutMs)
      return `timeout reached · ${duration(age)} of ${duration(start.timeoutMs)}`;
    if (age >= start.timeoutMs * 0.8)
      return `near timeout · ${duration(age)} of ${duration(start.timeoutMs)}`;
    return `running ${duration(age)} · timeout ${duration(start.timeoutMs)}`;
  }
  return age >= 10_000 ? `still running ${duration(age)} · no timeout` : `running ${duration(age)}`;
};

const traceLines = (traces: readonly Trace[], elapsedMs: number, theme: Palette) => {
  const lines: string[] = [];
  for (const [index, trace] of traces.entries()) {
    const last = index === traces.length - 1;
    const branch = theme.fg("dim", last ? "└─" : "├─");
    const lead = trace.start ?? trace.queued ?? trace.end;
    if (lead === undefined) continue;
    const end = trace.end;
    const queued = trace.start === undefined && end === undefined;
    const active = trace.start !== undefined && end === undefined;
    const failed = end?.phase === "error";
    const skipped = end?.phase === "skipped";
    const icon = queued
      ? theme.fg("dim", "○")
      : active
        ? theme.fg("warning", "●")
        : failed
          ? theme.fg("error", "×")
          : skipped
            ? theme.fg("dim", "–")
            : theme.fg("success", "✓");
    const tool = ACTION_LABELS.get(lead.tool) ?? humanKey(lead.tool);
    const target = shortText(lead.target ?? humanKey(lead.step));
    const item = lead.item === undefined ? "" : ` · item ${lead.item + 1}`;
    lines.push(`${branch} ${icon} ${theme.bold(tool)}  ${theme.fg("accent", target)}${item}`);

    const child = theme.fg("dim", last ? "   └─" : "│  └─");
    const detail = lead.detail === undefined ? "" : `${shortText(lead.detail, 48)} · `;
    if (queued) {
      lines.push(`${child} ${theme.fg("dim", `${detail}ready`)}`);
    } else if (active) {
      lines.push(`${child} ${theme.fg("warning", `${detail}${activeSummary(trace, elapsedMs)}`)}`);
    } else if (end?.phase === "error") {
      const reason = shortText(end.error ?? "failed", 88);
      lines.push(
        `${child} ${theme.fg("error", `${detail}failed · ${reason}`)}${theme.fg("dim", ` · ${duration(end.elapsedMs ?? 0)}`)}`,
      );
    } else if (end?.phase === "skipped") {
      lines.push(`${child} ${theme.fg("dim", `${detail}not launched`)}`);
    } else if (end !== undefined) {
      const result = end.result ?? "done";
      lines.push(
        `${child} ${theme.fg("muted", `${detail}${result}`)}${theme.fg("dim", ` · ${duration(end.elapsedMs ?? 0)}`)}`,
      );
    }
  }
  return lines;
};

const traceCounts = (traces: readonly Trace[]) => {
  let ready = 0;
  let running = 0;
  let done = 0;
  let failed = 0;
  let skipped = 0;
  for (const trace of traces) {
    if (trace.start === undefined && trace.end === undefined) ready += 1;
    else if (trace.end === undefined) running += 1;
    else if (trace.end.phase === "error") failed += 1;
    else if (trace.end.phase === "skipped") skipped += 1;
    else done += 1;
  }
  return { ready, running, done, failed, skipped };
};

const countLabel = (count: number, label: string) => (count > 0 ? `${count} ${label}` : "");

export const renderScriptResult = (
  text: string,
  details: RunDetails | undefined,
  expanded: boolean,
  partial: boolean,
  error: boolean,
  theme: Palette,
) => {
  if (details === undefined) {
    const label = partial
      ? theme.fg("warning", "◌ Running")
      : error
        ? theme.fg("error", "× Failed")
        : theme.fg("success", "✓ Done");
    const output = outputLines(text, expanded, theme);
    return new Text([label, ...output].join("\n"), 0, 0);
  }

  const traces = tracesFrom(details.activity);
  const counts = traceCounts(traces);
  const state = [
    !partial && details.status === "paused" ? "thinking" : "",
    !partial && error && counts.failed === 0 ? "failed" : "",
    countLabel(counts.done, "done"),
    countLabel(counts.running, "running"),
    countLabel(counts.ready, "ready"),
    countLabel(counts.failed, "failed"),
    countLabel(counts.skipped, "not run"),
    duration(details.elapsedMs),
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [theme.fg(partial ? "warning" : error ? "error" : "muted", state)];
  lines.push(...traceLines(traces, details.elapsedMs, theme));

  if (!partial && details.status !== "paused") {
    const output = outputLines(text, expanded, theme);
    if (output.length > 0) {
      lines.push("", theme.fg("dim", "Result"));
      lines.push(...output.map((line) => `${theme.fg("dim", "└─")} ${line}`));
    }
  }
  return new Text(lines.join("\n"), 0, 0);
};

type LookupKind = ToolLookupDetails["kind"];

export const renderLookupCall = (
  kind: LookupKind,
  subject: string,
  phase: CallPhase,
  theme: Palette,
) => {
  const label = kind === "search" ? "Find tools" : "Tool details";
  const state = phase === "ready" ? " · starting" : "";
  const target = subject.length > 0 ? `  ${theme.fg("accent", shortText(subject, 64))}` : "";
  return new Text(
    `${theme.fg("toolTitle", theme.bold(label))}${target}${theme.fg("dim", state)}`,
    0,
    0,
  );
};

export const renderLookupResult = (
  details: ToolLookupDetails | undefined,
  expanded: boolean,
  partial: boolean,
  theme: Palette,
) => {
  if (partial) return new Container();
  const tools = details?.tools ?? [];
  if (tools.length === 0) return new Text(theme.fg("warning", "No matching tools"), 0, 0);
  const lines = tools.map((tool, index) => {
    const last = index === tools.length - 1;
    const branch = theme.fg("dim", last ? "└─" : "├─");
    const name = theme.bold(humanKey(tool.name));
    if (!expanded || tool.description === undefined) return `${branch} ${name}`;
    const child = theme.fg("dim", last ? "   └─" : "│  └─");
    return `${branch} ${name}\n${child} ${theme.fg("muted", tool.description)}`;
  });
  return new Text(lines.join("\n"), 0, 0);
};
