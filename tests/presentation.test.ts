import { describe, expect, test } from "vitest";

import { presentationDetails, projectPresentation } from "../src/presentation.js";

describe("typed presentation", () => {
  test("keeps text head and tail with exact byte and line receipt", () => {
    const value = projectPresentation(`head\n${"middle".repeat(80)}\ntail`, 140);

    expect(value.kind).toBe("text");
    expect(value.content).toContain("head");
    expect(value.content).toContain("tail");
    expect(value.receipt.originalLines).toBe(3);
    expect(value.receipt.hiddenBytes).toBeGreaterThan(0);
    expect(value.receipt.continuation?.kind).toBe("text");
  });

  test("projects structured items without duplicating content in details", () => {
    const value = projectPresentation(
      { alpha: "a".repeat(80), beta: "b".repeat(80), gamma: "three" },
      150,
    );
    const details = presentationDetails(value);

    expect(value.kind).toBe("structured");
    expect(details).not.toHaveProperty("content");
    expect(value.receipt.originalItems).toBe(3);
    expect(value.receipt.hiddenItems).toBeGreaterThan(0);
    expect(value.receipt.continuation?.kind).toBe("items");
  });

  test("rejects invalid byte bounds", () => {
    expect(() => projectPresentation("result", 0)).toThrow("positive integer");
  });
});
