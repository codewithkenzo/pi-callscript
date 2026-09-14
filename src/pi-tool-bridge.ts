import { AsyncLocalStorage } from "node:async_hooks";

import {
  AgentSession,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEventResult,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const BRIDGE_STATE_KEY = Symbol.for("pi-callscript.pi-tool-bridge.v1");

type HostKind = "bundled" | "unbundled" | "unsupported";

const ToolInputSchema = Type.Record(Type.String(), Type.Unknown());
type ToolInput = Static<typeof ToolInputSchema>;

interface ToolResultOverride {
  content?: AgentToolResult<unknown>["content"];
  details?: unknown;
  isError?: boolean;
  usage?: AgentToolResult<unknown>["usage"];
}

interface PolicyRunner {
  hasHandlers(event: string): boolean;
  emitToolCall(event: {
    type: "tool_call";
    toolName: string;
    toolCallId: string;
    input: ToolInput;
  }): Promise<ToolCallEventResult | undefined>;
  emitToolResult(event: {
    type: "tool_result";
    toolName: string;
    toolCallId: string;
    input: ToolInput;
    content: AgentToolResult<unknown>["content"];
    details: unknown;
    isError: boolean;
    usage?: AgentToolResult<unknown>["usage"];
  }): Promise<ToolResultOverride | undefined>;
}

interface SessionLike {
  getAllTools(): ToolInfo[];
  getToolDefinition(name: string): ToolDefinition | undefined;
}

interface SessionConstructor {
  prototype: SessionLike;
}

interface SessionModule {
  AgentSession: SessionConstructor;
}

interface CaptureRequest {
  capture(session: SessionLike): void;
}

interface SharedBridgeState {
  readonly captures: AsyncLocalStorage<CaptureRequest>;
  readonly patched: WeakSet<object>;
}

export interface PiToolProvider {
  invoke(
    name: string,
    id: string,
    raw: ToolInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<unknown>,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>>;
  tools(): readonly ToolInfo[];
  status(): PiToolBridgeStatus;
}

export interface PiToolBridgeStatus {
  readonly available: boolean;
  readonly host: HostKind;
  readonly reason?: string;
  readonly tools: number;
}

const sharedState = () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, BRIDGE_STATE_KEY);
  // SAFETY: this package owns BRIDGE_STATE_KEY and writes only SharedBridgeState values.
  const existing = descriptor?.value as SharedBridgeState | undefined;
  if (existing !== undefined) return existing;

  const created: SharedBridgeState = {
    captures: new AsyncLocalStorage<CaptureRequest>(),
    patched: new WeakSet<object>(),
  };
  Object.defineProperty(globalThis, BRIDGE_STATE_KEY, {
    configurable: false,
    enumerable: false,
    value: created,
    writable: false,
  });
  return created;
};

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const policyRunner = (session: SessionLike) => {
  const descriptor = Object.getOwnPropertyDescriptor(session, "_extensionRunner");
  // SAFETY: Pi AgentSession owns _extensionRunner; compatibility probes fail closed when absent.
  return descriptor?.value as PolicyRunner | undefined;
};

const patchSession = (constructor: SessionConstructor, state: SharedBridgeState) => {
  const prototype = constructor.prototype;
  if (state.patched.has(prototype)) return;

  const original = prototype.getAllTools;
  Object.defineProperty(prototype, "getAllTools", {
    configurable: true,
    enumerable: false,
    value(this: SessionLike) {
      state.captures.getStore()?.capture(this);
      return original.call(this);
    },
    writable: true,
  });
  state.patched.add(prototype);
};

const bundledSession = async () => {
  const packageEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const bundledEntry = new URL("./bundle/index.js", packageEntry);
  try {
    // SAFETY: Pi npm package emits bundle/index.js beside its public dist/index.js entry.
    const loaded = (await import(bundledEntry.href)) as SessionModule;
    return loaded.AgentSession;
  } catch {
    return undefined;
  }
};

