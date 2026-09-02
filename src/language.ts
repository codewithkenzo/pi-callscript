import { ScriptValidationError, type ScriptEngine } from "callscript";

const REPLACEMENTS = {
  CS001: 'const result = await read({ path: "file.txt" }); return result;',
  CS002: 'const matches = await search({ pattern: "TODO", path: "src" }); return matches;',
  CS003: "Use owning Pi tool directly for Fabric, FFF, MCP, subagent, or extension work.",
  CS004: 'const result = await read({ path: "file.txt", offset: 1, limit: 200 }); return result;',
  CS005:
    "Use either read({ path, tail }) or read({ path, offset, limit }), not both tail and offset.",
  CS006: "Inspect job status. Retry mutation only through an explicitly repeat-safe operation.",
  CS007: "Run /callscript jobs. Start replacement work only when listed repeatSafe is true.",
} as const;

export type ValidationCode = keyof typeof REPLACEMENTS;

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

export const validationMessage = (cause: unknown) => {
  const messages =
    cause instanceof ScriptValidationError
      ? cause.issues.map((issue) => `${issue.path}: ${issue.message}`)
      : [cause instanceof Error ? cause.message : String(cause)];
  return messages
    .map((message) => {
      if (/^CS00\d:/.test(message)) return message;
      const code = codeFor(message);
      return `${code}: ${message}\nReplacement: ${REPLACEMENTS[code]}`;
    })
    .join("\n");
};

export const recoveryMessage = (code: "CS006" | "CS007", message: string) =>
  `${code}: ${message}\nRecovery: ${REPLACEMENTS[code]}`;

const EXTRA_LANGUAGE = `
Supported forms: top-level const declarations; direct await; static Promise.all; bounded slice(...).map(...) fan-out; data dependencies; if guards; try/catch recovery; unchanged-script think resume.
Unsupported forms: tagged templates; wrapper callbacks; computed callback bodies; regex literals; per-call .catch.
Detached calls return stable job IDs. Join a later run with await <job binding>. Mutating work is never retried unless repeat-safe.
Routing: use owning Pi tools directly for Fabric, FFF, MCP, subagent, and extension work. CallScript tools inspect only its fixed capabilities.`;

export const languageCard = (engine: Pick<ScriptEngine<readonly never[]>, "describe">) =>
  `${engine.describe().trim()}\n\n${EXTRA_LANGUAGE.trim()}`;

export const validationReplacement = (code: ValidationCode) => REPLACEMENTS[code];
