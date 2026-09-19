/**
 * @module sdk/query/search/semantic
 * Resolves provider hooks, blends vector and lexical scores, and applies expansion and reranking.
 */
import {
  getActiveExtensionRegistrations
} from "../../../core/extensions/index.js";
import {
  resolveRegisteredSearchProvider,
  resolveRegisteredVectorStoreAdapter,
} from "../../../core/extensions/runtime-registrations.js";
import {
  buildBm25Index,
  flattenSearchCorpusText,
  scoreBm25Query,
  tokenizeBm25,
  type Bm25Params
} from "../../../core/search/bm25.js";
import { readVectorizationStatusLedger } from "../../../core/search/cache.js";
import {
  buildSearchCorpus
} from "../../../core/search/corpus.js";
import {
  executeEmbeddingRequest,
  type EmbeddingProviderConfig,
  type EmbeddingProviderResolution
} from "../../../core/search/providers.js";
import {
  buildDeterministicQueryExpansions,
  mergeQueryExpansions,
  normalizeQueryExpansionOutput,
  normalizeRerankOutput,
  rerankCandidatesWithEmbeddings,
  type QueryExpansionConfig,
  type RerankCandidate,
  type RerankConfig
} from "../../../core/search/relevance.js";
import { collectStaleVectorizationIds } from "../../../core/search/staleness.js";
import {
  executeVectorQuery,
  type VectorQueryHit,
  type VectorStoreConfig,
  type VectorStoreResolution
} from "../../../core/search/vector-stores.js";
import { EXIT_CODE } from "../../../core/shared/constants.js";
import { PmCliError } from "../../../core/shared/errors.js";
import { toNonEmptyStringOrUndefined } from "../../../core/shared/primitives.js";
import type {
  ItemDocument,
  PmSettings
} from "../../../types/index.js";
import {
  type SearchOptions
} from "../search-contracts.js";
import {
  type SearchMode
} from "../search-rendering.js";
import { normalizeScoreMap } from "./lexical.js";
import type { SearchHit } from "./types.js";

interface ExtensionSearchProviderContext {
  query: string;
  mode: SearchMode;
  tokens: string[];
  options: SearchOptions;
  settings: PmSettings;
  documents: ItemDocument[];
}

interface ExtensionSearchProviderHit {
  id: string;
  score: number;
  matched_fields?: string[];
}

type ExtensionSearchProviderQuery = (
  context: ExtensionSearchProviderContext,
) =>
  | Promise<
      ExtensionSearchProviderHit[] | { hits?: ExtensionSearchProviderHit[] }
    >
  | ExtensionSearchProviderHit[]
  | { hits?: ExtensionSearchProviderHit[] };

interface ExtensionSearchProviderQueryExpansionContext {
  query: string;
  mode: Exclude<SearchMode, "keyword">;
  settings: PmSettings;
}

/** Optional provider hook used to expand a query before semantic retrieval. */
type ExtensionSearchProviderQueryExpansion = (
  context: ExtensionSearchProviderQueryExpansionContext,
) =>
  | Promise<string[] | { queries?: string[] }>
  | string[]
  | { queries?: string[] };

interface ExtensionSearchProviderRerankCandidate {
  id: string;
  text: string;
  score: number;
}

interface ExtensionSearchProviderRerankContext {
  query: string;
  mode: "hybrid";
  model: string;
  top_k: number;
  settings: PmSettings;
  candidates: ExtensionSearchProviderRerankCandidate[];
}

/** Optional provider hook used to rerank retrieved candidates. */
type ExtensionSearchProviderRerank = (
  context: ExtensionSearchProviderRerankContext,
) =>
  | Promise<
      | Array<{ id?: unknown; score?: unknown }>
      | { hits?: Array<{ id?: unknown; score?: unknown }> }
    >
  | Array<{ id?: unknown; score?: unknown }>
  | { hits?: Array<{ id?: unknown; score?: unknown }> };

type ExtensionVectorQuery = (context: {
  vector: number[];
  limit: number;
  settings: PmSettings;
}) => Promise<VectorQueryHit[]> | VectorQueryHit[];

type ExtensionVectorUpsert = (context: {
  points: Array<{
    id: string;
    vector: number[];
    payload: Record<string, unknown>;
  }>;
  settings: PmSettings;
}) => Promise<void> | void;

type ExtensionVectorAdapter = {
  adapterName: string;
  query?: ExtensionVectorQuery;
  upsert?: ExtensionVectorUpsert;
};

type ImplicitSemanticFallbackReason = "timeout" | "connection" | "error";

/**
 * Aggregate the `code` strings found along an error's `cause` chain.
 *
 * undici (Node's fetch) collapses connection errors to the generic message
 * "fetch failed" and stashes the real syscall code (e.g. `ECONNREFUSED`) on
 * `error.cause.code`. Walking the chain (bounded depth) lets the fallback
 * classifier label a downed/unreachable Ollama backend as "connection" rather
 * than the catch-all "error".
 */