export class PiToolBridge {
  readonly #state: SharedBridgeState;
  readonly #unbundledPrototype: object;
  readonly #bundledPrototype: object | undefined;
  #session: SessionLike | undefined;
  #metadata: readonly ToolInfo[] = [];
  #reason = "Pi session is not captured";

  private constructor(
    state: SharedBridgeState,
    unbundled: SessionConstructor,
    bundled: SessionConstructor | undefined,
  ) {
    this.#state = state;
    this.#unbundledPrototype = unbundled.prototype;
    this.#bundledPrototype = bundled?.prototype;
  }

  static async create() {
    const state = sharedState();
    const unbundled: SessionConstructor = AgentSession;
    const bundled = await bundledSession();
    patchSession(unbundled, state);
    if (bundled !== undefined) patchSession(bundled, state);
    return new PiToolBridge(state, unbundled, bundled);
  }

  capture(pi: Pick<ExtensionAPI, "getAllTools">) {
    let captured: SessionLike | undefined;
    const metadata = this.#state.captures.run(
      {
        capture(session) {
          captured = session;
        },
      },
      () => pi.getAllTools(),
    );
    this.#metadata = metadata;
    const runner = captured === undefined ? undefined : policyRunner(captured);
    this.#session = runner === undefined ? undefined : captured;
    this.#reason =
      captured === undefined
        ? "Current Pi host does not expose an importable shared AgentSession"
        : runner === undefined
          ? "Current Pi host does not expose its policy runner"
          : "";
    return metadata;
  }

  async invoke(
    name: string,
    id: string,
    raw: ToolInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<unknown>,
    ctx: ExtensionContext,
  ) {
    const session = this.#session;
    if (session === undefined) throw new Error(this.#reason);
    const runner = policyRunner(session);
    if (runner === undefined) throw new Error("Pi policy runner is unavailable");
    const definition = session.getToolDefinition(name);
    if (definition === undefined) throw new Error(`Unknown Pi tool: ${name}`);
    const prepared = definition.prepareArguments?.(raw) ?? raw;
    const params = Value.Parse(definition.parameters, prepared);
    const input = Value.Parse(ToolInputSchema, params);

    let failure: unknown;
    let result: AgentToolResult<unknown>;
    try {
      if (runner.hasHandlers("tool_call")) {
        const policy = await runner.emitToolCall({
          type: "tool_call",
          toolName: name,
          toolCallId: id,
          input,
        });
        if (policy?.block === true) throw new Error(policy.reason ?? `Pi policy blocked ${name}`);
      }
      result = await definition.execute(id, input, signal, onUpdate, ctx);
    } catch (cause) {
      failure = cause;
      result = {
        content: [{ type: "text", text: errorMessage(cause) }],
        details: undefined,
      };
    }

    let isError = failure !== undefined;
    if (runner.hasHandlers("tool_result")) {
      const event = {
        type: "tool_result" as const,
        toolName: name,
        toolCallId: id,
        input,
        content: result.content,
        details: result.details,
        isError,
        usage: result.usage,
      };
      const policy = await runner.emitToolResult(event);
      if (policy?.content !== undefined) result.content = policy.content;
      if (policy?.details !== undefined) result.details = policy.details;
      if (policy?.usage !== undefined) result.usage = policy.usage;
      if (policy?.isError !== undefined) isError = policy.isError;
    }

    if (isError) throw failure ?? new Error(errorMessage(result.content));
    return result;
  }

  definition(name: string) {
    return this.#session?.getToolDefinition(name);
  }

  tools() {
    if (this.#session !== undefined) this.#metadata = this.#session.getAllTools();
    return this.#metadata;
  }

  status(): PiToolBridgeStatus {
    if (this.#session === undefined) {
      return {
        available: false,
        host: "unsupported",
        reason: this.#reason,
        tools: this.#metadata.length,
      };
    }
    const prototype = Object.getPrototypeOf(this.#session);
    const host: HostKind =
      prototype === this.#bundledPrototype
        ? "bundled"
        : prototype === this.#unbundledPrototype
          ? "unbundled"
          : "unsupported";
    return {
      available: host !== "unsupported",
      host,
      tools: this.#metadata.length,
    };
  }
}
