import { describe, expect, it } from "vitest";
import { PmCliError } from "../../../src/core/shared/errors.js";
import {
  QUERY_CURSOR_CONTRACT,
  createQueryFingerprint,
  decodeQueryCursorEnvelope,
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
    expect(decodeQueryCursorEnvelope(cursor)).toEqual({
      version: 1,
      fingerprint: first,
      after_id: "pm-second",
      after_index: 1,
      snapshot: "revision-7",
    });
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
    ]) {
      expect(() => decodeQueryCursorEnvelope(cursor)).toThrow(PmCliError);
      expect(() => decodeQueryCursor(cursor, fingerprint)).toThrow(PmCliError);
    }
    expect(decodeQueryCursorEnvelope(mismatched)).toMatchObject({
      fingerprint: createQueryFingerprint("list", { status: "closed" }),
    });
    expect(() => decodeQueryCursor(mismatched, fingerprint)).toThrow(
      PmCliError,
    );
    for (const cursor of [null, undefined, 42, {}]) {
      expect(() => decodeQueryCursorEnvelope(cursor)).toThrow(PmCliError);
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
  it("rejects invalid transport bytes and enforces the inclusive cursor length boundary", () => {
    const payload = { version: 1, fingerprint: "fp", after_id: "a" };
    const cursor = Buffer.from(JSON.stringify(payload)).toString("base64url");
    expect(decodeQueryCursorEnvelope(`  ${cursor}  `)).toEqual(payload);
    // Buffer accepts junk around base64url; the public envelope must reject it.
    for (const malformed of [`!${cursor}`, `${cursor}!`, 42, "", "bm90LWpzb24"]) {
      expect(() => decodeQueryCursorEnvelope(malformed)).toThrow("Query cursor is malformed.");
    }
    const lengthBound = { ...payload, after_id: "a".repeat(3026) };
    const atLimit = Buffer.from(JSON.stringify(lengthBound)).toString("base64url");
    expect(atLimit).toHaveLength(4096);
    expect(decodeQueryCursorEnvelope(atLimit)).toEqual(lengthBound);
    const tooLong = Buffer.from(JSON.stringify({ ...lengthBound, after_id: lengthBound.after_id + "a" })).toString("base64url");
    expect(() => decodeQueryCursorEnvelope(tooLong)).toThrow("Query cursor is malformed.");
  });

  it("keeps refusal metadata and rejects JSON values that are not cursor envelopes", () => {
    let refusal: unknown;
    try { decodeQueryCursorEnvelope("!"); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(PmCliError);
    expect(refusal).toMatchObject({ context: {
      code: "invalid_query_cursor",
      nextSteps: ["Repeat the original query without --after to obtain a fresh cursor."],
    } });
    const payload = { version: 1, fingerprint: "fp", after_id: "a" };
    for (const invalid of [null, 7, "string", [], { ...payload, fingerprint: 2 }, { ...payload, after_id: 2 }, { ...payload, after_id: ["a"] }, { ...payload, snapshot: 1 }, { ...payload, snapshot: ["x"] }]) {
      expect(() => decodeQueryCursorEnvelope(Buffer.from(JSON.stringify(invalid)).toString("base64url"))).toThrow("Query cursor version or payload is unsupported.");
    }
    expect(() => decodeQueryCursor(encodeQueryCursor("old", "a"), "new")).toThrow("Query cursor does not match the current filters, sort, or query (old != new).");
  });

  it("emits the actual last row and position across consecutive one-row and three-row pages", () => {
    const rows = ["a", "b", "c", "d"];
    for (const limit of [1, 3]) {
      const page = paginateQueryRows(rows, { fingerprint: "fp", limit, readId: (id) => id });
      expect(decodeQueryCursorState(page.next_cursor, "fp")).toEqual({ after_id: rows[limit - 1], after_index: limit - 1 });
    }
    expect(resolveQueryCursorStart(rows, encodeQueryCursor("fp", "a"), "fp", (id) => id)).toBe(1);
    expect(createQueryFingerprint("list", {})).toHaveLength(24);
    expect(decodeQueryCursorState(encodeQueryCursor("fp", "a"), "fp")).toStrictEqual({ after_id: "a" });
    expect(paginateQueryRows([undefined, "a"], { fingerprint: "fp", limit: 1, readId: () => "missing" })).toStrictEqual({ rows: [undefined], has_more: true });
    expect(selectCursorSemanticOptions({ "Stryker was here": 1 }, [{ flag: "--limit", cursor_semantics: "presentation" }])).toEqual({ "Stryker was here": 1 });
    expect(selectCursorSemanticOptions({ "prefix-Value": 1, prefixvalue: 2 }, [{ flag: "prefix--value", cursor_semantics: "presentation" }])).toEqual({ prefixvalue: 2 });
    // Separating the command from the JSON contract prevents concatenation collisions.
    expect(createQueryFingerprint("x1", 2)).not.toBe(createQueryFingerprint("x", 12));
    expect(selectCursorSemanticOptions({ limit: 1, strykerWasHere: 2 }, [{ flag: "--limit", cursor_semantics: "presentation" }])).toEqual({ strykerWasHere: 2 });
  });

});
