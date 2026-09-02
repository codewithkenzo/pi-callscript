import { execFile, spawn } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, relative as relativePath, resolve } from "node:path";

interface ProbeEvent {
  event: string;
  aborted?: boolean;
  delta?: string;
  reason?: string;
  stopReason?: string;
  tools?: string[];
}
interface RpcRecord {
  id?: string;
  type?: string;
  command?: string;
  message?: unknown;
}
interface Result {
  name: string;
  kind: "cold" | "reload";
  passed: boolean;
  exitCode: number | null;
  stderr: string;
  sequence: string[];
  providerStarted: boolean;
  beforeProviderStartAborted?: boolean | undefined;
  deltaCount: number;
  deltaAbortStates: boolean[];
  completionAborted?: boolean | undefined;
  finalStopReason?: string | undefined;
  loadCount: number;
  sessionStartCount: number;
  toolsBeforeReload?: string[] | undefined;
  toolsAfterReload?: string[] | undefined;
  toolsBeforePrompt?: string[] | undefined;
}

const run = promisify(execFile);
const operationTimeoutMs = 30_000;
const teardownTimeoutMs = 5_000;
const root = resolve(import.meta.dirname, "..");
const provider = join(root, "tests/fixtures/matrix-provider.ts");
const reloadDriver = join(root, "tests/fixtures/matrix-reload.ts");
const inert = join(root, "tests/fixtures/matrix-inert.ts");
const source = join(root, "src/index.ts");
const dist = join(root, "dist/index.mjs");

async function makeAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-callscript-matrix-"));
  await Promise.all([
    mkdir(join(dir, "home"), { recursive: true }),
    mkdir(join(dir, "cache"), { recursive: true }),
  ]);
  await writeFile(join(dir, "npmrc"), "audit=false\nfund=false\nupdate-notifier=false\n");
  return dir;
}

