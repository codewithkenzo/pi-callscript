---
name: pi-callscript
description: Use Pi CallScript to compose multiple coding-tool actions into deliberate workflows with parallel evidence gathering, dependent chains, deterministic guards, full model reasoning checkpoints, resumable background jobs, bounded fan-out, compact outputs, and reversible edits. Use when a task would otherwise spend several model round trips moving intermediate tool results around, or when one visible plan can do the mechanical work while preserving judgment at explicit boundaries.
---

# Pi CallScript

Requires the `pi-callscript` Pi extension and its `callscript` tool.

> CallScript is available beside other Pi tools. Use it for bounded programs over its listed fixed capabilities. Use the owning Pi tool directly for Fabric, FFF, MCP, subagent, and other extension operations.

`on` adds one `callscript` entry to current active tools. `off` removes only `callscript`. Both transitions preserve current state owned by other extensions.

## What it solves

Ordinary tool use alternates between the model and one tool result at a time. That is useful when every next action is uncertain, but slow and context-heavy when several calls are already predictable.

Use `callscript` to keep mechanical work inside one dataflow: gather independent evidence together, pass results into dependent calls, branch on deterministic conditions, and return only the useful projection. Yield to the model only where interpretation or a new decision is genuinely required.

Do not maximize the number of calls in one script. Maximize useful work per reasoning turn.

## Choose the right shape

| Situation                                              | Shape                                        |
| ------------------------------------------------------ | -------------------------------------------- |
| One small known action                                 | One short awaited call                       |
| Several independent actions                            | `Promise.all`                                |
| A later call mechanically depends on an earlier result | Sequential `await`                           |
| Evidence must be interpreted before acting             | `think` between two waves                    |
| A finite list needs the same operation                 | Bounded `slice(0, N).map(...)` fan-out       |
| Slow work is independent of the current turn           | Start un-awaited, join by binding later      |
| A file change may need reversal                        | `snapshot` before mutation; `undo` if needed |

## Build deliberate workflows

1. State one concrete outcome for the script.
2. Gather the widest independent evidence wave first.
3. Use pure expressions and guard returns for mechanical decisions.
4. Insert `think` immediately before the first step that needs model judgment.
5. Continue with dependent changes and validation.
6. Return counts, decisions, paths, or short results—not every raw intermediate value.

Prefer two clear phases over one giant script. Use stable, descriptive binding names because retained bindings remain available to later scripts in the same Pi session.

## Operations

Pi-native operations:

- `read({ path, offset?, limit? })` or `read({ path, tail })`; never combine `tail` and `offset`
- `write({ path, content })`
- `edit({ path, edits: [{ oldText, newText }] })`
- `search({ pattern, path?, glob?, ignoreCase?, literal?, context?, limit? })`
- `find({ pattern, path?, limit? })`
- `list({ path? })`
- `run({ command, timeout? })`

CallScript additions:

- `http({ url, method?, headers?, body?, timeoutMs? })` fetches bounded response text.
- `wait({ milliseconds })` delays asynchronously.
- `think({ note? })` returns control for a full model reasoning turn.
- `snapshot({ paths })` captures exact file contents and remembers missing files.
- `undo({ snapshot })` restores a session-local snapshot.
- `tools({ query? })` inspects fixed CallScript capability names only.

Keep reads narrow with `offset` and `limit`, cap searches, and give commands a realistic timeout in seconds.

Each text read reports shown range, total lines, previous offset, next offset, and truncation reason. Relative paths resolve from current invocation `ctx.cwd`.

## Compose calls, do not serialize them by habit

Run three independent reads together, reason once, then continue into dependent work:

```js
const [source, tests, manifest] = await Promise.all([
  read({ path: "src/index.ts" }),
  read({ path: "tests/index.test.ts" }),
  read({ path: "package.json" }),
]);
await think({ note: "choose the smallest change supported by the source, tests, and manifest" });
const point = await snapshot({ paths: ["src/index.ts"] });
const changed = await edit({
  path: "src/index.ts",
  edits: [{ oldText: "old exact text", newText: "new exact text" }],
});
const checks = await run({ command: "bun test", timeout: 120 });
return { snapshot: point.id, changed, checks };
```

