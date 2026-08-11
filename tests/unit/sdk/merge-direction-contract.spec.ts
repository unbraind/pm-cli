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
  it("produces identical output when ours and theirs are swapped", () => {
    const forward = mergeItemDocuments(base, alpha, zeta, {
      format: "json",
      conflictResolution: "stable_value_order",
    });
    const reversed = mergeItemDocuments(base, zeta, alpha, {
      format: "json",
      conflictResolution: "stable_value_order",
    });

    expect(forward.merged).toBe(reversed.merged);
    expect(forward.conflict_fields).toContain("title");
    expect(forward.conflict_resolution).toBe("stable_value_order");
    expect(forward.requested_preference).toBe("ours");
    expect(forward).not.toHaveProperty("preferred");
    expect(forward.conflict_decisions).toContainEqual(
      expect.objectContaining({
        field: "title",
        ours: "alpha",
        theirs: "zeta",
        retained: "alpha",
        discarded: "zeta",
      }),
    );
    expect(JSON.parse(forward.merged).title).toBe("alpha");
  });
});
