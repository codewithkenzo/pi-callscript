import { appendFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function inertMatrixExtension(pi: ExtensionAPI): void {
  const logPath = process.env.CALLSCRIPT_MATRIX_LOG;
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ event: "inert_load" })}\n`);
  pi.registerTool({
    name: "matrix_inert",
    label: "Matrix inert",
    description: "Inert reload control",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "inert" }], details: {} };
    },
  });
}
