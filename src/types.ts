import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunDigestEntry, RunState } from "callscript";
import type { Chunk, Ref } from "effect";

import type { ActivityPresentation, OperationPresentationDetails } from "./presentation.js";

export const MODES = ["off", "on"] as const;
export type Mode = (typeof MODES)[number];

export interface ExtensionConfig {
  mode: Mode;
  limits: {
    maxSteps: number;
    maxItemsPerStep: number;
    maxTotalCalls: number;
    maxConcurrency: number;
    maxCallResultBytes: number;
  };
  httpTimeoutMs: number;
  maxHttpResultBytes: number;
  maxOutputBytes?: number;
}

export interface Activity {
  sequence: number;
  atMs: number;
  step: string;
  tool: string;
  phase: "queued" | "start" | "done" | "error" | "skipped";
  item?: number;
  elapsedMs?: number;
  target?: string;
  detail?: string;
  timeoutMs?: number;
  expectedMs?: number;
  result?: string;
  error?: string;
  presentation?: ActivityPresentation;
  selection?: "selected" | "skipped";
}

export type JobStatus = "running" | "done" | "failed" | "cancelled" | "unavailable";

export interface JobReceipt {
  id: string;
  label: string;
  status: JobStatus;
  repeatSafe: boolean;
  output?: unknown;
  error?: string;
}

export interface RunDetails {
  version: 1;
  mode: Mode;
  status: "running" | "paused" | "ok" | "error" | "invalid";
  elapsedMs: number;
  calls: number;
  completed: number;
  active: number;
  queued?: number;
  done?: number;
  failed?: number;
  cancelled?: number;
  skipped?: number;
  activity: Activity[];
  activityHidden?: number;
  presentation?: OperationPresentationDetails;
  retainedState?: { readonly omittedBytes: number };
  state?: RunState;
  background?: Record<string, RunDigestEntry>;
  jobs?: JobReceipt[];
}

export interface ActivityState {
  events: Chunk.Chunk<Activity>;
  calls: number;
  completed: number;
  queued: number;
  active: number;
  done: number;
  failed: number;
  cancelled: number;
  skipped: number;
}

export interface Invocation {
  id: string;
  signal: AbortSignal | undefined;
  ctx: ExtensionContext;
  update: AgentToolUpdateCallback<RunDetails> | undefined;
  activity: Ref.Ref<ActivityState>;
  lastUpdateAt: Ref.Ref<number>;
  streamOpen: Ref.Ref<boolean>;
  controller: AbortController;
  jobs: () => JobReceipt[];
  startedAt: number;
}

export type InvocationInput = Omit<
  Invocation,
  "activity" | "lastUpdateAt" | "streamOpen" | "controller" | "jobs" | "startedAt"
>;

export interface PersistedMode {
  version: 1;
  mode: Mode;
}

export interface PersistedJobReceipt {
  version: 1;
  job: JobReceipt;
}

export const MAIN_TOOL = "callscript";
export const EXTENSION_TOOLS = [MAIN_TOOL] as const;
export const STATE_ENTRY = "pi-callscript";
export const JOB_STATE_ENTRY = "pi-callscript-job";
