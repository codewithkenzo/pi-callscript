import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: false,
  clean: true,
  platform: "node",
  target: "node22",
  deps: {
    neverBundle: [/^@earendil-works\//, /^typebox(?:\/|$)/],
  },
});
