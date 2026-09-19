/**
 * @module sdk/query/search/response
 * Shapes compact, full, count-only and paginated search responses without changing ranking.
 */
import { toItemRecord } from "../../../core/item/item-record.js";
import {
  type QueryExpansionConfig,
  type RerankConfig
} from "../../../core/search/relevance.js";
import {
  nowIso
} from "../../../core/shared/time.js";
import type {
  ItemDocument
} from "../../../types/index.js";
import {
  type WorkspaceMemoryRollup
} from "../../workspace-memory.js";
import {
  type SearchMatchMode,
  type SearchModeSource,
  type SearchOptions,
  type SearchProjectionConfig
} from "../search-contracts.js";
import {
  buildCompactSearchFilterSummary,
  buildVerboseSearchFilters,
  type SearchMode,
} from "../search-rendering.js";
import { buildHitHighlights } from "./lexical.js";
import type { PreparedSearchInput,SearchHit,SearchResponseContext,SearchResult,SearchResultItem } from "./types.js";

/* c8 ignore start */

/** Build a zero-hit response preserving the requested search mode and filters. */
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
  runtimeFieldFilters: Record<string, unknown> | undefined,
  countOnly: boolean,
  modeSource: SearchModeSource,
): SearchResult {
  // --count consistency: a count-only query that matches nothing must still
  // carry the same { count_only: true, total } shape as the non-empty path.
  const countExtras = countOnly ? { total: 0, count_only: true } : {};
  const compactSummaryMode =
    projection.mode === "compact" && options.compact === true;
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
      ...compactModeSource(modeSource),
      items: [],
      count: 0,
      ...countExtras,
      filters: compactFilters,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
  const projectionFields =
    projection.mode === "full" ? null : [...projection.fields];
  return {
    query: query.trim(),
    mode,
    mode_source: modeSource,
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

/** Resolve a projected search field from item metadata or search-hit evidence. */
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

/** Convert ranked hits into the requested compact, full or custom-field rows. */
function projectSearchHits(
  hits: SearchHit[],
  projection: SearchProjectionConfig,
): SearchResultItem[] {
  if (projection.mode === "full") {
    // matched_all_terms is an internal ranking signal (GH-181); strip it from
    // full-mode output rows so the public hit shape stays { item, score, matched_fields }.
    return hits.map(
      ({
        matched_all_terms: _matchedAllTerms,
        exact_id_match: _exactIdMatch,
        ...hit
      }) => hit,
    );
  }
  return hits.map((hit) => {
    const projected: Record<string, unknown> = {};
    for (const field of projection.fields) {
      projected[field] = readSearchFieldValue(hit, field);
    }
    return projected;
  });
}

/** Build an empty result with the resolved search settings and warnings. */
function buildEmptySearchResultFromContext(
  response: SearchResponseContext,
  countOnly: boolean,
): SearchResult {
  return emptySearchResult(
    response.query,
    response.effectiveMode,
    response.matchMode,
    response.options,
    response.includeLinked,
    response.scoreThreshold,
    response.hybridSemanticWeight,
    response.queryExpansion,
    response.rerank,
    response.projection,
    response.warnings,
    response.runtimeFieldFilters,
    countOnly,
    response.modeSource,
  );
}

/** Return the matched total without materializing projected hit rows. */
function buildCountOnlySearchResult(
  response: SearchResponseContext,
  total: number,
): SearchResult {
  if (
    response.projection.mode === "compact" &&
    response.options.compact === true
  ) {
    return withSearchWarnings(
      {
        query: response.query.trim(),
        mode: response.effectiveMode,
        ...compactModeSource(response.modeSource),
        items: [],
        count: total,
        total,
        count_only: true,
        filters: buildCompactSearchFilterSummary({
          mode: response.effectiveMode,
          matchMode: response.matchMode,
          options: response.options,
          includeLinked: response.includeLinked,
          titleExact: response.titleExact,
          phraseExact: response.phraseExact,
          scoreThreshold: response.scoreThreshold,
          hybridSemanticWeight: response.hybridSemanticWeight,
          runtimeFieldFilters: response.runtimeFieldFilters,
        }),
      },
      response.warnings,
    );
  }
  const projectionFields =
    response.projection.mode === "full"
      ? null
      : [...response.projection.fields];
  return withSearchWarnings(
    {
      query: response.query.trim(),
      mode: response.effectiveMode,
      mode_source: response.modeSource,
      items: [],
      count: total,
      total,
      count_only: true,
      filters: buildVerboseSearchFilters({
        effectiveMode: response.effectiveMode,
        matchMode: response.matchMode,
        options: response.options,
        includeLinked: response.includeLinked,
        titleExact: response.titleExact,
        phraseExact: response.phraseExact,
        scoreThreshold: response.scoreThreshold,
        hybridSemanticWeight: response.hybridSemanticWeight,
        queryExpansion: response.queryExpansion,
        rerank: response.rerank,
        runtimeFieldFilters: response.runtimeFieldFilters,
      }),
      projection: {
        mode: response.projection.mode,
        fields: projectionFields,
      },
      now: nowIso(),
    },
    response.warnings,
  );
}

/**
 * Compact responses carry `mode_source` only when `search.default_mode` pinned
 * the mode: a caller that passed `--mode` already knows it chose the mode, and
 * `auto` is the documented default, so echoing either would spend tokens on a
 * fact the reader already holds. Verbose responses always carry the source.
 */
function compactModeSource(
  source: SearchModeSource,
): { mode_source?: SearchModeSource } {
  return source === "settings" ? { mode_source: source } : {};
}

/** Attach collected search warnings to a result only when warnings exist, preserving the warning-free envelope. */
function withSearchWarnings(
  result: SearchResult,
  warnings: string[],
): SearchResult {
  if (warnings.length === 0) {
    return result;
  }
  return { ...result, warnings };
}

/** Attach bounded historical workspace rollups when the query and workspace qualify. */
function withSearchWorkspaceMemory(
  result: SearchResult,
  memory:
    | {
        cache_status: "fresh" | "rebuilt";
        matches: WorkspaceMemoryRollup[];
      }
    | undefined,
): SearchResult {
  return memory ? { ...result, workspace_memory: memory } : result;
}

/** Add matched-field snippets only when highlighting was requested. */
function attachSearchHighlights(
  prepared: PreparedSearchInput,
  filteredDocuments: ItemDocument[],
  limited: SearchHit[],
): { hits: SearchHit[]; projection: SearchProjectionConfig } {
  if (!prepared.highlight) {
    return { hits: limited, projection: prepared.projection };
  }
  const documentById = new Map(
    filteredDocuments.map((document) => [document.metadata.id, document]),
  );
  const hits = limited.map((hit) => ({
    ...hit,
    highlights: buildHitHighlights(
      documentById.get(hit.item.id)!,
      hit.matched_fields,
      prepared.tokens,
    ),
  }));
  if (
    prepared.projection.mode === "full" ||
    prepared.projection.fields.includes("highlights")
  ) {
    return { hits, projection: prepared.projection };
  }
  return {
    hits,
    projection: {
      mode: prepared.projection.mode,
      fields: [...prepared.projection.fields, "highlights"],
    },
  };
}

/** Apply search pagination and projection to the final ranked hit set. */
function buildSearchResultForHits(
  response: SearchResponseContext,
  projectedItems: SearchResultItem[],
  total: number,
  limitedCount: number,
  effectiveProjection: SearchProjectionConfig,
  pageExtras: {
    has_more?: boolean;
    next_cursor?: string;
    applied_limit: number;
    truncated?: true;
  },
): SearchResult {
  const truncationExtras = limitedCount < total ? { total } : {};
  if (
    response.projection.mode === "compact" &&
    response.options.compact === true
  ) {
    return withSearchWarnings(
      {
        query: response.query.trim(),
        mode: response.effectiveMode,
        ...compactModeSource(response.modeSource),
        items: projectedItems,
        count: projectedItems.length,
        ...truncationExtras,
        ...pageExtras,
        filters: buildCompactSearchFilterSummary({
          mode: response.effectiveMode,
          matchMode: response.matchMode,
          options: response.options,
          includeLinked: response.includeLinked,
          titleExact: response.titleExact,
          phraseExact: response.phraseExact,
          scoreThreshold: response.scoreThreshold,
          hybridSemanticWeight: response.hybridSemanticWeight,
          runtimeFieldFilters: response.runtimeFieldFilters,
        }),
      },
      response.warnings,
    );
  }
  const finalProjectionFields =
    effectiveProjection.mode === "full"
      ? null
      : [...effectiveProjection.fields];
  return {
    query: response.query.trim(),
    mode: response.effectiveMode,
    mode_source: response.modeSource,
    items: projectedItems,
    count: projectedItems.length,
    ...truncationExtras,
    ...pageExtras,
    filters: buildVerboseSearchFilters({
      effectiveMode: response.effectiveMode,
      matchMode: response.matchMode,
      options: response.options,
      includeLinked: response.includeLinked,
      titleExact: response.titleExact,
      phraseExact: response.phraseExact,
      scoreThreshold: response.scoreThreshold,
      hybridSemanticWeight: response.hybridSemanticWeight,
      queryExpansion: response.queryExpansion,
      rerank: response.rerank,
      runtimeFieldFilters: response.runtimeFieldFilters,
    }),
    projection: {
      mode: effectiveProjection.mode,
      fields: finalProjectionFields,
    },
    now: nowIso(),
    ...(response.warnings.length > 0 ? { warnings: response.warnings } : {}),
  };
}

export { attachSearchHighlights,buildCountOnlySearchResult,buildEmptySearchResultFromContext,buildSearchResultForHits,emptySearchResult,projectSearchHits,readSearchFieldValue,withSearchWorkspaceMemory };
