/**
 * @module cli/commands/reindex
 *
 * Implements the pm reindex command surface and its agent-facing runtime behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { toNonEmptyStringOrUndefined } from "../../core/shared/primitives.js";
import { getActiveExtensionRegistrations, runActiveOnIndexHooks, runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { collectRegisteredItemFieldNames } from "../../core/extensions/item-fields.js";
import {
  resolveRegisteredSearchProvider,
  resolveRegisteredVectorStoreAdapter,
} from "../../core/extensions/runtime-registrations.js";
import { pathExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { parseItemDocument } from "../../core/item/item-format.js";
import { acquireLock } from "../../core/lock/lock.js";
import {
  buildSearchCorpus,
  buildSemanticCorpusInput,
  resolveSearchCorpusFields,
  resolveSemanticCorpusCharacterLimit,
} from "../../core/search/corpus.js";
import { executeEmbeddingBatchesWithRetry } from "../../core/search/embedding-batches.js";
import { readVectorizationStatusLedger, writeVectorizationStatusLedger } from "../../core/search/cache.js";
import { REINDEX_LOCK_ID } from "../../core/search/background-refresh.js";
import { resolveEmbeddingProviders } from "../../core/search/providers.js";
import { resolveSettingsWithSemanticRuntimeDefaults } from "../../core/search/semantic-defaults.js";
import { executeVectorDelete, executeVectorReset, executeVectorUpsert, resolveVectorStores } from "../../core/search/vector-stores.js";
import {
  buildVectorizationEmbeddingIdentity,
  buildVectorizationEmbeddingMetadata,
  hasVectorizationEmbeddingIdentityChanged,
  hasVectorizationVectorDimensionChanged,
  inferConsistentVectorDimension,
} from "../../core/search/vectorization-metadata.js";
import type {
  VectorizationEmbeddingIdentity,
  VectorizationEmbeddingMetadata,
} from "../../core/search/vectorization-metadata.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { listAllDocumentCandidatesCached, type CachedDocumentCandidate } from "../../core/store/front-matter-cache.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemDocument, PmSettings } from "../../types/index.js";

const MANIFEST_PATH = "index/manifest.json";
const EMBEDDINGS_PATH = "search/embeddings.jsonl";
const EMBEDDING_MIGRATION_REINDEX_HINT =
  "Provider or model has changed since last index. Run pm reindex --mode semantic to rebuild.";
type ReindexMode = "keyword" | "semantic" | "hybrid";

/**
 * Documents the reindex options payload exchanged by command, SDK, and package integrations.
 */
export interface ReindexOptions {
  mode?: string;
  progress?: boolean;
  full?: boolean;
}

/**
 * Documents the reindex result payload exchanged by command, SDK, and package integrations.
 */
export interface ReindexResult {
  ok: boolean;
  mode: ReindexMode;
  total_items: number;
  semantic: {
    enabled: boolean;
    stale_items: number;
    unchanged_items: number;
    embedded_items: number;
    vector_upserted: number;
    batches_completed: number;
  };
  artifacts: {
    manifest: string;
    embeddings: string;
  };
  warnings: string[];
  generated_at: string;
}

function shouldEmitReindexProgress(options: ReindexOptions): boolean {
  return options.progress === true || process.stderr.isTTY === true;
}

function emitReindexProgress(enabled: boolean, message: string): void {
  if (!enabled) {
    return;
  }
  try {
    process.stderr.write(`[pm reindex] ${message}\n`);
  } catch {
    // Ignore transient stderr write failures.
  }
}

function parseMode(raw: string | undefined): ReindexMode {
  const normalized = (raw ?? "keyword").trim().toLowerCase();
  if (normalized === "keyword") {
    return "keyword";
  }
  if (normalized === "semantic" || normalized === "hybrid") {
    return normalized;
  }
  throw new PmCliError("Reindex mode must be one of keyword|semantic|hybrid", EXIT_CODE.USAGE);
}

async function loadDocumentCandidates(
  pmRoot: string,
  itemFormat: "toon" | "json_markdown",
  typeToFolder: Record<string, string>,
  schema: PmSettings["schema"],
): Promise<{ candidates: CachedDocumentCandidate[]; warnings: string[] }> {
  const warnings: string[] = [];
  const candidates = await listAllDocumentCandidatesCached(pmRoot, itemFormat, typeToFolder, warnings, schema);
  return {
    candidates,
    warnings,
  };
}

async function hydrateDocuments(
  pmRoot: string,
  candidates: CachedDocumentCandidate[],
  schema: PmSettings["schema"],
  warnings: string[],
  itemIds?: Set<string>,
): Promise<ItemDocument[]> {
  const extensionFieldNames = collectRegisteredItemFieldNames(getActiveExtensionRegistrations());
  const hydrated: ItemDocument[] = [];
  for (const candidate of candidates) {
    if (itemIds && !itemIds.has(candidate.metadata.id)) {
      continue;
    }
    if (typeof candidate.body === "string") {
      hydrated.push({
        metadata: candidate.metadata,
        body: candidate.body,
      });
      continue;
    }
    try {
      const raw = await fs.readFile(candidate.item_path, "utf8");
      const parsed = parseItemDocument(raw, {
        format: candidate.item_format,
        schema,
        extensionFieldNames,
        onWarning: (warning) => warnings.push(warning),
      });
      hydrated.push({
        metadata: candidate.metadata,
        body: parsed.body,
      });
    } catch {
      warnings.push(`item_list_item_read_failed:${path.relative(pmRoot, candidate.item_path)}`);
      hydrated.push({
        metadata: candidate.metadata,
        body: "",
      });
    }
  }
  return hydrated;
}

function buildKeywordRecord(
  document: ItemDocument,
  mode: ReindexMode,
  corpusFields?: string[],
): Record<string, unknown> {
  const item = document.metadata;
  return {
    id: item.id,
    mode,
    updated_at: item.updated_at,
    corpus: buildSearchCorpus(document, { fields: corpusFields }),
  };
}

