import jsonPatch from "fast-json-patch";
import { describe, expect, it } from "vitest";
import {
  cloneEmptyReplayDocument,
  reanchorHistoryEntries,
  replayHash,
  resolveHistoryRepairItemHashVersion,
  verifyHistoryChainWithVersion,
  type ReplayDocument,
} from "../../../src/core/history/replay.js";
import type { HistoryEntry, HistoryPatchOp } from "../../../src/types.js";

function historyEntry(
  version: 1 | 2,
  explicitVersion: boolean,
): HistoryEntry {
  const before = cloneEmptyReplayDocument();
  const after: ReplayDocument = {
    metadata: {
      id: "pm-epoch",
      title: "Stable repair epoch",
      type: "Task",
      status: "open",
      priority: 1,
      tags: [],
      tests: [
        { command: "z-command", scope: "project" },
        { command: "a-command", scope: "project" },
      ],
    },
    body: "",
  };
  return {
    ts: "2026-08-15T00:00:00.000Z",
    author: "epoch-test",
    op: "create",
    patch: jsonPatch.compare(before, after) as HistoryPatchOp[],
    before_hash: replayHash(before, version),
    after_hash: replayHash(after, version),
    ...(explicitVersion ? { item_hash_version: version } : {}),
  };
}

describe("history repair hash epoch contract", () => {
  it("keeps an implicit legacy stream byte-stable", () => {
    const entries = [historyEntry(1, false)];
    expect(resolveHistoryRepairItemHashVersion(entries)).toBe(1);
    const repaired = reanchorHistoryEntries(entries);
    expect(repaired.entries).toEqual(entries);
    expect(repaired.entriesRehashed).toBe(0);
    expect(repaired.explicitItemHashVersion).toBe(false);
    expect(verifyHistoryChainWithVersion(repaired.entries)).toMatchObject({
      ok: true,
      item_hash_version: 1,
    });
  });

  it("keeps an explicit current stream on its declared epoch", () => {
    const entries = [historyEntry(2, true)];
    const repaired = reanchorHistoryEntries(entries);
    expect(repaired.entries).toEqual(entries);
    expect(repaired.itemHashVersion).toBe(2);
    expect(repaired.explicitItemHashVersion).toBe(true);
  });

  it("converges after repairing drift instead of alternating epochs", () => {
    const drifted = [
      {
        ...historyEntry(1, false),
        after_hash: "0".repeat(64),
      },
    ];
    const first = reanchorHistoryEntries(drifted);
    const second = reanchorHistoryEntries(first.entries);
    expect(first.itemHashVersion).toBe(1);
    expect(second.entries).toEqual(first.entries);
    expect(second.entriesRehashed).toBe(0);
  });

  it("falls forward only for an irreconcilably mixed explicit stream", () => {
    const mixed = [historyEntry(1, true), historyEntry(2, true)];
    expect(resolveHistoryRepairItemHashVersion(mixed)).toBe(2);
  });
});
