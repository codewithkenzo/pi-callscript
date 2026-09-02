import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter, once } from "node:events";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { CallScriptRuntime } from "../src/runtime.js";
import {
  EXTENSION_TOOLS,
  type ExtensionConfig,
  type InvocationInput,
  type JobReceipt,
  type RunDetails,
} from "../src/types.js";

const directories: string[] = [];

const AddressInfoSchema = Type.Object({
  address: Type.String(),
  family: Type.String(),
  port: Type.Number(),
});

const isAddressInfo = <T>(value: T): value is T & AddressInfo =>
  Value.Check(AddressInfoSchema, value);

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

const context = (cwd: string): ExtensionContext => {
  const empty = Object.create(null);
  return {
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
  };
};

const invocation = (
  cwd: string,
  update: InvocationInput["update"] = undefined,
  signal: AbortSignal | undefined = undefined,
): InvocationInput => ({
  id: "test",
  signal,
  ctx: context(cwd),
  update,
});

const workspace = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-callscript-"));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("configuration boundary", () => {
  test("decodes external JSON through schema before applying output budget", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "callscript.json"), '{"maxOutputBytes":4096}');

    const loaded = await Effect.runPromise(loadConfig(cwd));

    expect(loaded.maxOutputBytes).toBe(4_096);
  });

  test("returns tagged config failure for invalid external JSON shape", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "callscript.json"), '{"maxOutputBytes":"large"}');

    await expect(Effect.runPromise(loadConfig(cwd))).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("CallScriptRuntime", () => {
  test("keeps the extension surface to one tool", () => {
    expect(EXTENSION_TOOLS).toEqual(["callscript"]);
  });

  test("composes Pi write, read, and list tools", async () => {
    const cwd = await workspace();
    const runtime = new CallScriptRuntime(cwd, config);
    const result = await Effect.runPromise(
      runtime.execute(
        `
const names = ["alpha.txt", "beta.txt"];
const written = await Promise.all(
  names.slice(0, 2).map(name => write({ path: name, content: name }))
);
const first = await read({ path: "alpha.txt" });
if (!first.includes("alpha.txt")) return { ok: false };
const listed = await list({ path: "." });
return { ok: true, writes: written.length, listed };
`,
        invocation(cwd),
      ),
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ ok: true, writes: 2 });
    expect(result.details.calls).toBe(4);
    await expect(readFile(join(cwd, "beta.txt"), "utf8")).resolves.toBe("beta.txt");
  });

  test("runs independent batch items concurrently", async () => {
    const cwd = await workspace();
    const runtime = new CallScriptRuntime(cwd, config);
    const updates: RunDetails[] = [];
    const result = await Effect.runPromise(
      runtime.execute(
        `
const delays = [50, 51, 52];
const settled = await Promise.all(
  delays.slice(0, 3).map(milliseconds => wait({ milliseconds }))
);
return settled.length;
`,
        invocation(cwd, (result) => updates.push(result.details)),
      ),
    );

    expect(result.isError).toBe(false);
    expect(result.text).toBe("3");
    expect(result.details.calls).toBe(3);
    expect(result.details.activity.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.details.activity.find((event) => event.phase === "start")).toMatchObject({
      tool: "wait",
      target: "50 ms",
      expectedMs: 50,
    });
    expect(result.details.activity.at(-1)?.result).toMatch(/^waited 5[0-2] ms$/);
    const phases = result.details.activity.map((event) => event.phase);
    expect(phases.lastIndexOf("start")).toBeLessThan(phases.indexOf("done"));
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.length).toBeLessThan(result.details.activity.length);
  });

  test("pauses for agent reasoning between a parallel wave and dependent work", async () => {
    const cwd = await workspace();
    const runtime = new CallScriptRuntime(cwd, config);
    const script = `
const probes = await Promise.all([
  wait({ milliseconds: 20 }),
  wait({ milliseconds: 21 }),
  wait({ milliseconds: 22 })
]);
await think({ note: "inspect the first wave" });
const final = await write({ path: "after-thinking.txt", content: "chosen after reasoning" });
return { probes, final };
`;

    const paused = await Effect.runPromise(runtime.execute(script, invocation(cwd)));

    expect(paused.isError).toBe(false);
    expect(paused.details.status).toBe("paused");
    expect(paused.text).toBe("Paused: inspect the first wave");
    expect(
      paused.details.activity.some(
        (event) => event.phase === "queued" && event.target === "after-thinking.txt",
      ),
    ).toBe(true);
    expect(
      paused.details.activity.some(
        (event) => event.phase === "start" && event.target === "after-thinking.txt",
      ),
    ).toBe(false);
    await expect(readFile(join(cwd, "after-thinking.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const resumed = await Effect.runPromise(runtime.execute(script, invocation(cwd)));

    expect(resumed.isError, resumed.text).toBe(false);
    expect(resumed.details.status).toBe("ok");
    await expect(readFile(join(cwd, "after-thinking.txt"), "utf8")).resolves.toBe(
      "chosen after reasoning",
    );
  });

  test("restores changed and newly created files from a named snapshot", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "existing.txt"), "before");
    const runtime = new CallScriptRuntime(cwd, config);

    const changed = await Effect.runPromise(
      runtime.execute(
        `
const point = await snapshot({ paths: ["existing.txt", "created.txt"] });
await write({ path: "existing.txt", content: "after" });
await write({ path: "created.txt", content: "new" });
return point;
`,
        invocation(cwd),
      ),
    );

    expect(changed.isError, changed.text).toBe(false);
    expect(JSON.parse(changed.text)).toMatchObject({
      id: "snap-1",
      files: ["existing.txt", "created.txt"],
    });
    await expect(readFile(join(cwd, "existing.txt"), "utf8")).resolves.toBe("after");
    await expect(readFile(join(cwd, "created.txt"), "utf8")).resolves.toBe("new");

    const undone = await Effect.runPromise(
      runtime.execute(
        "const restored = await undo({ snapshot: point.id }); return restored;",
        invocation(cwd),
      ),
    );

    expect(undone.isError, undone.text).toBe(false);
    expect(JSON.parse(undone.text)).toMatchObject({ snapshot: "snap-1" });
    await expect(readFile(join(cwd, "existing.txt"), "utf8")).resolves.toBe("before");
    await expect(readFile(join(cwd, "created.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("refreshes active tool age while an otherwise quiet call is running", async () => {
    const cwd = await workspace();
    const runtime = new CallScriptRuntime(cwd, config);
    const updates: RunDetails[] = [];
    const result = await Effect.runPromise(
      runtime.execute(
        "return await wait({ milliseconds: 1100 });",
        invocation(cwd, (update) => updates.push(update.details)),
      ),
    );

    expect(result.isError).toBe(false);
    expect(updates.some((update) => update.active === 1 && update.elapsedMs >= 900)).toBe(true);
  });

  test("closes progress publishing after Pi rejects an update", async () => {
    const cwd = await workspace();
    const runtime = new CallScriptRuntime(cwd, config);
    let updateAttempts = 0;
    const result = await Effect.runPromise(
      runtime.execute(
        "return await wait({ milliseconds: 0 });",
        invocation(cwd, () => {
          updateAttempts += 1;
          throw new Error("closed tool row");
        }),
      ),
    );

    expect(result.isError, result.text).toBe(false);
    expect(result.details.activity.at(-1)?.phase).toBe("done");
    await Effect.runPromise(Effect.sleep(1_050));
    expect(updateAttempts).toBe(1);
  });

  test("publishes prior results into the next script", async () => {
    const cwd = await workspace();
    const runtime = new CallScriptRuntime(cwd, config);
    const first = await Effect.runPromise(
      runtime.execute(
        "const saved = await wait({ milliseconds: 1 }); return saved;",
        invocation(cwd),
      ),
    );
    expect(first.isError).toBe(false);

    const second = await Effect.runPromise(
      runtime.execute("return saved.waitedMs;", invocation(cwd)),
    );
    expect(second.isError).toBe(false);
    expect(second.text).toBe("1");
  });

  test("restores serialized state into a fresh runtime", async () => {
    const cwd = await workspace();
    const original = new CallScriptRuntime(cwd, config);
    const first = await Effect.runPromise(
      original.execute(
        "const restoredValue = await wait({ milliseconds: 1 }); return restoredValue;",
        invocation(cwd),
      ),
    );
    expect(first.isError).toBe(false);

    const restored = new CallScriptRuntime(cwd, config);
    await Effect.runPromise(restored.restore(first.details.state));
    const second = await Effect.runPromise(
      restored.execute("return restoredValue.waitedMs;", invocation(cwd)),
    );
    expect(second.isError).toBe(false);
    expect(second.text).toBe("1");
  });

  test("releases outputs that no result or later step can read", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "large.txt"), "x".repeat(100_000));
    const runtime = new CallScriptRuntime(cwd, config);
    const result = await Effect.runPromise(
      runtime.execute(
        `
const unused = await read({ path: "large.txt" });
const next = await wait({ milliseconds: 0 });
const tail = await wait({ milliseconds: 1 });
return tail;
`,
        invocation(cwd),
      ),
    );

    expect(result.isError).toBe(false);
    expect(
      result.details.state?.steps.unused?.released,
      JSON.stringify(result.details.state?.steps.unused),
    ).toBe(true);
    expect(result.details.state?.steps.unused?.output).toBeUndefined();
  });

  test("resets published state explicitly", async () => {
    const cwd = await workspace();
    const runtime = new CallScriptRuntime(cwd, config);
    const first = await Effect.runPromise(
      runtime.execute(
        "const saved = await wait({ milliseconds: 0 }); return saved;",
        invocation(cwd),
      ),
    );
    expect(first.isError).toBe(false);

    await Effect.runPromise(runtime.reset());
    const afterReset = await Effect.runPromise(runtime.execute("return saved;", invocation(cwd)));
    expect(afterReset.isError).toBe(true);
    expect(afterReset.details.status).toBe("invalid");
  });

  test("cancels timers through Pi's abort signal", async () => {
    const cwd = await workspace();
    const runtime = new CallScriptRuntime(cwd, config);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await Effect.runPromise(
      runtime.execute(
        "return await wait({ milliseconds: 1000 });",
        invocation(cwd, undefined, controller.signal),
      ),
    );

    expect(result.isError).toBe(true);
    expect(result.details.activity.at(-1)?.phase).toBe("error");
    expect(result.details.active).toBe(0);
    expect(result.details.cancelled).toBe(1);
  });

  test("settles active and queued operations once on host abort", async () => {
    const cwd = await workspace();
    const runtime = new CallScriptRuntime(cwd, config);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await Effect.runPromise(
      runtime.execute(
        `
const first = await wait({ milliseconds: 1000 });
const second = await wait({ milliseconds: 1000 });
return second;
`,
        invocation(cwd, undefined, controller.signal),
      ),
    );

    expect(result.isError).toBe(true);
    expect(result.details.calls).toBe(1);
    expect(result.details.completed).toBe(1);
    expect(result.details.active).toBe(0);
    expect(result.details.queued).toBe(0);
    expect(result.details.cancelled).toBe(2);
    expect(
      result.details.activity.filter(
        (event) => event.phase === "skipped" && event.result === "host abort before launch",
      ),
    ).toHaveLength(1);
  });

  test("keeps progress payloads bounded as operation count grows", async () => {
    const cwd = await workspace();
    const runtime = new CallScriptRuntime(cwd, config);
    const updates: RunDetails[] = [];
    const delays = Array.from({ length: 100 }, () => 0);
    const result = await Effect.runPromise(
      runtime.execute(
        `const delays = ${JSON.stringify(delays)}; const values = await Promise.all(delays.slice(0, 100).map(milliseconds => wait({ milliseconds }))); return values.length;`,
        invocation(cwd, (update) => updates.push(update.details)),
      ),
    );

    expect(result.isError, result.text).toBe(false);
    expect(result.details.calls).toBe(100);
    expect(result.details.done).toBe(100);
    expect(result.details.active).toBe(0);
    expect(result.details.activity.length).toBeLessThanOrEqual(24);
    expect(result.details.activityHidden).toBeGreaterThan(0);
    expect(
      Math.max(...updates.map((update) => Buffer.byteLength(JSON.stringify(update), "utf8"))),
    ).toBeLessThan(8_192);
    expect(updates.every((update) => update.activity.length <= 12)).toBe(true);
  });

  test("keeps complete host envelope below measured 24 KiB sidecar boundary", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "large-output.txt"), `${"x".repeat(100)}🙂\n`.repeat(30_000));
    const runtime = new CallScriptRuntime(cwd, config);
    const result = await Effect.runPromise(
      runtime.execute(
        'return await read({ path: "large-output.txt", offset: 1, limit: 30000 });',
        invocation(cwd),
      ),
    );
    const envelope = {
      content: [{ type: "text", text: result.text }],
      details: result.details,
      isError: result.isError,
    };

    expect(result.isError, result.text).toBe(false);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(10_240);
    expect(Buffer.byteLength(JSON.stringify(envelope), "utf8")).toBeLessThan(24_576);
    expect(
      result.details.presentation?.receipt.hiddenBytes,
      JSON.stringify({
        receipt: result.details.presentation?.receipt,
        textBytes: Buffer.byteLength(result.text, "utf8"),
      }),
    ).toBeGreaterThan(0);
    expect(result.details.retainedState?.omittedBytes).toBeGreaterThan(2_048);
  });

  test("detaches an un-awaited job and joins it from a later script", async () => {
    const cwd = await workspace();
    const settlement = Promise.withResolvers<JobReceipt>();
    const runtime = new CallScriptRuntime(cwd, config, settlement.resolve);
    const started = await Effect.runPromise(
      runtime.execute(
        `
const job = wait({ milliseconds: 250 });
const startedNow = await wait({ milliseconds: 0 });
return { started: true };
`,
        invocation(cwd),
      ),
    );

    expect(started.isError, started.text).toBe(false);
    expect(started.details.background?.job?.status).toBe("pending");
    expect(started.details.jobs).toContainEqual({
      id: "job",
      label: "wait · job",
      status: "running",
      repeatSafe: true,
    });

    const settled = await settlement.promise;
    expect(settled).toEqual({
      id: "job",
      label: "wait · job",
      status: "done",
      repeatSafe: true,
      output: { waitedMs: 250 },
    });
    expect(Buffer.byteLength(JSON.stringify(settled.output), "utf8")).toBeLessThanOrEqual(4_096);
    const restored = new CallScriptRuntime(cwd, config);
    await Effect.runPromise(restored.restoreJobs([settled]));
    expect(restored.jobs()).toEqual([settled]);

    const joined = await Effect.runPromise(
      runtime.execute("const result = await job; return result;", invocation(cwd)),
    );
    expect(joined.isError).toBe(false);
    expect(JSON.parse(joined.text.split("\n\nBackground\n", 1)[0] ?? "")).toEqual({
      waitedMs: 250,
    });
  });

  test("reset aborts an in-flight background HTTP stream", async () => {
    const cwd = await workspace();
    const lifecycle = new EventEmitter();
    const server = createServer((_request, response) => {
      response.on("close", () => lifecycle.emit("closed"));
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("stream-open");
      lifecycle.emit("request");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (!isAddressInfo(address)) throw new Error("Missing test port");
      const requested = once(lifecycle, "request", { signal: AbortSignal.timeout(500) });
      const runtime = new CallScriptRuntime(cwd, config);
      const started = await Effect.runPromise(
        runtime.execute(
          `
const stream = http({ url: "http://127.0.0.1:${address.port}" });
const ready = await wait({ milliseconds: 0 });
return ready;
`,
          invocation(cwd),
        ),
      );
      expect(started.isError, started.text).toBe(false);
      await requested;

      const closed = once(lifecycle, "closed", { signal: AbortSignal.timeout(500) });
      await Effect.runPromise(runtime.reset());
      await closed;
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  test("stops reading HTTP bodies at the configured byte limit", async () => {
    const cwd = await workspace();
    let sent = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const server = createServer((_request, response) => {
      const write = () => {
        sent += 1;
        if (sent >= 100) {
          response.end();
          return;
        }
        response.write("x".repeat(65_536));
        timer = setTimeout(write, 2);
      };
      response.on("close", () => {
        if (timer !== undefined) clearTimeout(timer);
      });
      write();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (!isAddressInfo(address)) throw new Error("Missing test port");
      const runtime = new CallScriptRuntime(cwd, { ...config, maxHttpResultBytes: 1_024 });
      const result = await Effect.runPromise(
        runtime.execute(
          `return await http({ url: "http://127.0.0.1:${address.port}" });`,
          invocation(cwd),
        ),
      );

      expect(result.isError).toBe(false);
      expect(result.text).toContain("[truncated at 1024 bytes]");
      expect(result.details.activity[0]).toMatchObject({
        tool: "http",
        target: `http://127.0.0.1:${address.port}`,
        detail: "GET",
        timeoutMs: 30_000,
      });
      expect(result.details.activity.at(-1)?.result).toMatch(/^200 · \d+ bytes$/);
      await Effect.runPromise(Effect.sleep(20));
      expect(sent).toBeLessThan(100);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      server.close();
      await once(server, "close");
    }
  });

  test("applies the configured HTTP deadline through the body request", async () => {
    const cwd = await workspace();
    const server = createServer(() => undefined);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (!isAddressInfo(address)) throw new Error("Missing test port");
      const runtime = new CallScriptRuntime(cwd, { ...config, httpTimeoutMs: 25 });
      const result = await Effect.runPromise(
        runtime.execute(
          `return await http({ url: "http://127.0.0.1:${address.port}" });`,
          invocation(cwd),
        ),
      );

      expect(result.isError).toBe(true);
      expect(result.details.activity.at(-1)).toMatchObject({
        tool: "http",
        phase: "error",
        timeoutMs: 25,
      });
    } finally {
      const closed = once(server, "close");
      server.closeAllConnections();
      server.close();
      await closed;
    }
  });

  test("preflights every undo target before restoring any file", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "first.txt"), "before");
    const runtime = new CallScriptRuntime(cwd, config);
    const captured = await Effect.runPromise(
      runtime.execute(
        'return await snapshot({ paths: ["first.txt", "second.txt"] });',
        invocation(cwd),
      ),
    );
    expect(captured.isError, captured.text).toBe(false);

    await writeFile(join(cwd, "first.txt"), "after");
    await mkdir(join(cwd, "second.txt"));
    const undone = await Effect.runPromise(
      runtime.execute('return await undo({ snapshot: "snap-1" });', invocation(cwd)),
    );

    expect(undone.isError).toBe(true);
    await expect(readFile(join(cwd, "first.txt"), "utf8")).resolves.toBe("after");
  });

  test("returns exact navigation receipts for first, middle, final, and tail reads from ctx.cwd", async () => {
    const constructorCwd = await workspace();
    const invocationCwd = await workspace();
    await writeFile(join(invocationCwd, "lines.txt"), "one\ntwo\nthree\nfour\nfive");
    const runtime = new CallScriptRuntime(constructorCwd, config);

    const scripts = [
      'return await read({ path: "lines.txt", limit: 2 });',
      'return await read({ path: "lines.txt", offset: 3, limit: 2 });',
      'return await read({ path: "lines.txt", offset: 5 });',
      'return await read({ path: "lines.txt", tail: 2 });',
    ];
    const results = [];
    for (const script of scripts)
      results.push(await Effect.runPromise(runtime.execute(script, invocation(invocationCwd))));

    expect(results.map((result) => result.isError)).toEqual([false, false, false, false]);
    expect(results[0]?.text).toContain(
      "[Read lines 1-2 of 5; previousOffset=none; nextOffset=3; truncation=limit]",
    );
    expect(results[1]?.text).toContain(
      "[Read lines 3-4 of 5; previousOffset=1; nextOffset=5; truncation=limit]",
    );
    expect(results[2]?.text).toContain(
      "[Read lines 5-5 of 5; previousOffset=1; nextOffset=none; truncation=none]",
    );
    expect(results[3]?.text).toContain(
      "[Read lines 4-5 of 5; previousOffset=2; nextOffset=none; truncation=tail]",
    );
  });

  test("returns exact navigation receipts for newline-terminated files", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "lines.txt"), "one\ntwo\nthree\nfour\nfive\n");
    const runtime = new CallScriptRuntime(cwd, config);
    const scripts = [
      'return await read({ path: "lines.txt", limit: 2 });',
      'return await read({ path: "lines.txt", offset: 3, limit: 2 });',
      'return await read({ path: "lines.txt", offset: 5 });',
      'return await read({ path: "lines.txt", tail: 2 });',
    ];
    const results = [];
    for (const script of scripts)
      results.push(await Effect.runPromise(runtime.execute(script, invocation(cwd))));

    expect(results.map((result) => result.isError)).toEqual([false, false, false, false]);
    expect(results[0]?.text).toContain(
      "[Read lines 1-2 of 5; previousOffset=none; nextOffset=3; truncation=limit]",
    );
    expect(results[1]?.text).toContain(
      "[Read lines 3-4 of 5; previousOffset=1; nextOffset=5; truncation=limit]",
    );
    expect(results[2]?.text).toContain(
      "[Read lines 5-5 of 5; previousOffset=1; nextOffset=none; truncation=none]",
    );
    expect(results[2]?.text).toContain("five\n\n[Read lines");
    expect(results[3]?.text).toContain(
      "[Read lines 4-5 of 5; previousOffset=2; nextOffset=none; truncation=tail]",
    );
    expect(results[3]?.text).toContain("four\nfive\n\n[Read lines");
  });

  test("preserves one empty line for empty files", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "empty.txt"), "");
    const runtime = new CallScriptRuntime(cwd, config);
    const results = await Promise.all(
      [
        'return await read({ path: "empty.txt" });',
        'return await read({ path: "empty.txt", tail: 1 });',
      ].map((script) => Effect.runPromise(runtime.execute(script, invocation(cwd)))),
    );

    expect(results.map((result) => result.isError)).toEqual([false, false]);
    for (const result of results) {
      expect(result.text).toContain(
        "[Read lines 1-1 of 1; previousOffset=none; nextOffset=none; truncation=none]",
      );
    }
  });

  test("reports all semantic boundary issues before queue creation", async () => {
    const cwd = await workspace();
    const runtime = new CallScriptRuntime(cwd, config);
    const result = await Effect.runPromise(
      runtime.execute(
        'const changed = await write({ path: "should-not-exist.txt", content: "no" }); const mixed = await read({ path: "x", tail: 2, offset: 1 }); const remote = await http({ url: "relative", method: "GET", body: "bad" }); return { changed, mixed, remote };',
        invocation(cwd),
      ),
    );

    expect(result.isError).toBe(true);
    expect(result.details.calls).toBe(0);
    expect(result.text).toContain("CS005");
    expect(result.text).toContain("URL must be absolute");
    expect(result.text).toContain("GET must not include body");
    await expect(readFile(join(cwd, "should-not-exist.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("serializes overlapping writes and reports conditional selection", async () => {
    const cwd = await workspace();
    const runtime = new CallScriptRuntime(cwd, config);
    const writes = await Effect.runPromise(
      runtime.execute(
        'const changed = await Promise.all([write({ path: "same.txt", content: "first" }), write({ path: "same.txt", content: "second" })]); return changed.length;',
        invocation(cwd),
      ),
    );
    expect(writes.isError, writes.text).toBe(false);
    await expect(readFile(join(cwd, "same.txt"), "utf8")).resolves.toBe("second");

    const branch = await Effect.runPromise(
      runtime.execute(
        "const choice = await wait({ milliseconds: 0 }); if (choice.waitedMs === 0) { const selected = await wait({ milliseconds: 0 }); return selected; } else { const skipped = await wait({ milliseconds: 1 }); return skipped; }",
        invocation(cwd),
      ),
    );
    expect(branch.details.activity.some((event) => event.selection === "selected")).toBe(true);
    expect(
      branch.details.activity.some((event) => event.selection === "skipped"),
      JSON.stringify(branch.details.activity),
    ).toBe(true);
  });

  test("recovers through try/catch and restores typed job states", async () => {
    const cwd = await workspace();
    const runtime = new CallScriptRuntime(cwd, config);
    const recovered = await Effect.runPromise(
      runtime.execute(
        'try { const missing = await read({ path: "missing.txt" }); return missing; } catch (error) { return { recovered: error.message.includes("missing") }; }',
        invocation(cwd),
      ),
    );
    expect(recovered.isError, recovered.text).toBe(false);
    expect(JSON.parse(recovered.text)).toEqual({ recovered: true });

    await Effect.runPromise(
      runtime.restoreJobs([
        { id: "running", label: "wait · check", status: "running", repeatSafe: true },
        { id: "done", label: "read · file", status: "done", repeatSafe: true, output: "ok" },
        { id: "failed", label: "read · bad", status: "failed", repeatSafe: true, error: "bad" },
        { id: "cancelled", label: "wait · old", status: "cancelled", repeatSafe: true },
      ]),
    );
    expect(runtime.jobs().map((job) => job.status)).toEqual([
      "cancelled",
      "done",
      "failed",
      "unavailable",
    ]);
    const join = await Effect.runPromise(
      runtime.execute("const result = await running; return result;", invocation(cwd)),
    );
    expect(join.isError).toBe(true);
    expect(join.text).toContain("CS007");
  });

  test("rejects invalid scripts before dispatch", async () => {
    const cwd = await workspace();
    const runtime = new CallScriptRuntime(cwd, config);
    const result = await Effect.runPromise(
      runtime.execute("while (true) { await wait({ milliseconds: 1 }); }", invocation(cwd)),
    );

    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("invalid");
    expect(result.details.calls).toBe(0);
    expect(result.text).toMatch(/^CS00[1-4]:/);
  });
});
