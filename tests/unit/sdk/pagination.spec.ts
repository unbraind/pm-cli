import { describe, expect, it } from "vitest";
import { PmCliError } from "../../../src/core/shared/errors.js";
import {
  QUERY_CURSOR_CONTRACT,
  createQueryFingerprint,
  decodeQueryCursor,
  encodeQueryCursor,
  paginateQueryRows,
  resolveQueryCursorStart,
} from "../../../src/sdk/pagination.js";

describe("SDK query pagination", () => {
  it("creates stable fingerprints and resumes after the encoded id", () => {
    const first = createQueryFingerprint("list", {
      status: "open",
      filters: { tag: "sdk", priority: 1 },
    });
    const reordered = createQueryFingerprint("list", {
      filters: { priority: 1, tag: "sdk" },
      status: "open",
    });
    expect(first).toBe(reordered);
    expect(first).not.toBe(
      createQueryFingerprint("search", { status: "open" }),
    );

    const cursor = encodeQueryCursor(first, "pm-second");
    expect(decodeQueryCursor(cursor, first)).toBe("pm-second");
    expect(
      resolveQueryCursorStart(
        [{ id: "pm-first" }, { id: "pm-second" }, { id: "pm-third" }],
        cursor,
        first,
        (row) => row.id,
      ),
    ).toBe(2);
    expect(resolveQueryCursorStart([], undefined, first, () => "")).toBe(0);
    expect(QUERY_CURSOR_CONTRACT).toEqual({ version: 1, max_length: 4096 });
  });

  it("rejects malformed, mismatched, unsupported, and stale cursors", () => {
    const fingerprint = createQueryFingerprint("list", { status: "open" });
    const mismatched = encodeQueryCursor(
      createQueryFingerprint("list", { status: "closed" }),
      "pm-first",
    );
    const unsupported = Buffer.from(
      JSON.stringify({ version: 2, fingerprint, after_id: "pm-first" }),
    ).toString("base64url");
    const invalidPayload = Buffer.from(JSON.stringify([])).toString(
      "base64url",
    );
    const emptyId = Buffer.from(
      JSON.stringify({ version: 1, fingerprint, after_id: "" }),
    ).toString("base64url");

    for (const cursor of [
      "",
      "%%%",
      "a".repeat(4097),
      Buffer.from("not-json").toString("base64url"),
      invalidPayload,
      unsupported,
      emptyId,
      mismatched,
    ]) {
      expect(() => decodeQueryCursor(cursor, fingerprint)).toThrow(PmCliError);
    }
    const stale = encodeQueryCursor(fingerprint, "pm-missing");
    expect(() =>
      resolveQueryCursorStart(
        [{ id: "pm-present" }],
        stale,
        fingerprint,
        (row) => row.id,
      ),
    ).toThrow(/no longer present/);
  });

  it("returns bounded ordered pages with continuation metadata", () => {
    const rows = [{ id: "pm-a" }, { id: "pm-b" }, { id: "pm-c" }];
    const fingerprint = createQueryFingerprint("list", { status: "open" });
    const first = paginateQueryRows(rows, {
      fingerprint,
      limit: 2,
      readId: (row) => row.id,
    });
    expect(first).toMatchObject({ rows: rows.slice(0, 2), has_more: true });
    expect(
      paginateQueryRows(rows, {
        cursor: first.next_cursor,
        fingerprint,
        limit: 2,
        readId: (row) => row.id,
      }),
    ).toEqual({ rows: rows.slice(2), has_more: false });
  });
});
