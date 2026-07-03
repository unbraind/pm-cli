import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _testOnly as searchCacheTestOnly,
  invalidateSearchCacheArtifacts,
  isSemanticRefreshActive,
  readVectorizationStatusLedger,
  refreshSearchArtifactsForMutation,
  refreshSemanticEmbeddingsForMutatedItems,
  SEARCH_CACHE_ARTIFACT_PATHS,
  writeVectorizationStatusLedger,
} from "../../../../src/core/search/cache.js";
import * as searchCache from "../../../../src/core/search/cache.js";
import { SEARCH_EMBEDDING_CORPUS_MAX_CHARACTERS_INVALID_WARNING } from "../../../../src/core/search/corpus.js";
import {
  buildVectorizationEmbeddingIdentity,
  buildVectorizationEmbeddingMetadata,
  hasVectorizationEmbeddingIdentityChanged,
  hasVectorizationVectorDimensionChanged,
  inferConsistentVectorDimension,
  normalizeVectorizationEmbeddingMetadata,
} from "../../../../src/core/search/vectorization-metadata.js";
import {
  drainPendingRefreshIds,
  enqueuePendingRefreshIds,
} from "../../../../src/core/search/background-refresh.js";
import { resolveRuntimeStatusRegistry } from "../../../../src/core/schema/runtime-schema.js";
import { SETTINGS_DEFAULTS } from "../../../../src/core/shared/constants.js";
import {
  _testOnlySearchCommand as searchInternals,
  classifyImplicitSemanticFallbackReason,
  collectErrorCauseCodes,
  resolveHybridSemanticWeight,
  resolveSearchMaxResults,
  resolveSearchScoreThreshold,
  resolveSearchTuning,
  runSearch,
  type SearchOptions,
} from "../../../../src/cli/commands/search.js";
import { setActiveExtensionHooks, setActiveExtensionRegistrations } from "../../../../src/core/extensions/index.js";
import { createEmptyExtensionRegistrationRegistry } from "../../../../src/core/extensions/loader.js";
import { readSettings, writeSettings } from "../../../../src/core/store/settings.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { withTempDir } from "../../../helpers/temp.js";
import type { TempPmContext } from "../../../helpers/withTempPmPath.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import {
  embeddingsResponse,
  fakeResponse,
  installFailingFetchMock,
  installSemanticFetchMock,
} from "../../../helpers/semanticFetchMock.js";
import { itOnPosix } from "../../../helpers/platform.js";

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
      await expect(fs.access(path.join(pmRoot, "index", "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(path.join(pmRoot, "search", "embeddings.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
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

  it("returns deterministic empty mutation refresh when no item ids are provided", async () => {
    await withTempPmPath(async (context) => {
      await fs.mkdir(path.join(context.pmPath, "index"), { recursive: true });
      await fs.writeFile(path.join(context.pmPath, "index", "manifest.json"), "{}\n", "utf8");

      const result = await refreshSearchArtifactsForMutation(context.pmPath, []);

      expect(result).toEqual({
        invalidated: ["index/manifest.json"],
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

  it("honors configured semantic corpus character limit during mutation refresh embedding", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context, "Configured mutation refresh corpus source");
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
      settings.search.embedding_corpus_max_characters = 1200;
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock();
      const inputLengths = semanticMock.inputLengths;

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemId]);
        expect(result.refreshed).toEqual([itemId]);
        expect(result.warnings).toEqual([]);
        expect(inputLengths).toHaveLength(1);
        expect(inputLengths[0]).toBeGreaterThan(300);
        expect(inputLengths[0]).toBeLessThanOrEqual(1200);
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("falls back to provider corpus default and warns when configured semantic corpus limit is invalid", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context, "Invalid mutation refresh corpus limit source");
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      settings.search.embedding_corpus_max_characters = 0;
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock();
      const inputLengths = semanticMock.inputLengths;

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemId]);
        expect(result.refreshed).toEqual([itemId]);
        expect(result.warnings).toContain(SEARCH_EMBEDDING_CORPUS_MAX_CHARACTERS_INVALID_WARNING);
        expect(inputLengths).toHaveLength(1);
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

  it("keeps existing semantic vectors when mutation refresh detects an embedding identity change", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context, "Changed provider refresh item");
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "new-model";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);
      await writeVectorizationStatusLedger(
        context.pmPath,
        {
          [itemId]: "2000-01-01T00:00:00.000Z",
          "pm-unchanged": "2026-01-01T00:00:00.000Z",
        },
        buildVectorizationEmbeddingMetadata(buildVectorizationEmbeddingIdentity("openai", "old-model")!, 2),
      );

      const semanticMock = installFailingFetchMock({ text: "mutation refresh should not embed on identity change" });

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemId]);
        expect(result.refreshed).toEqual([]);
        expect(result.skipped).toEqual([itemId]);
        expect(result.warnings).toEqual(["search_semantic_refresh_requires_reindex:embedding_identity_changed"]);
        const ledger = await readVectorizationStatusLedger(context.pmPath);
        expect(ledger.entries).toEqual({
          [itemId]: "2000-01-01T00:00:00.000Z",
          "pm-unchanged": "2026-01-01T00:00:00.000Z",
        });
        expect(ledger.embedding).toEqual({
          provider: "openai",
          model: "old-model",
          vector_dimension: 2,
        });
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("keeps existing semantic vectors when mutation refresh detects a vector dimension change", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context, "Changed dimension refresh item");
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "same-model";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);
      await writeVectorizationStatusLedger(
        context.pmPath,
        {
          [itemId]: "2000-01-01T00:00:00.000Z",
          "pm-unchanged": "2026-01-01T00:00:00.000Z",
        },
        buildVectorizationEmbeddingMetadata(buildVectorizationEmbeddingIdentity("openai", "same-model")!, 2),
      );

      const semanticMock = installSemanticFetchMock({
        embeddings: (request) =>
          fakeResponse({
            json: {
              data: Array.from({ length: request.inputCount }, (_entry, index) => ({
                index,
                embedding: [index + 0.1, index + 0.2, index + 0.3],
              })),
            },
          }),
      });

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemId]);
        expect(result.refreshed).toEqual([]);
        expect(result.skipped).toEqual([itemId]);
        expect(result.warnings).toEqual(["search_semantic_refresh_requires_reindex:vector_dimension_changed"]);
        expect(semanticMock.calls).toEqual(["https://api.example.test/v1/embeddings"]);
        const ledger = await readVectorizationStatusLedger(context.pmPath);
        expect(ledger.entries).toEqual({
          [itemId]: "2000-01-01T00:00:00.000Z",
          "pm-unchanged": "2026-01-01T00:00:00.000Z",
        });
        expect(ledger.embedding).toEqual({
          provider: "openai",
          model: "same-model",
          vector_dimension: 2,
        });
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

  itOnPosix("records ledger write warnings when semantic refresh cannot persist vectorization status", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context, "Ledger write warning item");
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      // Allow the initial ledger read, but make later writes fail deterministically.
      const searchDir = path.join(context.pmPath, "search");
      const ledgerPath = path.join(searchDir, "vectorization-status.json");
      await fs.mkdir(searchDir, { recursive: true });
      await fs.writeFile(
        ledgerPath,
        JSON.stringify({
          version: 1,
          embedding: {
            provider: "openai",
            model: "text-embedding-3-small",
          },
          items: [],
        }),
        "utf8",
      );
      await fs.chmod(searchDir, 0o555);

      const semanticMock = installSemanticFetchMock();
      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemId]);
        expect(result.refreshed).toEqual([itemId]);
        expect(result.warnings.some((warning) => warning.startsWith("search_vectorization_status_ledger_write_failed:"))).toBe(
          true,
        );
      } finally {
        await fs.chmod(searchDir, 0o755).catch(() => {});
        semanticMock.restore();
      }
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

  it("returns mutation refresh warnings when settings are missing or unreadable", async () => {
    await withTempDir("pm-cli-search-cache-mutation-", async (pmRoot) => {
      const uninitialized = await refreshSearchArtifactsForMutation(pmRoot, ["pm-missing"]);
      expect(uninitialized).toEqual({
        invalidated: [],
        refreshed: [],
        skipped: ["pm-missing"],
        warnings: ["search_semantic_refresh_skipped:settings_not_initialized"],
      });
    });

    await withTempDir("pm-cli-search-cache-mutation-", async (pmRoot) => {
      await fs.mkdir(path.join(pmRoot, "settings.json"), { recursive: true });
      const unreadable = await refreshSearchArtifactsForMutation(pmRoot, ["pm-settings-dir"]);
      expect(unreadable.refreshed).toEqual([]);
      expect(unreadable.skipped).toEqual(["pm-settings-dir"]);
      expect(unreadable.warnings[0]).toContain("search_semantic_refresh_skipped:settings_read_failed:");
    });
  });

  it("schedules configured semantic mutation refreshes in the background", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context, "Background scheduled refresh item");
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const result = await refreshSearchArtifactsForMutation(context.pmPath, [itemId], { background: true });
      expect(result).toMatchObject({
        invalidated: [],
        refreshed: [],
        skipped: [],
        warnings: ["search_semantic_refresh_scheduled_background"],
        scheduled: true,
      });
      expect(await drainPendingRefreshIds(context.pmPath)).toEqual([itemId]);
    });
  });
});

