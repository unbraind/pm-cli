/**
 * @module sdk/query/search
 * Coordinates query preparation, corpus filtering, ranking and bounded response assembly.
 */
import {
  getActiveExtensionRegistrations
} from "../../core/extensions/index.js";
import {
  lifecycleClassifierFromStatusRegistry
} from "../../core/governance/metadata-coverage.js";
import { parseStatusFilterCsv } from "../../core/item/status-filter.js";
import {
  resolveItemTypeRegistry,
  type ItemTypeRegistry,
} from "../../core/item/type-registry.js";
import {
  collectRuntimeFilterValues
} from "../../core/schema/runtime-field-filters.js";
import {
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeFieldRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import {
  resolveBm25Params
} from "../../core/search/bm25.js";
import {
  resolveSearchCorpusFields
} from "../../core/search/corpus.js";
import {
  resolveEmbeddingProviders,
  resolveProviderConfigSource,
  type EmbeddingProviderResolution
} from "../../core/search/providers.js";
import {
  resolveQueryExpansionConfig,
  resolveRerankConfig,
  type QueryExpansionConfig,
  type RerankConfig
} from "../../core/search/relevance.js";
import { resolveSettingsWithSemanticRuntimeDefaults } from "../../core/search/semantic-defaults.js";
import {
  resolveVectorStores,
  type VectorStoreResolution
} from "../../core/search/vector-stores.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  nowIso
} from "../../core/shared/time.js";
import {
  resolvePmRoot
} from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type {
  ItemDocument,
  PmSettings
} from "../../types/index.js";
import { assertInitializedTracker } from "../environment/tracker-preflight.js";
import {
  readWorkspaceMemory,
  searchWorkspaceMemoryReadResult
} from "../workspace-memory.js";
import {
  parseSearchProjection,
  parseSearchTokens,
  parseSemanticWeightOverride,
  parseTimestampWindow,
  resolveEffectiveSearchMode,
  resolveHybridSemanticWeight,
  resolveSearchMaxResults,
  resolveSearchScoreThreshold,
  resolveSearchTuning,
  validateSearchProjectionFields,
  type SearchModeSource,
  type SearchOptions,
  type SearchTuning
} from "./search-contracts.js";
import { resolveSearchPage } from "./search-pagination.js";
import {
  buildCompactSearchFilterSummary,
  buildVerboseSearchFilters,
  type SearchMode,
} from "./search-rendering.js";
import { collectLinkedCorpusById,collectLinkedPaths,loadDocuments,loadLinkedCorpus,resolveLinkedCorpusRoots } from "./search/corpus.js";
import { applyExactQueryFilters,applyFilters,collectExactPhraseFields,dependencyEntries,documentContainsExactPhrase,stringArray,textEntries } from "./search/filters.js";
import { applyInlineQueryFilters,assertSearchPagingOptions,parseInlineQueryFilters,prepareSearchInput } from "./search/input.js";
import { buildHitHighlights,buildHybridLexicalScore,countOccurrences,highlightFieldSnippet,markTokenRuns,normalizeScoreMap,scoreDocument,sortHits } from "./search/lexical.js";
import { attachSearchHighlights,buildCountOnlySearchResult,buildEmptySearchResultFromContext,buildSearchResultForHits,emptySearchResult,projectSearchHits,readSearchFieldValue,withSearchWorkspaceMemory } from "./search/response.js";
import type { BuiltInBm25Mode,ExtensionSearchProviderQueryExpansion,ExtensionSearchProviderRerank } from "./search/semantic.js";
import { buildExplicitSemanticFallbackWarning,buildRerankCorpus,buildSemanticHits,classifyImplicitSemanticFallbackReason,collectErrorCauseCodes,combineHybridHits,computeBuiltInBm25Hits,computeSemanticOrHybridHits,maybeEmitVectorIndexStaleWarning,mergeVectorHitsById,normalizeExtensionProviderHits,requireSemanticDependencies,resolveBuiltInBm25Mode,resolveExtensionSearchProvider,resolveExtensionSearchProviderByName,resolveExtensionVectorAdapter,resolveQueryExpansionExtension,resolveRerankExtension,toOptionalNonEmptyString } from "./search/semantic.js";
import type { PreparedSearchInput,SearchHit,SearchResult } from "./search/types.js";