function safeEnv(agentDir: string): NodeJS.ProcessEnv {
  return {
    HOME: join(agentDir, "home"),
    PATH: `${join(root, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
    XDG_CACHE_HOME: join(agentDir, "cache"),
    XDG_CONFIG_HOME: join(agentDir, "config"),
    npm_config_cache: join(agentDir, "cache/npm"),
    npm_config_userconfig: join(agentDir, "npmrc"),
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
}

async function removeAgentDir(agentDir: string): Promise<void> {
  try {
    await run("chmod", ["-R", "u+w", agentDir], {
      env: safeEnv(agentDir),
      timeout: teardownTimeoutMs,
    });
  } catch {
    // Cleanup continues so rm can report authoritative result.
  }
  await rm(agentDir, { recursive: true, force: true });
}

async function install(agentDir: string, target: string): Promise<void> {
  await run("pi", ["install", target], {
    cwd: root,
    env: safeEnv(agentDir),
    timeout: operationTimeoutMs,
  });
}

async function installPacked(agentDir: string, tarball: string): Promise<void> {
  const npmRoot = join(agentDir, "npm");
  await mkdir(npmRoot, { recursive: true });
  await run("npm", ["install", "--ignore-scripts", "--no-save", tarball], {
    cwd: npmRoot,
    env: safeEnv(agentDir),
    timeout: operationTimeoutMs,
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: ["npm:pi-callscript@0.1.3"] }),
  );
}

async function assertSafeCopySources(sources: string[]): Promise<void> {
  const roots = [...new Set(await Promise.all(sources.map((source) => realpath(source))))];
  const visited = new Set<string>();
  const isWithinRoot = (root: string, candidate: string): boolean => {
    const relative = relativePath(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !relative.startsWith("/"));
  };
  const scan = async (directory: string): Promise<void> => {
    const canonicalDirectory = await realpath(directory);
    if (visited.has(canonicalDirectory)) return;
    visited.add(canonicalDirectory);
    for (const entry of await readdir(canonicalDirectory, { withFileTypes: true })) {
      const path = join(canonicalDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(path);
        } catch (error) {
          throw new Error(`Unsafe dangling symlink: ${path}`, { cause: error });
        }
        if (!roots.some((root) => isWithinRoot(root, target)))
          throw new Error(`Unsafe escaping symlink: ${path} -> ${target}`);
        if ((await lstat(target)).isDirectory()) await scan(target);
      } else if (entry.isDirectory()) {
        await scan(path);
      }
    }
  };
  for (const source of sources) {
    if ((await lstat(source)).isSymbolicLink())
      throw new Error(`Unsafe symlink copy source: ${source}`);
  }
  await Promise.all(sources.map(scan));
}

async function copyUserExtensions(agentDir: string): Promise<void> {
  const real = join(process.env.HOME ?? "", ".pi/agent");
  const settings: { packages?: string[] } = JSON.parse(
    await readFile(join(real, "settings.json"), "utf8"),
  );
  const localPackages = (settings.packages ?? [])
    .filter((packageSource) => packageSource.startsWith(".") || packageSource.startsWith("/"))
    .map((packageSource) => resolve(real, packageSource));
  const copySources = [
    ...localPackages,
    ...["npm", "git", "extensions"].map((name) => join(real, name)),
  ];
  await assertSafeCopySources(copySources);
  const copiedPackages: string[] = [];
  for (const [index, packageSource] of (settings.packages ?? []).entries()) {
    if (!packageSource.startsWith(".") && !packageSource.startsWith("/")) {
      copiedPackages.push(packageSource);
      continue;
    }
    const destination = join(agentDir, "local-resources", String(index));
    await mkdir(destination, { recursive: true });
    await run(
      "cp",
      ["--archive", "--dereference", "--reflink=auto", resolve(real, packageSource), destination],
      {
        env: safeEnv(agentDir),
        timeout: operationTimeoutMs,
      },
    );
    copiedPackages.push(join(destination, packageSource.split("/").at(-1) ?? "package"));
  }
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: copiedPackages }));
  for (const name of ["npm", "git", "extensions"]) {
    await run(
      "cp",
      ["--archive", "--dereference", "--reflink=auto", join(real, name), join(agentDir, name)],
      {
        env: safeEnv(agentDir),
        timeout: operationTimeoutMs,
      },
    );
  }
  await run(
    "chmod",
    [
      "-R",
      "a-w",
      ...["npm", "git", "extensions", "local-resources"].map((name) => join(agentDir, name)),
    ],
    { env: safeEnv(agentDir), timeout: operationTimeoutMs },
  );
}

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolveBounded, rejectBounded) => {
    const timer = setTimeout(
      () => rejectBounded(new Error(`${label} timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveBounded(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectBounded(error);
      },
    );
  });
}