describe("cli/commands/search", () => {
  afterEach(() => {
    setActiveExtensionHooks(null);
    setActiveExtensionRegistrations(null);
  });

  async function searchInContext(
    context: TempPmContext,
    query: string,
    options: SearchOptions = {},
  ): Promise<Awaited<ReturnType<typeof runSearch>>> {
    return await runSearch(query, options, { path: context.pmPath });
  }

  it("covers search helper branches for projection, scoring, projection reads, and semantic merging", async () => {
    const item = {
      id: "pm-search-helper",
      title: "Alpha Alpha helper",
      description: "Description beta",
      type: "Task",
      status: "open",
      priority: 1,
      tags: ["alpha", "beta"],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      deadline: null,
      comments: [{ text: "comment alpha" }],
      notes: [{ text: "note beta" }],
      learnings: [{ text: "learning gamma" }],
      dependencies: [{ id: "pm-dep", kind: "blocks" }],
      reminders: [{ at: "2026-01-03T00:00:00.000Z", text: "reminder alpha" }],
      events: [{ at: "2026-01-04T00:00:00.000Z", title: "event beta", kind: "due" }],
      files: [
        { scope: "project", path: "linked.txt" },
        { scope: "project", path: "linked.txt" },
        { scope: "global", path: "global.txt" },
        { scope: "project", path: "   " },
      ],
      docs: [{ scope: "project", path: "docs/readme.md" }],
      tests: [
        { scope: "project", path: "tests/helper.spec.ts" },
        { scope: "project", command: "pnpm test" },
      ],
    };
    const document = { metadata: item, body: "body alpha alpha" };
    const tuning = resolveSearchTuning({});

    expect(searchInternals.countOccurrences("aaaa", "aa")).toBe(2);
    expect(searchInternals.countOccurrences("abc", "z")).toBe(0);
    expect(searchInternals.stringArray(["a", 1, "b"])).toEqual(["a", "b"]);
    expect(searchInternals.stringArray("not-array")).toEqual([]);
    expect(searchInternals.textEntries([{ text: "ok" }, { value: "no" }, null])).toEqual([{ text: "ok" }]);
    expect(searchInternals.textEntries({ text: "nope" })).toEqual([]);
    expect(searchInternals.dependencyEntries([{ id: "pm-a", kind: "blocks" }, { id: 1, kind: "bad" }])).toEqual([
      { id: "pm-a", kind: "blocks" },
    ]);
    expect(searchInternals.dependencyEntries("not-array")).toEqual([]);
    expect(searchInternals.collectLinkedPaths(item as never)).toEqual([
      { scope: "global", path: "global.txt" },
      { scope: "project", path: "docs/readme.md" },
      { scope: "project", path: "linked.txt" },
      { scope: "project", path: "tests/helper.spec.ts" },
    ]);
    expect(searchInternals.collectExactPhraseFields(document as never).join(" ")).toContain("comment alpha");
    expect(searchInternals.documentContainsExactPhrase(document as never, "note beta")).toBe(true);
    expect(searchInternals.applyExactQueryFilters([document] as never, "alpha alpha helper", {
      titleExact: true,
      phraseExact: true,
    })).toHaveLength(1);
    expect(searchInternals.applyExactQueryFilters([document] as never, "missing", {
      titleExact: false,
      phraseExact: true,
    })).toHaveLength(0);
    expect(searchInternals.applyExactQueryFilters([document] as never, "wrong title", {
      titleExact: true,
      phraseExact: false,
    })).toHaveLength(0);
    expect(
      searchInternals.buildCompactSearchFilterSummary(
        {
          mode: "hybrid",
          options: {
            status: "open",
            type: "Task",
            tag: "alpha",
            priority: "1",
            deadlineBefore: "+7d",
            deadlineAfter: "-1d",
            semanticWeight: "0.25",
            limit: "3",
          },
          includeLinked: true,
          titleExact: true,
          phraseExact: true,
          scoreThreshold: 0.4,
          hybridSemanticWeight: 0.25,
          runtimeFieldFilters: { assignee: "unit-test" },
        },
      ),
    ).toEqual({
      status: "open",
      type: "Task",
      tag: "alpha",
      priority: "1",
      deadline_before: "+7d",
      deadline_after: "-1d",
      include_linked: true,
      title_exact: true,
      phrase_exact: true,
      score_threshold: 0.4,
      hybrid_semantic_weight: 0.25,
      limit: "3",
      runtime_filters: { assignee: "unit-test" },
    });
    expect(
      searchInternals.buildCompactSearchFilterSummary(
        {
          mode: "keyword",
          options: {
            updatedAfter: "2026-01-01T00:00:00.000Z",
            updatedBefore: "2026-01-05T00:00:00.000Z",
            createdAfter: "2025-12-31T00:00:00.000Z",
            createdBefore: "2026-01-06T00:00:00.000Z",
            release: "r1",
            parent: "pm-parent",
          },
          includeLinked: false,
          titleExact: false,
          phraseExact: false,
          scoreThreshold: 0,
          hybridSemanticWeight: 0.7,
        },
      ),
    ).toEqual({
      updated_after: "2026-01-01T00:00:00.000Z",
      updated_before: "2026-01-05T00:00:00.000Z",
      created_after: "2025-12-31T00:00:00.000Z",
      created_before: "2026-01-06T00:00:00.000Z",
      release: "r1",
      parent: "pm-parent",
    });
    expect(searchInternals.parseTimestampWindow("   ", "updated-after")).toBeUndefined();
    expect(
      searchInternals.buildVerboseSearchFilters({
        effectiveMode: "keyword",
        matchMode: "or",
        options: {
          updatedAfter: "2026-01-01T00:00:00.000Z",
          updatedBefore: "2026-01-05T00:00:00.000Z",
          createdAfter: "2025-12-31T00:00:00.000Z",
          createdBefore: "2026-01-06T00:00:00.000Z",
          release: "r1",
          parent: "pm-parent",
        } as never,
        includeLinked: false,
        titleExact: false,
        phraseExact: false,
        scoreThreshold: 0,
        hybridSemanticWeight: 0.7,
        queryExpansion: { enabled: false, provider: null, max_queries: 4 },
        rerank: { enabled: false, model: null, top_k: 25 },
        runtimeFieldFilters: {},
      }),
    ).toMatchObject({
      updated_after: "2026-01-01T00:00:00.000Z",
      updated_before: "2026-01-05T00:00:00.000Z",
      created_after: "2025-12-31T00:00:00.000Z",
      created_before: "2026-01-06T00:00:00.000Z",
      release: "r1",
      parent: "pm-parent",
    });
    expect(searchInternals.classifyImplicitSemanticFallbackReason(new Error("timed out"))).toBe("timeout");
    expect(searchInternals.classifyImplicitSemanticFallbackReason(new Error("fetch failed"))).toBe("connection");
    expect(searchInternals.classifyImplicitSemanticFallbackReason(new Error("boom"))).toBe("error");
    expect(searchInternals.buildExplicitSemanticFallbackWarning("hybrid", new Error("boom"))).toBe(
      "search_hybrid_fallback:error:using_keyword_mode",
    );

    const hit = searchInternals.scoreDocument(document as never, ["alpha", "beta"], "alpha beta", "linked alpha", tuning);
    expect(hit).toMatchObject({ item: expect.objectContaining({ id: "pm-search-helper" }) });
    expect(hit?.matched_fields).toEqual(expect.arrayContaining(["body", "comments", "linked_content", "title"]));
    expect(searchInternals.scoreDocument(document as never, ["zzz"], "zzz", "", tuning)).toBeNull();
    const statusRegistry = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);
    expect(
      searchInternals.sortHits(
        [
          { item: { ...item, id: "pm-b", priority: 5, updated_at: "2026-01-01T00:00:00.000Z" }, score: 1, matched_fields: [] },
          { item: { ...item, id: "pm-a", priority: 1, updated_at: "2026-01-03T00:00:00.000Z" }, score: 1, matched_fields: [] },
          { item: { ...item, id: "pm-closed", status: "closed", priority: 0, updated_at: "2026-01-04T00:00:00.000Z" }, score: 1, matched_fields: [] },
        ] as never,
        statusRegistry,
      ).map((result) => result.item.id),
    ).toEqual(["pm-a", "pm-b", "pm-closed"]);
    expect(
      searchInternals.sortHits(
        [
          { item: { ...item, id: "pm-old", priority: 1, updated_at: "2026-01-01T00:00:00.000Z" }, score: 1, matched_fields: [] },
          { item: { ...item, id: "pm-new", priority: 1, updated_at: "2026-01-02T00:00:00.000Z" }, score: 1, matched_fields: [] },
          { item: { ...item, id: "pm-alpha", priority: 1, updated_at: "2026-01-02T00:00:00.000Z" }, score: 1, matched_fields: [] },
        ] as never,
        statusRegistry,
      ).map((result) => result.item.id),
    ).toEqual(["pm-alpha", "pm-new", "pm-old"]);

    const projection = searchInternals.parseProjectionConfig({ fields: "id,item.description,score,matched_fields" });
    searchInternals.validateSearchProjectionFields(projection, { definitions: [] } as never);
    expect(() => searchInternals.validateSearchProjectionFields({ mode: "fields", fields: ["bogus"] } as never, {
      definitions: [],
    } as never)).toThrow("Unknown search --fields value");
    expect(() => searchInternals.parseTokens("   ")).toThrow("Search query must not be empty");
    expect(searchInternals.readSearchFieldValue(hit!, "item.description")).toBe("Description beta");
    expect(searchInternals.readSearchFieldValue(hit!, "score")).toBe(hit?.score);
    expect(searchInternals.readSearchFieldValue(hit!, " matched_fields ")).toEqual(hit?.matched_fields);
    expect(searchInternals.readSearchFieldValue(hit!, "   ")).toBeNull();
    expect(searchInternals.readSearchFieldValue(hit!, "item.")).toBeNull();
    expect(searchInternals.readSearchFieldValue({ ...hit!, custom: "value" } as never, "custom")).toBe("value");
    expect(searchInternals.readSearchFieldValue(hit!, "missing")).toBeNull();

    const filteredById = new Map([[item.id, document]]);
    expect(searchInternals.normalizeScoreMap(new Map())).toEqual(new Map());
    expect(searchInternals.normalizeScoreMap(new Map([["a", 7], ["b", 7]]))).toEqual(new Map([["a", 1], ["b", 1]]));
    expect(searchInternals.normalizeScoreMap(new Map([["a", 1], ["b", 3]])).get("b")).toBe(1);
    expect(searchInternals.mergeVectorHitsById([[{ id: item.id, score: 0.1 }, { id: item.id, score: 0.8 }]])).toEqual([
      { id: item.id, score: 0.8 },
    ]);
    expect(searchInternals.buildSemanticHits([{ id: item.id, score: 0.7 }, { id: "pm-missing", score: 1 }], filteredById as never)).toMatchObject({
      semanticHits: [{ item: expect.objectContaining({ id: item.id }), score: 0.7, matched_fields: ["semantic"] }],
    });
    expect(searchInternals.buildSemanticHits([{ id: item.id, score: 0.2 }, { id: item.id, score: 0.9 }], filteredById as never)).toMatchObject({
      semanticHits: [{ score: 0.2 }],
    });
    expect(
      searchInternals.combineHybridHits(
        filteredById as never,
        new Map([[item.id, 0.7]]),
        [{ item, score: 2, matched_fields: ["title"] }] as never,
        0.5,
      )[0]?.matched_fields,
    ).toEqual(["semantic", "title"]);
    expect(searchInternals.combineHybridHits(filteredById as never, new Map([[item.id, 0]]), [] as never, 0.5)).toHaveLength(1);
    expect(searchInternals.buildRerankCorpus(document as never)).toContain("Alpha Alpha helper");

    expect(() =>
      searchInternals.normalizeExtensionProviderHits("bad-provider", { hits: "nope" }, filteredById as never),
    ).toThrow("must return an array");
    expect(searchInternals.normalizeExtensionProviderHits("provider", [{ id: item.id, score: 0.2 }], filteredById as never)).toEqual([
      { item, score: 0.2, matched_fields: ["provider:provider"] },
    ]);
    expect(() =>
      searchInternals.requireSemanticDependencies("semantic", { active: null } as never, { active: null } as never, false),
    ).toThrow("requires a configured embedding provider");
    const typeRegistry = {
      alias_to_type: { task: "Task" },
      by_type: {},
      folders: ["tasks"],
      type_to_folder: { Task: "tasks" },
      types: ["Task"],
    } as never;
    expect(
      searchInternals.applyFilters(
        [document] as never,
        { createdAfter: "2026-01-03T00:00:00.000Z" } as never,
        typeRegistry,
        {},
        undefined,
      ),
    ).toEqual([]);
    expect(
      searchInternals.applyFilters(
        [document] as never,
        { createdBefore: "2025-12-31T00:00:00.000Z" } as never,
        typeRegistry,
        {},
        undefined,
      ),
    ).toEqual([]);
    expect(
      searchInternals.applyFilters(
        [{ ...document, metadata: { ...document.metadata, sprint: "sprint-a", release: "release-a", parent: "pm-parent" } }] as never,
        { sprint: "sprint-b", release: "release-b", parent: "pm-other" } as never,
        typeRegistry,
        {},
        undefined,
      ),
    ).toEqual([]);
    expect(
      searchInternals.applyFilters(
        [{ ...document, metadata: { ...document.metadata, assignee: "alice" } }] as never,
        {} as never,
        typeRegistry,
        { assignee: "bob" },
        undefined,
      ),
    ).toEqual([]);

    const registrations = createEmptyExtensionRegistrationRegistry();
    registrations.search_providers.push({
      layer: "project",
      name: "search-provider-registration",
      definition: { name: "no-hooks-provider" },
      runtime_definition: { name: "no-hooks-provider" },
    });
    registrations.vector_store_adapters.push({
      layer: "project",
      name: "vector-adapter-registration",
      definition: { name: "no-query-adapter" },
      runtime_definition: { name: "no-query-adapter" },
    });
    setActiveExtensionRegistrations(registrations);
    expect(searchInternals.resolveExtensionSearchProviderByName("no-hooks-provider")).toBeNull();
    expect(searchInternals.resolveExtensionSearchProvider({ search: { provider: "no-hooks-provider" } } as never)).toBeNull();
    expect(searchInternals.resolveExtensionVectorAdapter({ vector_store: { adapter: "no-query-adapter" } } as never)).toBeNull();

    await withTempDir("pm-search-linked-corpus-", async (tempRoot) => {
      const projectRoot = path.join(tempRoot, "project");
      const globalRoot = path.join(tempRoot, "global");
      await fs.mkdir(projectRoot, { recursive: true });
      await fs.mkdir(globalRoot, { recursive: true });
      await fs.writeFile(path.join(projectRoot, "linked.txt"), "project linked alpha", "utf8");
      await fs.writeFile(path.join(globalRoot, "global.txt"), "global linked beta", "utf8");
      const roots = await searchInternals.resolveLinkedCorpusRoots(projectRoot, globalRoot);
      const linked = await searchInternals.loadLinkedCorpus(document as never, roots);
      expect(linked).toContain("project linked alpha");
      expect(linked).toContain("global linked beta");
    });
    await withTempDir("pm-search-ledger-", async (pmRoot) => {
      await fs.mkdir(path.join(pmRoot, "search"), { recursive: true });
      await fs.writeFile(path.join(pmRoot, "search", "vectorization-status.json"), "{", "utf8");
      const warnings: string[] = [];
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await searchInternals.maybeEmitVectorIndexStaleWarning(pmRoot, [] as never, warnings);
      } finally {
        stderrSpy.mockRestore();
      }
      expect(warnings).toContain("search_vectorization_status_ledger_invalid");
      expect(warnings.some((warning) => warning.startsWith("vector_index_stale:"))).toBe(false);
    });
  });

  it("covers direct semantic and hybrid helper edge branches", async () => {
    const itemA = {
      id: "pm-sem-a",
      title: "Semantic alpha",
      description: "",
      type: "Task",
      status: "open",
      priority: 1,
      tags: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    };
    const itemB = { ...itemA, id: "pm-sem-b", title: "Semantic beta", priority: 2 };
    const filteredDocuments = [
      { metadata: itemA, body: "alpha body" },
      { metadata: itemB, body: "beta body" },
    ];
    const settings = structuredClone(SETTINGS_DEFAULTS);
    settings.providers.openai.base_url = "https://api.example.test/v1";
    settings.providers.openai.model = "text-embedding-3-small";

    const semanticMock = installSemanticFetchMock();
    try {
      const unavailableWarnings: string[] = [];
      const semanticResult = await searchInternals.computeSemanticOrHybridHits({
        requestedMode: "semantic",
        query: "semantic alpha",
        filteredDocuments,
        keywordHits: [],
        hybridSemanticWeight: 0.7,
        limit: 2,
        maxResults: 5,
        provider: {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
          api_key: "",
        },
        vectorStore: null,
        extensionVectorAdapter: {
          query: () => [
            { id: "pm-sem-b", score: 0.6 },
            { id: "pm-sem-a", score: 0.6 },
            { id: "pm-sem-a", score: 0.4 },
          ],
        },
        queryExpansion: { enabled: true, provider: "missing-extension", max_queries: 2 },
        queryExpansionExtension: null,
        rerank: { enabled: false, model: "rerank-model", top_k: 2 },
        rerankExtension: null,
        warnings: unavailableWarnings,
        settings,
      } as never);

      expect(semanticResult.vectorMatchCount).toBe(2);
      expect(semanticResult.hits.map((hit: { item: { id: string } }) => hit.item.id)).toEqual(["pm-sem-a", "pm-sem-b"]);
      expect(unavailableWarnings).toContain("search_query_expansion_provider_unavailable:missing-extension:using_builtin");

      const failedWarnings: string[] = [];
      const hybridError = await searchInternals.computeSemanticOrHybridHits({
        requestedMode: "hybrid",
        query: "semantic alpha",
        filteredDocuments,
        keywordHits: [
          { item: itemA, score: 2, matched_fields: ["title"] },
          { item: itemB, score: 1, matched_fields: ["body"] },
        ],
        hybridSemanticWeight: 0.5,
        limit: 2,
        maxResults: 5,
        provider: {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
          api_key: "",
        },
        vectorStore: null,
        extensionVectorAdapter: {
          query: () => {
            throw new Error("extension vector down");
          },
        },
        queryExpansion: { enabled: true, provider: "ext-provider", max_queries: 2 },
        queryExpansionExtension: {
          providerName: "ext-provider",
          expand: () => {
            throw new Error("expansion down");
          },
        },
        rerank: { enabled: true, model: "rerank-model", top_k: 2 },
        rerankExtension: null,
        warnings: failedWarnings,
        settings,
      } as never).catch((error: unknown) => error);

      expect(hybridError).toBeInstanceOf(Error);
      expect(String((hybridError as Error).message)).toContain("Extension vector adapter query failed");
      expect(failedWarnings).toContain("search_query_expansion_provider_failed:ext-provider:using_builtin");
    } finally {
      semanticMock.restore();
    }
  });

  it("covers keyword scoring, filters, projection modes, and linked content", async () => {
    await withTempPmPath(async (context) => {
      const alphaId = createTestItemId(context, {
        title: "Alpha launch target",
        description: "Release work mentions beta once",
        tags: "search,alpha",
        priority: "1",
        body: "alpha launch body with dependency marker",
        deadline: "+2d",
        comment: "author=unit-test,created_at=now,text=alpha comment text",
        note: "author=unit-test,created_at=now,text=alpha note text",
        learning: "author=unit-test,created_at=now,text=alpha learning text",
        dep: "id=pm-related,kind=blocks,author=unit-test,created_at=now",
        file: "path=README.md,scope=project,note=linked project readme",
        test: "command=node dist/cli.js --version,path=package.json,scope=project,note=linked test path",
        doc: "path=AGENTS.md,scope=project,note=linked agent guide",
      });
      createTestItemId(context, {
        title: "Beta closed target",
        description: "Closed beta item",
        status: "closed",
        tags: "search,beta",
        priority: "3",
        body: "beta body",
      });

      const compact = await searchInContext(context, "alpha launch", {
        compact: true,
        includeLinked: true,
        status: "open",
        type: "Task",
        tag: "alpha",
        priority: "1",
        deadlineBefore: "+10d",
        deadlineAfter: "-1d",
        limit: "5",
      });
      expect(compact.mode).toBe("keyword");
      expect(compact.count).toBe(1);
      expect(compact.filters).toMatchObject({
        status: "open",
        type: "Task",
        tag: "alpha",
        priority: "1",
        include_linked: true,
        limit: "5",
      });
      expect(compact.items[0]).toMatchObject({
        id: alphaId,
        title: "Alpha launch target",
        status: "open",
      });

      const fields = await searchInContext(context, "alpha", {
        fields: "id,item.description,score,matched_fields,resolution",
      });
      expect(fields.projection).toEqual({
        mode: "fields",
        fields: ["id", "item.description", "score", "matched_fields", "resolution"],
      });
      expect(fields.items[0]).toMatchObject({
        id: alphaId,
        "item.description": "Release work mentions beta once",
      });
      expect(fields.items[0]).toHaveProperty("score");
      expect(fields.items[0]).toHaveProperty("matched_fields");
      expect(fields.items[0]).toHaveProperty("resolution", null);

      const exactMiss = await searchInContext(context, "alpha", { titleExact: true });
      expect(exactMiss.count).toBe(0);

      const phraseHit = await searchInContext(context, "alpha comment", { phraseExact: true, full: true });
      expect(phraseHit.count).toBe(1);
      expect(phraseHit.projection).toEqual({ mode: "full", fields: null });
    });
  });

  it("returns empty keyword results before scoring when filters or limits remove the corpus", async () => {
    await withTempPmPath(async (context) => {
      createTestItemId(context, {
        title: "Filtered search target",
        tags: "search,filtered",
        body: "filtered body",
      });

      const noMatches = await searchInContext(context, "filtered", { status: "closed", compact: true });
      expect(noMatches).toMatchObject({
        mode: "keyword",
        count: 0,
        items: [],
        filters: { status: "closed" },
      });

      const limitedOut = await searchInContext(context, "filtered", { limit: "0" });
      expect(limitedOut.count).toBe(0);
      expect(limitedOut.projection).toEqual({ mode: "full", fields: null });
    });
  });

  it("validates query, projection, mode, fields, status, and initialization errors", async () => {
    await expect(runSearch(" ", {}, { path: "/tmp/pm-cli-missing-search-root" })).rejects.toThrow(
      "Search query must not be empty",
    );
    await withTempDir("pm-cli-search-command-uninit-", async (pmRoot) => {
      await expect(runSearch("alpha", {}, { path: pmRoot })).rejects.toThrow("Tracker is not initialized");
    });
    await withTempPmPath(async (context) => {
      await expect(searchInContext(context, "alpha", { compact: true, full: true })).rejects.toThrow(
        "Search projection options are mutually exclusive",
      );
      await expect(searchInContext(context, "alpha", { fields: "  , " })).rejects.toThrow(
        "Search --fields requires",
      );
      await expect(searchInContext(context, "alpha", { fields: "id,unknown_field" })).rejects.toThrow(
        "Unknown search --fields value",
      );
      await expect(searchInContext(context, "alpha", { mode: "vector" })).rejects.toThrow(
        "Search mode must be one of",
      );
      await expect(searchInContext(context, "alpha", { status: "does-not-exist" })).rejects.toThrow(
        "Invalid --status value",
      );
    });
  });

  it("falls semantic and hybrid modes back to keyword with classified warnings", async () => {
    await withTempPmPath(async (context) => {
      createTestItemId(context, {
        title: "Semantic fallback target",
        tags: "search,semantic",
        body: "semantic fallback lexical body",
      });

      const semantic = await searchInContext(context, "semantic", { mode: "semantic" });
      expect(semantic.mode).toBe("keyword");
      expect(semantic.warnings).toContain("search_semantic_fallback:error:using_keyword_mode");
      expect(semantic.count).toBe(1);

      const hybrid = await searchInContext(context, "semantic", {
        mode: "hybrid",
        semanticWeight: "not-a-number",
      });
      expect(hybrid.mode).toBe("keyword");
      expect(hybrid.warnings).toEqual(
        expect.arrayContaining([
          "search_hybrid_semantic_weight_override_invalid:using_settings_default",
          "search_hybrid_fallback:error:using_keyword_mode",
        ]),
      );
      expect(hybrid.filters.hybrid_semantic_weight).toBeNull();
    });
  });

  it("covers search tuning defaults and fallback classifiers", () => {
    const nested = new Error("fetch failed", {
      cause: Object.assign(new Error("connect failed"), {
        code: "ECONNREFUSED",
        cause: { code: "ETIMEDOUT" },
      }),
    });
    expect(collectErrorCauseCodes(nested)).toBe("econnrefused etimedout");
    expect(classifyImplicitSemanticFallbackReason(nested)).toBe("timeout");
    expect(classifyImplicitSemanticFallbackReason(new Error("fetch failed"))).toBe("connection");
    expect(classifyImplicitSemanticFallbackReason("plain failure")).toBe("error");

    expect(resolveSearchMaxResults({ search: { max_results: 2.8 } })).toBe(2);
    expect(resolveSearchMaxResults({ search: { max_results: 0 } })).toBe(50);
    expect(resolveSearchScoreThreshold({ search: { score_threshold: 4.5 } })).toBe(4.5);
    expect(resolveSearchScoreThreshold({ search: { score_threshold: "bad" } })).toBe(0);
    expect(resolveHybridSemanticWeight({ search: { hybrid_semantic_weight: 0.25 } })).toBe(0.25);
    expect(resolveHybridSemanticWeight({ search: { hybrid_semantic_weight: 2 } })).toBe(0.7);
    expect(resolveSearchTuning({ search: { tuning: { title_weight: 12, body_weight: -1 } } })).toMatchObject({
      title_weight: 12,
      body_weight: 1,
    });
  });

  it("uses extension search providers and normalizes returned hits", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createTestItemId(context, {
        title: "Extension provider first",
        body: "extension provider first body",
      });
      const secondId = createTestItemId(context, {
        title: "Extension provider second",
        body: "extension provider second body",
      });
      const settings = await readSettings(context.pmPath);
      settings.search.provider = "ext-provider";
      await writeSettings(context.pmPath, settings);

      const registrations = createEmptyExtensionRegistrationRegistry();
      const queryCalls: Array<{ query: string; mode: string; documents: number }> = [];
      registrations.search_providers.push({
        layer: "project",
        name: "search-provider-registration",
        definition: { name: "ext-provider" },
        runtime_definition: {
          name: "ext-provider",
          query: (providerContext: { query: string; mode: string; documents: unknown[] }) => {
            queryCalls.push({
              query: providerContext.query,
              mode: providerContext.mode,
              documents: providerContext.documents.length,
            });
            return {
              hits: [
                null,
                { id: firstId, score: 0.42, matched_fields: [" title ", "", "body", "title"] },
                { id: secondId, score: Number.NaN },
                { id: "pm-missing", score: 0.99 },
                { id: firstId, score: 0.99 },
                { id: secondId, score: 0.33 },
              ],
            };
          },
        },
      });
      setActiveExtensionRegistrations(registrations);

      const result = await searchInContext(context, "extension", { mode: "semantic", full: true });

      expect(queryCalls).toEqual([{ query: "extension", mode: "semantic", documents: 2 }]);
      expect(result.mode).toBe("semantic");
      expect(result.count).toBe(2);
      expect(result.items[0]).toMatchObject({
        item: expect.objectContaining({ id: firstId }),
        score: 0.42,
        matched_fields: ["body", "title"],
      });
      expect(result.items[1]).toMatchObject({
        item: expect.objectContaining({ id: secondId }),
        score: 0.33,
        matched_fields: ["provider:ext-provider"],
      });
    });
  });

  it("falls through from failing extension providers to built-in semantic, expansion, vector, and rerank hooks", async () => {
    await withTempPmPath(async (context) => {
      const lowerId = createTestItemId(context, {
        title: "Hybrid extension lower",
        body: "hybrid semantic lower body",
      });
      const higherId = createTestItemId(context, {
        title: "Hybrid extension higher",
        body: "hybrid semantic higher body",
      });
      const settings = await readSettings(context.pmPath);
      settings.search.provider = "ext-provider";
      settings.search.query_expansion = { enabled: true, provider: "ext-provider" };
      settings.search.rerank = { enabled: true, model: "rerank-model", top_k: 2 };
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.adapter = "ext-vector";
      await writeSettings(context.pmPath, settings);

      const registrations = createEmptyExtensionRegistrationRegistry();
      const expandedQueries: string[] = [];
      const vectorLimits: number[] = [];
      const rerankCandidateIds: string[][] = [];
      registrations.search_providers.push({
        layer: "project",
        name: "search-provider-registration",
        definition: { name: "ext-provider" },
        runtime_definition: {
          name: "ext-provider",
          query: () => {
            throw new Error("provider query failed");
          },
          queryExpansion: () => ({ queries: ["hybrid extension expansion", "hybrid extension expansion"] }),
          rerank: (context: { candidates: Array<{ id: string }>; top_k: number }) => {
            rerankCandidateIds.push(context.candidates.map((candidate) => candidate.id));
            return {
              hits: [
                { id: higherId, score: 0.99 },
                { id: lowerId, score: 0.1 },
              ],
            };
          },
        },
      });
      registrations.vector_store_adapters.push({
        layer: "project",
        name: "vector-adapter-registration",
        definition: { name: "ext-vector" },
        runtime_definition: {
          name: "ext-vector",
          query: (context: { limit: number }) => {
            vectorLimits.push(context.limit);
            return [
              { id: lowerId, score: 0.25 },
              { id: higherId, score: 0.9 },
              { id: lowerId, score: 0.1 },
            ];
          },
        },
      });
      setActiveExtensionRegistrations(registrations);

      const semanticMock = installSemanticFetchMock({
        embeddings: (request) => {
          expandedQueries.push(...request.inputs);
          return embeddingsResponse(request.inputCount);
        },
      });
      try {
        const result = await searchInContext(context, "hybrid extension", {
          mode: "hybrid",
          semanticWeight: "0.5",
          limit: "3",
          full: true,
        });

        expect(result.mode).toBe("hybrid");
        expect(result.warnings ?? []).not.toContain("search_hybrid_fallback:error:using_keyword_mode");
        expect(expandedQueries).toContain("hybrid extension expansion");
        expect(vectorLimits).toEqual([3, 3, 3]);
        expect(rerankCandidateIds[0]).toEqual([higherId, lowerId]);
        expect(result.items.map((item) => ("item" in item ? item.item.id : undefined))).toEqual([higherId, lowerId]);
        expect(result.items[0]).toMatchObject({
          score: 0.99,
          matched_fields: expect.arrayContaining(["rerank", "semantic"]),
        });
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("loads only contained readable linked content when include-linked is enabled", async () => {
    await withTempPmPath(async (context) => {
      await fs.writeFile(path.join(process.cwd(), "linked-search-owned.tmp"), "ultrararelinkedneedle", "utf8");
      try {
        createTestItemId(context, {
          title: "Linked content target",
          body: "ordinary body",
          file: "path=linked-search-owned.tmp,scope=project,note=readable",
        });

        const withoutLinked = await searchInContext(context, "ultrararelinkedneedle", {});
        expect(withoutLinked.count).toBe(0);

        const withLinked = await searchInContext(context, "ultrararelinkedneedle", { includeLinked: true, compact: true });
        expect(withLinked.count).toBe(1);
        expect(withLinked.filters).toMatchObject({ include_linked: true });
        expect(withLinked.items[0]).toMatchObject({
          title: "Linked content target",
          matched_fields: ["linked_content"],
        });
      } finally {
        await fs.rm(path.join(process.cwd(), "linked-search-owned.tmp"), { force: true });
      }
    });
  });

  it("covers semantic empty, provider-failure, and no-vector-match fallback paths", async () => {
    await withTempPmPath(async (context) => {
      createTestItemId(context, {
        title: "Semantic limit zero target",
        body: "semantic limit zero body",
      });
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.adapter = "ext-vector";
      await writeSettings(context.pmPath, settings);

      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.vector_store_adapters.push({
        layer: "project",
        name: "vector-adapter-registration",
        definition: { name: "ext-vector" },
        runtime_definition: {
          name: "ext-vector",
          query: () => {
            throw new Error("limit zero should not query vectors");
          },
        },
      });
      setActiveExtensionRegistrations(registrations);

      const result = await searchInContext(context, "semantic", { mode: "semantic", limit: "0" });
      expect(result).toMatchObject({
        mode: "semantic",
        count: 0,
        items: [],
        filters: expect.objectContaining({ limit: "0" }),
      });
    });

    await withTempPmPath(async (context) => {
      createTestItemId(context, {
        title: "Extension provider failure",
        body: "extension provider failure body",
      });
      const settings = await readSettings(context.pmPath);
      settings.search.provider = "ext-provider";
      await writeSettings(context.pmPath, settings);

      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.search_providers.push({
        layer: "project",
        name: "search-provider-registration",
        definition: { name: "ext-provider" },
        runtime_definition: {
          name: "ext-provider",
          query: () => {
            throw new Error("provider failed");
          },
        },
      });
      setActiveExtensionRegistrations(registrations);

      const result = await searchInContext(context, "extension provider failure", { mode: "semantic" });
      expect(result.mode).toBe("keyword");
      expect(result.count).toBe(1);
      expect(result.warnings).toContain("search_semantic_fallback:error:using_keyword_mode");
    });

    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, {
        title: "Semantic no vector target",
        body: "semantic no vector body",
      });
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.adapter = "ext-vector";
      await writeSettings(context.pmPath, settings);

      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.vector_store_adapters.push({
        layer: "project",
        name: "vector-adapter-registration",
        definition: { name: "ext-vector" },
        runtime_definition: {
          name: "ext-vector",
          query: () => [],
        },
      });
      setActiveExtensionRegistrations(registrations);

      const semanticMock = installSemanticFetchMock();
      try {
        const result = await searchInContext(context, "semantic no vector", { mode: "semantic", full: true });
        expect(result.mode).toBe("semantic");
        expect(result.warnings).toContain("search_semantic_degraded:no_vector_matches:results_are_lexical");
        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toMatchObject({ item: expect.objectContaining({ id }) });
      } finally {
        semanticMock.restore();
      }
    });
  });
});