export type {
  SearchDefaultMode,
  SearchMatchMode,
  SearchModeResolution,
  SearchModeSource,
  SearchOptions,
  SearchTuning
} from "./search-contracts.js";

export {
  resolveEffectiveSearchMode,
  resolveHybridSemanticWeight,
  resolveSearchMaxResults,
  resolveSearchScoreThreshold,
  resolveSearchTuning
} from "./search-contracts.js";
export { classifyImplicitSemanticFallbackReason,collectErrorCauseCodes,formatVectorIndexRecoveryWarnings,resolveVectorIndexRecovery } from "./search/semantic.js";
export type { SearchCompactResult,SearchHit,SearchHitHighlight,SearchResult,SearchResultItem,SearchVerboseResult } from "./search/types.js";

/** Public contract for test only search command, shared by SDK and presentation-layer consumers. */
export const _testOnlySearchCommand = {
  applyFilters,
  applyExactQueryFilters,
  applyInlineQueryFilters,
  buildHitHighlights,
  buildVerboseSearchFilters,
  buildExplicitSemanticFallbackWarning,
  buildCompactSearchFilterSummary,
  buildHybridLexicalScore,
  buildRerankCorpus,
  buildSemanticHits,
  classifyImplicitSemanticFallbackReason,
  collectErrorCauseCodes,
  collectExactPhraseFields,
  collectLinkedPaths,
  combineHybridHits,
  computeBuiltInBm25Hits,
  computeSemanticOrHybridHits,
  resolveBuiltInBm25Mode,
  countOccurrences,
  dependencyEntries,
  documentContainsExactPhrase,
  emptySearchResult,
  highlightFieldSnippet,
  loadDocuments,
  markTokenRuns,
  parseInlineQueryFilters,
  maybeEmitVectorIndexStaleWarning,
  loadLinkedCorpus,
  mergeVectorHitsById,
  normalizeExtensionProviderHits,
  normalizeScoreMap,
  parseProjectionConfig: parseSearchProjection,
  parseTimestampWindow,
  parseTokens: parseSearchTokens,
  projectSearchHits,
  readSearchFieldValue,
  requireSemanticDependencies,
  resolveExtensionSearchProvider,
  resolveExtensionSearchProviderByName,
  resolveExtensionVectorAdapter,
  resolveLinkedCorpusRoots,
  scoreDocument,
  sortHits,
  stringArray,
  textEntries,
  validateSearchProjectionFields,
};

interface SearchRuntimeContext {
  pmRoot: string;
  settings: PmSettings;
  statusRegistry: RuntimeStatusRegistry;
  runtimeFieldRegistry: RuntimeFieldRegistry;
  runtimeFieldFilters: Record<string, unknown>;
  typeRegistry: ItemTypeRegistry;
  maxResults: number;
  scoreThreshold: number;
  semanticWeightProvided: boolean;
  semanticWeightOverride: number | undefined;
  hybridSemanticWeight: number;
  tuning: SearchTuning;
  providerResolution: EmbeddingProviderResolution;
  vectorResolution: VectorStoreResolution;
  extensionSearchProvider: ReturnType<typeof resolveExtensionSearchProvider>;
  extensionVectorAdapter: ReturnType<typeof resolveExtensionVectorAdapter>;
  bm25Mode: BuiltInBm25Mode | null;
  queryExpansion: QueryExpansionConfig;
  queryExpansionExtension: {
    providerName: string;
    expand: ExtensionSearchProviderQueryExpansion;
  } | null;
  rerank: RerankConfig;
  rerankExtension: {
    providerName: string;
    rerank: ExtensionSearchProviderRerank;
  } | null;
  effectiveMode: SearchMode;
  modeSource: SearchModeSource;
}

interface FilteredSearchCorpus {
  warnings: string[];
  allDocuments: ItemDocument[];
  filteredDocuments: ItemDocument[];
}

interface SearchModeExecutionInput {
  prepared: PreparedSearchInput;
  runtime: SearchRuntimeContext;
  filteredDocuments: ItemDocument[];
  keywordHits: SearchHit[];
  warnings: string[];
  modeWasExplicit: boolean;
}

interface SearchModeExecutionResult {
  effectiveMode: SearchMode;
  hits: SearchHit[];
}

