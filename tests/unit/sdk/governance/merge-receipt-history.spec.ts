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
    expect(
      isLegacyMergeReceiptSummary(
        { ...legacySummary(), decisions: null },
        "pm-receipt",
      ),
    ).toBe(false);
    expect(
      isLegacyMergeReceiptSummary(
        { ...legacySummary(), decisions: [] },
        "pm-receipt",
      ),
    ).toBe(false);
    expect(
      isLegacyMergeReceiptSummary(
        {
          ...legacySummary(),
          decisions: [
            {
              field: "",
              retained_hash: "a".repeat(64),
              discarded_hash: "b".repeat(64),
            },
          ],
        },
        "pm-receipt",
      ),
    ).toBe(false);
    expect(
      isLegacyMergeReceiptSummary(
        { ...legacySummary(), conflict_fields: ["description"] },
        "pm-receipt",
      ),
    ).toBe(false);
    expect(
      isLegacyMergeReceiptSummary(
        { ...legacySummary(), item_path: "../tasks/pm-receipt.md" },
        "pm-receipt",
      ),
    ).toBe(false);
    expect(
      isLegacyMergeReceiptSummary(
        { ...legacySummary(), item_path: 42 },
        "pm-receipt",
      ),
    ).toBe(false);
    expect(
      isLegacyMergeReceiptSummary(
        {
          ...legacySummary(),
          item_path: ".agents/pm/tasks/pm-receipt.md\0ignored",
        },
        "pm-receipt",
      ),
    ).toBe(false);
  });

  it("rejects sparse or duplicated collection evidence", () => {
    const sparse = Array(1) as unknown[];
    expect(
      isLegacyMergeReceiptSummary(
        { ...legacySummary(), decisions: sparse },
        "pm-receipt",
      ),
    ).toBe(false);
    expect(
      isLegacyMergeReceiptSummary(
        { ...legacySummary(), conflict_fields: ["title", "title"] },
        "pm-receipt",
      ),
    ).toBe(false);
    expect(
      isLegacyMergeReceiptSummary(
        { ...legacySummary(), conflict_fields: Array(257).fill("field") },
        "pm-receipt",
      ),
    ).toBe(false);
    expect(
      isLegacyMergeReceiptSummary(
        {
          ...legacySummary(),
          conflict_fields: ["a\0b", "c"],
          decisions: [
            {
              field: "a",
              retained_hash: "a".repeat(64),
              discarded_hash: "b".repeat(64),
            },
            {
              field: "b\0c",
              retained_hash: "c".repeat(64),
              discarded_hash: "d".repeat(64),
            },
          ],
        },
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
