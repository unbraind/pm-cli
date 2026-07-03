import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serializeItemDocument } from "../../../../src/core/item/item-format.js";
import {
  clearFrontMatterEnvelopeMemo,
  listAllDocumentCandidatesCached,
  shouldReplaceCachedDocumentCandidate,
} from "../../../../src/core/store/front-matter-cache.js";
import {
  clearActiveExtensionHooks,
  setActiveExtensionHooks,
  setActiveExtensionRegistrations,
} from "../../../../src/core/extensions/index.js";
import { createEmptyExtensionRegistrationRegistry } from "../../../../src/core/extensions/extension-registries.js";
import type { ItemMetadata } from "../../../../src/types.js";

const tempRoots: string[] = [];

async function withTempPmRoot(run: (pmRoot: string) => Promise<void>): Promise<void> {
  const pmRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-front-matter-cache-"));
  tempRoots.push(pmRoot);
  await run(pmRoot);
}

function makeTaskMetadata(overrides: Partial<ItemMetadata> & Pick<ItemMetadata, "id">): ItemMetadata {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    description: overrides.description ?? "",
    type: overrides.type ?? "Task",
    status: overrides.status ?? "open",
    priority: overrides.priority ?? 1,
    tags: overrides.tags ?? [],
    created_at: overrides.created_at ?? "2026-05-16T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-05-16T00:00:00.000Z",
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  clearActiveExtensionHooks();
  setActiveExtensionRegistrations(null);
  clearFrontMatterEnvelopeMemo();
  await Promise.all(tempRoots.splice(0).map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true })));
});

