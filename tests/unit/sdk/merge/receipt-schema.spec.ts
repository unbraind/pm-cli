import { describe, expect, it } from "vitest";
import {
  normalizeLegacyReceipt,
  receiptCollectionValidationPath,
  receiptValidationError,
} from "../../../../src/sdk/merge/receipt-schema.js";

const receipt = {
  version: 1,
  id: "schema-check",
  item_id: "pm-schema",
  item_path: ".agents/pm/tasks/pm-schema.toon",
  preferred: "ours",
  fields_from_theirs: [],
  union_fields: [],
  decisions: [],
  state: "pending",
  created_at: "2026-09-06T00:00:00Z",
};

describe("receipt schema recovery boundaries", () => {
  it("locates invalid collections without returning rejected values", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ fields_from_theirs: null }, "fields_from_theirs"],
      [{ union_fields: null }, "union_fields"],
      [{ decisions: null }, "decisions"],
      [{ decisions: Array.from({ length: 2049 }, () => null) }, "decisions"],
      [{ decisions: [null] }, "decisions[0]"],
      [
        { merged_field_hashes: { private_field: "not-a-hash" } },
        "merged_field_hashes",
      ],
    ];
    for (const [override, coordinate] of cases) {
      const invalid = { ...receipt, ...override };
      expect(receiptValidationError(invalid, "clone_local")).toBe(
        "collections",
      );
      expect(receiptCollectionValidationPath(invalid)).toBe(coordinate);
    }
    expect(receiptCollectionValidationPath(null)).toBeUndefined();
  });

  it("never reconstructs missing retained or discarded evidence", () => {
    for (const decision of [
      null,
      { field: "status", retained: "open" },
      { field: "status", discarded: "closed" },
    ]) {
      const raw = { ...receipt, decisions: [decision] };
      expect(normalizeLegacyReceipt(raw)).toEqual(raw);
      expect(
        receiptValidationError(normalizeLegacyReceipt(raw), "clone_local"),
      ).toBe("collections");
    }
  });

  it("refuses malformed operation identities and inconsistent settlement lifecycle", () => {
    const operation = {
      kind: "rebase",
      original_head: "a".repeat(40),
      original_blob: "b".repeat(40),
    };
    for (const override of [
      { operation: null },
      { operation: { ...operation, kind: "merge" } },
      { operation, settlement: "original_git_state_restored" },
      { state: "reconciled", settlement: "original_git_state_restored" },
      { operation, state: "reconciled", settlement: "unknown" },
    ]) {
      expect(
        receiptValidationError({ ...receipt, ...override }, "clone_local"),
      ).toBe("operation");
    }
    expect(
      receiptValidationError(
        {
          ...receipt,
          operation,
          state: "reconciled",
          settlement: "original_git_state_restored",
        },
        "clone_local",
      ),
    ).toBeNull();
  });
});