function launch(agentDir: string, logPath: string, extensions: string[], discover = false) {
  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--offline",
    "--provider",
    "matrix",
    "--model",
    "matrix-1",
    "-e",
    provider,
  ];
  if (!discover) args.push("--no-extensions");
  for (const extension of extensions) args.push("-e", extension);
  const child = spawn("pi", args, {
    cwd: root,
    env: { ...safeEnv(agentDir), CALLSCRIPT_MATRIX_LOG: logPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  let exitCode: number | null | undefined;
  let parserError: Error | undefined;
  const records: RpcRecord[] = [];
  let pending = "";
  const waiters = new Set<() => void>();
  const wakeAll = () => {
    for (const wake of waiters) wake();
  };
  const exit = new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => {
      exitCode = code;
      wakeAll();
      resolveExit(code);
    });
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    try {
      for (const line of lines) {
        if (!line.trim()) continue;
        // SAFETY: Pi RPC stdout emits RpcRecord JSON lines.
        records.push(JSON.parse(line) as RpcRecord);
      }
    } catch (error) {
      parserError = error instanceof Error ? error : new Error(String(error));
    }
    wakeAll();
  });
  const waitFor = async (label: string, predicate: () => boolean): Promise<void> => {
    await bounded(
      new Promise<void>((resolveWait, rejectWait) => {
        const check = () => {
          if (predicate()) {
            waiters.delete(check);
            resolveWait();
          } else if (parserError) {
            waiters.delete(check);
            rejectWait(parserError);
          } else if (exitCode !== undefined) {
            waiters.delete(check);
            rejectWait(new Error(`Pi exited before ${label}: ${exitCode}`));
          }
        };
        waiters.add(check);
        check();
      }),
      label,
      operationTimeoutMs,
    );
  };
  const send = (record: RpcRecord): void => {
    if (exitCode !== undefined || child.stdin.destroyed)
      throw new Error("Cannot write to stopped Pi RPC child");
    child.stdin.write(`${JSON.stringify(record)}\n`);
  };
  const close = async (): Promise<number | null> => {
    if (exitCode !== undefined) return exitCode;
    child.stdin.end();
    return bounded(exit, "Pi graceful exit", operationTimeoutMs);
  };
  const terminate = async (): Promise<void> => {
    if (exitCode !== undefined) return;
    child.stdin.destroy();
    child.kill("SIGTERM");
    try {
      await bounded(exit, "Pi SIGTERM exit", teardownTimeoutMs);
    } catch {
      child.kill("SIGKILL");
      await bounded(exit, "Pi SIGKILL exit", teardownTimeoutMs);
    }
  };
  return { records, send, waitFor, close, terminate, stderr: () => stderr };
}

async function readProbe(logPath: string): Promise<ProbeEvent[]> {
  const text = await readFile(logPath, "utf8").catch(() => "");
  // SAFETY: matrix fixture is sole writer and emits ProbeEvent JSON lines.
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProbeEvent);
}

interface CaseExpectation {
  kind: "cold" | "reload";
  loadCount: number;
  sessionStartCount: number;
  beforePrompt: { include: string[]; exclude: string[] };
  beforeReload?: { include: string[]; exclude: string[] };
  afterReload?: { include: string[]; exclude: string[] };
}

const caseExpectations = {
  "cold-control": {
    kind: "cold",
    loadCount: 1,
    sessionStartCount: 1,
    beforePrompt: { include: [], exclude: ["callscript", "matrix_inert"] },
  },
  "cold-source": {
    kind: "cold",
    loadCount: 1,
    sessionStartCount: 1,
    beforePrompt: { include: ["callscript"], exclude: ["matrix_inert"] },
  },
  "cold-dist": {
    kind: "cold",
    loadCount: 1,
    sessionStartCount: 1,
    beforePrompt: { include: ["callscript"], exclude: ["matrix_inert"] },
  },
  "cold-user-plus-source": {
    kind: "cold",
    loadCount: 1,
    sessionStartCount: 1,
    beforePrompt: { include: ["fabric_exec"], exclude: ["callscript", "matrix_inert"] },
  },
  "cold-local-package": {
    kind: "cold",
    loadCount: 1,
    sessionStartCount: 1,
    beforePrompt: { include: ["callscript"], exclude: ["matrix_inert"] },
  },
  "cold-packed-package": {
    kind: "cold",
    loadCount: 1,
    sessionStartCount: 1,
    beforePrompt: { include: ["callscript"], exclude: ["matrix_inert"] },
  },
  "reload-local-package": {
    kind: "reload",
    loadCount: 2,
    sessionStartCount: 2,
    beforePrompt: { include: ["callscript"], exclude: ["matrix_inert"] },
    beforeReload: { include: [], exclude: ["callscript", "matrix_inert"] },
    afterReload: { include: ["callscript"], exclude: ["matrix_inert"] },
  },
  "reload-packed-package": {
    kind: "reload",
    loadCount: 2,
    sessionStartCount: 2,
    beforePrompt: { include: ["callscript"], exclude: ["matrix_inert"] },
    beforeReload: { include: [], exclude: ["callscript", "matrix_inert"] },
    afterReload: { include: ["callscript"], exclude: ["matrix_inert"] },
  },
  "reload-inert-control": {
    kind: "reload",
    loadCount: 2,
    sessionStartCount: 2,
    beforePrompt: { include: ["matrix_inert"], exclude: ["callscript"] },
    beforeReload: { include: [], exclude: ["callscript", "matrix_inert"] },
    afterReload: { include: ["matrix_inert"], exclude: ["callscript"] },
  },
} satisfies Record<string, CaseExpectation>;

