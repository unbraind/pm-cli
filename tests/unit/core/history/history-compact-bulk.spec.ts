import { describe, expect, it } from "vitest";
import {
  selectHistoryCompactBulkTargets,
  type HistoryCompactBulkCandidate,
} from "../../../../src/core/history/history-compact-bulk.js";

function candidate(
  id: string,
  entries: number,
  bucket: HistoryCompactBulkCandidate["bucket"] = "closed",
): HistoryCompactBulkCandidate {
  return { id, entries, bucket };
}

describe("selectHistoryCompactBulkTargets", () => {
  describe("ids mode", () => {
    it("selects requested streams above the min-entries floor, ordered as requested", () => {
      const rows = selectHistoryCompactBulkTargets(
        [candidate("pm-a", 10), candidate("pm-b", 4), candidate("pm-c", 2)],
        { ids: ["pm-c", "pm-a"], minEntries: 3 },
      );
      expect(rows).toEqual([
        { id: "pm-c", entries: 2, selected: false, skip_reason: "already_compact" },
        { id: "pm-a", entries: 10, selected: true, skip_reason: null },
      ]);
    });

    it("flags requested ids with no stream as no_stream and ignores scope/allOver", () => {
      const rows = selectHistoryCompactBulkTargets([candidate("pm-a", 10, "open")], {
        ids: ["pm-missing", "pm-a"],
        scope: "closed",
        allOver: 100,
        minEntries: 3,
      });
      expect(rows).toEqual([
        { id: "pm-missing", entries: 0, selected: false, skip_reason: "no_stream" },
        // scope=closed + allOver=100 are ignored in ids mode: pm-a is selected despite being "open" and under 100.
        { id: "pm-a", entries: 10, selected: true, skip_reason: null },
      ]);
    });

    it("collapses duplicate and blank ids, preserving first-seen order", () => {
      const rows = selectHistoryCompactBulkTargets([candidate("pm-a", 10)], {
        ids: ["pm-a", " ", "pm-a", "  pm-a  "],
        minEntries: 3,
      });
      expect(rows).toEqual([{ id: "pm-a", entries: 10, selected: true, skip_reason: null }]);
    });
  });

  describe("scan mode", () => {
    it("orders deepest-first and skips streams at/below the min-entries floor", () => {
      const rows = selectHistoryCompactBulkTargets(
        [candidate("pm-small", 3), candidate("pm-deep", 20), candidate("pm-mid", 8)],
        { minEntries: 3 },
      );
      expect(rows.map((row) => row.id)).toEqual(["pm-deep", "pm-mid", "pm-small"]);
      expect(rows.find((row) => row.id === "pm-small")).toMatchObject({
        selected: false,
        skip_reason: "already_compact",
      });
      expect(rows.filter((row) => row.selected).map((row) => row.id)).toEqual(["pm-deep", "pm-mid"]);
    });

    it("breaks entry-count ties by id ascending", () => {
      const rows = selectHistoryCompactBulkTargets([candidate("pm-b", 9), candidate("pm-a", 9)], {
        minEntries: 3,
      });
      expect(rows.map((row) => row.id)).toEqual(["pm-a", "pm-b"]);
    });

    it("filters non-closed buckets (including orphan streams) under scope=closed", () => {
      const rows = selectHistoryCompactBulkTargets(
        [candidate("pm-open", 10, "open"), candidate("pm-closed", 10, "closed"), candidate("pm-orphan", 10, null)],
        { scope: "closed", minEntries: 3 },
      );
      expect(rows.find((row) => row.id === "pm-open")).toMatchObject({ skip_reason: "scope_mismatch" });
      expect(rows.find((row) => row.id === "pm-orphan")).toMatchObject({ skip_reason: "scope_mismatch" });
      expect(rows.find((row) => row.id === "pm-closed")).toMatchObject({ selected: true });
    });

    it("includes every bucket under scope=all-streams", () => {
      const rows = selectHistoryCompactBulkTargets(
        [candidate("pm-open", 10, "open"), candidate("pm-orphan", 10, null)],
        { scope: "all-streams", minEntries: 3 },
      );
      expect(rows.every((row) => row.selected)).toBe(true);
    });

    it("applies allOver as a higher selection threshold (below_threshold above the floor)", () => {
      const rows = selectHistoryCompactBulkTargets(
        [candidate("pm-a", 50), candidate("pm-b", 20), candidate("pm-c", 3)],
        { allOver: 30, minEntries: 3 },
      );
      expect(rows.find((row) => row.id === "pm-a")).toMatchObject({ selected: true });
      expect(rows.find((row) => row.id === "pm-b")).toMatchObject({ selected: false, skip_reason: "below_threshold" });
      expect(rows.find((row) => row.id === "pm-c")).toMatchObject({ selected: false, skip_reason: "already_compact" });
    });

    it("runs in scan mode when ids is an empty list", () => {
      const rows = selectHistoryCompactBulkTargets([candidate("pm-a", 10)], { ids: [], minEntries: 3 });
      expect(rows).toEqual([{ id: "pm-a", entries: 10, selected: true, skip_reason: null }]);
    });
  });
});
