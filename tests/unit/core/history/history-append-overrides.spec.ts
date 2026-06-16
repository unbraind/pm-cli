import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { appendHistoryEntry, createHistoryEntry } from "../../../../src/core/history/history.js";
import { clearActiveExtensionHooks, setActiveExtensionServices } from "../../../../src/core/extensions/index.js";
import type { ItemDocument } from "../../../../src/types/index.js";

const FIXED_TS = "2026-02-20T00:00:00.000Z";

function doc(metadata: Record<string, unknown>, body = ""): ItemDocument {
  return { metadata, body } as unknown as ItemDocument;
}

function fullDoc(overrides: Record<string, unknown>, body = ""): ItemDocument {
  return doc(
    {
      id: "pm-history",
      title: "Title",
      description: "desc",
      type: "Task",
      status: "open",
      priority: 1,
      tags: [],
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
      ...overrides,
    },
    body,
  );
}

afterEach(() => {
  clearActiveExtensionHooks();
});

describe("createHistoryEntry empty-metadata patch branch", () => {
  it("treats an empty-metadata (tombstone) document as having no patch base", () => {
    const before = fullDoc({ id: "pm-history-empty" }, "before body");
    // An empty-metadata `after` exercises the `!hasMetadata` branch of
    // canonicalPatchDocument (the delete tombstone shape).
    const after = doc({}, "");

    const entry = createHistoryEntry({
      nowIso: FIXED_TS,
      author: "test-agent",
      op: "delete",
      before,
      after,
    });

    expect(entry.op).toBe("delete");
    expect(Array.isArray(entry.patch)).toBe(true);
    expect(entry.before_hash).not.toBe(entry.after_hash);
  });

  it("treats a document with absent metadata as having no patch base", () => {
    const before = fullDoc({ id: "pm-history-absent" }, "before body");
    // metadata absent entirely → the `document.metadata && ...` left operand is
    // falsy, the other side of the hasMetadata short-circuit.
    const after = { body: "" } as unknown as ItemDocument;

    const entry = createHistoryEntry({
      nowIso: FIXED_TS,
      author: "test-agent",
      op: "delete",
      before,
      after,
    });

    expect(entry.op).toBe("delete");
    expect(Array.isArray(entry.patch)).toBe(true);
  });

  it("normalizes missing body values to empty strings when building patch documents", () => {
    const before = fullDoc({ id: "pm-history-missing-body" });
    const after = fullDoc({ id: "pm-history-missing-body", title: "after title" });
    delete (before as { body?: string }).body;
    delete (after as { body?: string }).body;

    const entry = createHistoryEntry({
      nowIso: FIXED_TS,
      author: "test-agent",
      op: "update",
      before,
      after,
    });

    expect(entry.op).toBe("update");
    expect(Array.isArray(entry.patch)).toBe(true);
  });

  it("normalizes tombstone documents with neither metadata nor body", () => {
    const before = fullDoc({ id: "pm-history-tombstone-missing-body" }, "before body");
    const after = {} as unknown as ItemDocument;

    const entry = createHistoryEntry({
      nowIso: FIXED_TS,
      author: "test-agent",
      op: "delete",
      before,
      after,
    });

    expect(entry.op).toBe("delete");
    expect(Array.isArray(entry.patch)).toBe(true);
  });
});

describe("appendHistoryEntry object service override", () => {
  it("honours an object result that skips the write", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-history-override-"));
    try {
      const historyPath = path.join(dir, "pm-skip.jsonl");
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "history-skip",
            service: "history_append",
            run: () => ({ skip: true }),
          },
        ],
      });

      const entry = createHistoryEntry({
        nowIso: FIXED_TS,
        author: "test-agent",
        op: "update",
        before: fullDoc({ id: "pm-skip", title: "a" }),
        after: fullDoc({ id: "pm-skip", title: "b" }),
      });

      await appendHistoryEntry(historyPath, entry);
      // skip:true → nothing written.
      await expect(fs.access(historyPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      clearActiveExtensionHooks();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores a non-object handled result and writes the serialized entry", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-history-override-"));
    try {
      const historyPath = path.join(dir, "fallthrough.jsonl");
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "history-number",
            service: "history_append",
            // A numeric result is handled but matches none of the false/string/object
            // shapes → the function falls through and writes the entry itself.
            run: () => 42,
          },
        ],
      });

      const entry = createHistoryEntry({
        nowIso: FIXED_TS,
        author: "test-agent",
        op: "update",
        before: fullDoc({ id: "pm-fallthrough", title: "a" }),
        after: fullDoc({ id: "pm-fallthrough", title: "b" }),
      });

      await appendHistoryEntry(historyPath, entry);
      const written = await fs.readFile(historyPath, "utf8");
      expect(written.trim().length).toBeGreaterThan(0);
      expect(JSON.parse(written.trim())).toMatchObject({ op: "update", author: "test-agent" });
    } finally {
      clearActiveExtensionHooks();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("redirects the write to an object-supplied history path and line", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-history-override-"));
    try {
      const requestedPath = path.join(dir, "requested.jsonl");
      const redirectedPath = path.join(dir, "redirected.jsonl");
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "history-redirect",
            service: "history_append",
            run: () => ({ history_path: redirectedPath, line: "custom-line" }),
          },
        ],
      });

      const entry = createHistoryEntry({
        nowIso: FIXED_TS,
        author: "test-agent",
        op: "update",
        before: fullDoc({ id: "pm-redirect", title: "a" }),
        after: fullDoc({ id: "pm-redirect", title: "b" }),
      });

      await appendHistoryEntry(requestedPath, entry);
      await expect(fs.access(requestedPath)).rejects.toMatchObject({ code: "ENOENT" });
      const written = await fs.readFile(redirectedPath, "utf8");
      expect(written.trim()).toBe("custom-line");
    } finally {
      clearActiveExtensionHooks();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("writes object-supplied entry payloads when no explicit line is provided", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-history-override-"));
    try {
      const requestedPath = path.join(dir, "requested-entry.jsonl");
      const redirectedPath = path.join(dir, "redirected-entry.jsonl");
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "history-entry",
            service: "history_append",
            run: () => ({
              history_path: redirectedPath,
              entry: { op: "override", marker: "custom-entry" },
            }),
          },
        ],
      });

      const entry = createHistoryEntry({
        nowIso: FIXED_TS,
        author: "test-agent",
        op: "update",
        before: fullDoc({ id: "pm-redirect-entry", title: "a" }),
        after: fullDoc({ id: "pm-redirect-entry", title: "b" }),
      });

      await appendHistoryEntry(requestedPath, entry);
      await expect(fs.access(requestedPath)).rejects.toMatchObject({ code: "ENOENT" });
      const written = await fs.readFile(redirectedPath, "utf8");
      expect(JSON.parse(written.trim())).toEqual({ op: "override", marker: "custom-entry" });
    } finally {
      clearActiveExtensionHooks();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
