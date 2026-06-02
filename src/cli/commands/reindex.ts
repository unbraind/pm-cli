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
import { buildSearchCorpus, buildSemanticCorpusInput } from "../../core/search/corpus.js";
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

export interface ReindexOptions {
  mode?: string;
  progress?: boolean;
}

export interface ReindexResult {
  ok: boolean;
  mode: "keyword" | "semantic" | "hybrid";
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

function buildKeywordRecord(document: ItemDocument, mode: "keyword" | "semantic" | "hybrid"): Record<string, unknown> {
  const item = document.metadata;
  return {
    id: item.id,
    mode,
    updated_at: item.updated_at,
    corpus: buildSearchCorpus(document),
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
  name: string;
  upsert: ExtensionVectorUpsert;
  delete?: ExtensionVectorDelete;
}

interface ReindexEmbeddingExecutionResult {
  vectors: number[][];
  embeddingIdentity: VectorizationEmbeddingIdentity;
}

const toOptionalNonEmptyString = toNonEmptyStringOrUndefined;

function resolveExtensionSearchEmbedding(
  settings: PmSettings,
): { name: string; embedBatch?: ExtensionEmbedBatch; embed?: ExtensionEmbedOne } | null {
  const registrations = getActiveExtensionRegistrations();
  const providerName = toOptionalNonEmptyString(settings.search?.provider);
  const registration = resolveRegisteredSearchProvider(registrations, providerName);
  if (!registration) {
    return null;
  }
  const runtimeDefinition = registration.runtime_definition ?? registration.definition;
  const name =
    toOptionalNonEmptyString((runtimeDefinition as { name?: unknown }).name) ??
    toOptionalNonEmptyString((registration.definition as { name?: unknown }).name) ??
    providerName;
  if (!name) {
    return null;
  }
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
  const registration = resolveRegisteredVectorStoreAdapter(registrations, adapterName);
  if (!registration) {
    return null;
  }
  const runtimeDefinition = registration.runtime_definition ?? registration.definition;
  const name =
    toOptionalNonEmptyString((runtimeDefinition as { name?: unknown }).name) ??
    toOptionalNonEmptyString((registration.definition as { name?: unknown }).name) ??
    adapterName;
  const upsert = (runtimeDefinition as { upsert?: unknown }).upsert;
  const deleteHandler = (runtimeDefinition as { delete?: unknown }).delete;
  if (!name || typeof upsert !== "function") {
    return null;
  }
  return {
    name,
    upsert: upsert as ExtensionVectorUpsert,
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
  const corpusInputs = documents.map((document) => buildSemanticCorpusInput(document, { providerName: semanticProviderName }));
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
          `Extension vector adapter "${extensionVectorAdapter.name}" failed to delete vectors during reindex reset: ${error instanceof Error ? error.message : String(error)}`,
          EXIT_CODE.GENERIC_FAILURE,
        );
      }
    } else if (knownIds.length > 0) {
      semanticWarnings.push(
        `search_semantic_reindex_reset_skipped:adapter=${extensionVectorAdapter.name}:known_ids=${knownIds.length}`,
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
          `Extension vector adapter "${extensionVectorAdapter.name}" failed to delete orphan vectors during reindex: ${error instanceof Error ? error.message : String(error)}`,
          EXIT_CODE.GENERIC_FAILURE,
        );
      }
    } else {
      semanticWarnings.push(
        `search_semantic_reindex_orphan_prune_skipped:adapter=${extensionVectorAdapter.name}:count=${orphanIds.length}`,
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

export async function runReindex(options: ReindexOptions, global: GlobalOptions): Promise<ReindexResult> {
  const requestedMode = parseMode(options.mode);
  const progressEnabled = shouldEmitReindexProgress(options);
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
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const extensionEmbedding = resolveExtensionSearchEmbedding(settings);
  const extensionVectorAdapter = resolveExtensionVectorAdapter(settings);
  let activeEmbeddingProvider: ReturnType<typeof resolveEmbeddingProviders>["active"] = null;
  let activeVectorStore: ReturnType<typeof resolveVectorStores>["active"] = null;
  if (requestedMode !== "keyword") {
    const providerResolution = resolveEmbeddingProviders(settings);
    if (!providerResolution.active && !extensionEmbedding) {
      throw new PmCliError(
        `Reindex mode '${requestedMode}' requires a configured embedding provider in settings.providers.openai/settings.providers.ollama or an extension provider selected by settings.search.provider`,
        EXIT_CODE.USAGE,
      );
    }
    const vectorResolution = resolveVectorStores(settings);
    if (!vectorResolution.active && !extensionVectorAdapter) {
      throw new PmCliError(
        `Reindex mode '${requestedMode}' requires a configured vector store in settings.vector_store.qdrant/settings.vector_store.lancedb or an extension adapter selected by settings.vector_store.adapter`,
        EXIT_CODE.USAGE,
      );
    }
    activeEmbeddingProvider = providerResolution.active;
    activeVectorStore = vectorResolution.active;
  }
  const mode = requestedMode;
  emitReindexProgress(progressEnabled, "loading item corpus");
  const loadedCandidates = await loadDocumentCandidates(pmRoot, settings.item_format, typeRegistry.type_to_folder, settings.schema);
  const reindexWarnings = [...loadedCandidates.warnings];
  const documentCandidates = loadedCandidates.candidates;
  const metadataDocuments: ItemDocument[] = documentCandidates.map((candidate) => ({
    metadata: candidate.metadata,
    body: typeof candidate.body === "string" ? candidate.body : "",
  }));
  emitReindexProgress(progressEnabled, `loaded_items=${metadataDocuments.length}`);
  const generatedAt = nowIso();

  const manifest = {
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

  const manifestPath = path.join(pmRoot, MANIFEST_PATH);
  const embeddingsPath = path.join(pmRoot, EMBEDDINGS_PATH);

  let documentsForKeywordArtifacts =
    mode === "keyword"
      ? await hydrateDocuments(pmRoot, documentCandidates, settings.schema, reindexWarnings)
      : metadataDocuments;
  const semanticWarnings: string[] = [];
  const vectorizationLedgerEntries: Record<string, string> = {};
  let vectorizationEmbeddingMetadata: VectorizationEmbeddingMetadata | null = null;
  const semanticSummary = {
    enabled: mode !== "keyword",
    stale_items: 0,
    unchanged_items: 0,
    embedded_items: 0,
    vector_upserted: 0,
    batches_completed: 0,
  };
  if (mode !== "keyword" && metadataDocuments.length > 0) {
    const ledger = await readVectorizationStatusLedger(pmRoot);
    semanticWarnings.push(...ledger.warnings);
    const embeddingIdentity = resolveReindexEmbeddingIdentity(settings, activeEmbeddingProvider, extensionEmbedding);
    const currentIds = new Set(metadataDocuments.map((document) => document.metadata.id));
    const orphanIds = collectLedgerOrphanIds(ledger.entries, currentIds);
    let resetRequired = hasVectorizationEmbeddingIdentityChanged(ledger.embedding, embeddingIdentity);
    let staleIds = new Set(
      (resetRequired ? metadataDocuments : metadataDocuments.filter((document) => ledger.entries[document.metadata.id] !== document.metadata.updated_at))
        .map((document) => document.metadata.id),
    );
    let staleDocuments = staleIds.size > 0
      ? await hydrateDocuments(pmRoot, documentCandidates, settings.schema, reindexWarnings, staleIds)
      : [];
    let freshDocuments = metadataDocuments.length - staleDocuments.length;
    semanticSummary.stale_items = staleDocuments.length;
    semanticSummary.unchanged_items = freshDocuments;
    for (const document of metadataDocuments) {
      vectorizationLedgerEntries[document.metadata.id] = document.metadata.updated_at;
    }
    if (staleDocuments.length === 0) {
      emitReindexProgress(progressEnabled, `embedding_skipped unchanged_items=${freshDocuments}`);
      semanticWarnings.push(`search_semantic_reindex_skipped_unchanged:count=${freshDocuments}`);
    } else {
      emitReindexProgress(progressEnabled, `embedding_start items=${staleDocuments.length} unchanged_items=${freshDocuments}`);
      let embeddingResult = await executeReindexEmbedding(
        settings,
        requestedMode,
        activeEmbeddingProvider,
        extensionEmbedding,
        staleDocuments,
        semanticWarnings,
        semanticSummary,
        progressEnabled,
      );
      let vectors = embeddingResult.vectors;
      let actualEmbeddingIdentity = embeddingResult.embeddingIdentity;
      let vectorDimension = inferConsistentVectorDimension(vectors, "Reindex embeddings");
      if (
        !resetRequired &&
        (hasVectorizationEmbeddingIdentityChanged(ledger.embedding, actualEmbeddingIdentity) ||
          hasVectorizationVectorDimensionChanged(ledger.embedding, vectorDimension))
      ) {
        resetRequired = true;
        staleIds = new Set(metadataDocuments.map((document) => document.metadata.id));
        staleDocuments = await hydrateDocuments(pmRoot, documentCandidates, settings.schema, reindexWarnings, staleIds);
        freshDocuments = 0;
        semanticSummary.stale_items = staleDocuments.length;
        semanticSummary.unchanged_items = 0;
        emitReindexProgress(progressEnabled, `embedding_dimension_changed reset_items=${staleDocuments.length}`);
        embeddingResult = await executeReindexEmbedding(
          settings,
          requestedMode,
          activeEmbeddingProvider,
          extensionEmbedding,
          staleDocuments,
          semanticWarnings,
          semanticSummary,
          progressEnabled,
        );
        vectors = embeddingResult.vectors;
        actualEmbeddingIdentity = embeddingResult.embeddingIdentity;
        vectorDimension = inferConsistentVectorDimension(vectors, "Reindex embeddings");
      }
      if (resetRequired) {
        emitReindexProgress(progressEnabled, "vector_reset_start");
        await resetVectorStoreForReindex(
          activeVectorStore,
          extensionVectorAdapter,
          ledger.entries,
          settings,
          semanticWarnings,
          ledger.embedding ? vectorDimension : undefined,
        );
        emitReindexProgress(progressEnabled, "vector_reset_complete");
      } else {
        await pruneReindexOrphanVectors(activeVectorStore, extensionVectorAdapter, orphanIds, settings, semanticWarnings);
      }
      vectorizationEmbeddingMetadata = buildVectorizationEmbeddingMetadata(actualEmbeddingIdentity, vectorDimension);
      const points = staleDocuments.map((document, index) => ({
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
      semanticSummary.embedded_items = vectors.length;
      if (extensionVectorAdapter) {
        try {
          emitReindexProgress(progressEnabled, `vector_upsert_start adapter=${extensionVectorAdapter.name} points=${points.length}`);
          await Promise.resolve(
            extensionVectorAdapter.upsert({
              points,
              settings,
            }),
          );
          semanticSummary.vector_upserted = points.length;
          emitReindexProgress(progressEnabled, `vector_upsert_complete adapter=${extensionVectorAdapter.name}`);
        } catch (error: unknown) {
          if (!activeVectorStore) {
            throw new PmCliError(
              `Extension vector adapter "${extensionVectorAdapter.name}" failed to upsert vectors: ${error instanceof Error ? error.message : String(error)}`,
              EXIT_CODE.GENERIC_FAILURE,
            );
          }
          semanticWarnings.push(
            `Extension vector adapter "${extensionVectorAdapter.name}" failed; falling back to built-in vector store (${error instanceof Error ? error.message : String(error)})`,
          );
          emitReindexProgress(progressEnabled, "vector_upsert_fallback built_in_store");
          await executeVectorUpsert(activeVectorStore, points);
          semanticSummary.vector_upserted = points.length;
          emitReindexProgress(progressEnabled, `vector_upsert_complete adapter=${activeVectorStore.name}`);
        }
      } else if (activeVectorStore) {
        emitReindexProgress(progressEnabled, `vector_upsert_start adapter=${activeVectorStore.name} points=${points.length}`);
        await executeVectorUpsert(activeVectorStore, points);
        semanticSummary.vector_upserted = points.length;
        emitReindexProgress(progressEnabled, `vector_upsert_complete adapter=${activeVectorStore.name}`);
      } else {
        throw new PmCliError(
          `No vector upsert executor available for reindex mode '${requestedMode}'`,
          EXIT_CODE.USAGE,
        );
      }
      if (freshDocuments > 0) {
        semanticWarnings.push(`search_semantic_reindex_skipped_unchanged:count=${freshDocuments}`);
      }
      const staleDocumentsById = new Map(staleDocuments.map((document) => [document.metadata.id, document]));
      documentsForKeywordArtifacts = metadataDocuments.map(
        (document) => staleDocumentsById.get(document.metadata.id) ?? document,
      );
    }
    if (staleDocuments.length === 0) {
      await pruneReindexOrphanVectors(activeVectorStore, extensionVectorAdapter, orphanIds, settings, semanticWarnings);
      vectorizationEmbeddingMetadata = ledger.embedding;
    }
  }
  const embeddingsLines = documentsForKeywordArtifacts.map((document) => JSON.stringify(buildKeywordRecord(document, mode))).join("\n");
  emitReindexProgress(progressEnabled, "writing keyword artifacts");
  await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFileAtomic(embeddingsPath, `${embeddingsLines}\n`);
  const vectorizationWarnings: string[] = [];
  if (mode !== "keyword") {
    try {
      emitReindexProgress(progressEnabled, "writing vectorization status ledger");
      await writeVectorizationStatusLedger(pmRoot, vectorizationLedgerEntries, vectorizationEmbeddingMetadata);
    } catch (error: unknown) {
      vectorizationWarnings.push(
        `search_vectorization_status_ledger_write_failed:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
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
