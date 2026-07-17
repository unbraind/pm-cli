import { describe, expect, it } from "vitest";
import { graphOptionsFromFlat } from "../../../src/sdk/runtime-input.js";

describe("graphOptionsFromFlat", () => {
  it("passes scalar strings, arrays, integer bounds, and summary through", () => {
    expect(
      graphOptionsFromFlat({
        kind: ["blocked_by", "parent"],
        maxDepth: 3,
        limit: "5",
        after: "pm-cursor",
        direction: "incoming",
        maxPaths: "4",
        sample: 2,
        exemptIsolate: "pm-root",
        summary: true,
      }),
    ).toEqual({
      kind: ["blocked_by", "parent"],
      maxDepth: 3,
      limit: "5",
      after: "pm-cursor",
      direction: "incoming",
      maxPaths: "4",
      sample: 2,
      exemptIsolate: "pm-root",
      summary: true,
    });
  });

  it("drops blank, non-finite, and wrongly typed values", () => {
    const options = graphOptionsFromFlat({
      kind: "  ",
      maxDepth: Number.NaN,
      limit: true,
      after: "   ",
      direction: 7,
      maxPaths: "",
      sample: Number.POSITIVE_INFINITY,
      exemptIsolate: { not: "a list" },
      summary: "yes",
    });
    expect(options).toEqual({
      maxDepth: undefined,
      limit: undefined,
      after: undefined,
      direction: undefined,
      maxPaths: undefined,
      sample: undefined,
      summary: false,
    });
    expect("kind" in options).toBe(false);
    expect("exemptIsolate" in options).toBe(false);
  });

  it("normalizes array id lists to non-empty strings", () => {
    expect(
      graphOptionsFromFlat({ exemptIsolate: ["pm-a", "", 7, "pm-b"] }).exemptIsolate,
    ).toEqual(["pm-a", "7", "pm-b"]);
  });
});