At the checkpoint, downstream calls remain queued. Reason from the completed wave, then invoke `callscript` again with the exact unchanged script. Settled calls are reused and execution resumes after `think`.

The `note` is only the checkpoint label. The `think` call itself creates the reasoning turn. Use it sparingly: deterministic dataflow does not need a model pause.

## Carry results through deterministic chains

Use a guard when the next action follows directly from the result:

```js
const source = await read({ path: "src/config.ts" });
if (!source.includes("legacyMode")) return { changed: false, reason: "already clean" };
const changed = await edit({
  path: "src/config.ts",
  edits: [{ oldText: "legacyMode", newText: "mode" }],
});
return { changed: true, result: changed };
```

This is cheaper and clearer than pausing for the model to rediscover an obvious branch.

## Bound repeated work visibly

Fan out only over a finite visible bound:

```js
const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
const sources = await Promise.all(paths.slice(0, 3).map((path) => read({ path })));
return { files: paths, count: sources.length };
```

Use `const` bindings only. Do not use imports, globals, reassignment, unbounded loops, or arbitrary evaluation. When validation rejects a construct, replace only that construct with the suggested CallScript form.

Supported forms: top-level `const`, direct `await`, static `Promise.all`, bounded fan-out, dependencies, guards, `try/catch`, and unchanged-script `think` resume. Unsupported forms: tagged templates, wrapper callbacks, computed callback bodies, regex literals, and per-call `.catch`. Stable `CS` validation codes include one valid replacement.

## Publish once, continue later

Bindings retained by a run's returned projection survive in the current CallScript session. Use this to split a large job at a natural reasoning boundary without repeating the first phase.

First script:

```js
const evidence = await search({ pattern: "legacyMode", path: "src", limit: 40 });
return { gathered: true, evidence };
```

Later script:

```js
if (!evidence.includes("legacyMode")) return { changed: false };
const source = await read({ path: "src/config.ts" });
return { evidence, source };
```

Use `/callscript reset` when those published bindings should no longer influence later work.

## Start and join background work

Detach only work that is independent of the current reasoning turn:

```js
const checks = run({ command: "bun test", timeout: 180 });
return { started: "checks" };
```

Join it from a later script:

```js
const result = await checks;
return { checks: result };
```

Never leave a background binding unobserved. Join it, inspect its final state, or reset the session.

Use `/callscript jobs` to inspect stable ID, human label, `running`, `done`, `failed`, `cancelled`, or `unavailable` state. Process-local running work restores as `unavailable`. Unknown or expired joins return one typed recovery action. Never retry mutating work unless it is explicitly repeat-safe. `/callscript reset` cancels owned jobs and clears retained state.

## Make risky work recoverable

Snapshot the exact mutation set before editing. If a later validation step fails, use the published snapshot id in a follow-up script:

```js
const restored = await undo({ snapshot: point.id });
return { restored };
```

Snapshots are session-local. Capture every file the workflow may change, including files that do not exist yet.

## Protect context and prompt-cache efficiency

- Use `callscript` for bounded programs over its fixed capabilities. Use other Pi tools through their owning extension.
- Put independent calls in one wave so their results enter one reasoning turn.
- Reuse named session bindings rather than re-reading unchanged evidence.
- Resume a `think` checkpoint with the exact script so settled work is reused.
- Narrow file reads and searches before they produce large results.
- Return compact projections. Do not echo large source files or command logs once downstream steps have consumed them.
- Split at genuine decision boundaries. Long scripts with many speculative branches are harder to reuse than two focused phases.

The goal is not fewer visible operations. It is fewer model round trips, less repeated context, and a clearer boundary between mechanical execution and model judgment.
