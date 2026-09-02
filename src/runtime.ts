import { AsyncLocalStorage } from "node:async_hooks";

import {
  isAwaitCall,
  isCallStep,
  previewValue,
  publishedVariables,
  scriptEngine,
  stableStringify,
  type AnyScriptTool,
  type ExecuteResult,
  type JsonValue,
  type RunState,
  type Script,
  type ScriptEngine,
  type ScriptScope,
  type SessionRunner,
  type StartResult,
} from "callscript";
import { Chunk, Effect, Fiber, Ref, Schema } from "effect";

import { closeQueued, createCapabilities, pulse, queuePlan } from "./capabilities.js";
import { validateCapabilityBoundaries } from "./boundaries.js";
import { OutputBoundsFailure, RuntimeDefect, SourceValidationFailure } from "./errors.js";
import { languageCard, recoveryMessage } from "./language.js";
import {
  presentationDetails,
  presentationText,
  projectPresentation,
  type OperationPresentation,
} from "./presentation.js";
import { SnapshotStore } from "./snapshots.js";
import type {
  Activity,
  ExtensionConfig,
  Invocation,
  InvocationInput,
  JobReceipt,
  RunDetails,
} from "./types.js";

export interface ExecutionResult {
  text: string;
  details: RunDetails;
  isError: boolean;
}

type RunOutcome = { kind: "run"; result: ExecuteResult } | { kind: "session"; result: StartResult };

const elapsedSince = (startedAt: number) => Math.max(0, Math.round(performance.now() - startedAt));

const sessionVariables = (state: RunState | undefined) =>
  state === undefined ? {} : publishedVariables(state);

type PlannedJobArgs = Record<string, JsonValue>;
const isJobArgsRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isJobArgs = (value: JsonValue | undefined): value is PlannedJobArgs => isJobArgsRecord(value);
const isString = Schema.is(Schema.String);
const plannedJobArgs = (value: JsonValue | undefined) => {
  if (!isJobArgs(value)) return undefined;
  return {
    path: isString(value.path) ? value.path : undefined,
    url: isString(value.url) ? value.url : undefined,
    command: isString(value.command) ? value.command : undefined,
    note: isString(value.note) ? value.note : undefined,
  };
};
const REPEAT_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "search",
  "find",
  "list",
  "wait",
  "think",
  "tools",
]);

const DEFAULT_OUTPUT_BYTES = 10_240;
const MAX_FINAL_ACTIVITY = 24;
const MAX_RETAINED_STATE_BYTES = 2_048;
const MAX_FINAL_ACTIVITY_TEXT = 200;

