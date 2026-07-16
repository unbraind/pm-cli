/**
 * @module sdk/query/search-rendering
 *
 * Builds stable compact and verbose filter projections for search responses.
 */
import {
  applyFilterValueEcho,
  buildContentFilterEcho,
  buildGovernanceMissingFilterEcho,
} from "./list.js";
import type { SearchMatchMode, SearchOptions } from "./search.js";

/** Search execution modes represented in response metadata. */
export type SearchMode = "keyword" | "semantic" | "hybrid";

interface SearchRenderingQueryExpansion {
  enabled: boolean;
  provider: string | null;
}

interface SearchRenderingRerank {
  enabled: boolean;
  model: string;
  top_k: number;
}

function isAllStatuses(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const tokens = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return tokens.length === 1 && tokens[0] === "all";
}

const COMPACT_SEARCH_VALUE_FILTER_ECHO_ENTRIES = [
  {
    optionKey: "status",
    summaryKey: "status",
    normalize: (value: unknown) => (isAllStatuses(value) ? "all" : value),
  },
  { optionKey: "type", summaryKey: "type" },
  { optionKey: "tag", summaryKey: "tag" },
  { optionKey: "priority", summaryKey: "priority" },
  { optionKey: "deadlineBefore", summaryKey: "deadline_before" },
  { optionKey: "deadlineAfter", summaryKey: "deadline_after" },
  { optionKey: "updatedAfter", summaryKey: "updated_after" },
  { optionKey: "updatedBefore", summaryKey: "updated_before" },
  { optionKey: "createdAfter", summaryKey: "created_after" },
  { optionKey: "createdBefore", summaryKey: "created_before" },
  { optionKey: "assignee", summaryKey: "assignee" },
  { optionKey: "sprint", summaryKey: "sprint" },
  { optionKey: "release", summaryKey: "release" },
  { optionKey: "parent", summaryKey: "parent" },
] as const;

/** Builds the token-efficient filter echo used by compact search results. */
export function buildCompactSearchFilterSummary(params: {
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
  const { mode, matchMode, options, includeLinked, titleExact, phraseExact, scoreThreshold, hybridSemanticWeight, runtimeFieldFilters } = params;
  const filters: Record<string, unknown> = {};
  applyFilterValueEcho(filters, options, COMPACT_SEARCH_VALUE_FILTER_ECHO_ENTRIES);
  Object.assign(filters, buildGovernanceMissingFilterEcho(options as Record<string, unknown>));
  Object.assign(filters, buildContentFilterEcho(options as Record<string, unknown>));
  if (matchMode !== "or") filters.match_mode = matchMode;
  if (includeLinked) filters.include_linked = true;
  if (titleExact) filters.title_exact = true;
  if (phraseExact) filters.phrase_exact = true;
  if (scoreThreshold > 0) filters.score_threshold = scoreThreshold;
  if (mode === "hybrid" && options.semanticWeight !== undefined) {
    filters.hybrid_semantic_weight = hybridSemanticWeight;
  }
  if (options.limit !== undefined) filters.limit = options.limit;
  if (runtimeFieldFilters && Object.keys(runtimeFieldFilters).length > 0) {
    filters.runtime_filters = runtimeFieldFilters;
  }
  return filters;
}

/** Builds the complete filter echo shared by verbose search response paths. */
export function buildVerboseSearchFilters(params: {
  effectiveMode: SearchMode;
  matchMode: SearchMatchMode;
  options: SearchOptions;
  includeLinked: boolean;
  titleExact: boolean;
  phraseExact: boolean;
  scoreThreshold: number;
  hybridSemanticWeight: number;
  queryExpansion: SearchRenderingQueryExpansion;
  rerank: SearchRenderingRerank;
  runtimeFieldFilters: Record<string, unknown>;
}): Record<string, unknown> {
  const { effectiveMode, matchMode, options, includeLinked, titleExact, phraseExact, scoreThreshold, hybridSemanticWeight, queryExpansion, rerank, runtimeFieldFilters } = params;
  const valueOrNull = (value: unknown): unknown => value ?? null;
  return {
    mode: effectiveMode,
    match_mode: matchMode,
    status: isAllStatuses(options.status) ? "all" : valueOrNull(options.status),
    type: valueOrNull(options.type),
    tag: valueOrNull(options.tag),
    priority: valueOrNull(options.priority),
    deadline_before: valueOrNull(options.deadlineBefore),
    deadline_after: valueOrNull(options.deadlineAfter),
    updated_after: valueOrNull(options.updatedAfter),
    updated_before: valueOrNull(options.updatedBefore),
    created_after: valueOrNull(options.createdAfter),
    created_before: valueOrNull(options.createdBefore),
    assignee: valueOrNull(options.assignee),
    sprint: valueOrNull(options.sprint),
    release: valueOrNull(options.release),
    parent: valueOrNull(options.parent),
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
    limit: valueOrNull(options.limit),
    runtime_filters: runtimeFieldFilters,
  };
}