describe("front matter cache", () => {
  it("serves cached item bodies for unchanged files and refreshes them after mutation", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const tasksDir = path.join(pmRoot, "tasks");
      await fs.mkdir(tasksDir, { recursive: true });
      const itemPath = path.join(tasksDir, "pm-cache.toon");
      const metadata = makeTaskMetadata({ id: "pm-cache", title: "Cached body task" });
      await fs.writeFile(
        itemPath,
        serializeItemDocument({ metadata, body: "first cached body token" }, { format: "toon" }),
        "utf8",
      );

      const typeToFolder = { Task: "tasks" };
      const first = await listAllDocumentCandidatesCached(pmRoot, "toon", typeToFolder, [], undefined);
      expect(first).toHaveLength(1);
      expect(first[0]?.body).toBe("first cached body token");

      const readSpy = vi.spyOn(fs, "readFile");
      const second = await listAllDocumentCandidatesCached(pmRoot, "toon", typeToFolder, [], undefined);
      expect(second[0]?.body).toBe("first cached body token");
      expect(readSpy).not.toHaveBeenCalledWith(itemPath, "utf8");

      readSpy.mockRestore();
      await fs.writeFile(
        itemPath,
        serializeItemDocument({ metadata, body: "updated cached body token" }, { format: "toon" }),
        "utf8",
      );

      const third = await listAllDocumentCandidatesCached(pmRoot, "toon", typeToFolder, [], undefined);
      expect(third[0]?.body).toBe("updated cached body token");
    });
  });

  it("adds deterministic warnings when item directories cannot be read", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const warnings: string[] = [];
      await fs.writeFile(path.join(pmRoot, "tasks"), "not-a-directory", "utf8");

      const docs = await listAllDocumentCandidatesCached(pmRoot, "toon", { Task: "tasks" }, warnings, undefined);
      expect(docs).toEqual([]);
      expect(warnings).toContain("item_list_directory_read_failed:tasks");
    });
  });

  it("dispatches onRead hooks for parsed items while skipping non-item files", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const tasksDir = path.join(pmRoot, "tasks");
      await fs.mkdir(tasksDir, { recursive: true });
      const itemPath = path.join(tasksDir, "pm-read-hook.toon");
      const metadata = makeTaskMetadata({ id: "pm-read-hook", title: "Hooked task" });
      await fs.writeFile(itemPath, serializeItemDocument({ metadata, body: "body" }, { format: "toon" }), "utf8");
      await fs.writeFile(path.join(tasksDir, "ignore.txt"), "ignored", "utf8");

      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onWrite: [],
        onRead: [
          {
            layer: "project",
            name: "boom-read-hook",
            run: () => {
              throw new Error("boom-read");
            },
          },
        ],
        onIndex: [],
      });

      const warnings: string[] = [];
      const docs = await listAllDocumentCandidatesCached(pmRoot, "toon", { Task: "tasks" }, warnings, undefined);
      expect(docs).toHaveLength(1);
      expect(docs[0]?.metadata.id).toBe("pm-read-hook");
      expect(warnings.some((warning) => warning.includes("extension_hook_failed:project:boom-read-hook:onRead"))).toBe(
        true,
      );
      expect(warnings.some((warning) => warning.includes("ignore.txt"))).toBe(false);
    });
  });

  it("invalidates mismatched collections cache and forwards parse warnings", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const tasksDir = path.join(pmRoot, "tasks");
      await fs.mkdir(tasksDir, { recursive: true });

      // Exercise context fingerprint extension-field branch.
      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.item_fields.push({
        layer: "project",
        name: "custom-field",
        fields: [{ name: "customer_segment", type: "string", commands: ["create"] }],
      });
      setActiveExtensionRegistrations(registrations);

      const metadata = makeTaskMetadata({ id: "pm-cache-warning", title: "Warning task" });
      const serialized = serializeItemDocument({ metadata, body: "body" }, { format: "json_markdown" });
      await fs.writeFile(path.join(tasksDir, "pm-cache-warning.md"), `---\ntitle: stale\n---\n${serialized}`, "utf8");

      // Exercise loadCollectionsCache shape guard.
      await fs.mkdir(path.join(pmRoot, "runtime"), { recursive: true });
      await fs.writeFile(
        path.join(pmRoot, "runtime", "metadata-cache-collections.json"),
        JSON.stringify({ version: 6, context_fingerprint: "mismatch", collections: 42 }),
        "utf8",
      );

      const warnings: string[] = [];
      const docs = await listAllDocumentCandidatesCached(pmRoot, "json_markdown", { Task: "tasks" }, warnings, undefined);
      expect(docs).toHaveLength(1);
      expect(warnings).toContain("json_markdown_leading_yaml_frontmatter_ignored");
    });
  });

  it("memoizes parsed cache envelopes per process and revalidates them by stat signature", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const tasksDir = path.join(pmRoot, "tasks");
      await fs.mkdir(tasksDir, { recursive: true });
      const metadata = makeTaskMetadata({ id: "pm-memo", title: "Memoized envelope task" });
      await fs.writeFile(
        path.join(tasksDir, "pm-memo.toon"),
        serializeItemDocument({ metadata, body: "memo body" }, { format: "toon" }),
        "utf8",
      );

      const typeToFolder = { Task: "tasks" };
      const cachePath = path.join(pmRoot, "runtime", "metadata-cache.json");
      // The first call persists the on-disk caches and repopulates the memo with the
      // just-written envelopes; the second call revalidates them by stat alone.
      await listAllDocumentCandidatesCached(pmRoot, "toon", typeToFolder, [], undefined);
      await listAllDocumentCandidatesCached(pmRoot, "toon", typeToFolder, [], undefined);

      // Third call with unchanged files must serve the memoized envelope without
      // re-reading any cache file (stats alone revalidate the memo).
      const readSpy = vi.spyOn(fs, "readFile");
      const memoized = await listAllDocumentCandidatesCached(pmRoot, "toon", typeToFolder, [], undefined);
      expect(memoized).toHaveLength(1);
      expect(memoized[0]?.metadata.id).toBe("pm-memo");
      expect(readSpy).not.toHaveBeenCalled();
      readSpy.mockRestore();

      // Externally rewriting the cache file invalidates the memoized envelope by
      // stat signature; a corrupt envelope memoizes as null and items re-parse.
      await fs.writeFile(cachePath, "{not json", "utf8");
      const reparsed = await listAllDocumentCandidatesCached(pmRoot, "toon", typeToFolder, [], undefined);
      expect(reparsed).toHaveLength(1);
      expect(reparsed[0]?.metadata.id).toBe("pm-memo");

      // The re-parse persisted a fresh envelope, so subsequent calls stay correct.
      const afterRecovery = await listAllDocumentCandidatesCached(pmRoot, "toon", typeToFolder, [], undefined);
      expect(afterRecovery).toHaveLength(1);
      expect(afterRecovery[0]?.metadata.id).toBe("pm-memo");
    });
  });

  it("rejects a version-mismatched metadata envelope and recovers by re-parsing items", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const tasksDir = path.join(pmRoot, "tasks");
      await fs.mkdir(tasksDir, { recursive: true });
      const metadata = makeTaskMetadata({ id: "pm-memo-null", title: "Memoized null envelope task" });
      await fs.writeFile(
        path.join(tasksDir, "pm-memo-null.toon"),
        serializeItemDocument({ metadata, body: "body" }, { format: "toon" }),
        "utf8",
      );

      // Version-mismatched metadata and body envelopes must parse to null so every
      // item is re-parsed from disk; the scan then persists fresh valid envelopes
      // that the second call loads normally.
      await fs.mkdir(path.join(pmRoot, "runtime"), { recursive: true });
      const cachePath = path.join(pmRoot, "runtime", "metadata-cache.json");
      await fs.writeFile(cachePath, JSON.stringify({ version: 1, context_fingerprint: "stale", entries: {} }), "utf8");
      await fs.writeFile(
        path.join(pmRoot, "runtime", "metadata-cache-bodies.json"),
        JSON.stringify({ version: 1, context_fingerprint: "stale", bodies: {} }),
        "utf8",
      );

      const typeToFolder = { Task: "tasks" };
      const first = await listAllDocumentCandidatesCached(pmRoot, "toon", typeToFolder, [], undefined);
      expect(first).toHaveLength(1);
      const second = await listAllDocumentCandidatesCached(pmRoot, "toon", typeToFolder, [], undefined);
      expect(second).toHaveLength(1);
      expect(second[0]?.metadata.id).toBe("pm-memo-null");
    });
  });

  it("falls back to memo invalidation when the post-persist stat cannot be captured", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const tasksDir = path.join(pmRoot, "tasks");
      await fs.mkdir(tasksDir, { recursive: true });
      const metadata = makeTaskMetadata({ id: "pm-persist-stat", title: "Persist stat fallback task" });
      await fs.writeFile(
        path.join(tasksDir, "pm-persist-stat.toon"),
        serializeItemDocument({ metadata, body: "body" }, { format: "toon" }),
        "utf8",
      );

      // Reject stats for the cache files only: envelope loads then miss (null) and
      // the post-persist repopulation hits its catch fallback; item-file stats keep
      // working so the scan itself still succeeds.
      const realStat = fs.stat;
      const statSpy = vi.spyOn(fs, "stat").mockImplementation(((target: Parameters<typeof fs.stat>[0], ...rest: unknown[]) =>
        String(target).includes("metadata-cache")
          ? Promise.reject(new Error("stat unavailable"))
          : (realStat as (...args: unknown[]) => Promise<unknown>)(target, ...rest)) as typeof fs.stat);

      const typeToFolder = { Task: "tasks" };
      const degraded = await listAllDocumentCandidatesCached(pmRoot, "toon", typeToFolder, [], undefined);
      expect(degraded).toHaveLength(1);
      expect(degraded[0]?.metadata.id).toBe("pm-persist-stat");

      statSpy.mockRestore();
      const recovered = await listAllDocumentCandidatesCached(pmRoot, "toon", typeToFolder, [], undefined);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.metadata.id).toBe("pm-persist-stat");
    });
  });

  it("caps the envelope memo across many project roots and refreshes stale entries at the cap", async () => {
    const typeToFolder = { Task: "tasks" };
    const roots: string[] = [];
    // 8 roots × 3 envelopes fill the 24-entry memo; a 9th root then forces the
    // oldest-half eviction branch, and refreshing an already-memoized path while
    // the memo is full exercises the has(cachePath) no-evict branch.
    for (let index = 0; index < 9; index += 1) {
      const pmRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-envelope-cap-"));
      tempRoots.push(pmRoot);
      roots.push(pmRoot);
      const tasksDir = path.join(pmRoot, "tasks");
      await fs.mkdir(tasksDir, { recursive: true });
      const metadata = makeTaskMetadata({ id: `pm-cap-${index}`, title: `Cap task ${index}` });
      await fs.writeFile(
        path.join(tasksDir, `pm-cap-${index}.toon`),
        serializeItemDocument({ metadata, body: `cap body ${index}` }, { format: "toon" }),
        "utf8",
      );
      // First call persists the on-disk caches; second call memoizes them.
      await listAllDocumentCandidatesCached(pmRoot, "toon", typeToFolder, [], undefined);
      const docs = await listAllDocumentCandidatesCached(pmRoot, "toon", typeToFolder, [], undefined);
      expect(docs).toHaveLength(1);
      expect(docs[0]?.metadata.id).toBe(`pm-cap-${index}`);
    }

    // Evicted roots still resolve correctly by re-reading their cache files; the
    // re-reads also refill the memo back up to the cap.
    for (let index = 0; index < 3; index += 1) {
      const evictedRootDocs = await listAllDocumentCandidatesCached(roots[index], "toon", typeToFolder, [], undefined);
      expect(evictedRootDocs).toHaveLength(1);
      expect(evictedRootDocs[0]?.metadata.id).toBe(`pm-cap-${index}`);
    }

    // Externally rewrite the newest root's metadata envelope so its memo entry is
    // stale while the memo sits at the cap; the reload must refresh the existing
    // entry in place without evicting anything.
    const lastRoot = roots[roots.length - 1];
    const lastCachePath = path.join(lastRoot, "runtime", "metadata-cache.json");
    const envelope = JSON.parse(await fs.readFile(lastCachePath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(lastCachePath, `${JSON.stringify(envelope)} `, "utf8");
    const refreshed = await listAllDocumentCandidatesCached(lastRoot, "toon", typeToFolder, [], undefined);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]?.metadata.id).toBe("pm-cap-8");
  });

  it("decides cross-format duplicate winners deterministically regardless of read order", () => {
    // No preferred format: toon wins over any non-toon format, never the reverse.
    expect(shouldReplaceCachedDocumentCandidate("json_markdown", "toon", undefined)).toBe(true);
    expect(shouldReplaceCachedDocumentCandidate("toon", "json_markdown", undefined)).toBe(false);
    expect(shouldReplaceCachedDocumentCandidate("toon", "toon", undefined)).toBe(false);
    // Explicit preferred format wins; a candidate that is not preferred never replaces.
    expect(shouldReplaceCachedDocumentCandidate("toon", "json_markdown", "json_markdown")).toBe(true);
    expect(shouldReplaceCachedDocumentCandidate("json_markdown", "toon", "json_markdown")).toBe(false);
    expect(shouldReplaceCachedDocumentCandidate("json_markdown", "json_markdown", "json_markdown")).toBe(false);
  });

  it("prefers the toon file when an item id exists in both toon and markdown formats", async () => {
    await withTempPmRoot(async (pmRoot) => {
      const tasksDir = path.join(pmRoot, "tasks");
      await fs.mkdir(tasksDir, { recursive: true });
      const metadata = makeTaskMetadata({ id: "pm-dup", title: "Duplicate across formats" });
      // Same id present as both .md (fallback) and .toon (canonical); the toon
      // candidate must win deterministically no matter which read resolves first.
      await fs.writeFile(
        path.join(tasksDir, "pm-dup.md"),
        serializeItemDocument({ metadata, body: "markdown body" }, { format: "json_markdown" }),
        "utf8",
      );
      await fs.writeFile(
        path.join(tasksDir, "pm-dup.toon"),
        serializeItemDocument({ metadata, body: "toon body" }, { format: "toon" }),
        "utf8",
      );

      const docs = await listAllDocumentCandidatesCached(pmRoot, "toon", { Task: "tasks" }, [], undefined);
      const deduped = docs.filter((doc) => doc.metadata.id === "pm-dup");
      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.item_format).toBe("toon");
      expect(deduped[0]?.body).toBe("toon body");
    });
  });
});
