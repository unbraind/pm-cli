/**
 * @module cli/commands/search
 *
 * Implements the pm search command surface and its agent-facing runtime behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { coerceNumberInRange, toNonEmptyStringOrUndefined } from "../../core/shared/primitives.js";
import { isPathWithinDirectory } from "../../core/fs/path-utils.js";
import { getActiveExtensionRegistrations, runActiveOnReadHooks } from "../../core/extensions/index.js";
import { collectRegisteredItemFieldNames } from "../../core/extensions/item-fields.js";
import {
  resolveRegisteredSearchProvider,
  resolveRegisteredVectorStoreAdapter,
} from "../../core/extensions/runtime-registrations.js";
import { resolveItemTypeRegistry, type ItemTypeRegistry } from "../../core/item/type-registry.js";
import { parseLimit, parsePriority, parseType } from "../shared-parsers.js";
import {
  executeEmbeddingRequest,
  resolveEmbeddingProviders,
  type EmbeddingProviderConfig,
  type EmbeddingProviderResolution,
} from "../../core/search/providers.js";
import {
  buildDeterministicQueryExpansions,
  mergeQueryExpansions,
  normalizeQueryExpansionOutput,
  normalizeRerankOutput,
  rerankCandidatesWithEmbeddings,
  resolveQueryExpansionConfig,
  resolveRerankConfig,
  type QueryExpansionConfig,
  type RerankCandidate,
  type RerankConfig,
} from "../../core/search/relevance.js";
import { resolveSettingsWithSemanticRuntimeDefaults } from "../../core/search/semantic-defaults.js";
import {
  executeVectorQuery,
  resolveVectorStores,
  type VectorQueryHit,
  type VectorStoreConfig,
  type VectorStoreResolution,
} from "../../core/search/vector-stores.js";
import { readVectorizationStatusLedger } from "../../core/search/cache.js";
import {
  buildEventCorpus,
  buildPlanFlatCorpus,
  buildReminderCorpus,
  buildSearchCorpus,
  resolveSearchCorpusFields,
} from "../../core/search/corpus.js";
import {
  buildBm25Index,
  flattenSearchCorpusText,
  resolveBm25Params,
  scoreBm25Query,
  tokenizeBm25,
  type Bm25Params,
} from "../../core/search/bm25.js";
import { collectStaleVectorizationIds } from "../../core/search/staleness.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { parseItemDocument } from "../../core/item/item-format.js";
import { toItemRecord } from "../../core/item/item-record.js";
import { isTerminalStatus } from "../../core/item/status.js";
import { isStatusAllFilterInput, parseStatusFilterCsv } from "../../core/item/status-filter.js";
import { collectRuntimeFilterValues, matchesRuntimeFilters } from "../../core/schema/runtime-field-filters.js";
import {
  hasMissingMetadataFilter,
  itemMatchesMissingMetadata,
  lifecycleClassifierFromStatusRegistry,
  type LifecycleClassifier,
} from "../../core/governance/metadata-coverage.js";
import {
  hasContentFieldFilter,
  itemMatchesContentFilters,
} from "../../core/governance/content-fields.js";
import {
  applyCommonItemFilterEcho,
  buildContentFilterEcho,
  buildGovernanceMissingFilterEcho,
  resolveContentFieldFilters,
  resolveMissingMetadataFilters,
} from "./list.js";
import {
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeFieldRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { tokenizeAlphaNumeric } from "../../core/shared/text-normalization.js";
import { compareTimestampStrings, nowIso, resolveIsoOrRelative } from "../../core/shared/time.js";
import { listAllDocumentCandidatesCached } from "../../core/store/front-matter-cache.js";
import { listAllFrontMatter } from "../../core/store/item-store.js";
import { getItemPath, getSettingsPath, resolveGlobalPmRoot, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemDocument, ItemFormat, ItemFrontMatter, ItemStatus, ItemType, PmSettings } from "../../types/index.js";

/**
 * Documents the search options payload exchanged by command, SDK, and package integrations.
 */
export interface SearchOptions {
  mode?: string;
  matchMode?: string;
  minScore?: string | number;
  count?: boolean;
  semanticWeight?: string | number;
  includeLinked?: boolean;
  titleExact?: boolean;
  phraseExact?: boolean;
  status?: string;
  type?: string;
  tag?: string;
  priority?: string;
  deadlineBefore?: string;
  deadlineAfter?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  createdAfter?: string;
  createdBefore?: string;
  assignee?: string;
  sprint?: string;
  release?: string;
  parent?: string;
  limit?: string;
  compact?: boolean;
  full?: boolean;
  fields?: string;
  // GH-157: emit per-field matched-text snippets on each hit (off by default for
  // token efficiency). Highlighted spans are wrapped with the «…» markers.
  highlight?: boolean;
  // Governance-missing selection filters (GH-236).
  filterReviewerMissing?: boolean;
  filterRiskMissing?: boolean;
  filterConfidenceMissing?: boolean;
  filterSprintMissing?: boolean;
  filterReleaseMissing?: boolean;
  // Content-field presence/absence selection filters (GH-242).
  hasNotes?: boolean;
  hasLearnings?: boolean;
  hasFiles?: boolean;
  hasDocs?: boolean;
  hasTests?: boolean;
  hasComments?: boolean;
  hasDeps?: boolean;
  hasBody?: boolean;
  hasLinkedCommand?: boolean;
  noNotes?: boolean;
  noLearnings?: boolean;
  noFiles?: boolean;
  noDocs?: boolean;
  noTests?: boolean;
  noComments?: boolean;
  noDeps?: boolean;
  emptyBody?: boolean;
  noLinkedCommand?: boolean;
  [key: string]: unknown;
}

/**
 * Restricts search match mode values accepted by command, SDK, and storage contracts.
 */
export type SearchMatchMode = "and" | "or" | "exact";

type SearchMode = "keyword" | "semantic" | "hybrid";
type SearchProjectionMode = "compact" | "full" | "fields";

interface SearchProjectionConfig {
  mode: SearchProjectionMode;
  fields: string[];
}

const DEFAULT_COMPACT_SEARCH_FIELDS = [
  "id",
  "title",
  "status",
  "type",
  "priority",
  "updated_at",
  "score",
  "matched_fields",
] as const;

const SEARCH_HIT_FIELD_KEYS = new Set(["score", "matched_fields", "highlights"]);
const SEARCH_ITEM_FIELD_KEYS = new Set([
  "id",
  "title",
  "description",
  "type",
  "status",
  "priority",
  "tags",
  "created_at",
  "updated_at",
  "deadline",
  "assignee",
  "author",
  "estimated_minutes",
  "acceptance_criteria",
  "dependencies",
  "comments",
  "notes",
  "learnings",
  "reminders",
  "events",
  "files",
  "tests",
  "docs",
  "close_reason",
  "parent",
  "reviewer",
  "risk",
  "confidence",
  "sprint",
  "release",
  "blocked_by",
  "blocked_reason",
  "reporter",
  "severity",
  "environment",
  "repro_steps",
  "resolution",
  "expected_result",
  "actual_result",
  "affected_version",
  "fixed_version",
  "component",
  "regression",
  "customer_impact",
  "definition_of_ready",
  "order",
  "rank",
  "goal",
  "objective",
  "value",
  "impact",
  "outcome",
  "why_now",
  "plan",
]);

const LONG_QUERY_TOKEN_THRESHOLD = 2;
const LONG_QUERY_TITLE_EXACT_BONUS = 120;
const LONG_QUERY_PHRASE_MULTIPLIER = 6;
// GH-181: in default (OR) match mode, multi-token queries that match EVERY
// distinct query token in some searchable field get an additive ranking bonus so
// items covering all terms outrank items matching only a subset. This is a
// RANKING preference, not a hard filter (use --match-mode and for that).
const ALL_TERMS_COVERAGE_BONUS = 40;
const EXACT_ID_MATCH_SCORE = 1_000;
const SHORT_ID_MATCH_SCORE = 900;
const IMPLICIT_HYBRID_EMBEDDING_TIMEOUT_MS = 8_000;
const IMPLICIT_HYBRID_VECTOR_TIMEOUT_MS = 8_000;

// GH-157 matched-text highlighting (--highlight): markers wrapping each matching
// token run, and the number of characters of surrounding context retained on
// each side of the first match in a field. The «…» guillemets are single
// characters with negligible collision risk against item text, keeping the
// snippet token-cheap while staying visually unambiguous for agents.
const HIGHLIGHT_OPEN = "«";
const HIGHLIGHT_CLOSE = "»";
const HIGHLIGHT_SNIPPET_RADIUS = 60;

// GH-157 inline query syntax: bare `field:value` tokens parsed out of the query
// string and applied as the equivalent filter. The value may itself contain
// colons (e.g. `tag:area:search`), so only the FIRST colon delimits field from
// value. Explicit --field flags take precedence over an inline token (see
// resolveInlineQueryFilters).
const INLINE_QUERY_FILTER_FIELDS = ["tag", "status", "type", "priority"] as const;
type InlineQueryFilterField = (typeof INLINE_QUERY_FILTER_FIELDS)[number];

/**
 * Documents the search hit payload exchanged by command, SDK, and package integrations.
 */
export interface SearchHit {
  item: ItemFrontMatter;
  score: number;
  matched_fields: string[];
  // GH-181: whether every distinct query token matched some searchable field.
  // Used by --match-mode and (hard filter) and the default all-terms ranking
  // bonus. Not projected into output rows.
  matched_all_terms?: boolean;
  // GH-281: marks the keyword hit produced by the exact full-ID / short-ID
  // early-return in scoreDocument(). The semantic & hybrid ranking paths use it
  // to guarantee the exact-ID target ALWAYS ranks #1 (and is exempt from the
  // score threshold / limit), so the keyword-mode exact-ID guarantee is never
  // lost once vector blending is active. SHORT_ID matches keep score=900 and
  // full-ID matches keep score=1000, so sortHits still orders full above short.
  // Not projected into output rows.
  exact_id_match?: boolean;
  // GH-157: per-field matched-text snippets, populated only when the caller
  // passes --highlight. Each entry pairs a matched field name with a snippet of
  // its text where the matching token runs are wrapped in the «…» markers.
  highlights?: SearchHitHighlight[];
}

/**
 * Pairs a matched field name with a snippet of its text where every matching
 * token run is wrapped in the {@link HIGHLIGHT_OPEN}/{@link HIGHLIGHT_CLOSE}
 * markers. Emitted on {@link SearchHit.highlights} when `--highlight` is set.
 */
export interface SearchHitHighlight {
  field: string;
  snippet: string;
}

/**
 * Restricts search result item values accepted by command, SDK, and storage contracts.
 */
export type SearchResultItem = SearchHit | Record<string, unknown>;

interface SearchResultBase {
  query: string;
  mode: SearchMode;
  items: SearchResultItem[];
  count: number;
  // GH-181: total matched hits after filters/threshold but BEFORE the limit
  // truncation. Lets callers see how many matched before the (now-default)
  // keyword limit dropped rows. Only emitted when it differs from count.
  total?: number;
  // --count mode: count-only response carries the matched total and skips the
  // hit rows entirely (items is empty). `count` reflects the same total.
  count_only?: boolean;
  warnings?: string[];
}

/**
 * Documents the search compact result payload exchanged by command, SDK, and package integrations.
 */
export interface SearchCompactResult extends SearchResultBase {
  filters: Record<string, unknown>;
  projection?: undefined;
  now?: undefined;
}

