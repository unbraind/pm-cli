/**
 * @module tests/unit/core/history/history-hash-version
 */
import jsonPatch from "fast-json-patch";
import { describe, expect, it } from "vitest";
import {
  CURRENT_HISTORY_ITEM_HASH_VERSION,
  createHistoryEntry,
  hashDocumentForVersion,
  type HistoryItemHashVersion,
} from "../../../../src/core/history/history.js";
import {
  EMPTY_REPLAY_DOCUMENT,
  reanchorHistoryEntries,
  toReplayDocument,
  verifyHistoryChainWithVersion,
} from "../../../../src/core/history/replay.js";
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
});
