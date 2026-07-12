/**
 * @module cli/commands/search-pagination
 *
 * Applies the shared SDK cursor contract to ranked search results.
 */
import {
  createQueryFingerprint,
  paginateQueryRows,
} from "../../sdk/pagination.js";
import type { SearchHit, SearchOptions } from "./search.js";
import type { SearchMode } from "./search-rendering.js";

/** Page ranked search hits without coupling cursor mechanics to search scoring. */
export function resolveSearchPage(options: {
  sorted: SearchHit[];
  query: string;
  mode: SearchMode;
  searchOptions: SearchOptions;
  limit: number;
}): {
  limited: SearchHit[];
  pageExtras: {
    has_more?: boolean;
    next_cursor?: string;
    applied_limit: number;
    truncated?: true;
  };
} {
  const normalizedOptions: Record<string, unknown> = {
    ...options.searchOptions,
  };
  delete normalizedOptions.after;
  delete normalizedOptions.limit;
  const page = paginateQueryRows(options.sorted, {
    cursor: options.searchOptions.after,
    fingerprint: createQueryFingerprint("search", {
      query: options.query.trim(),
      mode: options.mode,
      options: normalizedOptions,
    }),
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
