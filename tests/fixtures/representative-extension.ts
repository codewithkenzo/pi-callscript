import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function representativeExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "smoke_extension",
    label: "Smoke extension",
    description: "Representative extension tool for additive exposure smoke proof.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      return {
        content: [{ type: "text", text: "SMOKE_EXTENSION_TOOL_CALLED" }],
        details: {},
      };
    },
  });

  pi.registerCommand("smoke-probe", {
    description: "Report active tools from representative extension",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`SMOKE_ACTIVE_TOOLS:${pi.getActiveTools().join(",")}`);
      ctx.ui.notify("SMOKE_EXTENSION_CALLED");
    },
  });
}