/**
 * Documents the search verbose result payload exchanged by command, SDK, and package integrations.
 */
export interface SearchVerboseResult extends SearchResultBase {
  filters: Record<string, unknown>;
  projection: {
    mode: SearchProjectionMode;
    fields: string[] | null;
  };
  now: string;
}

/**
 * Restricts search result values accepted by command, SDK, and storage contracts.
 */
export type SearchResult = SearchCompactResult | SearchVerboseResult;

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

function buildCompactSearchFilterSummary(params: {
  mode: SearchMode;
  matchMode: SearchMatchMode;
  options: SearchOptions;
  includeLinked: boolean;
  titleExact: boolean;
  phraseExact: boolean;
  scoreThreshold: number;
  hybridSemanticWeight: number;
  runtimeFieldFilters?: Record<string, unknown>;
}): Record<string, unknown> {
  const {
    mode,
    matchMode,
    options,
    includeLinked,
    titleExact,
    phraseExact,
    scoreThreshold,
    hybridSemanticWeight,
    runtimeFieldFilters,
  } = params;
  const filters: Record<string, unknown> = {};
  if (options.status !== undefined) {
    filters.status = isStatusAllFilterInput(options.status) ? "all" : options.status;
  }
  applyCommonItemFilterEcho(filters, options);
  Object.assign(filters, buildGovernanceMissingFilterEcho(options as Record<string, unknown>));
  Object.assign(filters, buildContentFilterEcho(options as Record<string, unknown>));
  if (matchMode !== "or") {
    filters.match_mode = matchMode;
  }
  if (includeLinked) {
    filters.include_linked = true;
  }
  if (titleExact) {
    filters.title_exact = true;
  }
  if (phraseExact) {
    filters.phrase_exact = true;
  }
  if (scoreThreshold > 0) {
    filters.score_threshold = scoreThreshold;
  }
  if (mode === "hybrid" && options.semanticWeight !== undefined) {
    filters.hybrid_semantic_weight = hybridSemanticWeight;
  }
  if (options.limit !== undefined) {
    filters.limit = options.limit;
  }
  if (isNonEmptyRecord(runtimeFieldFilters)) {
    filters.runtime_filters = runtimeFieldFilters;
  }
  return filters;
}

// Shared verbose (non-compact) filters echo. Keeps the count-only, empty-result,
// and primary return paths emitting an identical filter shape (GH-181/pm-13nx).
function buildVerboseSearchFilters(params: {
  effectiveMode: SearchMode;
  matchMode: SearchMatchMode;
  options: SearchOptions;
  includeLinked: boolean;
  titleExact: boolean;
  phraseExact: boolean;
  scoreThreshold: number;
  hybridSemanticWeight: number;
  queryExpansion: QueryExpansionConfig;
  rerank: RerankConfig;
  runtimeFieldFilters: Record<string, unknown>;
}): Record<string, unknown> {
  const {
    effectiveMode,
    matchMode,
    options,
    includeLinked,
    titleExact,
    phraseExact,
    scoreThreshold,
    hybridSemanticWeight,
    queryExpansion,
    rerank,
    runtimeFieldFilters,
  } = params;
  return {
    mode: effectiveMode,
    match_mode: matchMode,
    status: isStatusAllFilterInput(options.status) ? "all" : options.status ?? null,
    type: options.type ?? null,
    tag: options.tag ?? null,
    priority: options.priority ?? null,
    deadline_before: options.deadlineBefore ?? null,
    deadline_after: options.deadlineAfter ?? null,
    updated_after: options.updatedAfter ?? null,
    updated_before: options.updatedBefore ?? null,
    created_after: options.createdAfter ?? null,
    created_before: options.createdBefore ?? null,
    assignee: options.assignee ?? null,
    sprint: options.sprint ?? null,
    release: options.release ?? null,
    parent: options.parent ?? null,
    ...buildGovernanceMissingFilterEcho(options as Record<string, unknown>),
    ...buildContentFilterEcho(options as Record<string, unknown>),
    include_linked: includeLinked,
    title_exact: titleExact,
    phrase_exact: phraseExact,
    score_threshold: scoreThreshold,
    hybrid_semantic_weight: effectiveMode === "hybrid" ? hybridSemanticWeight : null,
    query_expansion_enabled: queryExpansion.enabled,
    query_expansion_provider: queryExpansion.provider,
    rerank_enabled: rerank.enabled,
    rerank_model: rerank.model,
    rerank_top_k: rerank.top_k,
    limit: options.limit ?? null,
    runtime_filters: runtimeFieldFilters,
  };
}

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
) => Promise<ExtensionSearchProviderHit[] | { hits?: ExtensionSearchProviderHit[] }> | ExtensionSearchProviderHit[] | { hits?: ExtensionSearchProviderHit[] };

interface ExtensionSearchProviderQueryExpansionContext {
  query: string;
  mode: Exclude<SearchMode, "keyword">;
  settings: PmSettings;
}

type ExtensionSearchProviderQueryExpansion = (
  context: ExtensionSearchProviderQueryExpansionContext,
) => Promise<string[] | { queries?: string[] }> | string[] | { queries?: string[] };

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

type ExtensionSearchProviderRerank = (
  context: ExtensionSearchProviderRerankContext,
) => Promise<Array<{ id?: unknown; score?: unknown }> | { hits?: Array<{ id?: unknown; score?: unknown }> }>
  | Array<{ id?: unknown; score?: unknown }>
  | { hits?: Array<{ id?: unknown; score?: unknown }> };

type ExtensionVectorQuery = (
  context: {
    vector: number[];
    limit: number;
    settings: PmSettings;
  },
) => Promise<VectorQueryHit[]> | VectorQueryHit[];

type ExtensionVectorAdapter = {
  query?: ExtensionVectorQuery;
};



interface SearchModeContext {
  hasProvider: boolean;
  hasVectorStore: boolean;
}

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
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
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
export function classifyImplicitSemanticFallbackReason(error: unknown): ImplicitSemanticFallbackReason {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const causeCodes = collectErrorCauseCodes(error);
  const haystack = `${message} ${causeCodes}`;
  if (haystack.includes("timed out") || haystack.includes("timeout") || haystack.includes("etimedout")) {
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

function buildImplicitSemanticFallbackWarning(error: unknown): string {
  const reason = classifyImplicitSemanticFallbackReason(error);
  if (reason === "timeout") {
    return "search_implicit_semantic_fallback:timeout:using_keyword_mode";
  }
  if (reason === "connection") {
    return "search_implicit_semantic_fallback:connection:using_keyword_mode";
  }
  return "search_implicit_semantic_fallback:error:using_keyword_mode";
}

// Explicit --semantic/--hybrid searches must never hard-fail an agent when the
// embedding/vector backend is unreachable or unconfigured: degrade to keyword
// search and surface a machine-readable warning instead of an unknown_error.
function buildExplicitSemanticFallbackWarning(requestedMode: SearchMode, error: unknown): string {
  const reason = classifyImplicitSemanticFallbackReason(error);
  return `search_${requestedMode}_fallback:${reason}:using_keyword_mode`;
}

/**
 * Compare the vectorization-status ledger against the filtered corpus and, when
 * the vector index is behind, emit a one-line stderr warning plus a structured
 * `vector_index_stale:N` entry in the JSON warnings array. Best-effort: ledger
 * read failures fall through silently — the existing semantic/hybrid fallback
 * paths cover backend errors.
 */
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
    warnings.push(`vector_index_stale:${staleIds.length}`);
    /* c8 ignore start -- singular/plural warning text branches are cosmetic and validated in integration UX tests */
    process.stderr.write(
      `[pm] warning: ${staleIds.length} item${staleIds.length === 1 ? " is" : "s are"} new or modified since the last reindex and ${staleIds.length === 1 ? "is" : "are"} NOT in the semantic index yet — they will be missing from semantic/hybrid results until you run 'pm reindex --mode hybrid'. (Write-time embedding is governed by search.mutation_refresh_policy; staleness means the embed was skipped, failed, or the backend was unreachable.)\n`,
    );
    /* c8 ignore stop */
  } catch {
    // Best-effort: missing/unreadable ledger is not a query-blocking concern.
  }
}

function parseMode(raw: string | undefined, _context: SearchModeContext): SearchMode {
  if (raw === undefined) {
    return "keyword";
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized !== "keyword" && normalized !== "semantic" && normalized !== "hybrid") {
    throw new PmCliError("Search mode must be one of keyword|semantic|hybrid", EXIT_CODE.USAGE);
  }
  return normalized;
}

function parseIncludeLinked(raw: boolean | undefined): boolean {
  return raw === true;
}

function parseTitleExact(raw: boolean | undefined): boolean {
  return raw === true;
}

function parsePhraseExact(raw: boolean | undefined): boolean {
  return raw === true;
}

function parseSemanticWeightOverride(raw: unknown): number | undefined {
  return coerceNumberInRange(raw, 0, 1) ?? undefined;
}

function parseMatchMode(raw: string | undefined): SearchMatchMode {
  if (raw === undefined) {
    return "or";
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized !== "and" && normalized !== "or" && normalized !== "exact") {
    throw new PmCliError("Search --match-mode must be one of and|or|exact", EXIT_CODE.USAGE);
  }
  return normalized;
}

// Per-query --min-score overrides the persistent search.score_threshold for this
// query only. Accepts a finite number >= 0; anything else is a usage error.
function parseMinScoreOverride(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  /* c8 ignore start -- numeric-vs-string coercion branch is exercised via integration CLI parsing */
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  /* c8 ignore stop */
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new PmCliError("Search --min-score must be a finite number >= 0", EXIT_CODE.USAGE);
  }
  return parsed;
}

// updated/created date-window filters share the deadline ISO+relative resolver
// so `pm search` matches `pm list` semantics exactly: pass an ISO timestamp or a
// SIGNED relative offset ("-2h"/"-7d" reach into the past, "+1d" the future;
// units h/d/w/m, m = months — there is no minutes unit).
function parseTimestampWindow(raw: unknown, fieldLabel: string): string | undefined {
  if (raw == null) return undefined;
  const value = String(raw).trim();
  if (value.length === 0) return undefined;
  return resolveIsoOrRelative(value, new Date(), fieldLabel);
}

function normalizeSearchPhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parseDeadline(raw: string | undefined, fieldLabel: string): string | undefined {
  if (raw === undefined) return undefined;
  return resolveIsoOrRelative(raw, new Date(), fieldLabel);
}

function parseFieldSelectors(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const selectors = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (selectors.length === 0) {
    throw new PmCliError("Search --fields requires a comma-separated list of field names", EXIT_CODE.USAGE);
  }
  return [...new Set(selectors)];
}

function parseProjectionConfig(options: SearchOptions): SearchProjectionConfig {
  const compactRequested = options.compact === true;
  const fullRequested = options.full === true;
  const fieldSelectors = parseFieldSelectors(options.fields);
  const enabledModes = Number(compactRequested) + Number(fullRequested) + Number(fieldSelectors !== undefined);
  if (enabledModes > 1) {
    throw new PmCliError(
      "Search projection options are mutually exclusive. Use one of --compact, --full, or --fields.",
      EXIT_CODE.USAGE,
    );
  }
  if (compactRequested) {
    return {
      mode: "compact",
      fields: [...DEFAULT_COMPACT_SEARCH_FIELDS],
    };
  }
  if (fullRequested) {
    return {
      mode: "full",
      fields: [],
    };
  }
  if (fieldSelectors) {
    return {
      mode: "fields",
      fields: fieldSelectors,
    };
  }
  return {
    mode: "full",
    fields: [],
  };
}

