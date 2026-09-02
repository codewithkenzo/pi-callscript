import { appendFileSync } from "node:fs";

import {
  createFauxCore,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const logPath = process.env.CALLSCRIPT_MATRIX_LOG;

function record(event: string, data: Record<string, string | boolean | string[]> = {}): void {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify({ event, ...data })}\n`);
}

export default function matrixProvider(pi: ExtensionAPI): void {
  record("extension_load");
  const faux = createFauxCore({
    api: "matrix-api",
    provider: "matrix",
    models: [
      {
        id: "matrix-1",
        name: "Matrix",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 256,
      },
    ],
    tokenSize: { min: 1, max: 1 },
  });
  faux.setResponses([fauxAssistantMessage("alpha beta gamma")]);

  pi.registerProvider("matrix", {
    api: "matrix-api",
    baseUrl: "http://localhost:0",
    apiKey: "matrix-key",
    models: [
      {
        id: "matrix-1",
        name: "Matrix",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 256,
      },
    ],
    streamSimple(model, context, options) {
      record("before_provider_start", { aborted: options?.signal?.aborted ?? false });
      const inner = faux.streamSimple(model, context, options);
      const outer = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        for await (const event of inner) {
          const item = event;
          if (item.type === "text_delta")
            record("text_delta", { delta: item.delta, aborted: options?.signal?.aborted ?? false });
          if (item.type === "done")
            record("provider_done", {
              stopReason: item.message.stopReason,
              aborted: options?.signal?.aborted ?? false,
            });
          if (item.type === "error")
            record("provider_error", {
              stopReason: item.error.stopReason,
              aborted: options?.signal?.aborted ?? false,
            });
          outer.push(item);
        }
      });
      return outer;
    },
  });

  pi.on("session_start", (event) =>
    record("session_start", { reason: event.reason, tools: pi.getActiveTools() }),
  );
  pi.on("before_agent_start", () => record("before_prompt", { tools: pi.getActiveTools() }));
  pi.on("agent_start", () => record("agent_start"));
  pi.on("turn_end", () => record("turn_end"));
  pi.on("agent_end", () => record("agent_end"));
  pi.on("agent_settled", () => record("agent_settled"));
}
