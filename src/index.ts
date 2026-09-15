import type {
  ExtensionAPI,
  ExtensionContext,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { isMode, loadConfig } from "./config.js";
import { PiToolBridge } from "./pi-tool-bridge.js";
import { CallScriptRuntime } from "./runtime.js";
import {
  JOB_STATE_ENTRY,
  MAIN_TOOL,
  STATE_ENTRY,
  type JobReceipt,
  type Mode,
  type PersistedJobReceipt,
  type PersistedMode,
  type RunDetails,
} from "./types.js";
import { renderScriptCall, renderScriptResult } from "./ui.js";

const ScriptSchema = Type.String({
  maxLength: 262_144,
  description:
    "CallScript JavaScript source. It is parsed into an inert plan and never evaluated as JavaScript.",
});

const CountSchema = Type.Integer({
  minimum: 1,
  description: "Release next N queued call steps. Omit to release all until next think.",
});

const FromScratchSchema = Type.Boolean({
  description: "Discard retained execution state before running replacement plan.",
});

const DecisionSchema = Type.String({
  enum: ["continue", "stop", "replace"],
  description: "Checkpoint action. Omit for a new script.",
});

const ExecuteSchema = Type.Object(
  {
    script: Type.Optional(ScriptSchema),
    decision: Type.Optional(DecisionSchema),
    count: Type.Optional(CountSchema),
    fromScratch: Type.Optional(FromScratchSchema),
  },
  {
    additionalProperties: false,
    description:
      "Pass script for a new plan. At a checkpoint, pass continue, stop, or replace with its required fields.",
  },
);

const StrictExecuteSchema = Type.Union([
  Type.Object({ script: ScriptSchema }, { additionalProperties: false }),
  Type.Object(
    {
      decision: Type.Literal("continue"),
      count: Type.Optional(CountSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object({ decision: Type.Literal("stop") }, { additionalProperties: false }),
  Type.Object(
    {
      decision: Type.Literal("replace"),
      script: ScriptSchema,
      fromScratch: Type.Optional(FromScratchSchema),
    },
    { additionalProperties: false },
  ),
]);

const StrictProviderInputSchema = Type.Object(
  {
    script: Type.Optional(Type.Union([ScriptSchema, Type.Null()])),
    decision: Type.Optional(Type.Union([DecisionSchema, Type.Null()])),
    count: Type.Optional(Type.Union([CountSchema, Type.Null()])),
    fromScratch: Type.Optional(Type.Union([FromScratchSchema, Type.Null()])),
  },
  { additionalProperties: false },
);

type StrictProviderInput = Static<typeof StrictProviderInputSchema>;
type ExecuteInput = Static<typeof ExecuteSchema>;

const normalizeStrictOptionalNulls = (input: StrictProviderInput): ExecuteInput => {
  const normalized: ExecuteInput = {};
  if (input.script !== null && input.script !== undefined) normalized.script = input.script;
  if (input.decision !== null && input.decision !== undefined) normalized.decision = input.decision;
  if (input.count !== null && input.count !== undefined) normalized.count = input.count;
  if (input.fromScratch !== null && input.fromScratch !== undefined)
    normalized.fromScratch = input.fromScratch;
  return normalized;
};

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

const ActivitySchema = Type.Object(
  {
    sequence: Type.Number(),
    atMs: Type.Number(),
    step: Type.String(),
    tool: Type.String(),
    phase: Type.Union([
      Type.Literal("queued"),
      Type.Literal("start"),
      Type.Literal("done"),
      Type.Literal("error"),
      Type.Literal("skipped"),
    ]),
    item: Type.Optional(Type.Number()),
    elapsedMs: Type.Optional(Type.Number()),
    target: Type.Optional(Type.String()),
    detail: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    expectedMs: Type.Optional(Type.Number()),
    result: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    selection: Type.Optional(Type.Union([Type.Literal("selected"), Type.Literal("skipped")])),
  },
  { additionalProperties: true },
);

const RunDetailsSchema = Type.Object(
  {
    version: Type.Literal(1),
    mode: Type.Union([Type.Literal("off"), Type.Literal("on")]),
    status: Type.Union([
      Type.Literal("running"),
      Type.Literal("paused"),
      Type.Literal("ok"),
      Type.Literal("error"),
      Type.Literal("invalid"),
    ]),
    elapsedMs: Type.Number(),
    calls: Type.Number(),
    completed: Type.Number(),
    active: Type.Number(),
    activity: Type.Array(ActivitySchema),
  },
  { additionalProperties: true },
);

const JobReceiptSchema = Type.Object(
  {
    id: Type.String(),
    label: Type.String(),
    status: Type.Union([
      Type.Literal("running"),
      Type.Literal("done"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
      Type.Literal("unavailable"),
    ]),
    repeatSafe: Type.Boolean(),
    output: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const isRunDetails = <T>(value: T): value is T & RunDetails =>
  Value.Check(RunDetailsSchema, value);

const PersistedJobReceiptSchema = Type.Object(
  {
    version: Type.Literal(1),
    job: JobReceiptSchema,
  },
  { additionalProperties: false },
);

const isPersistedMode = <T>(value: T): value is T & PersistedMode =>
  Value.Check(PersistedModeSchema, value);

const isPersistedJobReceipt = <T>(value: T): value is T & PersistedJobReceipt =>
  Value.Check(PersistedJobReceiptSchema, value);

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

const restoredJobs = (ctx: ExtensionContext): readonly JobReceipt[] | undefined => {
  const jobs = new Map<string, JobReceipt>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === JOB_STATE_ENTRY) {
      if (isPersistedJobReceipt(entry.data)) jobs.set(entry.data.job.id, entry.data.job);
      continue;
    }
    if (
      entry.type !== "message" ||
      entry.message.role !== "toolResult" ||
      entry.message.toolName !== MAIN_TOOL
    )
      continue;
    const candidate: unknown = entry.message.details;
    if (!isRunDetails(candidate) || !Value.Check(Type.Array(JobReceiptSchema), candidate.jobs))
      continue;
    for (const job of candidate.jobs) jobs.set(job.id, job);
  }
  return jobs.size === 0 ? undefined : [...jobs.values()];
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
  "Execute one bounded, inert JavaScript-shaped plan over fixed capabilities and registered Pi tools through pi({ tool, args }).";

export const CALLSCRIPT_MODE_PROMPT =
  'CallScript is available beside other Pi tools. Use fixed capabilities directly. Discover registered Pi tools with tools({ query }) and invoke them through pi({ tool, args }). Work in short evidence-driven phases: parallelize independent fixed calls and await dependencies. Bridged Pi calls serialize and are never repeat-safe. think creates a decision checkpoint. After reasoning, call callscript with { decision: "continue" }, { decision: "continue", count: N }, { decision: "stop" }, or { decision: "replace", script, fromScratch? }. Do not resubmit an initial script while a checkpoint is pending. Use snapshot before changes that may need undo.';

export const activeToolsForMode = (mode: Mode, currentTools: readonly string[]) => {
  if (mode === "off") return currentTools.filter((name) => name !== MAIN_TOOL);
  const activeTools = [...new Set(currentTools)];
  if (!activeTools.includes(MAIN_TOOL)) activeTools.push(MAIN_TOOL);
  return activeTools;
};

export default async function callscriptExtension(pi: ExtensionAPI) {
  const piTools = await PiToolBridge.create();
  const persistJob = (job: JobReceipt) =>
    pi.appendEntry<PersistedJobReceipt>(JOB_STATE_ENTRY, { version: 1, job });
  let config = await Effect.runPromise(loadConfig(process.cwd()));
  let runtime = new CallScriptRuntime(process.cwd(), config, persistJob, piTools);
  let mode: Mode = config.mode;

  const applyMode = (ctx: ExtensionContext) => {
    pi.setActiveTools(activeToolsForMode(mode, pi.getActiveTools()));
    ctx.ui.setStatus(STATE_ENTRY, mode === "on" ? "callscript" : undefined);
  };

  const rebuild = (ctx: ExtensionContext, keepState: boolean) =>
    Effect.gen(function* () {
      const state = keepState ? runtime.scope.state : restoredState(ctx);
      const jobs = keepState ? runtime.jobs() : restoredJobs(ctx);
      const nextConfig = yield* loadConfig(ctx.cwd);
      const nextRuntime = new CallScriptRuntime(ctx.cwd, nextConfig, persistJob, piTools);
      yield* nextRuntime.restore(state);
      yield* nextRuntime.restoreJobs(jobs);
      yield* runtime.reset();
      config = nextConfig;
      runtime = nextRuntime;
    });

  pi.registerTool({
    name: MAIN_TOOL,
    label: "callscript",
    description: `${CALLSCRIPT_TOOL_DESCRIPTION}\n\n${runtime.languageCard()}`,
    parameters: ExecuteSchema,
    executionMode: "sequential",
    prepareArguments(input) {
      return normalizeStrictOptionalNulls(Value.Parse(StrictProviderInputSchema, input));
    },
    async execute(toolCallId, input, signal, onUpdate, ctx) {
      const invocation = {
        id: toolCallId,
        signal,
        ctx,
        update: onUpdate,
      };
      const parsed = Value.Parse(StrictExecuteSchema, input);
      const result = await Effect.runPromise(
        "decision" in parsed
          ? runtime.decide(
              parsed.decision === "replace"
                ? parsed.fromScratch === undefined
                  ? { action: "replace", script: parsed.script }
                  : {
                      action: "replace",
                      script: parsed.script,
                      fromScratch: parsed.fromScratch,
                    }
                : parsed.decision === "continue"
                  ? parsed.count === undefined
                    ? { action: "continue" }
                    : { action: "continue", count: parsed.count }
                  : { action: "stop" },
              invocation,
            )
          : runtime.execute(parsed.script, invocation),
      );
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
        isError: result.isError,
      };
    },
    renderCall(input, theme, context) {
      const phase = !context.isPartial ? "settled" : context.executionStarted ? "running" : "ready";
      const source =
        "script" in input
          ? input.script
          : input.decision === "continue" && input.count !== undefined
            ? `checkpoint: continue next ${input.count}`
            : `checkpoint: ${input.decision}`;
      return renderScriptCall(source, context.expanded, phase, theme);
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

  pi.on("session_start", async (_event, ctx) => {
    piTools.capture(pi);
    await Effect.runPromise(rebuild(ctx, false));
    mode = restoredMode(ctx) ?? config.mode;
    applyMode(ctx);
  });

  pi.on("before_agent_start", (event) => {
    if (mode === "off") return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${CALLSCRIPT_MODE_PROMPT}\n\n${runtime.languageCard()}`,
    };
  });

  pi.registerCommand("callscript", {
    description: "CallScript help, doctor, jobs, mode, reload, and reset",
    async handler(args, ctx) {
      const command = args.trim().toLowerCase();
      if (command === "status") {
        const bridge = piTools.status();
        const bridgeText = bridge.available
          ? `${bridge.tools} Pi tools via ${bridge.host} bridge`
          : `Pi bridge unavailable: ${bridge.reason ?? "unsupported host"}`;
        ctx.ui.notify(
          `CallScript is ${mode} and additive; ${runtime.tools.length} fixed tools; ${bridgeText}; concurrency ${config.limits.maxConcurrency}.`,
        );
        return;
      }
      if (command === "help") {
        ctx.ui.notify(
          "Usage: /callscript [on|off|status|jobs|help|doctor|reload|reset]. Use fixed capabilities directly. Use tools({ query }) plus pi({ tool, args }) for registered Pi tools.",
          "info",
        );
        return;
      }
      if (command === "doctor") {
        const bridge = piTools.status();
        const bridgeText = bridge.available
          ? `ready (${bridge.host}, ${bridge.tools} tools)`
          : `unavailable (${bridge.reason ?? "unsupported host"})`;
        ctx.ui.notify(
          `CallScript doctor: ready; Pi bridge ${bridgeText}; ${runtime.tools.length} fixed capabilities; output bound ${config.maxOutputBytes ?? 10_240} bytes; HTTP bound ${config.maxHttpResultBytes} bytes.`,
          "info",
        );
        return;
      }
      if (command === "jobs") {
        ctx.ui.notify(runtime.jobsText(), "info");
        return;
      }
      if (command === "reload") {
        piTools.capture(pi);
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
        mode = nextMode;
      } else {
        ctx.ui.notify(
          "Usage: /callscript [on|off|status|jobs|help|doctor|reload|reset]",
          "warning",
        );
        return;
      }
      pi.appendEntry<PersistedMode>(STATE_ENTRY, { version: 1, mode });
      applyMode(ctx);
      ctx.ui.notify(`CallScript ${mode}.`, "info");
    },
  });
}