async function resolveSearchRuntimeContext(
  prepared: PreparedSearchInput,
  global: GlobalOptions,
): Promise<SearchRuntimeContext> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await assertInitializedTracker(pmRoot);
  const storedSettings = await readSettings(pmRoot);
  const settings =
    resolveSettingsWithSemanticRuntimeDefaults(storedSettings).settings;
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const runtimeFieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
  validateSearchProjectionFields(
    prepared.projection,
    runtimeFieldRegistry,
    prepared.query,
  );
  const runtimeFieldFilters = collectRuntimeFilterValues(
    prepared.options as Record<string, unknown>,
    runtimeFieldRegistry,
    "search",
  );
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const providerResolution = resolveEmbeddingProviders(settings);
  const vectorResolution = resolveVectorStores(settings, pmRoot);
  const extensionSearchProvider = resolveExtensionSearchProvider(settings);
  const extensionVectorAdapter = resolveExtensionVectorAdapter(settings);
  const semanticWeightOverride = parseSemanticWeightOverride(
    prepared.options.semanticWeight,
  );
  const queryExpansion = resolveQueryExpansionConfig(
    settings,
    providerResolution.active?.name ?? null,
  );
  const rerank = resolveRerankConfig(
    settings,
    providerResolution.active?.model ??
      toOptionalNonEmptyString(settings.search?.embedding_model) ??
      "text-embedding-3-small",
  );
  return {
    pmRoot,
    settings,
    statusRegistry,
    runtimeFieldRegistry,
    runtimeFieldFilters,
    typeRegistry,
    maxResults: resolveSearchMaxResults(settings),
    scoreThreshold:
      prepared.minScoreOverride ?? resolveSearchScoreThreshold(settings),
    semanticWeightProvided: prepared.options.semanticWeight !== undefined,
    semanticWeightOverride,
    hybridSemanticWeight:
      semanticWeightOverride ?? resolveHybridSemanticWeight(settings),
    tuning: resolveSearchTuning(settings),
    providerResolution,
    vectorResolution,
    extensionSearchProvider,
    extensionVectorAdapter,
    bm25Mode: resolveBuiltInBm25Mode({
      configuredProvider: toOptionalNonEmptyString(settings.search?.provider),
      hasEmbeddingProvider: providerResolution.active !== null,
      hasExtensionSearchProvider: extensionSearchProvider !== null,
    }),
    queryExpansion,
    queryExpansionExtension: resolveQueryExpansionExtension(queryExpansion),
    rerank,
    rerankExtension: resolveRerankExtension(settings),
    ...resolveRuntimeSearchMode({
      requested: prepared.options.mode,
      settings,
      configuredProvider: storedSettings.search?.provider ?? null,
      providerResolution,
      vectorResolution,
      extensionSearchProvider,
      extensionVectorAdapter,
    }),
  };
}

/**
 * Decide the mode for this query. The semantic path counts as runnable only when
 * the stored settings name the active provider themselves (the same
 * `configured` verdict `pm health` reports): auto-detected Ollama/LanceDB
 * runtime defaults keep a bare search on the keyword path so an unconfigured
 * host never pays an embedding round-trip it did not ask for, while a configured
 * and resolvable provider + store (or an extension search provider) makes hybrid
 * the default the moment the index exists.
 */
function resolveRuntimeSearchMode(params: {
  requested: unknown;
  settings: PmSettings;
  configuredProvider: string | null;
  providerResolution: EmbeddingProviderResolution;
  vectorResolution: VectorStoreResolution;
  extensionSearchProvider: ReturnType<typeof resolveExtensionSearchProvider>;
  extensionVectorAdapter: ReturnType<typeof resolveExtensionVectorAdapter>;
}): { effectiveMode: SearchMode; modeSource: SearchModeSource } {
  const providerConfigured =
    resolveProviderConfigSource(
      params.providerResolution.active?.name,
      params.configuredProvider,
    ) === "configured";
  const builtInRunnable =
    providerConfigured &&
    (params.vectorResolution.active !== null ||
      params.extensionVectorAdapter !== null);
  const semanticRunnable =
    params.extensionSearchProvider !== null || builtInRunnable;
  const resolution = resolveEffectiveSearchMode({
    requested: params.requested,
    settings: params.settings,
    semanticRunnable,
  });
  return { effectiveMode: resolution.mode, modeSource: resolution.source };
}

