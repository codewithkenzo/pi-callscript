import { AsyncLocalStorage } from "node:async_hooks";

import {
  ScriptValidationError,
  isAwaitCall,
  isCallStep,
  previewValue,
  publishedVariables,
  scriptEngine,
  type AnyScriptTool,
  type ExecuteResult,
  type RunState,
  type Script,
  type ScriptEngine,
  type ScriptScope,
  type SessionRunner,
  type StartResult,
} from "callscript";
import { Chunk, Effect, Fiber, Ref, Schema } from "effect";

import { closeQueued, createCapabilities, pulse, queuePlan } from "./capabilities.js";
import { SnapshotStore } from "./snapshots.js";
import type {
  Activity,
  ExtensionConfig,
  Invocation,
  InvocationInput,
  RunDetails,
} from "./types.js";

export interface ExecutionResult {
  text: string;
  details: RunDetails;
  isError: boolean;
}

type RunOutcome = { kind: "run"; result: ExecuteResult } | { kind: "session"; result: StartResult };

class RuntimeFailure extends Error {
  readonly source: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "RuntimeFailure";
    this.source = cause;
  }
}

const isString = Schema.is(Schema.String);
const elapsedSince = (startedAt: number) => Math.max(0, Math.round(performance.now() - startedAt));

const sessionVariables = (state: RunState | undefined) =>
  state === undefined ? {} : publishedVariables(state);

const outputText = <T>(value: T) => {
  if (isString(value)) return value;
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
};

const finalDetails = (
  invocation: Invocation,
  status: RunDetails["status"],
  state?: RunState,
  background: RunDetails["background"] = undefined,
) =>
  Ref.get(invocation.activity).pipe(
    Effect.map((activity) => {
      const details: RunDetails = {
        version: 1,
        mode: "on",
        status,
        elapsedMs: elapsedSince(invocation.startedAt),
        calls: activity.calls,
        completed: activity.completed,
        active: activity.calls - activity.completed,
        activity: Chunk.toArray(activity.events),
      };
      if (state !== undefined) details.state = state;
      if (background !== undefined && Object.keys(background).length > 0)
        details.background = background;
      return details;
    }),
  );

const appendBackground = (text: string, background: RunDetails["background"]) => {
  if (background === undefined) return text;
  const entries = Object.entries(background);
  if (entries.length === 0) return text;
  const lines = entries.map(([runId, entry]) => {
    const duration = entry.durationMs === undefined ? "" : ` · ${entry.durationMs} ms`;
    if (entry.output !== undefined)
      return `${runId}: ${entry.status}${duration} · ${previewValue(entry.output, 240)}`;
    if (entry.error !== undefined)
      return `${runId}: ${entry.status}${duration} · ${previewValue(entry.error, 160)}`;
    return `${runId}: ${entry.status}${duration}`;
  });
  return `${text}\n\nBackground\n${lines.join("\n")}`;
};

const isThinkingCheckpoint = Schema.is(
  Schema.Struct({
    $callscript: Schema.Literal("think"),
    note: Schema.String,
  }),
);

const completedResult = (
  invocation: Invocation,
  result: ExecuteResult,
  background: RunDetails["background"],
) =>
  Effect.gen(function* () {
    if (result.status === "ok") {
      const checkpoint =
        result.returnedAt !== undefined && isThinkingCheckpoint(result.output)
          ? result.output
          : undefined;
      const paused = checkpoint !== undefined;
      if (!paused) yield* closeQueued(invocation);
      return {
        text: appendBackground(
          checkpoint === undefined ? outputText(result.output) : `Paused: ${checkpoint.note}`,
          background,
        ),
        details: yield* finalDetails(
          invocation,
          paused ? "paused" : "ok",
          result.state,
          background,
        ),
        isError: false,
      } satisfies ExecutionResult;
    }
    if (result.status === "error") {
      yield* closeQueued(invocation);
      return {
        text: appendBackground(`${result.at}: ${result.error.message}`, background),
        details: yield* finalDetails(invocation, "error", result.state, background),
        isError: true,
      } satisfies ExecutionResult;
    }
    yield* closeQueued(invocation);
    return {
      text: appendBackground(
        `Suspended at ${result.suspensions.map((entry) => entry.stepId ?? entry.key).join(", ")}`,
        background,
      ),
      details: yield* finalDetails(invocation, "error", result.state, background),
      isError: true,
    } satisfies ExecutionResult;
  });