function toolsMatch(
  actual: string[] | undefined,
  expected: { include: string[]; exclude: string[] },
): boolean {
  return (
    actual !== undefined &&
    expected.include.every((tool) => actual.includes(tool)) &&
    expected.exclude.every((tool) => !actual.includes(tool))
  );
}

function summarize(
  name: string,
  kind: "cold" | "reload",
  exitCode: number | null,
  stderr: string,
  rpc: RpcRecord[],
  probe: ProbeEvent[],
): Result {
  const lifecycle = new Set(["agent_start", "turn_end", "agent_end", "agent_settled"]);
  const sequence = probe
    .filter((item) => lifecycle.has(item.event) || item.event === "text_delta")
    .map((item) => item.event);
  const beforeProviderStart = probe.find((item) => item.event === "before_provider_start");
  const deltas = probe.filter((item) => item.event === "text_delta");
  const done = probe.findLast((item) => item.event === "provider_done");
  const beforeReload = probe.find((item) => item.event === "before_reload");
  const sessions = probe.filter((item) => item.event === "session_start");
  const afterReload =
    kind === "reload" ? sessions.findLast((item) => item.reason === "reload") : undefined;
  const beforePrompt = probe.findLast((item) => item.event === "before_prompt");
  const result: Result = {
    name,
    kind,
    passed: false,
    exitCode,
    stderr: stderr.trim(),
    sequence,
    providerStarted: beforeProviderStart !== undefined,
    beforeProviderStartAborted: beforeProviderStart?.aborted,
    deltaCount: deltas.length,
    deltaAbortStates: deltas.map((item) => item.aborted ?? true),
    completionAborted: done?.aborted,
    finalStopReason: done?.stopReason,
    loadCount: probe.filter((item) => item.event === "extension_load").length,
    sessionStartCount: sessions.length,
    toolsBeforeReload: beforeReload?.tools,
    toolsAfterReload: afterReload?.tools,
    toolsBeforePrompt: beforePrompt?.tools,
  };
  const ordered = ["agent_start", "text_delta", "turn_end", "agent_end", "agent_settled"];
  let cursor = -1;
  const orderPass = ordered.every((event) => {
    cursor = sequence.indexOf(event, cursor + 1);
    return cursor >= 0;
  });
  const rpcAbort = rpc.some(
    (item) =>
      item.type === "message_end" && JSON.stringify(item).includes('"stopReason":"aborted"'),
  );
  // SAFETY: matrix case names are declared in caseExpectations below.
  const expectedEntry = caseExpectations[name as keyof typeof caseExpectations];
  if (!expectedEntry || expectedEntry.kind !== kind)
    throw new Error(`Missing ${kind} expectation for ${name}`);
  const expected: CaseExpectation = expectedEntry;
  const toolPass =
    toolsMatch(result.toolsBeforePrompt, expected.beforePrompt) &&
    (kind === "cold" ||
      (expected.beforeReload !== undefined &&
        expected.afterReload !== undefined &&
        toolsMatch(result.toolsBeforeReload, expected.beforeReload) &&
        toolsMatch(result.toolsAfterReload, expected.afterReload)));
  result.passed =
    exitCode === 0 &&
    result.providerStarted &&
    result.beforeProviderStartAborted === false &&
    result.deltaCount >= 2 &&
    result.deltaAbortStates.every((aborted) => !aborted) &&
    result.completionAborted === false &&
    result.finalStopReason === "stop" &&
    orderPass &&
    !rpcAbort &&
    result.loadCount === expected.loadCount &&
    result.sessionStartCount === expected.sessionStartCount &&
    toolPass;
  return result;
}

