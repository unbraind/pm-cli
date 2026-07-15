/**
 * @module sdk/author-attribution
 *
 * Provides reusable diagnostics for mutation-author provenance in tracker history.
 */
import fs from "node:fs/promises";
import path from "node:path";

/** First release-governance anchor after which unknown authors require remediation. */
export const HISTORY_AUTHOR_ATTRIBUTION_BASELINE = "2026-07-15T06:22:12.276Z";

/** Parsed epoch for the immutable attribution baseline used by every stream scan. */
const HISTORY_AUTHOR_ATTRIBUTION_BASELINE_MS = Date.parse(
  HISTORY_AUTHOR_ATTRIBUTION_BASELINE,
);

/** Return history string fields unchanged while normalizing other values to empty text. */
const historyStringValue = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** Identifies one history event whose mutation author is absent or explicitly unknown. */
export interface UnknownAuthorHistoryEvent {
  /** Item whose history stream contains the event. */
  item_id: string;
  /** One-based JSONL line number. */
  line: number;
}

/** Summarizes mutation-author provenance across all readable tracker history streams. */
export interface HistoryAuthorAttributionScan {
  /** Number of readable history streams inspected. */
  checked_streams: number;
  /** Number of non-empty history events inspected. */
  checked_events: number;
  /** Number of events without attributable authorship. */
  unknown_event_count: number;
  /** Immutable pre-baseline events retained as historical information. */
  legacy_unknown_event_count: number;
  /** Timestamped post-baseline events that require author-attribution fixes. */
  actionable_unknown_event_count: number;
  /** Stable, sorted item ids containing unknown-author events. */
  affected_item_ids: string[];
  /** Bounded examples suitable for diagnostic output. */
  samples: UnknownAuthorHistoryEvent[];
}

/** Classifies one parsed history event by author provenance and baseline age. */
export const classifyHistoryAuthorEvent = (
  parsed: unknown,
): "attributed" | "legacy_unknown" | "actionable_unknown" => {
  const record = (parsed ?? {}) as { author?: unknown; ts?: unknown };
  const author = historyStringValue(record.author).trim().toLowerCase();
  if (!["", "unknown"].includes(author)) {
    return "attributed";
  }
  const timestamp = Date.parse(historyStringValue(record.ts));
  return !Number.isFinite(timestamp) ||
    timestamp < HISTORY_AUTHOR_ATTRIBUTION_BASELINE_MS
    ? "legacy_unknown"
    : "actionable_unknown";
};

/** Inspect one readable JSONL stream without performing filesystem I/O. */
export const inspectHistoryAuthorStream = (
  itemId: string,
  raw: string,
  sampleLimit = 20,
): Pick<
  HistoryAuthorAttributionScan,
  | "checked_events"
  | "unknown_event_count"
  | "legacy_unknown_event_count"
  | "actionable_unknown_event_count"
  | "samples"
> => {
  const samples: UnknownAuthorHistoryEvent[] = [];
  const unknownCounts = {
    legacy_unknown: 0,
    actionable_unknown: 0,
  };
  const boundedSampleLimit = Math.max(0, sampleLimit);
  let checkedEvents = 0;
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    checkedEvents += 1;
    const classification = classifyHistoryAuthorEvent(parsed);
    if (classification === "attributed") {
      continue;
    }
    unknownCounts[classification] += 1;
    if (samples.length < boundedSampleLimit) {
      samples.push({ item_id: itemId, line: index + 1 });
    }
  }
  return {
    checked_events: checkedEvents,
    unknown_event_count:
      unknownCounts.legacy_unknown + unknownCounts.actionable_unknown,
    legacy_unknown_event_count: unknownCounts.legacy_unknown,
    actionable_unknown_event_count: unknownCounts.actionable_unknown,
    samples,
  };
};

/**
 * Scan append-only tracker history for missing or `unknown` author values.
 * Malformed and unreadable streams are deliberately left to integrity diagnostics.
 */
export const scanHistoryAuthorAttribution = async (
  pmRoot: string,
  sampleLimit = 20,
): Promise<HistoryAuthorAttributionScan> => {
  const historyDirectory = path.join(pmRoot, "history");
  let fileNames: string[];
  try {
    fileNames = (await fs.readdir(historyDirectory))
      .filter((fileName) => fileName.endsWith(".jsonl"))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    fileNames = [];
  }
  const affectedItemIds = new Set<string>();
  const samples: UnknownAuthorHistoryEvent[] = [];
  let checkedStreams = 0;
  let checkedEvents = 0;
  let unknownEventCount = 0;
  let legacyUnknownEventCount = 0;
  let actionableUnknownEventCount = 0;
  for (const fileName of fileNames) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(historyDirectory, fileName), "utf8");
    } catch {
      continue;
    }
    const itemId = fileName.slice(0, -".jsonl".length);
    const inspected = inspectHistoryAuthorStream(
      itemId,
      raw,
      sampleLimit - samples.length,
    );
    checkedStreams += 1;
    checkedEvents += inspected.checked_events;
    unknownEventCount += inspected.unknown_event_count;
    legacyUnknownEventCount += inspected.legacy_unknown_event_count;
    actionableUnknownEventCount += inspected.actionable_unknown_event_count;
    if (inspected.unknown_event_count > 0) {
      affectedItemIds.add(itemId);
    }
    samples.push(...inspected.samples);
  }
  return {
    checked_streams: checkedStreams,
    checked_events: checkedEvents,
    unknown_event_count: unknownEventCount,
    legacy_unknown_event_count: legacyUnknownEventCount,
    actionable_unknown_event_count: actionableUnknownEventCount,
    affected_item_ids: [...affectedItemIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    samples,
  };
};
