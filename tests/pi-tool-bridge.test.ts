import {
  AgentSession,
  type ExtensionContext,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { describe, expect, test } from "vitest";

import { PiToolBridge } from "../src/pi-tool-bridge.js";

const sourceInfo = {
  path: "tests/fixture-extension.ts",
  source: "tests",
  scope: "temporary" as const,
  origin: "top-level" as const,
};

const definition = (name: string): ToolDefinition => ({
  name,
  label: name,
  description: `${name} fixture`,
  parameters: Type.Object({}, { additionalProperties: false }),
  async execute() {
    return { content: [{ type: "text", text: name }], details: {} };
  },
});

const PolicyInputSchema = Type.Record(Type.String(), Type.Unknown());
type PolicyInput = Static<typeof PolicyInputSchema>;

interface PolicyHarness {
  hasHandlers(event: string): boolean;
  emitToolCall(event: {
    input: PolicyInput;
  }): Promise<{ block?: boolean; reason?: string } | undefined>;
  emitToolResult(event: {
    input: PolicyInput;
    content: Array<
      { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
    >;
    details: unknown;
    isError: boolean;
  }): Promise<
    | {
        content?: Array<
          { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
        >;
        details?: unknown;
        isError?: boolean;
      }
    | undefined
  >;
}

interface SessionHarness {
  _extensionRunner: PolicyHarness;
  _toolDefinitions: Map<string, { definition: ToolDefinition; sourceInfo: typeof sourceInfo }>;
  getAllTools(): ToolInfo[];
  getToolDefinition(name: string): ToolDefinition | undefined;
}

const permissivePolicy = (): PolicyHarness => ({
  hasHandlers: () => false,
  async emitToolCall() {
    return undefined;
  },
  async emitToolResult() {
    return undefined;
  },
});

const sessionHarness = (
  definitions: ToolDefinition[],
  runner: PolicyHarness = permissivePolicy(),
) => {
  // SAFETY: harness supplies fields read by AgentSession tool lookup methods only.
  const session = Object.create(AgentSession.prototype) as SessionHarness;
  session._extensionRunner = runner;
  session._toolDefinitions = new Map(
    definitions.map((entry) => [entry.name, { definition: entry, sourceInfo }]),
  );
  return session;
};

describe("PiToolBridge", () => {
  test("captures unbundled session and resolves late registrations lazily", async () => {
    const bridge = await PiToolBridge.create();
    const first = definition("first");
    const session = sessionHarness([first]);

    bridge.capture({ getAllTools: () => session.getAllTools() });
    expect(bridge.status()).toMatchObject({ available: true, host: "unbundled", tools: 1 });
    expect(bridge.definition("first")).toBe(first);

    const late = definition("late");
    session._toolDefinitions.set("late", { definition: late, sourceInfo });
    expect(bridge.definition("late")).toBe(late);
    expect(bridge.tools().map((entry) => entry.name)).toEqual(["first", "late"]);
  });

  test("does not wrap a session prototype twice", async () => {
    await PiToolBridge.create();
    const wrapped = AgentSession.prototype.getAllTools;
    await PiToolBridge.create();

    expect(AgentSession.prototype.getAllTools).toBe(wrapped);
  });

  test("fails closed when host session cannot be captured", async () => {
    const bridge = await PiToolBridge.create();

    bridge.capture({ getAllTools: () => [] });

    expect(bridge.status()).toEqual({
      available: false,
      host: "unsupported",
      reason: "Current Pi host does not expose an importable shared AgentSession",
      tools: 0,
    });
    expect(bridge.definition("missing")).toBeUndefined();
    // SAFETY: unavailable bridge rejects before it can read ExtensionContext.
    const ctx = {} as ExtensionContext;
    await expect(
      bridge.invoke("missing", "unavailable", {}, undefined, () => {}, ctx),
    ).rejects.toThrow("Current Pi host does not expose an importable shared AgentSession");
  });

  test("runs tool-call policy before execution and tool-result policy after execution", async () => {
    const InputSchema = Type.Object({ value: Type.String() }, { additionalProperties: false });
    let executed = false;
    const target: ToolDefinition<typeof InputSchema> = {
      name: "guarded",
      label: "Guarded",
      description: "Policy target",
      parameters: InputSchema,
      async execute(_id, input) {
        executed = true;
        return { content: [{ type: "text", text: input.value }], details: {} };
      },
    };
    const blocking: PolicyHarness = {
      hasHandlers: () => true,
      async emitToolCall() {
        return { block: true, reason: "blocked by policy" };
      },
      async emitToolResult() {
        return undefined;
      },
    };
    const blockedBridge = await PiToolBridge.create();
    blockedBridge.capture({
      getAllTools: () => sessionHarness([target], blocking).getAllTools(),
    });
    // SAFETY: blocked policy returns before target can read ExtensionContext.
    const ctx = {} as ExtensionContext;

    await expect(
      blockedBridge.invoke("guarded", "blocked", { value: "raw" }, undefined, () => {}, ctx),
    ).rejects.toThrow("blocked by policy");
    expect(executed).toBe(false);

    const transforming: PolicyHarness = {
      hasHandlers: () => true,
      async emitToolCall(event) {
        event.input.value = "policy input";
        return undefined;
      },
      async emitToolResult() {
        return { content: [{ type: "text", text: "policy result" }] };
      },
    };
    const transformedBridge = await PiToolBridge.create();
    transformedBridge.capture({
      getAllTools: () => sessionHarness([target], transforming).getAllTools(),
    });
    const transformed = await transformedBridge.invoke(
      "guarded",
      "transformed",
      { value: "raw" },
      undefined,
      () => {},
      ctx,
    );

    expect(executed).toBe(true);
    expect(transformed.content).toEqual([{ type: "text", text: "policy result" }]);
  });

  test("new bridge capture does not reuse stale session", async () => {
    const stale = await PiToolBridge.create();
    const current = await PiToolBridge.create();
    stale.capture({ getAllTools: () => sessionHarness([definition("old")]).getAllTools() });
    current.capture({ getAllTools: () => sessionHarness([definition("new")]).getAllTools() });

    expect(stale.definition("old")?.name).toBe("old");
    expect(current.definition("old")).toBeUndefined();
    expect(current.definition("new")?.name).toBe("new");
  });
});
