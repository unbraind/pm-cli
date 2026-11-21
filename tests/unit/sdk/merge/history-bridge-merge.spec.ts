/**
 * Merge marking of records an append-only bridge covers (GH-1715).
 */
import { describe, expect, it } from "vitest";
import { digestBridgedSegment } from "../../../../src/core/history/bridge.js";
import { _testOnly } from "../../../../src/sdk/merge/three-way.js";
import type { HistoryEntry } from "../../../../src/types/index.js";

function record(fields: Partial<HistoryEntry>): HistoryEntry {
  return {
    ts: "2026-11-21T00:00:00.000Z",
    author: "tester",
    op: "update",
    patch: [{ op: "replace", path: "/metadata/priority", value: 0 }],
    before_hash: "a".repeat(64),
    after_hash: "b".repeat(64),
    ...fields,
  } as HistoryEntry;
}

describe("union marking by occurrence", () => {
  it("marks the same occurrence of a repeated identity, not its last copy", () => {
    const repeated = record({});
    const side = [record({ op: "create" }), repeated, { ...repeated, replay_inexact: true as const }, repeated];
    const merged = [record({ op: "create" }), repeated, repeated, repeated];
    expect([..._testOnly.collectUnionInexactIndexes(merged, [side], false)]).toEqual([2]);
  });

  it("marks every repeated record a bridge covers and every event placed inside its segment", () => {
    const first = record({ op: "create", after_hash: "1".repeat(64), record_hash: "c".repeat(64) });
    const broken = record({ before_hash: "2".repeat(64), record_hash: "d".repeat(64) });
    const repeated = record({ record_hash: "e".repeat(64) });
    const covered = [broken, repeated, repeated];
    const bridge = record({
      op: "history_repair",
      record_hash: "f".repeat(64),
      bridge: {
        version: 1,
        breaks: [{ gap_from: first.after_hash, gap_to: broken.before_hash, record_hash: broken.record_hash! }],
        segment_digest: digestBridgedSegment(covered, {}),
      },
    });
    const side = [first, ...covered, bridge];
    const interleaved = record({ op: "comment_add", ts: "2026-11-21T00:00:01.000Z" });
    const merged = [first, broken, repeated, interleaved, repeated, bridge];
    expect([..._testOnly.collectUnionInexactIndexes(merged, [side], true)].sort()).toEqual([1, 2, 3, 4]);
  });

  it("detects a repair that recurs after the equivalent-repair runs, live or as a neutral copy", () => {
    const bridge = { version: 1, breaks: [{ gap_from: "1".repeat(64), gap_to: "2".repeat(64), record_hash: null }], segment_digest: "3".repeat(64) };
    const repair = record({ op: "history_repair", record_hash: "f".repeat(64), bridge } as Partial<HistoryEntry>);
    const later = record({ op: "comment_add", ts: "2026-11-21T00:00:01.000Z" });
    const { bridge: _bridge, ...unbridged } = repair;
    const neutral = { ...unbridged, patch: [], reanchor_evidence: [{ record: repair }] } as unknown as HistoryEntry;
    expect(_testOnly.repairRecursAfterRuns([repair], [later])).toBe(false);
    expect(_testOnly.repairRecursAfterRuns([repair], [later, repair])).toBe(true);
    expect(_testOnly.repairRecursAfterRuns([repair], [later, neutral])).toBe(true);
    expect(_testOnly.repairRecursAfterRuns([neutral], [later, repair])).toBe(true);
    // A later marker reseal adds digest-only evidence; the copy still aliases its original.
    const marked = { ...neutral, reanchor_evidence: [{ record: repair }, { prior_record_hash: "8".repeat(64) }] } as unknown as HistoryEntry;
    expect(_testOnly.repairRecursAfterRuns([repair], [later, marked])).toBe(true);
    // A plain no-op repair without evidence is its own identity.
    const plain = record({ op: "history_repair", patch: [], ts: "2026-11-21T00:00:02.000Z" });
    expect(_testOnly.repairRecursAfterRuns([repair], [plain])).toBe(false);
    expect(_testOnly.repairRecursAfterRuns([], [later, repair])).toBe(false);
    // A recurring repair keeps the recorded runs before any side is verified.
    expect(_testOnly.normalizationApplies([repair], [later, neutral], [])).toBe(false);
    expect(_testOnly.normalizationApplies([repair], [later], [])).toBe(true);
  });

  it("keeps a legacy repair record without a patch array on the ordinary identity path", () => {
    const legacy = { ...record({ op: "history_repair" }), patch: undefined } as unknown as HistoryEntry;
    expect([..._testOnly.collectUnionInexactIndexes([legacy], [[legacy]], false)]).toEqual([]);
  });
});
