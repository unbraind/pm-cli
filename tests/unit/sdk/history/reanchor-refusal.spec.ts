/** A record re-anchoring cannot keep refuses typed; every other failure passes through (pm-3os5p6). */
import { describe, expect, it } from "vitest";
import { reanchorOrRefuse } from "../../../../src/sdk/history/reanchor-refusal.js";
import type { HistoryEntry } from "../../../../src/types/index.js";

describe("reanchorOrRefuse", () => {
  it("returns the re-anchored value", () => {
    expect(reanchorOrRefuse("pm-a", [], () => 7)).toBe(7);
  });

  it("types each record integrity failure with its entry and recovery", () => {
    for (const reason of ["record_hash_mismatch", "incomplete_record_hash_envelope", "rewrite_evidence_patch_hash_mismatch"]) {
      expect(() =>
        reanchorOrRefuse("pm-a", [], () => {
          throw new TypeError(`${reason}:entry_3`);
        }),
      ).toThrow(expect.objectContaining({
        code: "history_record_integrity_invalid",
        exitCode: 4,
        context: expect.objectContaining({ item_id: "pm-a", reason, details: { entry: 3 } }),
      }));
    }
  });

  it("reports only a complete newer record seal as an upgrade, and any other unreadable seal as damage", () => {
    const refuse = (record: Partial<HistoryEntry>) => () =>
      reanchorOrRefuse("pm-a", [{} as HistoryEntry, record as HistoryEntry], () => {
        throw new TypeError("unsupported_record_hash_version:entry_2");
      });
    expect(refuse({ record_hash_version: 2 as never, record_hash: "f".repeat(64) })).toThrow(expect.objectContaining({
      code: "history_record_version_unsupported",
      context: expect.objectContaining({ details: { entry: 2 }, nextSteps: [expect.stringContaining("npm install -g @unbrained/pm-cli@latest")] }),
    }));
    for (const damaged of [
      { record_hash_version: "1" as never, record_hash: "f".repeat(64) },
      { record_hash_version: 2 as never, record_hash: "" },
      { record_hash_version: 2.5 as never, record_hash: "f".repeat(64) },
      { record_hash_version: 1 as never, record_hash: "f".repeat(64) },
    ]) {
      expect(refuse(damaged)).toThrow(expect.objectContaining({
        code: "history_record_integrity_invalid",
        context: expect.objectContaining({ reason: "unsupported_record_hash_version" }),
      }));
    }
    // An entry ordinal outside the stream is still damage, never an upgrade.
    expect(() =>
      reanchorOrRefuse("pm-a", [], () => {
        throw new TypeError("unsupported_record_hash_version:entry_9");
      }),
    ).toThrow(expect.objectContaining({ code: "history_record_integrity_invalid" }));
  });

  it("rethrows failures that are not record integrity refusals", () => {
    const skew = new TypeError("unsupported_item_hash_version:99:entry_1");
    expect(() => reanchorOrRefuse("pm-a", [], () => { throw skew; })).toThrow(skew);
    const other = new RangeError("record_hash_mismatch:entry_1");
    expect(() => reanchorOrRefuse("pm-a", [], () => { throw other; })).toThrow(other);
  });
});