async function loadFilteredSearchCorpus(
  prepared: PreparedSearchInput,
  runtime: SearchRuntimeContext,
): Promise<FilteredSearchCorpus> {
  const loadedDocuments = await loadDocuments(
    runtime.pmRoot,
    runtime.settings.item_format ?? "toon",
    runtime.typeRegistry.type_to_folder,
    runtime.settings.schema,
  );
  const statusFilter = parseStatusFilterCsv(
    typeof prepared.options.status === "string"
      ? prepared.options.status
      : undefined,
    runtime.statusRegistry,
    { strict: true },
  );
  const lifecycleClassifier = lifecycleClassifierFromStatusRegistry(
    runtime.statusRegistry,
  );
  const metadataFilteredDocuments = applyFilters(
    loadedDocuments.documents,
    prepared.options,
    runtime.typeRegistry,
    runtime.runtimeFieldFilters,
    statusFilter,
    lifecycleClassifier,
  );
  return {
    warnings: loadedDocuments.warnings,
    allDocuments: loadedDocuments.documents,
    filteredDocuments: applyExactQueryFilters(
      metadataFilteredDocuments,
      prepared.normalizedQuery,
      {
        titleExact: prepared.titleExact,
        phraseExact: prepared.phraseExact || prepared.matchMode === "exact",
      },
    ),
  };
}

async function computeKeywordSearchHits(
  prepared: PreparedSearchInput,
  runtime: SearchRuntimeContext,
  filteredDocuments: ItemDocument[],
): Promise<SearchHit[]> {
  const linkedCorpusById = await collectLinkedCorpusById(
    prepared.includeLinked,
    runtime.effectiveMode,
    filteredDocuments,
  );
  const applyCoverageBonus = prepared.matchMode === "or";
  return filteredDocuments
    .map((document) =>
      buildHybridLexicalScore(
        document,
        prepared.tokens,
        prepared.normalizedQuery,
        prepared.includeLinked,
        linkedCorpusById,
        runtime.tuning,
        runtime.settings.id_prefix,
        applyCoverageBonus,
      ),
    )
    .filter((entry): entry is SearchHit => entry !== null)
    .filter(
      (entry) =>
        prepared.matchMode !== "and" || entry.matched_all_terms === true,
    );
}

async function executeBuiltInBm25Search(
  prepared: PreparedSearchInput,
  runtime: SearchRuntimeContext,
  filteredDocuments: ItemDocument[],
  keywordHits: SearchHit[],
  warnings: string[],
): Promise<SearchHit[] | null> {
  if (runtime.bm25Mode === null || runtime.effectiveMode === "keyword") {
    return null;
  }
  const hits = computeBuiltInBm25Hits({
    requestedMode: runtime.effectiveMode,
    query: prepared.query,
    filteredDocuments,
    keywordHits,
    corpusFields: resolveSearchCorpusFields(runtime.settings),
    bm25Params: resolveBm25Params(runtime.settings),
    hybridSemanticWeight: runtime.hybridSemanticWeight,
  });
  if (runtime.bm25Mode === "auto-fallback") {
    warnings.push(
      `search_${runtime.effectiveMode}_offline_bm25:no_embedding_provider:using_lexical_bm25`,
    );
  }
  return hits;
}

