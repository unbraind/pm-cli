import fs from "node:fs/promises";
import path from "node:path";
import { runActiveOnIndexHooks, runActiveOnReadHooks, runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { pathExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { parseItemDocument } from "../../core/item/item-format.js";
import { executeEmbeddingRequest, resolveEmbeddingProviders } from "../../core/search/providers.js";
import { executeVectorUpsert, resolveVectorStores } from "../../core/search/vector-stores.js";
import { EXIT_CODE, TYPE_TO_FOLDER } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { listAllFrontMatter } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemDocument } from "../../types/index.js";

const MANIFEST_PATH = "index/manifest.json";
const EMBEDDINGS_PATH = "search/embeddings.jsonl";

export interface ReindexOptions {
  mode?: string;
}

export interface ReindexResult {
  ok: boolean;
  mode: "keyword" | "semantic" | "hybrid";
  total_items: number;
  artifacts: {
    manifest: string;
    embeddings: string;
  };
  warnings: string[];
  generated_at: string;
}

function parseMode(raw: string | undefined): "keyword" | "semantic" | "hybrid" {
  const normalized = (raw ?? "keyword").trim().toLowerCase();
  if (normalized === "keyword") {
    return "keyword";
  }
  if (normalized === "semantic" || normalized === "hybrid") {
    return normalized;
  }
  throw new PmCliError("Reindex mode must be one of keyword|semantic|hybrid", EXIT_CODE.USAGE);
}

async function loadDocuments(pmRoot: string): Promise<ItemDocument[]> {
  const items = await listAllFrontMatter(pmRoot);
  const sortedItems = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const documents: ItemDocument[] = [];
  for (const item of sortedItems) {
    const itemPath = path.join(pmRoot, TYPE_TO_FOLDER[item.type], `${item.id}.md`);
    const raw = await fs.readFile(itemPath, "utf8");
    await runActiveOnReadHooks({
      path: itemPath,
      scope: "project",
    });
    documents.push(parseItemDocument(raw));
  }
  return documents;
}

function buildKeywordRecord(document: ItemDocument, mode: "keyword" | "semantic" | "hybrid"): Record<string, unknown> {
  const item = document.front_matter;
  return {
    id: item.id,
    mode,
    updated_at: item.updated_at,
    corpus: {
      title: item.title,
      description: item.description,
      tags: item.tags,
      status: item.status,
      body: document.body,
      comments: (item.comments ?? []).map((entry) => entry.text),
      notes: (item.notes ?? []).map((entry) => entry.text),
      learnings: (item.learnings ?? []).map((entry) => entry.text),
      dependencies: (item.dependencies ?? []).map((entry) => ({
        id: entry.id,
        kind: entry.kind,
      })),
    },
  };
}

function buildSemanticCorpusInput(document: ItemDocument): string {
  return JSON.stringify((buildKeywordRecord(document, "semantic") as { corpus: Record<string, unknown> }).corpus);
}

export async function runReindex(options: ReindexOptions, global: GlobalOptions): Promise<ReindexResult> {
  const requestedMode = parseMode(options.mode);
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  let activeEmbeddingProvider: ReturnType<typeof resolveEmbeddingProviders>["active"] = null;
  let activeVectorStore: ReturnType<typeof resolveVectorStores>["active"] = null;
  if (requestedMode !== "keyword") {
    const providerResolution = resolveEmbeddingProviders(settings);
    if (!providerResolution.active) {
      throw new PmCliError(
        `Reindex mode '${requestedMode}' requires a configured embedding provider in settings.providers.openai or settings.providers.ollama`,
        EXIT_CODE.USAGE,
      );
    }
    const vectorResolution = resolveVectorStores(settings);
    if (!vectorResolution.active) {
      throw new PmCliError(
        `Reindex mode '${requestedMode}' requires a configured vector store in settings.vector_store.qdrant or settings.vector_store.lancedb`,
        EXIT_CODE.USAGE,
      );
    }
    activeEmbeddingProvider = providerResolution.active;
    activeVectorStore = vectorResolution.active;
  }
  const mode = requestedMode;
  const documents = await loadDocuments(pmRoot);
  const generatedAt = nowIso();

  const manifest = {
    version: 1,
    mode,
    generated_at: generatedAt,
    total_items: documents.length,
    items: documents.map((document) => ({
      id: document.front_matter.id,
      type: document.front_matter.type,
      status: document.front_matter.status,
      priority: document.front_matter.priority,
      updated_at: document.front_matter.updated_at,
    })),
  };

  const manifestPath = path.join(pmRoot, MANIFEST_PATH);
  const embeddingsPath = path.join(pmRoot, EMBEDDINGS_PATH);

  const embeddingsLines = documents.map((document) => JSON.stringify(buildKeywordRecord(document, mode))).join("\n");
  if (mode !== "keyword" && documents.length > 0 && activeEmbeddingProvider && activeVectorStore) {
    const corpusInputs = documents.map((document) => buildSemanticCorpusInput(document));
    const vectors = await executeEmbeddingRequest(activeEmbeddingProvider, corpusInputs);
    await executeVectorUpsert(
      activeVectorStore,
      documents.map((document, index) => ({
        id: document.front_matter.id,
        vector: vectors[index],
        payload: {
          id: document.front_matter.id,
          type: document.front_matter.type,
          status: document.front_matter.status,
          priority: document.front_matter.priority,
          updated_at: document.front_matter.updated_at,
        },
      })),
    );
  }
  await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFileAtomic(embeddingsPath, `${embeddingsLines}\n`);
  const hookWarnings = [
    ...(await runActiveOnWriteHooks({
      path: manifestPath,
      scope: "project",
      op: "reindex:manifest",
    })),
    ...(await runActiveOnWriteHooks({
      path: embeddingsPath,
      scope: "project",
      op: "reindex:embeddings",
    })),
    ...(await runActiveOnIndexHooks({
      mode,
      total_items: documents.length,
    })),
  ];

  return {
    ok: true,
    mode,
    total_items: documents.length,
    artifacts: {
      manifest: MANIFEST_PATH,
      embeddings: EMBEDDINGS_PATH,
    },
    warnings: hookWarnings,
    generated_at: generatedAt,
  };
}