export function collectErrorCauseCodes(error: unknown): string {
  const codes: string[] = [];
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth += 1
  ) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      codes.push(code.toLowerCase());
    }
    current = (current as { cause?: unknown }).cause;
  }
  return codes.join(" ");
}

/**
 * Classify why an implicit/explicit semantic search degraded to keyword mode,
 * inspecting both the error message and the {@link collectErrorCauseCodes} chain
 * so undici's generic "fetch failed" is recognised as a connection failure.
 */
export function classifyImplicitSemanticFallbackReason(
  error: unknown,
): ImplicitSemanticFallbackReason {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  const causeCodes = collectErrorCauseCodes(error);
  const haystack = `${message} ${causeCodes}`;
  if (
    haystack.includes("timed out") ||
    haystack.includes("timeout") ||
    haystack.includes("etimedout")
  ) {
    return "timeout";
  }
  if (
    haystack.includes("econnrefused") ||
    haystack.includes("connection refused") ||
    haystack.includes("connect ") ||
    haystack.includes("enotfound") ||
    haystack.includes("eai_again") ||
    haystack.includes("econnreset") ||
    haystack.includes("fetch failed")
  ) {
    return "connection";
  }
  return "error";
}

// Explicit --semantic/--hybrid searches must never hard-fail an agent when the
// embedding/vector backend is unreachable or unconfigured: degrade to keyword
// search and surface a machine-readable warning instead of an unknown_error.
/** Describe why an explicitly requested semantic mode fell back to keyword retrieval. */
function buildExplicitSemanticFallbackWarning(
  requestedMode: SearchMode,
  error: unknown,
): string {
  const reason = classifyImplicitSemanticFallbackReason(error);
  return `search_${requestedMode}_fallback:${reason}:using_keyword_mode`;
}

interface VectorIndexRecoveryRegistrations {
  commands?: readonly { command: string }[];
}

interface VectorIndexRecovery {
  command: string;
  args: string[];
  follow_up_command?: string;
  follow_up_args?: string[];
}

/** Resolve an executable reindex path from the active extension capability surface. */
export function resolveVectorIndexRecovery(
  registrations: VectorIndexRecoveryRegistrations | null,
): VectorIndexRecovery {
  const hasReindex =
    registrations?.commands?.some(
      (registration) => registration.command.trim() === "reindex",
    ) === true;
  return hasReindex
    ? {
        command: "pm reindex --mode hybrid",
        args: ["reindex", "--mode", "hybrid"],
      }
    : {
        command: "pm install search-advanced --project",
        args: ["install", "search-advanced", "--project"],
        follow_up_command: "pm reindex --mode hybrid",
        follow_up_args: ["reindex", "--mode", "hybrid"],
      };
}

/** Compare the vectorization-status ledger against the filtered corpus and, when the vector index is behind, emit a one-line stderr warning plus a structured `vector_index_stale:N` entry in the JSON warnings array. Best-effort: ledger read failures fall through silently — the existing semantic/hybrid fallback paths cover backend errors. */
async function maybeEmitVectorIndexStaleWarning(
  pmRoot: string,
  filteredDocuments: ItemDocument[],
  warnings: string[],
): Promise<void> {
  try {
    const ledger = await readVectorizationStatusLedger(pmRoot);
    if (ledger.warnings.length > 0) {
      warnings.push(...ledger.warnings);
    }
    const staleIds = collectStaleVectorizationIds(
      filteredDocuments.map((document) => ({
        id: document.metadata.id,
        updated_at: document.metadata.updated_at,
      })),
      ledger.entries,
    );
    if (staleIds.length === 0) {
      return;
    }
    const recovery = resolveVectorIndexRecovery(
      getActiveExtensionRegistrations(),
    );
    warnings.push(...formatVectorIndexRecoveryWarnings(staleIds.length, recovery));
    /* c8 ignore start -- singular/plural warning text branches are cosmetic and validated in integration UX tests */
    process.stderr.write(
      `[pm] warning: ${staleIds.length} item${staleIds.length === 1 ? " is" : "s are"} new or modified since the last reindex and ${staleIds.length === 1 ? "is" : "are"} NOT in the semantic index yet — run '${recovery.command}'${recovery.follow_up_command ? `, then '${recovery.follow_up_command}'` : ""}. (Write-time embedding is governed by search.mutation_refresh_policy; staleness means the embed was skipped, failed, or the backend was unreachable.)\n`,
    );
    /* c8 ignore stop */
  } catch {
    // Best-effort: missing/unreadable ledger is not a query-blocking concern.
  }
}

/** Format token-efficient vector-index staleness and executable recovery warnings. */
export function formatVectorIndexRecoveryWarnings(
  staleCount: number,
  recovery: VectorIndexRecovery,
): string[] {
  return [
    `vector_index_stale:${staleCount}`,
    `vector_index_recovery:${recovery.args.join(" ")}`,
    ...(recovery.follow_up_args
      ? [`vector_index_recovery_follow_up:${recovery.follow_up_args.join(" ")}`]
      : []),
  ];
}