async function executeExtensionSearchProvider(
  prepared: PreparedSearchInput,
  runtime: SearchRuntimeContext,
  filteredDocuments: ItemDocument[],
  filteredById: Map<string, ItemDocument>,
): Promise<SearchHit[] | null> {
  if (!runtime.extensionSearchProvider) {
    return null;
  }
  const canUseBuiltInSemantic =
    runtime.providerResolution.active !== null &&
    (runtime.vectorResolution.active !== null ||
      runtime.extensionVectorAdapter !== null);
  try {
    const providerResponse = await Promise.resolve(
      runtime.extensionSearchProvider.query({
        query: prepared.query,
        mode: runtime.effectiveMode,
        tokens: prepared.tokens,
        options: prepared.options,
        settings: runtime.settings,
        documents: filteredDocuments,
      }),
    );
    return normalizeExtensionProviderHits(
      runtime.extensionSearchProvider.providerName,
      providerResponse,
      filteredById,
    );
  } catch (error: unknown) {
    if (!canUseBuiltInSemantic) {
      throw new PmCliError(
        `Extension search provider "${runtime.extensionSearchProvider.providerName}" failed: ${error instanceof Error ? error.message : String(error)}`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    return null;
  }
}

function maybeApplyNoVectorFallback(
  effectiveMode: Exclude<SearchMode, "keyword">,
  semanticResult: Awaited<ReturnType<typeof computeSemanticOrHybridHits>>,
  keywordHits: SearchHit[],
  warnings: string[],
): SearchHit[] {
  if (semanticResult.vectorMatchCount > 0) {
    return semanticResult.hits;
  }
  warnings.push(
    `search_${effectiveMode}_degraded:no_vector_matches:results_are_lexical`,
  );
  return effectiveMode === "semantic" ? keywordHits : semanticResult.hits;
}

async function prepareBuiltInSemanticSearch(
  runtime: SearchRuntimeContext,
  effectiveMode: Exclude<SearchMode, "keyword">,
  filteredDocuments: ItemDocument[],
  warnings: string[],
  modeWasExplicit: boolean,
): Promise<void> {
  const builtInSemanticWillRun =
    !runtime.extensionSearchProvider &&
    runtime.providerResolution.active !== null &&
    (runtime.vectorResolution.active !== null ||
      runtime.extensionVectorAdapter !== null);
  if (modeWasExplicit && builtInSemanticWillRun) {
    await maybeEmitVectorIndexStaleWarning(
      runtime.pmRoot,
      filteredDocuments,
      warnings,
    );
  }
  if (!runtime.extensionSearchProvider) {
    requireSemanticDependencies(
      effectiveMode,
      runtime.providerResolution,
      runtime.vectorResolution,
      runtime.extensionVectorAdapter !== null,
    );
  }
}

async function executeSemanticSearch(
  input: SearchModeExecutionInput,
): Promise<SearchModeExecutionResult> {
  const {
    prepared,
    runtime,
    filteredDocuments,
    keywordHits,
    warnings,
    modeWasExplicit,
  } = input;
  let hits = keywordHits;
  const bm25Hits = await executeBuiltInBm25Search(
    prepared,
    runtime,
    filteredDocuments,
    keywordHits,
    warnings,
  );
  const semanticMode = runtime.effectiveMode;
  if (bm25Hits !== null || semanticMode === "keyword") {
    return { effectiveMode: runtime.effectiveMode, hits: bm25Hits ?? hits };
  }
  try {
    await prepareBuiltInSemanticSearch(
      runtime,
      semanticMode,
      filteredDocuments,
      warnings,
      modeWasExplicit,
    );
    if (filteredDocuments.length === 0 || prepared.limit === 0) {
      return { effectiveMode: runtime.effectiveMode, hits: [] };
    }
    const filteredById = new Map(
      filteredDocuments.map((document) => [document.metadata.id, document]),
    );
    hits =
      (await executeExtensionSearchProvider(
        prepared,
        runtime,
        filteredDocuments,
        filteredById,
      )) ?? hits;
    if (hits === keywordHits) {
      const { provider, vectorStore } = requireSemanticDependencies(
        semanticMode,
        runtime.providerResolution,
        runtime.vectorResolution,
        runtime.extensionVectorAdapter !== null,
      );
      const semanticResult = await computeSemanticOrHybridHits({
        requestedMode: semanticMode,
        query: prepared.query,
        filteredDocuments,
        keywordHits,
        hybridSemanticWeight: runtime.hybridSemanticWeight,
        limit: prepared.limit,
        maxResults: runtime.maxResults,
        provider,
        vectorStore,
        extensionVectorAdapter: runtime.extensionVectorAdapter,
        queryExpansion: runtime.queryExpansion,
        queryExpansionExtension: runtime.queryExpansionExtension,
        rerank: runtime.rerank,
        rerankExtension: runtime.rerankExtension,
        warnings,
        settings: runtime.settings,
      });
      hits = maybeApplyNoVectorFallback(
        semanticMode,
        semanticResult,
        keywordHits,
        warnings,
      );
    }
    return { effectiveMode: runtime.effectiveMode, hits };
  } catch (error: unknown) {
    warnings.push(
      buildExplicitSemanticFallbackWarning(runtime.effectiveMode, error),
    );
    return { effectiveMode: "keyword", hits: keywordHits };
  }
}

/** Implements run search for the public runtime surface of this module. */
export async function runSearch(
  rawQuery: string,
  rawOptions: SearchOptions,
  global: GlobalOptions,
): Promise<SearchResult> {
  assertSearchPagingOptions(rawOptions);
  const prepared = prepareSearchInput(rawQuery, rawOptions);
  const runtime = await resolveSearchRuntimeContext(prepared, global);
  const corpus = await loadFilteredSearchCorpus(prepared, runtime);
  const warnings = corpus.warnings;
  warnings.push(...prepared.inlineWarnings);
  const workspaceMemory = await readWorkspaceMemory(
    corpus.allDocuments.map((document) => document.metadata),
    {
      pmRoot: runtime.pmRoot,
      statusRegistry: runtime.statusRegistry,
      now: nowIso(),
    },
  );
  warnings.push(...workspaceMemory.warnings);
  const workspaceMemoryResult = searchWorkspaceMemoryReadResult(
    workspaceMemory,
    prepared.query,
  );
  if (
    runtime.effectiveMode === "hybrid" &&
    runtime.semanticWeightProvided &&
    runtime.semanticWeightOverride === undefined
  ) {
    warnings.push(
      "search_hybrid_semantic_weight_override_invalid:using_settings_default",
    );
  }
  const responseBase = {
    query: prepared.query,
    modeSource: runtime.modeSource,
    matchMode: prepared.matchMode,
    options: prepared.options,
    includeLinked: prepared.includeLinked,
    titleExact: prepared.titleExact,
    phraseExact: prepared.phraseExact,
    scoreThreshold: runtime.scoreThreshold,
    hybridSemanticWeight: runtime.hybridSemanticWeight,
    queryExpansion: runtime.queryExpansion,
    rerank: runtime.rerank,
    projection: prepared.projection,
    warnings,
    runtimeFieldFilters: runtime.runtimeFieldFilters,
  };
  if (
    runtime.effectiveMode === "keyword" &&
    (corpus.filteredDocuments.length === 0 ||
      (prepared.limit === 0 && !prepared.countOnly))
  ) {
    return withSearchWorkspaceMemory(
      buildEmptySearchResultFromContext(
        { ...responseBase, effectiveMode: runtime.effectiveMode },
        prepared.countOnly,
      ),
      workspaceMemoryResult,
    );
  }
  const keywordHits = await computeKeywordSearchHits(
    prepared,
    runtime,
    corpus.filteredDocuments,
  );
  const modeResult = await executeSemanticSearch({
    prepared,
    runtime,
    filteredDocuments: corpus.filteredDocuments,
    keywordHits,
    warnings,
    modeWasExplicit: prepared.modeWasExplicit,
  });
  if (
    modeResult.effectiveMode !== "keyword" &&
    modeResult.hits.length === 0 &&
    (corpus.filteredDocuments.length === 0 ||
      (prepared.limit === 0 && !prepared.countOnly))
  ) {
    return withSearchWorkspaceMemory(
      buildEmptySearchResultFromContext(
        { ...responseBase, effectiveMode: modeResult.effectiveMode },
        prepared.countOnly,
      ),
      workspaceMemoryResult,
    );
  }
  const thresholded = modeResult.hits.filter(
    (entry) =>
      entry.exact_id_match === true || entry.score >= runtime.scoreThreshold,
  );
  const sorted = sortHits(thresholded, runtime.statusRegistry);
  const total = sorted.length;
  const page = resolveSearchPage({
    sorted,
    query: prepared.query,
    mode: modeResult.effectiveMode,
    searchOptions: prepared.options,
    limit: prepared.limit ?? runtime.maxResults,
  });
  const response = { ...responseBase, effectiveMode: modeResult.effectiveMode };
  if (prepared.countOnly) {
    return withSearchWorkspaceMemory(
      buildCountOnlySearchResult(response, total),
      workspaceMemoryResult,
    );
  }
  const { hits: projectedHits, projection: effectiveProjection } =
    attachSearchHighlights(prepared, corpus.filteredDocuments, page.limited);
  const projectedItems = projectSearchHits(projectedHits, effectiveProjection);
  return withSearchWorkspaceMemory(
    buildSearchResultForHits(
      response,
      projectedItems,
      total,
      page.limited.length,
      effectiveProjection,
      page.pageExtras,
    ),
    workspaceMemoryResult,
  );
}
