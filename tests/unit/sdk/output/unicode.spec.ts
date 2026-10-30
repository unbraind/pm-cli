import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { assertWellFormedOutputText, toWellFormedText } from "../../../../src/sdk/core.js";
import { formatBuiltInOutput } from "../../../../src/core/output/output.js";

describe("public output Unicode policy", () => {
  it("preserves native scalar serialization of boxed primitives across realms", () => {
    const value: unknown = runInNewContext('({ count: Object(3), enabled: Object(true), text: Object("😀") })');
    const expected = { count: 3, enabled: true, text: "😀" };
    expect(JSON.parse(formatBuiltInOutput(value, "json"))).toEqual(expected);
    expect(formatBuiltInOutput(value, "toon")).toBe(formatBuiltInOutput(expected, "toon"));
    for (const format of ["json", "toon"] as const) {
      expect(() => formatBuiltInOutput({ text: Object("bad\ud800") }, format)).toThrow(
        expect.objectContaining({ code: "text_unpaired_surrogate", context: expect.objectContaining({ field: "$.text" }) }),
      );
    }
  });

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
    const sparse = new Array(3);
    sparse[0] = "kept";
    expect(JSON.parse(formatBuiltInOutput(sparse, "json"))).toEqual(["kept", null, null]);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => assertWellFormedOutputText(cycle)).not.toThrow();
    expect(() => formatBuiltInOutput(cycle, "json")).toThrow(TypeError);
    expect(toWellFormedText("x\ud800😀\udc00")).toBe("x�😀�");
    expect(toWellFormedText("😀")).toBe("😀");
  });

  it("validates the actual toJSON snapshot once per render across both formats", () => {
    for (const format of ["json", "toon"] as const) {
      for (const serialized of ["bad\ud800", { ["bad\udc00"]: "kept" }]) {
        expect(() => formatBuiltInOutput({ nested: [{ toJSON: () => serialized }] }, format)).toThrow(
          expect.objectContaining({ code: "text_unpaired_surrogate", exitCode: 2 }),
        );
      }
      let calls = 0;
      const value = Object.freeze({ nested: [{ toJSON(key: string) { return ++calls === 1 ? { text: "😀", sibling: "kept", key } : "bad\ud800"; } }] });
      const rendered = formatBuiltInOutput(value, format);
      expect(calls).toBe(1);
      expect(rendered).toContain("😀");
      expect(rendered).toContain("kept");
      expect(rendered).toContain("0");
      expect(formatBuiltInOutput({ date: new Date("2026-10-29T00:00:00.000Z"), missing: { toJSON: () => undefined } }, format)).toContain("2026-10-29T00:00:00.000Z");
    }
  });
});