const compactActivityText = (text: string | undefined) => {
  if (text === undefined || text.length <= MAX_FINAL_ACTIVITY_TEXT) return text;
  const head = Math.ceil((MAX_FINAL_ACTIVITY_TEXT - 1) / 2);
  const tail = Math.floor((MAX_FINAL_ACTIVITY_TEXT - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
};

const finalActivity = (events: Chunk.Chunk<Activity>) =>
  Chunk.toArray(events)
    .slice(-MAX_FINAL_ACTIVITY)
    .map((event) => {
      const view: Activity = { ...event };
      const target = compactActivityText(event.target);
      const detail = compactActivityText(event.detail);
      const result = compactActivityText(event.result);
      const error = compactActivityText(event.error);
      if (target !== undefined) view.target = target;
      if (detail !== undefined) view.detail = detail;
      if (result !== undefined) view.result = result;
      if (error !== undefined) view.error = error;
      return view;
    });

const outputPresentation = <T>(value: T, maximumBytes: number) =>
  Effect.sync(() => projectPresentation(value, maximumBytes)).pipe(
    Effect.flatMap((presentation) => {
      const measuredBytes = Buffer.byteLength(presentationText(presentation), "utf8");
      if (measuredBytes <= maximumBytes) return Effect.succeed(presentation);
      return Effect.fail(
        OutputBoundsFailure.from(
          measuredBytes,
          maximumBytes,
          new Error("Projected output exceeds configured byte limit"),
        ),
      );
    }),
  );

const finalDetails = (
  invocation: Invocation,
  status: RunDetails["status"],
  state?: RunState,
  background: RunDetails["background"] = undefined,
  presentation: OperationPresentation | undefined = undefined,
) =>
  Ref.get(invocation.activity).pipe(
    Effect.map((activity) => {
      const visibleActivity = finalActivity(activity.events);
      const details: RunDetails = {
        version: 1,
        mode: "on",
        status,
        elapsedMs: elapsedSince(invocation.startedAt),
        calls: activity.calls,
        completed: activity.completed,
        active: activity.active,
        queued: activity.queued,
        done: activity.done,
        failed: activity.failed,
        cancelled: activity.cancelled,
        skipped: activity.skipped,
        activity: visibleActivity,
        activityHidden: activity.events.length - visibleActivity.length,
      };
      if (presentation !== undefined) details.presentation = presentationDetails(presentation);
      if (state !== undefined) {
        const stateBytes = Buffer.byteLength(stableStringify(state), "utf8");
        if (stateBytes <= MAX_RETAINED_STATE_BYTES) details.state = state;
        else details.retainedState = { omittedBytes: stateBytes };
      }
      if (background !== undefined && Object.keys(background).length > 0)
        details.background = background;
      const jobs = invocation.jobs();
      if (jobs.length > 0) details.jobs = jobs;
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

const projectedResult = <T>(
  invocation: Invocation,
  value: T,
  status: RunDetails["status"],
  state: RunState | undefined,
  background: RunDetails["background"],
  isError: boolean,
  maximumBytes: number,
) =>
  Effect.gen(function* () {
    const primary = yield* outputPresentation(value, maximumBytes);
    const combined = appendBackground(presentationText(primary), background);
    const presentation =
      Buffer.byteLength(combined, "utf8") <= maximumBytes
        ? primary
        : yield* outputPresentation(combined, maximumBytes);
    return {
      text: presentation === primary ? combined : presentationText(presentation),
      details: yield* finalDetails(invocation, status, state, background, presentation),
      isError,
    } satisfies ExecutionResult;
  });

const completedResult = (
  invocation: Invocation,
  result: ExecuteResult,
  background: RunDetails["background"],
  maximumBytes: number,
) =>
  Effect.gen(function* () {
    if (result.status === "ok") {
      const checkpoint =
        result.returnedAt !== undefined && isThinkingCheckpoint(result.output)
          ? result.output
          : undefined;
      const paused = checkpoint !== undefined;
      if (!paused) yield* closeQueued(invocation);
      const value = checkpoint === undefined ? result.output : `Paused: ${checkpoint.note}`;
      return yield* projectedResult(
        invocation,
        value,
        paused ? "paused" : "ok",
        result.state,
        background,
        false,
        maximumBytes,
      );
    }
    yield* closeQueued(invocation);
    if (result.status === "error")
      return yield* projectedResult(
        invocation,
        `${result.at}: ${result.error.message}`,
        "error",
        result.state,
        background,
        true,
        maximumBytes,
      );
    return yield* projectedResult(
      invocation,
      `Suspended at ${result.suspensions.map((entry) => entry.stepId ?? entry.key).join(", ")}`,
      "error",
      result.state,
      background,
      true,
      maximumBytes,
    );
  });

const completedSessionResult = (
  invocation: Invocation,
  result: StartResult,
  background: RunDetails["background"],
  maximumBytes: number,
) =>
  Effect.gen(function* () {
    if (result.status === "done") {
      const checkpoint =
        result.returnedAt !== undefined && isThinkingCheckpoint(result.output)
          ? result.output
          : undefined;
      const paused = checkpoint !== undefined;
      if (!paused) yield* closeQueued(invocation);
      const value = checkpoint === undefined ? result.output : `Paused: ${checkpoint.note}`;
      return yield* projectedResult(
        invocation,
        value,
        paused ? "paused" : "ok",
        result.record,
        background,
        false,
        maximumBytes,
      );
    }
    if (result.status === "error") {
      yield* closeQueued(invocation);
      return yield* projectedResult(
        invocation,
        `${result.at}: ${result.error.message}`,
        "error",
        result.record,
        background,
        true,
        maximumBytes,
      );
    }
    return yield* projectedResult(
      invocation,
      { runId: result.runId, status: "pending" },
      "ok",
      undefined,
      background,
      false,
      maximumBytes,
    );
  });

export class CallScriptRuntime {
  readonly tools: readonly AnyScriptTool[];
  readonly engine: ScriptEngine<readonly AnyScriptTool[]>;
  readonly scope: ScriptScope;
  readonly #config: ExtensionConfig;
  readonly #snapshots: SnapshotStore;
  readonly #validationTools: readonly string[];
  readonly #onJobSettled: (job: JobReceipt) => void;
  #session: SessionRunner;
  readonly #backgroundAbort = new Map<string, AbortController>();
  readonly #jobs = new Map<string, JobReceipt>();
  #unsubscribeSession: () => void = () => undefined;
  readonly #activeControllers = new Set<AbortController>();
  readonly #invocations = new AsyncLocalStorage<Invocation>();

  constructor(
    cwd: string,
    config: ExtensionConfig,
    onJobSettled: (job: JobReceipt) => void = () => undefined,
  ) {
    this.#config = config;
    this.#onJobSettled = onJobSettled;
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
    this.#unsubscribeSession = session.onRunSettled((run) => {
      this.#backgroundAbort.delete(run.runId);
      const previous = this.#jobs.get(run.runId);
      const next: JobReceipt = {
        id: run.runId,
        label: previous?.label ?? run.runId,
        repeatSafe: previous?.repeatSafe ?? false,
        status:
          run.status === "done" || run.status === "returned"
            ? "done"
            : run.status === "cancelled"
              ? "cancelled"
              : "failed",
      };
      if (run.output !== undefined) next.output = run.output;
      if (run.error !== undefined) next.error = run.error.message;
      this.#jobs.set(run.runId, next);
      this.#onJobSettled(next);
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
      if (!isCallStep(step) || step.await !== false) continue;
      this.#backgroundAbort.set(step.id, controller);
      const args = plannedJobArgs(step.args);
      const target = args?.path ?? args?.url ?? args?.command ?? args?.note;
      this.#jobs.set(step.id, {
        id: step.id,
        label: target === undefined ? `${step.call} · ${step.id}` : `${step.call} · ${target}`,
        status: "running",
        repeatSafe: REPEAT_SAFE_TOOLS.has(step.call),
      });
    }
  }

  private validateJoins(plan: Script) {
    for (const step of plan.steps) {
      if (!isCallStep(step) || !isAwaitCall(step.call)) continue;
      const runId = step.call.slice("await.".length).split(".")[0];
      if (runId === undefined || this.#session.status(runId) !== undefined) continue;
      const job = this.#jobs.get(runId);
      if (job?.status === "unavailable" && !job.repeatSafe)
        throw new Error(
          recoveryMessage("CS006", `Unavailable job ${runId} may have mutated state.`),
        );
      throw new Error(recoveryMessage("CS007", `Unknown or expired job ${runId}.`));
    }
    return plan;
  }

  restore(state: RunState | undefined) {
    return Effect.sync(() => {
      if (state === undefined) delete this.scope.state;
      else this.scope.state = state;
    });
  }

  restoreJobs(jobs: readonly JobReceipt[] | undefined) {
    return Effect.sync(() => {
      this.#jobs.clear();
      for (const job of jobs ?? []) {
        this.#jobs.set(job.id, {
          ...job,
          status: job.status === "running" ? "unavailable" : job.status,
        });
      }
    });
  }

  jobs() {
    return [...this.#jobs.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  jobsText() {
    const jobs = this.jobs();
    if (jobs.length === 0) return "No CallScript jobs.";
    return jobs
      .map((job) => `${job.id} · ${job.label} · ${job.status} · repeatSafe=${job.repeatSafe}`)
      .join("\n");
  }

  languageCard() {
    return languageCard(this.engine);
  }

  reset() {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.sync(() => {
        this.#unsubscribeSession();
        this.#unsubscribeSession = () => undefined;
        const controllers = new Set([
          ...this.#backgroundAbort.values(),
          ...this.#activeControllers,
        ]);
        for (const controller of controllers) controller.abort();
        for (const runId of this.#backgroundAbort.keys()) {
          this.#session.cancel(runId);
        }
        this.#backgroundAbort.clear();
        this.#jobs.clear();
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
        queued: 0,
        active: 0,
        done: 0,
        failed: 0,
        cancelled: 0,
        skipped: 0,
      });
      const lastUpdateAt = yield* Ref.make(0);
      const streamOpen = yield* Ref.make(true);
      const controller = yield* Effect.sync(() => new AbortController());
      const detachHostAbort = yield* Effect.sync(() => {
        this.#activeControllers.add(controller);
        const hostSignal = input.signal;
        if (hostSignal === undefined) return () => undefined;
        const forward = () => controller.abort(hostSignal.reason);
        if (hostSignal.aborted) forward();
        else hostSignal.addEventListener("abort", forward, { once: true });
        return () => hostSignal.removeEventListener("abort", forward);
      });
      const signal = controller.signal;
      const invocation: Invocation = {
        ...input,
        signal,
        activity,
        lastUpdateAt,
        streamOpen,
        controller,
        jobs: () => this.jobs(),
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
          this.validateJoins(
            validateCapabilityBoundaries(
              this.engine.validate(script, {
                tools: this.#validationTools,
                variables: [
                  ...Object.keys(this.scope.vars),
                  ...Object.keys(sessionVariables(this.scope.state)),
                ],
              }),
            ),
          ),
        catch: SourceValidationFailure.from,
      });
      const runPlan = (plan: Script): Effect.Effect<RunOutcome, RuntimeDefect> => {
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
                catch: RuntimeDefect.from,
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
          catch: RuntimeDefect.from,
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
      const maximumBytes = this.#config.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
      return yield* Effect.matchEffect(attempt, {
        onFailure: (failure) => {
          const invalid = failure._tag === "SourceValidationFailure";
          const background = this.#session.digest();
          return Effect.sync(() => this.reconcileBackground(background, controller)).pipe(
            Effect.andThen(closeQueued(invocation)),
            Effect.flatMap(() =>
              projectedResult(
                invocation,
                failure.message,
                invalid ? "invalid" : "error",
                this.scope.state,
                background,
                true,
                maximumBytes,
              ),
            ),
          );
        },
        onSuccess: (outcome) => {
          const background = this.#session.digest();
          return Effect.sync(() => this.reconcileBackground(background, controller)).pipe(
            Effect.flatMap(() =>
              outcome.kind === "run"
                ? completedResult(invocation, outcome.result, background, maximumBytes)
                : completedSessionResult(invocation, outcome.result, background, maximumBytes),
            ),
          );
        },
      }).pipe(
        Effect.catchDefect((defect) => Effect.fail(RuntimeDefect.from(defect))),
        Effect.ensuring(
          Effect.gen({ self: this }, function* () {
            yield* Ref.set(streamOpen, false);
            if (heartbeat !== undefined) yield* Fiber.interrupt(heartbeat);
            yield* Effect.sync(() => {
              detachHostAbort();
              this.#activeControllers.delete(controller);
            });
          }),
        ),
      );
    });
  }

  private invocation() {
    const invocation = this.#invocations.getStore();
    if (invocation === undefined)
      throw RuntimeDefect.from(new Error("CallScript tool invoked outside an execution"));
    return invocation;
  }
}
