import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendHistoryEntry, createHistoryEntry, hashDocument, hashEmptyDocument } from "../../src/history.js";
import { canonicalDocument, parseItemDocument, serializeItemDocument } from "../../src/item-format.js";
import { normalizeItemId, normalizePrefix } from "../../src/id.js";
import { parseCsvKv, parseOptionalNumber, parseTags } from "../../src/parse.js";
import { orderObject, stableStringify } from "../../src/serialization.js";
import { isNoneToken, resolveIsoOrRelative } from "../../src/time.js";

describe("deterministic primitives", () => {
  it("normalizes tags and ids deterministically", () => {
    expect(parseTags("BETA, alpha,alpha , gamma")).toEqual(["alpha", "beta", "gamma"]);
    expect(parseTags("none")).toEqual([]);
    expect(normalizePrefix("PM")).toBe("pm-");
    expect(normalizeItemId("#A1", "pm-")).toBe("pm-a1");
  });

  it("parses csv kv values with quoted strings", () => {
    const parsed = parseCsvKv('path=README.md,scope=project,note="quoted value"', "--file");
    expect(parsed.path).toBe("README.md");
    expect(parsed.scope).toBe("project");
    expect(parsed.note).toBe("quoted value");
  });

  it("handles none and deadline resolution", () => {
    expect(isNoneToken(undefined)).toBe(false);
    expect(isNoneToken("none")).toBe(true);
    expect(isNoneToken(" null ")).toBe(true);
    expect(() => parseOptionalNumber("not-a-number", "n")).toThrow();
    expect(() => resolveIsoOrRelative("bad-date")).toThrow();

    const now = new Date("2026-02-18T00:00:00.000Z");
    const plusOneHour = resolveIsoOrRelative("+1h", now);
    const plusOneDay = resolveIsoOrRelative("+1d", now);
    const plusOneWeek = resolveIsoOrRelative("+1w", now);
    expect(plusOneHour).toBe("2026-02-18T01:00:00.000Z");
    expect(plusOneDay).toBe("2026-02-19T00:00:00.000Z");
    expect(plusOneWeek).toBe("2026-02-25T00:00:00.000Z");
  });

  it("maintains stable ordering and document serialization", () => {
    const ordered = orderObject({ b: 2, a: 1 }, ["a", "b"]);
    expect(Object.keys(ordered)).toEqual(["a", "b"]);
    expect(stableStringify({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');

    const serialized = serializeItemDocument({
      front_matter: {
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
    expect(parsed.front_matter.tags).toEqual(["alpha", "beta"]);
    expect(parsed.body).toBe("Body");
  });

  it("creates deterministic history hashes and patches", () => {
    const before = canonicalDocument({
      front_matter: {
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
      front_matter: {
        ...before.front_matter,
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
        path: "/front_matter/updated_at",
        value: "2026-02-18T00:10:00.000Z",
      },
      {
        op: "replace",
        path: "/front_matter/title",
        value: "After",
      },
    ]);
    expect(entry.before_hash).toBe(hashDocument(before));
    expect(entry.after_hash).toBe(hashDocument(after));

    const reorderedBefore = canonicalDocument({
      front_matter: {
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
      front_matter: {
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

  it("returns a deterministic empty canonical document hash", () => {
    const first = hashEmptyDocument();
    const second = hashEmptyDocument();
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats missing body as empty string for empty front matter hashing", () => {
    const withMissingBody = hashDocument({
      front_matter: {} as never,
      body: undefined as unknown as string,
    });
    const withEmptyBody = hashDocument({
      front_matter: {} as never,
      body: "",
    });
    expect(withMissingBody).toBe(withEmptyBody);
  });

  it("appends history entries without rewriting previous lines", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-history-append-"));
    const historyPath = path.join(tempDir, "pm-a1.jsonl");

    const baseDocument = canonicalDocument({
      front_matter: {
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
      front_matter: {
        ...baseDocument.front_matter,
        title: "Second",
        updated_at: "2026-02-18T00:05:00.000Z",
      },
      body: "first update",
    });
    const thirdDocument = canonicalDocument({
      front_matter: {
        ...secondDocument.front_matter,
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
