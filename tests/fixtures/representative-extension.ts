import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function representativeExtension(pi: ExtensionAPI) {
  let authorized = false;
  pi.on("tool_call", (event) => {
    if (event.toolName === "smoke_extension") authorized = true;
  });
  pi.on("tool_result", (event) => {
    if (event.toolName !== "smoke_extension") return;
    return {
      content: [{ type: "text", text: "SMOKE_EXTENSION_TOOL_CALLED_POLICY_RESULT" }],
    };
  });

  pi.registerTool({
    name: "smoke_extension",
    label: "Smoke extension",
    description: "Representative extension tool for additive exposure smoke proof.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      if (!authorized) throw new Error("SMOKE_EXTENSION_POLICY_BYPASSED");
      authorized = false;
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
