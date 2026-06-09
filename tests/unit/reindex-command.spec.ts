import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runReindex } from "../../src/cli/commands/reindex.js";
import { readVectorizationStatusLedger, writeVectorizationStatusLedger } from "../../src/core/search/cache.js";
import { SEARCH_EMBEDDING_CORPUS_MAX_CHARACTERS_INVALID_WARNING } from "../../src/core/search/corpus.js";
import { executeVectorUpsert } from "../../src/core/search/vector-stores.js";
import {
  clearActiveExtensionHooks,
  setActiveExtensionHooks,
  setActiveExtensionRegistrations,
} from "../../src/core/extensions/index.js";
import { createEmptyExtensionRegistrationRegistry } from "../../src/core/extensions/loader.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
import type { TempPmContext } from "../helpers/withTempPmPath.js";
import { embeddingsResponse, fakeResponse, installSemanticFetchMock } from "../helpers/semanticFetchMock.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

const LANCE_DB_SNAPSHOT_DIR = ".pm-cli-local-vectors";

function createSeedItem(context: TempPmContext, title: string, body: string, withSeeds: boolean): string {
  const seedArgs = withSeeds
    ? [
        "--dep",
        "id=pm-seeddep,kind=related,author=unit-test,created_at=now",
        "--comment",
        "author=unit-test,created_at=now,text=seed-comment",
        "--note",
        "author=unit-test,created_at=now,text=seed-note",
        "--learning",
        "author=unit-test,created_at=now,text=seed-learning",
      ]
    : ["--dep", "none", "--comment", "none", "--note", "none", "--learning", "none"];
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
      "reindex,unit",
      "--body",
      body,
      "--deadline",
      "none",
      "--estimate",
      "10",
      "--acceptance-criteria",
      "Reindex captures deterministic keyword artifacts",
      "--author",
      "unit-test",
      "--message",
      "Create reindex seed item",
      "--assignee",
      "none",
      ...seedArgs,
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

async function readLocalVectorSnapshot(storePath: string): Promise<{
  records: Array<{ id: string; vector: number[]; payload?: Record<string, unknown> }>;
}> {
  const snapshotRaw = await readFile(
    path.join(path.resolve(storePath), LANCE_DB_SNAPSHOT_DIR, "pm_items.json"),
    "utf8",
  );
  return JSON.parse(snapshotRaw) as {
    records: Array<{ id: string; vector: number[]; payload?: Record<string, unknown> }>;
  };
}

describe("runReindex", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
    setActiveExtensionRegistrations(null);
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-reindex-not-init-"));
    try {
      await expect(runReindex({}, { path: tempDir })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("validates mode values and semantic/hybrid configuration requirements", async () => {
    await withTempPmPath(async (context) => {
      await expect(runReindex({ mode: "semantic" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("requires a configured embedding provider"),
      });
      await expect(runReindex({ mode: "hybrid" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("requires a configured embedding provider"),
      });
      await expect(runReindex({ mode: "bad-mode" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });

      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      await writeSettings(context.pmPath, settings);
      await expect(runReindex({ mode: "semantic" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("requires a configured vector store"),
      });

      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);
      const semanticResult = await runReindex({ mode: "semantic" }, { path: context.pmPath });
      expect(semanticResult.ok).toBe(true);
      expect(semanticResult.mode).toBe("semantic");
      expect(semanticResult.total_items).toBe(0);
    });
  });

  it("rebuilds deterministic keyword cache artifacts", async () => {
    await withTempPmPath(async (context) => {
      const idA = createSeedItem(context, "Alpha Reindex Item", "first body", true);
      const idB = createSeedItem(context, "Beta Reindex Item", "second body", false);

      const result = await runReindex({}, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.mode).toBe("keyword");
      expect(result.total_items).toBe(2);
      expect(result.semantic).toEqual({
        enabled: false,
        stale_items: 0,
        unchanged_items: 0,
        embedded_items: 0,
        vector_upserted: 0,
        batches_completed: 0,
      });
      expect(result.warnings).toEqual([]);
      expect(result.artifacts).toEqual({
        manifest: "index/manifest.json",
        embeddings: "search/embeddings.jsonl",
      });
      expect(result.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const manifestRaw = await readFile(path.join(context.pmPath, "index", "manifest.json"), "utf8");
      const manifest = JSON.parse(manifestRaw) as {
        mode: string;
        total_items: number;
        items: Array<{ id: string; type: string; status: string }>;
      };
      expect(manifest.mode).toBe("keyword");
      expect(manifest.total_items).toBe(2);
      expect(manifest.items.map((entry) => entry.id)).toEqual([idA, idB].sort((a, b) => a.localeCompare(b)));
      expect(manifest.items.every((entry) => entry.type === "Task" && entry.status === "open")).toBe(true);

      const embeddingsRaw = await readFile(path.join(context.pmPath, "search", "embeddings.jsonl"), "utf8");
      const records = embeddingsRaw
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              id: string;
              mode: string;
              corpus: {
                body: string;
                comments: string[];
                notes: string[];
                learnings: string[];
                dependencies: Array<{ id: string; kind: string }>;
              };
            },
        );
      expect(records.map((entry) => entry.id)).toEqual([idA, idB].sort((a, b) => a.localeCompare(b)));
      expect(records.every((entry) => entry.mode === "keyword")).toBe(true);
      const byId = new Map(records.map((entry) => [entry.id, entry]));
      expect(byId.get(idA)?.corpus.body).toBe("first body");
      expect(byId.get(idB)?.corpus.body).toBe("second body");
      expect(byId.get(idA)?.corpus.comments).toEqual(["seed-comment"]);
      expect(byId.get(idA)?.corpus.notes).toEqual(["seed-note"]);
      expect(byId.get(idA)?.corpus.learnings).toEqual(["seed-learning"]);
      expect(byId.get(idA)?.corpus.dependencies).toEqual([{ id: "pm-seeddep", kind: "related" }]);

      const rerun = await runReindex({ mode: "keyword" }, { path: context.pmPath });
      expect(rerun.ok).toBe(true);
      expect(rerun.total_items).toBe(2);
    });
  });

  it("rebuilds semantic and hybrid artifacts with embedding + vector execution", async () => {
    await withTempPmPath(async (context) => {
      const idA = createSeedItem(context, "Semantic Alpha", "alpha body", false);
      const idB = createSeedItem(context, "Semantic Beta", "beta body", false);

      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock();
      const fetchCalls = semanticMock.calls;

      try {
        const semanticResult = await runReindex({ mode: "semantic" }, { path: context.pmPath });
        expect(semanticResult.ok).toBe(true);
        expect(semanticResult.mode).toBe("semantic");
        expect(semanticResult.total_items).toBe(2);
        expect(semanticResult.semantic).toMatchObject({
          enabled: true,
          stale_items: 2,
          unchanged_items: 0,
          embedded_items: 2,
          vector_upserted: 2,
          batches_completed: 1,
        });

        const manifestSemanticRaw = await readFile(path.join(context.pmPath, "index", "manifest.json"), "utf8");
        const manifestSemantic = JSON.parse(manifestSemanticRaw) as { mode: string };
        expect(manifestSemantic.mode).toBe("semantic");

        const embeddingsSemanticRaw = await readFile(path.join(context.pmPath, "search", "embeddings.jsonl"), "utf8");
        const semanticRecords = embeddingsSemanticRaw
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { id: string; mode: string });
        expect(semanticRecords.map((entry) => entry.id)).toEqual([idA, idB].sort((a, b) => a.localeCompare(b)));
        expect(semanticRecords.every((entry) => entry.mode === "semantic")).toBe(true);

        const hybridResult = await runReindex({ mode: "hybrid" }, { path: context.pmPath });
        expect(hybridResult.ok).toBe(true);
        expect(hybridResult.mode).toBe("hybrid");
        expect(hybridResult.total_items).toBe(2);
        expect(hybridResult.semantic).toMatchObject({
          enabled: true,
          stale_items: 0,
          unchanged_items: 2,
          embedded_items: 0,
          vector_upserted: 0,
        });
        expect(hybridResult.warnings).toEqual(expect.arrayContaining(["search_semantic_reindex_skipped_unchanged:count=2"]));

        const manifestHybridRaw = await readFile(path.join(context.pmPath, "index", "manifest.json"), "utf8");
        const manifestHybrid = JSON.parse(manifestHybridRaw) as { mode: string };
        expect(manifestHybrid.mode).toBe("hybrid");

        const embeddingsHybridRaw = await readFile(path.join(context.pmPath, "search", "embeddings.jsonl"), "utf8");
        const hybridRecords = embeddingsHybridRaw
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { mode: string });
        expect(hybridRecords.every((entry) => entry.mode === "hybrid")).toBe(true);

        const vectorizationLedgerRaw = await readFile(
          path.join(context.pmPath, "search", "vectorization-status.json"),
          "utf8",
        );
        const vectorizationLedger = JSON.parse(vectorizationLedgerRaw) as {
          version: number;
          generated_at: string;
          items: Array<{ id: string; updated_at: string }>;
        };
        expect(vectorizationLedger.version).toBe(1);
        expect(vectorizationLedger.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(vectorizationLedger.items.map((entry) => entry.id)).toEqual([idA, idB].sort((a, b) => a.localeCompare(b)));
        expect(vectorizationLedger.items.every((entry) => /^\d{4}-\d{2}-\d{2}T/.test(entry.updated_at))).toBe(true);

        expect(fetchCalls).toEqual([
          "https://api.example.test/v1/embeddings",
          "https://qdrant.example.test:6333/collections/pm_items/points?wait=true",
        ]);
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("forces a full semantic/hybrid rebuild when --full is enabled", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context, "Force Full Alpha", "alpha body", false);
      createSeedItem(context, "Force Full Beta", "beta body", false);

      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock();
      try {
        await runReindex({ mode: "semantic" }, { path: context.pmPath });

        const incremental = await runReindex({ mode: "semantic" }, { path: context.pmPath });
        expect(incremental.semantic).toMatchObject({
          stale_items: 0,
          unchanged_items: 2,
          embedded_items: 0,
          vector_upserted: 0,
        });

        const forcedFull = await runReindex({ mode: "hybrid", full: true }, { path: context.pmPath });
        expect(forcedFull.semantic).toMatchObject({
          stale_items: 2,
          unchanged_items: 0,
          embedded_items: 2,
          vector_upserted: 2,
        });
        expect(forcedFull.warnings).toEqual(expect.arrayContaining(["search_semantic_reindex_full_rebuild_forced"]));
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("resets the local vector store and re-embeds every item when embedding model metadata changes", async () => {
    await withTempPmPath(async (context) => {
      const idA = createSeedItem(context, "Semantic Model Reset Alpha", "alpha body", false);
      const idB = createSeedItem(context, "Semantic Model Reset Beta", "beta body", false);
      const storePath = path.join(context.pmPath, "search", "lancedb");

      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "old-model";
      settings.vector_store.lancedb.path = storePath;
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock({
        embeddings: (request) => {
          const model = (request.body as { model?: string }).model;
          const dimensions = model === "new-model" ? 3 : 2;
          return fakeResponse({
            json: {
              data: Array.from({ length: request.inputCount }, (_entry, index) => ({
                index,
                embedding: Array.from({ length: dimensions }, (_value, dimension) => index + dimension + 0.1),
              })),
            },
          });
        },
      });

      try {
        const first = await runReindex({ mode: "semantic" }, { path: context.pmPath });
        expect(first.semantic).toMatchObject({
          stale_items: 2,
          unchanged_items: 0,
          embedded_items: 2,
          vector_upserted: 2,
        });
        await executeVectorUpsert(
          {
            name: "lancedb",
            path: storePath,
          },
          [{ id: "pm-untracked-orphan", vector: [9], payload: { kind: "old" } }],
        );

        const nextSettings = await readSettings(context.pmPath);
        nextSettings.providers.openai.model = "new-model";
        await writeSettings(context.pmPath, nextSettings);

        const second = await runReindex({ mode: "semantic" }, { path: context.pmPath });
        expect(second.semantic).toMatchObject({
          stale_items: 2,
          unchanged_items: 0,
          embedded_items: 2,
          vector_upserted: 2,
        });

        const snapshot = await readLocalVectorSnapshot(storePath);
        expect(snapshot.records.map((entry) => entry.id)).toEqual([idA, idB].sort((left, right) => left.localeCompare(right)));
        expect(snapshot.records.every((entry) => entry.vector.length === 3)).toBe(true);
        expect(snapshot.records.some((entry) => entry.id === "pm-untracked-orphan")).toBe(false);

        const ledger = await readVectorizationStatusLedger(context.pmPath);
        expect(ledger.embedding).toEqual({
          provider: "openai",
          model: "new-model",
          vector_dimension: 3,
        });
        expect(Object.keys(ledger.entries)).toEqual([idA, idB].sort((left, right) => left.localeCompare(right)));
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("warns keyword reindex when embedding identity changed since the last semantic index", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context, "Keyword Identity Drift", "keyword body", false);

      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "old-model";
      settings.vector_store.lancedb.path = path.join(context.pmPath, "search", "lancedb-keyword");
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock();
      try {
        await runReindex({ mode: "semantic" }, { path: context.pmPath });
      } finally {
        semanticMock.restore();
      }

      const nextSettings = await readSettings(context.pmPath);
      nextSettings.providers.openai.model = "new-model";
      await writeSettings(context.pmPath, nextSettings);

      const keywordReindex = await runReindex({ mode: "keyword" }, { path: context.pmPath });
      expect(keywordReindex.warnings).toEqual(
        expect.arrayContaining([
          "search_semantic_reindex_requires_rebuild:embedding_identity_changed",
          "Provider or model has changed since last index. Run pm reindex --mode semantic to rebuild.",
        ]),
      );
    });
  });

  it("resets and re-embeds all local vectors when vector dimension changes during a partial reindex", async () => {
    await withTempPmPath(async (context) => {
      const idA = createSeedItem(context, "Semantic Dimension Reset Alpha", "alpha body", false);
      const idB = createSeedItem(context, "Semantic Dimension Reset Beta", "beta body", false);
      const storePath = path.join(context.pmPath, "search", "lancedb-dimension");

      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "same-model";
      settings.vector_store.lancedb.path = storePath;
      await writeSettings(context.pmPath, settings);

      let dimensions = 2;
      const semanticMock = installSemanticFetchMock({
        embeddings: (request) =>
          fakeResponse({
            json: {
              data: Array.from({ length: request.inputCount }, (_entry, index) => ({
                index,
                embedding: Array.from({ length: dimensions }, (_value, dimension) => index + dimension + 0.1),
              })),
            },
          }),
      });

      try {
        await runReindex({ mode: "semantic" }, { path: context.pmPath });
        const firstLedger = await readVectorizationStatusLedger(context.pmPath);
        expect(firstLedger.embedding?.vector_dimension).toBe(2);
        await writeVectorizationStatusLedger(
          context.pmPath,
          {
            ...firstLedger.entries,
            [idA]: "2000-01-01T00:00:00.000Z",
          },
          firstLedger.embedding,
        );

        dimensions = 3;
        const second = await runReindex({ mode: "semantic" }, { path: context.pmPath });
        expect(second.semantic).toMatchObject({
          stale_items: 2,
          unchanged_items: 0,
          embedded_items: 2,
          vector_upserted: 2,
        });

        const snapshot = await readLocalVectorSnapshot(storePath);
        expect(snapshot.records.map((entry) => entry.id)).toEqual([idA, idB].sort((left, right) => left.localeCompare(right)));
        expect(snapshot.records.every((entry) => entry.vector.length === 3)).toBe(true);
        const ledger = await readVectorizationStatusLedger(context.pmPath);
        expect(ledger.embedding).toEqual({
          provider: "openai",
          model: "same-model",
          vector_dimension: 3,
        });
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("prunes orphaned local vectors and ledger entries during semantic reindex", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context, "Semantic Orphan Prune", "orphan body", false);
      const storePath = path.join(context.pmPath, "search", "lancedb-orphans");

      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.lancedb.path = storePath;
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock();

      try {
        await runReindex({ mode: "semantic" }, { path: context.pmPath });
        const firstLedger = await readVectorizationStatusLedger(context.pmPath);
        await executeVectorUpsert(
          {
            name: "lancedb",
            path: storePath,
          },
          [{ id: "pm-orphan", vector: [0.9, 0.1], payload: { kind: "orphan" } }],
        );
        await writeVectorizationStatusLedger(
          context.pmPath,
          {
            ...firstLedger.entries,
            "pm-orphan": "2026-01-01T00:00:00.000Z",
          },
          firstLedger.embedding,
        );

        const second = await runReindex({ mode: "semantic" }, { path: context.pmPath });
        expect(second.semantic).toMatchObject({
          stale_items: 0,
          unchanged_items: 1,
          embedded_items: 0,
          vector_upserted: 0,
        });
        expect(second.warnings).toContain("search_semantic_reindex_skipped_unchanged:count=1");

        const snapshot = await readLocalVectorSnapshot(storePath);
        expect(snapshot.records.map((entry) => entry.id)).toEqual([itemId]);
        const ledger = await readVectorizationStatusLedger(context.pmPath);
        expect(Object.keys(ledger.entries)).toEqual([itemId]);
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("supports semantic reindex through extension embedding and vector adapter registrations", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context, "Extension Semantic", "extension semantic body", false);
      const settings = await readSettings(context.pmPath);
      settings.search.provider = "ext-provider";
      settings.vector_store.adapter = "ext-vector";
      await writeSettings(context.pmPath, settings);

      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.search_providers.push({
        layer: "project",
        name: "ext-provider-reg",
        definition: { name: "ext-provider" },
        runtime_definition: {
          name: "ext-provider",
          embedBatch: ({ inputs }: { inputs: string[] }) => inputs.map((_value, index) => [index + 0.1, index + 0.2]),
        },
      });
      const capturedPointIds: string[] = [];
      const capturedDeletedIds: string[] = [];
      registrations.vector_store_adapters.push({
        layer: "project",
        name: "ext-vector-reg",
        definition: { name: "ext-vector" },
        runtime_definition: {
          name: "ext-vector",
          upsert: ({ points }: { points: Array<{ id: string }> }) => {
            capturedPointIds.push(...points.map((point) => point.id));
          },
          delete: ({ ids }: { ids: string[] }) => {
            capturedDeletedIds.push(...ids);
          },
        },
      });
      setActiveExtensionRegistrations(registrations);

      const result = await runReindex({ mode: "semantic" }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.mode).toBe("semantic");
      expect(result.total_items).toBe(1);
      expect(result.warnings).toEqual([]);
      expect(capturedPointIds).toHaveLength(1);
      expect(capturedPointIds[0]).toMatch(/^pm-/);
      const vectorizationLedgerRaw = await readFile(path.join(context.pmPath, "search", "vectorization-status.json"), "utf8");
      const vectorizationLedger = JSON.parse(vectorizationLedgerRaw) as {
        embedding: { provider: string; model: string; vector_dimension: number };
        items: Array<{ id: string }>;
      };
      expect(vectorizationLedger.embedding).toEqual({
        provider: "ext-provider",
        model: "text-embedding-3-small",
        vector_dimension: 2,
      });
      expect(vectorizationLedger.items).toHaveLength(1);
      expect(vectorizationLedger.items[0]?.id).toMatch(/^pm-/);

      const firstLedger = await readVectorizationStatusLedger(context.pmPath);
      await writeVectorizationStatusLedger(
        context.pmPath,
        {
          ...firstLedger.entries,
          "pm-extension-orphan": "2026-01-01T00:00:00.000Z",
        },
        vectorizationLedger.embedding,
      );
      capturedPointIds.length = 0;

      const pruneResult = await runReindex({ mode: "semantic" }, { path: context.pmPath });
      expect(pruneResult.warnings).toContain("search_semantic_reindex_skipped_unchanged:count=1");
      expect(capturedPointIds).toEqual([]);
      expect(capturedDeletedIds).toEqual(["pm-extension-orphan"]);
      const prunedLedger = await readVectorizationStatusLedger(context.pmPath);
      expect(Object.keys(prunedLedger.entries)).toEqual([vectorizationLedger.items[0]!.id]);

      const nextSettings = await readSettings(context.pmPath);
      nextSettings.search.embedding_model = "extension-next-model";
      await writeSettings(context.pmPath, nextSettings);
      capturedPointIds.length = 0;
      capturedDeletedIds.length = 0;

      const resetResult = await runReindex({ mode: "semantic" }, { path: context.pmPath });
      expect(resetResult.semantic).toMatchObject({
        stale_items: 1,
        unchanged_items: 0,
        embedded_items: 1,
        vector_upserted: 1,
      });
      expect(capturedDeletedIds).toEqual([vectorizationLedger.items[0]!.id]);
      expect(capturedPointIds).toEqual([vectorizationLedger.items[0]!.id]);
      const resetLedger = await readVectorizationStatusLedger(context.pmPath);
      expect(resetLedger.embedding).toEqual({
        provider: "ext-provider",
        model: "extension-next-model",
        vector_dimension: 2,
      });
    });
  });

  it("falls back to built-in semantic providers when extension embedding/upsert handlers fail", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context, "Fallback Semantic", "fallback body", false);
      const settings = await readSettings(context.pmPath);
      settings.search.provider = "ext-provider";
      settings.vector_store.adapter = "ext-vector";
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.search_providers.push({
        layer: "project",
        name: "ext-provider-reg",
        definition: { name: "ext-provider" },
        runtime_definition: {
          name: "ext-provider",
          embedBatch: () => {
            throw new Error("extension embed failed");
          },
        },
      });
      registrations.vector_store_adapters.push({
        layer: "project",
        name: "ext-vector-reg",
        definition: { name: "ext-vector" },
        runtime_definition: {
          name: "ext-vector",
          upsert: () => {
            throw new Error("extension upsert failed");
          },
        },
      });
      setActiveExtensionRegistrations(registrations);

      const semanticMock = installSemanticFetchMock();
      const fetchCalls = semanticMock.calls;

      try {
        const result = await runReindex({ mode: "semantic" }, { path: context.pmPath });
        expect(result.ok).toBe(true);
        expect(result.warnings.some((warning) => warning.includes('Extension search provider "ext-provider" failed'))).toBe(true);
        expect(result.warnings.some((warning) => warning.includes('Extension vector adapter "ext-vector" failed'))).toBe(true);
        expect(fetchCalls).toEqual([
          "https://api.example.test/v1/embeddings",
          "https://qdrant.example.test:6333/collections/pm_items/points?wait=true",
        ]);
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("honors embedding batch size and retry settings for semantic reindex", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context, "Retry Alpha", "alpha body", false);
      createSeedItem(context, "Retry Beta", "beta body", false);
      createSeedItem(context, "Retry Gamma", "gamma body", false);

      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      settings.search.embedding_batch_size = 2;
      settings.search.scanner_max_batch_retries = 1;
      await writeSettings(context.pmPath, settings);

      let embeddingAttempts = 0;
      const semanticMock = installSemanticFetchMock({
        embeddings: ({ inputCount }) => {
          embeddingAttempts += 1;
          if (embeddingAttempts === 1) {
            return fakeResponse({ ok: false, status: 503, statusText: "Service Unavailable", text: "retry me" });
          }
          return embeddingsResponse(inputCount);
        },
      });

      try {
        const result = await runReindex({ mode: "semantic" }, { path: context.pmPath });
        expect(result.ok).toBe(true);
        expect(result.warnings).toContain("search_embedding_batch_retry_succeeded:batch=1:attempt=2:size=2");
        expect(embeddingAttempts).toBe(3);
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("bounds oversized semantic corpus inputs before embedding", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context, "Huge Semantic Corpus", "x".repeat(20_000), false);

      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock();
      const embeddedInputLengths = semanticMock.inputLengths;

      try {
        const result = await runReindex({ mode: "semantic" }, { path: context.pmPath });
        expect(result.ok).toBe(true);
        expect(embeddedInputLengths).toHaveLength(1);
        expect(embeddedInputLengths[0]).toBeGreaterThan(300);
        expect(embeddedInputLengths[0]).toBeLessThanOrEqual(8_000);
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("honors configured semantic corpus character limit during embedding", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context, "Configured Semantic Corpus", "x".repeat(20_000), false);

      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      settings.search.embedding_corpus_max_characters = 1200;
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock();
      const embeddedInputLengths = semanticMock.inputLengths;

      try {
        const result = await runReindex({ mode: "semantic" }, { path: context.pmPath });
        expect(result.ok).toBe(true);
        expect(embeddedInputLengths).toHaveLength(1);
        expect(embeddedInputLengths[0]).toBeGreaterThan(300);
        expect(embeddedInputLengths[0]).toBeLessThanOrEqual(1200);
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("falls back to provider corpus default and warns when configured semantic corpus limit is invalid", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context, "Invalid Semantic Corpus Limit", "x".repeat(20_000), false);

      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      settings.search.embedding_corpus_max_characters = 0;
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock();
      const embeddedInputLengths = semanticMock.inputLengths;

      try {
        const result = await runReindex({ mode: "semantic" }, { path: context.pmPath });
        expect(result.ok).toBe(true);
        expect(result.warnings).toContain(SEARCH_EMBEDDING_CORPUS_MAX_CHARACTERS_INVALID_WARNING);
        expect(embeddedInputLengths).toHaveLength(1);
        expect(embeddedInputLengths[0]).toBeLessThanOrEqual(8_000);
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("dispatches active read/write/index hooks and reports hook warnings", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context, "Hook Reindex Item", "hook body", false);
      const events: string[] = [];

      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onWrite: [
          {
            layer: "project",
            name: "write-hook",
            run: (hookContext) => {
              events.push(`write:${hookContext.op}:${path.basename(hookContext.path)}`);
            },
          },
        ],
        onRead: [
          {
            layer: "project",
            name: "read-hook",
            run: (hookContext) => {
              events.push(`read:${path.basename(hookContext.path)}`);
            },
          },
        ],
        onIndex: [
          {
            layer: "project",
            name: "index-hook",
            run: () => {
              throw new Error("index-hook-boom");
            },
          },
        ],
      });

      const result = await runReindex({}, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual(["extension_hook_failed:project:index-hook:onIndex"]);
      expect(events.some((entry) => entry.startsWith("read:"))).toBe(true);
      expect(events).toContain("write:reindex:manifest:manifest.json");
      expect(events).toContain("write:reindex:embeddings:embeddings.jsonl");
    });
  });

  it("fails fast when another reindex lock is active", async () => {
    await withTempPmPath(async (context) => {
      const lockDirectory = path.join(context.pmPath, "locks");
      await mkdir(lockDirectory, { recursive: true });
      await writeFile(
        path.join(lockDirectory, "reindex.lock"),
        `${JSON.stringify(
          {
            id: "reindex",
            pid: 12345,
            owner: "unit-test",
            created_at: new Date().toISOString(),
            ttl_seconds: 1800,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await expect(runReindex({ mode: "keyword" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.CONFLICT,
        message: expect.stringContaining("Another pm reindex run is already active"),
        context: expect.objectContaining({
          code: "reindex_already_running",
        }),
      });
    });
  });

  it("emits progress updates when progress mode is forced in non-interactive runs", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context, "Progress Reindex Item", "progress body", false);
      const originalIsTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, "isTTY", {
        value: false,
        configurable: true,
      });
      const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const result = await runReindex({ mode: "keyword", progress: true }, { path: context.pmPath });
        expect(result.ok).toBe(true);
        const stderrOutput = stderrWriteSpy.mock.calls.map((entry) => String(entry[0])).join("");
        expect(stderrOutput).toContain("[pm reindex] start mode=keyword");
        expect(stderrOutput).toContain("[pm reindex] loading item corpus");
        expect(stderrOutput).toContain("[pm reindex] writing keyword artifacts");
        expect(stderrOutput).toContain("[pm reindex] done");
      } finally {
        Object.defineProperty(process.stderr, "isTTY", {
          value: originalIsTTY,
          configurable: true,
        });
      }
    });
  });

  it("emits batch progress and semantic summary for agent-visible semantic reindex runs", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context, "Progress Semantic Alpha", "alpha body", false);
      createSeedItem(context, "Progress Semantic Beta", "beta body", false);
      createSeedItem(context, "Progress Semantic Gamma", "gamma body", false);

      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      settings.search.embedding_batch_size = 2;
      await writeSettings(context.pmPath, settings);

      const originalIsTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, "isTTY", {
        value: false,
        configurable: true,
      });
      const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const semanticMock = installSemanticFetchMock();

      try {
        const result = await runReindex({ mode: "semantic", progress: true }, { path: context.pmPath });
        expect(result.semantic).toMatchObject({
          enabled: true,
          stale_items: 3,
          unchanged_items: 0,
          embedded_items: 3,
          vector_upserted: 3,
          batches_completed: 2,
        });
        const stderrOutput = stderrWriteSpy.mock.calls.map((entry) => String(entry[0])).join("");
        expect(stderrOutput).toContain("[pm reindex] embedding_batch_start batch=1/2 size=2 completed_inputs=0/3");
        expect(stderrOutput).toContain("[pm reindex] embedding_batch_complete batch=1/2 size=2 completed_inputs=2/3");
        expect(stderrOutput).toContain("[pm reindex] embedding_batch_complete batch=2/2 size=1 completed_inputs=3/3");
      } finally {
        semanticMock.restore();
        Object.defineProperty(process.stderr, "isTTY", {
          value: originalIsTTY,
          configurable: true,
        });
      }
    });
  });
});
