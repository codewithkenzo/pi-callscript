import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import { CALLSCRIPT_MODE_PROMPT, CALLSCRIPT_TOOL_DESCRIPTION, isRunDetails } from "../src/index.js";
import { CallScriptRuntime } from "../src/runtime.js";
import type { Activity, ExtensionConfig, InvocationInput, RunDetails } from "../src/types.js";
import { renderScriptResult } from "../src/ui.js";

const config: ExtensionConfig = {
  mode: "on",
  limits: {
    maxSteps: 30,
    maxItemsPerStep: 250,
    maxTotalCalls: 250,
    maxConcurrency: 64,
    maxCallResultBytes: 10_485_760,
  },
  httpTimeoutMs: 30_000,
  maxHttpResultBytes: 5_242_880,
};

const context = (): ExtensionContext => {
  const empty = Object.create(null);
  return {
    ui: empty,
    mode: "json",
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

const invocation = (): InvocationInput => ({
  id: "benchmark",
  signal: undefined,
  ctx: context(),
  update: undefined,
});

const percentile = (samples: number[], quantile: number) => {
  const sorted = samples.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
};

const measure = (iterations: number, operation: () => void) => {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    operation();
    samples.push(performance.now() - startedAt);
  }
  return percentile(samples, 0.95);
};

const runtime = new CallScriptRuntime(process.cwd(), config);
const validationScript = `${Array.from(
  { length: 20 },
  (_value, index) => `const value${index} = await wait({ milliseconds: ${index} });`,
).join("\n")}\nreturn value19;`;

for (let index = 0; index < 5; index += 1) runtime.engine.validate(validationScript);
const parseValidateP95Ms = measure(30, () => runtime.engine.validate(validationScript));

const parallelStartedAt = performance.now();
await Effect.runPromise(
  runtime.execute(
    "return await Promise.all([100, 101, 102].map(milliseconds => wait({ milliseconds })));",
    invocation(),
  ),
);
const parallelThreeTimersMs = performance.now() - parallelStartedAt;

const fanout = Array.from({ length: 200 }, (_value, index) => index).join(",");
const fanoutStartedAt = performance.now();
const fanoutResult = await Effect.runPromise(
  runtime.execute(
    `return await Promise.all([${fanout}].map(milliseconds => wait({ milliseconds })));`,
    invocation(),
  ),
);
const fanoutTwoHundredMs = performance.now() - fanoutStartedAt;

const zeroFanout = Array.from({ length: 200 }, () => 0).join(",");
const zeroFanoutStartedAt = performance.now();
const zeroFanoutResult = await Effect.runPromise(
  runtime.execute(
    `return await Promise.all([${zeroFanout}].map(milliseconds => wait({ milliseconds })));`,
    invocation(),
  ),
);
const zeroFanoutTwoHundredMs = performance.now() - zeroFanoutStartedAt;

const activity: Activity[] = Array.from({ length: 200 }, (_value, index) => [
  {
    sequence: index * 2 + 1,
    atMs: index,
    step: `step-${index}`,
    tool: "read",
    phase: "start" as const,
  },
  {
    sequence: index * 2 + 2,
    atMs: index + 1,
    step: `step-${index}`,
    tool: "read",
    phase: "done" as const,
    elapsedMs: 1,
  },
]).flat();
const details: RunDetails = {
  version: 1,
  mode: "on",
  status: "ok",
  elapsedMs: 200,
  calls: 200,
  completed: 200,
  active: 0,
  activity,
};
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const largeOutput = `${"0123456789abcdef".repeat(65_536)}\nfinal`;
const renderP95Ms = measure(100, () => {
  renderScriptResult(largeOutput, details, false, false, false, theme).render(120);
});
const detailsGuardP95Ms = measure(1_000, () => {
  isRunDetails(details);
});
const structuredOutput = JSON.stringify({
  rows: Array.from({ length: 40_000 }, (_value, index) => ({ index, ready: true })),
});
const structuredRenderP95Ms = measure(100, () => {
  renderScriptResult(structuredOutput, details, false, false, false, theme).render(120);
});
const staticPromptChars = CALLSCRIPT_TOOL_DESCRIPTION.length + CALLSCRIPT_MODE_PROMPT.length;

process.stdout.write(
  `${JSON.stringify(
    {
      runtime: `Bun ${Bun.version}`,
      parseValidate20StepP95Ms: Number(parseValidateP95Ms.toFixed(3)),
      parallelThreeTimersMs: Number(parallelThreeTimersMs.toFixed(3)),
      fanoutTwoHundredMs: Number(fanoutTwoHundredMs.toFixed(3)),
      fanoutPhysicalCalls: fanoutResult.details.calls,
      zeroTimerFanoutTwoHundredMs: Number(zeroFanoutTwoHundredMs.toFixed(3)),
      zeroTimerPhysicalCalls: zeroFanoutResult.details.calls,
      collapsedRender400Events1MiBP95Ms: Number(renderP95Ms.toFixed(3)),
      structuredRender400Events1MiBP95Ms: Number(structuredRenderP95Ms.toFixed(3)),
      detailsGuard400EventsP95Ms: Number(detailsGuardP95Ms.toFixed(3)),
      staticPromptChars,
      staticPromptApproxTokens: Math.ceil(staticPromptChars / 4),
    },
    undefined,
    2,
  )}\n`,
);
