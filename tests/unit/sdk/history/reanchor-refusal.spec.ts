/** A record re-anchoring cannot keep refuses typed; every other failure passes through (pm-3os5p6). */
import { describe, expect, it } from "vitest";
import { reanchorOrRefuse } from "../../../../src/sdk/history/reanchor-refusal.js";

describe("reanchorOrRefuse", () => {
  it("returns the re-anchored value", () => {
    expect(reanchorOrRefuse("pm-a", () => 7)).toBe(7);
  });

  it("types each record integrity failure with its entry and recovery", () => {
    for (const reason of ["record_hash_mismatch", "incomplete_record_hash_envelope", "rewrite_evidence_patch_hash_mismatch"]) {
      expect(() =>
        reanchorOrRefuse("pm-a", () => {
          throw new TypeError(`${reason}:entry_3`);
        }),
      ).toThrow(expect.objectContaining({
        code: "history_record_integrity_invalid",
        exitCode: 4,
        context: expect.objectContaining({ item_id: "pm-a", reason, details: { entry: 3 } }),
      }));
    }
  });

  it("rethrows failures that are not record integrity refusals", () => {
    const skew = new TypeError("unsupported_item_hash_version:99:entry_1");
    expect(() => reanchorOrRefuse("pm-a", () => { throw skew; })).toThrow(skew);
    const other = new RangeError("record_hash_mismatch:entry_1");
    expect(() => reanchorOrRefuse("pm-a", () => { throw other; })).toThrow(other);
  });
});
