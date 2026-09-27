import { describe, expect, it } from "vitest";
import { attachOutputOmissionReceipt } from "../../../../src/sdk/output-projection.js";
import { applyReadOutputDimensions } from "../../../../src/sdk/read-output-contracts.js";

describe("history diff output continuation", () => {
  it("tolerates incomplete history projection metadata during budget compaction", () => {
    const diff = Array.from({ length: 80 }, (_, index) => ({
      index: index + 1,
      changes: [{ field: "status", before: "open", after: `closed-${index}` }],
    }));
    for (const projection of [{ mode: "diff" }, { mode: "diff", row_key: "unavailable" }]) {
      const result = {
        id: "pm-example",
        diff,
        projection,
        count: diff.length,
      };
      const page = applyReadOutputDimensions(
        "history",
        { outputBudget: 900, resolvedOutputFormat: "json" },
        result,
      );
      expect(page).not.toHaveProperty("output_budget_exceeded");
      expect(page).toMatchObject({ has_more: true });
      expect((page.diff as typeof diff).length).toBeLessThan(diff.length);
    }
  });

  it("counts an active diff cursor without projection metadata", () => {
    const diff = Array.from({ length: 80 }, (_, index) => ({
      index: index + 1,
      changes: [{ field: "status", before: "open", after: `closed-${index}` }],
    }));
    const result = { id: "pm-example", diff, count: diff.length };
    const first = applyReadOutputDimensions("history", { outputBudget: 900, resolvedOutputFormat: "json" }, result);
    const cursor = (first.output_budget_truncation as { continuations: Array<{ path: string; cursor: string }> })
      .continuations.find(({ path }) => path === "diff")?.cursor;
    expect(cursor).toBeDefined();
    const next = applyReadOutputDimensions("history", { outputBudget: 900, outputCursor: cursor, resolvedOutputFormat: "json" }, result);
    expect(next).not.toHaveProperty("projection");
    expect(next.count).toBe((next.diff as typeof diff).length);
  });

  it("reconstructs complete diff rows independently of compact history", () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      index: index + 1,
      op: "update",
      changed_fields: ["status"],
    }));
    const diffs = rows.map((row) => ({
      ...row,
      changes: [{ field: "status", before: "open", after: `state-${row.index}` }],
    }));
    const result = attachOutputOmissionReceipt("history", {
      id: "pm-example",
      compact_history: rows,
      diff: diffs,
      compact: true,
      projection: { mode: "compact", row_key: "compact_history" },
      count: rows.length,
      omission_receipt: { has_omissions: true, omitted_field_group_count: 1, omitted_field_groups: [{ name: "raw_history", restore_with: "--full" }] },
    }) as Record<string, unknown>;
    const first = applyReadOutputDimensions("history", { outputBudget: 900, resolvedOutputFormat: "json" }, result);
    expect(first).toMatchObject({ has_more: true, read_output: { strings_compacted: false } });
    expect(first.output_budget_truncation).toMatchObject({
      continuations: expect.arrayContaining([
        expect.objectContaining({ path: "diff", remaining_rows: expect.any(Number) }),
      ]),
    });

    const received = [...(first.diff as typeof diffs)];
    let cursor = (first.output_budget_truncation as { continuations: Array<{ path: string; cursor: string }> })
      .continuations.find(({ path }) => path === "diff")?.cursor;
    for (let pageNumber = 0; cursor && pageNumber < 20; pageNumber += 1) {
      const page = applyReadOutputDimensions(
        "history",
        { outputBudget: 900, outputCursor: cursor, resolvedOutputFormat: "json" },
        result,
      );
      expect(page).not.toHaveProperty("compact_history");
      expect(page).not.toHaveProperty("output_budget_exceeded");
      received.push(...(page.diff as typeof diffs));
      cursor = (page.output_budget_truncation as { continuations?: Array<{ path: string; cursor: string }> } | undefined)
        ?.continuations?.find(({ path }) => path === "diff")?.cursor;
    }
    expect(cursor).toBeUndefined();
    expect(received).toEqual(diffs);
  });
});
