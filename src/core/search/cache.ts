import path from "node:path";
import { getActiveExtensionRegistrations } from "../extensions/index.js";
import { pathExists, readFileIfExists, removeFileIfExists, writeFileAtomic } from "../fs/fs-utils.js";
import { resolveItemTypeRegistry } from "../item/type-registry.js";
import { toErrorMessage } from "../shared/primitives.js";
import { locateItem, readLocatedItem } from "../store/item-store.js";
import { getSettingsPath } from "../store/paths.js";
import { readSettings } from "../store/settings.js";
import { executeEmbeddingBatchesWithRetry } from "./embedding-batches.js";
import {
  buildSemanticCorpusInput,
  resolveSemanticCorpusCharacterLimit,
} from "./corpus.js";
import { resolveEmbeddingProviders } from "./providers.js";
import type { EmbeddingProviderConfig } from "./providers.js";
import { resolveSettingsWithSemanticRuntimeDefaults } from "./semantic-defaults.js";
import { scheduleBackgroundSemanticRefresh } from "./background-refresh.js";
import { executeVectorDelete, executeVectorReset, executeVectorUpsert, resolveVectorStores } from "./vector-stores.js";
import type { VectorStoreConfig } from "./vector-stores.js";
import {
  buildVectorizationEmbeddingIdentity,
  buildVectorizationEmbeddingMetadata,
  hasVectorizationEmbeddingIdentityChanged,
  hasVectorizationVectorDimensionChanged,
  inferConsistentVectorDimension,
  normalizeVectorizationEmbeddingMetadata,
} from "./vectorization-metadata.js";
import type {
  VectorizationEmbeddingIdentity,
  VectorizationEmbeddingMetadata,
} from "./vectorization-metadata.js";
import { nowIso } from "../shared/time.js";
import type { ItemDocument, ItemFrontMatter } from "../../types/index.js";

export const SEARCH_CACHE_ARTIFACT_PATHS = ["index/manifest.json", "search/embeddings.jsonl"] as const;
export const VECTORIZATION_STATUS_LEDGER_PATH = "search/vectorization-status.json";

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
  /** True when the semantic refresh was dispatched to a detached background worker. */
  scheduled?: boolean;
}

export interface RefreshSearchArtifactsForMutationOptions {
  /**
   * When true and semantic search is active, the (slow) embedding refresh is
   * dispatched to a detached background worker instead of awaited inline so the
   * mutation returns immediately. The synchronous keyword-cache invalidation
   * still runs first. Callers pass this only outside test runners.
   */
  background?: boolean;
}

export interface SemanticRefreshOptions {
  settings?: Awaited<ReturnType<typeof readSettings>>;
  apply_runtime_defaults?: boolean;
}

export interface VectorizationStatusLedgerReadResult {
  entries: Record<string, string>;
  embedding: VectorizationEmbeddingMetadata | null;
  warnings: string[];
}

function formatInvalidationWarning(relativePath: string, error: unknown): string {
  return `search_cache_invalidation_failed:${relativePath}:${String(error)}`;
}


function toUniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter((value) => value.length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function isValidUpdatedAt(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function normalizeVectorizationLedgerEntries(entries: Record<string, string>): Record<string, string> {
  const normalized = new Map<string, string>();
  for (const [rawId, rawUpdatedAt] of Object.entries(entries)) {
    const id = rawId.trim();
    if (id.length === 0 || !isValidUpdatedAt(rawUpdatedAt)) {
      continue;
    }
    normalized.set(id, rawUpdatedAt);
  }
  return Object.fromEntries([...normalized.entries()].sort((left, right) => left[0].localeCompare(right[0])));
}

export async function readVectorizationStatusLedger(pmRoot: string): Promise<VectorizationStatusLedgerReadResult> {
  const ledgerPath = path.join(pmRoot, VECTORIZATION_STATUS_LEDGER_PATH);
  const raw = await readFileIfExists(ledgerPath);
  if (raw === null || raw.trim().length === 0) {
    return {
      entries: {},
      embedding: null,
      warnings: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      entries: {},
      embedding: null,
      warnings: ["search_vectorization_status_ledger_invalid"],
    };
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { items?: unknown }).items)
  ) {
    return {
      entries: {},
      embedding: null,
      warnings: ["search_vectorization_status_ledger_invalid"],
    };
  }

  const mapped = new Map<string, string>();
  for (const entry of (parsed as { items: unknown[] }).items) {
    if (typeof entry !== "object" || entry === null) {
      return {
        entries: {},
        embedding: null,
        warnings: ["search_vectorization_status_ledger_invalid"],
      };
    }
    const id = (entry as { id?: unknown }).id;
    const updatedAt = (entry as { updated_at?: unknown }).updated_at;
    if (typeof id !== "string" || id.trim().length === 0 || !isValidUpdatedAt(updatedAt)) {
      return {
        entries: {},
        embedding: null,
        warnings: ["search_vectorization_status_ledger_invalid"],
      };
    }
    mapped.set(id.trim(), updatedAt);
  }

  let embedding: VectorizationEmbeddingMetadata | null = null;
  try {
    embedding = normalizeVectorizationEmbeddingMetadata((parsed as { embedding?: unknown }).embedding);
  } catch {
    return {
      entries: {},
      embedding: null,
      warnings: ["search_vectorization_status_ledger_invalid"],
    };
  }

  return {
    entries: Object.fromEntries([...mapped.entries()].sort((left, right) => left[0].localeCompare(right[0]))),
    embedding,
    warnings: [],
  };
}

