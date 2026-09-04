/**
 * @module tests/unit/sdk/merge-receipt-history
 *
 * Exercises the pure preferred-era receipt classifier across accepted and
 * malformed historical summary shapes.
 */
import { describe, expect, it } from "vitest";
import {
  classifyHistoryMergeReceiptReferences,
  extractHistoryMergeReceiptDispositions,
  extractHistoryMergeReceiptReferences,
  isLegacyMergeReceiptSummary,
  isPreDurableCloneLocalReceiptSummary,
  isPreDurableDispositionEligibleReference,
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
    ).toEqual([
      expect.objectContaining({
        receiptId: "legacy-receipt",
        legacySummaryAccepted: true,
      }),
    ]);
  });

  it("requires the exact final pre-durable schema before disposition", () => {
    const summary = {
      ...legacySummary(),
      conflict_resolution: "stable_value_order",
    };
    expect(isPreDurableCloneLocalReceiptSummary(summary, "pm-receipt")).toBe(
      true,
    );
    expect(
      isPreDurableCloneLocalReceiptSummary(
        { ...summary, item_path: "../pm-receipt.md" },
        "pm-receipt",
      ),
    ).toBe(false);
    expect(
      isPreDurableCloneLocalReceiptSummary(
        { ...summary, conflict_resolution: "unknown" },
        "pm-receipt",
      ),
    ).toBe(false);
  });

  it("accepts only audited pre-durable missing-receipt dispositions", () => {
    const [extractedReference] = extractHistoryMergeReceiptReferences(
      {
        ts: "2026-08-06T22:21:21.734Z",
        context: {
          merge: {
            receipts: [
              {
                ...legacySummary(),
                conflict_resolution: "stable_value_order",
              },
            ],
          },
        },
      },
      "pm-receipt",
    );
    expect(isPreDurableDispositionEligibleReference(extractedReference!)).toBe(
      true,
    );
    const reference = {
      ...extractedReference!,
      itemId: "pm-receipt",
      line: 9,
    };
    const dispositions = extractHistoryMergeReceiptDispositions(
      {
        ts: "2026-09-04T00:00:00.000Z",
        op: "merge_reconcile",
        context: {
          merge: {
            missing_receipt_dispositions: [
              {
                receipt_id: "legacy-receipt",
                original_history_line: 9,
                original_event_ts: "2026-08-06T22:21:21.734Z",
                reason: "legacy_clone_local_only",
              },
            ],
          },
        },
      },
      "pm-receipt",
      10,
    );

    expect(
      classifyHistoryMergeReceiptReferences([reference], new Set(), [
        ...dispositions,
        { ...dispositions[0]!, auditHistoryLine: 11 },
      ]),
    ).toEqual({
      missing: [],
      acceptedLegacyCount: 0,
      acceptedDispositionCount: 1,
    });
    expect(
      classifyHistoryMergeReceiptReferences(
        [reference],
        new Set(),
        dispositions.map((disposition) => ({
          ...disposition,
          auditHistoryLine: reference.line,
        })),
      ).missing,
    ).toHaveLength(1);
    expect(
      classifyHistoryMergeReceiptReferences(
        [
          {
            itemId: reference.itemId,
            line: reference.line,
            receiptId: reference.receiptId,
            legacySummaryAccepted: false,
            eventTimestamp: reference.eventTimestamp,
          },
        ],
        new Set(),
        dispositions,
      ).missing,
    ).toHaveLength(1);
    expect(
      classifyHistoryMergeReceiptReferences(
        [{ ...reference, eventTimestamp: "2026-08-10T00:00:00.000Z" }],
        new Set(),
        dispositions,
      ).missing,
    ).toHaveLength(1);
    expect(
      classifyHistoryMergeReceiptReferences(
        [{ ...reference, eventTimestamp: "2026-08-10T00:00:00.000Z" }],
        new Set(),
        dispositions.map((disposition) => ({
          ...disposition,
          originalEventTimestamp: "2026-08-10T00:00:00.000Z",
        })),
      ).missing,
    ).toHaveLength(1);
    expect(
      extractHistoryMergeReceiptDispositions(
        {
          op: "update",
          context: {
            merge: {
              missing_receipt_dispositions: [
                {
                  receipt_id: "legacy-receipt",
                  original_history_line: 9,
                  original_event_ts: "2026-08-06T22:21:21.734Z",
                  reason: "legacy_clone_local_only",
                },
              ],
            },
          },
        },
        "pm-receipt",
        10,
      ),
    ).toEqual([]);
    expect(
      extractHistoryMergeReceiptDispositions(
        {
          op: "merge_reconcile",
          context: {
            merge: { missing_receipt_dispositions: [null] },
          },
        },
        "pm-receipt",
        10,
      ),
    ).toEqual([]);
  });
});
