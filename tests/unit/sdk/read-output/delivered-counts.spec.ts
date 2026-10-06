import { describe, expect, it } from "vitest";
import { compactReadOutputToBudget } from "../../../../src/sdk/read-output-budget.js";
import { applyReadOutputDimensions, decodeReadOutputContinuationCursor } from "../../../../src/sdk/read-output-contracts.js";
import { refreshReadOutputDeliveredCounts, rememberReadOutputFocusRows, sliceReadOutputRowCollection } from "../../../../src/sdk/read-output-rows.js";
import { decodeQueryCursorEnvelope, encodeQueryCursor } from "../../../../src/sdk/pagination.js";

describe("delivered row count receipts (GH-1371)", () => {
  it("rebases producer deletion fallback from the uncapped page coordinate", () => {
    const items = Array.from({ length: 50 }, (_, index) => ({ id: `pm-coordinate-${index}`, title: "Long coordinate evidence ".repeat(20) }));
    const producer = {
      items, count: items.length, total: 75, next_cursor: encodeQueryCursor("query-fingerprint", items.at(-1)!.id, items.length - 1),
    };
    const result = applyReadOutputDimensions("list", { outputLimit: 20, outputBudget: 1700, outputFormat: "json" }, producer);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.length).toBeLessThan(20);
    expect(decodeQueryCursorEnvelope(result.next_cursor).after_index).toBe(result.items.length - 1);
    const outputCursor = result.output_budget_truncation!.recovery.cursor!;
    expect(decodeReadOutputContinuationCursor(outputCursor).offset).toBe(result.items.length);
    const resumed = applyReadOutputDimensions("list", { outputLimit: 20, outputBudget: 1000, outputFormat: "json", outputCursor }, producer);
    expect(resumed.items.length).toBeGreaterThan(0);
    expect(resumed.items.length).toBeLessThan(20);
    expect(resumed.items.length).toBeLessThan(items.length - result.items.length);
    expect(resumed.output_budget_truncation).toBeDefined();
    expect(decodeQueryCursorEnvelope(resumed.next_cursor).after_index).toBe(result.items.length + resumed.items.length - 1);
  });

  it("counts shaped context focus while preserving population and blocker totals", () => {
    const source = {
      summary: { active_items: 30, blocked: 10, high_level: 1, low_level: 2, returned_focus: { active_items: 4, open: 3, in_progress: 1, blocked: 1 } },
      high_level: [{ id: "pm-parent", title: "Parent", status: "in_progress" }],
      low_level: [{ id: "pm-a", title: "A", status: "open" }, { id: "pm-b", title: "B", status: "open", blocked: true }],
      blocked_fallback: [{ id: "pm-c", title: "C", status: "blocked", blocked: true }],
    };
    const result = applyReadOutputDimensions("context", { outputLimit: 1, outputInclude: "id", outputBudget: "unbounded" }, source);
    expect(result.summary).toMatchObject({ active_items: 30, blocked: 10, high_level: 1, low_level: 1, returned_focus: { active_items: 3, open: 2, in_progress: 1, blocked: 1 } });
    expect(source.summary.returned_focus.active_items).toBe(4);
    const withoutIds = applyReadOutputDimensions("context", { outputLimit: 1, outputInclude: "title", outputBudget: "unbounded" }, source);
    expect(withoutIds.summary.returned_focus).toEqual(result.summary.returned_focus);
  });

  it("retains status and blocker receipts when budget compaction follows an ID-only projection", () => {
    const source = {
      summary: { active_items: 100, blocked: 100, returned_focus: { active_items: 100, in_progress: 100, open: 0, blocked: 100 } },
      low_level: Array.from({ length: 100 }, (_, index) => ({ id: `pm-projected-context-row-${index}`, status: "in_progress", blocked: true })),
    };
    const result = applyReadOutputDimensions("context", { outputInclude: "id", outputBudget: 1200, outputFormat: "json" }, source);
    expect(result.low_level.length).toBeGreaterThan(0);
    expect(result.low_level.length).toBeLessThan(100);
    expect(result.summary).toMatchObject({ active_items: 100, blocked: 100, returned_focus: { active_items: result.low_level.length, in_progress: result.low_level.length, open: 0, blocked: result.low_level.length } });
  });

  it("preserves producer classifications through transport cloning and continuation of ID-only rows", () => {
    const source = {
      summary: { active_items: 4, returned_focus: { active_items: 4, in_progress: 2, open: 2, blocked: 2 } },
      low_level: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }, { id: "d", title: "D" }],
      row_contract: { row_keys: ["low_level"] },
    };
    rememberReadOutputFocusRows(source, [
      { id: "a", status: "open", blocked: false },
      { id: "b", status: "in_progress", blocked: true },
      { id: "c", status: "in_progress", blocked: false },
      { id: "d", status: "open", blocked: true },
    ]);
    const cloned = JSON.parse(JSON.stringify(source));
    const continued = sliceReadOutputRowCollection(cloned, "low_level", 1);
    const result = applyReadOutputDimensions("context", { outputInclude: "id", outputLimit: 1, outputBudget: "unbounded" }, continued);
    expect(result.low_level).toEqual([{ id: "b" }]);
    expect(result.summary).toMatchObject({ active_items: 4, returned_focus: { active_items: 1, in_progress: 1, open: 0, blocked: 1 }, focus_row_states: { low_level: "I" } });
    expect(cloned.low_level).toHaveLength(4);
    const withoutIds = JSON.parse(JSON.stringify(applyReadOutputDimensions("context", { outputInclude: "title", outputBudget: "unbounded" }, cloned)));
    const noIdPage = applyReadOutputDimensions("context", { outputLimit: 1, outputBudget: "unbounded" }, sliceReadOutputRowCollection(withoutIds, "low_level", 1));
    expect(noIdPage.low_level).toEqual([{ title: "B" }]);
    expect(noIdPage.summary.returned_focus).toEqual({ active_items: 1, in_progress: 1, open: 0, blocked: 1 });
    const tail = applyReadOutputDimensions("context", { outputBudget: "unbounded" }, sliceReadOutputRowCollection(cloned, "low_level", 2));
    expect(tail.summary.returned_focus).toEqual({ active_items: 2, in_progress: 1, open: 1, blocked: 1 });
  });

  it("protects long semantic receipts while compacting explanatory strings and hundreds of projected rows", () => {
    const source = {
      explanation: "Long explanatory detail ".repeat(100),
      summary: { active_items: 600, returned_focus: { active_items: 600, in_progress: 600, open: 0, blocked: 0 } },
      low_level: Array.from({ length: 600 }, (_, index) => ({ id: `p-${index}`, status: "in_progress", blocked: false })),
    };
    rememberReadOutputFocusRows(source, source.low_level);
    const serialized = JSON.parse(JSON.stringify(applyReadOutputDimensions("context", { outputInclude: "id", outputBudget: "unbounded" }, source)));
    const compactedStrings = compactReadOutputToBudget(serialized, serialized.read_output, 100_000);
    expect(compactedStrings.summary.focus_row_states.low_level).toBe("i".repeat(600));
    expect(compactedStrings.read_output.strings_compacted).toBe(true);
    const result = applyReadOutputDimensions("context", { outputBudget: 3500, outputFormat: "json" }, serialized);
    expect(result.read_output.strings_compacted).toBe(true);
    expect(result.low_level.length).toBeGreaterThan(240);
    expect(result.low_level.length).toBeLessThan(600);
    expect(result.summary.returned_focus).toEqual({ active_items: result.low_level.length, in_progress: result.low_level.length, open: 0, blocked: 0 });
    expect(result.summary.focus_row_states.low_level).toBe("i".repeat(result.low_level.length));
  });

  it.each(["…", "i…", "ii", 1])("rejects corrupt or misaligned classifications instead of counting them as blockers: %s", (receipt) => {
    const malformed = { summary: { returned_focus: {}, focus_row_states: { low_level: receipt } }, low_level: [{ id: "a" }] };
    expect(() => refreshReadOutputDeliveredCounts(malformed)).toThrow("one i/I/o/O code per delivered record");
  });

  it("counts SDK items independently from warnings without a CLI row contract", () => {
    const result = applyReadOutputDimensions("list", { outputInclude: "id", outputBudget: "unbounded" }, { items: [{ id: "a" }, { id: "b" }], warnings: ["read_warning"], count: 2 });
    expect(result.count).toBe(2);
    expect(result.warnings).toEqual(["read_warning"]);
  });

  it("preserves count-only aggregates when no item rows are requested", () => {
    const source = { items: [], count: 30, total: 30, count_only: true };
    expect(applyReadOutputDimensions("search", { outputBudget: "unbounded" }, source)).toMatchObject(source);
    const compacted = applyReadOutputDimensions("search", { outputBudget: 1000, outputFormat: "json" }, {
      ...source,
      warnings: Array.from({ length: 100 }, (_, index) => `warning ${index} ${"detail ".repeat(10)}`),
    });
    expect(compacted.warnings.length).toBeGreaterThan(0);
    expect(compacted.warnings.length).toBeLessThan(100);
    expect(compacted).toMatchObject(source);
    for (const outputInclude of ["count,total,count_only,warnings", "count,total,warnings"]) {
      const rootProjected = applyReadOutputDimensions("search", { outputInclude, outputBudget: 1000, outputFormat: "json" }, {
        ...source,
        warnings: Array.from({ length: 100 }, (_, index) => `warning ${index} ${"detail ".repeat(10)}`),
      });
      expect(rootProjected).not.toHaveProperty("items");
      expect(rootProjected.warnings.length).toBeGreaterThan(0);
      expect(rootProjected.warnings.length).toBeLessThan(100);
      expect(rootProjected).toMatchObject({ count: 30, total: 30 });
      expect(Object.hasOwn(rootProjected, "count_only")).toBe(outputInclude.includes("count_only"));
    }
    const noAuthoritativeCount = { ...source };
    refreshReadOutputDeliveredCounts(noAuthoritativeCount, {});
    expect(noAuthoritativeCount.count).toBe(30);
  });

  it("handles empty focus sections and item pages without inventing counters", () => {
    const result = { summary: { active_items: 99, high_level: 99, low_level: 99, returned_focus: {} }, high_level: [], low_level: [], blocked_fallback: [] };
    refreshReadOutputDeliveredCounts(result);
    expect(result.summary).toMatchObject({ active_items: 99, high_level: 0, low_level: 0, returned_focus: { active_items: 0, open: 0, in_progress: 0, blocked: 0 } });
    const page = { items: [{ id: "a" }], count: 25, total: 30 };
    refreshReadOutputDeliveredCounts(page);
    expect(page).toMatchObject({ count: 1, total: 30 });
    const noSummary = { items: [] };
    rememberReadOutputFocusRows(noSummary, []);
    expect(noSummary).toEqual({ items: [] });
    const noReceipt = { items: [], summary: {} };
    rememberReadOutputFocusRows(noReceipt, []);
    refreshReadOutputDeliveredCounts(noReceipt);
    expect(noReceipt).toEqual({ items: [], summary: {} });
    const omittedSections = { summary: { high_level: 4, low_level: 3, returned_focus: {} } };
    refreshReadOutputDeliveredCounts(omittedSections);
    expect(omittedSections.summary).toMatchObject({ high_level: 0, low_level: 0, returned_focus: { active_items: 0 } });
    const sparse = { summary: { high_level: 0, low_level: 2, returned_focus: {} }, low_level: [{ id: "a", status: "open" }, null] };
    refreshReadOutputDeliveredCounts(sparse, {});
    expect(sparse.summary).toMatchObject({ high_level: 0, low_level: 2, returned_focus: { active_items: 1, open: 1 } });
    rememberReadOutputFocusRows(sparse, []);
    refreshReadOutputDeliveredCounts(sparse);
    expect(sparse.summary).not.toHaveProperty("focus_row_states");
  });
});
