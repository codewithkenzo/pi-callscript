import type {
  ExtensionAPI,
  ExtensionContext,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { isMode, loadConfig } from "./config.js";
import { CallScriptRuntime } from "./runtime.js";
import {
  DESCRIBE_TOOL,
  EXTENSION_TOOLS,
  MAIN_TOOL,
  SEARCH_TOOL,
  STATE_ENTRY,
  type Activity,
  type Mode,
  type PersistedMode,
  type RunDetails,
  type ToolLookupDetails,
} from "./types.js";
import {
  renderLookupCall,
  renderLookupResult,
  renderScriptCall,
  renderScriptResult,
} from "./ui.js";

const ExecuteSchema = Type.Object(
  {
    script: Type.String({
      maxLength: 262_144,
      description:
        "CallScript JavaScript source. It is parsed into an inert plan and never evaluated as JavaScript.",
    }),
  },
  { additionalProperties: false },
);

const SearchSchema = Type.Object(
  {
    query: Type.String({ maxLength: 200 }),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);

const DescribeSchema = Type.Object(
  { names: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 50 }) },
  { additionalProperties: false },
);

const RunStateSchema = Type.Object(
  {
    version: Type.Literal("2"),
    script: Type.Object(
      {
        steps: Type.Array(Type.Object({ id: Type.String() }, { additionalProperties: true })),
      },
      { additionalProperties: true },
    ),
    status: Type.Union([
      Type.Literal("done"),
      Type.Literal("returned"),
      Type.Literal("error"),
      Type.Literal("suspended"),
    ]),
    steps: Type.Record(
      Type.String(),
      Type.Object(
        {
          hash: Type.String(),
          status: Type.Union([
            Type.Literal("done"),
            Type.Literal("skipped"),
            Type.Literal("returned"),
            Type.Literal("error"),
            Type.Literal("suspended"),
          ]),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const PersistedModeSchema = Type.Object(
  {
    version: Type.Literal(1),
    mode: Type.Union([Type.Literal("off"), Type.Literal("on")]),
  },
  { additionalProperties: false },
);

const ToolSummarySchema = Type.Object(
  {
    name: Type.String(),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ToolLookupDetailsSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("search"), Type.Literal("describe")]),
    query: Type.Optional(Type.String()),
    tools: Type.Array(ToolSummarySchema),
  },
  { additionalProperties: false },
);

const extensionToolSet: ReadonlySet<string> = new Set(EXTENSION_TOOLS);
const activityPhases: ReadonlySet<string> = new Set([
  "queued",
  "start",
  "done",
  "error",
  "skipped",
]);
const runStatuses: ReadonlySet<string> = new Set(["running", "paused", "ok", "error", "invalid"]);

const isActivity = (value: unknown): value is Activity => {
  if (value === null || typeof value !== "object") return false;
  if (
    !("sequence" in value) ||
    typeof value.sequence !== "number" ||
    !Number.isFinite(value.sequence) ||
    !("atMs" in value) ||
    typeof value.atMs !== "number" ||
    !Number.isFinite(value.atMs) ||
    !("step" in value) ||
    typeof value.step !== "string" ||
    !("tool" in value) ||
    typeof value.tool !== "string" ||
    !("phase" in value) ||
    typeof value.phase !== "string" ||
    !activityPhases.has(value.phase)
  )
    return false;
  if (
    "item" in value &&
    value.item !== undefined &&
    (typeof value.item !== "number" || !Number.isFinite(value.item))
  )
    return false;
  if (
    "elapsedMs" in value &&
    value.elapsedMs !== undefined &&
    (typeof value.elapsedMs !== "number" || !Number.isFinite(value.elapsedMs))
  )
    return false;
  if (
    "timeoutMs" in value &&
    value.timeoutMs !== undefined &&
    (typeof value.timeoutMs !== "number" || !Number.isFinite(value.timeoutMs))
  )
    return false;
  if (
    "expectedMs" in value &&
    value.expectedMs !== undefined &&
    (typeof value.expectedMs !== "number" || !Number.isFinite(value.expectedMs))
  )
    return false;
  if ("target" in value && value.target !== undefined && typeof value.target !== "string")
    return false;
  if ("detail" in value && value.detail !== undefined && typeof value.detail !== "string")
    return false;
  if ("result" in value && value.result !== undefined && typeof value.result !== "string")
    return false;
  return !("error" in value && value.error !== undefined && typeof value.error !== "string");
};

export const isRunDetails = (value: unknown): value is RunDetails => {
  if (value === null || typeof value !== "object") return false;
  return (
    "version" in value &&
    value.version === 1 &&
    "mode" in value &&
    (value.mode === "on" || value.mode === "off") &&
    "status" in value &&
    typeof value.status === "string" &&
    runStatuses.has(value.status) &&
    "elapsedMs" in value &&
    typeof value.elapsedMs === "number" &&
    Number.isFinite(value.elapsedMs) &&
    "calls" in value &&
    typeof value.calls === "number" &&
    Number.isFinite(value.calls) &&
    "completed" in value &&
    typeof value.completed === "number" &&
    Number.isFinite(value.completed) &&
    "active" in value &&
    typeof value.active === "number" &&
    Number.isFinite(value.active) &&
    "activity" in value &&
    Array.isArray(value.activity) &&
    value.activity.every(isActivity)
  );
};

const isPersistedMode = (value: unknown): value is PersistedMode =>
  Value.Check(PersistedModeSchema, value);

const isToolLookupDetails = (value: unknown): value is ToolLookupDetails =>
  Value.Check(ToolLookupDetailsSchema, value);

const restoredState = (ctx: ExtensionContext) => {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type !== "message" ||
      entry.message.role !== "toolResult" ||
      entry.message.toolName !== MAIN_TOOL
    ) {
      continue;
    }
    const candidate: unknown = entry.message.details;
    if (isRunDetails(candidate) && Value.Check(RunStateSchema, candidate.state))
      return candidate.state;
  }
  return undefined;
};

const restoredMode = (ctx: ExtensionContext) => {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
    if (isPersistedMode(entry.data)) return entry.data.mode;
  }
  return undefined;
};

