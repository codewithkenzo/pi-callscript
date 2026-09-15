import {
  createAssistantMessageEventStream,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const RootObjectSchema = Type.Object(
  { type: Type.Literal("object") },
  { additionalProperties: true },
);

const bridgeScript = `
const extension = await pi({ tool: "smoke_extension", args: {} });
const builtin = await pi({ tool: "read", args: { path: "package.json", limit: 1 } });
return { extension, builtin };
`;

const checkpointScript = `
const saved = await snapshot({ paths: [".pi/checkpoint-smoke-first.txt", ".pi/checkpoint-smoke-second.txt"] });
await think({ note: "checkpoint smoke" });
const first = write({ path: ".pi/checkpoint-smoke-first.txt", content: "first" });
const second = await write({ path: ".pi/checkpoint-smoke-second.txt", content: "second" });
await undo({ snapshot: saved.id });
return "CHECKPOINT_DECISION_DONE";
`;

const stopCheckpointScript = `
await think({ note: "stop smoke" });
return "STOP_SMOKE_SHOULD_NOT_RUN";
`;

const replaceCheckpointScript = `
await think({ note: "replace smoke" });
return "REPLACE_SMOKE_SHOULD_NOT_RUN";
`;

export default function bridgeProvider(pi: ExtensionAPI): void {
  const faux = createFauxCore({
    api: "bridge-api",
    provider: "bridge",
    models: [
      {
        id: "bridge-1",
        name: "Bridge",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4_096,
        maxTokens: 256,
      },
    ],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("callscript", {
        script: bridgeScript,
        decision: null,
        count: null,
        fromScratch: null,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("callscript", {
        script: checkpointScript,
        decision: null,
        count: null,
        fromScratch: null,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("callscript", {
        script: null,
        decision: "continue",
        count: 1,
        fromScratch: null,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("callscript", {
        script: null,
        decision: "continue",
        count: null,
        fromScratch: null,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("callscript", {
        script: stopCheckpointScript,
        decision: null,
        count: null,
        fromScratch: null,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("callscript", {
        script: null,
        decision: "stop",
        count: null,
        fromScratch: null,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("callscript", {
        script: replaceCheckpointScript,
        decision: null,
        count: null,
        fromScratch: null,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("callscript", {
        script: 'return "STRICT_REPLACE_DONE";',
        decision: "replace",
        count: null,
        fromScratch: false,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("CALLSCRIPT_BRIDGE_DONE"),
  ]);

  pi.registerProvider("bridge", {
    api: "bridge-api",
    baseUrl: "http://localhost:0",
    apiKey: "bridge-key",
    models: [
      {
        id: "bridge-1",
        name: "Bridge",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4_096,
        maxTokens: 256,
      },
    ],
    streamSimple(model, context, options) {
      const callscript = context.tools?.find((tool) => tool.name === "callscript");
      if (callscript === undefined || !Value.Check(RootObjectSchema, callscript.parameters))
        throw new Error("CallScript provider schema must have root type object");
      const inner = faux.streamSimple(model, context, options);
      const outer = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        for await (const event of inner) outer.push(event);
      });
      return outer;
    },
  });
}
