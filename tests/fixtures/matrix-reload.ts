import { appendFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function reloadDriver(pi: ExtensionAPI): void {
  pi.registerCommand("matrix-reload", {
    description: "Run host resource reload for response matrix",
    async handler(_args, ctx) {
      const logPath = process.env.CALLSCRIPT_MATRIX_LOG;
      if (logPath)
        appendFileSync(
          logPath,
          `${JSON.stringify({ event: "before_reload", tools: pi.getActiveTools() })}\n`,
        );
      await ctx.reload();
    },
  });
}
