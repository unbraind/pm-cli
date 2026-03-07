import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  invalidateSearchCacheArtifacts,
  refreshSearchArtifactsForMutation,
  refreshSemanticEmbeddingsForMutatedItems,
  SEARCH_CACHE_ARTIFACT_PATHS,
} from "../../src/core/search/cache.js";
import { readSettings, writeSettings } from "../../src/settings.js";
import type { TempPmContext } from "../helpers/withTempPmPath.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

async function withTempDir(run: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-cli-search-cache-"));
  try {
    await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function createSeedItem(
  context: TempPmContext,
  title: string,
  dep: string = "none",
  seedLogs: boolean = true,
): string {
  const result = context.runCli(
    [
      "create",
      "--json",
      "--title",
      title,
      "--description",
      `${title} description`,
      "--type",
      "Task",
      "--status",
      "open",
      "--priority",
      "1",
      "--tags",
      "search,cache",
      "--body",
      `${title} body`,
      "--deadline",
      "none",
      "--estimate",
      "10",
      "--acceptance-criteria",
      "Mutation refresh updates semantic vectors",
      "--author",
      "unit-test",
      "--message",
      "Create search cache test item",
      "--assignee",
      "none",
      "--dep",
      dep,
      "--comment",
      seedLogs ? "author=unit-test,created_at=now,text=seed-comment" : "none",
      "--note",
      seedLogs ? "author=unit-test,created_at=now,text=seed-note" : "none",
      "--learning",
      seedLogs ? "author=unit-test,created_at=now,text=seed-learning" : "none",
      "--file",
      "none",
      "--test",
      "none",
      "--doc",
      "none",
    ],
    { expectJson: true },
  );
  expect(result.code).toBe(0);
  return (result.json as { item: { id: string } }).item.id;
}

describe("core/search/cache", () => {
  it("invalidates known search cache artifacts when present", async () => {
    await withTempDir(async (pmRoot) => {
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
    await withTempDir(async (pmRoot) => {
      const result = await invalidateSearchCacheArtifacts(pmRoot);
      expect(result.invalidated).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  });

  it("collects non-fatal warnings when artifact removal fails", async () => {
    await withTempDir(async (pmRoot) => {
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
    await withTempDir(async (pmRoot) => {
      const result = await refreshSemanticEmbeddingsForMutatedItems(pmRoot, ["pm-missing"]);
      expect(result).toEqual({
        refreshed: [],
        skipped: ["pm-missing"],
        warnings: ["search_semantic_refresh_skipped:settings_not_initialized"],
      });
    });
  });

  it("returns deterministic settings-read warning when settings path is unreadable", async () => {
    await withTempDir(async (pmRoot) => {
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

      const originalFetch = globalThis.fetch;
      const fetchCalls: string[] = [];
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const target = String(url);
        fetchCalls.push(target);
        if (target.endsWith("/v1/embeddings")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
          const inputCount = Array.isArray(body.input) ? body.input.length : 1;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              data: Array.from({ length: inputCount }, (_entry, index) => ({
                index,
                embedding: [index + 0.1, index + 0.2],
              })),
            }),
            text: async () => "",
          } as unknown as Response;
        }
        if (target.endsWith("/collections/pm_items/points?wait=true")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: { status: "acknowledged" } }),
            text: async () => "",
          } as unknown as Response;
        }
        if (target.endsWith("/collections/pm_items/points/delete?wait=true")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: { status: "acknowledged" } }),
            text: async () => "",
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch target: ${target}`);
      }) as typeof globalThis.fetch;

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemId, "pm-missing", itemId]);
        expect(result.refreshed).toEqual([itemId]);
        expect(result.skipped).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(fetchCalls).toEqual([
          "https://api.example.test/v1/embeddings",
          "https://qdrant.example.test:6333/collections/pm_items/points?wait=true",
          "https://qdrant.example.test:6333/collections/pm_items/points/delete?wait=true",
        ]);
      } finally {
        globalThis.fetch = originalFetch;
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

      const originalFetch = globalThis.fetch;
      const fetchCalls: string[] = [];
      globalThis.fetch = (async (url: unknown) => {
        const target = String(url);
        fetchCalls.push(target);
        if (target.endsWith("/collections/pm_items/points/delete?wait=true")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: { status: "acknowledged" } }),
            text: async () => "",
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch target: ${target}`);
      }) as typeof globalThis.fetch;

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, ["pm-missing", "pm-missing"]);
        expect(result.refreshed).toEqual([]);
        expect(result.skipped).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(fetchCalls).toEqual(["https://qdrant.example.test:6333/collections/pm_items/points/delete?wait=true"]);
      } finally {
        globalThis.fetch = originalFetch;
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

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown) => {
        const target = String(url);
        if (target.endsWith("/v1/embeddings")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2] }] }),
            text: async () => "",
          } as unknown as Response;
        }
        if (target.endsWith("/collections/pm_items/points?wait=true")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: { status: "acknowledged" } }),
            text: async () => "",
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch target: ${target}`);
      }) as typeof globalThis.fetch;

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemId]);
        expect(result.refreshed).toEqual([itemId]);
        expect(result.skipped).toEqual([]);
        expect(result.warnings).toEqual([]);
      } finally {
        globalThis.fetch = originalFetch;
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

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const target = String(url);
        if (target.endsWith("/v1/embeddings")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
          const inputCount = Array.isArray(body.input) ? body.input.length : 1;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              data: Array.from({ length: inputCount }, (_entry, index) => ({
                index,
                embedding: [index + 0.1, index + 0.2],
              })),
            }),
            text: async () => "",
          } as unknown as Response;
        }
        if (target.endsWith("/collections/pm_items/points?wait=true")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: { status: "acknowledged" } }),
            text: async () => "",
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch target: ${target}`);
      }) as typeof globalThis.fetch;

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemB, itemA]);
        expect(result.refreshed).toEqual([itemA, itemB].sort((left, right) => left.localeCompare(right)));
        expect(result.skipped).toEqual([]);
        expect(result.warnings).toEqual([]);
      } finally {
        globalThis.fetch = originalFetch;
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

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => ({}),
        text: async () => "embedding service down",
      })) as typeof globalThis.fetch;

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemId]);
        expect(result.refreshed).toEqual([]);
        expect(result.skipped).toEqual([itemId]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("search_semantic_refresh_failed:");
      } finally {
        globalThis.fetch = originalFetch;
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

      const originalFetch = globalThis.fetch;
      let embeddingAttempts = 0;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const target = String(url);
        if (target.endsWith("/v1/embeddings")) {
          embeddingAttempts += 1;
          if (embeddingAttempts === 1) {
            return {
              ok: false,
              status: 500,
              statusText: "Internal Server Error",
              json: async () => ({}),
              text: async () => "transient failure",
            } as unknown as Response;
          }
          const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
          const inputCount = Array.isArray(body.input) ? body.input.length : 1;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              data: Array.from({ length: inputCount }, (_entry, index) => ({
                index,
                embedding: [index + 0.1, index + 0.2],
              })),
            }),
            text: async () => "",
          } as unknown as Response;
        }
        if (target.endsWith("/collections/pm_items/points?wait=true")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: { status: "acknowledged" } }),
            text: async () => "",
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch target: ${target}`);
      }) as typeof globalThis.fetch;

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, [itemA, itemB]);
        expect(result.refreshed).toEqual([itemA, itemB].sort((left, right) => left.localeCompare(right)));
        expect(result.skipped).toEqual([]);
        expect(result.warnings).toContain("search_embedding_batch_retry_succeeded:batch=1:attempt=2:size=1");
        expect(embeddingAttempts).toBe(3);
      } finally {
        globalThis.fetch = originalFetch;
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

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => ({}),
        text: async () => "delete failed",
      })) as typeof globalThis.fetch;

      try {
        const result = await refreshSemanticEmbeddingsForMutatedItems(context.pmPath, ["pm-missing"]);
        expect(result.refreshed).toEqual([]);
        expect(result.skipped).toEqual(["pm-missing"]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("search_semantic_refresh_delete_failed:");
      } finally {
        globalThis.fetch = originalFetch;
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

      const brokenItemPath = path.join(context.pmPath, "tasks", `${itemId}.md`);
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
