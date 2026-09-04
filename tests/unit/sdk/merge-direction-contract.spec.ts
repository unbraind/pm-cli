/**
 * @module tests/unit/sdk/merge-direction-contract
 *
 * Protects the direction-independent scalar contract used by the Git item
 * merge driver so branch checkout order cannot change the merged document.
 */
import { describe, expect, it } from "vitest";
import {
  ITEM_SCALAR_MISSING_VALUE,
  hashItemScalarDecisionValue,
  isItemScalarMissingValue,
  mergeItemDocuments,
} from "../../../src/sdk/merge/three-way.js";

const base = JSON.stringify({
  id: "pm-direction",
  title: "base",
  description: "direction contract",
  type: "Task",
  status: "open",
  priority: 2,
  tags: [],
  created_at: "2026-08-08T00:00:00.000Z",
  updated_at: "2026-08-08T00:00:00.000Z",
});

const alpha = JSON.stringify({
  id: "pm-direction",
  title: "alpha",
  description: "direction contract",
  type: "Task",
  status: "open",
  priority: 2,
  tags: [],
  created_at: "2026-08-08T00:00:00.000Z",
  updated_at: "2026-08-08T01:00:00.000Z",
});

const zeta = JSON.stringify({
  id: "pm-direction",
  title: "zeta",
  description: "direction contract",
  type: "Task",
  status: "open",
  priority: 2,
  tags: [],
  created_at: "2026-08-08T00:00:00.000Z",
  updated_at: "2026-08-08T02:00:00.000Z",
});

describe("item merge direction contract", () => {
  it("produces identical latest-write output when ours and theirs are swapped", () => {
    const forward = mergeItemDocuments(base, alpha, zeta, {
      format: "json",
      conflictResolution: "latest_document_update",
    });
    const reversed = mergeItemDocuments(base, zeta, alpha, {
      format: "json",
      conflictResolution: "latest_document_update",
    });

    expect(forward.merged).toBe(reversed.merged);
    expect(forward.conflict_fields).toContain("title");
    expect(forward.conflict_resolution).toBe("latest_document_update");
    expect(forward.requested_preference).toBe("ours");
    expect(forward.requested_preference_applied).toBe(false);
    expect(forward).not.toHaveProperty("preferred");
    expect(forward.conflict_decisions).toContainEqual(
      expect.objectContaining({
        field: "title",
        ours: "alpha",
        theirs: "zeta",
        retained: "zeta",
        discarded: "alpha",
        retained_side: "theirs",
        resolution_basis: "document_updated_at",
      }),
    );
    expect(JSON.parse(forward.merged).title).toBe("zeta");
  });

  it("uses stable value order only as the equal-timestamp convergence tie-break", () => {
    const equalAlpha = JSON.stringify({
      ...JSON.parse(alpha),
      updated_at: "2026-08-08T03:00:00.000Z",
    });
    const equalZeta = JSON.stringify({
      ...JSON.parse(zeta),
      updated_at: "2026-08-08T03:00:00.000Z",
    });
    const forward = mergeItemDocuments(base, equalAlpha, equalZeta, {
      format: "json",
      conflictResolution: "latest_document_update",
      preferred: "theirs",
    });
    const reversed = mergeItemDocuments(base, equalZeta, equalAlpha, {
      format: "json",
      conflictResolution: "latest_document_update",
      preferred: "ours",
    });

    expect(forward.merged).toBe(reversed.merged);
    expect(JSON.parse(forward.merged).title).toBe("alpha");
    expect(forward.conflict_decisions).toContainEqual(
      expect.objectContaining({
        field: "title",
        retained: "alpha",
        resolution_basis: "stable_value_tiebreak",
      }),
    );
  });

  it("preserves a later scalar deletion as distinct JSON-stable evidence", () => {
    const deletionBase = { ...JSON.parse(base), assignee: "base-agent" };
    const deleted = JSON.stringify({
      ...deletionBase,
      assignee: undefined,
      updated_at: "2026-08-08T03:00:00.000Z",
    });
    const edited = JSON.stringify({
      ...deletionBase,
      assignee: "older-agent",
      updated_at: "2026-08-08T02:00:00.000Z",
    });

    const result = mergeItemDocuments(
      JSON.stringify(deletionBase),
      deleted,
      edited,
      {
        format: "json",
        conflictResolution: "latest_document_update",
      },
    );

    expect(JSON.parse(result.merged)).not.toHaveProperty("assignee");
    expect(result.conflict_decisions).toContainEqual(
      expect.objectContaining({
        field: "assignee",
        retained: ITEM_SCALAR_MISSING_VALUE,
        discarded: "older-agent",
        retained_side: "ours",
      }),
    );
    expect(
      JSON.parse(JSON.stringify(result.conflict_decisions[0])),
    ).toHaveProperty("retained");
    expect(hashItemScalarDecisionValue(undefined)).not.toBe(
      hashItemScalarDecisionValue("undefined"),
    );
    expect(hashItemScalarDecisionValue(undefined)).not.toBe(
      hashItemScalarDecisionValue(ITEM_SCALAR_MISSING_VALUE),
    );
  });

  it("keeps null distinct from a newer deletion during scalar comparison", () => {
    const nullableBase = { ...JSON.parse(base), extension_value: null };
    const deleted: Record<string, unknown> = {
      ...nullableBase,
      updated_at: "2026-08-08T03:00:00.000Z",
    };
    delete deleted.extension_value;
    const edited = {
      ...nullableBase,
      extension_value: "older-value",
      updated_at: "2026-08-08T02:00:00.000Z",
    };

    const result = mergeItemDocuments(
      JSON.stringify(nullableBase),
      JSON.stringify(deleted),
      JSON.stringify(edited),
      { format: "json", conflictResolution: "latest_document_update" },
    );

    expect(JSON.parse(result.merged)).not.toHaveProperty("extension_value");
    expect(result.conflict_fields).toContain("extension_value");
    expect(result.conflict_decisions).toContainEqual(
      expect.objectContaining({
        field: "extension_value",
        base: null,
        retained: ITEM_SCALAR_MISSING_VALUE,
        discarded: "older-value",
        retained_side: "ours",
        resolution_basis: "document_updated_at",
      }),
    );
  });

  it("recognizes only the exact missing-scalar evidence marker", () => {
    expect(isItemScalarMissingValue(ITEM_SCALAR_MISSING_VALUE)).toBe(true);
    expect(isItemScalarMissingValue(undefined)).toBe(false);
    expect(isItemScalarMissingValue(null)).toBe(false);
    expect(isItemScalarMissingValue([])).toBe(false);
    expect(
      isItemScalarMissingValue({
        pm_item_scalar_missing: true,
        unexpected: true,
      }),
    ).toBe(false);
    expect(isItemScalarMissingValue({ pm_item_scalar_missing: false })).toBe(
      false,
    );
  });

  it("rejects a present metadata value that collides with the reserved marker", () => {
    const reserved = JSON.stringify({
      ...JSON.parse(alpha),
      extension_value: ITEM_SCALAR_MISSING_VALUE,
    });

    expect(() =>
      mergeItemDocuments(base, reserved, zeta, {
        format: "json",
        conflictResolution: "latest_document_update",
      }),
    ).toThrow(/reserved missing-scalar evidence marker/u);
  });
});
