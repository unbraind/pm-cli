import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanHistoryDrift } from "../../../../src/core/history/drift-scan.js";
import { WORKSPACE_HISTORY_ID } from "../../../../src/core/history/workspace-history.js";
import { getHistoryPath } from "../../../../src/core/store/paths.js";
import { listAllItemMetadataWithBody } from "../../../../src/core/store/item-store.js";
import { withTempPmPath, type TempPmContext } from "../../../helpers/withTempPmPath.js";
import { createTestItem } from "../../../helpers/itemFactory.js";

const DRIFT_CACHE_RELATIVE = path.join("runtime", "history-drift-cache.json");

interface DriftCacheFixtureEntry {
  mtime_ms: number;
  ctime_ms: number;
  size: number;
  content_hash: string;
  latest_after_hash: string;
  chain_ok: boolean;
}

interface DriftCacheFixture {
  version: number;
  entries: Record<string, DriftCacheFixtureEntry>;
}

async function readDriftCache(pmRoot: string): Promise<DriftCacheFixture> {
  return JSON.parse(await fs.readFile(path.join(pmRoot, DRIFT_CACHE_RELATIVE), "utf8"));
}

// Seeds one item, scans to populate the cache, mutates the history stream via
// `mutateStream`, then forges a cache row whose stat tuple (mtime/ctime/size)
// matches the mutated stream while keeping the stale content hash/chain status.
// Returns the created item id plus the scanned item list for the follow-up scan.
async function seedStaleMetadataMatchedCache(
  context: TempPmContext,
  title: string,
  mutateStream: (historyPath: string) => Promise<void>,
): Promise<{ createdId: string; items: Awaited<ReturnType<typeof listAllItemMetadataWithBody>> }> {
  const created = createTestItem(context, { title });
  const items = await listAllItemMetadataWithBody(context.pmPath);
  await scanHistoryDrift(context.pmPath, items);
  const cachePath = path.join(context.pmPath, DRIFT_CACHE_RELATIVE);
  const cache = await readDriftCache(context.pmPath);
  const staleEntry = cache.entries[created.id];
  if (!staleEntry) {
    throw new Error("expected cache entry for created item");
  }

  const historyPath = getHistoryPath(context.pmPath, created.id);
  await mutateStream(historyPath);
  const mutatedStat = await fs.stat(historyPath);
  const forgedCache: DriftCacheFixture = {
    version: 3,
    entries: {
      [created.id]: {
        ...staleEntry,
        mtime_ms: mutatedStat.mtimeMs,
        ctime_ms: mutatedStat.ctimeMs,
        size: mutatedStat.size,
      },
    },
  };
  await fs.writeFile(cachePath, `${JSON.stringify(forgedCache, null, 2)}\n`, "utf8");
  return { createdId: created.id, items };
}

// Rewrites a history stream with a single entry that does not replay from the
// empty document, so any hash-guarded re-verification reports a chain mismatch.
async function writeInvalidChainStream(historyPath: string): Promise<void> {
  await fs.writeFile(
    historyPath,
    `${JSON.stringify({ before_hash: "deadbeef", after_hash: "feedface", patch: [] })}\n`,
    "utf8",
  );
}

