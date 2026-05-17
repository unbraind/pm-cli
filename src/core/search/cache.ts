import path from "node:path";
import { getActiveExtensionRegistrations } from "../extensions/index.js";
import { pathExists, readFileIfExists, removeFileIfExists, writeFileAtomic } from "../fs/fs-utils.js";
import { resolveItemTypeRegistry } from "../item/type-registry.js";
import { toErrorMessage } from "../shared/primitives.js";
import { locateItem, readLocatedItem } from "../store/item-store.js";
import { getSettingsPath } from "../store/paths.js";
import { readSettings } from "../store/settings.js";
import { executeEmbeddingBatchesWithRetry } from "./embedding-batches.js";
import { buildSemanticCorpusInput } from "./corpus.js";
import { resolveEmbeddingProviders } from "./providers.js";
import type { EmbeddingProviderConfig } from "./providers.js";
import { resolveSettingsWithSemanticRuntimeDefaults } from "./semantic-defaults.js";
import { executeVectorDelete, executeVectorUpsert, resolveVectorStores } from "./vector-stores.js";
import type { VectorStoreConfig } from "./vector-stores.js";
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
}

export interface SemanticRefreshOptions {
  settings?: Awaited<ReturnType<typeof readSettings>>;
  apply_runtime_defaults?: boolean;
}

export interface VectorizationStatusLedgerReadResult {
  entries: Record<string, string>;
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
      warnings: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      entries: {},
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
      warnings: ["search_vectorization_status_ledger_invalid"],
    };
  }

  const mapped = new Map<string, string>();
  for (const entry of (parsed as { items: unknown[] }).items) {
    if (typeof entry !== "object" || entry === null) {
      return {
        entries: {},
        warnings: ["search_vectorization_status_ledger_invalid"],
      };
    }
    const id = (entry as { id?: unknown }).id;
    const updatedAt = (entry as { updated_at?: unknown }).updated_at;
    if (typeof id !== "string" || id.trim().length === 0 || !isValidUpdatedAt(updatedAt)) {
      return {
        entries: {},
        warnings: ["search_vectorization_status_ledger_invalid"],
      };
    }
    mapped.set(id.trim(), updatedAt);
  }

  return {
    entries: Object.fromEntries([...mapped.entries()].sort((left, right) => left[0].localeCompare(right[0]))),
    warnings: [],
  };
}

export async function writeVectorizationStatusLedger(pmRoot: string, entries: Record<string, string>): Promise<void> {
  const normalizedEntries = normalizeVectorizationLedgerEntries(entries);
  const ledgerPath = path.join(pmRoot, VECTORIZATION_STATUS_LEDGER_PATH);
  const serialized = `${JSON.stringify(
    {
      version: 1,
      generated_at: nowIso(),
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

async function refreshLocatedSemanticVectors(
  settings: Awaited<ReturnType<typeof readSettings>>,
  provider: EmbeddingProviderConfig,
  vectorStore: VectorStoreConfig,
  documents: Array<{ id: string; document: ItemDocument }>,
): Promise<SemanticRefreshOperationResult> {
  if (documents.length === 0) {
    return { refreshed: [], skipped: [], warnings: [] };
  }

  try {
    const corpusInputs = documents.map((entry) =>
      buildSemanticCorpusInput(entry.document, {
        providerName: provider.name,
      }),
    );
    const embeddingResult = await executeEmbeddingBatchesWithRetry(provider, settings, corpusInputs);
    await executeVectorUpsert(
      vectorStore,
      documents.map((entry, index) => ({
        id: entry.id,
        vector: embeddingResult.vectors[index],
        payload: buildVectorPayload(entry.document.metadata),
      })),
    );
    return {
      refreshed: documents.map((entry) => entry.id),
      skipped: [],
      warnings: embeddingResult.warnings,
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
  const refreshedResult = await refreshLocatedSemanticVectors(
    runtimeContext.settings,
    runtimeContext.provider,
    runtimeContext.vectorStore,
    workload.documents,
  );
  const pruneResult = await pruneMissingSemanticVectors(runtimeContext.vectorStore, workload.missingIds);
  const refreshedIdSet = new Set(refreshedResult.refreshed);
  const refreshedEntries = Object.fromEntries(
    workload.documents
      .filter((entry) => refreshedIdSet.has(entry.id))
      .map((entry) => [entry.id, entry.document.metadata.updated_at]),
  );
  const ledgerWarnings: string[] = [];
  if (Object.keys(refreshedEntries).length > 0 || workload.missingIds.length > 0) {
    const ledgerRead = await readVectorizationStatusLedger(pmRoot);
    const nextEntries = {
      ...ledgerRead.entries,
      ...normalizeVectorizationLedgerEntries(refreshedEntries),
    };
    for (const missingId of workload.missingIds) {
      delete nextEntries[missingId];
    }
    try {
      await writeVectorizationStatusLedger(pmRoot, nextEntries);
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

export async function refreshSearchArtifactsForMutation(
  pmRoot: string,
  itemIds: string[],
): Promise<SearchMutationArtifactRefreshResult> {
  const invalidation = await invalidateSearchCacheArtifacts(pmRoot);
  const semanticRefresh = await refreshSemanticEmbeddingsForMutatedItems(pmRoot, itemIds, {
    apply_runtime_defaults: true,
  });
  return {
    invalidated: invalidation.invalidated,
    refreshed: semanticRefresh.refreshed,
    skipped: semanticRefresh.skipped,
    warnings: [...invalidation.warnings, ...semanticRefresh.warnings],
  };
}
