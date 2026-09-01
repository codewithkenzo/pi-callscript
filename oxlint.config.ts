import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: ["dist/**", "node_modules/**", ".pi/**"],
  rules: {
    eqeqeq: "error",
    "no-console": "error",
    "no-debugger": "error",
    "prefer-const": "error",
    "typescript/no-explicit-any": "error",
  },
});