type ExtensionEmbedBatch = (context: {
  inputs: string[];
  settings: PmSettings;
  model: string;
}) => Promise<number[][]> | number[][];

type ExtensionEmbedOne = (context: {
  input: string;
  settings: PmSettings;
  model: string;
}) => Promise<number[]> | number[];

type ExtensionVectorUpsert = (context: {
  points: Array<{
    id: string;
    vector: number[];
    payload: Record<string, unknown>;
  }>;
  settings: PmSettings;
}) => Promise<void> | void;

type ExtensionVectorDelete = (context: {
  ids: string[];
  settings: PmSettings;
}) => Promise<void> | void;

interface ExtensionVectorAdapter {
  adapterName: string;
  upsert?: ExtensionVectorUpsert;
  delete?: ExtensionVectorDelete;
}

interface ReindexEmbeddingExecutionResult {
  vectors: number[][];
  embeddingIdentity: VectorizationEmbeddingIdentity;
}

interface ReindexSemanticRuntime {
  activeEmbeddingProvider: ReturnType<typeof resolveEmbeddingProviders>["active"];
  activeVectorStore: ReturnType<typeof resolveVectorStores>["active"];
}

interface ReindexLoadedCorpus {
  metadataDocuments: ItemDocument[];
  documentCandidates: CachedDocumentCandidate[];
  warnings: string[];
}

interface ReindexSemanticPlan {
  ledgerEntries: Record<string, string>;
  ledgerEmbedding: VectorizationEmbeddingMetadata | null;
  orphanIds: string[];
  resetRequired: boolean;
  staleDocuments: ItemDocument[];
  freshDocuments: number;
}

const toOptionalNonEmptyString = toNonEmptyStringOrUndefined;

export const _testOnly = {
  shouldEmitReindexProgress,
  emitReindexProgress,
  parseMode,
  hydrateDocuments,
  buildKeywordRecord,
  resolveExtensionSearchEmbedding,
  resolveExtensionVectorAdapter,
  assertVector,
  executeExtensionEmbedding,
  resolveExtensionEmbeddingModel,
  resolveReindexEmbeddingIdentity,
  executeReindexEmbedding,
  collectLedgerOrphanIds,
  resetVectorStoreForReindex,
  pruneReindexOrphanVectors,
  upsertReindexVectors,
};

function resolveExtensionSearchEmbedding(
  settings: PmSettings,
): { name: string; embedBatch?: ExtensionEmbedBatch; embed?: ExtensionEmbedOne } | null {
  const registrations = getActiveExtensionRegistrations();
  const providerName = toOptionalNonEmptyString(settings.search?.provider);
  if (!providerName) {
    return null;
  }
  const registration = resolveRegisteredSearchProvider(registrations, providerName);
  if (!registration) {
    return null;
  }
  const runtimeDefinition = registration.runtime_definition ?? registration.definition;
  const name =
    toOptionalNonEmptyString((runtimeDefinition as { name?: unknown }).name) ??
    toOptionalNonEmptyString((registration.definition as { name?: unknown }).name);
  // resolveRegisteredSearchProvider only matches a registration whose normalized
  // runtime/registered definition name equals providerName, so `name` here is always
  // that non-empty value; the guard exists solely to narrow string | undefined.
  /* c8 ignore start -- unreachable: a matched provider registration always carries a normalized name */
  if (!name) {
    return null;
  }
  /* c8 ignore stop */
  const embedBatch = (runtimeDefinition as { embedBatch?: unknown; embed_batch?: unknown }).embedBatch;
  const embedBatchSnake = (runtimeDefinition as { embedBatch?: unknown; embed_batch?: unknown }).embed_batch;
  const embed = (runtimeDefinition as { embed?: unknown }).embed;
  const resolvedEmbedBatch =
    typeof embedBatch === "function"
      ? (embedBatch as ExtensionEmbedBatch)
      : typeof embedBatchSnake === "function"
        ? (embedBatchSnake as ExtensionEmbedBatch)
        : undefined;
  const resolvedEmbed = typeof embed === "function" ? (embed as ExtensionEmbedOne) : undefined;
  if (!resolvedEmbedBatch && !resolvedEmbed) {
    return null;
  }
  return {
    name,
    embedBatch: resolvedEmbedBatch,
    embed: resolvedEmbed,
  };
}

function resolveExtensionVectorAdapter(settings: PmSettings): ExtensionVectorAdapter | null {
  const registrations = getActiveExtensionRegistrations();
  const adapterName = toOptionalNonEmptyString(settings.vector_store?.adapter);
  if (!adapterName) {
    return null;
  }
  const registration = resolveRegisteredVectorStoreAdapter(registrations, adapterName);
  if (!registration) {
    return null;
  }
  const runtimeDefinition = registration.runtime_definition ?? registration.definition;
  const adapterDisplayName =
    toOptionalNonEmptyString((runtimeDefinition as { name?: unknown }).name) ??
    toOptionalNonEmptyString((registration.definition as { name?: unknown }).name);
  /* c8 ignore start -- resolveRegisteredVectorStoreAdapter only returns registrations with a normalized runtime or definition name */
  if (!adapterDisplayName) {
    return null;
  }
  /* c8 ignore stop */
  const upsert = (runtimeDefinition as { upsert?: unknown }).upsert;
  const deleteHandler = (runtimeDefinition as { delete?: unknown }).delete;
  return {
    adapterName: adapterDisplayName,
    ...(typeof upsert === "function" ? { upsert: upsert as ExtensionVectorUpsert } : {}),
    ...(typeof deleteHandler === "function" ? { delete: deleteHandler as ExtensionVectorDelete } : {}),
  };
}

function assertVector(value: unknown, context: string): number[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    throw new PmCliError(`Invalid vector returned by ${context}`, EXIT_CODE.GENERIC_FAILURE);
  }
  return value;
}

