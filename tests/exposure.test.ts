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
