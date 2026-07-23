import { describe, expect, it } from "vitest";
import { PmCliError } from "../../../src/core/shared/errors.js";
import {
  QUERY_CURSOR_CONTRACT,
  createQueryFingerprint,
  decodeQueryCursorState,
  decodeQueryCursor,
  encodeQueryCursor,
  paginateQueryRows,
  resolveQueryCursorStart,
  selectCursorSemanticOptions,
} from "../../../src/sdk/pagination.js";
import {
  CONTEXT_FLAG_CONTRACTS,
  LIST_FILTER_FLAG_CONTRACTS,
  SEARCH_FLAG_CONTRACTS,
} from "../../../src/sdk/cli-contracts/flag-contracts.js";

describe("SDK query pagination", () => {
  it("derives semantic cursor identity from compact presentation exceptions", () => {
    expect(
      [
        ...LIST_FILTER_FLAG_CONTRACTS,
        ...CONTEXT_FLAG_CONTRACTS,
        ...SEARCH_FLAG_CONTRACTS,
      ].filter((contract) => contract.cursor_semantics === "presentation")
        .length,
    ).toBeGreaterThan(0);
    expect(
      selectCursorSemanticOptions(
        {
          status: "open",
          limit: "10",
          maxItems: "10",
          tokenBudget: "900",
          explainRanking: true,
        },
        CONTEXT_FLAG_CONTRACTS,
      ),
    ).toEqual({ status: "open", tokenBudget: "900" });
    expect(
      selectCursorSemanticOptions({ futureFilter: "value" }, [
        { flag: "--future-filter" },
      ]),
    ).toEqual({ futureFilter: "value" });
  });

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

    const cursor = encodeQueryCursor(first, "pm-second", 1, "revision-7");
    expect(decodeQueryCursor(cursor, first)).toBe("pm-second");
    expect(decodeQueryCursorState(cursor, first)).toEqual({
      after_id: "pm-second",
      after_index: 1,
      snapshot: "revision-7",
    });
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

  it("rejects malformed, mismatched, and unsupported cursors", () => {
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
    for (const cursor of [null, undefined, 42, {}]) {
      expect(() => decodeQueryCursor(cursor, fingerprint)).toThrow(PmCliError);
    }
    const invalidIndex = Buffer.from(
      JSON.stringify({
        version: 1,
        fingerprint,
        after_id: "pm-first",
        after_index: -1,
      }),
    ).toString("base64url");
    expect(() => decodeQueryCursor(invalidIndex, fingerprint)).toThrow(
      PmCliError,
    );
    const invalidSnapshot = Buffer.from(
      JSON.stringify({
        version: 1,
        fingerprint,
        after_id: "pm-first",
        snapshot: "",
      }),
    ).toString("base64url");
    expect(() => decodeQueryCursor(invalidSnapshot, fingerprint)).toThrow(
      PmCliError,
    );
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

  it("resumes by the recorded position when concurrent mutation removes the cursor row", () => {
    const fingerprint = createQueryFingerprint("list", { status: "open" });
    const cursor = encodeQueryCursor(fingerprint, "pm-removed", 1);
    expect(
      resolveQueryCursorStart(
        [{ id: "pm-first" }, { id: "pm-third" }, { id: "pm-fourth" }],
        cursor,
        fingerprint,
        (row) => row.id,
      ),
    ).toBe(1);
    expect(
      paginateQueryRows(
        [{ id: "pm-first" }, { id: "pm-third" }, { id: "pm-fourth" }],
        {
          cursor,
          fingerprint,
          limit: 2,
          readId: (row) => row.id,
        },
      ),
    ).toMatchObject({
      rows: [{ id: "pm-third" }, { id: "pm-fourth" }],
      has_more: false,
    });
    expect(
      resolveQueryCursorStart(
        [{ id: "pm-first" }],
        encodeQueryCursor(fingerprint, "pm-removed", 99),
        fingerprint,
        (row) => row.id,
      ),
    ).toBe(1);
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
    expect(() =>
      paginateQueryRows(rows, {
        cursor: encodeQueryCursor(fingerprint, "pm-a", 0, "revision-1"),
        fingerprint,
        limit: 2,
        readId: (row) => row.id,
        snapshot: "revision-2",
      }),
    ).toThrow(/requested snapshot/);
    expect(
      paginateQueryRows(rows, {
        fingerprint,
        limit: 0,
        readId: (row) => row.id,
      }),
    ).toEqual({ rows: [], has_more: false });
  });
});
