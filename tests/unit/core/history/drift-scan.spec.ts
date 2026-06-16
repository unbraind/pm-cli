import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanHistoryDrift } from "../../../../src/core/history/drift-scan.js";
import { getHistoryPath } from "../../../../src/core/store/paths.js";
import { listAllFrontMatterWithBody } from "../../../../src/core/store/item-store.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
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

describe("core/history/drift-scan", () => {
  it("reports no drift for clean streams and reuses the cache on a repeat scan", async () => {
    await withTempPmPath(async (context) => {
      createTestItem(context, { title: "Alpha" });
      createTestItem(context, { title: "Beta" });
      const items = await listAllFrontMatterWithBody(context.pmPath);

      const first = await scanHistoryDrift(context.pmPath, items);
      expect(first.driftedItems).toEqual([]);

      const cache = await readDriftCache(context.pmPath);
      expect(cache.version).toBe(2);
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
      const items = await listAllFrontMatterWithBody(context.pmPath);
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
      const items = await listAllFrontMatterWithBody(context.pmPath);

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
      const items = await listAllFrontMatterWithBody(context.pmPath);
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
      const items = await listAllFrontMatterWithBody(context.pmPath);
      const cachePath = path.join(context.pmPath, DRIFT_CACHE_RELATIVE);
      await fs.mkdir(path.dirname(cachePath), { recursive: true });

      for (const corrupt of [
        "{ not json",
        JSON.stringify({ version: 999, entries: {} }),
        JSON.stringify({ version: 1, entries: null }),
        JSON.stringify({ version: 1, entries: "not-an-object" }),
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
      const items = await listAllFrontMatterWithBody(context.pmPath);

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
      const created = createTestItem(context, { title: "Hash guard" });
      const items = await listAllFrontMatterWithBody(context.pmPath);
      await scanHistoryDrift(context.pmPath, items);
      const cachePath = path.join(context.pmPath, DRIFT_CACHE_RELATIVE);
      const cache = await readDriftCache(context.pmPath);
      const staleEntry = cache.entries[created.id];
      if (!staleEntry) {
        throw new Error("expected cache entry for created item");
      }

      // Replace the stream with a different (invalid-chain) payload.
      await fs.writeFile(
        getHistoryPath(context.pmPath, created.id),
        `${JSON.stringify({ before_hash: "deadbeef", after_hash: "feedface", patch: [] })}\n`,
        "utf8",
      );
      const tamperedStat = await fs.stat(getHistoryPath(context.pmPath, created.id));

      // Craft a stale cache row that matches the file metadata tuple but keeps the
      // old content hash/chain status. Hash-guarded cache hits must invalidate this.
      const forgedCache: DriftCacheFixture = {
        version: 2,
        entries: {
          [created.id]: {
            ...staleEntry,
            mtime_ms: tamperedStat.mtimeMs,
            ctime_ms: tamperedStat.ctimeMs,
            size: tamperedStat.size,
          },
        },
      };
      await fs.writeFile(cachePath, `${JSON.stringify(forgedCache, null, 2)}\n`, "utf8");

      const result = await scanHistoryDrift(context.pmPath, items);
      expect(result.chainMismatches).toContain(created.id);
      expect(result.driftedItems).toContain(created.id);
    });
  });

  it("marks cached metadata hits unreadable when content-hash read fails", async () => {
    await withTempPmPath(async (context) => {
      const created = createTestItem(context, { title: "Hash read failure" });
      const items = await listAllFrontMatterWithBody(context.pmPath);
      await scanHistoryDrift(context.pmPath, items);
      const cachePath = path.join(context.pmPath, DRIFT_CACHE_RELATIVE);
      const cache = await readDriftCache(context.pmPath);
      const staleEntry = cache.entries[created.id];
      if (!staleEntry) {
        throw new Error("expected cache entry for created item");
      }

      const historyPath = getHistoryPath(context.pmPath, created.id);
      await fs.rm(historyPath, { force: true });
      await fs.mkdir(historyPath, { recursive: true });
      const dirStat = await fs.stat(historyPath);

      const forgedCache: DriftCacheFixture = {
        version: 2,
        entries: {
          [created.id]: {
            ...staleEntry,
            mtime_ms: dirStat.mtimeMs,
            ctime_ms: dirStat.ctimeMs,
            size: dirStat.size,
          },
        },
      };
      await fs.writeFile(cachePath, `${JSON.stringify(forgedCache, null, 2)}\n`, "utf8");

      const result = await scanHistoryDrift(context.pmPath, items);
      expect(result.unreadableStreams).toContain(created.id);
      expect(result.driftedItems).toContain(created.id);
    });
  });

  it("reclassifies stale metadata hits as missing when re-verified stream is empty", async () => {
    await withTempPmPath(async (context) => {
      const created = createTestItem(context, { title: "Hash mismatch to empty" });
      const items = await listAllFrontMatterWithBody(context.pmPath);
      await scanHistoryDrift(context.pmPath, items);
      const cachePath = path.join(context.pmPath, DRIFT_CACHE_RELATIVE);
      const cache = await readDriftCache(context.pmPath);
      const staleEntry = cache.entries[created.id];
      if (!staleEntry) {
        throw new Error("expected cache entry for created item");
      }

      const historyPath = getHistoryPath(context.pmPath, created.id);
      await fs.writeFile(historyPath, "\n", "utf8");
      const emptyStat = await fs.stat(historyPath);

      const forgedCache: DriftCacheFixture = {
        version: 2,
        entries: {
          [created.id]: {
            ...staleEntry,
            mtime_ms: emptyStat.mtimeMs,
            ctime_ms: emptyStat.ctimeMs,
            size: emptyStat.size,
          },
        },
      };
      await fs.writeFile(cachePath, `${JSON.stringify(forgedCache, null, 2)}\n`, "utf8");

      const result = await scanHistoryDrift(context.pmPath, items);
      expect(result.missingStreams).toContain(created.id);
      expect(result.driftedItems).toContain(created.id);
    });
  });
});
