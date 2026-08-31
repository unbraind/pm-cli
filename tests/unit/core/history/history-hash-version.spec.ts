/**
 * @module tests/unit/core/history/history-hash-version
 */
import jsonPatch from "fast-json-patch";
import { describe, expect, it } from "vitest";
import {
  CURRENT_HISTORY_ITEM_HASH_VERSION,
  createHistoryEntry,
  hashDocumentForVersion,
  hashDocumentVerificationCandidates,
  type HistoryItemHashVersion,
} from "../../../../src/core/history/history.js";
import {
  EMPTY_REPLAY_DOCUMENT,
  reanchorHistoryEntries,
  toReplayDocument,
  verifyHistoryChainWithVersion,
} from "../../../../src/core/history/replay.js";
import { verifyHistoryEntries } from "../../../../src/sdk/history-read.js";
import type {
  HistoryEntry,
  ItemDocument,
} from "../../../../src/types/index.js";

function document(tests: ItemDocument["metadata"]["tests"]): ItemDocument {
  return {
    metadata: {
      id: "pm-hash-version",
      title: "Hash version",
      description: "Cross-version history fixture",
      type: "Task",
      status: "open",
      priority: 1,
      tags: ["history"],
      created_at: "2026-08-11T00:00:00.000Z",
      updated_at: "2026-08-11T00:00:00.000Z",
      tests,
    },
    body: "",
  };
}

function unversionedEntry(
  after: ItemDocument,
  hashVersion: HistoryItemHashVersion,
): HistoryEntry {
  const beforeReplay = structuredClone(EMPTY_REPLAY_DOCUMENT);
  const afterReplay = toReplayDocument(after);
  return {
    ts: "2026-08-11T00:00:00.000Z",
    author: "fixture",
    op: "create",
    patch: jsonPatch.compare(beforeReplay, afterReplay),
    before_hash: hashDocumentForVersion(
      { metadata: {}, body: "" } as ItemDocument,
      hashVersion,
    ),
    after_hash: hashDocumentForVersion(after, hashVersion),
  };
}

