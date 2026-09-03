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
    ).toEqual({ ok: false, error: "incomplete_record_hash_envelope" });
    expect(
      verifyHistoryRecordHash({ ...entry, record_hash_version: undefined }),
    ).toEqual({ ok: false, error: "incomplete_record_hash_envelope" });
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
        record: theirsEntry,
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
      ok: true,
      coverage: "complete",
    });
    expect(
      verifyHistoryChainWithVersion([first, oursEntry, tamperedResealed]),
    ).toMatchObject({ ok: true });

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

    const malformedEvidence = sealHistoryRecord({
      ...theirsEntry,
      reanchor_evidence: [
        { before_hash: 42 },
      ] as unknown as HistoryEntry["reanchor_evidence"],
    });
    expect(verifyHistoryRewriteEvidence(malformedEvidence)).toEqual({
      ok: false,
      error: "rewrite_evidence_invalid",
    });

    const metadataRewrite = resealHistoryRewrite(
      theirsEntry,
      { ...theirsEntry, message: "maintenance changed metadata" },
      { retainPriorRecord: true },
    );
    expect(verifyHistoryRewriteEvidence(metadataRewrite)).toEqual({
      ok: true,
      coverage: "complete",
    });
    expect(metadataRewrite.reanchor_evidence?.[0]?.record).toEqual(theirsEntry);

    expect(() =>
      reanchorHistoryEntries([
        first,
        oursEntry,
        { ...theirsEntry, author: "fabricated-author" },
      ]),
    ).toThrow("record_hash_mismatch:entry_3");
  });

  it("fails closed on malformed, sparse, or contradictory rewrite evidence", () => {
    const original = historyEntry({
      at: "2026-09-03T00:00:00.000Z",
      before: EMPTY_CANONICAL_DOCUMENT,
      after: created,
    });
    const rewritten = resealHistoryRewrite(
      original,
      { ...original, before_hash: "reanchored" },
      { retainOriginalPatch: true, retainPriorRecord: true },
    );
    const evidence = rewritten.reanchor_evidence![0]!;
    const malformedEvidence: unknown[] = [
      null,
      { ...evidence, before_hash: 42 },
      { ...evidence, after_hash: 42 },
      { ...evidence, patch_hash: "not-a-digest" },
      { ...evidence, patch: "not-a-patch" },
      { ...evidence, patch: Array(1) },
      { ...evidence, patch: [null] },
      { ...evidence, patch: [{ op: "invalid", path: "/title" }] },
      { ...evidence, patch: [{ op: "add", path: 42 }] },
      { ...evidence, patch: [{ op: "move", path: "/title", from: 42 }] },
      { ...evidence, record_hash_version: "1" },
      { ...evidence, record_hash: 42 },
      { ...evidence, record_hash: "short" },
      { ...evidence, record: [] },
      { ...evidence, record: {} },
      { ...evidence, record: { ...original, ts: 42 } },
      { ...evidence, record: { ...original, author: 42 } },
      { ...evidence, record: { ...original, op: 42 } },
      { ...evidence, record: { ...original, before_hash: 42 } },
      { ...evidence, record: { ...original, after_hash: 42 } },
      { ...evidence, record: { ...original, patch: "invalid" } },
    ];
    for (const malformed of malformedEvidence) {
      expect(
        verifyHistoryRewriteEvidence(
          sealHistoryRecord({
            ...rewritten,
            reanchor_evidence: [malformed] as HistoryEntry["reanchor_evidence"],
          }),
        ),
      ).toEqual({ ok: false, error: "rewrite_evidence_invalid" });
    }

    expect(
      verifyHistoryRewriteEvidence({
        ...rewritten,
        reanchor_evidence: {} as HistoryEntry["reanchor_evidence"],
      }),
    ).toEqual({ ok: false, error: "rewrite_evidence_invalid" });
    expect(
      verifyHistoryChainWithVersion([
        sealHistoryRecord({
          ...rewritten,
          reanchor_evidence: {} as HistoryEntry["reanchor_evidence"],
        }),
      ]),
    ).toMatchObject({
      ok: false,
      errors: ["verify_failed:rewrite_evidence_invalid:entry_1"],
    });
    expect(
      verifyHistoryRewriteEvidence({ ...rewritten, reanchor_evidence: [] }),
    ).toEqual({ ok: true, coverage: "none" });
    const sparseEvidence = Array(1) as HistoryEntry["reanchor_evidence"];
    expect(
      verifyHistoryRewriteEvidence({
        ...rewritten,
        reanchor_evidence: sparseEvidence,
      }),
    ).toEqual({ ok: false, error: "rewrite_evidence_invalid" });

    const contradictory = structuredClone(evidence);
    contradictory.record!.before_hash = "contradiction";
    expect(
      verifyHistoryRewriteEvidence(
        sealHistoryRecord({ ...rewritten, reanchor_evidence: [contradictory] }),
      ),
    ).toEqual({
      ok: false,
      error: "rewrite_evidence_record_hash_mismatch",
    });

    const invalidPriorHash = structuredClone(evidence);
    invalidPriorHash.record!.record_hash = "0".repeat(64);
    invalidPriorHash.record_hash = "0".repeat(64);
    expect(
      verifyHistoryRewriteEvidence(
        sealHistoryRecord({
          ...rewritten,
          reanchor_evidence: [invalidPriorHash],
        }),
      ),
    ).toEqual({
      ok: false,
      error: "rewrite_evidence_record_hash_mismatch",
    });

    const exactWithoutEmbeddedRecord = structuredClone(evidence);
    delete exactWithoutEmbeddedRecord.record;
    expect(
      verifyHistoryRewriteEvidence(
        sealHistoryRecord({
          ...rewritten,
          reanchor_evidence: [exactWithoutEmbeddedRecord],
        }),
      ),
    ).toEqual({ ok: true, coverage: "complete" });
    expect(
      verifyHistoryRewriteEvidence(
        sealHistoryRecord({
          ...original,
          reanchor_evidence: [
            {
              before_hash: original.before_hash,
              after_hash: original.after_hash,
              patch_hash: hashHistoryPatch(original.patch),
              patch: original.patch,
            },
          ],
        }),
      ),
    ).toEqual({ ok: true, coverage: "legacy_anchor_only" });
    expect(
      verifyHistoryRewriteEvidence(
        sealHistoryRecord({
          ...original,
          reanchor_evidence: [
            {
              before_hash: original.before_hash,
              after_hash: original.after_hash,
              patch_hash: "0".repeat(64),
            },
          ],
        }),
      ),
    ).toEqual({ ok: true, coverage: "digest_only" });
  });
});
