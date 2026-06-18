/**
 * Pure aggregate metrics for history streams (JSONL files).
 * No filesystem access — callers read raw stream contents and pass them in.
 * This module has no Node imports; Buffer is available as a global.
 */

export interface HistoryStreamStat {
  id: string;
  bytes: number;
  lines: number; // non-empty JSONL entry count
  oldest_ts: string | null; // min parseable ts in this stream, else null
  newest_ts: string | null; // max parseable ts in this stream, else null
}

/**
 * Documents the history storage entry ref payload exchanged by command, SDK, and package integrations.
 */
export interface HistoryStorageEntryRef {
  id: string;
  ts: string;
}

/**
 * Documents the history storage stats payload exchanged by command, SDK, and package integrations.
 */
export interface HistoryStorageStats {
  total_streams: number;
  total_lines: number;
  total_bytes: number;
  largest_by_bytes: HistoryStreamStat[]; // top-N desc by bytes, tie-break id asc
  deepest_by_lines: HistoryStreamStat[]; // top-N desc by lines, tie-break id asc
  oldest_entry: HistoryStorageEntryRef | null; // global min ts across all streams
  newest_entry: HistoryStorageEntryRef | null; // global max ts across all streams
}

function parseStreamStat(id: string, raw: string): HistoryStreamStat {
  const bytes = Buffer.byteLength(raw, "utf8");

  let lines = 0;
  let oldestTs: string | null = null;
  let newestTs: string | null = null;
  let oldestMs = Number.POSITIVE_INFINITY;
  let newestMs = Number.NEGATIVE_INFINITY;

  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === "") {
      continue;
    }
    lines += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("ts" in (parsed as object)) ||
      typeof (parsed as Record<string, unknown>)["ts"] !== "string"
    ) {
      continue;
    }

    const ts = (parsed as Record<string, unknown>)["ts"] as string;
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) {
      continue;
    }

    if (ms < oldestMs || (ms === oldestMs && oldestTs !== null && ts < oldestTs)) {
      oldestMs = ms;
      oldestTs = ts;
    }
    if (ms > newestMs || (ms === newestMs && newestTs !== null && ts > newestTs)) {
      newestMs = ms;
      newestTs = ts;
    }
  }

  return { id, bytes, lines, oldest_ts: oldestTs, newest_ts: newestTs };
}

/**
 * Implements compute history storage stats for the public runtime surface of this module.
 */
export function computeHistoryStorageStats(
  streams: Array<{ id: string; raw: string }>,
  options?: { topN?: number },
): HistoryStorageStats {
  const rawTopN = options?.topN ?? 5;
  const topN = Math.max(0, Math.floor(rawTopN));

  const stats: HistoryStreamStat[] = streams.map(({ id, raw }) => parseStreamStat(id, raw));

  let totalLines = 0;
  let totalBytes = 0;
  let oldestEntry: HistoryStorageEntryRef | null = null;
  let newestEntry: HistoryStorageEntryRef | null = null;
  let globalOldestMs = Number.POSITIVE_INFINITY;
  let globalNewestMs = Number.NEGATIVE_INFINITY;

  for (const stat of stats) {
    totalLines += stat.lines;
    totalBytes += stat.bytes;

    if (stat.oldest_ts !== null) {
      const ms = Date.parse(stat.oldest_ts);
      if (
        ms < globalOldestMs ||
        (ms === globalOldestMs && oldestEntry !== null && stat.id < oldestEntry.id)
      ) {
        globalOldestMs = ms;
        oldestEntry = { id: stat.id, ts: stat.oldest_ts };
      }
    }

    if (stat.newest_ts !== null) {
      const ms = Date.parse(stat.newest_ts);
      if (
        ms > globalNewestMs ||
        (ms === globalNewestMs && newestEntry !== null && stat.id < newestEntry.id)
      ) {
        globalNewestMs = ms;
        newestEntry = { id: stat.id, ts: stat.newest_ts };
      }
    }
  }

  const largestByBytes =
    topN === 0
      ? []
      : [...stats]
          .sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id))
          .slice(0, topN);

  const deepestByLines =
    topN === 0
      ? []
      : [...stats]
          .sort((a, b) => b.lines - a.lines || a.id.localeCompare(b.id))
          .slice(0, topN);

  return {
    total_streams: streams.length,
    total_lines: totalLines,
    total_bytes: totalBytes,
    largest_by_bytes: largestByBytes,
    deepest_by_lines: deepestByLines,
    oldest_entry: oldestEntry,
    newest_entry: newestEntry,
  };
}
