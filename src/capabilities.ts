import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type AgentToolResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  earlyReturn,
  isCallStep,
  tool,
  type AnyScriptTool,
  type CallStep,
  type JsonSchema,
  type JsonValue,
  type Script,
  type ToolCallContext,
} from "callscript";
import { Chunk, Effect, Ref } from "effect";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { StreamUpdateFailure, ToolInvocationFailure } from "./errors.js";
import { SnapshotStore } from "./snapshots.js";
import type { Activity, ActivityState, ExtensionConfig, Invocation, RunDetails } from "./types.js";

type InvocationSource = () => Invocation;
type ActivityBase = Omit<Activity, "sequence" | "atMs" | "phase" | "elapsedMs">;
type ActivityEvent = Omit<Activity, "sequence" | "atMs">;

interface ActivityMeta {
  target?: string;
  detail?: string;
  timeoutMs?: number;
  expectedMs?: number;
}

interface OperationResult<T> {
  value: T;
  summary: string;
}

const STREAM_INTERVAL_MS = 50;
const elapsedSince = (startedAt: number) => Math.max(0, Math.round(performance.now() - startedAt));

const jsonSchema = (schema: TSchema): JsonSchema => ({ ...schema });

const progressDetails = (active: Invocation, state: ActivityState): RunDetails => {
  return {
    version: 1,
    mode: "on",
    status: "running",
    elapsedMs: elapsedSince(active.startedAt),
    calls: state.calls,
    completed: state.completed,
    active: state.calls - state.completed,
    activity: Chunk.toArray(state.events),
  };
};

const publish = (active: Invocation, update: Parameters<NonNullable<Invocation["update"]>>[0]) => {
  const send = active.update;
  if (send === undefined) return Effect.void;
  return Effect.try({
    try: () => send(update),
    catch: StreamUpdateFailure.from,
  }).pipe(Effect.asVoid);
};

const publishUntilFailure = (
  active: Invocation,
  update: Parameters<NonNullable<Invocation["update"]>>[0],
) =>
  publish(active, update).pipe(
    Effect.catchTag("StreamUpdateFailure", () => Ref.set(active.streamOpen, false)),
  );

const report = (active: Invocation, event: ActivityEvent) =>
  Effect.gen(function* () {
    const now = performance.now();
    const state = yield* Ref.updateAndGet(active.activity, (current) => {
      const activity: Activity = {
        ...event,
        sequence: current.events.length + 1,
        atMs: elapsedSince(active.startedAt),
      };
      return {
        events: Chunk.append(current.events, activity),
        calls: current.calls + (event.phase === "start" ? 1 : 0),
        completed: current.completed + (event.phase === "done" || event.phase === "error" ? 1 : 0),
      };
    });
    if (active.update === undefined) return;
    const lastUpdateAt = yield* Ref.get(active.lastUpdateAt);
    const streamOpen = yield* Ref.get(active.streamOpen);
    const shouldUpdate =
      state.events.length === 1 ||
      event.phase === "error" ||
      now - lastUpdateAt >= STREAM_INTERVAL_MS;
    if (!streamOpen || !shouldUpdate) return;

    yield* Ref.set(active.lastUpdateAt, now);
    const current = progressDetails(active, state);
    yield* publishUntilFailure(active, {
      content: [
        {
          type: "text",
          text: `◌ ${current.active} running · ${current.completed} done`,
        },
      ],
      details: current,
    });
  });