/** Resolve the configured semantic provider and vector-store dependencies or report their absence. */
function requireSemanticDependencies(
  requestedMode: Exclude<SearchMode, "keyword">,
  providerResolution: EmbeddingProviderResolution,
  vectorResolution: VectorStoreResolution,
  hasExtensionVectorQuery: boolean,
): {
  provider: EmbeddingProviderConfig;
  vectorStore: VectorStoreConfig | null;
} {
  if (!providerResolution.active) {
    throw new PmCliError(
      `Search mode '${requestedMode}' requires a configured embedding provider in settings.providers.openai or settings.providers.ollama`,
      EXIT_CODE.USAGE,
    );
  }
  if (!vectorResolution.active && !hasExtensionVectorQuery) {
    throw new PmCliError(
      `Search mode '${requestedMode}' requires a configured vector store in settings.vector_store.qdrant/settings.vector_store.lancedb or an extension adapter selected by settings.vector_store.adapter`,
      EXIT_CODE.USAGE,
    );
  }
  return {
    provider: providerResolution.active,
    vectorStore: vectorResolution.active ?? null,
  };
}

/** Normalize optional provider identifiers to trimmed non-empty strings. */
const toOptionalNonEmptyString = toNonEmptyStringOrUndefined;

interface ExtensionSearchProviderHooks {
  providerName: string;
  query?: ExtensionSearchProviderQuery;
  queryExpansion?: ExtensionSearchProviderQueryExpansion;
  rerank?: ExtensionSearchProviderRerank;
}

/* c8 ignore start */

/** Find an active extension search provider by its declared name. */
function resolveExtensionSearchProviderByName(
  providerName: string | undefined,
): ExtensionSearchProviderHooks | null {
  const registrations = getActiveExtensionRegistrations();
  const resolved = resolveRegisteredSearchProvider(registrations, providerName);
  if (!resolved) {
    return null;
  }
  const runtimeDefinition = resolved.runtime_definition ?? resolved.definition;
  const query = (runtimeDefinition as { query?: unknown }).query;
  const queryExpansion =
    (
      runtimeDefinition as {
        queryExpansion?: unknown;
        query_expansion?: unknown;
      }
    ).queryExpansion ??
    (
      runtimeDefinition as {
        queryExpansion?: unknown;
        query_expansion?: unknown;
      }
    ).query_expansion;
  const rerank = (runtimeDefinition as { rerank?: unknown }).rerank;
  const registeredName =
    toOptionalNonEmptyString((runtimeDefinition as { name?: unknown }).name) ??
    toOptionalNonEmptyString(
      (resolved.definition as { name?: unknown }).name,
    ) ??
    providerName;
  /* c8 ignore next 2 -- providerName is required for lookup and remains a non-empty fallback */
  if (!registeredName) {
    return null;
  }
  const hooks: ExtensionSearchProviderHooks = {
    providerName: registeredName,
    ...(typeof query === "function"
      ? { query: query as ExtensionSearchProviderQuery }
      : {}),
    ...(typeof queryExpansion === "function"
      ? {
          queryExpansion:
            queryExpansion as ExtensionSearchProviderQueryExpansion,
        }
      : {}),
    ...(typeof rerank === "function"
      ? { rerank: rerank as ExtensionSearchProviderRerank }
      : {}),
  };
  if (!hooks.query && !hooks.queryExpansion && !hooks.rerank) {
    return null;
  }
  return hooks;
}

/* c8 ignore stop */

/** Resolve the configured extension-owned search provider. */
function resolveExtensionSearchProvider(
  settings: PmSettings,
): { providerName: string; query: ExtensionSearchProviderQuery } | null {
  const providerName = toOptionalNonEmptyString(
    (settings.search as { provider?: unknown } | undefined)?.provider,
  );
  const resolved = resolveExtensionSearchProviderByName(providerName);
  if (!resolved?.query) {
    return null;
  }
  return {
    providerName: resolved.providerName,
    query: resolved.query,
  };
}

/* c8 ignore start */

/** Resolve the configured extension-owned vector-store adapter. */
function resolveExtensionVectorAdapter(
  settings: PmSettings,
): ExtensionVectorAdapter | null {
  const registrations = getActiveExtensionRegistrations();
  const adapterName = toOptionalNonEmptyString(
    (settings.vector_store as { adapter?: unknown } | undefined)?.adapter,
  );
  const resolved = resolveRegisteredVectorStoreAdapter(
    registrations,
    adapterName,
  );
  if (!resolved) {
    return null;
  }
  const runtimeDefinition = resolved.runtime_definition ?? resolved.definition;
  const query = (runtimeDefinition as { query?: unknown }).query;
  if (typeof query !== "function") {
    return null;
  }
  const upsert = (runtimeDefinition as { upsert?: unknown }).upsert;
  const runtimeAdapterName =
    toOptionalNonEmptyString((runtimeDefinition as { name?: unknown }).name) ??
    toOptionalNonEmptyString(
      (resolved.definition as { name?: unknown }).name,
    ) ??
    adapterName ??
    "extension";
  return {
    adapterName: runtimeAdapterName,
    query: query as ExtensionVectorQuery,
    ...(typeof upsert === "function"
      ? { upsert: upsert as ExtensionVectorUpsert }
      : {}),
  };
}

