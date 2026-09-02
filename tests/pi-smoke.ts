import { spawn } from "node:child_process";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import { CallScriptRuntime } from "../src/runtime.js";
import type { ExtensionConfig, InvocationInput } from "../src/types.js";

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

const context = (): ExtensionContext => {
  const empty = Object.create(null);
  return {
    ui: empty,
    mode: "rpc",
    hasUI: false,
    cwd: process.cwd(),
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

const invocation: InvocationInput = {
  id: "smoke-read",
  signal: undefined,
  ctx: context(),
  update: undefined,
};

const verifyFixedRead = async () => {
  const runtime = new CallScriptRuntime(process.cwd(), config);
  const result = await Effect.runPromise(
    runtime.execute(
      'const manifest = await read({ path: "package.json", offset: 0, limit: 5 }); return { manifest };',
      invocation,
    ),
  );
  if (result.isError || !result.text.includes("pi-callscript")) {
    throw new Error(`Fixed CallScript read failed: ${result.text}`);
  }
};

const launch = (extension: string) =>
  new Promise<{ output: string; exitCode: number | null }>((resolve, reject) => {
    const child = spawn(
      "node",
      [
        "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        "--mode",
        "rpc",
        "--no-session",
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
        "-e",
        extension,
        "-e",
        "./tests/fixtures/fabric-extension.ts",
        "-e",
        "./tests/fixtures/representative-extension.ts",
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ output, exitCode }));
    child.stdin.end(`{"type":"get_commands"}\n{"type":"prompt","message":"/smoke-probe"}\n`);
  });

await verifyFixedRead();
for (const extension of ["./src/index.ts", "./dist/index.mjs"]) {
  const { output, exitCode } = await launch(extension);
  if (exitCode !== 0) throw new Error(`Pi RPC exited with ${exitCode} for ${extension}`);
  if (!output.includes('"name":"callscript"')) {
    throw new Error(`CallScript command was not registered from ${extension}`);
  }
  if (!output.includes("SMOKE_EXTENSION_CALLED")) {
    throw new Error(`Representative extension command did not execute with ${extension}`);
  }
  const activeMarker = output.match(/SMOKE_ACTIVE_TOOLS:([^"\n]+)/u)?.[1] ?? "";
  for (const tool of ["read", "callscript", "fabric_exec", "smoke_extension"]) {
    if (!activeMarker.split(",").includes(tool)) {
      throw new Error(`Active tools omit ${tool} with ${extension}: ${activeMarker}`);
    }
  }
}

process.stdout.write("Pi additive exposure, fixed read, Fabric, and extension coexistence ok\n");
