import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vitest";

import { CALLSCRIPT_MODE_PROMPT } from "../src/index.js";
import { validationReplacement } from "../src/language.js";
import { CallScriptRuntime } from "../src/runtime.js";
import type { ExtensionConfig, InvocationInput } from "../src/types.js";

const directories: string[] = [];
const config: ExtensionConfig = {
  mode: "on",
  limits: {
    maxSteps: 30,
    maxItemsPerStep: 100,
    maxTotalCalls: 200,
    maxConcurrency: 12,
    maxCallResultBytes: 10_485_760,
  },
  httpTimeoutMs: 30_000,
  maxHttpResultBytes: 5_242_880,
};

const workspace = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-callscript-language-"));
  directories.push(directory);
  return directory;
};

const invocation = (cwd: string): InvocationInput => {
  const empty = Object.create(null);
  return {
    id: "language-test",
    signal: undefined,
    update: undefined,
    ctx: {
      ui: empty,
      mode: "json",
      hasUI: false,
      cwd,
      sessionManager: empty,
      modelRegistry: empty,
      model: undefined,
      scopedModels: [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      signal: undefined,
      abort: () => undefined,
      hasPendingMessages: () => false,
      shutdown: () => undefined,
      getContextUsage: () => undefined,
      compact: () => undefined,
      getSystemPrompt: () => "",
    } satisfies ExtensionContext,
  };
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("stable CallScript language card", () => {
  test("produces identical fixed guidance bytes with supported and unsupported forms", async () => {
    const firstCwd = await workspace();
    const secondCwd = await workspace();
    const first = new CallScriptRuntime(firstCwd, config).languageCard();
    const second = new CallScriptRuntime(secondCwd, config).languageCard();

    expect(Buffer.from(first)).toEqual(Buffer.from(second));
    expect(first).toContain("top-level const declarations");
    expect(first).toContain("try/catch recovery");
    expect(first).toContain("tagged templates");
    expect(first).toContain("per-call .catch");
    expect(first).toContain("use owning Pi tools directly for Fabric, FFF, MCP, subagent");
    expect(first).not.toContain(firstCwd);
    expect(first).not.toContain(secondCwd);
    expect(CALLSCRIPT_MODE_PROMPT).not.toMatch(/timestamp|counter|progress/i);
  });

  test("maps invalid source to stable CS codes and valid replacements", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "file.txt"), "ok");
    const runtime = new CallScriptRuntime(cwd, config);
    const invalid = await Effect.runPromise(
      runtime.execute("const matcher = /TODO/; return matcher;", invocation(cwd)),
    );
    const repeated = await Effect.runPromise(
      runtime.execute("const matcher = /TODO/; return matcher;", invocation(cwd)),
    );

    expect(invalid.isError).toBe(true);
    expect(invalid.text).toBe(repeated.text);
    expect(invalid.text).toContain("CS002");
    expect(invalid.text).toContain(`Replacement: ${validationReplacement("CS002")}`);

    const corrected = await Effect.runPromise(
      runtime.execute(validationReplacement("CS001"), invocation(cwd)),
    );
    expect(corrected.isError, corrected.text).toBe(false);
  });

  test("inspects only fixed capabilities", async () => {
    const cwd = await workspace();
    const runtime = new CallScriptRuntime(cwd, config);
    const result = await Effect.runPromise(
      runtime.execute('return await tools({ query: "read" });', invocation(cwd)),
    );

    expect(result.isError, result.text).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ fixed: true, names: ["read"] });
    expect(runtime.tools.map((entry) => entry.name)).not.toContain("fabric_exec");
  });
});