const PlannedArgsSchema = Type.Object(
  {
    path: Type.Optional(Type.String()),
    pattern: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    timeout: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    url: Type.Optional(Type.String()),
    method: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    milliseconds: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    note: Type.Optional(Type.String()),
    paths: Type.Optional(Type.Array(Type.String())),
    snapshot: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

type PlannedArgs = Static<typeof PlannedArgsSchema>;

const plannedArgs = (value: JsonValue | undefined): PlannedArgs | undefined =>
  Value.Check(PlannedArgsSchema, value) ? value : undefined;

const NumberValueSchema = Type.Number();

const milliseconds = (value: string | number | undefined) =>
  Value.Check(NumberValueSchema, value) ? value : undefined;

const plannedMeta = (step: CallStep, config: ExtensionConfig): ActivityMeta => {
  const args = plannedArgs(step.args);
  const path = args?.path;
  switch (step.call) {
    case "read":
    case "write":
    case "edit":
      return { target: path ?? step.id };
    case "search":
    case "find": {
      const meta: ActivityMeta = { target: path ?? "." };
      if (args?.pattern !== undefined) meta.detail = args.pattern;
      else if (step.each !== undefined) meta.detail = "fan-out";
      return meta;
    }
    case "list":
      return { target: path ?? "." };
    case "run": {
      const timeout = milliseconds(args?.timeout);
      const meta: ActivityMeta = { target: args?.command ?? step.id };
      if (timeout !== undefined) meta.timeoutMs = timeout * 1_000;
      return meta;
    }
    case "http": {
      const timeout = milliseconds(args?.timeoutMs);
      return {
        target: args?.url ?? step.id,
        detail: args?.method ?? "GET",
        timeoutMs: timeout ?? config.httpTimeoutMs,
      };
    }
    case "wait": {
      const expectedMs = milliseconds(args?.milliseconds);
      const meta: ActivityMeta = {
        target: expectedMs === undefined ? step.id : `${expectedMs} ms`,
      };
      if (expectedMs !== undefined) meta.expectedMs = expectedMs;
      return meta;
    }
    case "think":
      return { target: args?.note ?? "reason before continuing" };
    case "snapshot":
      return { target: args?.paths?.join(", ") ?? step.id };
    case "undo":
      return { target: args?.snapshot ?? step.id };
    default:
      return { target: step.id };
  }
};

export const queuePlan = (
  active: Invocation,
  script: Script,
  config: ExtensionConfig,
  runnable: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const queued = script.steps
      .filter(isCallStep)
      .filter((step) => runnable.has(step.id))
      .map((step): ActivityEvent => ({
        step: step.id,
        tool: step.call,
        ...plannedMeta(step, config),
        phase: "queued",
      }));
    if (queued.length === 0) return;

    const now = performance.now();
    const state = yield* Ref.updateAndGet(active.activity, (current) => ({
      ...current,
      events: Chunk.appendAll(
        current.events,
        Chunk.fromIterable(
          queued.map((event, index): Activity => ({
            ...event,
            sequence: current.events.length + index + 1,
            atMs: elapsedSince(active.startedAt),
          })),
        ),
      ),
    }));
    if (active.update === undefined || !(yield* Ref.get(active.streamOpen))) return;
    yield* Ref.set(active.lastUpdateAt, now);
    yield* publishUntilFailure(active, {
      content: [{ type: "text", text: `${queued.length} queued` }],
      details: progressDetails(active, state),
    });
  });

export const closeQueued = (active: Invocation) =>
  Ref.update(active.activity, (current) => {
    const events = Chunk.toArray(current.events);
    const started = new Set(
      events.filter((event) => event.phase === "start").map((event) => event.step),
    );
    const settled = new Set(
      events.filter((event) => event.phase === "skipped").map((event) => event.step),
    );
    const waiting = events.filter(
      (event) => event.phase === "queued" && !started.has(event.step) && !settled.has(event.step),
    );
    if (waiting.length === 0) return current;
    const atMs = elapsedSince(active.startedAt);
    return {
      ...current,
      events: Chunk.appendAll(
        current.events,
        Chunk.fromIterable(
          waiting.map((event, index): Activity => ({
            ...event,
            phase: "skipped",
            result: "not launched",
            sequence: current.events.length + index + 1,
            atMs,
          })),
        ),
      ),
    };
  });

export const pulse = (active: Invocation) =>
  Effect.gen(function* () {
    if (active.update === undefined) return;
    const state = yield* Ref.get(active.activity);
    const streamOpen = yield* Ref.get(active.streamOpen);
    if (!streamOpen || state.calls === state.completed || state.calls === 0) return;
    const current = progressDetails(active, state);
    yield* publishUntilFailure(active, {
      content: [{ type: "text", text: "Running" }],
      details: current,
    });
  });

const withActivity = <T, E>(
  source: InvocationSource,
  call: ToolCallContext,
  meta: ActivityMeta,
  operation: (active: Invocation) => Effect.Effect<OperationResult<T>, E>,
) =>
  Effect.gen(function* () {
    const active = yield* Effect.sync(source);
    const startedAt = performance.now();
    const base: ActivityBase = {
      step: call.stepId,
      tool: call.toolName,
      ...meta,
    };
    if (call.itemIndex !== undefined) base.item = call.itemIndex;
    yield* report(active, { ...base, phase: "start" });
    const outcome = yield* operation(active).pipe(
      Effect.tap((result) =>
        report(active, {
          ...base,
          phase: "done",
          elapsedMs: elapsedSince(startedAt),
          result: result.summary,
        }),
      ),
      Effect.tapError((cause) =>
        report(active, {
          ...base,
          phase: "error",
          elapsedMs: elapsedSince(startedAt),
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
    );
    return outcome.value;
  });

const nativeResult = <T>(result: AgentToolResult<T>) => {
  if (result.content.length === 1 && result.content[0]?.type === "text")
    return result.content[0].text;
  return {
    content: result.content,
    details: result.details,
  };
};

const nonemptyLines = (text: string) => {
  let count = 0;
  let content = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10) {
      if (content) count += 1;
      content = false;
    } else if (code !== 9 && code !== 13 && code !== 32) {
      content = true;
    }
  }
  return count + (content ? 1 : 0);
};

const resultLines = <T>(result: AgentToolResult<T>) => {
  let count = 0;
  for (const entry of result.content) {
    if (entry.type === "text") count += nonemptyLines(entry.text);
  }
  return count;
};

const totalLines = (text: string) => {
  let count = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
};

const lineSummary = <T>(result: AgentToolResult<T>, noun: string) => {
  const count = resultLines(result);
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
};

type DescribeInput<P extends TSchema> = (params: Static<P>) => ActivityMeta;
type DescribeResult<D> = (result: AgentToolResult<D>) => string;

const adapt = <P extends TSchema, D, S>(
  name: string,
  definition: ToolDefinition<P, D, S>,
  source: InvocationSource,
  describeInput: DescribeInput<P>,
  describeResult: DescribeResult<D>,
) =>
  tool({
    name,
    description: definition.description,
    inputSchema: jsonSchema(definition.parameters),
    execute(raw: Static<P>, call) {
      const program = Effect.try({
        try: () => {
          const prepared = definition.prepareArguments?.(raw) ?? raw;
          return Value.Parse(definition.parameters, prepared);
        },
        catch: (cause) => ToolInvocationFailure.from(name, cause),
      }).pipe(
        Effect.flatMap((params) =>
          withActivity(source, call, describeInput(params), (active) =>
            Effect.tryPromise({
              try: () =>
                definition.execute(
                  `${active.id}:${call.stepId}`,
                  params,
                  active.signal,
                  undefined,
                  active.ctx,
                ),
              catch: (cause) => ToolInvocationFailure.from(name, cause),
            }).pipe(
              Effect.map((result) => ({
                value: nativeResult(result),
                summary: describeResult(result),
              })),
            ),
          ),
        ),
      );
      return Effect.runPromise(program);
    },
  });

const HttpSchema = Type.Object(
  {
    url: Type.String(),
    method: Type.Optional(
      Type.Union([
        Type.Literal("GET"),
        Type.Literal("POST"),
        Type.Literal("PUT"),
        Type.Literal("PATCH"),
        Type.Literal("DELETE"),
        Type.Literal("HEAD"),
      ]),
    ),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    body: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 600_000 })),
  },
  { additionalProperties: false },
);

