import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

interface SearchResult {
  mode: string;
  count: number;
  items: Array<{ id: string; title: string }>;
}

/**
 * End-to-end coverage for the instant-mutation / non-blocking search refresh
 * shipped in PR #87 (pm-5rge). PR #87 split mutation refresh into a synchronous
 * keyword-cache invalidation plus a detached worker for the slow embedding
 * refresh, so a `pm create`/`pm update` returns without waiting on a reindex
 * while the new content is still immediately searchable.
 *
 * The detached-worker *dispatch decision* (background vs. inline) is unit-tested
 * in tests/unit/core/search/search-cache.spec.ts and forced inline under test
 * runners by `shouldRunSearchRefreshInForeground`, so it cannot be observed
 * deterministically through a spawned CLI. This test instead pins the
 * user-facing guarantee at the integration boundary: a mutation makes its
 * content findable via keyword search with no explicit `pm reindex`, the
 * inverse content stops matching, and no pending-refresh work is left stranded.
 */
describe("background-refresh non-blocking mutations", () => {
  it("reflects created and updated items in keyword search without an explicit reindex", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(["create", "Task", "Zephyrquux indexing milestone", "--json"], {
        expectJson: true,
      });
      expect(created.code).toBe(0);
      const itemId = (created.json as { item: { id: string } }).item.id;

      // No `pm reindex` between create and search: the keyword cache is
      // invalidated synchronously by the mutation, so the new item is findable
      // immediately even though embedding refresh is deferred.
      const afterCreate = context.runCli(["search", "zephyrquux", "--json"], { expectJson: true });
      expect(afterCreate.code).toBe(0);
      const createSearch = afterCreate.json as SearchResult;
      expect(createSearch.mode).toBe("keyword");
      expect(createSearch.items.map((row) => row.id)).toContain(itemId);

      const updated = context.runCli(["update", itemId, "--title", "Wobblefrotz deployment plan", "--json"]);
      expect(updated.code).toBe(0);

      const newToken = context.runCli(["search", "wobblefrotz", "--json"], { expectJson: true });
      expect(newToken.code).toBe(0);
      expect((newToken.json as SearchResult).items.map((row) => row.id)).toContain(itemId);

      // The pre-update title token no longer matches: the synchronous keyword
      // invalidation reindexed the mutated content, not just appended to it.
      const oldToken = context.runCli(["search", "zephyrquux", "--json"], { expectJson: true });
      expect(oldToken.code).toBe(0);
      expect((oldToken.json as SearchResult).count).toBe(0);

      // No semantic provider is configured, so no background work should be
      // queued: the pending-refresh queue must not strand ids behind a mutation.
      const pendingIds = await readFile(path.join(context.pmPath, "search", "pending-refresh.json"), "utf8").then(
        (raw) => (JSON.parse(raw) as { ids?: string[] }).ids ?? [],
        () => [],
      );
      expect(pendingIds).toEqual([]);
    });
  });
});
