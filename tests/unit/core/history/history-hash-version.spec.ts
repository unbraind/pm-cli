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
import type { HistoryEntry, ItemDocument } from "../../../../src/types/index.js";

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
  hashVersion: 1 | 2,
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
    expect(
      createHistoryEntry({
        nowIso: "2026-08-11T00:01:00.000Z",
        author: "fixture",
        op: "tests_add",
        before: sortedOrder,
        after: insertionOrder,
      }).item_hash_version,
    ).toBe(CURRENT_HISTORY_ITEM_HASH_VERSION);
  });

  it("auto-detects unversioned legacy streams and rejects unknown epochs precisely", () => {
    const insertionOrder = document([first, second]);
    expect(() =>
      hashDocumentForVersion(insertionOrder, 3 as HistoryItemHashVersion),
    ).toThrow("unsupported_item_hash_version:3");
    expect(verifyHistoryChainWithVersion([unversionedEntry(insertionOrder, 1)])).toMatchObject({
      ok: true,
      item_hash_version: 1,
    });
    expect(verifyHistoryChainWithVersion([unversionedEntry(insertionOrder, 2)])).toMatchObject({
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
});
