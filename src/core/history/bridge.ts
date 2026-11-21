/**
 * @module core/history/bridge
 *
 * Append-only chain bridges (GH-1715, pm-gh1715). A bridge is one sealed
 * `history_repair` record that names every place where the recorded chain
 * breaks because a change landed outside pm. It leaves every earlier line
 * byte-identical: verification accepts a break exactly when the next bridge
 * names it, checks the recorded links inside the bridged segment, and
 * re-anchors replay on the bridge's own after_hash.
 */
import { historyDigest, resolveHistoryHashAlgorithm } from "./digest.js";
import { stableStringify } from "../shared/serialization.js";
import type {
  HistoryBridge,
  HistoryBridgeBreak,
  HistoryEntry,
} from "../../types/index.js";

/** Version of the bridge envelope written by this build. */
export const HISTORY_BRIDGE_VERSION = 1 as const;

/** Return whether one value is a well-formed break descriptor. */
function isHistoryBridgeBreak(value: unknown): value is HistoryBridgeBreak {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 3 &&
    typeof candidate.gap_from === "string" &&
    typeof candidate.gap_to === "string" &&
    candidate.gap_from !== candidate.gap_to &&
    (candidate.record_hash === null || typeof candidate.record_hash === "string")
  );
}

/**
 * Read an entry's bridge: undefined when it carries none, "invalid" when the
 * field is present but malformed or unsealed, so a forged or truncated bridge
 * is drift instead of being ignored.
 */
export function readHistoryBridge(
  entry: HistoryEntry,
): HistoryBridge | "invalid" | undefined {
  if (!Object.hasOwn(entry, "bridge")) return undefined;
  const bridge = entry.bridge as unknown;
  if (
    entry.op !== "history_repair" ||
    typeof entry.record_hash !== "string" ||
    typeof bridge !== "object" ||
    bridge === null ||
    Array.isArray(bridge)
  ) {
    return "invalid";
  }
  const candidate = bridge as Record<string, unknown>;
  return candidate.version === HISTORY_BRIDGE_VERSION &&
    Object.keys(candidate).length === 3 &&
    typeof candidate.segment_digest === "string" &&
    Array.isArray(candidate.breaks) &&
    candidate.breaks.length > 0 &&
    candidate.breaks.every(isHistoryBridgeBreak)
    ? (candidate as unknown as HistoryBridge)
    : "invalid";
}

/** Describe the break between two adjacent recorded entries. */
export function describeHistoryBreak(
  previous: HistoryEntry,
  entry: HistoryEntry,
): HistoryBridgeBreak {
  return {
    gap_from: previous.after_hash,
    gap_to: entry.before_hash,
    record_hash: entry.record_hash ?? null,
  };
}

/** Whether a descriptor names exactly the break between these two entries. */
export function matchesHistoryBreak(
  descriptor: HistoryBridgeBreak | undefined,
  previous: HistoryEntry,
  entry: HistoryEntry,
): boolean {
  return (
    descriptor !== undefined &&
    descriptor.gap_from === previous.after_hash &&
    descriptor.gap_to === entry.before_hash &&
    descriptor.record_hash === (entry.record_hash ?? null)
  );
}

/**
 * Digest the records a bridge covers, from the first break up to the bridge,
 * under the bridge record's algorithm. Inside a segment replay cannot prove
 * each recorded state, so the bridge commits to the exact records instead.
 */
export function digestBridgedSegment(
  segment: readonly HistoryEntry[],
  bridge: Pick<HistoryEntry, "hash_algorithm">,
): string {
  return historyDigest(
    stableStringify(segment),
    resolveHistoryHashAlgorithm(bridge.hash_algorithm),
  );
}

/** Index of the first bridge record after `index`, or -1. */
export function findNextHistoryBridge(
  entries: readonly HistoryEntry[],
  index: number,
): number {
  for (let candidate = index + 1; candidate < entries.length; candidate += 1) {
    if (Object.hasOwn(entries[candidate], "bridge")) return candidate;
  }
  return -1;
}

/** Where each bridge's own commitments place its segment, independent of whether the stream verifies. */
export interface LocatedBridgedSegments {
  /**
   * Zero-based inclusive ranges from a segment's first break to its bridge.
   * `exact` is false when no intact commitment proved the start: the range
   * then reaches back to the record after the previous bridge and covers the
   * bridge record too, so an unproven segment is never served as exact.
   */
  segments: Array<{ start: number; end: number; exact: boolean }>;
  /** Indexes of bridge records whose segment no intact commitment locates, or whose envelope is malformed. */
  unlocated: number[];
}

/** The segment digest, or null when the bridge names an algorithm this build cannot compute. */
function safeSegmentDigest(segment: readonly HistoryEntry[], bridge: HistoryEntry): string | null {
  try {
    return digestBridgedSegment(segment, bridge);
  } catch {
    return null;
  }
}

/**
 * Index where a bridge's segment provably starts, or -1. The segment digest
 * proves it from a start the first break's record hash or recorded anchors
 * name, even when the record before the break was damaged since. Failing
 * that, a start whose break anchors match is accepted only when every record
 * after it already carries replay_inexact: a rewrite located that segment
 * exactly and marked it, which voided the digest it would otherwise match.
 */
function findBridgedSegmentStart(
  entries: readonly HistoryEntry[],
  bridge: HistoryBridge,
  floor: number,
  end: number,
): number {
  const first = bridge.breaks[0]!;
  let materialized = -1;
  for (let start = Math.max(1, floor); start < end; start += 1) {
    const entry = entries[start]!;
    const anchored =
      entries[start - 1]!.after_hash === first.gap_from && entry.before_hash === first.gap_to;
    const named = first.record_hash !== null && entry.record_hash === first.record_hash;
    if (!anchored && !named) continue;
    const covered = entries.slice(start, end);
    if (safeSegmentDigest(covered, entries[end]!) === bridge.segment_digest) return start;
    if (materialized < 0 && anchored && covered.every((record) => record.replay_inexact === true)) {
      materialized = start;
    }
  }
  return materialized;
}

/**
 * Locate every bridge's segment from the records it commits to, without
 * requiring the stream before it to verify. Rewrites use this to mark the
 * versions a bridge proves unreconstructable even when an earlier record is
 * what they repair; markers only ever restrict reads.
 */
export function locateBridgedSegments(entries: readonly HistoryEntry[]): LocatedBridgedSegments {
  const located: LocatedBridgedSegments = { segments: [], unlocated: [] };
  let floor = 1;
  entries.forEach((entry, index) => {
    if (!Object.hasOwn(entry, "bridge")) return;
    const bridge = readHistoryBridge(entry);
    const start =
      typeof bridge === "object" ? findBridgedSegmentStart(entries, bridge, floor, index) : -1;
    if (start < 0) located.unlocated.push(index);
    located.segments.push({ start: start < 0 ? floor : start, end: index, exact: start >= 0 });
    // Only a proven bridge closes what came before it: an unproven one must
    // not hide the start of a later bridge's segment.
    if (start >= 0) floor = index + 1;
  });
  return located;
}
