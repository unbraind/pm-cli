import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendHistoryEntry, createHistoryEntry, hashDocument, hashEmptyDocument } from "../../src/core/history/history.js";
import { canonicalDocument, parseItemDocument, serializeItemDocument } from "../../src/core/item/item-format.js";
import { normalizeItemId, normalizePrefix } from "../../src/core/item/id.js";
import { parseCsvKv, parseOptionalNumber, parseTags } from "../../src/core/item/parse.js";
import { orderObject, stableStringify } from "../../src/core/shared/serialization.js";
import { resolveIsoOrRelative } from "../../src/core/shared/time.js";

describe("deterministic primitives", () => {
  it("normalizes tags and ids deterministically", () => {
    expect(parseTags("BETA, alpha,alpha , gamma")).toEqual(["alpha", "beta", "gamma"]);
    expect(parseTags("none")).toEqual(["none"]);
    expect(normalizePrefix("PM")).toBe("pm-");
    expect(normalizeItemId("#A1", "pm-")).toBe("pm-a1");
  });

  it("parses csv kv values with quoted strings", () => {
    const parsed = parseCsvKv('path=README.md,scope=project,note="quoted value"', "--file");
    expect(parsed.path).toBe("README.md");
    expect(parsed.scope).toBe("project");
    expect(parsed.note).toBe("quoted value");
  });

  it("handles deadline resolution", () => {
    expect(() => parseOptionalNumber("not-a-number", "n")).toThrow();
    expect(() => resolveIsoOrRelative("bad-date")).toThrow();

    const now = new Date("2026-02-18T00:00:00.000Z");
    const plusOneHour = resolveIsoOrRelative("+1h", now);
    const plusOneDay = resolveIsoOrRelative("+1d", now);
    const plusOneWeek = resolveIsoOrRelative("+1w", now);
    const plusOneMonth = resolveIsoOrRelative("+1m", now);
    const minusOneDay = resolveIsoOrRelative("-1d", now);
    const nowToken = resolveIsoOrRelative("now", now);
    expect(plusOneHour).toBe("2026-02-18T01:00:00.000Z");
    expect(plusOneDay).toBe("2026-02-19T00:00:00.000Z");
    expect(plusOneWeek).toBe("2026-02-25T00:00:00.000Z");
    expect(plusOneMonth).toBe("2026-03-18T00:00:00.000Z");
    expect(minusOneDay).toBe("2026-02-17T00:00:00.000Z");
    expect(nowToken).toBe("2026-02-18T00:00:00.000Z");

    const monthEdge = new Date("2026-01-31T00:00:00.000Z");
    expect(resolveIsoOrRelative("+1m", monthEdge)).toBe("2026-02-28T00:00:00.000Z");

    expect(resolveIsoOrRelative("2026-03-31T13-59Z", now)).toBe("2026-03-31T13:59:00.000Z");
    expect(resolveIsoOrRelative("20260331", now)).toBe("2026-03-31T00:00:00.000Z");
    expect(resolveIsoOrRelative("20260331T135900Z", now)).toBe("2026-03-31T13:59:00.000Z");
  });

  it("rejects impossible calendar dates instead of silently rolling over", () => {
    const now = new Date("2026-05-30T00:00:00.000Z");
    // 2026-02-30 previously parsed to 2026-03-02 via JS Date rollover, silently
    // storing the wrong deadline; it must now be a clear usage error.
    expect(() => resolveIsoOrRelative("2026-02-30", now, "deadline")).toThrow(/February 2026 has 28 days/);
    expect(() => resolveIsoOrRelative("2026-04-31", now, "start")).toThrow(/Invalid start value/);
    expect(() => resolveIsoOrRelative("20260230", now, "deadline")).toThrow(/does not exist/);
    expect(() => resolveIsoOrRelative("2026-13-99", now, "deadline")).toThrow(/Month "13" is out of range/);
    // Non-leap-year Feb 29 is impossible; a real leap day is accepted.
    expect(() => resolveIsoOrRelative("2026-02-29", now, "deadline")).toThrow(/February 2026 has 28 days/);
    expect(resolveIsoOrRelative("2028-02-29", now, "deadline")).toBe("2028-02-29T00:00:00.000Z");
    expect(resolveIsoOrRelative("2026-01-31", now, "deadline")).toBe("2026-01-31T00:00:00.000Z");
    // A valid literal day must not be false-rejected when a tz offset shifts the UTC instant.
    expect(() => resolveIsoOrRelative("2026-02-28T23:30:00-05:00", now, "deadline")).not.toThrow();
    // Z-suffixed and no-separator compact datetimes must still be guarded.
    expect(() => resolveIsoOrRelative("2026-02-30Z", now, "deadline")).toThrow(/February 2026 has 28 days/);
    expect(() => resolveIsoOrRelative("20260230135900Z", now, "deadline")).toThrow(/does not exist/);
    // Relative tokens and "now" are not literal calendar dates and must pass through untouched.
    for (const token of ["now", "+3d", "-2w", "+6m"]) {
      expect(() => resolveIsoOrRelative(token, now, "deadline")).not.toThrow();
    }
  });

  it("maintains stable ordering and document serialization", () => {
    const ordered = orderObject({ b: 2, a: 1 }, ["a", "b"]);
    expect(Object.keys(ordered)).toEqual(["a", "b"]);
    expect(stableStringify({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');

    const serialized = serializeItemDocument({
      metadata: {
        id: "pm-ab1",
        title: "Title",
        description: "Description",
        type: "Task",
        status: "open",
        priority: 1,
        tags: ["beta", "alpha"],
        created_at: "2026-02-18T00:00:00.000Z",
        updated_at: "2026-02-18T00:00:00.000Z",
      },
      body: "Body",
    });
    const parsed = parseItemDocument(serialized);
    expect(parsed.metadata.tags).toEqual(["alpha", "beta"]);
    expect(parsed.body).toBe("Body");
  });

  it("creates deterministic history hashes and patches", () => {
    const before = canonicalDocument({
      metadata: {
        id: "pm-a1",
        title: "Before",
        description: "Before",
        type: "Task",
        status: "open",
        priority: 1,
        tags: ["a"],
        created_at: "2026-02-18T00:00:00.000Z",
        updated_at: "2026-02-18T00:00:00.000Z",
      },
      body: "",
    });
    const after = canonicalDocument({
      metadata: {
        ...before.metadata,
        title: "After",
        updated_at: "2026-02-18T00:10:00.000Z",
      },
      body: "Body",
    });
    const entry = createHistoryEntry({
      nowIso: "2026-02-18T00:10:00.000Z",
      author: "tester",
      op: "update",
      before,
      after,
      message: "update title and body",
    });
    expect(entry.patch).toEqual([
      {
        op: "replace",
        path: "/body",
        value: "Body",
      },
      {
        op: "replace",
        path: "/metadata/updated_at",
        value: "2026-02-18T00:10:00.000Z",
      },
      {
        op: "replace",
        path: "/metadata/title",
        value: "After",
      },
    ]);
    expect(entry.before_hash).toBe(hashDocument(before));
    expect(entry.after_hash).toBe(hashDocument(after));

    const reorderedBefore = canonicalDocument({
      metadata: {
        tags: ["a"],
        priority: 1,
        status: "open",
        type: "Task",
        description: "Before",
        title: "Before",
        id: "pm-a1",
        updated_at: "2026-02-18T00:00:00.000Z",
        created_at: "2026-02-18T00:00:00.000Z",
      },
      body: "",
    });
    const reorderedAfter = canonicalDocument({
      metadata: {
        updated_at: "2026-02-18T00:10:00.000Z",
        title: "After",
        created_at: "2026-02-18T00:00:00.000Z",
        id: "pm-a1",
        description: "Before",
        type: "Task",
        status: "open",
        priority: 1,
        tags: ["a"],
      },
      body: "Body",
    });
    const reorderedEntry = createHistoryEntry({
      nowIso: "2026-02-18T00:10:00.000Z",
      author: "tester",
      op: "update",
      before: reorderedBefore,
      after: reorderedAfter,
      message: "same mutation with reordered keys",
    });
    expect(reorderedEntry.patch).toEqual(entry.patch);
    expect(reorderedEntry.before_hash).toBe(entry.before_hash);
    expect(reorderedEntry.after_hash).toBe(entry.after_hash);
  });

  it("normalizes replace ops to add when a patch path is absent", () => {
    const baseFrontMatter = {
      id: "pm-a1",
      title: "Patch mode",
      description: "Patch mode",
      type: "Task" as const,
      status: "open" as const,
      priority: 1,
      tags: ["history"],
      created_at: "2026-02-18T00:00:00.000Z",
      updated_at: "2026-02-18T00:05:00.000Z",
    };
    const before = canonicalDocument({
      metadata: {
        ...baseFrontMatter,
        tests: [
          {
            command: "node scripts/run-tests.mjs test",
            scope: "project",
            pm_context_mode: undefined as unknown as string,
          },
        ],
      },
      body: "",
    });
    const after = canonicalDocument({
      metadata: {
        ...baseFrontMatter,
        updated_at: "2026-02-18T00:06:00.000Z",
        tests: [
          {
            command: "node scripts/run-tests.mjs test",
            scope: "project",
            pm_context_mode: "schema",
          },
        ],
      },
      body: "",
    });
    const entry = createHistoryEntry({
      nowIso: "2026-02-18T00:06:00.000Z",
      author: "tester",
      op: "tests_add",
      before,
      after,
      message: "set per-linked-test pm_context_mode",
    });
    expect(entry.patch).toContainEqual({
      op: "add",
      path: "/metadata/tests/0/pm_context_mode",
      value: "schema",
    });
    expect(
      entry.patch.some(
        (operation) => operation.op === "replace" && operation.path === "/metadata/tests/0/pm_context_mode",
      ),
    ).toBe(false);
  });

  it("returns a deterministic empty canonical document hash", () => {
    const first = hashEmptyDocument();
    const second = hashEmptyDocument();
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats missing body as empty string for empty metadata hashing", () => {
    const withMissingBody = hashDocument({
      metadata: {} as never,
      body: undefined as unknown as string,
    });
    const withEmptyBody = hashDocument({
      metadata: {} as never,
      body: "",
    });
    expect(withMissingBody).toBe(withEmptyBody);
  });

  it("appends history entries without rewriting previous lines", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-history-append-"));
    const historyPath = path.join(tempDir, "pm-a1.jsonl");

    const baseDocument = canonicalDocument({
      metadata: {
        id: "pm-a1",
        title: "Initial",
        description: "Initial",
        type: "Task",
        status: "open",
        priority: 1,
        tags: ["history"],
        created_at: "2026-02-18T00:00:00.000Z",
        updated_at: "2026-02-18T00:00:00.000Z",
      },
      body: "",
    });
    const secondDocument = canonicalDocument({
      metadata: {
        ...baseDocument.metadata,
        title: "Second",
        updated_at: "2026-02-18T00:05:00.000Z",
      },
      body: "first update",
    });
    const thirdDocument = canonicalDocument({
      metadata: {
        ...secondDocument.metadata,
        title: "Third",
        updated_at: "2026-02-18T00:10:00.000Z",
      },
      body: "second update",
    });

    const firstEntry = createHistoryEntry({
      nowIso: "2026-02-18T00:05:00.000Z",
      author: "tester",
      op: "update",
      before: baseDocument,
      after: secondDocument,
      message: "first update",
    });
    const secondEntry = createHistoryEntry({
      nowIso: "2026-02-18T00:10:00.000Z",
      author: "tester",
      op: "update",
      before: secondDocument,
      after: thirdDocument,
      message: "second update",
    });

    try {
      await appendHistoryEntry(historyPath, firstEntry);
      const afterFirstAppend = await readFile(historyPath, "utf8");
      expect(afterFirstAppend).toBe(`${JSON.stringify(firstEntry)}\n`);

      await appendHistoryEntry(historyPath, secondEntry);
      const finalContent = await readFile(historyPath, "utf8");
      const lines = finalContent.trim().split("\n");

      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(JSON.stringify(firstEntry));
      expect(lines[1]).toBe(JSON.stringify(secondEntry));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