const completedSessionResult = (
  invocation: Invocation,
  result: StartResult,
  background: RunDetails["background"],
) =>
  Effect.gen(function* () {
    if (result.status === "done") {
      const checkpoint =
        result.returnedAt !== undefined && isThinkingCheckpoint(result.output)
          ? result.output
          : undefined;
      const paused = checkpoint !== undefined;
      if (!paused) yield* closeQueued(invocation);
      return {
        text: appendBackground(
          checkpoint === undefined ? outputText(result.output) : `Paused: ${checkpoint.note}`,
          background,
        ),
        details: yield* finalDetails(
          invocation,
          paused ? "paused" : "ok",
          result.record,
          background,
        ),
        isError: false,
      } satisfies ExecutionResult;
    }
    if (result.status === "error") {
      yield* closeQueued(invocation);
      return {
        text: appendBackground(`${result.at}: ${result.error.message}`, background),
        details: yield* finalDetails(invocation, "error", result.record, background),
        isError: true,
      } satisfies ExecutionResult;
    }
    return {
      text: appendBackground(outputText({ runId: result.runId, status: "pending" }), background),
      details: yield* finalDetails(invocation, "ok", undefined, background),
      isError: false,
    } satisfies ExecutionResult;
  });

export class CallScriptRuntime {
  readonly tools: readonly AnyScriptTool[];
  readonly engine: ScriptEngine<readonly AnyScriptTool[]>;
  readonly scope: ScriptScope;
  readonly #config: ExtensionConfig;
  readonly #snapshots: SnapshotStore;
  readonly #validationTools: readonly string[];
  #session: SessionRunner;
  readonly #backgroundAbort = new Map<string, AbortController>();
  readonly #invocations = new AsyncLocalStorage<Invocation>();

