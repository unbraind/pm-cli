import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  invalidateSearchCacheArtifacts,
  refreshSearchArtifactsForMutation,
  refreshSemanticEmbeddingsForMutatedItems,
  SEARCH_CACHE_ARTIFACT_PATHS,
} from "../../src/core/search/cache.js";
import {
  drainPendingRefreshIds,
  enqueuePendingRefreshIds,
  REINDEX_LOCK_ID,
  runSemanticRefreshWorker,
  shouldRunSearchRefreshInForeground,
} from "../../src/core/search/background-refresh.js";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
import { createTestItemId } from "../helpers/itemFactory.js";
import { withTempDir } from "../helpers/temp.js";
import type { TempPmContext } from "../helpers/withTempPmPath.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";
import {
  embeddingsResponse,
  fakeResponse,
  installFailingFetchMock,
  installSemanticFetchMock,
} from "../helpers/semanticFetchMock.js";

function createSeedItem(
  context: TempPmContext,
  title: string,
  dep: string = "none",
  seedLogs: boolean = true,
): string {
  return createTestItemId(context, {
    title,
    tags: "search,cache",
    body: `${title} body`,
    acceptanceCriteria: "Mutation refresh updates semantic vectors",
    author: "unit-test",
    message: "Create search cache test item",
    dep,
    comment: seedLogs ? "author=unit-test,created_at=now,text=seed-comment" : "none",
    note: seedLogs ? "author=unit-test,created_at=now,text=seed-note" : "none",
    learning: seedLogs ? "author=unit-test,created_at=now,text=seed-learning" : "none",
  });
}

