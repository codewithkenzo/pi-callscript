import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter, once } from "node:events";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vitest";

import { CallScriptRuntime } from "../src/runtime.js";
import {
  EXTENSION_TOOLS,
  type ExtensionConfig,
  type InvocationInput,
  type RunDetails,
} from "../src/types.js";

const directories: string[] = [];

const isAddressInfo = (value: string | AddressInfo | null): value is AddressInfo =>
  typeof value === "object" && value !== null;

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
  });

  test("detaches an un-awaited job and joins it from a later script", async () => {
    const cwd = await workspace();
    const runtime = new CallScriptRuntime(cwd, config);
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

  test("rejects invalid scripts before dispatch", async () => {
    const cwd = await workspace();
    const runtime = new CallScriptRuntime(cwd, config);
    const result = await Effect.runPromise(
      runtime.execute("while (true) { await wait({ milliseconds: 1 }); }", invocation(cwd)),
    );

    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("invalid");
    expect(result.details.calls).toBe(0);
  });
});
