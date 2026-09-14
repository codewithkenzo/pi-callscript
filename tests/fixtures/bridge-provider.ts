import {
  createAssistantMessageEventStream,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
    fauxAssistantMessage(fauxToolCall("callscript", { script: bridgeScript }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("callscript", { script: checkpointScript }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("callscript", { decision: "continue", count: 1 }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("callscript", { decision: "continue" }), {
      stopReason: "toolUse",
    }),
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
      const inner = faux.streamSimple(model, context, options);
      const outer = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        for await (const event of inner) outer.push(event);
      });
      return outer;
    },
  });
}