describe("core/history/drift-scan", () => {
  it("classifies an inaccessible workspace history path as unreadable", async () => {
    await withTempPmPath(async (context) => {
      const historyRoot = path.join(context.pmPath, "history");
      await fs.rm(historyRoot, { recursive: true, force: true });
      await fs.writeFile(historyRoot, "not-a-directory", "utf8");

      const result = await scanHistoryDrift(context.pmPath, []);
      expect(result.unreadableStreams).toContain(WORKSPACE_HISTORY_ID);
      expect(result.driftedItems).toContain(WORKSPACE_HISTORY_ID);
    });
  });

  it("reports no drift for clean streams and reuses the cache on a repeat scan", async () => {
    await withTempPmPath(async (context) => {
      createTestItem(context, { title: "Alpha" });
      createTestItem(context, { title: "Beta" });
      const items = await listAllItemMetadataWithBody(context.pmPath);

      const first = await scanHistoryDrift(context.pmPath, items);
      expect(first.driftedItems).toEqual([]);

      const cache = await readDriftCache(context.pmPath);
      expect(cache.version).toBe(3);
      expect(Object.keys(cache.entries)).toHaveLength(items.length);
      const firstEntry = Object.values(cache.entries)[0];
      expect(typeof firstEntry.content_hash).toBe("string");
      expect(firstEntry.content_hash.length).toBeGreaterThan(0);

      // Second scan: every stream is a cache hit (stat unchanged) and stays clean.
      const second = await scanHistoryDrift(context.pmPath, items);
      expect(second.driftedItems).toEqual([]);
    });
  });

  it("detects a hash mismatch when the item content diverges from its history", async () => {
    await withTempPmPath(async (context) => {
      const created = createTestItem(context, { title: "Gamma" });
      const items = await listAllItemMetadataWithBody(context.pmPath);
      const tampered = items.map((item) =>
        item.id === created.id ? { ...item, body: `${item.body} tampered` } : item,
      );

      const result = await scanHistoryDrift(context.pmPath, tampered);
      expect(result.hashMismatches).toContain(created.id);
      expect(result.driftedItems).toContain(created.id);
    });
  });

  it("detects broken chains, unreadable and empty streams, and missing streams", async () => {
    await withTempPmPath(async (context) => {
      const broken = createTestItem(context, { title: "Broken" });
      const unreadable = createTestItem(context, { title: "Unreadable" });
      const empty = createTestItem(context, { title: "Empty" });
      const items = await listAllItemMetadataWithBody(context.pmPath);

      // Chain that does not replay from the empty document.
      await fs.writeFile(
        getHistoryPath(context.pmPath, broken.id),
        `${JSON.stringify({ before_hash: "deadbeef", after_hash: "feedface", patch: [] })}\n`,
        "utf8",
      );
      // Valid JSON line missing after_hash → throws inside stream verification.
      await fs.writeFile(getHistoryPath(context.pmPath, unreadable.id), `${JSON.stringify({ op: "noop" })}\n`, "utf8");
      // Empty stream → treated as a missing stream.
      await fs.writeFile(getHistoryPath(context.pmPath, empty.id), "\n", "utf8");

      // Parent path component is a file. POSIX reports ENOTDIR for the nested
      // stream, while Windows reports ENOENT, so assert drift instead of a
      // platform-specific bucket.
      await fs.writeFile(path.join(context.pmPath, "history", "notdir"), "x", "utf8");

      const withSynthetic = [
        ...items,
        { ...items[0], id: "pm-does-not-exist" },
        { ...items[0], id: "notdir/child" },
      ];
      const result = await scanHistoryDrift(context.pmPath, withSynthetic);

      expect(result.chainMismatches).toContain(broken.id);
      expect(result.unreadableStreams).toContain(unreadable.id);
      expect([...result.missingStreams, ...result.unreadableStreams]).toContain("notdir/child");
      expect(result.driftedItems).toContain("notdir/child");
      expect(result.missingStreams).toContain(empty.id);
      expect(result.missingStreams).toContain("pm-does-not-exist");
    });
  });

  it("invalidates a cached stream when ctime changes even if mtime and size do not", async () => {
    await withTempPmPath(async (context) => {
      const created = createTestItem(context, { title: "Ctime" });
      const items = await listAllItemMetadataWithBody(context.pmPath);
      await scanHistoryDrift(context.pmPath, items); // populate cache (records ctime)

      // chmod updates the inode ctime without touching mtime or size, the exact
      // case where an mtime/size-only key would wrongly trust a stale result.
      const historyPath = getHistoryPath(context.pmPath, created.id);
      await fs.chmod(historyPath, 0o600);
      await fs.chmod(historyPath, 0o644);

      const result = await scanHistoryDrift(context.pmPath, items);
      expect(result.driftedItems).toEqual([]);
    });
  });

  it("ignores corrupt or version-mismatched cache files and rescans from scratch", async () => {
    await withTempPmPath(async (context) => {
      createTestItem(context, { title: "Delta" });
      const items = await listAllItemMetadataWithBody(context.pmPath);
      const cachePath = path.join(context.pmPath, DRIFT_CACHE_RELATIVE);
      await fs.mkdir(path.dirname(cachePath), { recursive: true });

      for (const corrupt of [
        "{ not json",
        JSON.stringify({ version: 999, entries: {} }),
        JSON.stringify({ version: 3, entries: null }),
        JSON.stringify({ version: 3, entries: "not-an-object" }),
      ]) {
        await fs.writeFile(cachePath, corrupt, "utf8");
        const result = await scanHistoryDrift(context.pmPath, items);
        expect(result.driftedItems).toEqual([]);
      }
    });
  });

  it("rewrites the cache when the tracked item set shrinks between scans", async () => {
    await withTempPmPath(async (context) => {
      createTestItem(context, { title: "One" });
      createTestItem(context, { title: "Two" });
      const items = await listAllItemMetadataWithBody(context.pmPath);

      await scanHistoryDrift(context.pmPath, items);
      expect(Object.keys((await readDriftCache(context.pmPath)).entries)).toHaveLength(2);

      // Subset scan: each remaining stream is an unchanged cache hit, but the key
      // set shrank, so the cache is rewritten with fewer entries.
      await scanHistoryDrift(context.pmPath, items.slice(0, 1));
      expect(Object.keys((await readDriftCache(context.pmPath)).entries)).toHaveLength(1);
    });
  });

  it("detects metadata-matching stale cache rows when content hash changes", async () => {
    await withTempPmPath(async (context) => {
      // Replace the stream with a different (invalid-chain) payload behind a
      // metadata-matched cache row. Hash-guarded cache hits must invalidate it.
      const { createdId, items } = await seedStaleMetadataMatchedCache(context, "Hash guard", writeInvalidChainStream);

      const result = await scanHistoryDrift(context.pmPath, items);
      expect(result.chainMismatches).toContain(createdId);
      expect(result.driftedItems).toContain(createdId);
    });
  });

  it("metadata mode skips content rereads and trusts stat-matched cache entries after content changes", async () => {
    await withTempPmPath(async (context) => {
      const { items } = await seedStaleMetadataMatchedCache(context, "Metadata trusted", writeInvalidChainStream);

      const result = await scanHistoryDrift(context.pmPath, items, { cacheHitVerification: "metadata" });
      expect(result.driftedItems).toEqual([]);
    });
  });

  it("marks cached metadata hits unreadable when content-hash read fails", async () => {
    await withTempPmPath(async (context) => {
      const { createdId, items } = await seedStaleMetadataMatchedCache(
        context,
        "Hash read failure",
        async (historyPath) => {
          await fs.rm(historyPath, { force: true });
          await fs.mkdir(historyPath, { recursive: true });
        },
      );

      const result = await scanHistoryDrift(context.pmPath, items);
      expect(result.unreadableStreams).toContain(createdId);
      expect(result.driftedItems).toContain(createdId);
    });
  });

  it("reclassifies stale metadata hits as missing when re-verified stream is empty", async () => {
    await withTempPmPath(async (context) => {
      const { createdId, items } = await seedStaleMetadataMatchedCache(
        context,
        "Hash mismatch to empty",
        async (historyPath) => {
          await fs.writeFile(historyPath, "\n", "utf8");
        },
      );

      const result = await scanHistoryDrift(context.pmPath, items);
      expect(result.missingStreams).toContain(createdId);
      expect(result.driftedItems).toContain(createdId);
    });
  });
});
