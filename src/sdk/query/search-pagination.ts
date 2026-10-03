/**
 * @module sdk/query/search-pagination
 *
 * Applies the shared SDK cursor contract to ranked search results.
 */
import {
  createQueryFingerprint,
  paginateQueryRows,
  selectCursorSemanticOptions,
} from "../pagination.js";
import path from "node:path";
import { SEARCH_FLAG_CONTRACTS } from "../cli-contracts/flag-contracts.js";
import type { SearchHit, SearchOptions } from "./search.js";
import type { SearchMode } from "./search-rendering.js";

/** Build the query-only fingerprint shared by search retrieval and paging. */
export function createSearchCursorFingerprint(options: {
  query: string;
  mode: SearchMode;
  searchOptions: SearchOptions;
  /** Tracker scope, resolved before hashing so callers share native path identity. */
  pmRoot?: string;
}): string {
  return createQueryFingerprint("search", {
    pmRoot: options.pmRoot === undefined ? undefined : path.resolve(options.pmRoot),
    query: options.query.trim(),
    mode: options.mode,
    options: selectCursorSemanticOptions(
      options.searchOptions as Readonly<Record<string, unknown>>,
      SEARCH_FLAG_CONTRACTS,
    ),
  });
}

/** Page ranked search hits without coupling cursor mechanics to search scoring. */
export function resolveSearchPage(options: {
  sorted: SearchHit[];
  query: string;
  mode: SearchMode;
  searchOptions: SearchOptions;
  limit: number;
  /** Resolved tracker scope when invoked by the query runtime. */
  pmRoot?: string;
}): {
  limited: SearchHit[];
  pageExtras: {
    has_more?: boolean;
    next_cursor?: string;
    applied_limit: number;
    truncated?: true;
  };
} {
  const page = paginateQueryRows(options.sorted, {
    cursor: options.searchOptions.after,
    fingerprint: createSearchCursorFingerprint(options),
    limit: options.limit,
    readId: (hit) => hit.item.id,
  });
  return {
    limited: page.rows,
    pageExtras: {
      applied_limit: options.limit,
      ...(page.has_more ? { has_more: true, truncated: true } : {}),
      ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
    },
  };
}