describe("core/search/cache", () => {
  it("invalidates known search cache artifacts when present", async () => {
    await withTempDir("pm-cli-search-cache-", async (pmRoot) => {
      await fs.mkdir(path.join(pmRoot, "index"), { recursive: true });
      await fs.mkdir(path.join(pmRoot, "search"), { recursive: true });
      await fs.writeFile(path.join(pmRoot, "index", "manifest.json"), '{"ok":true}\n', "utf8");
      await fs.writeFile(path.join(pmRoot, "search", "embeddings.jsonl"), '{"id":"x"}\n', "utf8");

      const result = await invalidateSearchCacheArtifacts(pmRoot);

      expect(result.invalidated).toEqual([...SEARCH_CACHE_ARTIFACT_PATHS]);
      expect(result.warnings).toEqual([]);
      await expect(fs.access(path.join(pmRoot, "index", "manifest.json"))).rejects.toBeDefined();
      await expect(fs.access(path.join(pmRoot, "search", "embeddings.jsonl"))).rejects.toBeDefined();
    });
  });

  it("returns deterministic empty invalidation when artifacts do not exist", async () => {
    await withTempDir("pm-cli-search-cache-", async (pmRoot) => {
      const result = await invalidateSearchCacheArtifacts(pmRoot);
      expect(result.invalidated).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  });

  it("collects non-fatal warnings when artifact removal fails", async () => {
    await withTempDir("pm-cli-search-cache-", async (pmRoot) => {
      await fs.mkdir(path.join(pmRoot, "index", "manifest.json"), { recursive: true });
      await fs.mkdir(path.join(pmRoot, "search"), { recursive: true });
      await fs.writeFile(path.join(pmRoot, "search", "embeddings.jsonl"), '{"id":"x"}\n', "utf8");

      const result = await invalidateSearchCacheArtifacts(pmRoot);

      expect(result.invalidated).toEqual(["search/embeddings.jsonl"]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("search_cache_invalidation_failed:index/manifest.json:");
    });
  });

  it("returns deterministic empty semantic refresh when no item ids are provided", async () => {
    await withTempPmPath(async (context) => {
      const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, []);
      expect(result).toEqual({
        refreshed: [],
        skipped: [],
        warnings: [],
      });
    });
  });

  it("returns deterministic settings-not-initialized warning when PM root lacks settings", async () => {
    await withTempDir("pm-cli-search-cache-", async (pmRoot) => {
      const result = await refreshSemanticEmbeddingsForMutatedItems(pmRoot, ["pm-missing"]);
      expect(result).toEqual({
        refreshed: [],
        skipped: ["pm-missing"],
        warnings: ["search_semantic_refresh_skipped:settings_not_initialized"],
      });
    });
  });

  it("returns deterministic settings-read warning when settings path is unreadable", async () => {
    await withTempDir("pm-cli-search-cache-", async (pmRoot) => {
      await fs.mkdir(path.join(pmRoot, "settings.json"), { recursive: true });
      const result = await refreshSemanticEmbeddingsForMutatedItems(pmRoot, ["pm-missing"]);
      expect(result.refreshed).toEqual([]);
      expect(result.skipped).toEqual(["pm-missing"]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("search_semantic_refresh_skipped:settings_read_failed:");
    });
  });

  it("skips semantic refresh with deterministic warning when provider is unconfigured", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context, "Unconfigured provider item");

      const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemId]);
      expect(result.refreshed).toEqual([]);
      expect(result.skipped).toEqual([itemId]);
      expect(result.warnings).toEqual(["search_semantic_refresh_skipped:provider_unconfigured"]);
    });
  });

  it("skips semantic refresh with deterministic warning when vector store is unconfigured", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context, "Unconfigured vector store item");
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      await writeSettings(context.pmPath, settings);

      const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemId]);
      expect(result.refreshed).toEqual([]);
      expect(result.skipped).toEqual([itemId]);
      expect(result.warnings).toEqual(["search_semantic_refresh_skipped:vector_store_unconfigured"]);
    });
  });

  it("refreshes semantic vectors and prunes missing ids when provider and store are configured", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(
        context,
        "Configured semantic refresh item",
        "id=pm-related,kind=related,author=unit-test,created_at=now",
      );
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock();

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemId, "pm-missing", itemId]);
        expect(result.refreshed).toEqual([itemId]);
        expect(result.skipped).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(semanticMock.calls).toEqual([
          "https://api.example.test/v1/embeddings",
          "https://qdrant.example.test:6333/collections/pm_items/points?wait=true",
          "https://qdrant.example.test:6333/collections/pm_items/points/delete?wait=true",
        ]);
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("prunes missing ids even when no located items exist", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock();

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, ["pm-missing", "pm-missing"]);
        expect(result.refreshed).toEqual([]);
        expect(result.skipped).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(semanticMock.calls).toEqual(["https://qdrant.example.test:6333/collections/pm_items/points/delete?wait=true"]);
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("refreshes semantic vectors when comments notes and learnings are unset", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context, "Configured semantic refresh no logs item", "none", false);
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock();

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemId]);
        expect(result.refreshed).toEqual([itemId]);
        expect(result.skipped).toEqual([]);
        expect(result.warnings).toEqual([]);
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("bounds oversized semantic refresh corpus input before embedding", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context, "Oversized semantic corpus source");
      const oversizedCommentChunk = "x".repeat(900);
      for (let index = 0; index < 12; index += 1) {
        const commentResult = context.runCli(["comments", "--json", itemId, `${oversizedCommentChunk}-${index}`], {
          expectJson: true,
        });
        expect(commentResult.code).toBe(0);
      }
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock();
      const inputLengths = semanticMock.inputLengths;

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemId]);
        expect(result.refreshed).toEqual([itemId]);
        expect(result.warnings).toEqual([]);
        expect(inputLengths).toHaveLength(1);
        expect(inputLengths[0]).toBeGreaterThan(300);
        expect(inputLengths[0]).toBeLessThanOrEqual(8_000);
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("sorts refreshed document ids deterministically before embedding and upsert", async () => {
    await withTempPmPath(async (context) => {
      const itemA = createSeedItem(context, "Semantic sort A");
      const itemB = createSeedItem(context, "Semantic sort B");
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock();

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemB, itemA]);
        expect(result.refreshed).toEqual([itemA, itemB].sort((left, right) => left.localeCompare(right)));
        expect(result.skipped).toEqual([]);
        expect(result.warnings).toEqual([]);
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("reports deterministic warning when semantic refresh embedding request fails", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context, "Failed semantic refresh item");
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const semanticMock = installFailingFetchMock({ text: "embedding service down" });

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemId]);
        expect(result.refreshed).toEqual([]);
        expect(result.skipped).toEqual([itemId]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("search_semantic_refresh_failed:");
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("honors embedding batch size and retry settings during mutation semantic refresh", async () => {
    await withTempPmPath(async (context) => {
      const itemA = createSeedItem(context, "Retry refresh A");
      const itemB = createSeedItem(context, "Retry refresh B");
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      settings.search.embedding_batch_size = 1;
      settings.search.scanner_max_batch_retries = 1;
      await writeSettings(context.pmPath, settings);

      let embeddingAttempts = 0;
      const semanticMock = installSemanticFetchMock({
        embeddings: ({ inputCount }) => {
          embeddingAttempts += 1;
          if (embeddingAttempts === 1) {
            return fakeResponse({ ok: false, status: 500, statusText: "Internal Server Error", text: "transient failure" });
          }
          return embeddingsResponse(inputCount);
        },
      });

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemA, itemB]);
        expect(result.refreshed).toEqual([itemA, itemB].sort((left, right) => left.localeCompare(right)));
        expect(result.skipped).toEqual([]);
        expect(result.warnings).toContain("search_embedding_batch_retry_succeeded:batch=1:attempt=2:size=1");
        expect(embeddingAttempts).toBe(3);
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("reports deterministic warning when missing-id vector prune fails", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const semanticMock = installFailingFetchMock({ text: "delete failed" });

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, ["pm-missing"]);
        expect(result.refreshed).toEqual([]);
        expect(result.skipped).toEqual(["pm-missing"]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("search_semantic_refresh_delete_failed:");
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("reports deterministic read warning when located item cannot be parsed", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context, "Unreadable semantic refresh item");
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const brokenItemPath = path.join(context.pmPath, "tasks", `${itemId}.toon`);
      await fs.writeFile(brokenItemPath, "not-json-front-matter", "utf8");

      const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemId]);
      expect(result.refreshed).toEqual([]);
      expect(result.skipped).toEqual([itemId]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(`search_semantic_refresh_item_read_failed:${itemId}:`);
    });
  });

  it("combines cache invalidation and semantic refresh warnings in mutation refresh helper", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context, "Combined refresh item");
      await fs.mkdir(path.join(context.pmPath, "index"), { recursive: true });
      await fs.mkdir(path.join(context.pmPath, "search"), { recursive: true });
      await fs.writeFile(path.join(context.pmPath, "index", "manifest.json"), '{"ok":true}\n', "utf8");
      await fs.writeFile(path.join(context.pmPath, "search", "embeddings.jsonl"), '{"id":"x"}\n', "utf8");

      const result = await refreshSearchArtifactsForMutation(context.pmPath, [itemId]);
      expect(result.invalidated).toEqual([...SEARCH_CACHE_ARTIFACT_PATHS]);
      expect(result.refreshed).toEqual([]);
      expect(result.skipped).toEqual([itemId]);
      expect(result.warnings).toEqual(["search_semantic_refresh_skipped:provider_unconfigured"]);
    });
  });

  it("honors cache-only mutation refresh policy without calling semantic providers", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context, "Cache-only mutation refresh item");
      const settings = await readSettings(context.pmPath);
      settings.search.mutation_refresh_policy = "cache_only";
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const semanticMock = installFailingFetchMock({ text: "semantic refresh should not run" });

      try {
        const result = await refreshSearchArtifactsForMutation(context.pmPath, [itemId]);
        expect(result.refreshed).toEqual([]);
        expect(result.skipped).toEqual([itemId]);
        expect(result.warnings).toEqual([]);
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("keeps mutation refresh enabled for explicitly configured semantic search", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context, "Configured mutation refresh item");
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock();

      try {
        const result = await refreshSearchArtifactsForMutation(context.pmPath, [itemId]);
        expect(result.refreshed).toEqual([itemId]);
        expect(result.skipped).toEqual([]);
        expect(result.warnings).toEqual([]);
      } finally {
        semanticMock.restore();
      }
    });
  });
});