async function cold(
  name: string,
  setup: (dir: string) => Promise<{ extensions?: string[]; discover?: boolean }>,
): Promise<Result> {
  const dir = await makeAgentDir();
  const log = join(dir, "matrix.jsonl");
  let rpc: ReturnType<typeof launch> | undefined;
  try {
    const config = await setup(dir);
    rpc = launch(dir, log, config.extensions ?? [], config.discover);
    rpc.send({ id: "ready", type: "get_state" });
    await rpc.waitFor(
      `${name} readiness`,
      () => rpc?.records.some((item) => item.id === "ready") ?? false,
    );
    rpc.send({ id: "prompt", type: "prompt", message: "matrix response" });
    await rpc.waitFor(
      `${name} settlement`,
      () => rpc?.records.some((item) => item.type === "agent_settled") ?? false,
    );
    const exitCode = await rpc.close();
    return summarize(name, "cold", exitCode, rpc.stderr(), rpc.records, await readProbe(log));
  } finally {
    await rpc?.terminate();
    await removeAgentDir(dir);
  }
}

async function reload(name: string, setup: (dir: string) => Promise<void>): Promise<Result> {
  const dir = await makeAgentDir();
  const log = join(dir, "matrix.jsonl");
  let rpc: ReturnType<typeof launch> | undefined;
  try {
    rpc = launch(dir, log, [reloadDriver], true);
    rpc.send({ id: "ready", type: "get_state" });
    await rpc.waitFor(
      `${name} readiness`,
      () => rpc?.records.some((item) => item.id === "ready") ?? false,
    );
    await setup(dir);
    rpc.send({ id: "reload", type: "prompt", message: "/matrix-reload" });
    await rpc.waitFor(
      `${name} reload`,
      () => rpc?.records.some((item) => item.id === "reload") ?? false,
    );
    rpc.send({ id: "prompt", type: "prompt", message: "matrix response" });
    await rpc.waitFor(
      `${name} settlement`,
      () => rpc?.records.some((item) => item.type === "agent_settled") ?? false,
    );
    const exitCode = await rpc.close();
    return summarize(name, "reload", exitCode, rpc.stderr(), rpc.records, await readProbe(log));
  } finally {
    await rpc?.terminate();
    await removeAgentDir(dir);
  }
}

const packDir = await makeAgentDir();
let tarball = "";
try {
  await run(join(root, "node_modules/.bin/tsdown"), [], {
    cwd: root,
    env: safeEnv(packDir),
    timeout: operationTimeoutMs,
  });
  const packed = await run("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir], {
    cwd: root,
    env: safeEnv(packDir),
    timeout: operationTimeoutMs,
  });
  tarball = join(packDir, packed.stdout.trim().split("\n").at(-1) ?? "");
  const results: Result[] = [];
  results.push(await cold("cold-control", async () => ({})));
  results.push(await cold("cold-source", async () => ({ extensions: [source] })));
  results.push(await cold("cold-dist", async () => ({ extensions: [dist] })));
  results.push(
    await cold("cold-user-plus-source", async (dir) => {
      await copyUserExtensions(dir);
      return { extensions: [source], discover: true };
    }),
  );
  results.push(
    await cold("cold-local-package", async (dir) => {
      await install(dir, root);
      return { discover: true };
    }),
  );
  results.push(
    await cold("cold-packed-package", async (dir) => {
      await installPacked(dir, tarball);
      return { discover: true };
    }),
  );
  results.push(await reload("reload-local-package", async (dir) => install(dir, root)));
  results.push(await reload("reload-packed-package", async (dir) => installPacked(dir, tarball)));
  results.push(await reload("reload-inert-control", async (dir) => install(dir, inert)));
  process.stdout.write(`${JSON.stringify({ piVersion: "0.84.4", results }, null, 2)}\n`);
  const failed = results.find((result) => !result.passed);
  if (failed) throw new Error(`First failing boundary: ${failed.name}`);
} finally {
  await removeAgentDir(packDir);
}
