import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunDigestEntry, RunState } from "callscript";
import type { Chunk, Ref } from "effect";

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
}

export interface RunDetails {
  version: 1;
  mode: Mode;
  status: "running" | "paused" | "ok" | "error" | "invalid";
  elapsedMs: number;
  calls: number;
  completed: number;
  active: number;
  activity: Activity[];
  state?: RunState;
  background?: Record<string, RunDigestEntry>;
}

export interface ActivityState {
  events: Chunk.Chunk<Activity>;
  calls: number;
  completed: number;
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
  startedAt: number;
}

export type InvocationInput = Omit<
  Invocation,
  "activity" | "lastUpdateAt" | "streamOpen" | "controller" | "startedAt"
>;

export interface PersistedMode {
  version: 1;
  mode: Mode;
}

export interface ToolSummary {
  name: string;
  description?: string;
}

export interface ToolLookupDetails {
  kind: "search" | "describe";
  query?: string;
  tools: ToolSummary[];
}

export const MAIN_TOOL = "callscript";
export const SEARCH_TOOL = "callscript_search";
export const DESCRIBE_TOOL = "callscript_describe";
export const EXTENSION_TOOLS = [MAIN_TOOL, SEARCH_TOOL, DESCRIBE_TOOL] as const;
export const STATE_ENTRY = "pi-callscript";