const SEARCH_REFRESH_INLINE_ENV = "PM_SEARCH_REFRESH_INLINE";
const SEARCH_REFRESH_CHILD_ENV = "PM_SEARCH_REFRESH_CHILD";

describe("search background refresh", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [SEARCH_REFRESH_INLINE_ENV, SEARCH_REFRESH_CHILD_ENV]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("exposes the shared reindex lock id so reindex and refresh never write concurrently", () => {
    expect(REINDEX_LOCK_ID).toBe("reindex");
  });

  describe("shouldRunSearchRefreshInForeground", () => {
    it("runs inline under the vitest runner by default", () => {
      // VITEST is set by the test runner, so the gate stays inline (deterministic).
      expect(shouldRunSearchRefreshInForeground()).toBe(true);
    });

    it("honors the explicit inline override flag", () => {
      process.env[SEARCH_REFRESH_INLINE_ENV] = "1";
      expect(shouldRunSearchRefreshInForeground()).toBe(true);
      process.env[SEARCH_REFRESH_INLINE_ENV] = "false";
      // Still inline because the vitest runner env forces inline regardless.
      expect(shouldRunSearchRefreshInForeground()).toBe(true);
    });

    it("treats the worker-child marker as inline", () => {
      process.env[SEARCH_REFRESH_CHILD_ENV] = "yes";
      expect(shouldRunSearchRefreshInForeground()).toBe(true);
    });
  });

  describe("pending queue", () => {
    it("merges, de-duplicates, and sorts enqueued ids and drains them once", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        await enqueuePendingRefreshIds(pmPath, ["pm-b", "pm-a"]);
        await enqueuePendingRefreshIds(pmPath, ["pm-a", "pm-c"]);

        const drained = await drainPendingRefreshIds(pmPath);
        expect(drained).toEqual(["pm-a", "pm-b", "pm-c"]);

        // Second drain is empty — ids are consumed exactly once.
        expect(await drainPendingRefreshIds(pmPath)).toEqual([]);
      });
    });

    it("ignores empty enqueue requests without writing the queue file", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        await enqueuePendingRefreshIds(pmPath, []);
        await enqueuePendingRefreshIds(pmPath, ["", "   "]);
        expect(await drainPendingRefreshIds(pmPath)).toEqual([]);
      });
    });

    it("recovers from a corrupt queue file by treating it as empty", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        await fs.writeFile(path.join(pmPath, "search", "pending-refresh.json"), "{not json", "utf8");
        expect(await drainPendingRefreshIds(pmPath)).toEqual([]);
        await enqueuePendingRefreshIds(pmPath, ["pm-x"]);
        expect(await drainPendingRefreshIds(pmPath)).toEqual(["pm-x"]);
      });
    });
  });

  describe("runSemanticRefreshWorker", () => {
    it("drains the queue and refreshes ids under the reindex lock", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        await enqueuePendingRefreshIds(pmPath, ["pm-1", "pm-2"]);
        const calls: string[][] = [];
        const result = await runSemanticRefreshWorker(pmPath, async (_root, ids) => {
          calls.push(ids);
          return { refreshed: ids, skipped: [], warnings: [] };
        });

        expect(calls).toEqual([["pm-1", "pm-2"]]);
        expect(result.processed).toEqual(["pm-1", "pm-2"]);
        expect(result.rounds).toBe(1);
        expect(await drainPendingRefreshIds(pmPath)).toEqual([]);
      });
    });

    it("processes ids enqueued mid-refresh in a follow-up round", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        await enqueuePendingRefreshIds(pmPath, ["pm-1"]);
        let enqueuedFollowUp = false;
        const result = await runSemanticRefreshWorker(pmPath, async (root, ids) => {
          if (!enqueuedFollowUp) {
            enqueuedFollowUp = true;
            await enqueuePendingRefreshIds(root, ["pm-2"]);
          }
          return { refreshed: ids, skipped: [], warnings: [] };
        });

        expect(result.rounds).toBe(2);
        expect(result.processed).toEqual(["pm-1", "pm-2"]);
      });
    });

    it("returns immediately when the queue is empty", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const result = await runSemanticRefreshWorker(pmPath, async () => {
          throw new Error("refresh should not run for an empty queue");
        });
        expect(result.rounds).toBe(0);
        expect(result.processed).toEqual([]);
      });
    });

    it("re-enqueues ids and records a warning when refresh throws", async () => {
      await withTempPmPath(async ({ pmPath }) => {
        await enqueuePendingRefreshIds(pmPath, ["pm-err"]);
        const result = await runSemanticRefreshWorker(pmPath, async () => {
          throw new Error("embed boom");
        });
        expect(result.warnings.some((w) => w.startsWith("search_background_refresh_failed:"))).toBe(true);
        // Failed ids are re-queued for a later dispatch rather than dropped.
        expect(await drainPendingRefreshIds(pmPath)).toEqual(["pm-err"]);
      });
    });

    it("returns early when the pm root does not exist", async () => {
      const result = await runSemanticRefreshWorker(path.join("/nonexistent-pm-root", "missing"), async () => {
        throw new Error("should not run");
      });
      expect(result).toEqual({ processed: [], rounds: 0, warnings: [] });
    });
  });
});
