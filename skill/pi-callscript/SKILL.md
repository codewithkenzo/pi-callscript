---
name: pi-callscript
description: Use Pi CallScript to compose fast, bounded coding-tool workflows with parallel evidence gathering, dependent edits, conditionals, explicit reasoning checkpoints, background jobs, HTTP requests, and reversible file changes. Use when a Pi task would otherwise need several tool round trips or benefits from a visible execution plan.
compatibility: Requires the pi-callscript Pi extension and its callscript tool.
---

# Pi CallScript

Use `callscript` to turn a small JavaScript-shaped workflow into one validated, inert plan. The source is parsed, not evaluated; only the mounted operations can cause effects.

## Shape the work

1. Give each script one evidence or change outcome.
2. Run independent calls together with `Promise.all`.
3. `await` dependent calls in order.
4. Put `think` between waves when later work depends on judgment. A paused result returns control for a full model reasoning turn; invoke `callscript` again with the unchanged script to resume from saved results.
5. Return only the values or short summary needed for the next reasoning pass.

Prefer two clear phases over one giant script. Keep file reads narrow with `offset` and `limit`, cap searches, and give potentially slow commands a timeout.

## Operations

Pi-native operations:

- `read({ path, offset?, limit? })`
- `write({ path, content })`
- `edit({ path, edits: [{ oldText, newText }] })`
- `search({ pattern, path?, glob?, ignoreCase?, literal?, context?, limit? })`
- `find({ pattern, path?, limit? })`
- `list({ path? })`
- `run({ command, timeout? })`

CallScript additions:

- `http({ url, method?, headers?, body?, timeoutMs? })` fetches bounded response text.
- `wait({ milliseconds })` delays asynchronously.
- `think({ note? })` ends the current tool call for a model reasoning turn; its note labels the focus, and the unchanged script resumes the plan.
- `snapshot({ paths })` captures exact files before a risky change.
- `undo({ snapshot })` restores everything captured by that snapshot.

## High-leverage patterns

Gather independent evidence in one wave:

```js
const [manifest, matches, files] = await Promise.all([
  read({ path: "package.json" }),
  search({ pattern: "TODO", path: "src", limit: 30 }),
  find({ pattern: "*.test.ts", path: "tests", limit: 50 }),
]);
return { manifest, matches, files };
```

Pause before an evidence-dependent change:

```js
const [source, tests] = await Promise.all([
  read({ path: "src/index.ts" }),
  read({ path: "tests/index.test.ts" }),
]);
await think({ note: "choose the smallest edit supported by source and tests" });
const changed = await edit({
  path: "src/index.ts",
  edits: [{ oldText: "old exact text", newText: "new exact text" }],
});
return { changed };
```

Make a reversible edit:

```js
const point = await snapshot({ paths: ["src/index.ts", "package.json"] });
const changed = await edit({
  path: "src/index.ts",
  edits: [{ oldText: "old exact text", newText: "new exact text" }],
});
return { snapshot: point.id, changed };
```

If validation fails, correct the exact reported construct and retry. CallScript bindings are single-assignment, fan-out must be visibly bounded, and arbitrary imports, globals, loops, or evaluation are not supported.

Use an un-awaited call only for genuinely independent background work:

```js
const checks = run({ command: "bun test", timeout: 120 });
return { started: "checks" };
```

Join it in a later script with `const result = await checks;`. Do not leave background work unobserved.