describe("history item hash versions", () => {
  const first = { command: "z-last", scope: "project" } as const;
  const second = { command: "a-first", scope: "project" } as const;

  it("keeps legacy sorted hashes available while versioning order-sensitive hashes", () => {
    const insertionOrder = document([first, second]);
    const sortedOrder = document([second, first]);

    expect(hashDocumentForVersion(insertionOrder, 1)).toBe(
      hashDocumentForVersion(sortedOrder, 1),
    );
    expect(hashDocumentForVersion(document([first, first]), 1)).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(hashDocumentForVersion(insertionOrder, 2)).not.toBe(
      hashDocumentForVersion(sortedOrder, 2),
    );
    expect(hashDocumentForVersion(insertionOrder, 3)).toBe(
      hashDocumentForVersion(insertionOrder, 2),
    );
    const currentEntry = createHistoryEntry({
      nowIso: "2026-08-11T00:01:00.000Z",
      author: "fixture",
      op: "tests_add",
      before: sortedOrder,
      after: insertionOrder,
    });
    expect(currentEntry.item_hash_version).toBe(
      CURRENT_HISTORY_ITEM_HASH_VERSION,
    );
  });

  it("verifies both immutable field surfaces written under epoch 2", () => {
    const preProvenance = document([first]);
    const withProvenance = document([
      {
        ...first,
        workspace_context_mode: "source",
        provenance: {
          author: "fixture",
          created_at: "2026-08-21T00:00:00.000Z",
          source_kind: "local_mutation",
          source_ref: "fixture/v2-writer",
        },
      },
    ]);

    expect(hashDocumentForVersion(withProvenance, 2)).not.toBe(
      hashDocumentForVersion(preProvenance, 2),
    );
    const [expandedHash, legacyHash] =
      hashDocumentVerificationCandidates(withProvenance, 2);
    expect(expandedHash).toBe(hashDocumentForVersion(withProvenance, 2));
    expect(legacyHash).toBe(hashDocumentForVersion(preProvenance, 2));
    expect(hashDocumentVerificationCandidates(preProvenance, 2)).toEqual([
      hashDocumentForVersion(preProvenance, 2),
      hashDocumentForVersion(preProvenance, 2),
    ]);

    const legacyEntry: HistoryEntry = {
      ...unversionedEntry(withProvenance, 2),
      after_hash: legacyHash,
      item_hash_version: 2,
    };
    expect(verifyHistoryChainWithVersion([legacyEntry])).toMatchObject({
      ok: true,
      item_hash_version: 2,
    });
    expect(verifyHistoryEntries([legacyEntry], withProvenance)).toMatchObject({
      ok: true,
      current_matches_latest: true,
      current_item_hash: legacyEntry.after_hash,
    });
    expect(reanchorHistoryEntries([legacyEntry])).toMatchObject({
      entries: [legacyEntry],
      entriesRehashed: 0,
      itemHashVersion: 2,
    });

    const expandedEntry: HistoryEntry = {
      ...unversionedEntry(withProvenance, 2),
      item_hash_version: 2,
    };
    expect(verifyHistoryEntries([expandedEntry], withProvenance)).toMatchObject({
      ok: true,
      current_matches_latest: true,
      current_item_hash: expandedEntry.after_hash,
    });
  });

  it("keeps one epoch-2 semantic variant across a field-introducing patch", () => {
    const preProvenance = document([first]);
    const withProvenance = document([
      {
        ...first,
        workspace_context_mode: "source",
        provenance: {
          author: "fixture",
          created_at: "2026-08-21T00:00:00.000Z",
          source_kind: "local_mutation",
          source_ref: "fixture/v2-writer",
        },
      },
    ]);
    const firstEntry = {
      ...unversionedEntry(preProvenance, 2),
      item_hash_version: 2 as const,
    };
    const secondEntry: HistoryEntry = {
      ts: "2026-08-21T00:01:00.000Z",
      author: "fixture",
      op: "tests_update",
      patch: jsonPatch.compare(
        toReplayDocument(preProvenance),
        toReplayDocument(withProvenance),
      ),
      before_hash: hashDocumentForVersion(preProvenance, 2),
      after_hash: hashDocumentForVersion(withProvenance, 2),
      item_hash_version: 2,
    };

    expect(
      verifyHistoryChainWithVersion([firstEntry, secondEntry]),
    ).toMatchObject({ ok: true, item_hash_version: 2 });

    const legacyTransitionEntry = {
      ...secondEntry,
      after_hash: hashDocumentVerificationCandidates(withProvenance, 2)[1],
    };
    expect(
      verifyHistoryChainWithVersion([firstEntry, legacyTransitionEntry]),
    ).toMatchObject({
      ok: true,
      item_hash_version: 2,
    });

    const afterBodyUpdate = structuredClone(withProvenance);
    afterBodyUpdate.body = "semantic variants cannot cross";
    const crossedVariantEntry: HistoryEntry = {
      ts: "2026-08-21T00:02:00.000Z",
      author: "fixture",
      op: "update",
      patch: jsonPatch.compare(
        toReplayDocument(withProvenance),
        toReplayDocument(afterBodyUpdate),
      ),
      before_hash: hashDocumentForVersion(withProvenance, 2),
      after_hash: hashDocumentVerificationCandidates(afterBodyUpdate, 2)[1],
      item_hash_version: 2,
    };
    const expandedSetupEntry = {
      ...unversionedEntry(withProvenance, 2),
      item_hash_version: 2 as const,
    };
    expect(
      verifyHistoryChainWithVersion([expandedSetupEntry, crossedVariantEntry]),
    ).toMatchObject({
      ok: false,
      errors: ["verify_failed:after_hash_mismatch:entry_2"],
    });
  });

  it("retains both earlier and later epoch-2 metadata field surfaces", () => {
    const epochTwo = document([first]);
    epochTwo.metadata.dependencies = [
      {
        id: "PM-MIXED-CASE",
        kind: "related",
        created_at: "2026-08-21T00:00:00.000Z",
      },
    ];
    epochTwo.metadata.test_runs = [
      {
        run_id: "run-1",
        kind: "test",
        status: "passed",
        started_at: "2026-08-21T00:00:00.000Z",
        finished_at: "2026-08-21T00:00:01.000Z",
        recorded_at: "2026-08-21T00:00:01.000Z",
        passed: 1,
        failed: 0,
        skipped: 0,
      },
    ];
    const current = structuredClone(epochTwo);
    current.metadata.dependencies![0]!.id = "pm-mixed-case";
    current.metadata.tests![0] = {
      ...current.metadata.tests![0]!,
      provenance_invalid: true,
    };
    current.metadata.test_runs![0]!.executions = [
      {
        command: "z-last",
        workspace_context_mode: "snapshot",
        trust_reason: "local_mutation",
      },
    ];

    expect(hashDocumentForVersion(current, 2)).not.toBe(
      hashDocumentForVersion(epochTwo, 2),
    );
    expect(hashDocumentVerificationCandidates(current, 2)[1]).toBe(
      hashDocumentVerificationCandidates(epochTwo, 2)[1],
    );
    expect(hashDocumentForVersion(current, 3)).not.toBe(
      hashDocumentForVersion(epochTwo, 3),
    );
  });

  it("auto-detects unversioned legacy streams and rejects unknown epochs precisely", () => {
    const insertionOrder = document([first, second]);
    expect(() =>
      hashDocumentForVersion(insertionOrder, 4 as HistoryItemHashVersion),
    ).toThrow("unsupported_item_hash_version:4");
    expect(
      verifyHistoryChainWithVersion([unversionedEntry(insertionOrder, 1)]),
    ).toMatchObject({
      ok: true,
      item_hash_version: 1,
    });
    expect(
      verifyHistoryChainWithVersion([unversionedEntry(insertionOrder, 2)]),
    ).toMatchObject({
      ok: true,
      item_hash_version: 2,
    });
    expect(
      verifyHistoryChainWithVersion([
        { ...unversionedEntry(insertionOrder, 2), item_hash_version: 99 },
      ]),
    ).toEqual({
      ok: false,
      errors: ["verify_failed:unsupported_item_hash_version:99:entry_1"],
    });
    expect(() =>
      reanchorHistoryEntries([
        { ...unversionedEntry(insertionOrder, 2), item_hash_version: 99 },
      ]),
    ).toThrow("unsupported_item_hash_version:99:entry_1");
  });

  it("treats an unversioned stream whose hashes match every epoch as legacy", () => {
    const orderInsensitive = document([]);
    const entry = unversionedEntry(orderInsensitive, 1);
    expect(entry.before_hash).toBe(
      unversionedEntry(orderInsensitive, 2).before_hash,
    );
    expect(entry.after_hash).toBe(
      unversionedEntry(orderInsensitive, 2).after_hash,
    );

    expect(verifyHistoryChainWithVersion([entry])).toMatchObject({
      ok: true,
      item_hash_version: 1,
    });
    expect(reanchorHistoryEntries([entry])).toMatchObject({
      itemHashVersion: 1,
      explicitItemHashVersion: false,
      entries: [entry],
    });
  });

  it("keeps an explicit epoch authoritative over a trailing ambiguous entry", () => {
    const firstDocument = document([]);
    const secondDocument = structuredClone(firstDocument);
    secondDocument.body = "second event";
    const firstEntry = {
      ...unversionedEntry(firstDocument, 2),
      item_hash_version: 2 as const,
    };
    const secondEntry: HistoryEntry = {
      ts: "2026-08-11T00:01:00.000Z",
      author: "fixture",
      op: "update",
      patch: jsonPatch.compare(
        toReplayDocument(firstDocument),
        toReplayDocument(secondDocument),
      ),
      before_hash: hashDocumentForVersion(firstDocument, 2),
      after_hash: hashDocumentForVersion(secondDocument, 2),
    };
    expect(secondEntry.before_hash).toBe(
      hashDocumentForVersion(firstDocument, 1),
    );
    expect(secondEntry.after_hash).toBe(
      hashDocumentForVersion(secondDocument, 1),
    );

    expect(
      verifyHistoryChainWithVersion([firstEntry, secondEntry]),
    ).toMatchObject({ ok: true, item_hash_version: 2 });
    expect(reanchorHistoryEntries([firstEntry, secondEntry])).toMatchObject({
      itemHashVersion: 2,
      entriesRehashed: 0,
    });
  });

  it("applies an explicit epoch only from its marker forward", () => {
    const legacyDocument = document([first, second]);
    const currentDocument = structuredClone(legacyDocument);
    currentDocument.body = "explicit epoch transition";
    const legacyEntry = unversionedEntry(legacyDocument, 1);
    const currentEntry: HistoryEntry = {
      ts: "2026-08-11T00:01:00.000Z",
      author: "fixture",
      op: "update",
      patch: jsonPatch.compare(
        toReplayDocument(legacyDocument),
        toReplayDocument(currentDocument),
      ),
      before_hash: hashDocumentForVersion(legacyDocument, 2),
      after_hash: hashDocumentForVersion(currentDocument, 2),
      item_hash_version: 2,
    };
    expect(legacyEntry.after_hash).not.toBe(
      hashDocumentForVersion(legacyDocument, 2),
    );

    expect(
      verifyHistoryChainWithVersion([legacyEntry, currentEntry]),
    ).toMatchObject({ ok: true, item_hash_version: 2 });
  });

  it("reports supported corruption after an unsupported writer entry", () => {
    const futureDocument = document([]);
    const supportedDocument = structuredClone(futureDocument);
    supportedDocument.body = "supported entry after future writer";
    const futureEntry = {
      ...unversionedEntry(futureDocument, 2),
      item_hash_version: 99 as HistoryItemHashVersion,
    };
    const corruptedSupportedEntry: HistoryEntry = {
      ts: "2026-08-11T00:01:00.000Z",
      author: "fixture",
      op: "update",
      patch: jsonPatch.compare(
        toReplayDocument(futureDocument),
        toReplayDocument(supportedDocument),
      ),
      before_hash: hashDocumentForVersion(
        futureDocument,
        CURRENT_HISTORY_ITEM_HASH_VERSION,
      ),
      after_hash: "0".repeat(64),
      item_hash_version: CURRENT_HISTORY_ITEM_HASH_VERSION,
    };

    expect(
      verifyHistoryChainWithVersion([futureEntry, corruptedSupportedEntry]),
    ).toEqual({
      ok: false,
      errors: [
        "verify_failed:unsupported_item_hash_version:99:entry_1",
        "verify_failed:after_hash_mismatch:entry_2",
      ],
    });
    expect(
      verifyHistoryChainWithVersion([
        {
          ...futureEntry,
          patch: [{ op: "remove" as const, path: "/missing" }],
        },
      ]),
    ).toEqual({
      ok: false,
      errors: [
        "verify_failed:unsupported_item_hash_version:99:entry_1",
        "verify_failed:patch_apply_failed:entry_1",
      ],
    });
  });
});
