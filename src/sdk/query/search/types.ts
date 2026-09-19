/**
 * @module sdk/query/search/types
 * Shared search result and pipeline state contracts; no runtime dependencies.
 */
import {
  type QueryExpansionConfig,
  type RerankConfig
} from "../../../core/search/relevance.js";
import type {
  ItemMetadata
} from "../../../types/index.js";
import {
  type WorkspaceMemoryRollup
} from "../../workspace-memory.js";
import {
  type SearchMatchMode,
  type SearchModeSource,
  type SearchOptions,
  type SearchProjectionConfig,
  type SearchProjectionMode
} from "../search-contracts.js";
import {
  type SearchMode
} from "../search-rendering.js";

/** Documents the search hit payload exchanged by command, SDK, and package integrations. */
export interface SearchHit {
  /** Value that configures or reports item for this contract. */
  item: ItemMetadata;
  /** Value that configures or reports score for this contract. */
  score: number;
  /** Value that configures or reports matched fields for this contract. */
  matched_fields: string[];
  // GH-181: whether every distinct query token matched some searchable field.
  // Used by --match-mode and (hard filter) and the default all-terms ranking
  // bonus. Not projected into output rows.
  /** Value that configures or reports matched all terms for this contract. */
  matched_all_terms?: boolean;
  // GH-281: marks the keyword hit produced by the exact full-ID / short-ID
  // early-return in scoreDocument(). The semantic & hybrid ranking paths use it
  // to guarantee the exact-ID target ALWAYS ranks #1 (and is exempt from the
  // score threshold / limit), so the keyword-mode exact-ID guarantee is never
  // lost once vector blending is active. SHORT_ID matches keep score=900 and
  // full-ID matches keep score=1000, so sortHits still orders full above short.
  // Not projected into output rows.
  /** Value that configures or reports exact id match for this contract. */
  exact_id_match?: boolean;
  // GH-157: per-field matched-text snippets, populated only when the caller
  // passes --highlight. Each entry pairs a matched field name with a snippet of
  // its text where the matching token runs are wrapped in the «…» markers.
  /** Value that configures or reports highlights for this contract. */
  highlights?: SearchHitHighlight[];
}

/**
 * Pairs a matched field name with a snippet of its text where every matching
 * token run is wrapped in the {@link HIGHLIGHT_OPEN}/{@link HIGHLIGHT_CLOSE}
 * markers. Emitted on {@link SearchHit.highlights} when `--highlight` is set.
 */
export interface SearchHitHighlight {
  /** Value that configures or reports field for this contract. */
  field: string;
  /** Value that configures or reports snippet for this contract. */
  snippet: string;
}

/** Restricts search result item values accepted by command, SDK, and storage contracts. */
export type SearchResultItem = SearchHit | Record<string, unknown>;

interface SearchResultBase {
  query: string;
  mode: SearchMode;
  /** Which layer chose `mode` before any runtime fallback: the caller, `search.default_mode`, or the workspace-state default. */
  mode_source?: SearchModeSource;
  items: SearchResultItem[];
  count: number;
  // GH-181: total matched hits after filters/threshold but BEFORE the limit
  // truncation. Lets callers see how many matched before the (now-default)
  // keyword limit dropped rows. Only emitted when it differs from count.
  total?: number;
  /** Whether additional ranked hits remain after this page. */
  has_more?: boolean;
  /** Opaque continuation cursor when additional hits remain. */
  next_cursor?: string;
  /** Effective page size for this response. */
  applied_limit?: number;
  /** Explicit marker that the response is a bounded page. */
  truncated?: true;
  // --count mode: count-only response carries the matched total and skips the
  // hit rows entirely (items is empty). `count` reflects the same total.
  count_only?: boolean;
  warnings?: string[];
  /** Historical epoch and epic rollups matching the query in large workspaces. */
  workspace_memory?: {
    /** Persistence freshness for the derived projection. */
    cache_status: "fresh" | "rebuilt";
    /** Matching bounded rollups, ordered by term coverage and recency. */
    matches: WorkspaceMemoryRollup[];
  };
}

/** Documents the search compact result payload exchanged by command, SDK, and package integrations. */
export interface SearchCompactResult extends SearchResultBase {
  /** Value that configures or reports filters for this contract. */
  filters: Record<string, unknown>;
  /** Value that configures or reports projection for this contract. */
  projection?: undefined;
  /** Value that configures or reports now for this contract. */
  now?: undefined;
}

/** Documents the search verbose result payload exchanged by command, SDK, and package integrations. */
export interface SearchVerboseResult extends SearchResultBase {
  /** Value that configures or reports filters for this contract. */
  filters: Record<string, unknown>;
  /** Value that configures or reports projection for this contract. */
  projection: {
    mode: SearchProjectionMode;
    fields: string[] | null;
  };
  /** Value that configures or reports now for this contract. */
  now: string;
}

/** Restricts search result values accepted by command, SDK, and storage contracts. */
export type SearchResult = SearchCompactResult | SearchVerboseResult;

/** Validated search input shared by corpus selection, retrieval and result construction. */
interface PreparedSearchInput {
  query: string;
  options: SearchOptions;
  inlineWarnings: string[];
  highlight: boolean;
  includeLinked: boolean;
  titleExact: boolean;
  phraseExact: boolean;
  matchMode: SearchMatchMode;
  minScoreOverride: number | undefined;
  countOnly: boolean;
  tokens: string[];
  normalizedQuery: string;
  limit: number | undefined;
  projection: SearchProjectionConfig;
  modeWasExplicit: boolean;
}

/** Resolved query settings and evidence retained while shaping the final response. */
interface SearchResponseContext {
  query: string;
  effectiveMode: SearchMode;
  modeSource: SearchModeSource;
  matchMode: SearchMatchMode;
  options: SearchOptions;
  includeLinked: boolean;
  titleExact: boolean;
  phraseExact: boolean;
  scoreThreshold: number;
  hybridSemanticWeight: number;
  queryExpansion: QueryExpansionConfig;
  rerank: RerankConfig;
  projection: SearchProjectionConfig;
  warnings: string[];
  runtimeFieldFilters: Record<string, unknown>;
}

export { PreparedSearchInput,SearchResponseContext };
