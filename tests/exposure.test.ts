import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";

import callscriptExtension, { activeToolsForMode } from "../src/index.js";
import { STATE_ENTRY } from "../src/types.js";

const initialTools = ["read", "fabric_exec", "fff_multi_grep"] as const;

describe("CallScript additive exposure", () => {
  test("startup with persisted on adds one CallScript tool", async () => {
    let activeTools: string[] = [...initialTools];
    let sessionStart: ExtensionHandler<SessionStartEvent> | undefined;
    const host = {
      registerTool() {},
      registerCommand() {},
      appendEntry() {},
      on(event: string, handler: ExtensionHandler<SessionStartEvent>) {
        if (event === "session_start") sessionStart = handler;
      },
      getActiveTools: () => activeTools,
      setActiveTools(nextTools: string[]) {
        activeTools = nextTools;
      },
    };
    // SAFETY: extension initialization uses only host methods supplied above.
    // @ts-expect-error Partial host is deliberate for lifecycle integration test.
    await callscriptExtension(host as ExtensionAPI);
    const context = {
      cwd: process.cwd(),
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: STATE_ENTRY,
            data: { version: 1, mode: "on" },
          },
        ],
      },
      ui: { setStatus() {} },
    };
    // SAFETY: session_start handler uses only cwd, sessionManager.getBranch, and ui.setStatus.
    // @ts-expect-error Partial context is deliberate for lifecycle integration test.
    await sessionStart?.({ type: "session_start", reason: "startup" }, context as ExtensionContext);

    expect(activeTools).toEqual([...initialTools, "callscript"]);
  });

  test("exposes help, doctor, and jobs command paths", async () => {
    let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> } | undefined;
    const notices: string[] = [];
    const host = {
      registerTool() {},
      registerCommand(_name: string, definition: typeof command) {
        command = definition;
      },
      appendEntry() {},
      on() {},
      getActiveTools: () => [...initialTools],
      setActiveTools() {},
    };
    // SAFETY: extension initialization uses only host methods supplied above.
    // @ts-expect-error Partial host is deliberate for command integration test.
    await callscriptExtension(host as ExtensionAPI);
    const context = {
      cwd: process.cwd(),
      ui: { notify: (message: string) => notices.push(message) },
    };
    // SAFETY: these command paths use only cwd and ui.notify.
    // @ts-expect-error Partial context is deliberate for command integration test.
    const commandContext: ExtensionContext = context;
    await command?.handler("help", commandContext);
    await command?.handler("doctor", commandContext);
    await command?.handler("jobs", commandContext);

    expect(notices[0]).toContain("/callscript [on|off|status|jobs|help|doctor|reload|reset]");
    expect(notices[1]).toContain("CallScript doctor: ready");
    expect(notices[2]).toBe("No CallScript jobs.");
  });

  test("persists a post-result job settlement and restores it without repeating work", async () => {
    interface CapturedSessionData {
      version: 1;
      job: { id: string; status: string; repeatSafe: boolean };
    }
    type CapturedTool = {
      execute: (
        toolCallId: string,
        input: { script: string },
        signal: AbortSignal | undefined,
        update: undefined,
        ctx: ExtensionContext,
      ) => Promise<{ details: unknown; isError: boolean }>;
    };

    const branch: object[] = [];
    const persisted = Promise.withResolvers<void>();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      setTimeout(() => response.end("settled"), 200);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (address === null) throw new Error("Missing test port");
      // SAFETY: server listens on a TCP host, so Node returns AddressInfo.
      const port = (address as AddressInfo).port;
      let tool: CapturedTool | undefined;
      let sessionStart: ExtensionHandler<SessionStartEvent> | undefined;
      const host = {
        registerTool(definition: CapturedTool) {
          tool = definition;
        },
        registerCommand() {},
        appendEntry(customType: string, data: CapturedSessionData) {
          branch.push({ type: "custom", customType, data });
          persisted.resolve();
        },
        on(event: string, handler: ExtensionHandler<SessionStartEvent>) {
          if (event === "session_start") sessionStart = handler;
        },
        getActiveTools: () => [...initialTools],
        setActiveTools() {},
      };
      // SAFETY: lifecycle harness supplies every extension method used by this test.
      // @ts-expect-error Partial host is deliberate for lifecycle integration test.
      await callscriptExtension(host as ExtensionAPI);
      const context = {
        cwd: process.cwd(),
        sessionManager: { getBranch: () => branch },
        ui: { setStatus() {} },
      };
      // SAFETY: execution uses only cwd, sessionManager, and UI methods supplied above.
      // @ts-expect-error Partial context is deliberate for lifecycle integration test.
      const extensionContext: ExtensionContext = context;
      await sessionStart?.({ type: "session_start", reason: "startup" }, extensionContext);
      if (tool === undefined) throw new Error("CallScript tool was not registered");
      const result = await tool.execute(
        "detached-job",
        {
          script: `const job = http({ url: "http://127.0.0.1:${port}", method: "GET" }); const ready = await wait({ milliseconds: 0 }); return ready;`,
        },
        undefined,
        undefined,
        extensionContext,
      );
      expect(result.isError).toBe(false);
      branch.push({
        type: "message",
        message: { role: "toolResult", toolName: "callscript", details: result.details },
      });
      await persisted.promise;
      expect(requests).toBe(1);
      const settlement = branch.at(-1);
      expect(settlement).toMatchObject({
        type: "custom",
        customType: "pi-callscript-job",
        data: {
          version: 1,
          job: { id: "job", status: "done", repeatSafe: false },
        },
      });
      expect(Buffer.byteLength(JSON.stringify(settlement), "utf8")).toBeLessThan(4_096);

      const notices: string[] = [];
      let restoredStart: ExtensionHandler<SessionStartEvent> | undefined;
      let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> } | undefined;
      const freshHost = {
        registerTool() {},
        registerCommand(_name: string, definition: typeof command) {
          command = definition;
        },
        appendEntry(customType: string, data: CapturedSessionData) {
          branch.push({ type: "custom", customType, data });
        },
        on(event: string, handler: ExtensionHandler<SessionStartEvent>) {
          if (event === "session_start") restoredStart = handler;
        },
        getActiveTools: () => [...initialTools],
        setActiveTools() {},
      };
      // SAFETY: fresh lifecycle harness supplies every extension method used by this test.
      // @ts-expect-error Partial host is deliberate for lifecycle integration test.
      await callscriptExtension(freshHost as ExtensionAPI);
      const freshContext = {
        cwd: process.cwd(),
        sessionManager: { getBranch: () => branch },
        ui: { setStatus() {}, notify: (message: string) => notices.push(message) },
      };
      // SAFETY: fresh session and command use only supplied context methods.
      // @ts-expect-error Partial context is deliberate for lifecycle integration test.
      const restoredContext: ExtensionContext = freshContext;
      await restoredStart?.({ type: "session_start", reason: "startup" }, restoredContext);
      await command?.handler("jobs", restoredContext);

      expect(notices).toEqual([
        "job · http · http://127.0.0.1:" + port + " · done · repeatSafe=false",
      ]);
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  test("repeated on stays idempotent", () => {
    const first = activeToolsForMode("on", initialTools);

    expect(activeToolsForMode("on", first)).toEqual(first);
  });

  test("off removes only CallScript", () => {
    const active = [...initialTools, "callscript"];

    expect(activeToolsForMode("off", active)).toEqual(initialTools);
  });

  test("command transitions preserve dynamic additions", () => {
    const started = activeToolsForMode("on", initialTools);
    const withDynamicTool = [...started, "mcp_dynamic"];
    const disabled = activeToolsForMode("off", withDynamicTool);

    expect(activeToolsForMode("on", disabled)).toEqual([
      ...initialTools,
      "mcp_dynamic",
      "callscript",
    ]);
  });

  test("command transitions do not restore dynamic removals", () => {
    const started = activeToolsForMode("on", initialTools);
    const withoutFff = started.filter((name) => name !== "fff_multi_grep");
    const disabled = activeToolsForMode("off", withoutFff);

    expect(activeToolsForMode("on", disabled)).toEqual(["read", "fabric_exec", "callscript"]);
  });
});
