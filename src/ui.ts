import { renderDiff } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { Activity, RunDetails } from "./types.js";
import type { OperationPresentationDetails } from "./presentation.js";

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
const MAX_PROJECTED_OPERATIONS = 24;

interface ProjectedOperation {
  readonly tool: string;
  readonly target: string;
}

const isIdentifierStart = (value: string) => /[A-Za-z_$]/.test(value);
const isIdentifierPart = (value: string) => /[A-Za-z0-9_$]/.test(value);

const quotedValue = (source: string, from: number, end: number) => {
  for (let index = from; index < end; index += 1) {
    const quote = source[index];
    if (quote !== '"' && quote !== "'") continue;
    let value = "";
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      if (source[cursor] === "\\") {
        value += source[cursor + 1] ?? "";
        cursor += 1;
        continue;
      }
      if (source[cursor] === quote) return value;
      value += source[cursor] ?? "";
    }
    return value;
  }
  return undefined;
};

const projectedTarget = (source: string, open: number, operation: string) => {
  const end = Math.min(source.length, open + 320);
  const key =
    operation === "snapshot"
      ? "paths"
      : operation === "run"
        ? "command"
        : operation === "http"
          ? "url"
          : operation === "search"
            ? "pattern"
            : operation === "think"
              ? "note"
              : operation === "undo"
                ? "snapshot"
                : "path";
  const keyAt = source.indexOf(key, open);
  if (keyAt >= 0 && keyAt < end) {
    const colon = source.indexOf(":", keyAt + key.length);
    if (colon >= 0 && colon < end) return quotedValue(source, colon + 1, end) ?? `${key} pending`;
  }
  return "next arguments";
};

const projectedOperations = (source: string): readonly ProjectedOperation[] => {
  const operations: ProjectedOperation[] = [];
  let index = 0;
  let quote: string | undefined;
  while (index < source.length && operations.length < MAX_PROJECTED_OPERATIONS) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (quote !== undefined) {
      if (char === "\\") index += 2;
      else if (char === quote) {
        quote = undefined;
        index += 1;
      } else index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      index += 1;
      continue;
    }
    if (!isIdentifierStart(char)) {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < source.length && isIdentifierPart(source[index] ?? "")) index += 1;
    const identifier = source.slice(start, index);
    if (!ACTION_LABELS.has(identifier)) continue;
    let cursor = index;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] === "(")
      operations.push({
        tool: identifier,
        target: projectedTarget(source, cursor + 1, identifier),
      });
  }
  return operations;
};

const projectedTree = (operations: readonly ProjectedOperation[], theme: Palette) => {
  const visible = operations.slice(0, 12);
  const lines = visible.map((operation) => {
    const run = operation.tool === "run" ? "$ " : "";
    return `${theme.fg("dim", "›")} ${run}${theme.bold(ACTION_LABELS.get(operation.tool) ?? operation.tool)}  ${theme.fg("accent", shortText(operation.target, 72))}`;
  });
  if (operations.length > visible.length)
    lines.push(
      `${theme.fg("dim", "›")} ${theme.fg("dim", `… ${operations.length - visible.length} more operations`)}`,
    );
  lines.push(`${theme.fg("dim", "›")} ${theme.fg("dim", "… receiving next operation")}`);
  return lines;
};

export type CallPhase = "ready" | "composing" | "running" | "settled";

export const renderScriptCall = (
  script: string,
  expanded: boolean,
  phase: CallPhase,
  theme: Palette,
) => {
  const source = script.trim() || "No script";
  const operations = projectedOperations(source);
  const composing = phase === "ready" || phase === "composing";
  const title = composing
    ? `${theme.fg("toolTitle", theme.bold("CallScript"))}${theme.fg("dim", " · composing")}`
    : `${theme.fg("toolTitle", theme.bold("CallScript"))}${theme.fg("dim", operations.length > 0 ? ` · ${operations.length} planned` : "")}`;
  if (!expanded && !composing) return new Text(title, 0, 0);
  if (!expanded && composing)
    return new Text([title, ...projectedTree(operations, theme)].join("\n"), 0, 0);
  const body = collapse(source, 40, 24_000, (text) => theme.fg("dim", text));
  return new Text(
    [title, theme.fg("dim", body), ...(composing ? projectedTree(operations, theme) : [])].join(
      "\n",
    ),
    0,
    0,
  );
};

const StringValueSchema = Type.String();
const NumberValueSchema = Type.Number();
const BooleanValueSchema = Type.Boolean();
const DisplayObjectSchema = Type.Object({}, { additionalProperties: true });

const isString = <T>(value: T): value is T & string => Value.Check(StringValueSchema, value);
const isNumber = <T>(value: T): value is T & number => Value.Check(NumberValueSchema, value);
const isBoolean = <T>(value: T): value is T & boolean => Value.Check(BooleanValueSchema, value);
const isDisplayObject = <T>(value: T): value is T & object =>
  Value.Check(DisplayObjectSchema, value);

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