async function executeExtensionEmbedding(
  extensionEmbedding: { name: string; embedBatch?: ExtensionEmbedBatch; embed?: ExtensionEmbedOne },
  settings: PmSettings,
  corpusInputs: string[],
): Promise<number[][]> {
  const model = settings.search?.embedding_model?.trim() || "text-embedding-3-small";
  if (extensionEmbedding.embedBatch) {
    const vectors = await Promise.resolve(
      extensionEmbedding.embedBatch({
        inputs: corpusInputs,
        settings,
        model,
      }),
    );
    if (!Array.isArray(vectors)) {
      throw new PmCliError(
        `Extension search provider "${extensionEmbedding.name}" embedBatch must return an array of vectors`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    return vectors.map((vector, index) =>
      assertVector(vector, `extension search provider "${extensionEmbedding.name}" embedBatch output at index ${index}`),
    );
  }
  if (!extensionEmbedding.embed) {
    throw new PmCliError(
      `Extension search provider "${extensionEmbedding.name}" does not implement embed/embedBatch`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  const vectors: number[][] = [];
  for (const [index, input] of corpusInputs.entries()) {
    const vector = await Promise.resolve(
      extensionEmbedding.embed({
        input,
        settings,
        model,
      }),
    );
    vectors.push(assertVector(vector, `extension search provider "${extensionEmbedding.name}" embed output at index ${index}`));
  }
  return vectors;
}

function resolveExtensionEmbeddingModel(settings: PmSettings): string {
  return settings.search?.embedding_model?.trim() || "text-embedding-3-small";
}

function resolveReindexEmbeddingIdentity(
  settings: PmSettings,
  activeEmbeddingProvider: ReturnType<typeof resolveEmbeddingProviders>["active"],
  extensionEmbedding: { name: string } | null,
): VectorizationEmbeddingIdentity {
  const identity = extensionEmbedding
    ? buildVectorizationEmbeddingIdentity(extensionEmbedding.name, resolveExtensionEmbeddingModel(settings))
    : activeEmbeddingProvider
      ? buildVectorizationEmbeddingIdentity(activeEmbeddingProvider.name, activeEmbeddingProvider.model)
      : null;
  if (!identity) {
    throw new PmCliError(
      `No embedding identity available for semantic reindex mode`,
      EXIT_CODE.USAGE,
    );
  }
  return identity;
}

function collectLedgerOrphanIds(ledgerEntries: Record<string, string>, currentIds: Set<string>): string[] {
  return Object.keys(ledgerEntries)
    .filter((id) => !currentIds.has(id))
    .sort((left, right) => left.localeCompare(right));
}

async function executeReindexEmbedding(
  settings: PmSettings,
  requestedMode: "keyword" | "semantic" | "hybrid",
  activeEmbeddingProvider: ReturnType<typeof resolveEmbeddingProviders>["active"],
  extensionEmbedding: { name: string; embedBatch?: ExtensionEmbedBatch; embed?: ExtensionEmbedOne } | null,
  documents: ItemDocument[],
  semanticWarnings: string[],
  semanticSummary: ReindexResult["semantic"],
  progressEnabled: boolean,
): Promise<ReindexEmbeddingExecutionResult> {
  const semanticProviderName = extensionEmbedding?.name ?? activeEmbeddingProvider?.name;
  const corpusCharacterLimit = resolveSemanticCorpusCharacterLimit(
    semanticProviderName,
    settings.search.embedding_corpus_max_characters,
  ).maxCharacters;
  const corpusFields = resolveSearchCorpusFields(settings);
  const corpusInputs = documents.map((document) =>
    buildSemanticCorpusInput(document, {
      providerName: semanticProviderName,
      maxCharacters: corpusCharacterLimit,
      fields: corpusFields,
    }),
  );
  let vectors: number[][] = [];
  let embeddingIdentity: VectorizationEmbeddingIdentity | null = null;
  if (extensionEmbedding) {
    try {
      vectors = await executeExtensionEmbedding(extensionEmbedding, settings, corpusInputs);
      embeddingIdentity = buildVectorizationEmbeddingIdentity(extensionEmbedding.name, resolveExtensionEmbeddingModel(settings));
    } catch (error: unknown) {
      if (!activeEmbeddingProvider) {
        throw new PmCliError(
          `Extension search provider "${extensionEmbedding.name}" failed to generate embeddings: ${error instanceof Error ? error.message : String(error)}`,
          EXIT_CODE.GENERIC_FAILURE,
        );
      }
      semanticWarnings.push(
        `Extension search provider "${extensionEmbedding.name}" failed; falling back to built-in provider (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  if (vectors.length === 0) {
    if (!activeEmbeddingProvider) {
      throw new PmCliError(
        `No embedding executor available for reindex mode '${requestedMode}'`,
        EXIT_CODE.USAGE,
      );
    }
    const embeddingResult = await executeEmbeddingBatchesWithRetry(activeEmbeddingProvider, settings, corpusInputs, {
      onProgress: (event) => {
        if (event.phase === "complete") {
          semanticSummary.batches_completed = event.batch_index;
        }
        emitReindexProgress(
          progressEnabled,
          `embedding_batch_${event.phase} batch=${event.batch_index}/${event.batch_total} size=${event.batch_size} completed_inputs=${event.completed_inputs}/${event.total_inputs}`,
        );
      },
    });
    semanticWarnings.push(...embeddingResult.warnings);
    vectors = embeddingResult.vectors;
    embeddingIdentity = buildVectorizationEmbeddingIdentity(activeEmbeddingProvider.name, activeEmbeddingProvider.model);
  }
  emitReindexProgress(progressEnabled, `embedding_complete vectors=${vectors.length}`);
  if (vectors.length !== documents.length) {
    throw new PmCliError(
      `Embedding output size mismatch (expected ${documents.length}, received ${vectors.length})`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  if (!embeddingIdentity) {
    throw new PmCliError(
      `No embedding identity available for reindex mode '${requestedMode}'`,
      EXIT_CODE.USAGE,
    );
  }
  return { vectors, embeddingIdentity };
}

async function resetVectorStoreForReindex(
  activeVectorStore: ReturnType<typeof resolveVectorStores>["active"],
  extensionVectorAdapter: ExtensionVectorAdapter | null,
  ledgerEntries: Record<string, string>,
  settings: PmSettings,
  semanticWarnings: string[],
  vectorDimension?: number,
): Promise<void> {
  const knownIds = Object.keys(ledgerEntries);
  if (extensionVectorAdapter) {
    if (knownIds.length > 0 && extensionVectorAdapter.delete) {
      try {
        await Promise.resolve(extensionVectorAdapter.delete({ ids: knownIds.sort((left, right) => left.localeCompare(right)), settings }));
      } catch (error: unknown) {
        throw new PmCliError(
          `Extension vector adapter "${extensionVectorAdapter.adapterName}" failed to delete vectors during reindex reset: ${error instanceof Error ? error.message : String(error)}`,
          EXIT_CODE.GENERIC_FAILURE,
        );
      }
    } else if (knownIds.length > 0) {
      semanticWarnings.push(
        `search_semantic_reindex_reset_skipped:adapter=${extensionVectorAdapter.adapterName}:known_ids=${knownIds.length}`,
      );
    }
    if (!activeVectorStore) {
      return;
    }
  }
  if (activeVectorStore) {
    await executeVectorReset(activeVectorStore, knownIds, {}, vectorDimension);
  }
}

async function pruneReindexOrphanVectors(
  activeVectorStore: ReturnType<typeof resolveVectorStores>["active"],
  extensionVectorAdapter: ExtensionVectorAdapter | null,
  orphanIds: string[],
  settings: PmSettings,
  semanticWarnings: string[],
): Promise<void> {
  if (orphanIds.length === 0) {
    return;
  }
  if (extensionVectorAdapter) {
    if (extensionVectorAdapter.delete) {
      try {
        await Promise.resolve(extensionVectorAdapter.delete({ ids: orphanIds, settings }));
      } catch (error: unknown) {
        throw new PmCliError(
          `Extension vector adapter "${extensionVectorAdapter.adapterName}" failed to delete orphan vectors during reindex: ${error instanceof Error ? error.message : String(error)}`,
          EXIT_CODE.GENERIC_FAILURE,
        );
      }
    } else {
      semanticWarnings.push(
        `search_semantic_reindex_orphan_prune_skipped:adapter=${extensionVectorAdapter.adapterName}:count=${orphanIds.length}`,
      );
    }
    if (!activeVectorStore) {
      return;
    }
  }
  if (activeVectorStore) {
    await executeVectorDelete(activeVectorStore, orphanIds);
  }
}

function createReindexSemanticSummary(mode: ReindexMode): ReindexResult["semantic"] {
  return {
    enabled: mode !== "keyword",
    stale_items: 0,
    unchanged_items: 0,
    embedded_items: 0,
    vector_upserted: 0,
    batches_completed: 0,
  };
}

function buildReindexManifest(mode: ReindexMode, generatedAt: string, metadataDocuments: ItemDocument[]): {
  version: number;
  mode: ReindexMode;
  generated_at: string;
  total_items: number;
  items: Array<{
    id: string;
    type: string;
    status: string;
    priority: ItemDocument["metadata"]["priority"];
    updated_at: string;
  }>;
} {
  return {
    version: 1,
    mode,
    generated_at: generatedAt,
    total_items: metadataDocuments.length,
    items: metadataDocuments.map((document) => ({
      id: document.metadata.id,
      type: document.metadata.type,
      status: document.metadata.status,
      priority: document.metadata.priority,
      updated_at: document.metadata.updated_at,
    })),
  };
}

function assertSemanticRuntimeAvailable(params: {
  requestedMode: ReindexMode;
  pmRoot: string;
  settings: PmSettings;
  extensionEmbedding: { name: string; embedBatch?: ExtensionEmbedBatch; embed?: ExtensionEmbedOne } | null;
  extensionVectorAdapter: ExtensionVectorAdapter | null;
}): ReindexSemanticRuntime {
  if (params.requestedMode === "keyword") {
    return {
      activeEmbeddingProvider: null,
      activeVectorStore: null,
    };
  }
  const providerResolution = resolveEmbeddingProviders(params.settings);
  if (!providerResolution.active && !params.extensionEmbedding) {
    throw new PmCliError(
      `Reindex mode '${params.requestedMode}' requires a configured embedding provider in settings.providers.openai/settings.providers.ollama or an extension provider selected by settings.search.provider`,
      EXIT_CODE.USAGE,
    );
  }
  const vectorResolution = resolveVectorStores(params.settings, params.pmRoot);
  if (!vectorResolution.active && !params.extensionVectorAdapter) {
    throw new PmCliError(
      `Reindex mode '${params.requestedMode}' requires a configured vector store in settings.vector_store.qdrant/settings.vector_store.lancedb or an extension adapter selected by settings.vector_store.adapter`,
      EXIT_CODE.USAGE,
    );
  }
  return {
    activeEmbeddingProvider: providerResolution.active,
    activeVectorStore: vectorResolution.active,
  };
}

async function loadReindexCorpus(params: {
  pmRoot: string;
  settings: PmSettings;
}): Promise<ReindexLoadedCorpus> {
  const typeRegistry = resolveItemTypeRegistry(params.settings, getActiveExtensionRegistrations());
  const loadedCandidates = await loadDocumentCandidates(
    params.pmRoot,
    params.settings.item_format,
    typeRegistry.type_to_folder,
    params.settings.schema,
  );
  return {
    documentCandidates: loadedCandidates.candidates,
    warnings: [...loadedCandidates.warnings],
    metadataDocuments: loadedCandidates.candidates.map((candidate) => ({
      metadata: candidate.metadata,
      body: typeof candidate.body === "string" ? candidate.body : "",
    })),
  };
}

async function appendKeywordLedgerWarnings(params: {
  pmRoot: string;
  settings: PmSettings;
  forceFullSemantic: boolean;
  extensionEmbedding: { name: string; embedBatch?: ExtensionEmbedBatch; embed?: ExtensionEmbedOne } | null;
  reindexWarnings: string[];
}): Promise<void> {
  const ledger = await readVectorizationStatusLedger(params.pmRoot);
  params.reindexWarnings.push(...ledger.warnings);
  if (params.forceFullSemantic) {
    params.reindexWarnings.push("search_semantic_reindex_full_ignored:mode_keyword");
  }
  if (!ledger.embedding) {
    return;
  }
  const currentEmbeddingIdentity = (() => {
    try {
      return resolveReindexEmbeddingIdentity(params.settings, resolveEmbeddingProviders(params.settings).active, params.extensionEmbedding);
    } catch {
      return null;
    }
  })();
  if (currentEmbeddingIdentity && hasVectorizationEmbeddingIdentityChanged(ledger.embedding, currentEmbeddingIdentity)) {
    params.reindexWarnings.push("search_semantic_reindex_requires_rebuild:embedding_identity_changed");
    params.reindexWarnings.push(EMBEDDING_MIGRATION_REINDEX_HINT);
  }
}

async function planSemanticReindex(params: {
  pmRoot: string;
  settings: PmSettings;
  activeEmbeddingProvider: ReturnType<typeof resolveEmbeddingProviders>["active"];
  extensionEmbedding: { name: string; embedBatch?: ExtensionEmbedBatch; embed?: ExtensionEmbedOne } | null;
  documentCandidates: CachedDocumentCandidate[];
  metadataDocuments: ItemDocument[];
  forceFullSemantic: boolean;
  semanticWarnings: string[];
  reindexWarnings: string[];
}): Promise<ReindexSemanticPlan> {
  const ledger = await readVectorizationStatusLedger(params.pmRoot);
  params.semanticWarnings.push(...ledger.warnings);
  const embeddingIdentity = resolveReindexEmbeddingIdentity(
    params.settings,
    params.activeEmbeddingProvider,
    params.extensionEmbedding,
  );
  const currentIds = new Set(params.metadataDocuments.map((document) => document.metadata.id));
  const orphanIds = collectLedgerOrphanIds(ledger.entries, currentIds);
  const resetRequired = hasVectorizationEmbeddingIdentityChanged(ledger.embedding, embeddingIdentity);
  if (params.forceFullSemantic && !resetRequired) {
    params.semanticWarnings.push("search_semantic_reindex_full_rebuild_forced");
  }
  const staleSourceDocuments =
    params.forceFullSemantic || resetRequired
      ? params.metadataDocuments
      : params.metadataDocuments.filter((document) => ledger.entries[document.metadata.id] !== document.metadata.updated_at);
  const staleIds = new Set(staleSourceDocuments.map((document) => document.metadata.id));
  const staleDocuments = staleIds.size > 0
    ? await hydrateDocuments(params.pmRoot, params.documentCandidates, params.settings.schema, params.reindexWarnings, staleIds)
    : [];
  return {
    ledgerEntries: ledger.entries,
    ledgerEmbedding: ledger.embedding,
    orphanIds,
    resetRequired,
    staleDocuments,
    freshDocuments: params.metadataDocuments.length - staleDocuments.length,
  };
}

async function rerunSemanticEmbeddingAfterDimensionChange(params: {
  pmRoot: string;
  settings: PmSettings;
  requestedMode: ReindexMode;
  activeEmbeddingProvider: ReturnType<typeof resolveEmbeddingProviders>["active"];
  extensionEmbedding: { name: string; embedBatch?: ExtensionEmbedBatch; embed?: ExtensionEmbedOne } | null;
  documentCandidates: CachedDocumentCandidate[];
  metadataDocuments: ItemDocument[];
  semanticWarnings: string[];
  reindexWarnings: string[];
  semanticSummary: ReindexResult["semantic"];
  progressEnabled: boolean;
}): Promise<ReindexEmbeddingExecutionResult & { staleDocuments: ItemDocument[]; vectorDimension: number }> {
  const staleIds = new Set(params.metadataDocuments.map((document) => document.metadata.id));
  const staleDocuments = await hydrateDocuments(
    params.pmRoot,
    params.documentCandidates,
    params.settings.schema,
    params.reindexWarnings,
    staleIds,
  );
  params.semanticSummary.stale_items = staleDocuments.length;
  params.semanticSummary.unchanged_items = 0;
  emitReindexProgress(params.progressEnabled, `embedding_dimension_changed reset_items=${staleDocuments.length}`);
  const embeddingResult = await executeReindexEmbedding(
    params.settings,
    params.requestedMode,
    params.activeEmbeddingProvider,
    params.extensionEmbedding,
    staleDocuments,
    params.semanticWarnings,
    params.semanticSummary,
    params.progressEnabled,
  );
  return {
    ...embeddingResult,
    staleDocuments,
    vectorDimension: inferConsistentVectorDimension(embeddingResult.vectors, "Reindex embeddings"),
  };
}

async function resolveSemanticEmbeddingForUpsert(params: {
  pmRoot: string;
  settings: PmSettings;
  requestedMode: ReindexMode;
  activeEmbeddingProvider: ReturnType<typeof resolveEmbeddingProviders>["active"];
  extensionEmbedding: { name: string; embedBatch?: ExtensionEmbedBatch; embed?: ExtensionEmbedOne } | null;
  documentCandidates: CachedDocumentCandidate[];
  metadataDocuments: ItemDocument[];
  staleDocuments: ItemDocument[];
  ledgerEmbedding: VectorizationEmbeddingMetadata | null;
  resetRequired: boolean;
  semanticWarnings: string[];
  reindexWarnings: string[];
  semanticSummary: ReindexResult["semantic"];
  progressEnabled: boolean;
}): Promise<ReindexEmbeddingExecutionResult & { staleDocuments: ItemDocument[]; vectorDimension: number; resetRequired: boolean }> {
  const embeddingResult = await executeReindexEmbedding(
    params.settings,
    params.requestedMode,
    params.activeEmbeddingProvider,
    params.extensionEmbedding,
    params.staleDocuments,
    params.semanticWarnings,
    params.semanticSummary,
    params.progressEnabled,
  );
  let vectors = embeddingResult.vectors;
  let actualEmbeddingIdentity = embeddingResult.embeddingIdentity;
  let vectorDimension = inferConsistentVectorDimension(vectors, "Reindex embeddings");
  const dimensionChanged =
    !params.resetRequired &&
    (hasVectorizationEmbeddingIdentityChanged(params.ledgerEmbedding, actualEmbeddingIdentity) ||
      hasVectorizationVectorDimensionChanged(params.ledgerEmbedding, vectorDimension));
  if (!dimensionChanged) {
    return {
      vectors,
      embeddingIdentity: actualEmbeddingIdentity,
      staleDocuments: params.staleDocuments,
      vectorDimension,
      resetRequired: params.resetRequired,
    };
  }
  const rerun = await rerunSemanticEmbeddingAfterDimensionChange(params);
  vectors = rerun.vectors;
  actualEmbeddingIdentity = rerun.embeddingIdentity;
  vectorDimension = rerun.vectorDimension;
  return {
    vectors,
    embeddingIdentity: actualEmbeddingIdentity,
    staleDocuments: rerun.staleDocuments,
    vectorDimension,
    resetRequired: true,
  };
}

async function upsertReindexVectors(params: {
  requestedMode: ReindexMode;
  activeVectorStore: ReturnType<typeof resolveVectorStores>["active"];
  extensionVectorAdapter: ExtensionVectorAdapter | null;
  settings: PmSettings;
  points: Array<{
    id: string;
    vector: number[];
    payload: Record<string, unknown>;
  }>;
  semanticWarnings: string[];
  semanticSummary: ReindexResult["semantic"];
  progressEnabled: boolean;
}): Promise<void> {
  if (params.extensionVectorAdapter) {
    try {
      const adapterName = params.extensionVectorAdapter.adapterName;
      emitReindexProgress(params.progressEnabled, `vector_upsert_start adapter=${adapterName} points=${params.points.length}`);
      if (typeof params.extensionVectorAdapter.upsert !== "function") {
        throw new PmCliError(
          `Extension vector adapter "${adapterName}" does not support upserting vectors.`,
          EXIT_CODE.USAGE,
        );
      }
      await Promise.resolve(params.extensionVectorAdapter.upsert({ points: params.points, settings: params.settings }));
      params.semanticSummary.vector_upserted = params.points.length;
      emitReindexProgress(params.progressEnabled, `vector_upsert_complete adapter=${adapterName}`);
      return;
    } catch (error: unknown) {
      if (error instanceof PmCliError) {
        throw error;
      }
      if (!params.activeVectorStore) {
        throw new PmCliError(
          `Extension vector adapter "${params.extensionVectorAdapter.adapterName}" failed to upsert vectors: ${error instanceof Error ? error.message : String(error)}`,
          EXIT_CODE.GENERIC_FAILURE,
        );
      }
      params.semanticWarnings.push(
        `Extension vector adapter "${params.extensionVectorAdapter.adapterName}" failed; falling back to built-in vector store (${error instanceof Error ? error.message : String(error)})`,
      );
      emitReindexProgress(params.progressEnabled, "vector_upsert_fallback built_in_store");
    }
  }
  if (params.activeVectorStore) {
    emitReindexProgress(params.progressEnabled, `vector_upsert_start adapter=${params.activeVectorStore.name} points=${params.points.length}`);
    await executeVectorUpsert(params.activeVectorStore, params.points);
    params.semanticSummary.vector_upserted = params.points.length;
    emitReindexProgress(params.progressEnabled, `vector_upsert_complete adapter=${params.activeVectorStore.name}`);
    return;
  }
  /* c8 ignore start -- guarded by semantic-mode provider/vector-store preflight above */
  throw new PmCliError(
    `No vector upsert executor available for reindex mode '${params.requestedMode}'`,
    EXIT_CODE.USAGE,
  );
  /* c8 ignore stop */
}

function buildReindexVectorPoints(staleDocuments: ItemDocument[], vectors: number[][]): Array<{
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}> {
  return staleDocuments.map((document, index) => ({
    id: document.metadata.id,
    vector: assertVector(vectors[index], `reindex embeddings output at index ${index}`),
    payload: {
      id: document.metadata.id,
      type: document.metadata.type,
      status: document.metadata.status,
      priority: document.metadata.priority,
      updated_at: document.metadata.updated_at,
    },
  }));
}

async function executeSemanticVectorRefresh(params: {
  pmRoot: string;
  settings: PmSettings;
  requestedMode: ReindexMode;
  activeEmbeddingProvider: ReturnType<typeof resolveEmbeddingProviders>["active"];
  activeVectorStore: ReturnType<typeof resolveVectorStores>["active"];
  extensionEmbedding: { name: string; embedBatch?: ExtensionEmbedBatch; embed?: ExtensionEmbedOne } | null;
  extensionVectorAdapter: ExtensionVectorAdapter | null;
  documentCandidates: CachedDocumentCandidate[];
  metadataDocuments: ItemDocument[];
  plan: ReindexSemanticPlan;
  semanticWarnings: string[];
  reindexWarnings: string[];
  semanticSummary: ReindexResult["semantic"];
  progressEnabled: boolean;
}): Promise<{ staleDocuments: ItemDocument[]; embeddingMetadata: VectorizationEmbeddingMetadata }> {
  emitReindexProgress(params.progressEnabled, `embedding_start items=${params.plan.staleDocuments.length} unchanged_items=${params.plan.freshDocuments}`);
  const embedding = await resolveSemanticEmbeddingForUpsert({
    pmRoot: params.pmRoot,
    settings: params.settings,
    requestedMode: params.requestedMode,
    activeEmbeddingProvider: params.activeEmbeddingProvider,
    extensionEmbedding: params.extensionEmbedding,
    documentCandidates: params.documentCandidates,
    metadataDocuments: params.metadataDocuments,
    staleDocuments: params.plan.staleDocuments,
    ledgerEmbedding: params.plan.ledgerEmbedding,
    resetRequired: params.plan.resetRequired,
    semanticWarnings: params.semanticWarnings,
    reindexWarnings: params.reindexWarnings,
    semanticSummary: params.semanticSummary,
    progressEnabled: params.progressEnabled,
  });
  if (embedding.resetRequired) {
    emitReindexProgress(params.progressEnabled, "vector_reset_start");
    await resetVectorStoreForReindex(
      params.activeVectorStore,
      params.extensionVectorAdapter,
      params.plan.ledgerEntries,
      params.settings,
      params.semanticWarnings,
      params.plan.ledgerEmbedding ? embedding.vectorDimension : undefined,
    );
    emitReindexProgress(params.progressEnabled, "vector_reset_complete");
  } else {
    await pruneReindexOrphanVectors(
      params.activeVectorStore,
      params.extensionVectorAdapter,
      params.plan.orphanIds,
      params.settings,
      params.semanticWarnings,
    );
  }
  const points = buildReindexVectorPoints(embedding.staleDocuments, embedding.vectors);
  params.semanticSummary.embedded_items = embedding.vectors.length;
  await upsertReindexVectors({
    requestedMode: params.requestedMode,
    activeVectorStore: params.activeVectorStore,
    extensionVectorAdapter: params.extensionVectorAdapter,
    settings: params.settings,
    points,
    semanticWarnings: params.semanticWarnings,
    semanticSummary: params.semanticSummary,
    progressEnabled: params.progressEnabled,
  });
  return {
    staleDocuments: embedding.staleDocuments,
    embeddingMetadata: buildVectorizationEmbeddingMetadata(embedding.embeddingIdentity, embedding.vectorDimension),
  };
}

async function runSemanticReindex(params: {
  pmRoot: string;
  settings: PmSettings;
  requestedMode: ReindexMode;
  activeEmbeddingProvider: ReturnType<typeof resolveEmbeddingProviders>["active"];
  activeVectorStore: ReturnType<typeof resolveVectorStores>["active"];
  extensionEmbedding: { name: string; embedBatch?: ExtensionEmbedBatch; embed?: ExtensionEmbedOne } | null;
  extensionVectorAdapter: ExtensionVectorAdapter | null;
  documentCandidates: CachedDocumentCandidate[];
  metadataDocuments: ItemDocument[];
  documentsForKeywordArtifacts: ItemDocument[];
  forceFullSemantic: boolean;
  reindexWarnings: string[];
  semanticWarnings: string[];
  semanticSummary: ReindexResult["semantic"];
  progressEnabled: boolean;
}): Promise<{
  documentsForKeywordArtifacts: ItemDocument[];
  vectorizationLedgerEntries: Record<string, string>;
  vectorizationEmbeddingMetadata: VectorizationEmbeddingMetadata | null;
}> {
  const plan = await planSemanticReindex(params);
  params.semanticSummary.stale_items = plan.staleDocuments.length;
  params.semanticSummary.unchanged_items = plan.freshDocuments;
  const vectorizationLedgerEntries = Object.fromEntries(
    params.metadataDocuments.map((document) => [document.metadata.id, document.metadata.updated_at]),
  );
  emitReindexProgress(
    params.progressEnabled,
    `semantic_stale_items stale=${plan.staleDocuments.length} total=${params.metadataDocuments.length} unchanged=${plan.freshDocuments} full=${params.forceFullSemantic || plan.resetRequired}`,
  );
  if (plan.staleDocuments.length === 0) {
    emitReindexProgress(params.progressEnabled, `embedding_skipped unchanged_items=${plan.freshDocuments}`);
    params.semanticWarnings.push(`search_semantic_reindex_skipped_unchanged:count=${plan.freshDocuments}`);
    await pruneReindexOrphanVectors(
      params.activeVectorStore,
      params.extensionVectorAdapter,
      plan.orphanIds,
      params.settings,
      params.semanticWarnings,
    );
    return {
      documentsForKeywordArtifacts: params.documentsForKeywordArtifacts,
      vectorizationLedgerEntries,
      vectorizationEmbeddingMetadata: plan.ledgerEmbedding,
    };
  }
  const refresh = await executeSemanticVectorRefresh({ ...params, plan });
  if (plan.freshDocuments > 0) {
    params.semanticWarnings.push(`search_semantic_reindex_skipped_unchanged:count=${plan.freshDocuments}`);
  }
  const staleDocumentsById = new Map(refresh.staleDocuments.map((document) => [document.metadata.id, document]));
  return {
    documentsForKeywordArtifacts: params.metadataDocuments.map(
      (document) => staleDocumentsById.get(document.metadata.id) ?? document,
    ),
    vectorizationLedgerEntries,
    vectorizationEmbeddingMetadata: refresh.embeddingMetadata,
  };
}

async function writeReindexArtifacts(params: {
  pmRoot: string;
  mode: ReindexMode;
  manifest: ReturnType<typeof buildReindexManifest>;
  documentsForKeywordArtifacts: ItemDocument[];
  settings: PmSettings;
  vectorizationLedgerEntries: Record<string, string>;
  vectorizationEmbeddingMetadata: VectorizationEmbeddingMetadata | null;
  progressEnabled: boolean;
}): Promise<string[]> {
  const manifestPath = path.join(params.pmRoot, MANIFEST_PATH);
  const embeddingsPath = path.join(params.pmRoot, EMBEDDINGS_PATH);
  const keywordCorpusFields = resolveSearchCorpusFields(params.settings);
  const embeddingsLines = params.documentsForKeywordArtifacts
    .map((document) => JSON.stringify(buildKeywordRecord(document, params.mode, keywordCorpusFields)))
    .join("\n");
  emitReindexProgress(params.progressEnabled, "writing keyword artifacts");
  await writeFileAtomic(manifestPath, `${JSON.stringify(params.manifest, null, 2)}\n`);
  await writeFileAtomic(embeddingsPath, `${embeddingsLines}\n`);
  const vectorizationWarnings: string[] = [];
  if (params.mode !== "keyword") {
    try {
      emitReindexProgress(params.progressEnabled, "writing vectorization status ledger");
      await writeVectorizationStatusLedger(
        params.pmRoot,
        params.vectorizationLedgerEntries,
        params.vectorizationEmbeddingMetadata,
      );
    } catch (error: unknown) {
      vectorizationWarnings.push(
        `search_vectorization_status_ledger_write_failed:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return vectorizationWarnings;
}

/**
 * Implements run reindex for the public runtime surface of this module.
 */
export async function runReindex(options: ReindexOptions, global: GlobalOptions): Promise<ReindexResult> {
  const requestedMode = parseMode(options.mode);
  const progressEnabled = shouldEmitReindexProgress(options);
  const forceFullSemantic = options.full === true;
  emitReindexProgress(progressEnabled, `start mode=${requestedMode}`);
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = resolveSettingsWithSemanticRuntimeDefaults(await readSettings(pmRoot)).settings;
  let releaseReindexLock: (() => Promise<void>) | null = null;
  try {
    releaseReindexLock = await acquireLock(
      pmRoot,
      REINDEX_LOCK_ID,
      settings.locks.ttl_seconds,
      process.env.PM_AUTHOR ?? "pm-reindex",
      false,
      settings.governance.force_required_for_stale_lock,
      settings.locks.wait_ms,
    );
  } catch (error: unknown) {
    if (error instanceof PmCliError && error.exitCode === EXIT_CODE.CONFLICT) {
      throw new PmCliError(
        "Another pm reindex run is already active for this project. Wait for it to finish before starting a new keyword, semantic, or hybrid reindex.",
        EXIT_CODE.CONFLICT,
        {
          code: "reindex_already_running",
          type: "urn:pm-cli:error:reindex_already_running",
          why: "Semantic reindex can be expensive and duplicate runs compete for the same local embedding model and vector store.",
          nextSteps: [
            "Check active pm reindex processes before starting another reindex.",
            "Rerun with --progress when you need non-interactive visibility.",
          ],
        },
      );
    }
    throw error;
  }

  try {
  const extensionEmbedding = resolveExtensionSearchEmbedding(settings);
  const extensionVectorAdapter = resolveExtensionVectorAdapter(settings);
  const semanticRuntime = assertSemanticRuntimeAvailable({
    requestedMode,
    pmRoot,
    settings,
    extensionEmbedding,
    extensionVectorAdapter,
  });
  const mode = requestedMode;
  emitReindexProgress(progressEnabled, "loading item corpus");
  const corpus = await loadReindexCorpus({ pmRoot, settings });
  const reindexWarnings = corpus.warnings;
  const { documentCandidates, metadataDocuments } = corpus;
  emitReindexProgress(progressEnabled, `loaded_items=${metadataDocuments.length}`);
  const generatedAt = nowIso();
  const manifest = buildReindexManifest(mode, generatedAt, metadataDocuments);
  const manifestPath = path.join(pmRoot, MANIFEST_PATH);
  const embeddingsPath = path.join(pmRoot, EMBEDDINGS_PATH);

  let documentsForKeywordArtifacts =
    mode === "keyword"
      ? await hydrateDocuments(pmRoot, documentCandidates, settings.schema, reindexWarnings)
      : metadataDocuments;
  const semanticWarnings: string[] = [];
  let vectorizationLedgerEntries: Record<string, string> = {};
  let vectorizationEmbeddingMetadata: VectorizationEmbeddingMetadata | null = null;
  const semanticSummary = createReindexSemanticSummary(mode);
  if (mode === "keyword") {
    await appendKeywordLedgerWarnings({ pmRoot, settings, forceFullSemantic, extensionEmbedding, reindexWarnings });
  }
  if (mode !== "keyword") {
    const semantic = await runSemanticReindex({
      pmRoot,
      settings,
      requestedMode,
      activeEmbeddingProvider: semanticRuntime.activeEmbeddingProvider,
      activeVectorStore: semanticRuntime.activeVectorStore,
      extensionEmbedding,
      extensionVectorAdapter,
      documentCandidates,
      metadataDocuments,
      documentsForKeywordArtifacts,
      forceFullSemantic,
      reindexWarnings,
      semanticWarnings,
      semanticSummary,
      progressEnabled,
    });
    documentsForKeywordArtifacts = semantic.documentsForKeywordArtifacts;
    vectorizationLedgerEntries = semantic.vectorizationLedgerEntries;
    vectorizationEmbeddingMetadata = semantic.vectorizationEmbeddingMetadata;
  }
  const vectorizationWarnings = await writeReindexArtifacts({
    pmRoot,
    mode,
    manifest,
    documentsForKeywordArtifacts,
    settings,
    vectorizationLedgerEntries,
    vectorizationEmbeddingMetadata,
    progressEnabled,
  });
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
      total_items: metadataDocuments.length,
    })),
  ];
  emitReindexProgress(progressEnabled, "done");

  return {
    ok: true,
    mode,
    total_items: metadataDocuments.length,
    semantic: semanticSummary,
    artifacts: {
      manifest: MANIFEST_PATH,
      embeddings: EMBEDDINGS_PATH,
    },
    warnings: [...reindexWarnings, ...semanticWarnings, ...vectorizationWarnings, ...hookWarnings],
    generated_at: generatedAt,
  };
  } finally {
    await releaseReindexLock?.();
  }
}