const WaitSchema = Type.Object(
  { milliseconds: Type.Number({ minimum: 0 }) },
  { additionalProperties: false },
);

const ThinkSchema = Type.Object(
  { note: Type.Optional(Type.String({ maxLength: 500 })) },
  { additionalProperties: false },
);

const SnapshotSchema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1, maxLength: 32_768 }), {
      minItems: 1,
      maxItems: 100,
    }),
  },
  { additionalProperties: false },
);

const UndoSchema = Type.Object(
  { snapshot: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

const requestSignal = (
  piSignal: AbortSignal | undefined,
  effectSignal: AbortSignal,
  timeoutMs: number,
) => {
  const signals = [effectSignal, AbortSignal.timeout(timeoutMs)];
  if (piSignal !== undefined) signals.push(piSignal);
  return AbortSignal.any(signals);
};

const aborted = (signal: AbortSignal) =>
  Effect.callback<never, ToolInvocationFailure>((resume) => {
    const cancel = () =>
      resume(Effect.fail(ToolInvocationFailure.from("wait", new Error("Wait aborted"))));
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", cancel));
  });

const waitFor = (milliseconds: number, signal: AbortSignal | undefined) => {
  const timer = Effect.sleep(milliseconds).pipe(Effect.as({ waitedMs: milliseconds }));
  return signal === undefined ? timer : timer.pipe(Effect.raceFirst(aborted(signal)));
};

const readBody = (reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes: number) =>
  Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;

    while (true) {
      const next = yield* Effect.tryPromise({
        try: () => reader.read(),
        catch: (cause) => ToolInvocationFailure.from("http", cause),
      });
      if (next.done) break;
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (next.value.byteLength > remaining) {
        chunks.push(next.value.subarray(0, remaining));
        total += remaining;
        truncated = true;
        break;
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }

    const text = Buffer.concat(chunks, total).toString("utf8");
    return truncated ? `${text}\n[truncated at ${maxBytes} bytes]` : text;
  });

const closeReader = (reader: ReadableStreamDefaultReader<Uint8Array>) =>
  Effect.tryPromise({
    try: () => reader.cancel(),
    catch: () => undefined,
  }).pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => reader.releaseLock())));

