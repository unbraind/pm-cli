import { describe, expect, it } from "vitest";
import {
  computeHistoryStorageStats,
  type HistoryStorageStats,
  type HistoryStreamStat,
} from "../../../../src/core/history/history-storage-stats.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(ts: string, op = "create"): string {
  return JSON.stringify({ ts, op });
}

function makeStream(id: string, entries: string[]): { id: string; raw: string } {
  const raw = entries.length === 0 ? "" : `${entries.join("\n")}\n`;
  return { id, raw };
}

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

describe("computeHistoryStorageStats — empty input", () => {
  it("returns all-zero totals and null entries for empty streams array", () => {
    const result = computeHistoryStorageStats([]);
    expect(result.total_streams).toBe(0);
    expect(result.total_lines).toBe(0);
    expect(result.total_bytes).toBe(0);
    expect(result.largest_by_bytes).toEqual([]);
    expect(result.deepest_by_lines).toEqual([]);
    expect(result.oldest_entry).toBeNull();
    expect(result.newest_entry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Single stream
// ---------------------------------------------------------------------------

describe("computeHistoryStorageStats — single stream", () => {
  it("counts lines, bytes, and extracts oldest/newest ts", () => {
    const ts1 = "2026-01-01T00:00:00.000Z";
    const ts2 = "2026-06-01T12:00:00.000Z";
    const raw = `${makeEntry(ts1)}\n${makeEntry(ts2)}\n`;
    const result = computeHistoryStorageStats([{ id: "pm-aaa1", raw }]);

    expect(result.total_streams).toBe(1);
    expect(result.total_lines).toBe(2);
    expect(result.total_bytes).toBe(Buffer.byteLength(raw, "utf8"));
    expect(result.oldest_entry).toEqual({ id: "pm-aaa1", ts: ts1 });
    expect(result.newest_entry).toEqual({ id: "pm-aaa1", ts: ts2 });
    expect(result.largest_by_bytes).toHaveLength(1);
    expect(result.deepest_by_lines).toHaveLength(1);
  });

  it("handles single-entry stream (oldest_ts === newest_ts)", () => {
    const ts = "2026-03-15T10:00:00.000Z";
    const raw = `${makeEntry(ts)}\n`;
    const result = computeHistoryStorageStats([{ id: "pm-single", raw }]);
    expect(result.oldest_entry).toEqual({ id: "pm-single", ts });
    expect(result.newest_entry).toEqual({ id: "pm-single", ts });
    const stat = result.largest_by_bytes[0]!;
    expect(stat.oldest_ts).toBe(ts);
    expect(stat.newest_ts).toBe(ts);
  });
});

// ---------------------------------------------------------------------------
// Multiple streams — bytes / lines ordering
// ---------------------------------------------------------------------------

describe("computeHistoryStorageStats — multiple streams", () => {
  it("totals bytes and lines across streams", () => {
    const r1 = `${makeEntry("2026-01-01T00:00:00.000Z")}\n`;
    const r2 = `${makeEntry("2026-02-01T00:00:00.000Z")}\n${makeEntry("2026-03-01T00:00:00.000Z")}\n`;
    const streams = [
      { id: "pm-a", raw: r1 },
      { id: "pm-b", raw: r2 },
    ];
    const result = computeHistoryStorageStats(streams);
    expect(result.total_streams).toBe(2);
    expect(result.total_lines).toBe(3);
    expect(result.total_bytes).toBe(
      Buffer.byteLength(r1, "utf8") + Buffer.byteLength(r2, "utf8"),
    );
  });

  it("sorts largest_by_bytes desc by bytes, then id asc for ties", () => {
    // pm-c is bigger, pm-a and pm-b tie — pm-a should come first on tie
    const shortEntry = makeEntry("2026-01-01T00:00:00.000Z");
    const longEntry = makeEntry("2026-01-01T00:00:00.000Z") + " ".repeat(200);
    const streams = [
      { id: "pm-b", raw: `${shortEntry}\n` },
      { id: "pm-c", raw: `${longEntry}\n` },
      { id: "pm-a", raw: `${shortEntry}\n` },
    ];
    const result = computeHistoryStorageStats(streams);
    expect(result.largest_by_bytes[0]!.id).toBe("pm-c");
    expect(result.largest_by_bytes[1]!.id).toBe("pm-a"); // tie-break: a < b
    expect(result.largest_by_bytes[2]!.id).toBe("pm-b");
  });

  it("sorts deepest_by_lines desc by lines, then id asc for ties", () => {
    const ts = "2026-01-01T00:00:00.000Z";
    const streams = [
      makeStream("pm-z", [makeEntry(ts)]),
      makeStream("pm-a", [makeEntry(ts), makeEntry(ts), makeEntry(ts)]),
      makeStream("pm-b", [makeEntry(ts)]), // tie with pm-z on lines; pm-b > pm-z, pm-z wins tie
    ];
    const result = computeHistoryStorageStats(streams);
    expect(result.deepest_by_lines[0]!.id).toBe("pm-a");
    expect(result.deepest_by_lines[1]!.id).toBe("pm-b");
    expect(result.deepest_by_lines[2]!.id).toBe("pm-z");
  });
});

// ---------------------------------------------------------------------------
// Tie-breaking by id
// ---------------------------------------------------------------------------

describe("computeHistoryStorageStats — tie-breaking by id asc", () => {
  it("breaks byte ties alphabetically by id", () => {
    const entry = makeEntry("2026-01-01T00:00:00.000Z");
    const streams = [
      { id: "pm-zz", raw: `${entry}\n` },
      { id: "pm-aa", raw: `${entry}\n` },
      { id: "pm-mm", raw: `${entry}\n` },
    ];
    const result = computeHistoryStorageStats(streams);
    expect(result.largest_by_bytes.map((s) => s.id)).toEqual(["pm-aa", "pm-mm", "pm-zz"]);
  });

  it("breaks line ties alphabetically by id", () => {
    const entry = makeEntry("2026-06-01T00:00:00.000Z");
    const streams = [
      makeStream("pm-z", [entry]),
      makeStream("pm-a", [entry]),
    ];
    const result = computeHistoryStorageStats(streams);
    expect(result.deepest_by_lines.map((s) => s.id)).toEqual(["pm-a", "pm-z"]);
  });
});

// ---------------------------------------------------------------------------
// Unparseable lines — ts handling and line counting
// ---------------------------------------------------------------------------

describe("computeHistoryStorageStats — unparseable lines", () => {
  it("counts unparseable JSON lines but skips their ts", () => {
    const validTs = "2026-04-01T00:00:00.000Z";
    const raw = `not-valid-json\n${makeEntry(validTs)}\nalso-not-json\n`;
    const result = computeHistoryStorageStats([{ id: "pm-parse", raw }]);
    const stat = result.largest_by_bytes[0]!;
    expect(stat.lines).toBe(3);
    expect(stat.oldest_ts).toBe(validTs);
    expect(stat.newest_ts).toBe(validTs);
  });

  it("counts lines with missing ts field but skips them for ts tracking", () => {
    const validTs = "2026-05-01T00:00:00.000Z";
    const lineNoTs = JSON.stringify({ op: "update", note: "no ts here" });
    const raw = `${lineNoTs}\n${makeEntry(validTs)}\n`;
    const result = computeHistoryStorageStats([{ id: "pm-nots", raw }]);
    const stat = result.largest_by_bytes[0]!;
    expect(stat.lines).toBe(2);
    expect(stat.oldest_ts).toBe(validTs);
  });

  it("counts lines with non-string ts field but skips them for ts tracking", () => {
    const lineNumericTs = JSON.stringify({ ts: 1_234_567_890, op: "create" });
    const raw = `${lineNumericTs}\n`;
    const result = computeHistoryStorageStats([{ id: "pm-numts", raw }]);
    const stat = result.largest_by_bytes[0]!;
    expect(stat.lines).toBe(1);
    expect(stat.oldest_ts).toBeNull();
    expect(stat.newest_ts).toBeNull();
  });

  it("skips lines whose ts string is not a valid date", () => {
    const badDate = JSON.stringify({ ts: "not-a-date", op: "create" });
    const raw = `${badDate}\n`;
    const result = computeHistoryStorageStats([{ id: "pm-baddate", raw }]);
    const stat = result.deepest_by_lines[0]!;
    expect(stat.lines).toBe(1);
    expect(stat.oldest_ts).toBeNull();
  });

  it("handles \\r\\n line endings correctly", () => {
    const ts = "2026-06-01T00:00:00.000Z";
    const raw = `${makeEntry(ts)}\r\n${makeEntry(ts)}\r\n`;
    const result = computeHistoryStorageStats([{ id: "pm-crlf", raw }]);
    const stat = result.largest_by_bytes[0]!;
    expect(stat.lines).toBe(2);
  });

  it("skips empty and whitespace-only lines without counting them", () => {
    const ts = "2026-06-01T00:00:00.000Z";
    const raw = `\n   \n${makeEntry(ts)}\n\n`;
    const result = computeHistoryStorageStats([{ id: "pm-ws", raw }]);
    const stat = result.largest_by_bytes[0]!;
    expect(stat.lines).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Stream with no parseable ts — null oldest/newest
// ---------------------------------------------------------------------------

describe("computeHistoryStorageStats — stream with no parseable ts", () => {
  it("produces null oldest_ts and newest_ts when no line has a valid ts", () => {
    const raw = `${JSON.stringify({ op: "create" })}\n`;
    const result = computeHistoryStorageStats([{ id: "pm-noparseable", raw }]);
    const stat = result.largest_by_bytes[0]!;
    expect(stat.oldest_ts).toBeNull();
    expect(stat.newest_ts).toBeNull();
  });

  it("returns null oldest_entry and newest_entry when no stream has a parseable ts", () => {
    const streams = [
      { id: "pm-x", raw: `${JSON.stringify({ op: "a" })}\n` },
      { id: "pm-y", raw: `${JSON.stringify({ op: "b" })}\n` },
    ];
    const result = computeHistoryStorageStats(streams);
    expect(result.oldest_entry).toBeNull();
    expect(result.newest_entry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// topN behaviour
// ---------------------------------------------------------------------------

describe("computeHistoryStorageStats — topN option", () => {
  it("defaults to returning top 5 when more than 5 streams are provided", () => {
    const ts = "2026-01-01T00:00:00.000Z";
    const streams = Array.from({ length: 8 }, (_, i) =>
      makeStream(`pm-${String(i).padStart(2, "0")}`, [makeEntry(ts)]),
    );
    const result = computeHistoryStorageStats(streams);
    expect(result.largest_by_bytes).toHaveLength(5);
    expect(result.deepest_by_lines).toHaveLength(5);
  });

  it("returns empty top-N arrays when topN=0", () => {
    const ts = "2026-01-01T00:00:00.000Z";
    const streams = [makeStream("pm-aaa", [makeEntry(ts)])];
    const result = computeHistoryStorageStats(streams, { topN: 0 });
    expect(result.largest_by_bytes).toEqual([]);
    expect(result.deepest_by_lines).toEqual([]);
  });

  it("returns all streams when topN exceeds stream count", () => {
    const ts = "2026-01-01T00:00:00.000Z";
    const streams = [
      makeStream("pm-aaa", [makeEntry(ts)]),
      makeStream("pm-bbb", [makeEntry(ts)]),
    ];
    const result = computeHistoryStorageStats(streams, { topN: 100 });
    expect(result.largest_by_bytes).toHaveLength(2);
    expect(result.deepest_by_lines).toHaveLength(2);
  });

  it("floors fractional topN values", () => {
    const ts = "2026-01-01T00:00:00.000Z";
    const streams = Array.from({ length: 6 }, (_, i) =>
      makeStream(`pm-${String(i).padStart(2, "0")}`, [makeEntry(ts)]),
    );
    const result = computeHistoryStorageStats(streams, { topN: 3.9 });
    expect(result.largest_by_bytes).toHaveLength(3);
  });

  it("clamps negative topN to 0 (empty top-N arrays)", () => {
    const ts = "2026-01-01T00:00:00.000Z";
    const streams = [makeStream("pm-neg", [makeEntry(ts)])];
    const result = computeHistoryStorageStats(streams, { topN: -5 });
    expect(result.largest_by_bytes).toEqual([]);
    expect(result.deepest_by_lines).toEqual([]);
  });

  it("returns topN=1 correctly", () => {
    const ts = "2026-01-01T00:00:00.000Z";
    const streams = [makeStream("pm-a", [makeEntry(ts)]), makeStream("pm-b", [makeEntry(ts)])];
    const result = computeHistoryStorageStats(streams, { topN: 1 });
    expect(result.largest_by_bytes).toHaveLength(1);
    expect(result.deepest_by_lines).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Global oldest/newest — cross-stream selection
// ---------------------------------------------------------------------------

describe("computeHistoryStorageStats — global oldest/newest", () => {
  it("picks the globally oldest and newest ts across all streams", () => {
    const earliest = "2026-01-01T00:00:00.000Z";
    const middle = "2026-04-01T00:00:00.000Z";
    const latest = "2026-12-31T23:59:59.999Z";
    const streams = [
      makeStream("pm-mid", [makeEntry(middle)]),
      makeStream("pm-old", [makeEntry(earliest)]),
      makeStream("pm-new", [makeEntry(latest)]),
    ];
    const result = computeHistoryStorageStats(streams);
    expect(result.oldest_entry).toEqual({ id: "pm-old", ts: earliest });
    expect(result.newest_entry).toEqual({ id: "pm-new", ts: latest });
  });

  it("breaks global oldest tie on id asc", () => {
    const ts = "2026-06-01T00:00:00.000Z";
    const streams = [
      makeStream("pm-zzz", [makeEntry(ts)]),
      makeStream("pm-aaa", [makeEntry(ts)]),
    ];
    const result = computeHistoryStorageStats(streams);
    expect(result.oldest_entry).toEqual({ id: "pm-aaa", ts });
  });

  it("breaks global newest tie on id asc", () => {
    const ts = "2026-06-01T00:00:00.000Z";
    const streams = [
      makeStream("pm-zzz", [makeEntry(ts)]),
      makeStream("pm-aaa", [makeEntry(ts)]),
    ];
    const result = computeHistoryStorageStats(streams);
    expect(result.newest_entry).toEqual({ id: "pm-aaa", ts });
  });

  it("handles mix of streams with and without parseable ts", () => {
    const ts = "2026-06-01T00:00:00.000Z";
    const streams = [
      { id: "pm-nodate", raw: `${JSON.stringify({ op: "x" })}\n` },
      makeStream("pm-dated", [makeEntry(ts)]),
    ];
    const result = computeHistoryStorageStats(streams);
    expect(result.oldest_entry).toEqual({ id: "pm-dated", ts });
    expect(result.newest_entry).toEqual({ id: "pm-dated", ts });
  });
});

// ---------------------------------------------------------------------------
// Multibyte UTF-8 byte counting
// ---------------------------------------------------------------------------

describe("computeHistoryStorageStats — multibyte UTF-8 byte counting", () => {
  it("counts bytes correctly for content with emoji and accented chars", () => {
    // Each emoji like 🚀 is 4 bytes; é is 2 bytes
    const ts = "2026-06-01T00:00:00.000Z";
    const entry = JSON.stringify({ ts, note: "🚀 héllo" });
    const raw = `${entry}\n`;
    const expectedBytes = Buffer.byteLength(raw, "utf8");
    // Sanity: UTF-8 byte count must be > raw.length for multibyte content
    expect(expectedBytes).toBeGreaterThan(raw.length);

    const result = computeHistoryStorageStats([{ id: "pm-utf8", raw }]);
    expect(result.total_bytes).toBe(expectedBytes);
    const stat = result.largest_by_bytes[0]!;
    expect(stat.bytes).toBe(expectedBytes);
  });

  it("sums multibyte byte counts across streams", () => {
    const ts = "2026-06-01T00:00:00.000Z";
    const r1 = `${JSON.stringify({ ts, note: "こんにちは" })}\n`; // Japanese = 3 bytes/char
    const r2 = `${JSON.stringify({ ts, note: "café" })}\n`;
    const streams = [
      { id: "pm-ja", raw: r1 },
      { id: "pm-fr", raw: r2 },
    ];
    const result = computeHistoryStorageStats(streams);
    expect(result.total_bytes).toBe(
      Buffer.byteLength(r1, "utf8") + Buffer.byteLength(r2, "utf8"),
    );
  });
});

// ---------------------------------------------------------------------------
// Per-stream oldest/newest within a stream
// ---------------------------------------------------------------------------

describe("computeHistoryStorageStats — per-stream ts min/max", () => {
  it("correctly determines oldest and newest ts within a stream with many entries", () => {
    const ts1 = "2026-01-15T08:00:00.000Z";
    const ts2 = "2026-03-20T12:30:00.000Z";
    const ts3 = "2026-01-10T00:00:00.000Z"; // oldest
    const ts4 = "2026-06-01T23:59:59.999Z"; // newest
    const raw = [ts1, ts2, ts3, ts4].map((ts) => makeEntry(ts)).join("\n") + "\n";
    const result = computeHistoryStorageStats([{ id: "pm-multi", raw }]);
    const stat: HistoryStreamStat = result.largest_by_bytes[0]!;
    expect(stat.oldest_ts).toBe(ts3);
    expect(stat.newest_ts).toBe(ts4);
  });
});

// ---------------------------------------------------------------------------
// Empty raw string stream (zero lines, zero bytes)
// ---------------------------------------------------------------------------

describe("computeHistoryStorageStats — empty raw string stream", () => {
  it("handles a stream with empty raw content", () => {
    const result = computeHistoryStorageStats([{ id: "pm-empty", raw: "" }]);
    expect(result.total_streams).toBe(1);
    expect(result.total_lines).toBe(0);
    expect(result.total_bytes).toBe(0);
    const stat = result.largest_by_bytes[0]!;
    expect(stat.lines).toBe(0);
    expect(stat.bytes).toBe(0);
    expect(stat.oldest_ts).toBeNull();
    expect(stat.newest_ts).toBeNull();
    expect(result.oldest_entry).toBeNull();
    expect(result.newest_entry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Return type shape
// ---------------------------------------------------------------------------

describe("computeHistoryStorageStats — return type completeness", () => {
  it("returns a fully typed HistoryStorageStats object", () => {
    const ts = "2026-06-01T00:00:00.000Z";
    const result: HistoryStorageStats = computeHistoryStorageStats(
      [makeStream("pm-shape", [makeEntry(ts)])],
      { topN: 2 },
    );
    expect(typeof result.total_streams).toBe("number");
    expect(typeof result.total_lines).toBe("number");
    expect(typeof result.total_bytes).toBe("number");
    expect(Array.isArray(result.largest_by_bytes)).toBe(true);
    expect(Array.isArray(result.deepest_by_lines)).toBe(true);
    expect(result.oldest_entry).not.toBeNull();
    expect(result.newest_entry).not.toBeNull();
  });
});