describe("core/search/vectorization-metadata", () => {
  it("normalizes provider/model identity and embedding metadata", () => {
    const identity = buildVectorizationEmbeddingIdentity(" ollama ", " qwen3-embedding:0.6b ");
    expect(identity).toEqual({
      provider: "ollama",
      model: "qwen3-embedding:0.6b",
    });
    expect(buildVectorizationEmbeddingIdentity("", "model")).toBeNull();
    expect(buildVectorizationEmbeddingIdentity("provider", " ")).toBeNull();
    expect(normalizeVectorizationEmbeddingMetadata(undefined)).toBeNull();
    expect(normalizeVectorizationEmbeddingMetadata(null)).toBeNull();
    expect(
      normalizeVectorizationEmbeddingMetadata({
        provider: "ollama",
        model: "qwen3",
        vector_dimension: 1024,
      }),
    ).toEqual({
      provider: "ollama",
      model: "qwen3",
      vector_dimension: 1024,
    });
    expect(buildVectorizationEmbeddingMetadata(identity!, 1024)).toEqual({
      provider: "ollama",
      model: "qwen3-embedding:0.6b",
      vector_dimension: 1024,
    });
  });

  it("rejects invalid embedding metadata shapes", () => {
    expect(() => normalizeVectorizationEmbeddingMetadata("bad")).toThrow("must be an object");
    expect(() =>
      normalizeVectorizationEmbeddingMetadata({
        provider: "ollama",
        model: "qwen3",
        vector_dimension: "1024",
      }),
    ).toThrow("provider, model, and positive vector_dimension");
    expect(() => buildVectorizationEmbeddingMetadata({ provider: "ollama", model: "qwen3" }, 0)).toThrow(
      "positive vector dimension",
    );
  });

  it("detects identity and dimension changes", () => {
    const metadata = {
      provider: "ollama",
      model: "qwen3",
      vector_dimension: 1024,
    };
    expect(hasVectorizationEmbeddingIdentityChanged(null, { provider: "ollama", model: "qwen3" })).toBe(true);
    expect(hasVectorizationEmbeddingIdentityChanged(metadata, { provider: "ollama", model: "qwen3" })).toBe(false);
    expect(hasVectorizationEmbeddingIdentityChanged(metadata, { provider: "openai", model: "qwen3" })).toBe(true);
    expect(hasVectorizationEmbeddingIdentityChanged(metadata, { provider: "ollama", model: "nomic" })).toBe(true);
    expect(hasVectorizationVectorDimensionChanged(null, 1024)).toBe(false);
    expect(hasVectorizationVectorDimensionChanged(metadata, 1024)).toBe(false);
    expect(hasVectorizationVectorDimensionChanged(metadata, 768)).toBe(true);
  });

  it("infers consistent vector dimensions and rejects unusable vectors", () => {
    expect(inferConsistentVectorDimension([[1, 2], [3, 4]], "unit")).toBe(2);
    expect(() => inferConsistentVectorDimension([], "unit")).toThrow("unit returned no vectors");
    expect(() => inferConsistentVectorDimension([[]], "unit")).toThrow("unit returned an empty vector");
    expect(() => inferConsistentVectorDimension([[1], [2, 3]], "unit")).toThrow("unit returned mixed vector dimensions");
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

  it("runs the search-refresh entrypoint with PM_PATH and runtime defaults", async () => {
    await withTempPmPath(async (context) => {
      await enqueuePendingRefreshIds(context.pmPath, ["pm-entrypoint"]);
      const previousPmPath = process.env.PM_PATH;
      const refreshSpy = vi.spyOn(searchCache, "refreshSemanticEmbeddingsForMutatedItems").mockResolvedValue({
        refreshed: ["pm-entrypoint"],
        skipped: [],
        warnings: [],
      });
      try {
        process.env.PM_PATH = context.pmPath;
        await import("../../../../src/cli/search-refresh.js?search-refresh-entrypoint");
        expect(refreshSpy).toHaveBeenCalledWith(context.pmPath, ["pm-entrypoint"], {
          apply_runtime_defaults: true,
        });
        expect(await drainPendingRefreshIds(context.pmPath)).toEqual([]);
      } finally {
        refreshSpy.mockRestore();
        if (previousPmPath === undefined) {
          delete process.env.PM_PATH;
        } else {
          process.env.PM_PATH = previousPmPath;
        }
      }
    });
  });

  it("supports semantic refresh paths with and without runtime defaults", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context, "No runtime defaults");
      const settings = await readSettings(context.pmPath);
      settings.search.provider = "openai";
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.adapter = "qdrant";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock();
      try {
        const withoutDefaults = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemId], {
          settings,
          apply_runtime_defaults: false,
        });
        expect(withoutDefaults.refreshed).toContain(itemId);

        const withDefaults = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemId], {
          settings,
          apply_runtime_defaults: true,
        });
        expect(withDefaults.refreshed).toContain(itemId);
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("evaluates semantic refresh activity with and without runtime defaults", async () => {
    const base = structuredClone(SETTINGS_DEFAULTS);
    base.search.provider = "ollama";
    base.vector_store.adapter = "lancedb";
    base.providers.ollama.base_url = "";
    // Pre-set the model so resolveSettingsWithSemanticRuntimeDefaults does not probe
    // for a locally-installed Ollama binary (isOllamaInstalled spawns `ollama
    // --version`). Without this the assertion is host-dependent: it activates only
    // where Ollama is installed (dev box) and fails in clean CI. base_url stays empty
    // so the provider is inactive without runtime defaults; applyRuntimeDefaults then
    // fills base_url + lancedb path + embedding model to activate it. The Ollama-probe
    // branch itself is covered by tests/unit/core/search/semantic-defaults.spec.ts.
    base.providers.ollama.model = "nomic-embed-text";
    base.search.embedding_model = "";
    base.vector_store.lancedb.path = "";

    expect(isSemanticRefreshActive(base, false)).toBe(false);
    expect(isSemanticRefreshActive(base, true)).toBe(true);
  });

  it("covers search cache normalization and reset helper edge cases", async () => {
    await withTempPmPath(async (context) => {
      const ledgerPath = path.join(context.pmPath, "search", "vectorization-status.json");
      await fs.mkdir(path.dirname(ledgerPath), { recursive: true });

      await fs.writeFile(ledgerPath, "{not-json", "utf8");
      await expect(readVectorizationStatusLedger(context.pmPath)).resolves.toMatchObject({
        entries: {},
        embedding: null,
        warnings: ["search_vectorization_status_ledger_invalid"],
      });

      for (const invalidLedger of [
        { version: 2, items: [] },
        { version: 1, items: [null] },
        { version: 1, items: [{ id: "", updated_at: "2026-01-01T00:00:00.000Z" }] },
        {
          version: 1,
          items: [{ id: "pm-a", updated_at: "2026-01-01T00:00:00.000Z" }],
          embedding: { provider: "", model: "" },
        },
      ]) {
        await fs.writeFile(ledgerPath, `${JSON.stringify(invalidLedger)}\n`, "utf8");
        await expect(readVectorizationStatusLedger(context.pmPath)).resolves.toMatchObject({
          entries: {},
          embedding: null,
          warnings: ["search_vectorization_status_ledger_invalid"],
        });
      }
    });

    expect(
      searchCacheTestOnly.normalizeVectorizationLedgerEntries({
        " pm-b ": "2026-01-02T00:00:00.000Z",
        "": "2026-01-01T00:00:00.000Z",
        "pm-a": "not-a-date",
        "pm-c": "2026-01-03T00:00:00.000Z",
      }),
    ).toEqual({
      "pm-b": "2026-01-02T00:00:00.000Z",
      "pm-c": "2026-01-03T00:00:00.000Z",
    });
    expect(searchCacheTestOnly.buildSkippedSemanticRefreshResult(["pm-b", "pm-a"], "because")).toEqual({
      refreshed: [],
      skipped: ["pm-b", "pm-a"],
      warnings: ["because"],
    });
    expect(() => searchCacheTestOnly.buildVectorizationIdentityForProvider({ name: "", model: "" })).toThrow(
      "Embedding provider must include a provider name and model",
    );

    const resetSuccessMock = installSemanticFetchMock();
    try {
      const result = await searchCacheTestOnly.resetSemanticVectorStore(
        {
          name: "lancedb",
          collection_name: "pm_items",
          path: path.join(os.tmpdir(), "pm-vector-reset-success"),
        },
        { "pm-a": "2026-01-01T00:00:00.000Z" },
      );
      expect(result).toEqual({
        refreshed: [],
        skipped: [],
        warnings: [],
      });
    } finally {
      resetSuccessMock.restore();
    }

    const resetMock = installFailingFetchMock("reset failed");
    try {
      const result = await searchCacheTestOnly.resetSemanticVectorStore(
        {
          adapter: "qdrant",
          collection_name: "pm_items",
          qdrant: { url: "https://qdrant.example.test:6333", api_key: "" },
          lancedb: { path: "" },
        },
        { "pm-a": "2026-01-01T00:00:00.000Z" },
      );
      expect(result).toMatchObject({
        refreshed: [],
        skipped: [],
      });
      expect(result.warnings[0]).toContain("search_semantic_refresh_reset_failed:");
    } finally {
      resetMock.restore();
    }
  });
});