export const _testOnlySearchCommand = {
  applyFilters,
  applyExactQueryFilters,
  applyInlineQueryFilters,
  buildHitHighlights,
  buildVerboseSearchFilters,
  buildExplicitSemanticFallbackWarning,
  buildCompactSearchFilterSummary,
  buildHybridLexicalScore,
  buildImplicitSemanticFallbackWarning,
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
  parseProjectionConfig,
  parseTimestampWindow,
  parseTokens,
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

/* c8 ignore start -- projection/runtime-field validation edge permutations are covered by integration query-contract tests */
function validateSearchProjectionFields(projection: SearchProjectionConfig, runtimeFieldRegistry: RuntimeFieldRegistry): void {
  if (projection.mode !== "fields") {
    return;
  }
  const runtimeKeys = new Set(runtimeFieldRegistry.definitions.flatMap((field) => [field.key, field.metadata_key]));
  const unknown = projection.fields.filter((field) => {
    const normalized = field.trim();
    const itemKey = normalized.startsWith("item.") ? normalized.slice("item.".length) : normalized;
    return !SEARCH_HIT_FIELD_KEYS.has(normalized) && !SEARCH_ITEM_FIELD_KEYS.has(itemKey) && !runtimeKeys.has(itemKey);
  });
  if (unknown.length > 0) {
    throw new PmCliError(`Unknown search --fields value(s): ${unknown.join(", ")}`, EXIT_CODE.USAGE, {
      examples: [
        "pm search <query> --fields id,title,status,score",
        "pm search <query> --fields id,title,item.description,matched_fields",
      ],
      nextSteps: ["Use item.<field> for explicit item metadata fields, or run pm search --help for projection examples."],
    });
  }
}
/* c8 ignore stop */

function parseTokens(query: string): string[] {
  const normalized = normalizeSearchPhrase(query);
  if (!normalized) {
    throw new PmCliError("Search query must not be empty", EXIT_CODE.USAGE);
  }
  return normalized.split(/\s+/).filter(Boolean);
}

/**
 * Result of extracting inline `field:value` tokens from a raw search query.
 */
interface InlineQueryParse {
  /** The query with all recognized inline filter tokens removed. */
  residualQuery: string;
  /** Recognized inline filters keyed by field name; first occurrence per field wins. */
  inlineFilters: Partial<Record<InlineQueryFilterField, string>>;
}

/**
 * Split a raw search query into its residual keyword text and any inline
 * `field:value` filter tokens (GH-157). Recognized fields are
 * {@link INLINE_QUERY_FILTER_FIELDS}; the value runs to the end of the token so
 * colon-bearing values like `tag:area:search` parse as `{ tag: "area:search" }`.
 * Only the first occurrence of each field is captured — later duplicates are left
 * in the residual query so they are never silently dropped. Tokens whose prefix
 * is not a recognized field (`foo:bar`) stay in the residual query verbatim.
 */
function parseInlineQueryFilters(query: string): InlineQueryParse {
  const inlineFilters: Partial<Record<InlineQueryFilterField, string>> = {};
  const residualTokens: string[] = [];
  for (const token of query.split(/\s+/).filter((entry) => entry.length > 0)) {
    const separatorIndex = token.indexOf(":");
    const field = separatorIndex > 0 ? token.slice(0, separatorIndex).toLowerCase() : "";
    const value = separatorIndex > 0 ? token.slice(separatorIndex + 1) : "";
    const matchedField = (INLINE_QUERY_FILTER_FIELDS as ReadonlyArray<string>).includes(field)
      ? (field as InlineQueryFilterField)
      : undefined;
    if (matchedField && value.length > 0 && inlineFilters[matchedField] === undefined) {
      inlineFilters[matchedField] = value;
      continue;
    }
    residualTokens.push(token);
  }
  return {
    residualQuery: residualTokens.join(" "),
    inlineFilters,
  };
}

/**
 * Merge inline `field:value` filters into a search options object (GH-157).
 * Explicit `--field` flags always win: an inline token is applied only when the
 * corresponding option is not already set, and a conflicting inline token is
 * recorded as a `search_inline_filter_ignored:<field>:flag_takes_precedence`
 * warning so the override is observable rather than silent. Returns a fresh
 * options object — the caller's input is never mutated.
 */
function applyInlineQueryFilters(
  options: SearchOptions,
  inlineFilters: Partial<Record<InlineQueryFilterField, string>>,
  warnings: string[],
): SearchOptions {
  const merged: SearchOptions = { ...options };
  for (const field of INLINE_QUERY_FILTER_FIELDS) {
    const inlineValue = inlineFilters[field];
    if (inlineValue === undefined) {
      continue;
    }
    if (toNonEmptyStringOrUndefined(merged[field]) !== undefined) {
      warnings.push(`search_inline_filter_ignored:${field}:flag_takes_precedence`);
      continue;
    }
    merged[field] = inlineValue;
  }
  return merged;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function textEntries(value: unknown): Array<{ text: string }> {
  return Array.isArray(value)
    ? value.filter((entry): entry is { text: string } =>
        typeof entry === "object" && entry !== null && typeof (entry as { text?: unknown }).text === "string",
      )
    : [];
}

function dependencyEntries(value: unknown): Array<{ id: string; kind: string }> {
  return Array.isArray(value)
    ? value.filter((entry): entry is { id: string; kind: string } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === "string" &&
        typeof (entry as { kind?: unknown }).kind === "string",
      )
    : [];
}

function collectExactPhraseFields(document: ItemDocument): string[] {
  const item = document.metadata;
  return [
    item.title,
    item.description,
    item.status,
    stringArray(item.tags).join(" "),
    document.body,
    textEntries(item.comments).map((entry) => entry.text).join(" "),
    textEntries(item.notes).map((entry) => entry.text).join(" "),
    textEntries(item.learnings).map((entry) => entry.text).join(" "),
    buildReminderCorpus(item).join(" "),
    buildEventCorpus(item).join(" "),
    dependencyEntries(item.dependencies).map((entry) => `${entry.id} ${entry.kind}`).join(" "),
    buildPlanFlatCorpus(item),
  ];
}

function documentContainsExactPhrase(document: ItemDocument, normalizedQuery: string): boolean {
  return collectExactPhraseFields(document).some((fieldValue) =>
    normalizeSearchPhrase(fieldValue).includes(normalizedQuery),
  );
}

function applyExactQueryFilters(
  items: ItemDocument[],
  normalizedQuery: string,
  options: { titleExact: boolean; phraseExact: boolean },
): ItemDocument[] {
  if (!options.titleExact && !options.phraseExact) {
    return items;
  }
  return items.filter((document) => {
    if (options.titleExact && normalizeSearchPhrase(document.metadata.title) !== normalizedQuery) {
      return false;
    }
    if (options.phraseExact && !documentContainsExactPhrase(document, normalizedQuery)) {
      return false;
    }
    return true;
  });
}

function applyFilters(
  items: ItemDocument[],
  options: SearchOptions,
  typeRegistry: ItemTypeRegistry,
  runtimeFieldFilters: Record<string, unknown>,
  statusFilter: ItemStatus[] | undefined,
  lifecycleClassifier: LifecycleClassifier,
): ItemDocument[] {
  const typeFilter = parseType(options.type, typeRegistry);
  const tagFilter = options.tag?.trim().toLowerCase();
  const priorityFilter = parsePriority(options.priority);
  const deadlineBefore = parseDeadline(options.deadlineBefore, "deadline-before");
  const deadlineAfter = parseDeadline(options.deadlineAfter, "deadline-after");
  const updatedAfter = parseTimestampWindow(options.updatedAfter, "updated-after");
  const updatedBefore = parseTimestampWindow(options.updatedBefore, "updated-before");
  const createdAfter = parseTimestampWindow(options.createdAfter, "created-after");
  const createdBefore = parseTimestampWindow(options.createdBefore, "created-before");
  const assigneeFilter = options.assignee?.trim();
  const sprintFilter = options.sprint?.trim();
  const releaseFilter = options.release?.trim();
  const parentFilter = options.parent?.trim();
  const statusSet = statusFilter && statusFilter.length > 0 ? new Set<ItemStatus>(statusFilter) : undefined;
  const missingMetadataFilters = resolveMissingMetadataFilters(options);
  const missingMetadataActive = hasMissingMetadataFilter(missingMetadataFilters);
  const contentFieldFilters = resolveContentFieldFilters(options as Record<string, unknown>);
  const contentFiltersActive = hasContentFieldFilter(contentFieldFilters);

  // Match pm list: --assignee no longer accepts none/null (unassigned filtering
  // belongs to a dedicated flag there; pm search has no presence flag so reject
  // the sentinel values explicitly rather than silently matching a literal).
  if (assigneeFilter && (assigneeFilter.toLowerCase() === "none" || assigneeFilter.toLowerCase() === "null")) {
    throw new PmCliError('--assignee no longer accepts "none" or "null".', EXIT_CODE.USAGE);
  }

  return items.filter((document) => {
    const item = document.metadata;
    if (statusSet && !statusSet.has(item.status)) return false;
    if (typeFilter && item.type !== typeFilter) return false;
    if (tagFilter && !stringArray(item.tags).includes(tagFilter)) return false;
    if (priorityFilter !== undefined && item.priority !== priorityFilter) return false;
    if (deadlineBefore && (!item.deadline || compareTimestampStrings(item.deadline, deadlineBefore) > 0)) return false;
    if (deadlineAfter && (!item.deadline || compareTimestampStrings(item.deadline, deadlineAfter) < 0)) return false;
    if (updatedAfter && compareTimestampStrings(item.updated_at, updatedAfter) < 0) return false;
    if (updatedBefore && compareTimestampStrings(item.updated_at, updatedBefore) > 0) return false;
    if (createdAfter && compareTimestampStrings(item.created_at, createdAfter) < 0) return false;
    if (createdBefore && compareTimestampStrings(item.created_at, createdBefore) > 0) return false;
    if (assigneeFilter !== undefined && item.assignee !== assigneeFilter) return false;
    if (sprintFilter !== undefined && item.sprint !== sprintFilter) return false;
    /* c8 ignore start -- release/parent metadata filter combinations are covered by integration search fixtures */
    if (releaseFilter !== undefined && item.release !== releaseFilter) return false;
    if (parentFilter !== undefined && item.parent !== parentFilter) return false;
    /* c8 ignore stop */
    if (!matchesRuntimeFilters(item as Record<string, unknown>, runtimeFieldFilters)) return false;
    if (missingMetadataActive && !itemMatchesMissingMetadata(item, missingMetadataFilters, lifecycleClassifier)) {
      return false;
    }
    if (contentFiltersActive && !itemMatchesContentFilters(item, contentFieldFilters)) {
      return false;
    }
    return true;
  });
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const foundAt = haystack.indexOf(needle, index);
    if (foundAt < 0) {
      return count;
    }
    count += 1;
    index = foundAt + needle.length;
  }
}

function tokenizeForExactTokenMatch(value: string): string[] {
  return tokenizeAlphaNumeric(value);
}

function collectLinkedPaths(item: ItemFrontMatter): Array<{ scope: "project" | "global"; path: string }> {
  const fromFiles = (item.files ?? []).map((entry) => ({
    scope: entry.scope,
    path: entry.path.trim(),
  }));
  const fromDocs = (item.docs ?? []).map((entry) => ({
    scope: entry.scope,
    path: entry.path.trim(),
  }));
  const fromTests = (item.tests ?? [])
    .filter((entry): entry is typeof entry & { path: string } => typeof entry.path === "string" && entry.path.trim().length > 0)
    .map((entry) => ({
      scope: entry.scope,
      path: entry.path.trim(),
    }));
  const sorted = [...fromFiles, ...fromDocs, ...fromTests]
    .filter((entry) => entry.path.length > 0)
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.path.localeCompare(b.path));
  const deduped = new Map<string, { scope: "project" | "global"; path: string }>();
  for (const entry of sorted) {
    deduped.set(`${entry.scope}:${entry.path}`, entry);
  }
  return [...deduped.values()];
}

