/**
 * @module sdk/author-attribution
 *
 * Provides reusable diagnostics for mutation-author provenance in tracker history.
 */
import fs from "node:fs/promises";
import path from "node:path";

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
  /** Stable, sorted item ids containing unknown-author events. */
  affected_item_ids: string[];
  /** Bounded examples suitable for diagnostic output. */
  samples: UnknownAuthorHistoryEvent[];
}

/** Inspect one readable JSONL stream without performing filesystem I/O. */
export function inspectHistoryAuthorStream(
  itemId: string,
  raw: string,
  sampleLimit = 20,
): Pick<
  HistoryAuthorAttributionScan,
  "checked_events" | "unknown_event_count" | "samples"
> {
  const samples: UnknownAuthorHistoryEvent[] = [];
  let checkedEvents = 0;
  let unknownEventCount = 0;
  for (const [index, rawLine] of raw.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    checkedEvents += 1;
    const author =
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { author?: unknown }).author === "string"
        ? (parsed as { author: string }).author.trim()
        : "";
    if (author.length > 0 && author.toLowerCase() !== "unknown") {
      continue;
    }
    unknownEventCount += 1;
    if (samples.length < Math.max(0, sampleLimit)) {
      samples.push({ item_id: itemId, line: index + 1 });
    }
  }
  return {
    checked_events: checkedEvents,
    unknown_event_count: unknownEventCount,
    samples,
  };
}

/**
 * Scan append-only tracker history for missing or `unknown` author values.
 * Malformed and unreadable streams are deliberately left to integrity diagnostics.
 */
export async function scanHistoryAuthorAttribution(
  pmRoot: string,
  sampleLimit = 20,
): Promise<HistoryAuthorAttributionScan> {
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
    if (inspected.unknown_event_count > 0) {
      affectedItemIds.add(itemId);
    }
    samples.push(...inspected.samples);
  }
  return {
    checked_streams: checkedStreams,
    checked_events: checkedEvents,
    unknown_event_count: unknownEventCount,
    affected_item_ids: [...affectedItemIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    samples,
  };
}
