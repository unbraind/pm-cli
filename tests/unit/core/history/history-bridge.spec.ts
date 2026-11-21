/**
 * Bridge envelope parsing for append-only history repair (GH-1715, pm-gh1715).
 */
import { describe, expect, it } from "vitest";
import {
  describeHistoryBreak,
  findNextHistoryBridge,
  matchesHistoryBreak,
  readHistoryBridge,
} from "../../../../src/core/history/bridge.js";
import type { HistoryEntry } from "../../../../src/types/index.js";

const descriptor = { gap_from: "a".repeat(64), gap_to: "b".repeat(64), record_hash: null };

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
    const bridge = { version: 1, breaks: [descriptor, { ...descriptor, record_hash: "f".repeat(64) }] };
    expect(readHistoryBridge(entry({ bridge }))).toEqual(bridge);
  });

  it.each([
    ["a null bridge", { bridge: null }],
    ["an array bridge", { bridge: [descriptor] }],
    ["a string bridge", { bridge: "bridge" }],
    ["an extra bridge key", { bridge: { version: 1, breaks: [descriptor], note: "x" } }],
    ["a breaks object", { bridge: { version: 1, breaks: { 0: descriptor } } }],
    ["a non-object break", { bridge: { version: 1, breaks: [null] } }],
    ["an array break", { bridge: { version: 1, breaks: [[descriptor.gap_from]] } }],
    ["a numeric gap", { bridge: { version: 1, breaks: [{ ...descriptor, gap_from: 1 }] } }],
    ["a numeric gap_to", { bridge: { version: 1, breaks: [{ ...descriptor, gap_to: 1 }] } }],
    ["a numeric record hash", { bridge: { version: 1, breaks: [{ ...descriptor, record_hash: 1 }] } }],
    ["a missing break key", { bridge: { version: 1, breaks: [{ gap_from: "a", gap_to: "b" }] } }],
    ["an unsealed record", { record_hash: undefined, bridge: { version: 1, breaks: [descriptor] } }],
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
    const stream = [previous, legacy, entry({ bridge: { version: 1, breaks: [descriptor] } })];
    expect(findNextHistoryBridge(stream, 0)).toBe(2);
    expect(findNextHistoryBridge(stream, 2)).toBe(-1);
  });
});
