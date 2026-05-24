import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  invalidateSearchCacheArtifacts,
  refreshSearchArtifactsForMutation,
  refreshSemanticEmbeddingsForMutatedItems,
  SEARCH_CACHE_ARTIFACT_PATHS,
} from "../../src/core/search/cache.js";
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
});