/* c8 ignore stop */

/** Normalize extension retrieval results to item IDs and numeric scores. */
function normalizeExtensionProviderHits(
  providerName: string,
  raw: unknown,
  filteredById: Map<string, ItemDocument>,
): SearchHit[] {
  const rawHits = Array.isArray(raw)
    ? raw
    : (raw as { hits?: unknown } | null | undefined)?.hits;
  if (!Array.isArray(rawHits)) {
    throw new PmCliError(
      `Extension search provider "${providerName}" must return an array of hits or { hits: [...] }`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }

  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const rawHit of rawHits) {
    if (typeof rawHit !== "object" || rawHit === null) {
      continue;
    }
    const id = toOptionalNonEmptyString((rawHit as { id?: unknown }).id);
    const score = (rawHit as { score?: unknown }).score;
    if (
      !id ||
      typeof score !== "number" ||
      !Number.isFinite(score) ||
      seen.has(id)
    ) {
      continue;
    }
    const document = filteredById.get(id);
    if (!document) {
      continue;
    }
    const matchedFieldsRaw = (rawHit as { matched_fields?: unknown })
      .matched_fields;
    const matchedFields =
      Array.isArray(matchedFieldsRaw) &&
      matchedFieldsRaw.every((entry) => typeof entry === "string")
        ? [
            ...new Set(
              (matchedFieldsRaw as string[])
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0),
            ),
          ].sort((a, b) => a.localeCompare(b))
        : [`provider:${providerName}`];
    seen.add(id);
    hits.push({
      item: document.metadata,
      score,
      matched_fields: matchedFields,
    });
  }
  return hits;
}

/** Join semantic scores to the filtered item corpus. */
function buildSemanticHits(
  vectorHits: VectorQueryHit[],
  filteredById: Map<string, ItemDocument>,
): { semanticHits: SearchHit[]; semanticScores: Map<string, number> } {
  const semanticHits: SearchHit[] = [];
  const semanticScores = new Map<string, number>();
  for (const vectorHit of vectorHits) {
    if (semanticScores.has(vectorHit.id)) {
      continue;
    }
    const document = filteredById.get(vectorHit.id);
    if (!document) {
      continue;
    }
    semanticScores.set(vectorHit.id, vectorHit.score);
    semanticHits.push({
      item: document.metadata,
      score: vectorHit.score,
      matched_fields: ["semantic"],
    });
  }
  return {
    semanticHits,
    semanticScores,
  };
}

// GH-281: in semantic & hybrid mode the blended/vector scores live on an
// arbitrary scale (blended hybrid scores are [0,1]; raw vector similarities are
// provider-defined), so an exact full-ID or short-ID keyword match can be
// out-ranked by a high-semantic body mention. This reattaches the exact-ID
// keyword hit(s) to the top of the ranked set in a reserved band ABOVE every
// other hit, preserving matched_fields:["id"] and keeping full-ID above
// short-ID. The reserved scores are derived from the current max so the
// guarantee holds no matter what scale the backend returns, and the hit is
// re-inserted even if it was dropped from `rankedHits` (e.g. it had no semantic
// vector match) so it is never lost to the threshold or the result-limit slice.
/** Promote full and short ID matches above all other hits while retaining their relative exact-match priority. */
function forceExactIdHitsToTop(
  rankedHits: SearchHit[],
  keywordHits: SearchHit[],
): SearchHit[] {
  const exactIdHits = keywordHits.filter((hit) => hit.exact_id_match === true);
  if (exactIdHits.length === 0) {
    return rankedHits;
  }
  const exactIdIds = new Set(exactIdHits.map((hit) => hit.item.id));
  const remaining = rankedHits.filter((hit) => !exactIdIds.has(hit.item.id));
  // reduce (not Math.max(...spread)) so a very large pre-truncation candidate
  // set can never overflow the call stack.
  const maxRemainingScore = remaining.reduce(
    (max, hit) => Math.max(max, hit.score),
    0,
  );
  // Full-ID hits (score 1000) must rank above short-ID hits (score 900): rank
  // within the exact-ID band by the original keyword score (descending) so a
  // full-ID match always precedes a short-ID match for the same query, then
  // offset the whole band above every remaining hit. ids are unique, so two
  // exact-ID hits can never tie on score — sorting on score alone is total.
  // exactIdHits is already a fresh array from keywordHits.filter(...), so sort
  // it in place — no defensive copy needed.
  const orderedExactHits = exactIdHits.sort(
    (left, right) => right.score - left.score,
  );
  const bandBase = maxRemainingScore + orderedExactHits.length + 1;
  const promoted = orderedExactHits.map((hit, index) => ({
    // Spread the original keyword hit so flags like matched_all_terms /
    // exact_id_match are preserved; only the band-slot score and the id-only
    // matched_fields are overridden.
    ...hit,
    // Higher band slot for earlier (higher original keyword score) hits.
    score: bandBase - index,
    matched_fields: ["id"],
  }));
  return [...promoted, ...remaining];
}

