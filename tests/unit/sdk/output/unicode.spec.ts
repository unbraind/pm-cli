import { describe, expect, it } from "vitest";
import { assertWellFormedOutputText, toWellFormedText } from "../../../../src/sdk/core.js";
import { formatBuiltInOutput } from "../../../../src/core/output/output.js";

describe("public output Unicode policy", () => {
  it.each([
    ["\ud800", "$", 0],
    [{ nested: [{ value: "a\udc00" }] }, "$.nested[0].value", 1],
    [{ ["bad\ud800"]: "valid" }, '$["bad\\ud800"] (key)', 3],
    [Object.assign([], { ["bad\ud800"]: "valid" }), '$["bad\\ud800"] (key)', 3],
  ] as const)("refuses malformed text with a field diagnostic: %j", (value, field, index) => {
    const before = structuredClone(value);
    for (const format of ["json", "toon"] as const) {
      expect(() => formatBuiltInOutput(value, format)).toThrow(expect.objectContaining({
        code: "text_unpaired_surrogate", exitCode: 2, context: expect.objectContaining({ field }),
        message: expect.stringContaining(`index ${index}`),
      }));
    }
    try { assertWellFormedOutputText(value); }
    catch (error) {
      expect((error as Error).message.isWellFormed()).toBe(true);
    }
    expect(value).toEqual(before);
  });

  it("preserves valid strings, non-text leaves, shared values and serializer-owned cycle handling", () => {
    const shared = { value: "😀", empty: "" };
    const value = { left: shared, right: shared, leaves: [null, undefined, true, 1] };
    expect(() => assertWellFormedOutputText(value)).not.toThrow();
    expect(formatBuiltInOutput(value, "json")).toContain("😀");
    expect(formatBuiltInOutput(value, "toon")).toContain("😀");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => assertWellFormedOutputText(cycle)).not.toThrow();
    expect(() => formatBuiltInOutput(cycle, "json")).toThrow(TypeError);
    expect(toWellFormedText("x\ud800😀\udc00")).toBe("x�😀�");
    expect(toWellFormedText("😀")).toBe("😀");
  });
});
