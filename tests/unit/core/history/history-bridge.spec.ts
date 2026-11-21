/**
 * Bridge envelope parsing for append-only history repair (GH-1715, pm-gh1715).
 */
import { describe, expect, it } from "vitest";
import {
  describeHistoryBreak,
  digestBridgedSegment,
  findNextHistoryBridge,
  locateBridgedSegments,
  matchesHistoryBreak,
  readHistoryBridge,
} from "../../../../src/core/history/bridge.js";
import type { HistoryEntry } from "../../../../src/types/index.js";

const descriptor = { gap_from: "a".repeat(64), gap_to: "b".repeat(64), record_hash: null };
const segment_digest = "9".repeat(64);

function entry(fields: Record<string, unknown>): HistoryEntry {
  return {
    ts: "2026-11-21T00:00:00.000Z",
    author: "tester",
    op: "history_repair",
    patch: [],
    before_hash: "c".repeat(64),
    after_hash: "d".repeat(64),
    record_hash: "e".repeat(64),
    ...fields,
  } as HistoryEntry;
}

describe("history bridge envelope", () => {
  it("reads absent, valid and legacy-anchored bridges", () => {
    expect(readHistoryBridge(entry({}))).toBeUndefined();
    const bridge = { version: 1, breaks: [descriptor, { ...descriptor, record_hash: "f".repeat(64) }], segment_digest };
    expect(readHistoryBridge(entry({ bridge }))).toEqual(bridge);
  });

  it.each([
    ["a null bridge", { bridge: null }],
    ["an array bridge", { bridge: [descriptor] }],
    ["a string bridge", { bridge: "bridge" }],
    ["an extra bridge key", { bridge: { version: 1, breaks: [descriptor], segment_digest, note: "x" } }],
    ["a missing segment digest", { bridge: { version: 1, breaks: [descriptor], note: "x" } }],
    ["a numeric segment digest", { bridge: { version: 1, breaks: [descriptor], segment_digest: 9 } }],
    ["a breaks object", { bridge: { version: 1, breaks: { 0: descriptor }, segment_digest } }],
    ["a non-object break", { bridge: { version: 1, breaks: [null], segment_digest } }],
    ["an array break", { bridge: { version: 1, breaks: [[descriptor.gap_from]], segment_digest } }],
    ["a numeric gap", { bridge: { version: 1, breaks: [{ ...descriptor, gap_from: 1 }], segment_digest } }],
    ["a numeric gap_to", { bridge: { version: 1, breaks: [{ ...descriptor, gap_to: 1 }], segment_digest } }],
    ["a numeric record hash", { bridge: { version: 1, breaks: [{ ...descriptor, record_hash: 1 }], segment_digest } }],
    ["a missing break key", { bridge: { version: 1, breaks: [{ gap_from: "a", gap_to: "b" }], segment_digest } }],
    ["an unsealed record", { record_hash: undefined, bridge: { version: 1, breaks: [descriptor], segment_digest } }],
  ])("refuses %s", (_label, fields) => {
    expect(readHistoryBridge(entry(fields))).toBe("invalid");
  });

  it("describes, matches and finds breaks by recorded anchors", () => {
    const previous = entry({ after_hash: descriptor.gap_from });
    const legacy = entry({ before_hash: descriptor.gap_to, record_hash: undefined });
    expect(describeHistoryBreak(previous, legacy)).toEqual(descriptor);
    expect(matchesHistoryBreak(descriptor, previous, legacy)).toBe(true);
    expect(matchesHistoryBreak(undefined, previous, legacy)).toBe(false);
    expect(matchesHistoryBreak({ ...descriptor, record_hash: "e".repeat(64) }, previous, legacy)).toBe(false);
    expect(matchesHistoryBreak({ ...descriptor, gap_to: "0" }, previous, legacy)).toBe(false);
    expect(matchesHistoryBreak({ ...descriptor, gap_from: "0" }, previous, legacy)).toBe(false);
    const stream = [previous, legacy, entry({ bridge: { version: 1, breaks: [descriptor], segment_digest } })];
    expect(findNextHistoryBridge(stream, 0)).toBe(2);
    expect(findNextHistoryBridge(stream, 2)).toBe(-1);
  });

  it("locates segments from each bridge's own commitments", () => {
    const first = entry({ after_hash: descriptor.gap_from, record_hash: "1".repeat(64) });
    const broken = entry({ before_hash: descriptor.gap_to, record_hash: undefined });
    const covered = [broken, entry({ record_hash: "2".repeat(64) })];
    const bridge = entry({
      bridge: { version: 1, breaks: [descriptor], segment_digest: digestBridgedSegment(covered, {}) },
    });
    const stream = [first, ...covered, bridge];
    expect(locateBridgedSegments(stream)).toEqual({ segments: [{ start: 1, end: 3 }], unlocated: [] });
    // A digest that does not match, a malformed envelope, and a bridge with nothing before it stay unlocated.
    const wrongDigest = entry({ bridge: { version: 1, breaks: [descriptor], segment_digest } });
    const malformed = entry({ bridge: { version: 1 } });
    expect(locateBridgedSegments([first, ...covered, wrongDigest, malformed])).toEqual({ segments: [], unlocated: [3, 4] });
    expect(locateBridgedSegments([bridge])).toEqual({ segments: [], unlocated: [0] });
  });
});
