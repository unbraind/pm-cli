/**
 * @module sdk/query/search/input
 * Parses inline predicates before keyword tokenization and preserves explicit flag precedence.
 */
import { EXIT_CODE } from "../../../core/shared/constants.js";
import { PmCliError } from "../../../core/shared/errors.js";
import { toNonEmptyStringOrUndefined } from "../../../core/shared/primitives.js";
import { parseLimit } from "../parsers.js";
import {
  normalizeSearchPhrase,
  parseMinScoreOverride,
  parseSearchBoolean,
  parseSearchMatchMode,
  parseSearchProjection,
  parseSearchTokens,
  type SearchOptions
} from "../search-contracts.js";
import type { PreparedSearchInput } from "./types.js";

// GH-157 inline query syntax: bare `field:value` tokens parsed out of the query
// string and applied as the equivalent filter. The value may itself contain
// colons (e.g. `tag:area:search`), so only the FIRST colon delimits field from
// value. Explicit --field flags take precedence over an inline token (see
// resolveInlineQueryFilters).
const INLINE_QUERY_FILTER_FIELDS = [
  "tag",
  "status",
  "type",
  "priority",
] as const;

type InlineQueryFilterField = (typeof INLINE_QUERY_FILTER_FIELDS)[number];

/** Result of extracting inline `field:value` tokens from a raw search query. */
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
    const field =
      separatorIndex > 0 ? token.slice(0, separatorIndex).toLowerCase() : "";
    const value = separatorIndex > 0 ? token.slice(separatorIndex + 1) : "";
    const matchedField = (
      INLINE_QUERY_FILTER_FIELDS as ReadonlyArray<string>
    ).includes(field)
      ? (field as InlineQueryFilterField)
      : undefined;
    if (
      matchedField &&
      value.length > 0 &&
      inlineFilters[matchedField] === undefined
    ) {
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

/** Merge inline `field:value` filters into a search options object (GH-157). Explicit `--field` flags always win: an inline token is applied only when the corresponding option is not already set, and a conflicting inline token is recorded as a `search_inline_filter_ignored:<field>:flag_takes_precedence` warning so the override is observable rather than silent. Returns a fresh options object — the caller's input is never mutated. */
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
      warnings.push(
        `search_inline_filter_ignored:${field}:flag_takes_precedence`,
      );
      continue;
    }
    merged[field] = inlineValue;
  }
  return merged;
}

/** Resolve inline filters, explicit options, tokenization and projection before accessing the search corpus. */
function prepareSearchInput(
  rawQuery: string,
  rawOptions: SearchOptions,
): PreparedSearchInput {
  const inlineWarnings: string[] = [];
  const inlineParse = parseInlineQueryFilters(rawQuery);
  const hasInlineFilters = Object.keys(inlineParse.inlineFilters).length > 0;
  if (hasInlineFilters && inlineParse.residualQuery.trim().length === 0) {
    throw new PmCliError(
      "Inline field:value tokens consumed the entire query, leaving no search terms.",
      EXIT_CODE.USAGE,
      {
        examples: [
          "pm search auth tag:area:search",
          "pm list --tag area:search --status open",
        ],
        nextSteps: [
          "Add keyword terms alongside the inline filters, or use pm list for pure tag/status/type/priority filtering.",
        ],
      },
    );
  }
  const query = hasInlineFilters ? inlineParse.residualQuery : rawQuery;
  const options = applyInlineQueryFilters(
    rawOptions,
    inlineParse.inlineFilters,
    inlineWarnings,
  );
  return {
    query,
    options,
    inlineWarnings,
    highlight: options.highlight === true,
    includeLinked: parseSearchBoolean(options.includeLinked),
    titleExact: parseSearchBoolean(options.titleExact),
    phraseExact: parseSearchBoolean(options.phraseExact),
    matchMode: parseSearchMatchMode(
      typeof options.matchMode === "string" ? options.matchMode : undefined,
    ),
    minScoreOverride: parseMinScoreOverride(options.minScore),
    countOnly: options.count === true,
    tokens: parseSearchTokens(query),
    normalizedQuery: normalizeSearchPhrase(query),
    limit: parseLimit(options.limit),
    projection: parseSearchProjection(options, rawQuery),
    modeWasExplicit:
      typeof options.mode === "string" && options.mode.trim().length > 0,
  };
}

/** Reject incompatible paging options before search execution. */
function assertSearchPagingOptions(options: SearchOptions): void {
  if (options.after !== undefined && options.count === true) {
    throw new PmCliError(
      "Search --after cannot be combined with --count.",
      EXIT_CODE.USAGE,
    );
  }
}

export { applyInlineQueryFilters,assertSearchPagingOptions,parseInlineQueryFilters,prepareSearchInput };