const typedOutputLines = (
  text: string,
  presentation: OperationPresentationDetails | undefined,
  expanded: boolean,
  theme: Palette,
) => {
  if (presentation?.kind === "structured") {
    const items = presentation.items;
    if (items.length === 0) return [theme.fg("dim", "No output")];
    const visible = items.slice(0, expanded ? MAX_EXPANDED_CHILDREN : 8).map((item) => {
      const label = item.key === undefined ? `[${item.index ?? 0}]` : humanKey(item.key);
      return expanded
        ? `${theme.fg("muted", label)}  ${shortText(item.preview, 160)}`
        : `${theme.fg("muted", label)} ${shortText(item.preview, 64)}`;
    });
    if (items.length > visible.length)
      visible.push(theme.fg("dim", `+${items.length - visible.length} more items`));
    return visible;
  }
  if (presentation?.kind === "scalar" || presentation?.kind === "text")
    return expanded
      ? collapse(text, 24, 16_000, (line) => theme.fg("dim", line)).split("\n")
      : [shortText(text, 160)];
  return undefined;
};

const outputLines = (
  text: string,
  expanded: boolean,
  theme: Palette,
  presentation?: OperationPresentationDetails,
) => {
  const backgroundAt = text.indexOf("\n\nBackground\n");
  const visibleText = (backgroundAt < 0 ? text : text.slice(0, backgroundAt)).trim();
  if (visibleText.length === 0 || visibleText === "done") return [];
  const typed = typedOutputLines(visibleText, presentation, expanded, theme);
  if (typed !== undefined) return typed;
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

const diffHunks = (diff: string) => {
  const lines = diff.split("\n");
  const starts = lines
    .map((line, index) => (line.startsWith("@@") ? index : -1))
    .filter((index) => index >= 0);
  return { lines, starts };
};

const editDiffLines = (presentation: NonNullable<Activity["presentation"]>, expanded: boolean) => {
  if (presentation.kind !== "edit") return undefined;
  const { lines, starts } = diffHunks(presentation.diff);
  const visibleHunks = Math.min(expanded ? 8 : 1, starts.length);
  const end = starts.length > visibleHunks ? starts[visibleHunks] : lines.length;
  const visible = lines.slice(0, end);
  let rendered = "";
  try {
    rendered = renderDiff(visible.join("\n"), { filePath: "" });
  } catch {
    rendered = visible.join("\n");
  }
  return {
    rendered,
    hiddenHunks: starts.length - visibleHunks,
    hiddenLines: lines.length - visible.length,
  };
};

const editSummary = (presentation: NonNullable<Activity["presentation"]>) => {
  if (presentation.kind !== "edit") return undefined;
  const hunks = `${presentation.hunkCount} ${presentation.hunkCount === 1 ? "hunk" : "hunks"}`;
  const line =
    presentation.firstChangedLine === undefined ? "" : ` · line ${presentation.firstChangedLine}`;
  return `${hunks} · +${presentation.addedLines} -${presentation.removedLines}${line}`;
};

const isCancelled = (event: Activity | undefined) =>
  event?.phase === "error" && /abort|cancel|interrupt/i.test(event.error ?? event.result ?? "");

const traceLines = (
  traces: readonly Trace[],
  elapsedMs: number,
  expanded: boolean,
  theme: Palette,
) => {
  const lines: string[] = [];
  for (const trace of traces) {
    const lead = trace.start ?? trace.queued ?? trace.end;
    if (lead === undefined || (!expanded && (trace.end?.selection ?? lead.selection) === "skipped"))
      continue;
    const end = trace.end;
    const queued = trace.start === undefined && end === undefined;
    const active = trace.start !== undefined && end === undefined;
    const cancelled = isCancelled(end);
    const failed = end?.phase === "error" && !cancelled;
    const skipped = end?.phase === "skipped";
    const icon =
      queued || active
        ? theme.fg(active ? "warning" : "dim", "›")
        : cancelled
          ? theme.fg("warning", "!")
          : failed
            ? theme.fg("error", "×")
            : skipped
              ? theme.fg("dim", "–")
              : theme.fg("success", "✓");
    const tool = ACTION_LABELS.get(lead.tool) ?? humanKey(lead.tool);
    const run = lead.tool === "run" ? "$ " : "";
    const target = shortText(lead.target ?? humanKey(lead.step));
    const item = lead.item === undefined ? "" : ` · item ${lead.item + 1}`;
    const detail = lead.detail === undefined ? "" : shortText(lead.detail, 48);
    let summary = "";
    let timing = queued
      ? "ready"
      : active
        ? activeSummary(trace, elapsedMs)
        : duration(end?.elapsedMs ?? 0);
    if (cancelled) {
      timing += ` · cancelled: ${shortText(end?.error ?? "host abort", 72)}`;
    } else if (failed) {
      timing += ` · ${shortText(end?.error ?? "failed", 72)}`;
    } else if (skipped) {
      summary = end?.result ?? "not launched";
    } else if (end !== undefined) {
      const presentation = end.presentation;
      summary =
        presentation === undefined
          ? (end.result ?? "")
          : (editSummary(presentation) ?? end.result ?? "");
    }
    const suffix = [timing, summary, detail].filter(Boolean).join(" · ");
    lines.push(
      `${icon} ${run}${theme.bold(tool)}  ${theme.fg("accent", target)}${item}${theme.fg("dim", ` · ${suffix}`)}`,
    );

    if (end?.presentation?.kind === "edit") {
      const bounded = editDiffLines(end.presentation, expanded);
      if (bounded !== undefined) {
        if (bounded.hiddenHunks > 0)
          lines.push(
            theme.fg(
              "dim",
              `  … ${bounded.hiddenHunks} ${bounded.hiddenHunks === 1 ? "hunk" : "hunks"} hidden · ${bounded.hiddenLines} lines hidden`,
            ),
          );
        if (bounded.rendered.length > 0)
          lines.push(...bounded.rendered.split("\n").map((line) => `  ${line}`));
      }
    }
  }
  return lines;
};

const traceCounts = (traces: readonly Trace[]) => {
  let ready = 0;
  let running = 0;
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  let skipped = 0;
  for (const trace of traces) {
    if (trace.start === undefined && trace.end === undefined) ready += 1;
    else if (trace.end === undefined) running += 1;
    else if (trace.end.phase === "skipped") skipped += 1;
    else if (isCancelled(trace.end)) cancelled += 1;
    else if (trace.end.phase === "error") failed += 1;
    else done += 1;
  }
  return { ready, running, done, failed, cancelled, skipped };
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
    const output = partial ? [] : outputLines(text, expanded, theme);
    if (output.length === 0) return new Text(label, 0, 0);
    if (expanded)
      return new Text(
        [label, theme.fg("dim", "Output"), ...output.map((line) => `  ${line}`)].join("\n"),
        0,
        0,
      );
    return new Text(
      [label, `${theme.fg("dim", "Output")} · ${output.join(" · ")}`].join("\n"),
      0,
      0,
    );
  }
  if (details.status === "invalid") {
    const compact = text.replace(/\s+/g, " ").trim();
    const location = compact.match(/\bline\s+(\d+)(?:[, ]+column\s+(\d+))?/i);
    const where =
      location === null
        ? ""
        : ` line ${location[1]}${location[2] === undefined ? "" : `, column ${location[2]}`}`;
    const correction = compact.match(/(?:Use|Try):\s*(.*)$/i)?.[1];
    const reason =
      compact
        .replace(/\s*(?:Use|Try):\s*.*$/i, "")
        .replace(/\s*\bline\s+\d+(?:[, ]+column\s+\d+)?/i, "")
        .trim() || "source is not valid";
    const lines = [theme.fg("error", "× Invalid source"), `  ${reason}${where}`];
    lines.push(`  ${theme.fg("dim", "Use:")} ${correction ?? 'await read({ path: "file" })'}`);
    return new Text(lines.join("\n"), 0, 0);
  }

  const traces = tracesFrom(details.activity);
  const derived = traceCounts(traces);
  const counts = {
    done: details.done ?? derived.done,
    running: details.active ?? derived.running,
    ready: details.queued ?? derived.ready,
    failed: details.failed ?? derived.failed,
    cancelled: details.cancelled ?? derived.cancelled,
    skipped: details.skipped ?? derived.skipped,
  };
  const state = [
    details.status === "paused" ? "thinking" : "",
    error && counts.failed === 0 && counts.cancelled === 0 ? "failed" : "",
    countLabel(counts.done, "done"),
    countLabel(counts.running, "running"),
    countLabel(counts.ready, "ready"),
    countLabel(counts.failed, "failed"),
    countLabel(counts.cancelled, "cancelled"),
    countLabel(counts.skipped, "not run"),
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [theme.fg(partial ? "warning" : error ? "error" : "muted", state)];
  lines.push(...traceLines(traces, details.elapsedMs, expanded, theme));
  if (expanded && (details.activityHidden ?? 0) > 0)
    lines.push(theme.fg("dim", `… ${details.activityHidden} activities hidden`));
  lines.push(theme.fg("dim", `Timing · ${duration(details.elapsedMs)}`));

  if (!partial && details.status !== "paused") {
    const normalized = text.replace(/\s+/g, " ").trim();
    const repeated = traces.some(
      (trace) =>
        (trace.end?.result !== undefined &&
          trace.end.result.replace(/\s+/g, " ").trim() === normalized) ||
        (trace.end?.error !== undefined &&
          trace.end.error.replace(/\s+/g, " ").trim() === normalized),
    );
    const meaningful =
      normalized.length > 0 && normalized !== "done" && normalized !== "Running" && !repeated;
    const output = meaningful ? outputLines(text, expanded, theme, details.presentation) : [];
    if (output.length > 0) {
      lines.push("", theme.fg("dim", "Output"));
      lines.push(...output.map((line) => `  ${line}`));
    }
  }
  return new Text(lines.join("\n"), 0, 0);
};