interface ContainmentRoot {
  resolved: string;
  realpath: string;
}

interface LinkedCorpusRoots {
  projectContainmentRoot: ContainmentRoot | null;
  globalContainmentRoot: ContainmentRoot | null;
}

async function resolveContainmentRoot(root: string): Promise<ContainmentRoot | null> {
  const resolved = path.resolve(root);
  try {
    const realpathRoot = await fs.realpath(resolved);
    return {
      resolved,
      realpath: realpathRoot,
    };
  } catch {
    return null;
  }
}

async function resolveLinkedCorpusRoots(projectRoot: string, globalRoot: string): Promise<LinkedCorpusRoots> {
  const [projectContainmentRoot, globalContainmentRoot] = await Promise.all([
    resolveContainmentRoot(projectRoot),
    resolveContainmentRoot(globalRoot),
  ]);
  return {
    projectContainmentRoot,
    globalContainmentRoot,
  };
}

async function loadLinkedCorpus(
  document: ItemDocument,
  roots: LinkedCorpusRoots,
): Promise<string> {
  const linkedPaths = collectLinkedPaths(document.metadata);
  const chunks: string[] = [];
  for (const linkedPath of linkedPaths) {
    const containmentRoot = linkedPath.scope === "global" ? roots.globalContainmentRoot : roots.projectContainmentRoot;
    if (!containmentRoot) {
      continue;
    }
    const resolved = path.resolve(containmentRoot.resolved, linkedPath.path);
    if (!isPathWithinDirectory(containmentRoot.resolved, resolved)) {
      continue;
    }
    let linkedRealpath: string;
    try {
      linkedRealpath = await fs.realpath(resolved);
    } catch {
      continue;
    }
    if (!isPathWithinDirectory(containmentRoot.realpath, linkedRealpath)) {
      continue;
    }
    try {
      await runActiveOnReadHooks({
        path: resolved,
        scope: linkedPath.scope,
      });
      chunks.push(await fs.readFile(resolved, "utf8"));
    } catch {
      // Best-effort linked-content indexing: unreadable paths are ignored.
    }
  }
  return chunks.join("\n");
}

/**
 * Documents the search tuning payload exchanged by command, SDK, and package integrations.
 */
export interface SearchTuning {
  title_exact_bonus: number;
  title_weight: number;
  description_weight: number;
  tags_weight: number;
  status_weight: number;
  body_weight: number;
  comments_weight: number;
  notes_weight: number;
  learnings_weight: number;
  reminders_weight: number;
  events_weight: number;
  dependencies_weight: number;
  linked_content_weight: number;
}

/**
 * Canonical definition of the document-derived searchable fields shared by the
 * lexical scorer ({@link scoreDocument}) and the matched-text highlighter
 * ({@link buildHitHighlights}). Keeping a single source of field name → text
 * extractor → tuning weight guarantees the highlighter can only ever produce
 * snippets for fields the scorer actually inspected. The `linked_content` field
 * is appended separately by the scorer because its text is supplied per-query
 * rather than derived from the document.
 */
const SEARCHABLE_FIELD_BUILDERS: ReadonlyArray<{
  name: string;
  weightKey: keyof SearchTuning;
  value: (document: ItemDocument) => string;
}> = [
  { name: "title", weightKey: "title_weight", value: (document) => document.metadata.title },
  { name: "description", weightKey: "description_weight", value: (document) => document.metadata.description },
  { name: "tags", weightKey: "tags_weight", value: (document) => stringArray(document.metadata.tags).join(" ") },
  {
    name: "status",
    weightKey: "status_weight",
    value: (document) => (typeof document.metadata.status === "string" ? document.metadata.status : ""),
  },
  { name: "body", weightKey: "body_weight", value: (document) => document.body },
  {
    name: "comments",
    weightKey: "comments_weight",
    value: (document) => textEntries(document.metadata.comments).map((entry) => entry.text).join(" "),
  },
  {
    name: "notes",
    weightKey: "notes_weight",
    value: (document) => textEntries(document.metadata.notes).map((entry) => entry.text).join(" "),
  },
  {
    name: "learnings",
    weightKey: "learnings_weight",
    value: (document) => textEntries(document.metadata.learnings).map((entry) => entry.text).join(" "),
  },
  { name: "reminders", weightKey: "reminders_weight", value: (document) => buildReminderCorpus(document.metadata).join(" ") },
  { name: "events", weightKey: "events_weight", value: (document) => buildEventCorpus(document.metadata).join(" ") },
  {
    name: "dependencies",
    weightKey: "dependencies_weight",
    value: (document) => dependencyEntries(document.metadata.dependencies).map((entry) => `${entry.id} ${entry.kind}`).join(" "),
  },
  { name: "plan", weightKey: "body_weight", value: (document) => buildPlanFlatCorpus(document.metadata) },
];

// Name → builder index so the highlighter can resolve a matched field to its
// text extractor in O(1) and evaluate ONLY the matched fields' values, instead
// of materializing all twelve (several of which join/build corpora) per hit.
const SEARCHABLE_FIELD_BUILDER_BY_NAME = new Map(SEARCHABLE_FIELD_BUILDERS.map((builder) => [builder.name, builder]));

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wrap every case-insensitive occurrence of any query token in `text` with the
 * {@link HIGHLIGHT_OPEN}/{@link HIGHLIGHT_CLOSE} markers. Token boundaries follow
 * the same substring semantics as the lexical scorer (a token highlights inside
 * longer words, matching how it scored), and overlapping matches are coalesced
 * by the single combined alternation so markers never nest.
 */
function markTokenRuns(text: string, tokens: string[]): string {
  // Sort by length descending before building the alternation so a longer token
  // wins over a shorter token that is its prefix (regex alternation is greedy
  // left-to-right, so `auth|authority` would mark «auth»ority instead of
  // «authority»). `.filter` already returns a fresh array, so the in-place sort
  // never mutates the caller's token list.
  const escaped = tokens
    .filter((token) => token.length > 0)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExpLiteral);
  if (escaped.length === 0) {
    return text;
  }
  const pattern = new RegExp(escaped.join("|"), "gi");
  return text.replace(pattern, (match) => `${HIGHLIGHT_OPEN}${match}${HIGHLIGHT_CLOSE}`);
}

/**
 * Build a single highlighted snippet for one field value (GH-157), or null when
 * no token matches. The snippet is a window of {@link HIGHLIGHT_SNIPPET_RADIUS}
 * characters on each side of the first match with the matching token runs
 * wrapped in markers, prefixed/suffixed with an ellipsis when the field text was
 * trimmed. Returning null lets the caller skip fields with no concrete textual
 * match (e.g. a field flagged purely by the phrase-coverage bonus).
 */
function highlightFieldSnippet(text: string, tokens: string[]): string | null {
  if (text.length === 0) {
    return null;
  }
  const lowerText = text.toLowerCase();
  let firstMatchIndex = -1;
  for (const token of tokens) {
    if (token.length === 0) {
      continue;
    }
    const index = lowerText.indexOf(token);
    if (index >= 0 && (firstMatchIndex < 0 || index < firstMatchIndex)) {
      firstMatchIndex = index;
    }
  }
  if (firstMatchIndex < 0) {
    return null;
  }
  const windowStart = Math.max(0, firstMatchIndex - HIGHLIGHT_SNIPPET_RADIUS);
  const windowEnd = Math.min(text.length, firstMatchIndex + HIGHLIGHT_SNIPPET_RADIUS);
  const marked = markTokenRuns(text.slice(windowStart, windowEnd), tokens);
  const prefix = windowStart > 0 ? "…" : "";
  const suffix = windowEnd < text.length ? "…" : "";
  return `${prefix}${marked}${suffix}`;
}

/**
 * Produce per-field matched-text snippets for a hit (GH-157, `--highlight`).
 * Iterates the hit's already-sorted `matched_fields`, retains only the
 * document-derived searchable fields (skipping synthetic markers like `id`,
 * `semantic`, `rerank`, and `linked_content`), and emits a snippet for each
 * field that still contains a concrete token match.
 */
function buildHitHighlights(document: ItemDocument, matchedFields: string[], tokens: string[]): SearchHitHighlight[] {
  const highlights: SearchHitHighlight[] = [];
  for (const field of matchedFields) {
    const builder = SEARCHABLE_FIELD_BUILDER_BY_NAME.get(field);
    if (builder === undefined) {
      continue;
    }
    const snippet = highlightFieldSnippet(builder.value(document), tokens);
    if (snippet !== null) {
      highlights.push({ field, snippet });
    }
  }
  return highlights;
}

function scoreDocument(
  document: ItemDocument,
  tokens: string[],
  normalizedQuery: string,
  linkedCorpus: string,
  tuning: SearchTuning,
  idPrefix: string,
  applyCoverageBonus = false,
): SearchHit | null {
  const item = document.metadata;
  const normalizedId = normalizeSearchPhrase(item.id);
  const normalizedIdPrefix = typeof idPrefix === "string" ? idPrefix.trim().toLowerCase() : "";
  const normalizedIdPrefixPhrase = normalizeSearchPhrase(normalizedIdPrefix);
  const normalizedShortId =
    normalizedIdPrefixPhrase.length > 0 && normalizedId.startsWith(normalizedIdPrefixPhrase)
      ? normalizedId.slice(normalizedIdPrefixPhrase.length).trim()
      : normalizedId;
  if (normalizedQuery === normalizedId || normalizedQuery === normalizedShortId) {
    return {
      item,
      score: normalizedQuery === normalizedId ? EXACT_ID_MATCH_SCORE : SHORT_ID_MATCH_SCORE,
      matched_fields: ["id"],
      matched_all_terms: true,
      exact_id_match: true,
    };
  }
  const titleTokenCounts = new Map<string, number>();
  for (const token of tokenizeForExactTokenMatch(item.title)) {
    titleTokenCounts.set(token, (titleTokenCounts.get(token) ?? 0) + 1);
  }
  const searchableFields: Array<{ name: string; value: string; weight: number }> = [
    ...SEARCHABLE_FIELD_BUILDERS.map((builder) => ({
      name: builder.name,
      value: builder.value(document),
      weight: tuning[builder.weightKey],
    })),
    { name: "linked_content", value: linkedCorpus, weight: tuning.linked_content_weight },
  ];

  let score = 0;
  const matched = new Set<string>();
  const matchedTokens = new Set<string>();
  for (const token of tokens) {
    const exactTitleMatches = titleTokenCounts.get(token) ?? 0;
    if (exactTitleMatches > 0) {
      score += exactTitleMatches * tuning.title_exact_bonus;
      matched.add("title");
      matchedTokens.add(token);
    }
    for (const field of searchableFields) {
      const fieldValue = field.value.toLowerCase();
      const occurrences = countOccurrences(fieldValue, token);
      if (occurrences > 0) {
        score += occurrences * field.weight;
        matched.add(field.name);
        matchedTokens.add(token);
      }
    }
  }
  const distinctTokens = new Set(tokens);
  // matchedTokens only ever holds entries drawn from `tokens`, so it is always a
  // subset of distinctTokens — exact size equality means every distinct term matched.
  const matchedAllTerms = distinctTokens.size > 0 && matchedTokens.size === distinctTokens.size;
  // GH-181 default-mode all-terms ranking bonus: only meaningful for multi-token
  // queries where every distinct token matched somewhere.
  if (applyCoverageBonus && distinctTokens.size > 1 && matchedAllTerms) {
    score += ALL_TERMS_COVERAGE_BONUS;
  }

  const isLongPhraseQuery = tokens.length >= LONG_QUERY_TOKEN_THRESHOLD && normalizedQuery.includes(" ");
  if (isLongPhraseQuery) {
    const normalizedTitle = normalizeSearchPhrase(item.title);
    if (normalizedTitle === normalizedQuery) {
      score += LONG_QUERY_TITLE_EXACT_BONUS;
      matched.add("title");
    }
    for (const field of searchableFields) {
      const normalizedField = normalizeSearchPhrase(field.value);
      const phraseOccurrences = countOccurrences(normalizedField, normalizedQuery);
      if (phraseOccurrences > 0) {
        score += phraseOccurrences * field.weight * LONG_QUERY_PHRASE_MULTIPLIER;
        matched.add(field.name);
      }
    }
  }

  if (score <= 0) {
    return null;
  }

  return {
    item,
    score,
    matched_fields: [...matched].sort((a, b) => a.localeCompare(b)),
    matched_all_terms: matchedAllTerms,
  };
}