/** Blend lexical and semantic results while preserving exact-ID precedence. */
function combineHybridHits(
  filteredById: Map<string, ItemDocument>,
  semanticScores: Map<string, number>,
  keywordHits: SearchHit[],
  hybridSemanticWeight: number,
  // Matched-field label for the dense-ranking component. Defaults to "semantic"
  // (vector retrieval); the offline BM25 hybrid path passes "bm25" so hits carry
  // an honest provenance marker instead of implying a vector match (pm-75k9).
  semanticFieldLabel = "semantic",
): SearchHit[] {
  const keywordScores = new Map(
    keywordHits.map((entry) => [entry.item.id, entry.score]),
  );
  const keywordMatches = new Map(
    keywordHits.map((entry) => [entry.item.id, entry.matched_fields]),
  );
  const normalizedSemantic = normalizeScoreMap(semanticScores);
  const normalizedKeyword = normalizeScoreMap(keywordScores);
  const candidateIds = new Set<string>([
    ...semanticScores.keys(),
    ...keywordScores.keys(),
  ]);
  const keywordWeight = 1 - hybridSemanticWeight;
  return [...candidateIds]
    .map((id) => {
      const document = filteredById.get(id)!;
      const semanticScore = normalizedSemantic.get(id) ?? 0;
      const keywordScore = normalizedKeyword.get(id) ?? 0;
      const combinedScore =
        semanticScore * hybridSemanticWeight + keywordScore * keywordWeight;
      if (combinedScore <= 0) {
        return null;
      }
      const matchedFields = new Set<string>();
      if (semanticScores.has(id)) {
        matchedFields.add(semanticFieldLabel);
      }
      for (const field of keywordMatches.get(id) ?? []) {
        matchedFields.add(field);
      }
      return {
        item: document.metadata,
        score: combinedScore,
        matched_fields: [...matchedFields].sort((a, b) => a.localeCompare(b)),
      };
    })
    .filter((entry): entry is SearchHit => entry !== null);
}

/** Built-in BM25 activation outcome for semantic/hybrid search (pm-75k9): - `"explicit"`: `search.provider` is `bm25` — the user opted into offline lexical ranking, so it is used even if an embedding provider is configured. - `"auto-fallback"`: `search.provider` is `auto` and neither an embedding provider nor an extension search provider is available — BM25 is used in place of degrading to the naive field-weighted keyword scorer. - `null`: BM25 does not apply; the existing embedding/extension path runs. */
type BuiltInBm25Mode = "explicit" | "auto-fallback";

/** Select the built-in BM25 path from effective search settings. */
function resolveBuiltInBm25Mode(params: {
  configuredProvider: string | undefined;
  hasEmbeddingProvider: boolean;
  hasExtensionSearchProvider: boolean;
}): BuiltInBm25Mode | null {
  const normalized = params.configuredProvider?.trim().toLowerCase();
  if (normalized === "bm25") {
    return "explicit";
  }
  if (
    normalized === "auto" &&
    !params.hasEmbeddingProvider &&
    !params.hasExtensionSearchProvider
  ) {
    return "auto-fallback";
  }
  return null;
}

/**
 * Rank the filtered corpus with the offline BM25 provider (pm-75k9). Builds a
 * BM25 index over each document's resolved search corpus (honoring
 * `search.corpus_fields`), scores the query, and shapes hits for the requested
 * mode: semantic mode returns pure BM25-ranked hits tagged
 * `matched_fields: ["bm25"]`, while hybrid mode blends the BM25 scores with the
 * locally computed keyword scores via {@link combineHybridHits}. The exact
 * full-ID / short-ID guarantee is preserved in both modes via
 * {@link forceExactIdHitsToTop}. No network, embedding service, or vector store
 * is involved, so this path cannot fail on a backend error.
 */
