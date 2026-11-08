import { describe, expect, it } from "vitest";
import { compactReadOutputToBudget } from "../../../../src/sdk/read-output-budget.js";
import {
  PM_READ_OUTPUT_SURFACES,
  PM_READ_OUTPUT_TAIL_RETENTION_POLICIES,
  applyReadOutputDimensions,
  decodeReadOutputContinuationCursor,
  encodeReadOutputContinuationCursor,
  isReadOutputBudgetExceeded,
  readOutputCollectionFingerprint,
  readOutputRetainsTail,
  validateReadOutputOptions,
  type PmReadOutputReceipt,
} from "../../../../src/sdk/read-output-contracts.js";
import { boundReadOutputRows, sliceReadOutputRowCollection } from "../../../../src/sdk/read-output-rows.js";

/**
 * pm-8s53lj: a bounded read of a chronological annotation collection keeps
 * its newest entries and pages backwards, matching the producer's latest-N
 * --limit, while every other surface still keeps its first rows.
 */

type Row = { index: number; created_at: string; text: string };

function annotationRows(count: number): Row[] {
  return Array.from({ length: count }, (_, position) => ({
    index: position + 1,
    created_at: `2026-11-${String((position % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    text: `entry ${position + 1} ${"x".repeat(300)}`,
  }));
}

function bounded(
  command: "comments" | "notes" | "learnings",
  rows: Row[],
  options: Record<string, unknown>,
): Record<string, unknown> {
  const result = applyReadOutputDimensions(command, options, { id: "pm-tail", [command]: rows, count: rows.length });
  if (isReadOutputBudgetExceeded(result)) throw new Error("Expected retained rows, not an omission.");
  return result as Record<string, unknown>;
}

describe("newest-tail retention for annotation reads (pm-8s53lj)", () => {
  it("declares tail retention only for the chronological annotation surfaces", () => {
    expect(Object.keys(PM_READ_OUTPUT_TAIL_RETENTION_POLICIES).sort()).toEqual(["comments", "learnings", "notes"]);
    for (const command of Object.keys(PM_READ_OUTPUT_TAIL_RETENTION_POLICIES)) {
      expect(PM_READ_OUTPUT_SURFACES).toContain(command);
      expect(readOutputRetainsTail(command, command)).toBe(true);
    }
    expect(readOutputRetainsTail("comments", "notes")).toBe(false);
    expect(readOutputRetainsTail("list", "items")).toBe(false);
    expect(readOutputRetainsTail("toString", "toString")).toBe(false);
    expect(readOutputRetainsTail(undefined, "comments")).toBe(false);
  });

  it.each(["comments", "notes", "learnings"] as const)(
    "keeps the newest %s under a budget and pages backwards to the oldest",
    (command) => {
      const rows = annotationRows(60);
      const first = bounded(command, rows, { outputBudget: 1500 });
      const page = first[command] as Row[];
      expect(page.length).toBeGreaterThan(1);
      expect(page.length).toBeLessThan(rows.length);
      // Budget compaction may also shorten strings, so rows are compared by index.
      expect(page.at(-1)!.index).toBe(60);
      expect(page[0]!.index).toBe(rows.length - page.length + 1);
      expect(first).toMatchObject({ count: page.length, total_count: 60, has_more: true, continuation_kind: "output_cursor" });
      const cursor = decodeReadOutputContinuationCursor(String(first.next_cursor));
      expect(cursor).toMatchObject({ command, path: command, offset: 60 - page.length, total_rows: 60, direction: "backward" });
      expect(first.output_budget_truncation).toMatchObject({
        continuations: [{ path: command, retained_rows: page.length, remaining_rows: 60 - page.length, total_rows: 60 }],
      });

      const seen: number[] = page.map((row) => row.index);
      let next: unknown = first.next_cursor;
      let pages = 0;
      while (typeof next === "string") {
        const replay = bounded(command, rows, { outputBudget: 1500, outputCursor: next });
        const older = replay[command] as Row[];
        expect(older.at(-1)!.index).toBe(seen[0]! - 1);
        seen.unshift(...older.map((row) => row.index));
        next = replay.next_cursor;
        pages += 1;
        expect(pages).toBeLessThan(20);
      }
      expect(seen).toEqual(rows.map((row) => row.index));
    },
  );

  it("retains the newest rows for --output-limit and reports the complete size", () => {
    const rows = annotationRows(5);
    const limited = bounded("comments", rows, { outputLimit: 2 });
    expect((limited.comments as Row[]).map((row) => row.index)).toEqual([4, 5]);
    expect(limited).toMatchObject({ count: 2, total_count: 5, has_more: true, truncated: true });
    const complete = bounded("comments", rows.slice(0, 2), { outputLimit: 2 });
    expect(complete).not.toHaveProperty("total_count");
    const list = applyReadOutputDimensions("list", { outputLimit: 2 }, { items: rows, count: 5 }) as Record<string, unknown>;
    expect((list.items as Row[]).map((row) => row.index)).toEqual([1, 2]);
    expect(list).not.toHaveProperty("total_count");
  });

  it("keeps a producer total that counts more than the producer page (MCP lists 20)", () => {
    const page = annotationRows(20).map((row) => ({ ...row, index: row.index + 40 }));
    const limited = bounded("comments", page, { outputLimit: 2 });
    expect(limited).toMatchObject({ total_count: 20 });
    const withTotal = applyReadOutputDimensions(
      "comments",
      { outputLimit: 2 },
      { id: "pm-tail", comments: page, count: 20, total_count: 60, returned_count: 20 },
    ) as Record<string, unknown>;
    expect((withTotal.comments as Row[]).map((row) => row.index)).toEqual([59, 60]);
    expect(withTotal).toMatchObject({ total_count: 60, count: 2, returned_count: 2 });
    const compacted = applyReadOutputDimensions(
      "comments",
      { outputBudget: 1500 },
      { id: "pm-tail", comments: page, count: 20, total_count: 60, returned_count: 20 },
    ) as Record<string, unknown>;
    expect(compacted).toMatchObject({ total_count: 60, has_more: true });
  });

  it("reports the delivered page on a replay that needs no further compaction", () => {
    const rows = annotationRows(40);
    const first = bounded("learnings", rows, { outputBudget: 1500 });
    const cursor = decodeReadOutputContinuationCursor(String(first.next_cursor));
    const replay = applyReadOutputDimensions(
      "learnings",
      { outputBudget: "unbounded", outputCursor: first.next_cursor },
      { id: "pm-tail", learnings: rows, count: 40, returned_count: 40 },
    ) as Record<string, unknown>;
    expect((replay.learnings as Row[]).length).toBe(cursor.offset);
    expect(replay).toMatchObject({ count: cursor.offset, returned_count: cursor.offset });
    const bare = applyReadOutputDimensions(
      "learnings",
      { outputBudget: "unbounded", outputCursor: first.next_cursor },
      { id: "pm-tail", learnings: rows },
    ) as Record<string, unknown>;
    expect(bare).not.toHaveProperty("count");
  });

  it("refuses universal output controls on a learnings mutation before it can write", () => {
    for (const key of ["add", "stdin", "file", "edit", "delete"]) {
      expect(() => validateReadOutputOptions("learnings", { [key]: key === "stdin" ? true : 1, outputCursor: "cursor" })).toThrow(
        "Universal output controls cannot be combined with a learnings mutation.",
      );
    }
    expect(() => validateReadOutputOptions("learnings", { limit: "5", outputBudget: 500 })).not.toThrow();
  });

  it("refreshes a producer returned_count with the delivered page", () => {
    const rows = annotationRows(40);
    const result = applyReadOutputDimensions(
      "comments",
      { outputBudget: 1500 },
      { id: "pm-tail", comments: rows, count: 40, total_count: 40, returned_count: 40 },
    ) as Record<string, unknown>;
    expect(result.returned_count).toBe((result.comments as Row[]).length);
    expect(result.total_count).toBe(40);
  });

  it("refuses a cursor issued under the other retention direction", () => {
    const rows = annotationRows(30);
    const fingerprint = readOutputCollectionFingerprint("comments", rows, "comments");
    const forward = encodeReadOutputContinuationCursor({ command: "comments", path: "comments", offset: 10, total_rows: 30, fingerprint });
    expect(() => bounded("comments", rows, { outputCursor: forward })).toThrow(
      expect.objectContaining({ context: expect.objectContaining({ code: "read_output_cursor_stale" }) }),
    );
    const listRows = rows.map((row) => ({ ...row, id: `pm-${row.index}` }));
    const backward = encodeReadOutputContinuationCursor({
      command: "list",
      path: "items",
      offset: 10,
      total_rows: 30,
      fingerprint: readOutputCollectionFingerprint("items", listRows, "list"),
      direction: "backward",
    });
    expect(() => applyReadOutputDimensions("list", { outputCursor: backward }, { items: listRows, count: 30 })).toThrow(
      expect.objectContaining({ context: expect.objectContaining({ code: "read_output_cursor_stale" }) }),
    );
  });

  it("round-trips the direction and rejects an unknown one", () => {
    const encoded = encodeReadOutputContinuationCursor({
      command: "notes",
      path: "notes",
      offset: 3,
      total_rows: 9,
      fingerprint: "f",
      direction: "backward",
    });
    expect(decodeReadOutputContinuationCursor(encoded)).toEqual({
      version: 1,
      command: "notes",
      path: "notes",
      offset: 3,
      total_rows: 9,
      fingerprint: "f",
      direction: "backward",
    });
    const forward = encodeReadOutputContinuationCursor({ command: "notes", path: "notes", offset: 3, total_rows: 9, fingerprint: "f" });
    expect(decodeReadOutputContinuationCursor(forward)).not.toHaveProperty("direction");
    const sideways = Buffer.from(JSON.stringify({ v: 1, c: "notes", p: "notes", o: 3, n: 9, f: "f", d: "s" })).toString("base64url");
    expect(() => decodeReadOutputContinuationCursor(sideways)).toThrow(
      expect.objectContaining({ context: expect.objectContaining({ code: "read_output_cursor_invalid" }) }),
    );
  });

  it("bounds object-map and array rows from either end", () => {
    const result = { rows: { a: 1, b: 2, c: 3 }, list: [1, 2, 3], row_contract: { command: "x", row_keys: ["rows", "list"] } };
    expect(boundReadOutputRows(result, 2, (path) => path === "rows").result).toMatchObject({ rows: { b: 2, c: 3 }, list: [1, 2] });
    expect(boundReadOutputRows(result, 2).result).toMatchObject({ rows: { a: 1, b: 2 }, list: [1, 2] });
    expect(sliceReadOutputRowCollection(result, "list", 0, 2)).toMatchObject({ list: [1, 2] });
    expect(sliceReadOutputRowCollection(result, "rows", 1, 2)).toMatchObject({ rows: { b: 2 } });
    const focus = {
      high_level: [{ id: "a" }, { id: "b" }, { id: "c" }],
      summary: { returned_focus: {}, focus_row_states: { high_level: "ioO" } },
      row_contract: { command: "context", row_keys: ["high_level"] },
    };
    const sliced = sliceReadOutputRowCollection(focus, "high_level", 0, 2) as { summary: { focus_row_states: { high_level: string } } };
    expect(sliced.summary.focus_row_states.high_level).toBe("io");
  });

  it("compacts a keyed row map from its tail when the predicate selects it", () => {
    const receipt = { estimated_tokens: 0 } as PmReadOutputReceipt;
    const rows = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`k${index}`, "y".repeat(200)]));
    const compacted = compactReadOutputToBudget(
      { rows, row_contract: { command: "x", row_keys: ["rows"] } },
      receipt,
      400,
      new Map(),
      "json",
      undefined,
      false,
      (path) => path === "rows",
    );
    const keys = Object.keys(compacted.rows as Record<string, unknown>);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.at(-1)).toBe("k29");
    // Without a predicate every collection keeps its first rows, as before.
    const headReceipt = { estimated_tokens: 0 } as PmReadOutputReceipt;
    const head = compactReadOutputToBudget({ rows, row_contract: { command: "x", row_keys: ["rows"] } }, headReceipt, 400);
    expect(Object.keys(head.rows as Record<string, unknown>)[0]).toBe("k0");
    expect(Object.keys(head.rows as Record<string, unknown>)).not.toContain("k29");
  });
});
