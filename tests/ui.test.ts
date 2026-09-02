import { describe, expect, test } from "vitest";

import { renderScriptCall, renderScriptResult } from "../src/ui.js";
import { isRunDetails } from "../src/index.js";
import type { Activity, RunDetails } from "../src/types.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const render = (component: { render(width: number): string[] }, width = 120) =>
  component.render(width).join("\n");

const runDetails = (activity: Activity[], elapsedMs = 1_420): RunDetails => {
  const calls = activity.filter((event) => event.phase === "start").length;
  const completed = activity.filter(
    (event) => event.phase === "done" || event.phase === "error",
  ).length;
  return {
    version: 1,
    mode: "on",
    status: completed === calls ? "ok" : "running",
    elapsedMs,
    calls,
    completed,
    active: calls - completed,
    activity,
  };
};

describe("CallScript UI", () => {
  test("uses Pi's native shell and hides source until expanded", () => {
    const script = Array.from(
      { length: 14 },
      (_value, index) => `const value${index} = await read({ path: "${index}.txt" });`,
    ).join("\n");
    const collapsed = render(renderScriptCall(script, false, "settled", theme));
    const expanded = render(renderScriptCall(script, true, "settled", theme));

    expect(collapsed.trimEnd()).toBe("CallScript · 14 planned");
    expect(collapsed).not.toContain("╭");
    expect(collapsed).not.toContain("Read 14×");
    expect(collapsed).not.toContain("const value7");
    expect(expanded).toContain("const value7");
  });

  test("hides unselected branch when collapsed and marks it skipped when expanded", () => {
    const activity: Activity[] = [
      {
        sequence: 1,
        atMs: 0,
        step: "unusedBranch",
        tool: "write",
        phase: "queued",
        selection: "selected",
        target: "unused.txt",
      },
      {
        sequence: 2,
        atMs: 1,
        step: "unusedBranch",
        tool: "write",
        phase: "skipped",
        selection: "skipped",
        target: "unused.txt",
        result: "branch not selected",
      },
    ];
    const collapsed = render(
      renderScriptResult("done", runDetails(activity), false, false, false, theme),
    );
    const expanded = render(
      renderScriptResult("done", runDetails(activity), true, false, false, theme),
    );

    expect(collapsed).toContain("1 not run");
    expect(collapsed).not.toContain("unused.txt");
    expect(expanded).toContain("unused.txt");
    expect(expanded).toContain("branch not selected");
  });

  test("shows each target and its settlement as a child result", () => {
    const activity: Activity[] = [
      {
        sequence: 1,
        atMs: 0,
        step: "manifest",
        tool: "read",
        phase: "start",
        target: "package.json",
      },
      {
        sequence: 2,
        atMs: 4,
        step: "manifest",
        tool: "read",
        phase: "done",
        target: "package.json",
        result: "42 lines",
        elapsedMs: 4,
      },
    ];
    const output = JSON.stringify({ loaded: true, preview: "", httpStatus: 200 });
    const compact = render(
      renderScriptResult(output, runDetails(activity), false, false, false, theme),
    );

    expect(compact).toContain("1 done · 1.4 s");
    expect(compact).toContain("└─ ✓ Read  package.json");
    expect(compact).toContain("└─ 42 lines · 4 ms");
    expect(compact).toContain("Result");
    expect(compact).toContain("loaded ✓");
    expect(compact).toContain("preview —");
    expect(compact).toContain("HTTP status 200");
    expect(compact).not.toContain("{");
    expect(compact).not.toContain('"loaded"');
  });

  test("accepts Pi-enriched details without mislabeling a successful run", () => {
    const activity: Activity[] = [
      {
        sequence: 1,
        atMs: 0,
        step: "cleanup",
        tool: "run",
        phase: "start",
        target: "cleanup command",
      },
      {
        sequence: 2,
        atMs: 12,
        step: "cleanup",
        tool: "run",
        phase: "done",
        target: "cleanup command",
        result: "finished · 1 output line",
        elapsedMs: 12,
      },
    ];
    const enriched = {
      ...runDetails(activity),
      toolMetadata: { durationMs: 12 },
      outputGuard: { detailsSanitized: true },
    };

    expect(isRunDetails(enriched)).toBe(true);
    const compact = render(
      renderScriptResult(
        JSON.stringify({ cleanup: "cleanup-ok" }),
        isRunDetails(enriched) ? enriched : undefined,
        false,
        false,
        false,
        theme,
      ),
    );

    expect(compact).toContain("1 done");
    expect(compact).toContain("cleanup command");
    expect(compact).not.toContain("Failed");
  });

  test("does not infer failure when successful result details are unavailable", () => {
    const compact = render(renderScriptResult("cleanup-ok", undefined, false, false, false, theme));

    expect(compact).toContain("✓ Done");
    expect(compact).not.toContain("Failed");
  });

  test("identifies the active blocker, elapsed age, and timeout", () => {
    const activity: Activity[] = [
      {
        sequence: 1,
        atMs: 0,
        step: "manifest",
        tool: "read",
        phase: "start",
        target: "package.json",
      },
      {
        sequence: 2,
        atMs: 20,
        step: "manifest",
        tool: "read",
        phase: "done",
        target: "package.json",
        result: "42 lines",
        elapsedMs: 20,
      },
      {
        sequence: 3,
        atMs: 200,
        step: "tests",
        tool: "run",
        phase: "start",
        target: "bun test",
        timeoutMs: 120_000,
      },
    ];
    const running = render(
      renderScriptResult("Running", runDetails(activity, 12_200), false, true, false, theme),
    );

    expect(running).toContain("1 done · 1 running · 12.2 s");
    expect(running).toContain("└─ ● Run  bun test");
    expect(running).toContain("running 12.0 s · timeout 2m 0s");
  });

  test("marks long-running tools that have no timeout", () => {
    const activity: Activity[] = [
      {
        sequence: 1,
        atMs: 0,
        step: "command",
        tool: "run",
        phase: "start",
        target: "long task",
      },
    ];
    const running = render(
      renderScriptResult("Running", runDetails(activity, 15_000), false, true, false, theme),
    );

    expect(running).toContain("still running 15.0 s · no timeout");
  });

  test("keeps every step in the compact tree without recompression", () => {
    const activity: Activity[] = Array.from({ length: 10 }, (_value, index) => ({
      sequence: index + 1,
      atMs: index * 10,
      step: `step-${index}`,
      tool: "read",
      phase: "start" as const,
      target: `${index}.txt`,
    }));
    const compact = render(
      renderScriptResult("Running", runDetails(activity, 200), false, true, false, theme),
    );

    expect(compact).toContain("0.txt");
    expect(compact).toContain("5.txt");
    expect(compact).toContain("9.txt");
    expect(compact).not.toContain("steps hidden");
  });

  test("shows ready, running, done, and failed state per planned call", () => {
    const activity: Activity[] = [
      { sequence: 1, atMs: 0, step: "a", tool: "read", phase: "queued", target: "a.txt" },
      { sequence: 2, atMs: 0, step: "b", tool: "read", phase: "queued", target: "b.txt" },
      { sequence: 3, atMs: 0, step: "c", tool: "run", phase: "queued", target: "bun test" },
      {
        sequence: 4,
        atMs: 0,
        step: "after",
        tool: "edit",
        phase: "queued",
        target: "result.ts",
      },
      { sequence: 5, atMs: 1, step: "a", tool: "read", phase: "start", target: "a.txt" },
      { sequence: 6, atMs: 1, step: "b", tool: "read", phase: "start", target: "b.txt" },
      { sequence: 7, atMs: 1, step: "c", tool: "run", phase: "start", target: "bun test" },
      {
        sequence: 8,
        atMs: 10,
        step: "a",
        tool: "read",
        phase: "done",
        target: "a.txt",
        result: "12 lines",
        elapsedMs: 9,
      },
      {
        sequence: 9,
        atMs: 11,
        step: "b",
        tool: "read",
        phase: "error",
        target: "b.txt",
        error: "missing",
        elapsedMs: 10,
      },
    ];
    const compact = render(
      renderScriptResult("Running", runDetails(activity, 500), false, true, false, theme),
    );

    expect(compact).toContain("1 done · 1 running · 1 ready · 1 failed");
    expect(compact).toContain("✓ Read  a.txt");
    expect(compact).toContain("× Read  b.txt");
    expect(compact).toContain("● Run  bun test");
    expect(compact).toContain("○ Edit  result.ts");
    expect(compact).not.toContain("not launched");
  });

  test("renders a thinking checkpoint without leaking its transport marker", () => {
    const activity: Activity[] = [
      {
        sequence: 1,
        atMs: 0,
        step: "pause",
        tool: "think",
        phase: "queued",
        target: "choose the next edit",
      },
      {
        sequence: 2,
        atMs: 1,
        step: "after",
        tool: "edit",
        phase: "queued",
        target: "src/index.ts",
      },
      {
        sequence: 3,
        atMs: 2,
        step: "pause",
        tool: "think",
        phase: "start",
        target: "choose the next edit",
      },
      {
        sequence: 4,
        atMs: 3,
        step: "pause",
        tool: "think",
        phase: "done",
        target: "choose the next edit",
        result: "thinking checkpoint",
        elapsedMs: 1,
      },
    ];
    const details: RunDetails = { ...runDetails(activity, 3), status: "paused" };
    const compact = render(
      renderScriptResult(
        JSON.stringify({ $callscript: "think", note: "choose the next edit" }),
        details,
        false,
        false,
        false,
        theme,
      ),
    );

    expect(compact).toContain("thinking · 1 done · 1 ready");
    expect(compact).toContain("✓ Think  choose the next edit");
    expect(compact).toContain("○ Edit  src/index.ts");
    expect(compact).not.toContain("$callscript");
  });

  test("keeps both ends of giant output without leaking a giant line", () => {
    const output = `HEAD${"x".repeat(100_000)}TAIL`;
    const compact = render(renderScriptResult(output, undefined, false, false, false, theme));

    expect(compact.length).toBeLessThan(1_000);
    expect(compact).toContain("HEAD");
    expect(compact).toContain("TAIL");
  });

  test("summarizes oversized structured output without parsing or printing JSON", () => {
    const output = JSON.stringify({
      rows: Array.from({ length: 40_000 }, (_value, index) => ({ index, ready: true })),
    });
    const compact = render(renderScriptResult(output, undefined, false, false, false, theme));

    expect(compact.length).toBeLessThan(260);
    expect(compact).toContain("Structured result");
    expect(compact).not.toContain("{");
  });

  test("projects incomplete composing source without counting comments or strings", () => {
    const composing = render(
      renderScriptCall(
        '// read({ path: "ignored" })\nconst note = "write({})";\nawait read({ path: "src/runtime.ts" });\nawait search({ pattern: "update callback"',
        false,
        "composing",
        theme,
      ),
    );

    expect(composing).toContain("CallScript · composing");
    expect(composing).toContain("Read  src/runtime.ts");
    expect(composing).toContain("Search  update callback");
    expect(composing).toContain("receiving next operation");
    expect(composing).not.toContain("ignored");
  });

  test("renders invalid source once without phantom plan", () => {
    const details = runDetails([]);
    const invalid: RunDetails = { ...details, status: "invalid" };
    const output = render(
      renderScriptResult(
        "CS102 line 1, column 8: invalid fan-out. Use: await read({ path: item })",
        invalid,
        false,
        false,
        true,
        theme,
      ),
    );

    expect(output).toContain("Invalid source");
    expect(output).toContain("line 1, column 8");
    expect(output).toContain("Use:");
    expect(output).not.toContain("planned");
    expect(output).not.toContain("Result");
  });

  test("shows cancellation as distinct state with explicit plural labels", () => {
    const activity: Activity[] = [
      { sequence: 1, atMs: 0, step: "wait", tool: "wait", phase: "start", target: "1000 ms" },
      {
        sequence: 2,
        atMs: 5,
        step: "wait",
        tool: "wait",
        phase: "error",
        target: "1000 ms",
        error: "Wait aborted",
        elapsedMs: 5,
      },
    ];
    const output = render(
      renderScriptResult(
        "Wait aborted",
        { ...runDetails(activity, 5), cancelled: 1 },
        false,
        false,
        true,
        theme,
      ),
    );

    expect(output).toContain("1 cancelled");
    expect(output).toContain("cancelled");
    expect(output).not.toContain("1 failed");
  });

  test("renders native edit diff with bounded hunk totals", () => {
    const activity: Activity[] = [
      {
        sequence: 1,
        atMs: 0,
        step: "edit",
        tool: "edit",
        phase: "start",
        target: "src/example.ts",
      },
      {
        sequence: 2,
        atMs: 11,
        step: "edit",
        tool: "edit",
        phase: "done",
        target: "src/example.ts",
        result: "applied",
        elapsedMs: 11,
        presentation: {
          kind: "edit",
          diff: "@@ -1,2 +1,3 @@\n const value = 1;\n-old();\n+new();\n+next();\n@@ -10,1 +11,2 @@\n-oldLater();\n+newLater();",
          patch: "@@ -1,2 +1,3 @@",
          firstChangedLine: 2,
          hunkCount: 2,
          addedLines: 3,
          removedLines: 2,
        },
      },
    ];
    const output = render(
      renderScriptResult("done", runDetails(activity, 11), false, false, false, theme),
    );

    expect(output).toContain("2 hunks · +3 -2 · line 2");
    expect(output).toContain("… 1 hunk hidden");
    expect(output).toContain("+new();");
    expect(output).not.toContain("newLater");
    const expanded = render(
      renderScriptResult("done", runDetails(activity, 11), true, false, false, theme),
    );
    expect(expanded).toContain("newLater");
    expect(expanded).not.toContain("patch");
  });
});