function computeBuiltInBm25Hits(params: {
  requestedMode: Exclude<SearchMode, "keyword">;
  query: string;
  filteredDocuments: ItemDocument[];
  keywordHits: SearchHit[];
  corpusFields: string[];
  bm25Params: Bm25Params;
  hybridSemanticWeight: number;
}): SearchHit[] {
  const bm25Documents = params.filteredDocuments.map((document) => ({
    id: document.metadata.id,
    text: flattenSearchCorpusText(
      buildSearchCorpus(document, { fields: params.corpusFields }),
    ),
  }));
  const index = buildBm25Index(bm25Documents);
  const bm25Scores = scoreBm25Query(
    index,
    tokenizeBm25(params.query),
    params.bm25Params,
  );
  const filteredById = new Map(
    params.filteredDocuments.map((document) => [
      document.metadata.id,
      document,
    ]),
  );
  if (params.requestedMode === "semantic") {
    const semanticHits: SearchHit[] = [...bm25Scores].map(([id, score]) => ({
      item: filteredById.get(id)!.metadata,
      score,
      matched_fields: ["bm25"],
    }));
    return forceExactIdHitsToTop(semanticHits, params.keywordHits);
  }
  const hybridHits = combineHybridHits(
    filteredById,
    bm25Scores,
    params.keywordHits,
    params.hybridSemanticWeight,
    "bm25",
  );
  return forceExactIdHitsToTop(hybridHits, params.keywordHits);
}

interface SemanticQueryContext {
  requestedMode: Exclude<SearchMode, "keyword">;
  query: string;
  filteredDocuments: ItemDocument[];
  keywordHits: SearchHit[];
  hybridSemanticWeight: number;
  limit: number | undefined;
  maxResults: number;
  provider: EmbeddingProviderConfig;
  vectorStore: VectorStoreConfig | null;
  extensionVectorAdapter: ExtensionVectorAdapter | null;
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
  warnings: string[];
  settings: PmSettings;
  embeddingTimeoutMs?: number;
  vectorQueryTimeoutMs?: number;
}

interface SemanticQueryResult {
  hits: SearchHit[];
  // Number of documents returned by the vector stage for this query after the
  // current metadata filters. When this is 0 the semantic/hybrid query ran
  // successfully, but vector ranking contributed nothing to the returned hits.
  vectorMatchCount: number;
}

/** Merge vector retrieval batches by item ID for query expansion. */
function mergeVectorHitsById(
  vectorHitGroups: VectorQueryHit[][],
): VectorQueryHit[] {
  const bestById = new Map<string, VectorQueryHit>();
  for (const group of vectorHitGroups) {
    for (const hit of group) {
      const existing = bestById.get(hit.id);
      if (!existing || hit.score > existing.score) {
        bestById.set(hit.id, hit);
      }
    }
  }
  const merged = [...bestById.values()];
  merged.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.id.localeCompare(right.id);
  });
  return merged;
}

/* c8 ignore start */

/** Build the candidate text corpus supplied to reranking providers. */
function buildRerankCorpus(document: ItemDocument): string {
  const metadata = (document as { metadata?: ItemDocument["metadata"] | null })
    .metadata;
  const tags = Array.isArray(metadata?.tags) ? metadata.tags.join(" ") : "";
  return [
    metadata?.title,
    metadata?.description,
    metadata?.type,
    metadata?.status,
    tags,
    document.body,
  ]
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0)
    .join("\n");
}

/** Merge deterministic and extension query expansions within the configured budget, falling back with warnings on provider failure. */
async function resolveExpandedSemanticQueries(
  context: SemanticQueryContext,
  queryTrimmed: string,
): Promise<string[]> {
  const baseExpandedQueries = context.queryExpansion.enabled
    ? buildDeterministicQueryExpansions(
        queryTrimmed,
        context.queryExpansion.max_queries,
      )
    : [queryTrimmed];
  const expandedQueries =
    baseExpandedQueries.length > 0 ? baseExpandedQueries : [queryTrimmed];
  if (!context.queryExpansion.enabled) {
    return expandedQueries;
  }
  if (context.queryExpansionExtension?.expand) {
    try {
      const rawExpansion = await Promise.resolve(
        context.queryExpansionExtension.expand({
          query: queryTrimmed,
          mode: context.requestedMode,
          settings: context.settings,
        }),
      );
      return mergeQueryExpansions(
        expandedQueries,
        normalizeQueryExpansionOutput(rawExpansion),
        context.queryExpansion.max_queries,
      );
    } catch {
      context.warnings.push(
        `search_query_expansion_provider_failed:${context.queryExpansionExtension.providerName}:using_builtin`,
      );
      return expandedQueries;
    }
  }
  if (
    context.queryExpansion.provider &&
    context.queryExpansion.provider !== "openai" &&
    context.queryExpansion.provider !== "ollama"
  ) {
    context.warnings.push(
      `search_query_expansion_provider_unavailable:${context.queryExpansion.provider}:using_builtin`,
    );
  }
  return expandedQueries;
}