function sortHits(items: SearchHit[], statusRegistry: RuntimeStatusRegistry): SearchHit[] {
  return [...items].sort((a, b) => {
    const byScore = b.score - a.score;
    if (byScore !== 0) return byScore;
    const aTerminal = isTerminalStatus(a.item.status, statusRegistry);
    const bTerminal = isTerminalStatus(b.item.status, statusRegistry);
    if (aTerminal !== bTerminal) {
      return aTerminal ? 1 : -1;
    }
    const byPriority = a.item.priority - b.item.priority;
    if (byPriority !== 0) return byPriority;
    const byUpdated = compareTimestampStrings(b.item.updated_at, a.item.updated_at);
    if (byUpdated !== 0) return byUpdated;
    return a.item.id.localeCompare(b.item.id);
  });
}

function buildHybridLexicalScore(
  document: ItemDocument,
  tokens: string[],
  normalizedQuery: string,
  includeLinked: boolean,
  linkedCorpusById: Map<string, string>,
  tuning: SearchTuning,
  idPrefix: string,
  applyCoverageBonus = false,
): SearchHit | null {
  /* c8 ignore start -- linked corpus presence branch is covered by keyword/hybrid integration query tests */
  return scoreDocument(
    document,
    tokens,
    normalizedQuery,
    includeLinked ? linkedCorpusById.get(document.metadata.id) ?? "" : "",
    tuning,
    idPrefix,
    applyCoverageBonus,
  );
  /* c8 ignore stop */
}

function normalizeScoreMap(scoreById: Map<string, number>): Map<string, number> {
  if (scoreById.size === 0) {
    return new Map();
  }
  const values = [...scoreById.values()];
  const minScore = Math.min(...values);
  const maxScore = Math.max(...values);
  if (maxScore === minScore) {
    return new Map([...scoreById.keys()].map((id) => [id, 1]));
  }
  const normalized = new Map<string, number>();
  for (const [id, score] of scoreById) {
    normalized.set(id, (score - minScore) / (maxScore - minScore));
  }
  return normalized;
}

/**
 * Implements resolve search max results for the public runtime surface of this module.
 */
export function resolveSearchMaxResults(settings: unknown): number {
  const candidate = (settings as { search?: { max_results?: unknown } }).search?.max_results;
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
    return Math.floor(candidate);
  }
  return 50;
}

/**
 * Implements resolve search score threshold for the public runtime surface of this module.
 */
export function resolveSearchScoreThreshold(settings: unknown): number {
  const candidate = (settings as { search?: { score_threshold?: unknown } }).search?.score_threshold;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return candidate;
  }
  return 0;
}

/**
 * Implements resolve hybrid semantic weight for the public runtime surface of this module.
 */
export function resolveHybridSemanticWeight(settings: unknown): number {
  const candidate = (settings as { search?: { hybrid_semantic_weight?: unknown } }).search?.hybrid_semantic_weight;
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 && candidate <= 1) {
    return candidate;
  }
  return 0.7;
}

/**
 * Implements resolve search tuning for the public runtime surface of this module.
 */
export function resolveSearchTuning(settings: unknown): SearchTuning {
  const defaults: SearchTuning = {
    title_exact_bonus: 10,
    title_weight: 8,
    description_weight: 5,
    tags_weight: 6,
    status_weight: 2,
    body_weight: 1,
    comments_weight: 1,
    notes_weight: 1,
    learnings_weight: 1,
    reminders_weight: 2,
    events_weight: 2,
    dependencies_weight: 3,
    linked_content_weight: 1,
  };
  const tuning = (settings as { search?: { tuning?: Partial<SearchTuning> } }).search?.tuning;
  if (!tuning) return defaults;

  const resolveWeight = (candidate: unknown, fallback: number) => {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
    return fallback;
  };

  return {
    title_exact_bonus: resolveWeight(tuning.title_exact_bonus, defaults.title_exact_bonus),
    title_weight: resolveWeight(tuning.title_weight, defaults.title_weight),
    description_weight: resolveWeight(tuning.description_weight, defaults.description_weight),
    tags_weight: resolveWeight(tuning.tags_weight, defaults.tags_weight),
    status_weight: resolveWeight(tuning.status_weight, defaults.status_weight),
    body_weight: resolveWeight(tuning.body_weight, defaults.body_weight),
    comments_weight: resolveWeight(tuning.comments_weight, defaults.comments_weight),
    notes_weight: resolveWeight(tuning.notes_weight, defaults.notes_weight),
    learnings_weight: resolveWeight(tuning.learnings_weight, defaults.learnings_weight),
    reminders_weight: resolveWeight(tuning.reminders_weight, defaults.reminders_weight),
    events_weight: resolveWeight(tuning.events_weight, defaults.events_weight),
    dependencies_weight: resolveWeight(tuning.dependencies_weight, defaults.dependencies_weight),
    linked_content_weight: resolveWeight(tuning.linked_content_weight, defaults.linked_content_weight),
  };
}

