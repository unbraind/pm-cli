/**
 * @module tests/unit/sdk/merge-receipt-history
 *
 * Exercises the pure preferred-era receipt classifier across accepted and
 * malformed historical summary shapes.
 */
import { describe, expect, it } from "vitest";
import {
  extractHistoryMergeReceiptReferences,
  isLegacyMergeReceiptSummary,
} from "../../../../src/sdk/governance/merge-receipt-history.js";

function legacySummary(): Record<string, unknown> {
  return {
    receipt_id: "legacy-receipt",
    item_id: "pm-receipt",
    item_path: ".agents/pm/tasks/pm-receipt.md",
    conflict_fields: ["title"],
    fields_from_theirs: [],
    union_fields: [],
    preferred: "theirs",
    decisions: [
      {
        field: "title",
        retained_hash: "a".repeat(64),
        discarded_hash: "b".repeat(64),
      },
    ],
  };
}

describe("merge receipt history compatibility", () => {
  it("accepts complete markdown summaries and rejects malformed decisions", () => {
    expect(isLegacyMergeReceiptSummary(legacySummary(), "pm-receipt")).toBe(
      true,
    );
    expect(
      isLegacyMergeReceiptSummary(
        { ...legacySummary(), receipt_id: 42 },
        "pm-receipt",
      ),
    ).toBe(false);
    expect(
      isLegacyMergeReceiptSummary(
        { ...legacySummary(), decisions: [null] },
        "pm-receipt",
      ),
    ).toBe(false);
  });

  it("ignores blank receipt identifiers during bounded extraction", () => {
    expect(
      extractHistoryMergeReceiptReferences(
        {
          context: {
            merge: {
              receipts: [{ receipt_id: " " }, legacySummary()],
            },
          },
        },
        "pm-receipt",
      ),
    ).toEqual([{ receiptId: "legacy-receipt", legacySummaryAccepted: true }]);
  });
});