/** Query the selected extension vector adapter with built-in fallback, or fail explicitly when no usable store exists. */
async function executeSemanticVectorQuery(
  context: SemanticQueryContext,
  semanticVector: number[],
  semanticLimit: number,
  vectorQueryOptions: { timeout_ms?: number },
): Promise<VectorQueryHit[]> {
  if (context.extensionVectorAdapter?.query) {
    try {
      return await Promise.resolve(
        context.extensionVectorAdapter.query({
          vector: semanticVector,
          limit: semanticLimit,
          settings: context.settings,
        }),
      );
    } catch (error: unknown) {
      if (!context.vectorStore) {
        throw new PmCliError(
          `Extension vector adapter query failed and no built-in fallback store is configured (${error instanceof Error ? error.message : String(error)})`,
          EXIT_CODE.GENERIC_FAILURE,
        );
      }
      context.warnings.push(
        `search_vector_adapter_failed:${context.extensionVectorAdapter.adapterName}:using_builtin`,
      );
      return await executeVectorQuery(
        context.vectorStore,
        semanticVector,
        semanticLimit,
        vectorQueryOptions,
      );
    }
  }
  if (context.vectorStore) {
    return await executeVectorQuery(
      context.vectorStore,
      semanticVector,
      semanticLimit,
      vectorQueryOptions,
    );
  }
  throw new PmCliError(
    "Semantic search requires either a configured vector store or an extension vector adapter query handler",
    EXIT_CODE.USAGE,
  );
}

/** Select the highest-ranked candidates up to the rerank limit and associate each with its searchable document text. */
function buildRerankCandidateContexts(
  hybridHits: SearchHit[],
  filteredById: Map<string, ItemDocument>,
  topK: number,
): Array<{ hit: SearchHit; text: string }> {
  const sortedForCandidates = [...hybridHits].sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.item.id.localeCompare(right.item.id);
  });
  return sortedForCandidates
    .slice(0, topK)
    .map((hit) => {
      const document = filteredById.get(hit.item.id);
      return document ? { hit, text: buildRerankCorpus(document) } : null;
    })
    .filter(
      (entry): entry is { hit: SearchHit; text: string } => entry !== null,
    );
}

/** Invoke an extension reranker and normalize its scores while converting provider failures into search warnings. */
async function resolveExtensionRerankScores(
  context: SemanticQueryContext,
  queryTrimmed: string,
  candidateContexts: Array<{ hit: SearchHit; text: string }>,
): Promise<Map<string, number> | null> {
  if (!context.rerankExtension?.rerank) {
    return null;
  }
  try {
    const rawRerank = await Promise.resolve(
      context.rerankExtension.rerank({
        query: queryTrimmed,
        mode: "hybrid",
        model: context.rerank.model,
        top_k: context.rerank.top_k,
        settings: context.settings,
        candidates: candidateContexts.map((entry) => ({
          id: entry.hit.item.id,
          text: entry.text,
          score: entry.hit.score,
        })),
      }),
    );
    const normalizedRerank = normalizeRerankOutput(rawRerank);
    if (normalizedRerank.length > 0) {
      return new Map(normalizedRerank.map((entry) => [entry.id, entry.score]));
    }
    context.warnings.push(
      `search_rerank_provider_invalid_response:${context.rerankExtension.providerName}:using_builtin`,
    );
    return null;
  } catch {
    context.warnings.push(
      `search_rerank_provider_failed:${context.rerankExtension.providerName}:using_builtin`,
    );
    return null;
  }
}

/** Resolve reranking through the configured extension or built-in provider and preserve graceful fallback behavior. */
async function resolveRerankScores(
  context: SemanticQueryContext,
  queryTrimmed: string,
  candidateContexts: Array<{ hit: SearchHit; text: string }>,
): Promise<Map<string, number> | null> {
  const extensionScores = await resolveExtensionRerankScores(
    context,
    queryTrimmed,
    candidateContexts,
  );
  if (extensionScores) {
    return extensionScores;
  }
  const rerankCandidates: RerankCandidate[] = candidateContexts.map(
    (entry) => ({
      id: entry.hit.item.id,
      text: entry.text,
    }),
  );
  try {
    return await rerankCandidatesWithEmbeddings(
      context.provider,
      context.rerank.model,
      queryTrimmed,
      rerankCandidates,
      context.embeddingTimeoutMs,
    );
  } catch {
    context.warnings.push("search_rerank_failed:using_hybrid_scores");
    return null;
  }
}

/** Apply available rerank scores and deterministically order reranked hits before candidates without replacement scores. */
function applyRerankScores(
  hybridHits: SearchHit[],
  rerankScores: Map<string, number>,
): SearchHit[] {
  const rerankedIds = new Set(rerankScores.keys());
  const rerankedHits = hybridHits.map((hit) => {
    const rerankScore = rerankScores.get(hit.item.id);
    if (rerankScore === undefined) {
      return hit;
    }
    const matchedFields = new Set(hit.matched_fields);
    matchedFields.add("rerank");
    return {
      ...hit,
      score: rerankScore,
      matched_fields: [...matchedFields].sort((left, right) =>
        left.localeCompare(right),
      ),
    };
  });
  rerankedHits.sort((left, right) => {
    const leftWasReranked = rerankedIds.has(left.item.id);
    const rightWasReranked = rerankedIds.has(right.item.id);
    if (leftWasReranked !== rightWasReranked) {
      return leftWasReranked ? -1 : 1;
    }
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.item.id.localeCompare(right.item.id);
  });
  return rerankedHits;
}

