import { describe, expect, it } from "vitest";
import { collectStaleVectorizationIds } from "../../../../src/core/search/staleness.js";

// pm-7ilo — `pm search ... --mode semantic|hybrid` emits a one-line stderr
// warning when the vectorization ledger lags behind item front-matter. The
// staleness helper drives both the existing health gate and the new
// query-time warning; this spec locks its contract.
describe("collectStaleVectorizationIds", () => {
  it("returns nothing when every item is mirrored in the ledger", () => {
    const items = [
      { id: "pm-a", updated_at: "2026-05-28T00:00:00Z" },
      { id: "pm-b", updated_at: "2026-05-28T00:00:01Z" },
    ];
    const ledger = {
      "pm-a": "2026-05-28T00:00:00Z",
      "pm-b": "2026-05-28T00:00:01Z",
    };
    expect(collectStaleVectorizationIds(items, ledger)).toEqual([]);
  });

  it("flags items whose front-matter updated_at no longer matches the ledger", () => {
    const items = [
      { id: "pm-a", updated_at: "2026-05-28T00:00:02Z" }, // changed
      { id: "pm-b", updated_at: "2026-05-28T00:00:01Z" }, // matches
    ];
    const ledger = {
      "pm-a": "2026-05-28T00:00:00Z",
      "pm-b": "2026-05-28T00:00:01Z",
    };
    expect(collectStaleVectorizationIds(items, ledger)).toEqual(["pm-a"]);
  });

  it("flags items missing from the ledger (never indexed yet)", () => {
    const items = [
      { id: "pm-a", updated_at: "2026-05-28T00:00:00Z" },
      { id: "pm-new", updated_at: "2026-05-28T00:00:05Z" },
    ];
    const ledger = {
      "pm-a": "2026-05-28T00:00:00Z",
    };
    expect(collectStaleVectorizationIds(items, ledger)).toEqual(["pm-new"]);
  });

  it("returns IDs sorted lexicographically for deterministic output", () => {
    const items = [
      { id: "pm-z", updated_at: "x" },
      { id: "pm-a", updated_at: "x" },
      { id: "pm-m", updated_at: "x" },
    ];
    expect(collectStaleVectorizationIds(items, {})).toEqual(["pm-a", "pm-m", "pm-z"]);
  });

  it("tolerates a null / undefined ledger by treating every item as stale", () => {
    // Defensive — a corrupted, empty, or partially-written ledger should not
    // crash semantic / hybrid search; it should just flag every item as stale.
    const items = [
      { id: "pm-a", updated_at: "x" },
      { id: "pm-b", updated_at: "y" },
    ];
    expect(collectStaleVectorizationIds(items, null)).toEqual(["pm-a", "pm-b"]);
    expect(collectStaleVectorizationIds(items, undefined)).toEqual(["pm-a", "pm-b"]);
  });
});
