<p align="center">
  <img src="./assets/pi-callscript.webp" alt="pi-callscript" width="200" />
</p>

# pi-callscript

[![Pi package](https://img.shields.io/badge/Pi-package-6f5cff?style=flat-square)](https://pi.dev/packages/pi-callscript)
[![npm](https://img.shields.io/npm/v/pi-callscript?style=flat-square)](https://www.npmjs.com/package/pi-callscript)
[![Bun](https://img.shields.io/badge/Bun-1.4-fbf0df?style=flat-square&logo=bun&logoColor=000)](https://bun.com/)
[![Effect](https://img.shields.io/badge/Effect-v4_RC-8a2be2?style=flat-square)](https://effect.website/)

`pi-callscript` adds one code-planning tool to Pi. It composes fixed capabilities and any registered Pi tool into structured execution flows. It supports parallel and dependent calls, reasoning checkpoints, background work, reversible edits, and a compact live trace. Other active Pi tools stay visible.

## Install

From npm:

```sh
pi install npm:pi-callscript
```

From GitHub:

```sh
pi install git:github.com/codewithkenzo/pi-callscript
```

For a local checkout:

```sh
pi install /path/to/pi-callscript
```

### Cold install

Install before starting Pi, then start a new Pi process. Confirm package discovery with:

```text
/callscript status
```

A status message containing `CallScript is on and additive` confirms that the `callscript` tool is active.

### Reload an active session

After installing or changing package/config files while Pi is running, use Pi's public reload command:

```text
/reload

/callscript status
```

`/reload` reloads configured extensions through Pi's public lifecycle. `/callscript reload` only rebuilds CallScript state and reapplies its current mode; it does not install packages or reload Pi's package set.

Pi owns cancellation. CallScript forwards an aborted turn to fixed and bridged work. Cancellation does not become a successful result.

Pi and Node.js 22.19 or newer are required.

## Use

CallScript starts enabled in additive mode. Ask Pi to use it, or manage it directly:

```text
/callscript status
/callscript jobs
/callscript help
/callscript doctor
/callscript on
/callscript off
/callscript reload
/callscript reset
```

`on` adds one `callscript` entry to the current active tool list. Repeated `on` commands do not create duplicates. `off` removes only `callscript`. Each transition uses the current active list, so tools added or removed by other owners keep their current state.

> CallScript is available beside other Pi tools. Use fixed capabilities directly. Discover registered Pi tools with `tools({ query })`, then invoke one with `pi({ tool, args })`.

The extension exposes one tool: `callscript`. It supports these fixed file and process calls:

`read` · `write` · `edit` · `search` · `find` · `list` · `run`

It also supports these control and network calls:

- `http` — fetch bounded response text.
- `wait` — delay asynchronously without blocking Pi.
- `think` — return control to the model for a full reasoning turn, then resume the same plan.
- `snapshot` — capture exact files before a change.
- `undo` — restore a captured snapshot.
- `tools({ query? })` — inspect fixed capabilities and registered Pi tools with exact argument schemas.
- `pi({ tool, args })` — invoke any registered Pi tool except recursive `callscript`.

```js
const matches = await tools({ query: "agent_browser" });
const page = await pi({
  tool: "agent_browser",
  args: { args: ["open", "https://example.com"] },
});
return { matches, page };
```

Bridged Pi calls serialize. They are non-repeat-safe because CallScript cannot infer side effects. Text-only tool results become strings. Mixed or image results become bounded text plus image metadata; raw image payloads and UI-only `details` do not enter script state.

### Pi host compatibility

Universal Pi-tool access works with npm/Node Pi. CallScript loads Pi's matching bundled or unbundled `AgentSession`, then probes required registry methods. CI tests lockfile Pi plus npm latest by behavior, not an exact version check.

Standalone compiled Pi cannot share an importable session class. CallScript keeps fixed capabilities available and reports `Pi bridge unavailable` through `/callscript status`, `/callscript doctor`, and `tools()`.

Bridged calls invoke tool-owned schema validation, cancellation, progress callbacks, execution code, and UI confirmation. CallScript also emits nested Pi `tool_call` and `tool_result` hooks, honors blocks and mutations, and fails closed when Pi policy runner is unavailable. Pi `tool_execution_*` observation hooks still see outer `callscript` execution only.

`read({ path, tail })` reads final bounded lines. Do not combine `tail` with `offset`. Every text read returns shown range, total lines, previous offset, next offset, and truncation reason. Relative paths resolve from current invocation `ctx.cwd`.

```js
const point = await snapshot({ paths: ["src/index.ts"] });
const [manifest, matches] = await Promise.all([
  read({ path: "package.json" }),
  search({ pattern: "TODO", path: "src", limit: 30 }),
]);
await think({ note: "choose the smallest useful edit" });
return { point, manifest, matches };
```

At `think`, downstream operations stay queued while the tool call returns to the model. The next CallScript invocation must make one explicit decision:

```js
{ decision: "continue" }                    // release all until next think
{ decision: "continue", count: 1 }          // release next queued call step, then pause again
{ decision: "stop" }                        // discard remaining queued calls
{ decision: "replace", script: "..." }     // reconcile a revised plan with completed work
{ decision: "replace", script: "...", fromScratch: true } // discard retained execution state
```

A pending checkpoint rejects a new initial `{ script }` submission. A partial continuation reports remaining queued step IDs and tool names. Selected steps run to settlement, including calls authored without `await`, so the next decision sees stable state. Partial continuation rejects `await.<runId>` join steps; continue all or replace that plan. `fromScratch` clears retained execution state; it does not reverse external side effects. Use `snapshot` and `undo({ snapshot: receipt.id })` when file rollback is required.

Supported source forms are top-level `const` declarations, direct `await`, static `Promise.all`, bounded `slice(...).map(...)` fan-out, dependencies, guards, `try/catch` recovery, and unchanged-script `think` resume. Unsupported forms are tagged templates, wrapper callbacks, computed callback bodies, regex literals, and per-call `.catch`. Validation returns stable `CS` codes plus one valid replacement.

Un-awaited work returns stable job ID and label. `/callscript jobs` reports `running`, `done`, `failed`, `cancelled`, or `unavailable`. Reloaded process-local work becomes `unavailable`. Unknown or expired joins return one typed recovery action. CallScript never retries mutating work unless operation is explicitly repeat-safe. `/callscript reset` cancels owned work and clears retained state.

Each operation stays visible in Pi's native tool view with its target, short result, elapsed time, timeout, and live state. Use Pi's normal `Ctrl+O` toggle for expanded details.

Under the hood, [CallScript](https://callscript.dev/) validates the workflow as a bounded inert plan instead of evaluating model-authored JavaScript. That is what makes aggressive composition predictable without adding another code sandbox.

## Optional agent skill

Install the included skill when you want Pi to combine larger tool waves deliberately: carry results between dependent calls, pause only for real model judgment, continue from session bindings, bound fan-out, keep background work observable, and roll risky changes back.

With npm:

```sh
npx pi-callscript
```

With Bun:

```sh
bunx pi-callscript
```

This copies `SKILL.md` to `~/.agents/skills/pi-callscript/`. It is separate from the extension and is not installed by `pi install`.

## Configuration

Global settings live at `~/.pi/agent/callscript.json`. Project settings in `.pi/callscript.json` override them.

```json
{
  "mode": "on",
  "limits": {
    "maxSteps": 30,
    "maxItemsPerStep": 100,
    "maxTotalCalls": 200,
    "maxConcurrency": 12,
    "maxCallResultBytes": 10485760
  },
  "httpTimeoutMs": 30000,
  "maxHttpResultBytes": 5242880
}
```

These are execution limits, not a separate permission layer. File and shell behavior stays Pi-native. `run` uses PowerShell on Windows and Bash on Linux and macOS. Bridged tools retain their own validation and confirmation behavior.

## Development

```sh
git clone https://github.com/codewithkenzo/pi-callscript.git
cd pi-callscript
bun install
bun run check
bun run smoke
```

`nix develop` opens the included Linux/macOS development shell. The project pins Bun 1.4.0; CI verifies Windows, macOS, and Linux with Node.js 22.19.

## Release proof

Run complete local release proof with:

```sh
bun run check
bun run smoke
bun run pack:check
bun run matrix
```

`matrix` runs isolated cold, source, dist, local-package, packed-package, user-extension, and reload cases. CI also checks locked and npm-latest Pi compatibility. Bundled smoke invokes one built-in and one extension tool through `pi({ tool, args })`. Unit and presentation tests cover bridge capture, validation, updates, cancellation, serialization, recursion, reload fallback, fixed calls, jobs, and UI behavior.

Recorded real-provider receipt (not rerun):

`pi --no-session -e ./src/index.ts -p 'Reply with exactly CALLSCRIPT_STREAM_OK.'` → `CALLSCRIPT_STREAM_OK`

Ticket 10 is retired. Node host profiling found no measured runtime bottleneck requiring optimization.