/** Rerank eligible hybrid candidates when enabled and retain the original hits when no usable scores are returned. */
async function applyHybridRerank(
  context: SemanticQueryContext,
  queryTrimmed: string,
  hybridHits: SearchHit[],
  filteredById: Map<string, ItemDocument>,
): Promise<SearchHit[]> {
  if (!context.rerank.enabled || hybridHits.length <= 1) {
    return hybridHits;
  }
  const candidateContexts = buildRerankCandidateContexts(
    hybridHits,
    filteredById,
    context.rerank.top_k,
  );
  const rerankScores = await resolveRerankScores(
    context,
    queryTrimmed,
    candidateContexts,
  );
  return rerankScores && rerankScores.size > 0
    ? applyRerankScores(hybridHits, rerankScores)
    : hybridHits;
}

/** Execute provider retrieval and ranking with the existing fallback and warning contracts. */
async function computeSemanticOrHybridHits(
  context: SemanticQueryContext,
): Promise<SemanticQueryResult> {
  const semanticLimit = Math.max(
    context.limit ?? context.maxResults,
    context.maxResults,
  );
  const embeddingOptions =
    context.embeddingTimeoutMs !== undefined
      ? { timeout_ms: context.embeddingTimeoutMs }
      : {};
  const vectorQueryOptions =
    context.vectorQueryTimeoutMs !== undefined
      ? { timeout_ms: context.vectorQueryTimeoutMs }
      : {};
  const queryTrimmed = context.query.trim();
  const expandedQueries = await resolveExpandedSemanticQueries(
    context,
    queryTrimmed,
  );
  const queryVectors = await executeEmbeddingRequest(
    context.provider,
    expandedQueries,
    embeddingOptions,
  );
  const queryVectorGroups = await Promise.all(
    queryVectors.map(
      async (semanticVector) =>
        await executeSemanticVectorQuery(
          context,
          semanticVector,
          semanticLimit,
          vectorQueryOptions,
        ),
    ),
  );
  const vectorHits = mergeVectorHitsById(queryVectorGroups);
  const filteredById = new Map(
    context.filteredDocuments.map((document) => [
      document.metadata.id,
      document,
    ]),
  );
  const { semanticHits, semanticScores } = buildSemanticHits(
    vectorHits,
    filteredById,
  );
  const vectorMatchCount = semanticScores.size;
  if (context.requestedMode === "semantic") {
    // GH-281: guarantee an exact full-ID / short-ID match ranks #1 even in pure
    // semantic mode, where it otherwise carries no vector hit at all.
    return {
      hits: forceExactIdHitsToTop(semanticHits, context.keywordHits),
      vectorMatchCount,
    };
  }
  const hybridHits = await applyHybridRerank(
    context,
    queryTrimmed,
    combineHybridHits(
      filteredById,
      semanticScores,
      context.keywordHits,
      context.hybridSemanticWeight,
    ),
    filteredById,
  );
  return {
    // GH-281: applied LAST (after any rerank reordering) so an exact full-ID /
    // short-ID keyword match always ranks #1 in hybrid mode regardless of the
    // semantic blend weight or rerank scores.
    hits: forceExactIdHitsToTop(hybridHits, context.keywordHits),
    vectorMatchCount,
  };
}

/* c8 ignore stop */

/** Resolve the active provider implementation for configured query expansion. */
function resolveQueryExpansionExtension(queryExpansion: QueryExpansionConfig): {
  providerName: string;
  expand: ExtensionSearchProviderQueryExpansion;
} | null {
  const provider = resolveExtensionSearchProviderByName(
    queryExpansion.provider ?? undefined,
  );
  return provider?.queryExpansion
    ? { providerName: provider.providerName, expand: provider.queryExpansion }
    : null;
}

/** Resolve the active provider implementation for configured reranking. */
function resolveRerankExtension(
  settings: PmSettings,
): { providerName: string; rerank: ExtensionSearchProviderRerank } | null {
  const provider = resolveExtensionSearchProviderByName(
    toOptionalNonEmptyString(settings.search?.provider),
  );
  return provider?.rerank
    ? { providerName: provider.providerName, rerank: provider.rerank }
    : null;
}

export { buildExplicitSemanticFallbackWarning,buildRerankCorpus,buildSemanticHits,BuiltInBm25Mode,combineHybridHits,computeBuiltInBm25Hits,computeSemanticOrHybridHits,ExtensionSearchProviderQueryExpansion,ExtensionSearchProviderRerank,maybeEmitVectorIndexStaleWarning,mergeVectorHitsById,normalizeExtensionProviderHits,requireSemanticDependencies,resolveBuiltInBm25Mode,resolveExtensionSearchProvider,resolveExtensionSearchProviderByName,resolveExtensionVectorAdapter,resolveQueryExpansionExtension,resolveRerankExtension,toOptionalNonEmptyString };
