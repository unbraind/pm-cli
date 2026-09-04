/**
 * @module tests/unit/sdk/merge-direction-contract
 *
 * Protects the direction-independent scalar contract used by the Git item
 * merge driver so branch checkout order cannot change the merged document.
 */
import { describe, expect, it } from "vitest";
import { mergeItemDocuments } from "../../../src/sdk/merge/three-way.js";

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
});