const resultText = (result: { content: Array<{ type: string; text?: string }> }) => {
  const only = result.content.length === 1 ? result.content[0] : undefined;
  if (only?.type === "text") return only.text ?? "";
  const text: string[] = [];
  for (const entry of result.content) {
    if (entry.type === "text") text.push(entry.text ?? "");
  }
  return text.join("\n");
};

export const CALLSCRIPT_TOOL_DESCRIPTION =
  "Execute one bounded, inert JavaScript-shaped tool plan. Mounted calls: read, write, edit, search, find, list, run, http, wait, think, snapshot, and undo. Bind results with const, await dependencies, use Promise.all for independent calls, and return only what the next reasoning pass needs. Un-awaited calls become session jobs and can be joined by name later. Use callscript_search or callscript_describe when a signature is unclear.";

export const CALLSCRIPT_MODE_PROMPT =
  "CallScript mode replaces the normal tools. Work in short evidence-driven phases: parallelize independent calls, await dependencies, then stop and reason before evidence-dependent work. Use think for an explicit checkpoint and snapshot before changes that may need undo.";

export default async function callscriptExtension(pi: ExtensionAPI) {
  let config = await Effect.runPromise(loadConfig(process.cwd()));
  let runtime = new CallScriptRuntime(process.cwd(), config);
  let mode: Mode = config.mode;
  let normalTools: string[] = [];

  const captureNormalTools = () => {
    normalTools = pi.getActiveTools().filter((name) => !extensionToolSet.has(name));
  };

  const applyMode = (ctx: ExtensionContext) => {
    pi.setActiveTools(mode === "on" ? [...EXTENSION_TOOLS] : normalTools);
    ctx.ui.setStatus(STATE_ENTRY, mode === "on" ? "callscript" : undefined);
  };

  const rebuild = (ctx: ExtensionContext, keepState: boolean) =>
    Effect.gen(function* () {
      const state = keepState ? runtime.scope.state : restoredState(ctx);
      const nextConfig = yield* loadConfig(ctx.cwd);
      const nextRuntime = new CallScriptRuntime(ctx.cwd, nextConfig);
      yield* nextRuntime.restore(state);
      yield* runtime.reset();
      config = nextConfig;
      runtime = nextRuntime;
    });

  pi.registerTool({
    name: MAIN_TOOL,
    label: "callscript",
    description: CALLSCRIPT_TOOL_DESCRIPTION,
    parameters: ExecuteSchema,
    executionMode: "sequential",
    async execute(toolCallId, { script }, signal, onUpdate, ctx) {
      const result = await Effect.runPromise(
        runtime.execute(script, {
          id: toolCallId,
          signal,
          ctx,
          update: onUpdate,
        }),
      );
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
        isError: result.isError,
      };
    },
    renderCall({ script }, theme, context) {
      const phase = !context.isPartial ? "settled" : context.executionStarted ? "running" : "ready";
      return renderScriptCall(script, context.expanded, phase, theme);
    },
    renderResult(result, options: ToolRenderResultOptions, theme, context) {
      const candidate: unknown = result.details;
      return renderScriptResult(
        resultText(result),
        isRunDetails(candidate) ? candidate : undefined,
        options.expanded,
        options.isPartial,
        context.isError,
        theme,
      );
    },
  });

  pi.registerTool({
    name: SEARCH_TOOL,
    label: "Find tools",
    description: "Find CallScript tools by name, purpose, or argument field.",
    parameters: SearchSchema,
    async execute(_toolCallId, { query, limit }) {
      const result = runtime.search(query, limit);
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
    renderCall({ query }, theme, context) {
      const phase = !context.isPartial ? "settled" : context.executionStarted ? "running" : "ready";
      return renderLookupCall("search", query, phase, theme);
    },
    renderResult(result, options, theme) {
      const candidate: unknown = result.details;
      return renderLookupResult(
        isToolLookupDetails(candidate) ? candidate : undefined,
        options.expanded,
        options.isPartial,
        theme,
      );
    },
  });

  pi.registerTool({
    name: DESCRIBE_TOOL,
    label: "Tool details",
    description: "Show full signatures for named CallScript tools before writing a script.",
    parameters: DescribeSchema,
    async execute(_toolCallId, { names }) {
      const result = runtime.describe(names);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
    renderCall({ names }, theme, context) {
      const phase = !context.isPartial ? "settled" : context.executionStarted ? "running" : "ready";
      return renderLookupCall("describe", names.join(" · "), phase, theme);
    },
    renderResult(result, options, theme) {
      const candidate: unknown = result.details;
      return renderLookupResult(
        isToolLookupDetails(candidate) ? candidate : undefined,
        options.expanded,
        options.isPartial,
        theme,
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    captureNormalTools();
    await Effect.runPromise(rebuild(ctx, false));
    mode = restoredMode(ctx) ?? config.mode;
    applyMode(ctx);
  });

  pi.on("before_agent_start", (event) => {
    if (mode === "off") return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${CALLSCRIPT_MODE_PROMPT}`,
    };
  });

  pi.registerCommand("callscript", {
    description: "Toggle CallScript mode or run on, off, status, reload, reset",
    async handler(args, ctx) {
      const command = args.trim().toLowerCase();
      if (command === "status") {
        ctx.ui.notify(
          `CallScript is ${mode}; ${runtime.tools.length} tools; concurrency ${config.limits.maxConcurrency}.`,
        );
        return;
      }
      if (command === "reload") {
        await Effect.runPromise(rebuild(ctx, true));
        applyMode(ctx);
        ctx.ui.notify("CallScript reloaded.", "info");
        return;
      }
      if (command === "reset") {
        await Effect.runPromise(runtime.reset());
        ctx.ui.notify("CallScript state reset.", "info");
        return;
      }
      const nextMode = command.length === 0 ? (mode === "on" ? "off" : "on") : command;
      if (isMode(nextMode)) {
        if (mode === "off" && nextMode === "on") captureNormalTools();
        mode = nextMode;
      } else {
        ctx.ui.notify("Usage: /callscript [on|off|status|reload|reset]", "warning");
        return;
      }
      pi.appendEntry<PersistedMode>(STATE_ENTRY, { version: 1, mode });
      applyMode(ctx);
      ctx.ui.notify(`CallScript ${mode}.`, "info");
    },
  });
}