  constructor(cwd: string, config: ExtensionConfig) {
    this.#config = config;
    this.#snapshots = new SnapshotStore(cwd);
    this.tools = createCapabilities(cwd, config, () => this.invocation(), this.#snapshots);
    this.engine = scriptEngine({
      tools: this.tools,
      format: "js",
      limits: config.limits,
    });
    this.scope = this.engine.scope();
    this.#validationTools = [...this.engine.tools, "await.*"];
    this.#session = this.createSession();
  }

  private createSession() {
    const session = this.engine.session(
      {
        deadlineMs: 0,
        maxRuns: 64,
        maxDigestOutputBytes: 4_096,
        retainOutputs: "live",
      },
      this.scope,
    );
    session.onRunSettled((run) => {
      this.#backgroundAbort.delete(run.runId);
    });
    return session;
  }

  private reconcileBackground(background: RunDetails["background"], controller: AbortController) {
    const pending = new Set<string>();
    if (background !== undefined) {
      for (const [runId, entry] of Object.entries(background)) {
        if (entry.status !== "pending") continue;
        pending.add(runId);
        this.#backgroundAbort.set(runId, controller);
      }
    }
    for (const [runId, owner] of this.#backgroundAbort) {
      if (owner !== controller || pending.has(runId)) continue;
      if (this.#session.status(runId)?.status === "pending") continue;
      this.#backgroundAbort.delete(runId);
    }
  }

  private trackPlannedBackground(plan: Script, controller: AbortController) {
    for (const step of plan.steps) {
      if (isCallStep(step) && step.await === false) this.#backgroundAbort.set(step.id, controller);
    }
  }

  restore(state: RunState | undefined) {
    return Effect.sync(() => {
      if (state === undefined) delete this.scope.state;
      else this.scope.state = state;
    });
  }

  reset() {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.sync(() => {
        const controllers = new Set(this.#backgroundAbort.values());
        for (const controller of controllers) controller.abort();
        for (const runId of this.#backgroundAbort.keys()) {
          this.#session.cancel(runId);
        }
        this.#backgroundAbort.clear();
        delete this.scope.state;
        this.scope.memo.clear();
        this.#session = this.createSession();
      });
      yield* this.#snapshots.clear();
    });
  }

  execute(script: string, input: InvocationInput) {
    return Effect.gen({ self: this }, function* () {
      const activity = yield* Ref.make({
        events: Chunk.empty<Activity>(),
        calls: 0,
        completed: 0,
      });
      const lastUpdateAt = yield* Ref.make(0);
      const streamOpen = yield* Ref.make(true);
      const controller = yield* Effect.sync(() => new AbortController());
      const signal =
        input.signal === undefined
          ? controller.signal
          : AbortSignal.any([input.signal, controller.signal]);
      const invocation: Invocation = {
        ...input,
        signal,
        activity,
        lastUpdateAt,
        streamOpen,
        controller,
        startedAt: performance.now(),
      };
      const heartbeat =
        input.update === undefined
          ? undefined
          : yield* Effect.forkChild(
              Effect.forever(Effect.sleep(1_000).pipe(Effect.andThen(pulse(invocation)))),
            );

      const validated = Effect.try({
        try: () =>
          this.engine.validate(script, {
            tools: this.#validationTools,
            variables: [
              ...Object.keys(this.scope.vars),
              ...Object.keys(sessionVariables(this.scope.state)),
            ],
          }),
        catch: (cause) => new RuntimeFailure(cause),
      });
      const runPlan = (plan: Script): Effect.Effect<RunOutcome, RuntimeFailure> => {
        const usesSession =
          plan.await === false ||
          plan.steps.some(
            (step) => isCallStep(step) && (step.await === false || isAwaitCall(step.call)),
          );
        if (usesSession) {
          return Effect.sync(() => this.trackPlannedBackground(plan, controller)).pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: () =>
                  this.#invocations.run(invocation, () =>
                    this.#session.start(plan, {
                      variables: {
                        ...sessionVariables(this.scope.state),
                        ...this.scope.vars,
                      },
                    }),
                  ),
                catch: (cause) => new RuntimeFailure(cause),
              }),
            ),
            Effect.map((result): RunOutcome => ({ kind: "session", result })),
          );
        }
        return Effect.tryPromise({
          try: () =>
            this.#invocations.run(invocation, () =>
              this.engine.run({ script: plan, retainOutputs: "live" }, this.scope),
            ),
          catch: (cause) => new RuntimeFailure(cause),
        }).pipe(Effect.map((result): RunOutcome => ({ kind: "run", result })));
      };
      const attempt = validated.pipe(
        Effect.tap((plan) => {
          const runnable = new Set(
            this.engine
              .plan(plan, this.scope.state)
              .filter((step) => step.action === "run" && step.tool !== undefined)
              .map((step) => step.id),
          );
          return queuePlan(invocation, plan, this.#config, runnable);
        }),
        Effect.flatMap(runPlan),
      );
      return yield* Effect.matchEffect(attempt, {
        onFailure: (failure) => {
          const invalid = failure.source instanceof ScriptValidationError;
          const background = this.#session.digest();
          return Effect.sync(() => this.reconcileBackground(background, controller)).pipe(
            Effect.andThen(closeQueued(invocation)),
            Effect.andThen(
              finalDetails(invocation, invalid ? "invalid" : "error", this.scope.state, background),
            ),
            Effect.map((details) => ({
              text: appendBackground(failure.message, background),
              details,
              isError: true,
            })),
          );
        },
        onSuccess: (outcome) => {
          const background = this.#session.digest();
          return Effect.sync(() => this.reconcileBackground(background, controller)).pipe(
            Effect.flatMap(() =>
              outcome.kind === "run"
                ? completedResult(invocation, outcome.result, background)
                : completedSessionResult(invocation, outcome.result, background),
            ),
          );
        },
      }).pipe(
        Effect.ensuring(
          heartbeat === undefined ? Effect.succeed(undefined) : Fiber.interrupt(heartbeat),
        ),
        Effect.ensuring(Ref.set(streamOpen, false)),
      );
    });
  }

  private invocation() {
    const invocation = this.#invocations.getStore();
    if (invocation === undefined) throw new Error("CallScript tool invoked outside an execution");
    return invocation;
  }
}
