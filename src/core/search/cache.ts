import path from "node:path";
import { pathExists, removeFileIfExists } from "../fs/fs-utils.js";
import { locateItem, readLocatedItem } from "../store/item-store.js";
import { getSettingsPath } from "../store/paths.js";
import { readSettings } from "../store/settings.js";
import { executeEmbeddingRequest, resolveEmbeddingProviders } from "./providers.js";
import type { EmbeddingProviderConfig } from "./providers.js";
import { executeVectorDelete, executeVectorUpsert, resolveVectorStores } from "./vector-stores.js";
import type { VectorStoreConfig } from "./vector-stores.js";
import type { ItemDocument, ItemFrontMatter } from "../../types/index.js";

export const SEARCH_CACHE_ARTIFACT_PATHS = ["index/manifest.json", "search/embeddings.jsonl"] as const;

export interface SearchCacheInvalidationResult {
  invalidated: string[];
  warnings: string[];
}

export interface SemanticMutationRefreshResult {
  refreshed: string[];
  skipped: string[];
  warnings: string[];
}

export interface SearchMutationArtifactRefreshResult extends SearchCacheInvalidationResult {
  refreshed: string[];
  skipped: string[];
}

function formatInvalidationWarning(relativePath: string, error: unknown): string {
  return `search_cache_invalidation_failed:${relativePath}:${String(error)}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message.length > 0 ? message : error.name;
  }
  return String(error);
}

function toUniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter((value) => value.length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function buildSemanticCorpusInput(document: ItemDocument): string {
  const item = document.front_matter;
  return JSON.stringify({
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
  });
}

function buildVectorPayload(item: ItemFrontMatter): Record<string, unknown> {
  return {
    id: item.id,
    type: item.type,
    status: item.status,
    priority: item.priority,
    updated_at: item.updated_at,
  };
}

interface SemanticRefreshRuntimeContext {
  settings: Awaited<ReturnType<typeof readSettings>>;
  provider: EmbeddingProviderConfig;
  vectorStore: VectorStoreConfig;
}

interface SemanticRefreshWorkload {
  documents: Array<{ id: string; document: ItemDocument }>;
  missingIds: string[];
  skippedIds: string[];
  warnings: string[];
}

interface SemanticRefreshOperationResult {
  refreshed: string[];
  skipped: string[];
  warnings: string[];
}

function buildSkippedSemanticRefreshResult(itemIds: string[], warning: string): SemanticMutationRefreshResult {
  return {
    refreshed: [],
    skipped: itemIds,
    warnings: [warning],
  };
}

async function resolveSemanticRefreshRuntimeContext(
  pmRoot: string,
  normalizedItemIds: string[],
): Promise<SemanticRefreshRuntimeContext | SemanticMutationRefreshResult> {
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return buildSkippedSemanticRefreshResult(normalizedItemIds, "search_semantic_refresh_skipped:settings_not_initialized");
  }

  let settings: Awaited<ReturnType<typeof readSettings>>;
  try {
    settings = await readSettings(pmRoot);
  } catch (error: unknown) {
    return buildSkippedSemanticRefreshResult(
      normalizedItemIds,
      `search_semantic_refresh_skipped:settings_read_failed:${toErrorMessage(error)}`,
    );
  }

  const provider = resolveEmbeddingProviders(settings).active;
  if (!provider) {
    return buildSkippedSemanticRefreshResult(normalizedItemIds, "search_semantic_refresh_skipped:provider_unconfigured");
  }
  const vectorStore = resolveVectorStores(settings).active;
  if (!vectorStore) {
    return buildSkippedSemanticRefreshResult(normalizedItemIds, "search_semantic_refresh_skipped:vector_store_unconfigured");
  }

  return {
    settings,
    provider,
    vectorStore,
  };
}

async function collectSemanticRefreshWorkload(
  pmRoot: string,
  idPrefix: string,
  normalizedItemIds: string[],
): Promise<SemanticRefreshWorkload> {
  const warnings: string[] = [];
  const skipped = new Set<string>();
  const missing = new Set<string>();
  const documents: Array<{ id: string; document: ItemDocument }> = [];

  for (const itemId of normalizedItemIds) {
    const located = await locateItem(pmRoot, itemId, idPrefix);
    if (!located) {
      missing.add(itemId);
      continue;
    }

    try {
      const loaded = await readLocatedItem(located);
      documents.push({
        id: loaded.document.front_matter.id,
        document: loaded.document,
      });
    } catch (error: unknown) {
      skipped.add(located.id);
      warnings.push(`search_semantic_refresh_item_read_failed:${located.id}:${toErrorMessage(error)}`);
    }
  }

  documents.sort((left, right) => left.id.localeCompare(right.id));
  return {
    documents,
    missingIds: toUniqueSorted(missing),
    skippedIds: toUniqueSorted(skipped),
    warnings,
  };
}

async function refreshLocatedSemanticVectors(
  provider: EmbeddingProviderConfig,
  vectorStore: VectorStoreConfig,
  documents: Array<{ id: string; document: ItemDocument }>,
): Promise<SemanticRefreshOperationResult> {
  if (documents.length === 0) {
    return { refreshed: [], skipped: [], warnings: [] };
  }

  try {
    const corpusInputs = documents.map((entry) => buildSemanticCorpusInput(entry.document));
    const vectors = await executeEmbeddingRequest(provider, corpusInputs);
    await executeVectorUpsert(
      vectorStore,
      documents.map((entry, index) => ({
        id: entry.id,
        vector: vectors[index],
        payload: buildVectorPayload(entry.document.front_matter),
      })),
    );
    return {
      refreshed: documents.map((entry) => entry.id),
      skipped: [],
      warnings: [],
    };
  } catch (error: unknown) {
    return {
      refreshed: [],
      skipped: documents.map((entry) => entry.id),
      warnings: [`search_semantic_refresh_failed:${toErrorMessage(error)}`],
    };
  }
}

async function pruneMissingSemanticVectors(
  vectorStore: VectorStoreConfig,
  missingIds: string[],
): Promise<SemanticRefreshOperationResult> {
  if (missingIds.length === 0) {
    return { refreshed: [], skipped: [], warnings: [] };
  }
  try {
    await executeVectorDelete(vectorStore, missingIds);
    return {
      refreshed: [],
      skipped: [],
      warnings: [],
    };
  } catch (error: unknown) {
    return {
      refreshed: [],
      skipped: missingIds,
      warnings: [`search_semantic_refresh_delete_failed:${toErrorMessage(error)}`],
    };
  }
}

export async function invalidateSearchCacheArtifacts(pmRoot: string): Promise<SearchCacheInvalidationResult> {
  const invalidated: string[] = [];
  const warnings: string[] = [];

  for (const relativePath of SEARCH_CACHE_ARTIFACT_PATHS) {
    const artifactPath = path.join(pmRoot, relativePath);
    try {
      if (!(await pathExists(artifactPath))) {
        continue;
      }
      await removeFileIfExists(artifactPath);
      invalidated.push(relativePath);
    } catch (error: unknown) {
      warnings.push(formatInvalidationWarning(relativePath, error));
    }
  }

  return {
    invalidated,
    warnings,
  };
}

export async function refreshSemanticEmbeddingsForMutatedItems(
  pmRoot: string,
  itemIds: string[],
): Promise<SemanticMutationRefreshResult> {
  const normalizedItemIds = toUniqueSorted(itemIds);
  if (normalizedItemIds.length === 0) {
    return {
      refreshed: [],
      skipped: [],
      warnings: [],
    };
  }

  const runtimeContext = await resolveSemanticRefreshRuntimeContext(pmRoot, normalizedItemIds);
  if (!("settings" in runtimeContext)) {
    return runtimeContext;
  }
  const workload = await collectSemanticRefreshWorkload(
    pmRoot,
    runtimeContext.settings.id_prefix,
    normalizedItemIds,
  );
  const refreshedResult = await refreshLocatedSemanticVectors(
    runtimeContext.provider,
    runtimeContext.vectorStore,
    workload.documents,
  );
  const pruneResult = await pruneMissingSemanticVectors(runtimeContext.vectorStore, workload.missingIds);

  return {
    refreshed: toUniqueSorted([...refreshedResult.refreshed, ...pruneResult.refreshed]),
    skipped: toUniqueSorted([...workload.skippedIds, ...refreshedResult.skipped, ...pruneResult.skipped]),
    warnings: [...workload.warnings, ...refreshedResult.warnings, ...pruneResult.warnings],
  };
}

export async function refreshSearchArtifactsForMutation(
  pmRoot: string,
  itemIds: string[],
): Promise<SearchMutationArtifactRefreshResult> {
  const invalidation = await invalidateSearchCacheArtifacts(pmRoot);
  const semanticRefresh = await refreshSemanticEmbeddingsForMutatedItems(pmRoot, itemIds);
  return {
    invalidated: invalidation.invalidated,
    refreshed: semanticRefresh.refreshed,
    skipped: semanticRefresh.skipped,
    warnings: [...invalidation.warnings, ...semanticRefresh.warnings],
  };
}
