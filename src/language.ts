import {
  jsLanguageCard,
  ScriptValidationError,
  toolCards,
  type AnyScriptTool,
  type ScriptLimits,
} from "callscript";

const REPLACEMENTS = {
  CS001: 'const result = await read({ path: "file.txt" }); return result;',
  CS002: 'const matches = await search({ pattern: "TODO", path: "src" }); return matches;',
  CS003:
    'Inspect callable tools with tools({ query: "name" }). Call fixed tools, bash/grep/ls, or an exact Pi tool name directly; otherwise use pi({ tool: "exact_name", args: { ... } }).',
  CS004: 'const result = await read({ path: "file.txt", offset: 1, limit: 200 }); return result;',
  CS005:
    "Use either read({ path, tail }) or read({ path, offset, limit }), not both tail and offset.",
  CS006: "Inspect job status. Retry mutation only through an explicitly repeat-safe operation.",
  CS007: "Run /callscript jobs. Start replacement work only when listed repeatSafe is true.",
  CS008:
    'Scripts cannot define or call local functions. Write the call inline: Promise.all(items.slice(0, 20).map((item) => pi({ tool: "name", args: { item } }))).',
} as const;

const ESCAPE_REPLACEMENT =
  'In string literals a backslash starts an escape: write "\\\\" for one backslash or use forward slashes in paths; "\\u" must be followed by 4 hex digits.';

const HELPER_DECLARATION =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>|\bfunction\s+([A-Za-z_$][\w$]*)/g;
const HELPER_FAILURES = [
  "call options must be",
  "fan out with an arrow",
  "element must be a tool call",
];
const PARSE_POSITION = /\((\d+):(\d+)\)\s*$/;
const SNIPPET_RADIUS = 30;

export type ValidationCode = keyof typeof REPLACEMENTS;

const localHelper = (source: string, messages: readonly string[]) => {
  for (const declaration of source.matchAll(HELPER_DECLARATION)) {
    const name = declaration[1] ?? declaration[2];
    if (name === undefined) continue;
    const failed =
      messages.some((message) => message.includes(`Unknown tool "${name}"`)) ||
      messages.some((message) => HELPER_FAILURES.some((marker) => message.includes(marker)));
    if (!failed) continue;
    const escaped = name.replaceAll("$", "\\$");
    const used = new RegExp(`(?:^|[^\\w$.])${escaped}\\s*\\(|\\(\\s*${escaped}\\s*\\)`);
    if (used.test(source.slice((declaration.index ?? 0) + declaration[0].length))) return name;
  }
  return undefined;
};

const nearSnippet = (message: string, source: string) => {
  const position = PARSE_POSITION.exec(message);
  if (position === null) return undefined;
  const text = source.split("\n")[Number(position[1]) - 1];
  if (text === undefined) return undefined;
  const column = Math.min(Number(position[2]), text.length);
  const start = Math.max(0, column - SNIPPET_RADIUS);
  const before = text.slice(start, column);
  const after = text.slice(column, column + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${before}<here>${after}${column + SNIPPET_RADIUS < text.length ? "…" : ""}`;
};

const codeFor = (message: string): ValidationCode => {
  const lower = message.toLowerCase();
  if (lower.includes("tail") && lower.includes("offset")) return "CS005";
  if (lower.includes("unknown or expired") || lower.includes("unavailable job")) return "CS007";
  if (lower.includes("repeat-safe")) return "CS006";
  if (lower.includes("unknown tool") || lower.includes("not mounted")) return "CS003";
  if (
    lower.includes("tagged template") ||
    lower.includes("regex") ||
    lower.includes("function") ||
    lower.includes(".catch")
  )
    return "CS002";
  if (lower.includes("parse") || lower.includes("unexpected token")) return "CS001";
  return "CS004";
};

export const validationMessage = (cause: unknown, source: string | undefined = undefined) => {
  const messages =
    cause instanceof ScriptValidationError
      ? cause.issues.map((issue) => `${issue.path}: ${issue.message}`)
      : [cause instanceof Error ? cause.message : String(cause)];
  const helper = source === undefined ? undefined : localHelper(source, messages);
  if (helper !== undefined)
    return `CS008: "${helper}" is a local function; only mounted tools can be called.\nReplacement: ${REPLACEMENTS.CS008}`;
  return messages
    .map((message) => {
      if (/^CS00\d:/.test(message)) return message;
      const code = codeFor(message);
      const near = source === undefined ? undefined : nearSnippet(message, source);
      const replacement =
        code === "CS001" && /escape sequence/i.test(message)
          ? ESCAPE_REPLACEMENT
          : REPLACEMENTS[code];
      const location = near === undefined ? "" : `\nNear: ${near}`;
      return `${code}: ${message}${location}\nReplacement: ${replacement}`;
    })
    .join("\n");
};

export const recoveryMessage = (code: "CS006" | "CS007", message: string) =>
  `${code}: ${message}\nRecovery: ${REPLACEMENTS[code]}`;

const EXTRA_LANGUAGE = `
Supported forms: top-level const declarations; direct await; static Promise.all; bounded slice(...).map(...) fan-out; data dependencies; if guards; try/catch recovery; explicit think decisions.
At think, choose { decision: "continue" }, { decision: "continue", count: N }, { decision: "stop" }, or { decision: "replace", script, fromScratch? }. A pending checkpoint rejects a new initial script.
Unsupported forms: tagged templates; wrapper callbacks; local functions that call tools; computed callback bodies; regex literals; per-call .catch.
A failing call, including a timeout, fails the run. Wrap it in try/catch to recover, or pass { onError: "skip" } as the call's second argument to continue with an undefined result.
A returned value over about 10 KiB is cut with a truncation marker. Page by returning slices (list.slice(i, j), text.slice(a, b)) or compact projections; full values stay usable inside the script.
Detached calls return stable job IDs. Join a later run with await <job binding>. Mutating work is never retried unless repeat-safe.
Aliases: bash = run, grep = search, ls = list.
Pi tools: every other registered Pi tool is also callable by its exact name when the name is a valid identifier; list names and schemas with tools({ query? }). Other names, and tools registered after the last reload, go through pi({ tool, args }). callscript recursion is blocked. Pi calls serialize and are never repeat-safe.`;

export const languageCard = (tools: readonly AnyScriptTool[], limits: Partial<ScriptLimits>) =>
  [jsLanguageCard({ limits }), `## tools\n${toolCards(tools)}`, EXTRA_LANGUAGE.trim()].join("\n\n");

export const validationReplacement = (code: ValidationCode) => REPLACEMENTS[code];
