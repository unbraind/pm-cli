import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanHistoryDrift } from "../../src/core/history/drift-scan.js";
import { getHistoryPath } from "../../src/core/store/paths.js";
import { listAllFrontMatterWithBody } from "../../src/core/store/item-store.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";
import { createTestItem } from "../helpers/itemFactory.js";

const DRIFT_CACHE_RELATIVE = path.join("runtime", "history-drift-cache.json");

async function readDriftCache(pmRoot: string): Promise<{ version: number; entries: Record<string, unknown> }> {
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
      expect(cache.version).toBe(1);
      expect(Object.keys(cache.entries)).toHaveLength(items.length);

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

      // Stat failure that is not ENOENT (parent path component is a file → ENOTDIR).
      await fs.writeFile(path.join(context.pmPath, "history", "notdir"), "x", "utf8");

      const withSynthetic = [
        ...items,
        { ...items[0], id: "pm-does-not-exist" },
        { ...items[0], id: "notdir/child" },
      ];
      const result = await scanHistoryDrift(context.pmPath, withSynthetic);

      expect(result.chainMismatches).toContain(broken.id);
      expect(result.unreadableStreams).toContain(unreadable.id);
      expect(result.unreadableStreams).toContain("notdir/child");
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
});