/* c8 ignore start -- empty-result projection/count/warnings shape matrix is validated by integration response-contract tests */
function emptySearchResult(
  query: string,
  mode: SearchMode,
  matchMode: SearchMatchMode,
  options: SearchOptions,
  includeLinked: boolean,
  scoreThreshold: number,
  hybridSemanticWeight: number,
  queryExpansion: QueryExpansionConfig,
  rerank: RerankConfig,
  projection: SearchProjectionConfig,
  warnings: string[],
  runtimeFieldFilters?: Record<string, unknown>,
  countOnly = false,
): SearchResult {
  // --count consistency: a count-only query that matches nothing must still
  // carry the same { count_only: true, total } shape as the non-empty path.
  const countExtras = countOnly ? { total: 0, count_only: true } : {};
  const compactSummaryMode = projection.mode === "compact" && options.compact === true;
  if (compactSummaryMode) {
    const compactFilters = buildCompactSearchFilterSummary({
      mode,
      matchMode,
      options,
      includeLinked,
      titleExact: options.titleExact === true,
      phraseExact: options.phraseExact === true,
      scoreThreshold,
      hybridSemanticWeight,
      runtimeFieldFilters,
    });
    return {
      query: query.trim(),
      mode,
      items: [],
      count: 0,
      ...countExtras,
      filters: compactFilters,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
  const projectionFields = projection.mode === "full" ? null : [...projection.fields];
  return {
    query: query.trim(),
    mode,
    items: [],
    count: 0,
    ...countExtras,
    filters: buildVerboseSearchFilters({
      effectiveMode: mode,
      matchMode,
      options,
      includeLinked,
      titleExact: options.titleExact === true,
      phraseExact: options.phraseExact === true,
      scoreThreshold,
      hybridSemanticWeight,
      queryExpansion,
      rerank,
      runtimeFieldFilters: runtimeFieldFilters ?? {},
    }),
    projection: {
      mode: projection.mode,
      fields: projectionFields,
    },
    now: nowIso(),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
/* c8 ignore stop */

function requireSemanticDependencies(
  requestedMode: Exclude<SearchMode, "keyword">,
  providerResolution: EmbeddingProviderResolution,
  vectorResolution: VectorStoreResolution,
  hasExtensionVectorQuery: boolean,
): { provider: EmbeddingProviderConfig; vectorStore: VectorStoreConfig | null } {
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

const toOptionalNonEmptyString = toNonEmptyStringOrUndefined;

interface ExtensionSearchProviderHooks {
  providerName: string;
  query?: ExtensionSearchProviderQuery;
  queryExpansion?: ExtensionSearchProviderQueryExpansion;
  rerank?: ExtensionSearchProviderRerank;
}

/* c8 ignore start -- extension search-provider registration permutations are covered by extension integration suites */
function resolveExtensionSearchProviderByName(providerName: string | undefined): ExtensionSearchProviderHooks | null {
  const registrations = getActiveExtensionRegistrations();
  const resolved = resolveRegisteredSearchProvider(registrations, providerName);
  if (!resolved) {
    return null;
  }
  const runtimeDefinition = resolved.runtime_definition ?? resolved.definition;
  const query = (runtimeDefinition as { query?: unknown }).query;
  const queryExpansion =
    (runtimeDefinition as { queryExpansion?: unknown; query_expansion?: unknown }).queryExpansion ??
    (runtimeDefinition as { queryExpansion?: unknown; query_expansion?: unknown }).query_expansion;
  const rerank = (runtimeDefinition as { rerank?: unknown }).rerank;
  const registeredName =
    toOptionalNonEmptyString((runtimeDefinition as { name?: unknown }).name) ??
    toOptionalNonEmptyString((resolved.definition as { name?: unknown }).name) ??
    providerName;
  /* c8 ignore next 2 -- providerName is required for lookup and remains a non-empty fallback */
  if (!registeredName) {
    return null;
  }
  const hooks: ExtensionSearchProviderHooks = {
    providerName: registeredName,
    ...(typeof query === "function" ? { query: query as ExtensionSearchProviderQuery } : {}),
    ...(typeof queryExpansion === "function"
      ? { queryExpansion: queryExpansion as ExtensionSearchProviderQueryExpansion }
      : {}),
    ...(typeof rerank === "function" ? { rerank: rerank as ExtensionSearchProviderRerank } : {}),
  };
  if (!hooks.query && !hooks.queryExpansion && !hooks.rerank) {
    return null;
  }
  return hooks;
}
/* c8 ignore stop */

function resolveExtensionSearchProvider(settings: PmSettings): { providerName: string; query: ExtensionSearchProviderQuery } | null {
  const providerName = toOptionalNonEmptyString((settings.search as { provider?: unknown } | undefined)?.provider);
  const resolved = resolveExtensionSearchProviderByName(providerName);
  if (!resolved?.query) {
    return null;
  }
  return {
    providerName: resolved.providerName,
    query: resolved.query,
  };
}

/* c8 ignore start -- vector adapter runtime definition permutations are covered by extension integration suites */
function resolveExtensionVectorAdapter(settings: PmSettings): ExtensionVectorAdapter | null {
  const registrations = getActiveExtensionRegistrations();
  const adapterName = toOptionalNonEmptyString((settings.vector_store as { adapter?: unknown } | undefined)?.adapter);
  const resolved = resolveRegisteredVectorStoreAdapter(registrations, adapterName);
  if (!resolved) {
    return null;
  }
  const runtimeDefinition = resolved.runtime_definition ?? resolved.definition;
  const query = (runtimeDefinition as { query?: unknown }).query;
  if (typeof query !== "function") {
    return null;
  }
  return {
    query: query as ExtensionVectorQuery,
  };
}
/* c8 ignore stop */

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
    if (!id || typeof score !== "number" || !Number.isFinite(score) || seen.has(id)) {
      continue;
    }
    const document = filteredById.get(id);
    if (!document) {
      continue;
    }
    const matchedFieldsRaw = (rawHit as { matched_fields?: unknown }).matched_fields;
    const matchedFields =
      Array.isArray(matchedFieldsRaw) && matchedFieldsRaw.every((entry) => typeof entry === "string")
        ? [...new Set((matchedFieldsRaw as string[]).map((entry) => entry.trim()).filter((entry) => entry.length > 0))].sort((a, b) =>
            a.localeCompare(b),
          )
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
function forceExactIdHitsToTop(rankedHits: SearchHit[], keywordHits: SearchHit[]): SearchHit[] {
  const exactIdHits = keywordHits.filter((hit) => hit.exact_id_match === true);
  if (exactIdHits.length === 0) {
    return rankedHits;
  }
  const exactIdIds = new Set(exactIdHits.map((hit) => hit.item.id));
  const remaining = rankedHits.filter((hit) => !exactIdIds.has(hit.item.id));
  // reduce (not Math.max(...spread)) so a very large pre-truncation candidate
  // set can never overflow the call stack.
  const maxRemainingScore = remaining.reduce((max, hit) => Math.max(max, hit.score), 0);
  // Full-ID hits (score 1000) must rank above short-ID hits (score 900): rank
  // within the exact-ID band by the original keyword score (descending) so a
  // full-ID match always precedes a short-ID match for the same query, then
  // offset the whole band above every remaining hit. ids are unique, so two
  // exact-ID hits can never tie on score — sorting on score alone is total.
  // exactIdHits is already a fresh array from keywordHits.filter(...), so sort
  // it in place — no defensive copy needed.
  const orderedExactHits = exactIdHits.sort((left, right) => right.score - left.score);
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
  const keywordScores = new Map(keywordHits.map((entry) => [entry.item.id, entry.score]));
  const keywordMatches = new Map(keywordHits.map((entry) => [entry.item.id, entry.matched_fields]));
  const normalizedSemantic = normalizeScoreMap(semanticScores);
  const normalizedKeyword = normalizeScoreMap(keywordScores);
  const candidateIds = new Set<string>([...semanticScores.keys(), ...keywordScores.keys()]);
  const keywordWeight = 1 - hybridSemanticWeight;
  return [...candidateIds]
    .map((id) => {
      const document = filteredById.get(id)!;
      const semanticScore = normalizedSemantic.get(id) ?? 0;
      const keywordScore = normalizedKeyword.get(id) ?? 0;
      const combinedScore = (semanticScore * hybridSemanticWeight) + (keywordScore * keywordWeight);
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

/**
 * Built-in BM25 activation outcome for semantic/hybrid search (pm-75k9):
 * - `"explicit"`: `search.provider` is `bm25` — the user opted into offline
 *   lexical ranking, so it is used even if an embedding provider is configured.
 * - `"auto-fallback"`: `search.provider` is `auto` and neither an embedding
 *   provider nor an extension search provider is available — BM25 is used in
 *   place of degrading to the naive field-weighted keyword scorer.
 * - `null`: BM25 does not apply; the existing embedding/extension path runs.
 */
type BuiltInBm25Mode = "explicit" | "auto-fallback";

function resolveBuiltInBm25Mode(params: {
  configuredProvider: string | undefined;
  hasEmbeddingProvider: boolean;
  hasExtensionSearchProvider: boolean;
}): BuiltInBm25Mode | null {
  const normalized = params.configuredProvider?.trim().toLowerCase();
  if (normalized === "bm25") {
    return "explicit";
  }
  if (normalized === "auto" && !params.hasEmbeddingProvider && !params.hasExtensionSearchProvider) {
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
    text: flattenSearchCorpusText(buildSearchCorpus(document, { fields: params.corpusFields })),
  }));
  const index = buildBm25Index(bm25Documents);
  const bm25Scores = scoreBm25Query(index, tokenizeBm25(params.query), params.bm25Params);
  const filteredById = new Map(params.filteredDocuments.map((document) => [document.metadata.id, document]));
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
  queryExpansionExtension: { providerName: string; expand: ExtensionSearchProviderQueryExpansion } | null;
  rerank: RerankConfig;
  rerankExtension: { providerName: string; rerank: ExtensionSearchProviderRerank } | null;
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

function mergeVectorHitsById(vectorHitGroups: VectorQueryHit[][]): VectorQueryHit[] {
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

/* c8 ignore start -- rerank corpus metadata-shape permutations are covered by semantic integration tests */
function buildRerankCorpus(document: ItemDocument): string {
  const metadata = (document as { metadata?: ItemDocument["metadata"] | null }).metadata;
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
/* c8 ignore stop */

/* c8 ignore start -- semantic expansion/rerank fallback matrices are covered by end-to-end semantic search tests */
async function computeSemanticOrHybridHits(context: SemanticQueryContext): Promise<SemanticQueryResult> {
  const semanticLimit = context.limit ?? context.maxResults;
  const embeddingOptions = context.embeddingTimeoutMs !== undefined ? { timeout_ms: context.embeddingTimeoutMs } : {};
  const vectorQueryOptions = context.vectorQueryTimeoutMs !== undefined ? { timeout_ms: context.vectorQueryTimeoutMs } : {};
  const queryTrimmed = context.query.trim();
  const baseExpandedQueries = context.queryExpansion.enabled
    ? buildDeterministicQueryExpansions(queryTrimmed, context.queryExpansion.max_queries)
    : [queryTrimmed];
  let expandedQueries = baseExpandedQueries.length > 0 ? baseExpandedQueries : [queryTrimmed];
  if (context.queryExpansion.enabled) {
    if (context.queryExpansionExtension?.expand) {
      try {
        const rawExpansion = await Promise.resolve(
          context.queryExpansionExtension.expand({
            query: queryTrimmed,
            mode: context.requestedMode,
            settings: context.settings,
          }),
        );
        const extensionExpansion = normalizeQueryExpansionOutput(rawExpansion);
        expandedQueries = mergeQueryExpansions(expandedQueries, extensionExpansion, context.queryExpansion.max_queries);
      } catch {
        context.warnings.push(
          `search_query_expansion_provider_failed:${context.queryExpansionExtension.providerName}:using_builtin`,
        );
      }
    } else if (
      context.queryExpansion.provider &&
      context.queryExpansion.provider !== "openai" &&
      context.queryExpansion.provider !== "ollama"
    ) {
      context.warnings.push(
        `search_query_expansion_provider_unavailable:${context.queryExpansion.provider}:using_builtin`,
      );
    }
  }

  const queryVectors = await executeEmbeddingRequest(context.provider, expandedQueries, embeddingOptions);

  const executeVectorQueryWithFallback = async (semanticVector: number[]): Promise<VectorQueryHit[]> => {
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
        return await executeVectorQuery(context.vectorStore, semanticVector, semanticLimit, vectorQueryOptions);
      }
    }
    if (context.vectorStore) {
      return await executeVectorQuery(context.vectorStore, semanticVector, semanticLimit, vectorQueryOptions);
    }
    throw new PmCliError(
      "Semantic search requires either a configured vector store or an extension vector adapter query handler",
      EXIT_CODE.USAGE,
    );
  };

  const queryVectorGroups = await Promise.all(
    queryVectors.map(async (semanticVector) => await executeVectorQueryWithFallback(semanticVector)),
  );
  const vectorHits = mergeVectorHitsById(queryVectorGroups);
  const filteredById = new Map(context.filteredDocuments.map((document) => [document.metadata.id, document]));
  const { semanticHits, semanticScores } = buildSemanticHits(vectorHits, filteredById);
  const vectorMatchCount = semanticScores.size;
  if (context.requestedMode === "semantic") {
    // GH-281: guarantee an exact full-ID / short-ID match ranks #1 even in pure
    // semantic mode, where it otherwise carries no vector hit at all.
    return { hits: forceExactIdHitsToTop(semanticHits, context.keywordHits), vectorMatchCount };
  }
  let hybridHits = combineHybridHits(filteredById, semanticScores, context.keywordHits, context.hybridSemanticWeight);
  if (context.rerank.enabled && hybridHits.length > 1) {
    const sortedForCandidates = [...hybridHits].sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.item.id.localeCompare(right.item.id);
    });
    const candidateHits = sortedForCandidates.slice(0, context.rerank.top_k);
    const candidateContexts = candidateHits
      .map((hit) => {
        const document = filteredById.get(hit.item.id);
        if (!document) {
          return null;
        }
        return { hit, text: buildRerankCorpus(document) };
      })
      .filter((entry): entry is { hit: SearchHit; text: string } => entry !== null);
    const rerankCandidates: RerankCandidate[] = candidateContexts.map((entry) => ({
      id: entry.hit.item.id,
      text: entry.text,
    }));
    let rerankScores: Map<string, number> | null = null;
    if (context.rerankExtension?.rerank) {
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
          rerankScores = new Map(normalizedRerank.map((entry) => [entry.id, entry.score]));
        } else {
          context.warnings.push(
            `search_rerank_provider_invalid_response:${context.rerankExtension.providerName}:using_builtin`,
          );
        }
      } catch {
        context.warnings.push(`search_rerank_provider_failed:${context.rerankExtension.providerName}:using_builtin`);
      }
    }
    if (!rerankScores) {
      try {
        rerankScores = await rerankCandidatesWithEmbeddings(
          context.provider,
          context.rerank.model,
          queryTrimmed,
          rerankCandidates,
          context.embeddingTimeoutMs,
        );
      } catch {
        context.warnings.push("search_rerank_failed:using_hybrid_scores");
      }
    }
    if (rerankScores && rerankScores.size > 0) {
      const rerankedIds = new Set(rerankScores.keys());
      hybridHits = hybridHits.map((hit) => {
        const rerankScore = rerankScores.get(hit.item.id);
        if (rerankScore === undefined) {
          return hit;
        }
        const matchedFields = new Set(hit.matched_fields);
        matchedFields.add("rerank");
        return {
          ...hit,
          score: rerankScore,
          matched_fields: [...matchedFields].sort((left, right) => left.localeCompare(right)),
        };
      });
      hybridHits.sort((left, right) => {
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
    }
  }
  return {
    // GH-281: applied LAST (after any rerank reordering) so an exact full-ID /
    // short-ID keyword match always ranks #1 in hybrid mode regardless of the
    // semantic blend weight or rerank scores.
    hits: forceExactIdHitsToTop(hybridHits, context.keywordHits),
    vectorMatchCount,
  };
}
/* c8 ignore stop */

/* c8 ignore start -- item body fallback read-path combinations are covered by document-cache integration tests */
async function loadDocuments(
  pmRoot: string,
  itemFormat: ItemFormat,
  typeToFolder: Record<string, string>,
  schema: PmSettings["schema"],
): Promise<{ documents: ItemDocument[]; warnings: string[] }> {
  const extensionFieldNames = collectRegisteredItemFieldNames(getActiveExtensionRegistrations());
  const readDocumentBody = async (
    metadata: ItemFrontMatter,
    preferredPath: string,
    preferredFormat: ItemFormat,
  ): Promise<string> => {
    const tryRead = async (targetPath: string, format: ItemFormat): Promise<string> => {
      await runActiveOnReadHooks({ path: targetPath, scope: "project" });
      const raw = await fs.readFile(targetPath, "utf8");
      const parsed = parseItemDocument(raw, {
        format,
        schema,
        extensionFieldNames,
        onWarning: (warning) => listWarnings.push(warning),
      });
      return parsed.body;
    };

    try {
      return await tryRead(preferredPath, preferredFormat);
    } catch {
      const alternateFormat: ItemFormat = preferredFormat === "toon" ? "json_markdown" : "toon";
      const alternatePath = getItemPath(pmRoot, metadata.type as ItemType, metadata.id, alternateFormat, typeToFolder);
      try {
        return await tryRead(alternatePath, alternateFormat);
      } catch {
        listWarnings.push(`item_list_item_read_failed:${path.relative(pmRoot, alternatePath)}`);
        return "";
      }
    }
  };

  const listWarnings: string[] = [];
  const cachedDocuments = await listAllDocumentCandidatesCached(pmRoot, itemFormat, typeToFolder, listWarnings, schema);
  const documents: ItemDocument[] = [];
  if (cachedDocuments.length === 0) {
    const frontMatterDocuments = await listAllFrontMatter(pmRoot, itemFormat, typeToFolder, listWarnings, schema);
    for (const metadata of frontMatterDocuments) {
      const preferredPath = getItemPath(pmRoot, metadata.type as ItemType, metadata.id, itemFormat, typeToFolder);
      const body = await readDocumentBody(metadata, preferredPath, itemFormat);
      documents.push({ metadata, body });
    }
    return {
      documents,
      warnings: [...new Set(listWarnings)].sort((left, right) => left.localeCompare(right)),
    };
  }

  for (const cachedDocument of cachedDocuments) {
    if (typeof cachedDocument.body === "string") {
      documents.push({
        metadata: cachedDocument.metadata,
        body: cachedDocument.body,
      });
      continue;
    }
    const body = await readDocumentBody(cachedDocument.metadata, cachedDocument.item_path, cachedDocument.item_format);
    documents.push({
      metadata: cachedDocument.metadata,
      body,
    });
  }
  return {
    documents,
    warnings: [...new Set(listWarnings)].sort((left, right) => left.localeCompare(right)),
  };
}
/* c8 ignore stop */

/* c8 ignore start -- field projection lookup precedence is validated by output-shaping integration tests */
function readSearchFieldValue(hit: SearchHit, field: string): unknown {
  const normalized = field.trim();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized === "score") {
    return hit.score;
  }
  if (normalized === "matched_fields") {
    return hit.matched_fields;
  }
  if (normalized.startsWith("item.")) {
    const itemKey = normalized.slice("item.".length);
    if (itemKey.length === 0) {
      return null;
    }
    const itemRecord = toItemRecord(hit.item);
    return itemRecord[itemKey] ?? null;
  }
  const hitRecord = hit as unknown as Record<string, unknown>;
  const itemRecord = toItemRecord(hit.item);
  if (Object.prototype.hasOwnProperty.call(itemRecord, normalized)) {
    return itemRecord[normalized] ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(hitRecord, normalized)) {
    return hitRecord[normalized] ?? null;
  }
  return null;
}
/* c8 ignore stop */

function projectSearchHits(hits: SearchHit[], projection: SearchProjectionConfig): SearchResultItem[] {
  if (projection.mode === "full") {
    // matched_all_terms is an internal ranking signal (GH-181); strip it from
    // full-mode output rows so the public hit shape stays { item, score, matched_fields }.
    return hits.map(({ matched_all_terms: _matchedAllTerms, ...hit }) => hit);
  }
  return hits.map((hit) => {
    const projected: Record<string, unknown> = {};
    for (const field of projection.fields) {
      projected[field] = readSearchFieldValue(hit, field);
    }
    return projected;
  });
}

/**
 * Implements run search for the public runtime surface of this module.
 */
export async function runSearch(rawQuery: string, rawOptions: SearchOptions, global: GlobalOptions): Promise<SearchResult> {
  // GH-157 inline query syntax: pull `field:value` filter tokens out of the raw
  // query before any other parsing. Explicit flags win — an inline token only
  // applies when its flag is unset, and a conflicting token surfaces as a
  // warning. The residual keyword text drives tokenization/scoring as usual.
  const inlineWarnings: string[] = [];
  const inlineParse = parseInlineQueryFilters(rawQuery);
  const hasInlineFilters = Object.keys(inlineParse.inlineFilters).length > 0;
  if (hasInlineFilters && inlineParse.residualQuery.trim().length === 0) {
    throw new PmCliError(
      "Inline field:value tokens consumed the entire query, leaving no search terms.",
      EXIT_CODE.USAGE,
      {
        examples: ["pm search auth tag:area:search", "pm list --tag area:search --status open"],
        nextSteps: [
          "Add keyword terms alongside the inline filters, or use pm list for pure tag/status/type/priority filtering.",
        ],
      },
    );
  }
  const query = hasInlineFilters ? inlineParse.residualQuery : rawQuery;
  const options = applyInlineQueryFilters(rawOptions, inlineParse.inlineFilters, inlineWarnings);
  const highlight = options.highlight === true;
  const includeLinked = parseIncludeLinked(options.includeLinked);
  const titleExact = parseTitleExact(options.titleExact);
  const phraseExact = parsePhraseExact(options.phraseExact);
  const matchMode = parseMatchMode(typeof options.matchMode === "string" ? options.matchMode : undefined);
  const minScoreOverride = parseMinScoreOverride(options.minScore);
  const countOnly = options.count === true;
  const tokens = parseTokens(query);
  const normalizedQuery = normalizeSearchPhrase(query);
  const limit = parseLimit(options.limit);
  const projection = parseProjectionConfig(options);
  const modeWasExplicit = typeof options.mode === "string" && options.mode.trim().length > 0;
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const storedSettings = await readSettings(pmRoot);
  const runtimeDefaultsResolution = resolveSettingsWithSemanticRuntimeDefaults(storedSettings);
  const settings = runtimeDefaultsResolution.settings;
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const runtimeFieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
  validateSearchProjectionFields(projection, runtimeFieldRegistry);
  const runtimeFieldFilters = collectRuntimeFilterValues(options as Record<string, unknown>, runtimeFieldRegistry, "search");
  // `pm search --status` resolves strictly (a typo'd status surfaces a
  // did-you-mean hint) so agents can scope retrieval to open work and drop
  // closed-history noise without re-listing. Resolved before the corpus scan so
  // an invalid value fails fast.
  const statusFilter = parseStatusFilterCsv(
    typeof options.status === "string" ? options.status : undefined,
    statusRegistry,
    { strict: true },
  );
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const maxResults = resolveSearchMaxResults(settings);
  // pm-cstl: --min-score overrides the persistent search.score_threshold for this
  // query only; the effective threshold is reflected in filters.score_threshold.
  const scoreThreshold = minScoreOverride ?? resolveSearchScoreThreshold(settings);
  const semanticWeightProvided = options.semanticWeight !== undefined;
  const semanticWeightOverride = parseSemanticWeightOverride(options.semanticWeight);
  const hybridSemanticWeight = semanticWeightOverride ?? resolveHybridSemanticWeight(settings);
  const tuning = resolveSearchTuning(settings);
  const providerResolution = resolveEmbeddingProviders(settings);
  const vectorResolution = resolveVectorStores(settings);
  const extensionSearchProvider = resolveExtensionSearchProvider(settings);
  const extensionVectorAdapter = resolveExtensionVectorAdapter(settings);
  // pm-75k9: offline BM25 lexical provider. When active, a semantic/hybrid query
  // ranks the corpus locally with BM25 instead of requiring an embedding service
  // + vector store — enabling dense-quality offline retrieval in air-gapped, CI,
  // and zero-setup environments. Resolved here so the semantic block can branch.
  const bm25Mode = resolveBuiltInBm25Mode({
    configuredProvider: toOptionalNonEmptyString(settings.search?.provider),
    hasEmbeddingProvider: providerResolution.active !== null,
    hasExtensionSearchProvider: extensionSearchProvider !== null,
  });
  const queryExpansion = resolveQueryExpansionConfig(settings, providerResolution.active?.name ?? null);
  const rerank = resolveRerankConfig(
    settings,
    providerResolution.active?.model ?? toOptionalNonEmptyString(settings.search?.embedding_model) ?? "text-embedding-3-small",
  );
  const queryExpansionProvider = resolveExtensionSearchProviderByName(queryExpansion.provider ?? undefined);
  const queryExpansionExtension = queryExpansionProvider?.queryExpansion
    ? { providerName: queryExpansionProvider.providerName, expand: queryExpansionProvider.queryExpansion }
    : null;
  const rerankProvider = resolveExtensionSearchProviderByName(toOptionalNonEmptyString(settings.search?.provider));
  const rerankExtension = rerankProvider?.rerank
    ? { providerName: rerankProvider.providerName, rerank: rerankProvider.rerank }
    : null;
  let effectiveMode = parseMode(options.mode, {
    hasProvider: providerResolution.active !== null || extensionSearchProvider !== null,
    hasVectorStore: vectorResolution.active !== null || extensionVectorAdapter !== null,
  });
  const loadedDocuments = await loadDocuments(
    pmRoot,
    settings.item_format ?? "toon",
    typeRegistry.type_to_folder,
    settings.schema,
  );
  const warnings = loadedDocuments.warnings;
  if (inlineWarnings.length > 0) {
    warnings.push(...inlineWarnings);
  }
  if (effectiveMode === "hybrid" && semanticWeightProvided && semanticWeightOverride === undefined) {
    warnings.push("search_hybrid_semantic_weight_override_invalid:using_settings_default");
  }
  const allDocuments = loadedDocuments.documents;
  const lifecycleClassifier = lifecycleClassifierFromStatusRegistry(statusRegistry);
  const metadataFilteredDocuments = applyFilters(
    allDocuments,
    options,
    typeRegistry,
    runtimeFieldFilters,
    statusFilter,
    lifecycleClassifier,
  );
  const filteredDocuments = applyExactQueryFilters(metadataFilteredDocuments, normalizedQuery, {
    titleExact,
    // --match-mode exact reuses the exact-phrase containment logic so the whole
    // normalized query must appear as a contiguous phrase in some searchable field.
    phraseExact: phraseExact || matchMode === "exact",
  });
  if (effectiveMode === "keyword" && (filteredDocuments.length === 0 || limit === 0)) {
    return emptySearchResult(
      query,
      effectiveMode,
      matchMode,
      options,
      includeLinked,
      scoreThreshold,
      hybridSemanticWeight,
      queryExpansion,
      rerank,
      projection,
      warnings,
      runtimeFieldFilters,
      countOnly,
    );
  }

  const projectRoot = process.cwd();
  const globalRoot = resolveGlobalPmRoot(projectRoot);
  const linkedCorpusById = new Map<string, string>();
  if (includeLinked && (effectiveMode === "keyword" || effectiveMode === "hybrid")) {
    const linkedCorpusRoots = await resolveLinkedCorpusRoots(projectRoot, globalRoot);
    const linkedCorpusEntries = await Promise.all(
      filteredDocuments.map(async (document) => [document.metadata.id, await loadLinkedCorpus(document, linkedCorpusRoots)] as const),
    );
    for (const [id, corpus] of linkedCorpusEntries) {
      linkedCorpusById.set(id, corpus);
    }
  }

  // GH-181: the all-terms coverage RANKING bonus only applies in default OR mode
  // (no hard term filter) so multi-term queries prefer items covering all tokens.
  // and/exact modes hard-filter instead, so the additive bonus would be redundant.
  const applyCoverageBonus = matchMode === "or";
  const keywordHits = filteredDocuments
    .map((document) =>
      buildHybridLexicalScore(
        document,
        tokens,
        normalizedQuery,
        // Linked corpus is only collected into linkedCorpusById when the user
        // passed --include-linked (and mode is keyword/hybrid), so pass the
        // parsed flag directly rather than re-deriving it from the mode.
        includeLinked,
        linkedCorpusById,
        tuning,
        settings.id_prefix,
        applyCoverageBonus,
      ),
    )
    .filter((entry): entry is SearchHit => entry !== null)
    // --match-mode and: hard-filter to items where EVERY distinct query token
    // matched some searchable field.
    .filter((entry) => matchMode !== "and" || entry.matched_all_terms === true);

  let hits = keywordHits;
  // pm-75k9: offline BM25 path. Runs entirely in-process (no embedding service,
  // vector store, or HTTP), so it sits OUTSIDE the semantic try/catch fallback
  // block below — it cannot fail on a backend error. Empty corpus / limit-0 are
  // handled by the shared threshold+limit path that follows, so no early-return
  // guard is needed here.
  const useBuiltInBm25 = bm25Mode !== null && effectiveMode !== "keyword";
  if (bm25Mode !== null && effectiveMode !== "keyword") {
    hits = computeBuiltInBm25Hits({
      requestedMode: effectiveMode,
      query,
      filteredDocuments,
      keywordHits,
      corpusFields: resolveSearchCorpusFields(settings),
      bm25Params: resolveBm25Params(settings),
      hybridSemanticWeight,
    });
    if (bm25Mode === "auto-fallback") {
      warnings.push(`search_${effectiveMode}_offline_bm25:no_embedding_provider:using_lexical_bm25`);
    }
  }
  /* c8 ignore start -- semantic/provider fallback + compact/count warning-shape permutations are covered by integration command-contract tests */
  if (effectiveMode !== "keyword" && !useBuiltInBm25) {
    // Surface vector-index staleness once per query so agents notice when a
    // refresh is overdue. Only emitted when:
    //   (1) the user explicitly asked for semantic/hybrid mode (implicit
    //       upgrades fall back silently to keyword on any failure path below
    //       and shouldn't carry noise), AND
    //   (2) the BUILT-IN semantic path is what will run — an extension search
    //       provider has its own indexing lifecycle and the local ledger we
    //       read is irrelevant to it.
    const builtInSemanticWillRun =
      !extensionSearchProvider &&
      providerResolution.active !== null &&
      (vectorResolution.active !== null || extensionVectorAdapter !== null);
    if (modeWasExplicit && builtInSemanticWillRun) {
      await maybeEmitVectorIndexStaleWarning(pmRoot, filteredDocuments, warnings);
    }
    try {
      if (!extensionSearchProvider) {
        requireSemanticDependencies(effectiveMode, providerResolution, vectorResolution, extensionVectorAdapter !== null);
      }
      if (filteredDocuments.length === 0 || limit === 0) {
        return emptySearchResult(
          query,
          effectiveMode,
          matchMode,
          options,
          includeLinked,
          scoreThreshold,
          hybridSemanticWeight,
          queryExpansion,
          rerank,
          projection,
          warnings,
          runtimeFieldFilters,
          countOnly,
        );
      }
      const filteredById = new Map(filteredDocuments.map((document) => [document.metadata.id, document]));
      const canUseBuiltInSemantic =
        providerResolution.active !== null && (vectorResolution.active !== null || extensionVectorAdapter !== null);
      if (extensionSearchProvider) {
        try {
          const providerResponse = await Promise.resolve(
            extensionSearchProvider.query({
              query,
              mode: effectiveMode,
              tokens,
              options,
              settings,
              documents: filteredDocuments,
            }),
          );
          hits = normalizeExtensionProviderHits(extensionSearchProvider.providerName, providerResponse, filteredById);
        } catch (error: unknown) {
          if (!canUseBuiltInSemantic) {
            throw new PmCliError(
              `Extension search provider "${extensionSearchProvider.providerName}" failed: ${error instanceof Error ? error.message : String(error)}`,
              EXIT_CODE.GENERIC_FAILURE,
            );
          }
        }
      }
      if (hits === keywordHits) {
        const implicitHybridMode = !modeWasExplicit && effectiveMode === "hybrid";
        const { provider, vectorStore } = requireSemanticDependencies(
          effectiveMode,
          providerResolution,
          vectorResolution,
          extensionVectorAdapter !== null,
        );
        const semanticResult = await computeSemanticOrHybridHits({
          requestedMode: effectiveMode,
          query,
          filteredDocuments,
          keywordHits,
          hybridSemanticWeight,
          limit,
          maxResults,
          provider,
          vectorStore,
          extensionVectorAdapter,
          queryExpansion,
          queryExpansionExtension,
          rerank,
          rerankExtension,
          warnings,
          settings,
          /* c8 ignore next 5 -- reserved for future implicit-hybrid auto-mode; current parseMode defaults keyword when mode is omitted */
          ...(implicitHybridMode
            ? {
                embeddingTimeoutMs: IMPLICIT_HYBRID_EMBEDDING_TIMEOUT_MS,
                vectorQueryTimeoutMs: IMPLICIT_HYBRID_VECTOR_TIMEOUT_MS,
              }
            : {}),
        });
        hits = semanticResult.hits;
        // The semantic/hybrid query ran without error, but vector ranking
        // contributed no hits for this query/filter set. Pure semantic mode would
        // otherwise return an empty set, so degrade to the locally computed
        // keyword hits (hybrid already blends them in) and warn so agents do not
        // mistake them for true vector ranking. The reported mode is left
        // unchanged; the warning is the signal.
        if (semanticResult.vectorMatchCount === 0) {
          if (effectiveMode === "semantic") {
            hits = keywordHits;
          }
          warnings.push(`search_${effectiveMode}_degraded:no_vector_matches:results_are_lexical`);
        }
      }
    } catch (error: unknown) {
      // Any semantic/hybrid attempt that fails (backend down, timeout, or the
      // project is not configured for semantic search) degrades to keyword mode
      // so agents are never blocked. Keyword hits are always computed locally
      // before this point, so the fallback is guaranteed to succeed.
      const fallbackWarning = modeWasExplicit
        ? buildExplicitSemanticFallbackWarning(effectiveMode, error)
        /* c8 ignore next -- reserved for future implicit semantic/hybrid auto-mode fallback */
        : buildImplicitSemanticFallbackWarning(error);
      effectiveMode = "keyword";
      hits = keywordHits;
      warnings.push(fallbackWarning);
    }
  }

  // GH-281: an exact full-ID / short-ID match is always retained regardless of
  // the (possibly user-raised --min-score) threshold so the exact-target lookup
  // is never silently dropped in any mode.
  const thresholded = hits.filter((entry) => entry.exact_id_match === true || entry.score >= scoreThreshold);
  const sorted = sortHits(thresholded, statusRegistry);
  // total = matched hits after filters + threshold, BEFORE limit truncation.
  const total = sorted.length;
  // GH-181: keyword mode now also falls back to the configured max_results (50)
  // default when --limit is omitted, so a broad query no longer returns ALL hits.
  const resolvedLimit = limit ?? maxResults;
  const limited = sorted.slice(0, resolvedLimit);
  const projectionFields = projection.mode === "full" ? null : [...projection.fields];
  const compactSummaryMode = projection.mode === "compact" && options.compact === true;

  // --count: count-only response. Skips projecting/returning hit rows entirely so
  // an agent asking "how many" pays minimal tokens. `count` carries the matched
  // total (post-filter, post-threshold, pre-limit).
  if (countOnly) {
    if (compactSummaryMode) {
      const compactFilters = buildCompactSearchFilterSummary({
        mode: effectiveMode,
        matchMode,
        options,
        includeLinked,
        titleExact,
        phraseExact,
        scoreThreshold,
        hybridSemanticWeight,
        runtimeFieldFilters,
      });
      return {
        query: query.trim(),
        mode: effectiveMode,
        items: [],
        count: total,
        total,
        count_only: true,
        filters: compactFilters,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }
    return {
      query: query.trim(),
      mode: effectiveMode,
      items: [],
      count: total,
      total,
      count_only: true,
      filters: buildVerboseSearchFilters({
        effectiveMode,
        matchMode,
        options,
        includeLinked,
        titleExact,
        phraseExact,
        scoreThreshold,
        hybridSemanticWeight,
        queryExpansion,
        rerank,
        runtimeFieldFilters,
      }),
      projection: {
        mode: projection.mode,
        fields: projectionFields,
      },
      now: nowIso(),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  // GH-157 --highlight: attach per-field matched-text snippets to the returned
  // page of hits (only the post-limit slice pays the cost). In compact/fields
  // projections we add "highlights" to the projected field set so the snippets
  // are actually emitted; full mode already carries them on the hit.
  let projectedHits: SearchHit[] = limited;
  let effectiveProjection = projection;
  if (highlight) {
    const documentById = new Map(filteredDocuments.map((document) => [document.metadata.id, document]));
    projectedHits = limited.map((hit) => ({
      ...hit,
      highlights: buildHitHighlights(documentById.get(hit.item.id)!, hit.matched_fields, tokens),
    }));
    if (projection.mode !== "full" && !projection.fields.includes("highlights")) {
      effectiveProjection = { mode: projection.mode, fields: [...projection.fields, "highlights"] };
    }
  }
  const projectedItems = projectSearchHits(projectedHits, effectiveProjection);
  const finalProjectionFields = effectiveProjection.mode === "full" ? null : [...effectiveProjection.fields];
  // Surface the pre-limit total only when the limit actually dropped rows.
  const truncationExtras = limited.length < total ? { total } : {};
  if (compactSummaryMode) {
    const compactFilters = buildCompactSearchFilterSummary({
      mode: effectiveMode,
      matchMode,
      options,
      includeLinked,
      titleExact,
      phraseExact,
      scoreThreshold,
      hybridSemanticWeight,
      runtimeFieldFilters,
    });
    return {
      query: query.trim(),
      mode: effectiveMode,
      items: projectedItems,
      count: projectedItems.length,
      ...truncationExtras,
      filters: compactFilters,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
  /* c8 ignore stop */

  return {
    query: query.trim(),
    mode: effectiveMode,
    items: projectedItems,
    count: projectedItems.length,
    ...truncationExtras,
    filters: buildVerboseSearchFilters({
      effectiveMode,
      matchMode,
      options,
      includeLinked,
      titleExact,
      phraseExact,
      scoreThreshold,
      hybridSemanticWeight,
      queryExpansion,
      rerank,
      runtimeFieldFilters,
    }),
    projection: {
      mode: effectiveProjection.mode,
      fields: finalProjectionFields,
    },
    now: nowIso(),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
