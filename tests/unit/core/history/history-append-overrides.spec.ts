import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendHistoryEntry,
  createHistoryEntry,
} from "../../../../src/core/history/history.js";
import {
  clearActiveExtensionHooks,
  setActiveExtensionServices,
} from "../../../../src/core/extensions/index.js";
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

async function trackerHistoryPath(
  tempRoot: string,
  filename: string,
): Promise<string> {
  const historyRoot = path.join(tempRoot, ".agents", "pm", "history");
  await fs.mkdir(historyRoot, { recursive: true });
  return path.join(historyRoot, filename);
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
    const after = fullDoc({
      id: "pm-history-missing-body",
      title: "after title",
    });
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
    const before = fullDoc(
      { id: "pm-history-tombstone-missing-body" },
      "before body",
    );
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
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pm-history-override-"),
    );
    try {
      const historyPath = await trackerHistoryPath(dir, "pm-skip.jsonl");
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
      await expect(fs.access(historyPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      clearActiveExtensionHooks();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores a non-object handled result and writes the serialized entry", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pm-history-override-"),
    );
    try {
      const historyPath = await trackerHistoryPath(dir, "fallthrough.jsonl");
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
      expect(JSON.parse(written.trim())).toMatchObject({
        op: "update",
        author: "test-agent",
      });
    } finally {
      clearActiveExtensionHooks();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("redirects the write to an object-supplied history path and line", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pm-history-override-"),
    );
    try {
      const requestedPath = await trackerHistoryPath(dir, "requested.jsonl");
      const redirectedPath = await trackerHistoryPath(dir, "redirected.jsonl");
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
      await expect(fs.access(requestedPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const written = await fs.readFile(redirectedPath, "utf8");
      expect(written.trim()).toBe("custom-line");
    } finally {
      clearActiveExtensionHooks();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("writes object-supplied entry payloads when no explicit line is provided", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pm-history-override-"),
    );
    try {
      const requestedPath = await trackerHistoryPath(
        dir,
        "requested-entry.jsonl",
      );
      const redirectedPath = await trackerHistoryPath(
        dir,
        "redirected-entry.jsonl",
      );
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "history-entry",
            service: "history_append",
            run: () => ({
              history_path: redirectedPath,
              entry: { ts: "   ", op: "override", marker: "custom-entry" },
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
      await expect(fs.access(requestedPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const written = await fs.readFile(redirectedPath, "utf8");
      expect(JSON.parse(written.trim())).toEqual({
        ts: FIXED_TS,
        op: "override",
        marker: "custom-entry",
      });
    } finally {
      clearActiveExtensionHooks();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the current time when an override entry and fallback entry both omit timestamps", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pm-history-override-"),
    );
    try {
      const historyPath = await trackerHistoryPath(
        dir,
        "fallback-now-entry.jsonl",
      );
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "history-fallback-now-entry",
            service: "history_append",
            run: () => ({
              entry: { op: "fallback-now", marker: "custom-entry" },
            }),
          },
        ],
      });

      const entry = createHistoryEntry({
        nowIso: FIXED_TS,
        author: "test-agent",
        op: "update",
        before: fullDoc({ id: "pm-fallback-now-entry", title: "a" }),
        after: fullDoc({ id: "pm-fallback-now-entry", title: "b" }),
      });
      entry.ts = "";

      await appendHistoryEntry(historyPath, entry);
      const written = await fs.readFile(historyPath, "utf8");
      const parsed = JSON.parse(written.trim()) as {
        ts?: string;
        op?: string;
        marker?: string;
      };
      expect(parsed).toMatchObject({
        op: "fallback-now",
        marker: "custom-entry",
      });
      expect(typeof parsed.ts).toBe("string");
      expect(parsed.ts).not.toBe("");
      expect(Number.isNaN(Date.parse(parsed.ts ?? ""))).toBe(false);
    } finally {
      clearActiveExtensionHooks();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("adds a timestamp to JSON line override payloads that omit one", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pm-history-override-"),
    );
    try {
      const historyPath = await trackerHistoryPath(dir, "line-entry.jsonl");
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "history-line-entry",
            service: "history_append",
            run: () =>
              JSON.stringify({
                ts: "   ",
                op: "line-override",
                marker: "custom-line-entry",
              }),
          },
        ],
      });

      const entry = createHistoryEntry({
        nowIso: FIXED_TS,
        author: "test-agent",
        op: "update",
        before: fullDoc({ id: "pm-line-entry", title: "a" }),
        after: fullDoc({ id: "pm-line-entry", title: "b" }),
      });

      await appendHistoryEntry(historyPath, entry);
      const written = await fs.readFile(historyPath, "utf8");
      expect(JSON.parse(written.trim())).toEqual({
        ts: FIXED_TS,
        op: "line-override",
        marker: "custom-line-entry",
      });
    } finally {
      clearActiveExtensionHooks();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timestamps from authoritative and extension-projected entries", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pm-history-override-"),
    );
    try {
      const invalid = createHistoryEntry({
        nowIso: FIXED_TS,
        author: "test-agent",
        op: "update",
        before: fullDoc({ id: "pm-invalid-ts", title: "a" }),
        after: fullDoc({ id: "pm-invalid-ts", title: "b" }),
      });
      invalid.ts = "2026-02-20T00:00:00.0001Z";
      await expect(
        appendHistoryEntry(
          await trackerHistoryPath(dir, "authoritative.jsonl"),
          invalid,
        ),
      ).rejects.toMatchObject({ code: "history_timestamp_invalid" });
      invalid.ts = ` ${FIXED_TS}`;
      await expect(
        appendHistoryEntry(
          await trackerHistoryPath(dir, "whitespace.jsonl"),
          invalid,
        ),
      ).rejects.toMatchObject({ code: "history_timestamp_invalid" });

      invalid.ts = FIXED_TS;
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "history-invalid-timestamp",
            service: "history_append",
            run: () => ({ entry: { ts: "not-a-date", op: "override" } }),
          },
        ],
      });
      await expect(
        appendHistoryEntry(
          await trackerHistoryPath(dir, "override.jsonl"),
          invalid,
        ),
      ).rejects.toMatchObject({ code: "history_timestamp_invalid" });
      clearActiveExtensionHooks();
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "history-invalid-string-timestamp",
            service: "history_append",
            run: () => JSON.stringify({ ts: "not-a-date", op: "override" }),
          },
        ],
      });
      await expect(
        appendHistoryEntry(
          await trackerHistoryPath(dir, "override-string.jsonl"),
          invalid,
        ),
      ).rejects.toMatchObject({ code: "history_timestamp_invalid" });
    } finally {
      clearActiveExtensionHooks();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes primitive object override entry payloads defensively", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pm-history-override-"),
    );
    try {
      const historyPath = await trackerHistoryPath(
        dir,
        "primitive-entry.jsonl",
      );
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "history-primitive-entry",
            service: "history_append",
            run: () => ({ entry: 42 }),
          },
        ],
      });

      const entry = createHistoryEntry({
        nowIso: FIXED_TS,
        author: "test-agent",
        op: "update",
        before: fullDoc({ id: "pm-primitive-entry", title: "a" }),
        after: fullDoc({ id: "pm-primitive-entry", title: "b" }),
      });

      await appendHistoryEntry(historyPath, entry);
      const written = await fs.readFile(historyPath, "utf8");
      expect(JSON.parse(written.trim())).toBe(42);

      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "history-primitive-string-entry",
            service: "history_append",
            run: () => ({ entry: "42" }),
          },
        ],
      });
      await appendHistoryEntry(historyPath, entry);
      const lines = (await fs.readFile(historyPath, "utf8")).trim().split("\n");
      expect(JSON.parse(lines[1] ?? "")).toBe(42);
    } finally {
      clearActiveExtensionHooks();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("invalidates drift state before a post-append event-index cleanup fails", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pm-history-override-"),
    );
    try {
      const pmRoot = path.join(dir, ".agents", "pm");
      const historyPath = path.join(
        pmRoot,
        "history",
        "pm-index-failure.jsonl",
      );
      const runtimePath = path.join(pmRoot, "runtime");
      const driftCachePath = path.join(runtimePath, "history-drift-cache.json");
      const eventIndexPath = path.join(
        runtimePath,
        "history-event-index.sqlite",
      );
      await fs.mkdir(eventIndexPath, { recursive: true });
      await fs.writeFile(
        path.join(eventIndexPath, "blocker"),
        "file\n",
        "utf8",
      );
      await fs.writeFile(driftCachePath, "{}\n", "utf8");
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "history-index-failure",
            service: "history_append",
            run: () => JSON.stringify({ op: "override" }),
          },
        ],
      });

      const entry = createHistoryEntry({
        nowIso: FIXED_TS,
        author: "test-agent",
        op: "update",
        before: fullDoc({ id: "pm-index-failure", title: "a" }),
        after: fullDoc({ id: "pm-index-failure", title: "b" }),
      });

      await expect(
        appendHistoryEntry(historyPath, entry),
      ).rejects.toMatchObject({
        code: "ERR_FS_EISDIR",
      });
      await expect(fs.readFile(historyPath, "utf8")).resolves.toContain(
        '"op":"override"',
      );
      await expect(fs.access(driftCachePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      clearActiveExtensionHooks();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
