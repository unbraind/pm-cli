import { describe, expect, it } from "vitest";
import { unicodeSafePrefix } from "../../../../src/core/shared/text-normalization.js";
import { formatBuiltInOutput } from "../../../../src/core/output/output.js";
import { applyReadOutputDimensions } from "../../../../src/sdk/read-output-contracts.js";
import { attachContextIntentReceipt } from "../../../../src/sdk/context-intent-contracts.js";

describe("Unicode-safe read-output compaction (GH-1478)", () => {
  it.each([
    { offset: 238, prefix: `${"a".repeat(238)}😀` },
    { offset: 239, prefix: "a".repeat(239) },
    { offset: 240, prefix: "a".repeat(240) },
  ])("preserves valid astral prefixes across cutoff $offset in both compaction paths", ({ offset, prefix }) => {
    const title = `${"a".repeat(offset)}😀${"z".repeat(5000)}`;
    const original = { items: [{ id: "pm-unicode", title, status: "open", details: { notes: [title] } }], count: 1, total: 1 };
    const before = structuredClone(original);
    for (const format of ["json", "toon"] as const) {
      const bounded = applyReadOutputDimensions("list", { outputFormat: format, outputBudget: 1000 }, original);
      expect(bounded.read_output).toMatchObject({ strings_compacted: true, within_budget: true });
      const expected = `${prefix}…`;
      expect(bounded.items[0]!.title).toBe(expected);
      expect(bounded.items[0]!.details.notes[0]).toBe(expected);
      expect(formatBuiltInOutput(bounded, format)).not.toContain("�");
      expect(bounded.items[0]!.title.isWellFormed()).toBe(true);
      expect(bounded.read_output!.estimated_tokens).toBe(Math.ceil(Buffer.byteLength(formatBuiltInOutput(bounded, format), "utf8") / 4));
      expect(applyReadOutputDimensions("list", { outputFormat: format, outputBudget: "unbounded" }, original).items[0]!.title).toBe(title);
    }
    const intent = attachContextIntentReceipt("list", { for: "triage", tokenBudget: 1000 }, original);
    expect(intent.context_intent).toMatchObject({ degradation: "recursive_budget_compaction", within_budget: true });
    expect(intent.items[0]!.title.isWellFormed()).toBe(true);
    expect(intent.items[0]!.details.notes[0]).toBe(intent.items[0]!.title);
    expect(formatBuiltInOutput(intent, "toon")).not.toContain("�");
    expect(intent.context_intent!.estimated_tokens).toBe(Math.ceil(Buffer.byteLength(JSON.stringify(intent), "utf8") / 4));
    expect(original).toEqual(before);
  });

  it("retains preexisting malformed input rather than silently repairing it", () => {
    for (const [value, end, expected] of [
      ["", 0, ""], ["abc", 2, "ab"], ["😀x", 1, ""], ["😀x", 2, "😀"],
      ["\uD800x", 1, "\uD800"], ["\uD800\uE000", 1, "\uD800"], ["\uD800", 1, "\uD800"],
    ] as const) expect(unicodeSafePrefix(value, end)).toBe(expected);
  });
});
