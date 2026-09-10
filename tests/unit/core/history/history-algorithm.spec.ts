/** @module tests/unit/core/history/history-algorithm */
import { describe, expect, it } from "vitest";
import { createHistoryEntry, sealHistoryRecord } from "../../../../src/core/history/history.js";
import { reanchorHistoryEntries, verifyHistoryChain } from "../../../../src/core/history/replay.js";
import { verifyHistoryEntries } from "../../../../src/sdk/history-read.js";
import type { ItemDocument } from "../../../../src/types/index.js";

describe("named history digest algorithms", () => {
  it("writes and verifies mixed algorithms without changing earlier records", () => {
    const empty = { metadata: {}, body: "" } as ItemDocument;
    const first = { metadata: { id: "pm-algorithm", title: "Digest migration", description: "fixture", type: "Task", status: "open", priority: 2, tags: [] }, body: "first" } as ItemDocument;
    const second = { ...first, body: "second" };
    const genesis = createHistoryEntry({ nowIso: "2026-09-10T00:00:00.000Z", author: "fixture", op: "create", before: empty, after: first });
    const legacy = { ...genesis };
    delete legacy.hash_algorithm;
    delete legacy.record_hash;
    delete legacy.record_hash_version;
    const entry = createHistoryEntry({ nowIso: "2026-09-10T00:01:00.000Z", author: "fixture", op: "update", before: first, after: second, hashAlgorithm: "sha512" });
    expect(genesis.hash_algorithm).toBe("sha256");
    expect(entry.hash_algorithm).toBe("sha512");
    expect(entry.after_hash).toHaveLength(128);
    expect(entry.record_hash).toHaveLength(128);
    const history = [legacy, entry];
    const original = JSON.stringify(history);
    expect(verifyHistoryEntries(history, second)).toMatchObject({ ok: true, current_matches_latest: true });
    expect(reanchorHistoryEntries(history).entries).toEqual(history);
    expect(JSON.stringify(history)).toBe(original);
    expect(verifyHistoryChain([{ ...entry, hash_algorithm: "unknown" }]).ok).toBe(false);
    expect(() => sealHistoryRecord({ ...entry, hash_algorithm: "unknown" })).toThrow("unsupported_history_hash_algorithm");
  });
});
