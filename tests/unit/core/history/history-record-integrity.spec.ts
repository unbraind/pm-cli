/**
 * @module tests/unit/core/history/history-record-integrity
 *
 * Proves immutable history records cover their own attribution and retain the
 * evidence replaced by deterministic re-anchoring.
 */
import { describe, expect, it } from "vitest";
import {
  CURRENT_HISTORY_RECORD_HASH_VERSION,
  createHistoryEntry,
  hashHistoryPatch,
  resealHistoryRewrite,
  sealHistoryRecord,
  verifyHistoryRecordHash,
  verifyHistoryRewriteEvidence,
} from "../../../../src/core/history/history.js";
import {
  reanchorHistoryEntries,
  verifyHistoryChainWithVersion,
} from "../../../../src/core/history/replay.js";
import { EMPTY_CANONICAL_DOCUMENT } from "../../../../src/core/shared/constants.js";
import type {
  HistoryEntry,
  ItemDocument,
} from "../../../../src/types/index.js";

const created: ItemDocument = {
  metadata: {
    id: "pm-record-integrity",
    title: "Record integrity",
    description: "Protect immutable event metadata",
    type: "Task",
    status: "open",
    priority: 1,
    tags: ["history"],
    created_at: "2026-09-03T00:00:00.000Z",
    updated_at: "2026-09-03T00:00:00.000Z",
  },
  body: "",
};

function historyEntry(params: {
  at: string;
  before: ItemDocument;
  after: ItemDocument;
  author?: string;
}): HistoryEntry {
  return createHistoryEntry({
    nowIso: params.at,
    author: params.author ?? "harness:test",
    op: params.before.metadata.id ? "update" : "create",
    before: params.before,
    after: params.after,
  });
}

describe("history record integrity", () => {
  it("hashes immutable record metadata while explicitly accepting legacy records", () => {
    const entry = historyEntry({
      at: "2026-09-03T00:00:00.000Z",
      before: EMPTY_CANONICAL_DOCUMENT,
      after: created,
    });
    expect(entry.record_hash_version).toBe(CURRENT_HISTORY_RECORD_HASH_VERSION);
    expect(entry.record_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(verifyHistoryRecordHash(entry)).toEqual({
      ok: true,
      coverage: "record_and_item_state",
    });

    const tamperedAuthor = { ...entry, author: "fabricated-author" };
    expect(verifyHistoryChainWithVersion([tamperedAuthor])).toMatchObject({
      ok: false,
      errors: ["verify_failed:record_hash_mismatch:entry_1"],
    });

    const legacy = { ...entry };
    delete legacy.record_hash;
    delete legacy.record_hash_version;
    expect(verifyHistoryRecordHash(legacy)).toEqual({
      ok: true,
      coverage: "item_state_only",
    });
    expect(verifyHistoryChainWithVersion([legacy])).toMatchObject({ ok: true });

    expect(
      verifyHistoryRecordHash({ ...entry, record_hash: undefined }),
    ).toEqual({ ok: false, error: "unsupported_record_hash_version" });
    expect(
      verifyHistoryRecordHash({
        ...entry,
        record_hash_version: 99,
      } as HistoryEntry),
    ).toEqual({ ok: false, error: "unsupported_record_hash_version" });
  });

  it("retains prior anchors and refuses to bless attributed content tampering", () => {
    const first = historyEntry({
      at: "2026-09-03T00:00:00.000Z",
      before: EMPTY_CANONICAL_DOCUMENT,
      after: created,
    });
    const ours = structuredClone(created);
    ours.metadata.title = "Ours";
    ours.metadata.updated_at = "2026-09-03T00:01:00.000Z";
    const theirs = structuredClone(created);
    theirs.metadata.description = "Theirs";
    theirs.metadata.updated_at = "2026-09-03T00:02:00.000Z";
    const oursEntry = historyEntry({
      at: "2026-09-03T00:01:00.000Z",
      before: created,
      after: ours,
    });
    const theirsEntry = historyEntry({
      at: "2026-09-03T00:02:00.000Z",
      before: created,
      after: theirs,
    });

    const result = reanchorHistoryEntries([first, oursEntry, theirsEntry]);
    const rewritten = result.entries[2]!;
    expect(rewritten.reanchor_evidence).toEqual([
      expect.objectContaining({
        before_hash: theirsEntry.before_hash,
        after_hash: theirsEntry.after_hash,
        record_hash: theirsEntry.record_hash,
        record_hash_version: CURRENT_HISTORY_RECORD_HASH_VERSION,
      }),
    ]);
    expect(rewritten.record_hash).not.toBe(theirsEntry.record_hash);
    expect(verifyHistoryRewriteEvidence(rewritten)).toEqual({
      ok: true,
      coverage: "complete",
    });
    expect(verifyHistoryChainWithVersion(result.entries)).toMatchObject({
      ok: true,
    });

    const tamperedResealed = sealHistoryRecord({
      ...rewritten,
      author: "fabricated-after-rewrite",
    });
    expect(verifyHistoryRewriteEvidence(tamperedResealed)).toEqual({
      ok: false,
      error: "rewrite_evidence_record_hash_mismatch",
    });
    expect(
      verifyHistoryChainWithVersion([first, oursEntry, tamperedResealed]),
    ).toMatchObject({
      ok: false,
      errors: ["verify_failed:rewrite_evidence_record_hash_mismatch:entry_3"],
    });

    const patchEvidenceTampered = sealHistoryRecord({
      ...rewritten,
      reanchor_evidence: rewritten.reanchor_evidence?.map((evidence) => ({
        ...evidence,
        patch: [],
      })),
    });
    expect(hashHistoryPatch([])).not.toBe(
      patchEvidenceTampered.reanchor_evidence?.[0]?.patch_hash,
    );
    expect(verifyHistoryRewriteEvidence(patchEvidenceTampered)).toEqual({
      ok: false,
      error: "rewrite_evidence_patch_hash_mismatch",
    });

    expect(() =>
      resealHistoryRewrite(
        { ...theirsEntry, author: "fabricated-prior-record" },
        theirsEntry,
        { retainOriginalPatch: true, retainPriorRecord: true },
      ),
    ).toThrow("record_hash_mismatch");
    expect(() =>
      resealHistoryRewrite(theirsEntry, {
        ...theirsEntry,
        reanchor_evidence: [
          {
            before_hash: theirsEntry.before_hash,
            after_hash: theirsEntry.after_hash,
            patch_hash: "0".repeat(64),
            patch: [],
          },
        ],
      }),
    ).toThrow("rewrite_evidence_patch_hash_mismatch");

    expect(() =>
      reanchorHistoryEntries([
        first,
        oursEntry,
        { ...theirsEntry, author: "fabricated-author" },
      ]),
    ).toThrow("record_hash_mismatch:entry_3");
  });
});
