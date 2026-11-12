import { describe, expect, it } from "vitest";
import { readCompactionMarker } from "../../../../src/core/shared/text-normalization.js";
import { applyReadOutputDimensions } from "../../../../src/sdk/read-output-contracts.js";
import { attachContextIntentReceipt } from "../../../../src/sdk/context-intent-contracts.js";
import { decodeQueryCursorEnvelope } from "../../../../src/sdk/pagination.js";
import { decodeReadOutputContinuationCursor } from "../../../../src/sdk/read-output/continuation.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";

/**
 * GH-1710: string compaction shortened next_cursor like any other long string,
 * so --after rejected the cursor the page emitted. A continuation token is
 * machine input for the next call and is never compacted, in either walker.
 */
describe("continuation tokens survive string compaction (GH-1710)", () => {
  const cursor = `eyJ2${"QUJD".repeat(120)}`;
  const page = () => ({
    items: [1, 2, 3].map((index) => ({ id: `pm-${index}`, title: `${"T".repeat(2000)}${index}`, status: "open" })),
    count: 3,
    total: 8,
    has_more: true,
    next_cursor: cursor,
    nested: { section: { next_cursor: cursor, output_cursor: cursor, source_cursor: cursor, cursor, note: "N".repeat(600) } },
  });

  it("keeps every cursor whole while explanatory strings carry the compaction marker", () => {
    for (const format of ["json", "toon"] as const) {
      const bounded = applyReadOutputDimensions("list", { outputFormat: format, outputBudget: 2000 }, page());
      expect(bounded.read_output).toMatchObject({ strings_compacted: true, rows_compacted: false });
      expect(bounded.next_cursor).toBe(cursor);
      expect(bounded.nested.section).toMatchObject({ next_cursor: cursor, output_cursor: cursor, source_cursor: cursor, cursor });
      expect(readCompactionMarker(bounded.items[0]!.title)).toBe(1761);
      expect(readCompactionMarker(bounded.nested.section.note)).toBe(360);
    }
  });

  it("keeps every cursor whole on the context-intent compaction path", () => {
    const intent = attachContextIntentReceipt("list", { for: "triage", tokenBudget: 2000 }, page());
    expect(intent.context_intent).toMatchObject({ degradation: "recursive_budget_compaction" });
    expect(intent.next_cursor).toBe(cursor);
    expect(intent.nested.section).toMatchObject({ next_cursor: cursor, output_cursor: cursor, source_cursor: cursor, cursor });
    expect(readCompactionMarker(intent.items[0]!.title)).toBe(1761);
  });

  it("still compacts a non-string value stored under a cursor key", () => {
    const bounded = applyReadOutputDimensions("list", { outputBudget: 2000 }, { ...page(), cursor: { label: "L".repeat(600) } });
    expect(readCompactionMarker(bounded.cursor.label)).toBe(360);
  });

  it("diagnoses a cursor argument a compacted read shortened, on both cursor kinds", () => {
    const capture = (run: () => unknown): PmCliError => {
      try {
        run();
      } catch (error) {
        return error as PmCliError;
      }
      throw new Error("expected a refusal");
    };
    for (const flag of ["--after", "--cursor"] as const) {
      const query = capture(() => decodeQueryCursorEnvelope(`${cursor.slice(0, 240)}…`, flag));
      expect(query.message).toContain("shortened by output compaction");
      expect(query.context).toMatchObject({ code: "invalid_query_cursor", reason: "cursor_compacted" });
      expect(query.context.nextSteps).toEqual([
        expect.stringContaining(`pass its whole next_cursor to ${flag}`),
        `Or repeat the original query without ${flag} to obtain a fresh cursor.`,
      ]);
    }
    const output = capture(() => decodeReadOutputContinuationCursor(`${cursor.slice(0, 240)}…[+111 chars]`));
    expect(output.context).toMatchObject({ code: "read_output_cursor_invalid", reason: "cursor_compacted" });
    expect(output.context.nextSteps).toEqual([expect.stringContaining("--output-cursor")]);
    // A cursor without an ellipsis keeps the generic refusal.
    expect(capture(() => decodeQueryCursorEnvelope("not-a-cursor")).message).toBe("Query cursor is malformed.");
  });
});
