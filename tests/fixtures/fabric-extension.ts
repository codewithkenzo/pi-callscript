import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function fabricExtensionFixture(pi: ExtensionAPI) {
  pi.registerTool({
    name: "fabric_exec",
    label: "Fabric fixture",
    description: "Representative Fabric tool for additive exposure smoke proof.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      return {
        content: [{ type: "text", text: "FABRIC_FIXTURE_CALLED" }],
        details: {},
      };
    },
  });
}