export async function writeVectorizationStatusLedger(
  pmRoot: string,
  entries: Record<string, string>,
  embedding?: VectorizationEmbeddingMetadata | null,
): Promise<void> {
  const normalizedEntries = normalizeVectorizationLedgerEntries(entries);
  const ledgerPath = path.join(pmRoot, VECTORIZATION_STATUS_LEDGER_PATH);
  const serialized = `${JSON.stringify(
    {
      version: 1,
      generated_at: nowIso(),
      ...(embedding ? { embedding } : {}),
      items: Object.entries(normalizedEntries).map(([id, updated_at]) => ({
        id,
        updated_at,
      })),
    },
    null,
    2,
  )}\n`;
  await writeFileAtomic(ledgerPath, serialized);
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

interface SemanticEmbeddingOperationResult {
  vectors: number[][];
  vector_dimension: number;
  warnings: string[];
}

function buildVectorizationIdentityForProvider(provider: EmbeddingProviderConfig): VectorizationEmbeddingIdentity {
  const identity = buildVectorizationEmbeddingIdentity(provider.name, provider.model);
  if (!identity) {
    throw new Error("Embedding provider must include a provider name and model");
  }
  return identity;
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
  options: SemanticRefreshOptions,
): Promise<SemanticRefreshRuntimeContext | SemanticMutationRefreshResult> {
  if (!options.settings && !(await pathExists(getSettingsPath(pmRoot)))) {
    return buildSkippedSemanticRefreshResult(normalizedItemIds, "search_semantic_refresh_skipped:settings_not_initialized");
  }

  let settings: Awaited<ReturnType<typeof readSettings>>;
  try {
    settings = options.settings ?? (await readSettings(pmRoot));
  } catch (error: unknown) {
    return buildSkippedSemanticRefreshResult(
      normalizedItemIds,
      `search_semantic_refresh_skipped:settings_read_failed:${toErrorMessage(error)}`,
    );
  }
  const effectiveSettings = options.apply_runtime_defaults
    ? resolveSettingsWithSemanticRuntimeDefaults(settings).settings
    : settings;

  const provider = resolveEmbeddingProviders(effectiveSettings).active;
  if (!provider) {
    return buildSkippedSemanticRefreshResult(normalizedItemIds, "search_semantic_refresh_skipped:provider_unconfigured");
  }
  const vectorStore = resolveVectorStores(effectiveSettings).active;
  if (!vectorStore) {
    return buildSkippedSemanticRefreshResult(normalizedItemIds, "search_semantic_refresh_skipped:vector_store_unconfigured");
  }

  return {
    settings: effectiveSettings,
    provider,
    vectorStore,
  };
}

async function collectSemanticRefreshWorkload(
  pmRoot: string,
  idPrefix: string,
  preferredFormat: "toon" | "json_markdown",
  normalizedItemIds: string[],
  typeToFolder: Record<string, string>,
  schema: Awaited<ReturnType<typeof readSettings>>["schema"],
): Promise<SemanticRefreshWorkload> {
  const warnings: string[] = [];
  const skipped = new Set<string>();
  const missing = new Set<string>();
  const documents: Array<{ id: string; document: ItemDocument }> = [];

  for (const itemId of normalizedItemIds) {
    const located = await locateItem(pmRoot, itemId, idPrefix, preferredFormat, typeToFolder);
    if (!located) {
      missing.add(itemId);
      continue;
    }

    try {
      const loaded = await readLocatedItem(located, { schema });
      documents.push({
        id: loaded.document.metadata.id,
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

async function embedLocatedSemanticVectors(
  settings: Awaited<ReturnType<typeof readSettings>>,
  provider: EmbeddingProviderConfig,
  documents: Array<{ id: string; document: ItemDocument }>,
): Promise<SemanticEmbeddingOperationResult> {
  const corpusCharacterLimit = resolveSemanticCorpusCharacterLimit(
    provider.name,
    settings.search.embedding_corpus_max_characters,
  ).maxCharacters;
  const corpusInputs = documents.map((entry) =>
    buildSemanticCorpusInput(entry.document, {
      providerName: provider.name,
      maxCharacters: corpusCharacterLimit,
    }),
  );
  const embeddingResult = await executeEmbeddingBatchesWithRetry(provider, settings, corpusInputs);
  return {
    vectors: embeddingResult.vectors,
    vector_dimension: inferConsistentVectorDimension(embeddingResult.vectors, "Semantic refresh embedding"),
    warnings: embeddingResult.warnings,
  };
}

async function upsertLocatedSemanticVectors(
  vectorStore: VectorStoreConfig,
  documents: Array<{ id: string; document: ItemDocument }>,
  vectors: number[][],
): Promise<SemanticRefreshOperationResult> {
  await executeVectorUpsert(
    vectorStore,
    documents.map((entry, index) => ({
      id: entry.id,
      vector: vectors[index],
      payload: buildVectorPayload(entry.document.metadata),
    })),
  );
  return {
    refreshed: documents.map((entry) => entry.id),
    skipped: [],
    warnings: [],
  };
}

async function resetSemanticVectorStore(
  vectorStore: VectorStoreConfig,
  ledgerEntries: Record<string, string>,
): Promise<SemanticRefreshOperationResult> {
  try {
    await executeVectorReset(vectorStore, Object.keys(ledgerEntries));
    return { refreshed: [], skipped: [], warnings: [] };
  } catch (error: unknown) {
    return {
      refreshed: [],
      skipped: [],
      warnings: [`search_semantic_refresh_reset_failed:${toErrorMessage(error)}`],
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
  options: SemanticRefreshOptions = {},
): Promise<SemanticMutationRefreshResult> {
  const normalizedItemIds = toUniqueSorted(itemIds);
  if (normalizedItemIds.length === 0) {
    return {
      refreshed: [],
      skipped: [],
      warnings: [],
    };
  }

  const runtimeContext = await resolveSemanticRefreshRuntimeContext(pmRoot, normalizedItemIds, options);
  if (!("settings" in runtimeContext)) {
    return runtimeContext;
  }
  const typeRegistry = resolveItemTypeRegistry(runtimeContext.settings, getActiveExtensionRegistrations());
  const workload = await collectSemanticRefreshWorkload(
    pmRoot,
    runtimeContext.settings.id_prefix,
    runtimeContext.settings.item_format,
    normalizedItemIds,
    typeRegistry.type_to_folder,
    runtimeContext.settings.schema,
  );
  const ledgerRead =
    workload.documents.length > 0 || workload.missingIds.length > 0
      ? await readVectorizationStatusLedger(pmRoot)
      : { entries: {}, embedding: null, warnings: [] };
  const embeddingIdentity = buildVectorizationIdentityForProvider(runtimeContext.provider);
  const nextLedgerBaseEntries = ledgerRead.entries;
  let refreshedResult: SemanticRefreshOperationResult = { refreshed: [], skipped: [], warnings: [] };
  let nextEmbeddingMetadata = ledgerRead.embedding;
  if (workload.documents.length > 0) {
    if (ledgerRead.embedding && hasVectorizationEmbeddingIdentityChanged(ledgerRead.embedding, embeddingIdentity)) {
      refreshedResult = {
        refreshed: [],
        skipped: workload.documents.map((entry) => entry.id),
        warnings: ["search_semantic_refresh_requires_reindex:embedding_identity_changed"],
      };
    } else {
      try {
        const embedded = await embedLocatedSemanticVectors(
          runtimeContext.settings,
          runtimeContext.provider,
          workload.documents,
        );
        if (hasVectorizationVectorDimensionChanged(ledgerRead.embedding, embedded.vector_dimension)) {
          refreshedResult = {
            refreshed: [],
            skipped: workload.documents.map((entry) => entry.id),
            warnings: [...embedded.warnings, "search_semantic_refresh_requires_reindex:vector_dimension_changed"],
          };
        } else {
          nextEmbeddingMetadata = buildVectorizationEmbeddingMetadata(embeddingIdentity, embedded.vector_dimension);
          const upserted = await upsertLocatedSemanticVectors(runtimeContext.vectorStore, workload.documents, embedded.vectors);
          refreshedResult = {
            refreshed: upserted.refreshed,
            skipped: upserted.skipped,
            warnings: [...embedded.warnings, ...upserted.warnings],
          };
        }
      } catch (error: unknown) {
        refreshedResult = {
          refreshed: [],
          skipped: workload.documents.map((entry) => entry.id),
          warnings: [`search_semantic_refresh_failed:${toErrorMessage(error)}`],
        };
      }
    }
  }
  const pruneResult = await pruneMissingSemanticVectors(runtimeContext.vectorStore, workload.missingIds);
  const refreshedIdSet = new Set(refreshedResult.refreshed);
  const refreshedEntries = Object.fromEntries(
    workload.documents
      .filter((entry) => refreshedIdSet.has(entry.id))
      .map((entry) => [entry.id, entry.document.metadata.updated_at]),
  );
  const ledgerWarnings: string[] = [];
  if (Object.keys(refreshedEntries).length > 0 || workload.missingIds.length > 0) {
    const nextEntries = {
      ...nextLedgerBaseEntries,
      ...normalizeVectorizationLedgerEntries(refreshedEntries),
    };
    for (const missingId of workload.missingIds) {
      delete nextEntries[missingId];
    }
    try {
      await writeVectorizationStatusLedger(pmRoot, nextEntries, nextEmbeddingMetadata);
    } catch (error: unknown) {
      ledgerWarnings.push(`search_vectorization_status_ledger_write_failed:${toErrorMessage(error)}`);
    }
    ledgerWarnings.push(...ledgerRead.warnings);
  }

  return {
    refreshed: toUniqueSorted([...refreshedResult.refreshed, ...pruneResult.refreshed]),
    skipped: toUniqueSorted([...workload.skippedIds, ...refreshedResult.skipped, ...pruneResult.skipped]),
    warnings: [...workload.warnings, ...refreshedResult.warnings, ...pruneResult.warnings, ...ledgerWarnings],
  };
}

/**
 * Returns true when a semantic embedding refresh would do real work for these
 * settings (an embedding provider AND a vector store both resolve). Used to
 * decide whether a mutation's refresh is worth dispatching to a background
 * worker — when semantic search is not configured the inline path is already a
 * fast no-op and no child is spawned.
 */
export function isSemanticRefreshActive(
  settings: Awaited<ReturnType<typeof readSettings>>,
  applyRuntimeDefaults: boolean,
): boolean {
  const effectiveSettings = applyRuntimeDefaults
    ? resolveSettingsWithSemanticRuntimeDefaults(settings).settings
    : settings;
  return Boolean(resolveEmbeddingProviders(effectiveSettings).active && resolveVectorStores(effectiveSettings).active);
}

export async function refreshSearchArtifactsForMutation(
  pmRoot: string,
  itemIds: string[],
  options: RefreshSearchArtifactsForMutationOptions = {},
): Promise<SearchMutationArtifactRefreshResult> {
  const invalidation = await invalidateSearchCacheArtifacts(pmRoot);
  const normalizedItemIds = toUniqueSorted(itemIds);
  if (normalizedItemIds.length === 0) {
    return {
      invalidated: invalidation.invalidated,
      refreshed: [],
      skipped: [],
      warnings: invalidation.warnings,
    };
  }

  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    const semanticRefresh = await refreshSemanticEmbeddingsForMutatedItems(pmRoot, normalizedItemIds);
    return {
      invalidated: invalidation.invalidated,
      refreshed: semanticRefresh.refreshed,
      skipped: semanticRefresh.skipped,
      warnings: [...invalidation.warnings, ...semanticRefresh.warnings],
    };
  }

  let settings: Awaited<ReturnType<typeof readSettings>>;
  try {
    settings = await readSettings(pmRoot);
  } catch (error: unknown) {
    return {
      invalidated: invalidation.invalidated,
      refreshed: [],
      skipped: normalizedItemIds,
      warnings: [
        ...invalidation.warnings,
        `search_semantic_refresh_skipped:settings_read_failed:${toErrorMessage(error)}`,
      ],
    };
  }

  if (settings.search.mutation_refresh_policy === "cache_only") {
    return {
      invalidated: invalidation.invalidated,
      refreshed: [],
      skipped: normalizedItemIds,
      warnings: invalidation.warnings,
    };
  }

  const applyRuntimeDefaults = settings.search.mutation_refresh_policy === "semantic_auto";

  // Keyword cache is already invalidated synchronously above (so keyword search
  // stays immediately correct). When requested, dispatch the slow embedding
  // refresh to a detached worker so the mutation returns instantly; the
  // vector_index_stale health/search warning covers the catch-up window.
  if (options.background && isSemanticRefreshActive(settings, applyRuntimeDefaults)) {
    await scheduleBackgroundSemanticRefresh(pmRoot, normalizedItemIds);
    return {
      invalidated: invalidation.invalidated,
      refreshed: [],
      skipped: [],
      warnings: [...invalidation.warnings, "search_semantic_refresh_scheduled_background"],
      scheduled: true,
    };
  }

  const semanticRefresh = await refreshSemanticEmbeddingsForMutatedItems(pmRoot, normalizedItemIds, {
    settings,
    apply_runtime_defaults: applyRuntimeDefaults,
  });
  return {
    invalidated: invalidation.invalidated,
    refreshed: semanticRefresh.refreshed,
    skipped: semanticRefresh.skipped,
    warnings: [...invalidation.warnings, ...semanticRefresh.warnings],
  };
}

export const _testOnly = {
  buildSkippedSemanticRefreshResult,
  buildVectorizationIdentityForProvider,
  normalizeVectorizationLedgerEntries,
  resetSemanticVectorStore,
};