const limitedBody = (response: Response, maxBytes: number) => {
  if (response.body === null) return Effect.succeed("");
  const reader = response.body.getReader();
  return readBody(reader, maxBytes).pipe(Effect.ensuring(closeReader(reader)));
};

export const createCapabilities = (
  cwd: string,
  config: ExtensionConfig,
  source: InvocationSource,
  snapshots: SnapshotStore,
): readonly AnyScriptTool[] => {
  const run =
    process.platform === "win32"
      ? createPowerShellToolDefinition(cwd)
      : createBashToolDefinition(cwd);
  return [
    adapt(
      "read",
      createReadToolDefinition(cwd),
      source,
      (args) => ({ target: args.path }),
      (result) => lineSummary(result, "line"),
    ),
    adapt(
      "write",
      createWriteToolDefinition(cwd),
      source,
      (args) => {
        const lines = totalLines(args.content);
        return {
          target: args.path,
          detail: `${lines} ${lines === 1 ? "line" : "lines"}`,
        };
      },
      () => "written",
    ),
    adapt(
      "edit",
      createEditToolDefinition(cwd),
      source,
      (args) => ({
        target: args.path,
        detail: `${args.edits.length} ${args.edits.length === 1 ? "change" : "changes"}`,
      }),
      () => "applied",
    ),
    adapt(
      "search",
      createGrepToolDefinition(cwd),
      source,
      (args) => ({ target: args.path ?? ".", detail: args.pattern }),
      (result) => lineSummary(result, "match"),
    ),
    adapt(
      "find",
      createFindToolDefinition(cwd),
      source,
      (args) => ({ target: args.path ?? ".", detail: args.pattern }),
      (result) => lineSummary(result, "path"),
    ),
    adapt(
      "list",
      createLsToolDefinition(cwd),
      source,
      (args) => ({ target: args.path ?? "." }),
      (result) => lineSummary(result, "entry"),
    ),
    adapt(
      "run",
      run,
      source,
      (args) => {
        const meta: ActivityMeta = { target: args.command };
        if (args.timeout !== undefined) meta.timeoutMs = args.timeout * 1_000;
        return meta;
      },
      (result) => {
        const lines = resultLines(result);
        if (lines === 0) return "finished";
        return `finished · ${lines} output ${lines === 1 ? "line" : "lines"}`;
      },
    ),
    tool({
      name: "http",
      description: "Make an HTTP request and return status, headers, and body text.",
      inputSchema: jsonSchema(HttpSchema),
      execute(raw: Static<typeof HttpSchema>, call) {
        const program = Effect.try({
          try: () => Value.Parse(HttpSchema, raw),
          catch: (cause) => ToolInvocationFailure.from("http", cause),
        }).pipe(
          Effect.flatMap((args) => {
            const timeoutMs = Math.max(1, Math.floor(args.timeoutMs ?? config.httpTimeoutMs));
            return withActivity(
              source,
              call,
              { target: args.url, detail: args.method ?? "GET", timeoutMs },
              (active) =>
                Effect.tryPromise({
                  try: (effectSignal) => {
                    const request: RequestInit = {
                      method: args.method ?? "GET",
                      signal: requestSignal(active.signal, effectSignal, timeoutMs),
                    };
                    if (args.headers !== undefined) request.headers = args.headers;
                    if (args.body !== undefined) request.body = args.body;
                    return fetch(args.url, request);
                  },
                  catch: (cause) => ToolInvocationFailure.from("http", cause),
                }).pipe(
                  Effect.flatMap((response) =>
                    limitedBody(response, config.maxHttpResultBytes).pipe(
                      Effect.map((body) => ({
                        value: {
                          status: response.status,
                          ok: response.ok,
                          headers: Object.fromEntries(response.headers),
                          body,
                        },
                        summary: `${response.status} · ${Buffer.byteLength(body, "utf8")} bytes`,
                      })),
                    ),
                  ),
                ),
            );
          }),
        );
        return Effect.runPromise(program);
      },
    }),
    tool({
      name: "wait",
      description: "Wait asynchronously for a number of milliseconds.",
      inputSchema: jsonSchema(WaitSchema),
      execute(raw: Static<typeof WaitSchema>, call) {
        const program = Effect.try({
          try: () => Value.Parse(WaitSchema, raw),
          catch: (cause) => ToolInvocationFailure.from("wait", cause),
        }).pipe(
          Effect.flatMap((args) =>
            withActivity(
              source,
              call,
              { target: `${args.milliseconds} ms`, expectedMs: args.milliseconds },
              (active) =>
                waitFor(args.milliseconds, active.signal).pipe(
                  Effect.map((value) => ({ value, summary: `waited ${args.milliseconds} ms` })),
                ),
            ),
          ),
        );
        return Effect.runPromise(program);
      },
    }),
    tool({
      name: "think",
      description:
        "Pause this execution phase so the agent can reason before continuing. Re-run the same script to continue past the checkpoint, or start a new script using published results.",
      inputSchema: jsonSchema(ThinkSchema),
      execute(raw: Static<typeof ThinkSchema>, call) {
        const program = Effect.try({
          try: () => Value.Parse(ThinkSchema, raw),
          catch: (cause) => ToolInvocationFailure.from("think", cause),
        }).pipe(
          Effect.flatMap((args) => {
            const pause = {
              $callscript: "think" as const,
              note: args.note ?? "Reason before continuing",
            };
            return withActivity(source, call, { target: pause.note }, () =>
              Effect.succeed({
                value: call.attempt === 0 ? pause : { continued: true, note: pause.note },
                summary: call.attempt === 0 ? "thinking checkpoint" : "continued",
              }),
            ).pipe(
              Effect.flatMap((value) =>
                call.attempt === 0 ? Effect.fail(earlyReturn(value)) : Effect.succeed(value),
              ),
            );
          }),
        );
        return Effect.runPromise(program);
      },
    }),
    tool({
      name: "snapshot",
      description:
        "Capture exact file contents before edits. Missing files are remembered so undo removes files created later.",
      inputSchema: jsonSchema(SnapshotSchema),
      execute(raw: Static<typeof SnapshotSchema>, call) {
        const program = Effect.try({
          try: () => Value.Parse(SnapshotSchema, raw),
          catch: (cause) => ToolInvocationFailure.from("snapshot", cause),
        }).pipe(
          Effect.flatMap((args) =>
            withActivity(
              source,
              call,
              {
                target: args.paths.join(", "),
                detail: `${args.paths.length} ${args.paths.length === 1 ? "file" : "files"}`,
              },
              () =>
                snapshots.capture(args.paths).pipe(
                  Effect.mapError((cause) => ToolInvocationFailure.from("snapshot", cause)),
                  Effect.map((value) => ({
                    value,
                    summary: `${value.id} · ${value.files.length} ${value.files.length === 1 ? "file" : "files"}`,
                  })),
                ),
            ),
          ),
        );
        return Effect.runPromise(program);
      },
    }),
    tool({
      name: "undo",
      description: "Restore every file captured by a session-local snapshot.",
      inputSchema: jsonSchema(UndoSchema),
      execute(raw: Static<typeof UndoSchema>, call) {
        const program = Effect.try({
          try: () => Value.Parse(UndoSchema, raw),
          catch: (cause) => ToolInvocationFailure.from("undo", cause),
        }).pipe(
          Effect.flatMap((args) =>
            withActivity(source, call, { target: args.snapshot }, () =>
              snapshots.undo(args.snapshot).pipe(
                Effect.mapError((cause) => ToolInvocationFailure.from("undo", cause)),
                Effect.map((value) => ({
                  value,
                  summary: `${value.restored.length} ${value.restored.length === 1 ? "file" : "files"} restored`,
                })),
              ),
            ),
          ),
        );
        return Effect.runPromise(program);
      },
    }),
  ];
};
