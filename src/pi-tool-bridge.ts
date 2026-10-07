import { AsyncLocalStorage } from "node:async_hooks";

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ToolCallEventResult,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type { PiToolContext } from "./types.js";
import { Value } from "typebox/value";

const BRIDGE_STATE_KEY = Symbol.for("pi-callscript.pi-tool-bridge.v1");

type HostKind = "native" | "bundled" | "unbundled" | "unsupported";

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

interface NativeToolOutcome {
  result: AgentToolResult<unknown>;
  isError: boolean;
}

interface NativeToolContext {
  tools?: readonly { readonly name: string }[];
  executeTool?: (
    name: string,
    args: ToolInput,
    options?: {
      signal?: AbortSignal | undefined;
      onUpdate?: AgentToolUpdateCallback<unknown> | undefined;
    },
  ) => Promise<NativeToolOutcome>;
}

type ModuleResolver = (specifier: string) => string | undefined;

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
    ctx: PiToolContext,
  ): Promise<AgentToolResult<unknown>>;
  tools(ctx?: PiToolContext): readonly ToolInfo[];
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

const resolveModule: ModuleResolver = (specifier) => {
  try {
    return import.meta.resolve(specifier);
  } catch {
    return undefined;
  }
};

const legacySessions = async (resolve: ModuleResolver) => {
  const packageEntry = resolve("@earendil-works/pi-coding-agent");
  if (packageEntry === undefined) return [];

  let unbundled: SessionConstructor | undefined;
  try {
    // SAFETY: Pi's public package entry exports AgentSession; patchSession checks its required method.
    const loaded = (await import(packageEntry)) as SessionModule;
    unbundled = loaded.AgentSession;
  } catch {
    // Older Pi hosts may not expose an importable package entry.
  }

  let bundled: SessionConstructor | undefined;
  try {
    // SAFETY: Pi npm package emits bundle/index.js beside its public dist/index.js entry.
    const loaded = (await import(new URL("./bundle/index.js", packageEntry).href)) as SessionModule;
    bundled = loaded.AgentSession;
  } catch {
    // Standalone binaries may not provide a separately importable bundle entry.
  }

  return [unbundled, bundled].filter(
    (session): session is SessionConstructor => session !== undefined,
  );
};

export class PiToolBridge {
  readonly #state: SharedBridgeState;
  readonly #legacyPrototypes: readonly object[];
  #nativeHost = false;
  #session: SessionLike | undefined;
  #metadata: readonly ToolInfo[] = [];
  #reason = "Pi tool execution API is unavailable";

  private constructor(state: SharedBridgeState, sessions: readonly SessionConstructor[]) {
    this.#state = state;
    this.#legacyPrototypes = sessions.map((session) => session.prototype);
  }

  static async create(options: { resolveModule?: ModuleResolver } = {}) {
    const state = sharedState();
    const sessions = await legacySessions(options.resolveModule ?? resolveModule);
    for (const session of sessions) patchSession(session, state);
    return new PiToolBridge(state, sessions);
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
    this.#nativeHost = metadata.some((entry) => "exposure" in entry);
    const runner = captured === undefined ? undefined : policyRunner(captured);
    this.#session = runner === undefined ? undefined : captured;
    this.#reason = this.#nativeHost
      ? "Pi native nested-tool API is unavailable in this tool context"
      : captured === undefined
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
    ctx: PiToolContext,
  ) {
    // SAFETY: the native API is present on Pi 1.0's tool context; older contexts omit it.
    const nativeContext = ctx as PiToolContext & NativeToolContext;
    if (nativeContext.executeTool !== undefined) {
      if (
        nativeContext.tools !== undefined &&
        !nativeContext.tools.some((tool) => tool.name === name)
      ) {
        throw new Error(`Pi tool is not callable in this context: ${name}`);
      }
      const nativeOutcome = await nativeContext.executeTool(name, raw, { signal, onUpdate });
      if (nativeOutcome.isError) {
        const message = nativeOutcome.result.content
          .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
          .join("\n");
        throw new Error(message || `Pi tool ${name} failed`);
      }
      return nativeOutcome.result;
    }

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

  tools(ctx?: PiToolContext) {
    const metadata = this.#session?.getAllTools() ?? this.#metadata;
    // SAFETY: Pi 1.0 contexts expose callable tools; older host contexts may omit the field.
    const callableTools =
      ctx === undefined ? undefined : (ctx as PiToolContext & NativeToolContext).tools;
    if (callableTools === undefined) return metadata;
    return metadata.filter((entry) => callableTools.some((tool) => tool.name === entry.name));
  }

  status(): PiToolBridgeStatus {
    if (this.#nativeHost) {
      return { available: true, host: "native", tools: this.#metadata.length };
    }
    if (this.#session === undefined) {
      return {
        available: false,
        host: "unsupported",
        reason: this.#reason,
        tools: this.#metadata.length,
      };
    }
    const prototype = Object.getPrototypeOf(this.#session);
    const prototypeIndex = this.#legacyPrototypes.indexOf(prototype);
    const host: HostKind =
      prototypeIndex === this.#legacyPrototypes.length - 1 && this.#legacyPrototypes.length > 1
        ? "bundled"
        : prototypeIndex >= 0
          ? "unbundled"
          : this.#nativeHost
            ? "native"
            : "unsupported";
    return {
      available: host !== "unsupported",
      host,
      tools: this.#metadata.length,
    };
  }
}
