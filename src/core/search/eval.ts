/**
 * @module core/search/eval
 *
 * Search relevance evaluation primitives (pm-u8n5). Implements the standard
 * offline ranking metrics — nDCG@k, MRR@k, precision@k, recall@k — over a
 * human-curated golden-query set, plus the loader/validator for that set. The
 * `pm eval` command (src/cli/commands/eval.ts) runs each golden query through
 * the live retrieval path and feeds the ranked ids here, so relevance
 * regressions from corpus changes, hybrid-weight changes, or provider swaps are
 * measurable and gateable in CI.
 *
 * Relevance is binary: an id is either in a query's `relevant_ids` set or it is
 * not. This keeps the golden set cheap to curate while still supporting the
 * graded-discount behavior of DCG (earlier hits are worth more).
 */

/** Retrieval mode a golden query is evaluated under. Mirrors the `pm search` mode surface; omitting it on a query defers to the eval run's default mode. */
export type EvalSearchMode = "keyword" | "semantic" | "hybrid";

/** Default cutoff (`@k`) used for every metric when the caller does not override it. */
export const DEFAULT_EVAL_K = 10;

/** One curated golden query: the query text, the set of item ids considered relevant, an optional per-query retrieval mode override, and an optional human-readable description of the relevance intent. */
export interface EvalQuery {
  /** Value that configures or reports query for this contract. */
  query: string;
  /** Value that configures or reports relevant ids for this contract. */
  relevant_ids: string[];
  /** Value that configures or reports mode for this contract. */
  mode?: EvalSearchMode;
  /** Value that configures or reports description for this contract. */
  description?: string;
}

/** A parsed, validated golden-query set. */
export interface EvalQuerySet {
  /** Value that configures or reports queries for this contract. */
  queries: EvalQuery[];
}

/**
 * Thrown by {@link parseEvalQuerySet} when the raw golden-query payload is
 * structurally invalid. Carries a precise, human-actionable message naming the
 * offending query index/field so an author can fix the JSON directly.
 */
export class EvalQuerySetError extends Error {
  /** Construct an error describing why a golden-query set failed validation. */
  constructor(message: string) {
    super(message);
    this.name = "EvalQuerySetError";
  }
}

const VALID_EVAL_MODES: ReadonlySet<string> = new Set<EvalSearchMode>([
  "keyword",
  "semantic",
  "hybrid",
]);

/** Compute Discounted Cumulative Gain at cutoff `k` for an ordered list of binary relevance gains (`1` relevant, `0` not). Position `i` (1-based) contributes `gain / log2(i + 1)`, so a relevant hit ranked first is worth `1` and later hits are progressively discounted. Gains beyond `k` are ignored. */
export function dcgAtK(relevanceGains: number[], k: number): number {
  let dcg = 0;
  const limit = Math.min(k, relevanceGains.length);
  for (let index = 0; index < limit; index += 1) {
    dcg += relevanceGains[index] / Math.log2(index + 2);
  }
  return dcg;
}

/** Normalized DCG at cutoff `k`: the ranking's DCG divided by the DCG of the ideal ranking (all relevant ids first). Returns `0` when the query has no relevant ids (the ideal DCG is `0` and the score is undefined), giving a stable lower bound for aggregation. Result is in `[0, 1]`. */
export function ndcgAtK(
  rankedIds: string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): number {
  if (relevantIds.size === 0) {
    return 0;
  }
  const gains = rankedIds.map((id) => (relevantIds.has(id) ? 1 : 0));
  const dcg = dcgAtK(gains, k);
  const idealGains = Array.from({ length: relevantIds.size }, () => 1);
  const idealDcg = dcgAtK(idealGains, k);
  return idealDcg === 0 ? 0 : dcg / idealDcg;
}

/**
 * Reciprocal rank of the first relevant id within the top `k` results: `1/rank`
 * (rank is 1-based), or `0` when no relevant id appears in the cutoff. Averaged
 * across queries this is Mean Reciprocal Rank (MRR@k).
 */
export function reciprocalRankAtK(
  rankedIds: string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): number {
  const limit = Math.min(k, rankedIds.length);
  for (let index = 0; index < limit; index += 1) {
    if (relevantIds.has(rankedIds[index])) {
      return 1 / (index + 1);
    }
  }
  return 0;
}

/** Count relevant ids within the top `k` results (shared by precision and recall). */
function countRelevantInTopK(
  rankedIds: string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): number {
  const limit = Math.min(k, rankedIds.length);
  let hits = 0;
  for (let index = 0; index < limit; index += 1) {
    if (relevantIds.has(rankedIds[index])) {
      hits += 1;
    }
  }
  return hits;
}

/** Precision at cutoff `k`: relevant ids retrieved in the top `k` divided by `k`. Returns `0` for a non-positive `k`. */
export function precisionAtK(
  rankedIds: string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): number {
  if (k <= 0) {
    return 0;
  }
  return countRelevantInTopK(rankedIds, relevantIds, k) / k;
}

/** Recall at cutoff `k`: relevant ids retrieved in the top `k` divided by the total number of relevant ids. Returns `0` when the query has no relevant ids. */
export function recallAtK(
  rankedIds: string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): number {
  if (relevantIds.size === 0) {
    return 0;
  }
  return countRelevantInTopK(rankedIds, relevantIds, k) / relevantIds.size;
}

/** The four ranking metrics computed for a single query, plus match counts. */
export interface QueryEvalMetrics {
  /** Value that configures or reports ndcg for this contract. */
  ndcg: number;
  /** Value that configures or reports mrr for this contract. */
  mrr: number;
  /** Value that configures or reports precision for this contract. */
  precision: number;
  /** Value that configures or reports recall for this contract. */
  recall: number;
  /** Value that configures or reports relevant total for this contract. */
  relevant_total: number;
  /** Value that configures or reports retrieved relevant for this contract. */
  retrieved_relevant: number;
}

/** Evaluate one ranking against its relevant-id set at cutoff `k`, returning all four metrics together so callers compute the document ranking once and read every score off the result. */
export function evaluateRanking(
  rankedIds: string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): QueryEvalMetrics {
  return {
    ndcg: ndcgAtK(rankedIds, relevantIds, k),
    mrr: reciprocalRankAtK(rankedIds, relevantIds, k),
    precision: precisionAtK(rankedIds, relevantIds, k),
    recall: recallAtK(rankedIds, relevantIds, k),
    relevant_total: relevantIds.size,
    retrieved_relevant: countRelevantInTopK(rankedIds, relevantIds, k),
  };
}

/** Macro-averaged metrics across all evaluated queries. */
export interface AggregateEvalMetrics {
  /** Value that configures or reports ndcg for this contract. */
  ndcg: number;
  /** Value that configures or reports mrr for this contract. */
  mrr: number;
  /** Value that configures or reports precision for this contract. */
  precision: number;
  /** Value that configures or reports recall for this contract. */
  recall: number;
  /** Number of query entries represented by this result. */
  query_count: number;
}

/** Macro-average per-query metrics (each query weighted equally). Returns all zeros with `query_count: 0` for an empty input so the gate path has a stable shape to compare against. */
export function aggregateEvalMetrics(
  perQuery: QueryEvalMetrics[],
): AggregateEvalMetrics {
  const queryCount = perQuery.length;
  if (queryCount === 0) {
    return { ndcg: 0, mrr: 0, precision: 0, recall: 0, query_count: 0 };
  }
  const sum = perQuery.reduce(
    (accumulator, metrics) => ({
      ndcg: accumulator.ndcg + metrics.ndcg,
      mrr: accumulator.mrr + metrics.mrr,
      precision: accumulator.precision + metrics.precision,
      recall: accumulator.recall + metrics.recall,
    }),
    { ndcg: 0, mrr: 0, precision: 0, recall: 0 },
  );
  return {
    ndcg: sum.ndcg / queryCount,
    mrr: sum.mrr / queryCount,
    precision: sum.precision / queryCount,
    recall: sum.recall / queryCount,
    query_count: queryCount,
  };
}

/**
 * Validate one raw golden-query entry, returning a typed {@link EvalQuery}.
 * Throws {@link EvalQuerySetError} (with the entry index) for a missing/empty
 * `query`, a `relevant_ids` that is not a non-empty string array, or an invalid
 * `mode`. `relevant_ids` are trimmed and de-duplicated; `description` is kept
 * only when it is a non-empty string.
 */
function parseEvalQueryEntry(raw: unknown, index: number): EvalQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new EvalQuerySetError(
      `Eval query at index ${index} must be an object`,
    );
  }
  const entry = raw as {
    query?: unknown;
    relevant_ids?: unknown;
    mode?: unknown;
    description?: unknown;
  };
  const query = typeof entry.query === "string" ? entry.query.trim() : "";
  if (query.length === 0) {
    throw new EvalQuerySetError(
      `Eval query at index ${index} must have a non-empty "query" string`,
    );
  }
  if (!Array.isArray(entry.relevant_ids)) {
    throw new EvalQuerySetError(
      `Eval query at index ${index} must have a "relevant_ids" array`,
    );
  }
  if (entry.relevant_ids.some((value) => typeof value !== "string")) {
    // Reject (rather than silently drop) non-string members: malformed golden
    // data must fail loudly so it can never quietly change relevance judgments.
    throw new EvalQuerySetError(
      `Eval query at index ${index} must have a "relevant_ids" array of strings`,
    );
  }
  const relevantIds = [
    ...new Set(
      (entry.relevant_ids as string[])
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];
  if (relevantIds.length === 0) {
    throw new EvalQuerySetError(
      `Eval query at index ${index} must list at least one relevant id`,
    );
  }
  if (
    entry.mode !== undefined &&
    (typeof entry.mode !== "string" || !VALID_EVAL_MODES.has(entry.mode))
  ) {
    throw new EvalQuerySetError(
      `Eval query at index ${index} has an invalid mode (expected keyword|semantic|hybrid)`,
    );
  }
  return {
    query,
    relevant_ids: relevantIds,
    ...(entry.mode !== undefined ? { mode: entry.mode as EvalSearchMode } : {}),
    ...(typeof entry.description === "string" &&
    entry.description.trim().length > 0
      ? { description: entry.description.trim() }
      : {}),
  };
}

/**
 * Parse and validate a raw golden-query payload (typically `JSON.parse` of
 * `.agents/pm/search/eval-queries.json`). Accepts either a bare array of query
 * entries or an object with a `queries` array. Throws {@link EvalQuerySetError}
 * with a precise message when the payload is not an array/object, when
 * `queries` is missing/not an array, when the set is empty, or when any entry
 * fails {@link parseEvalQueryEntry}.
 */
export function parseEvalQuerySet(raw: unknown): EvalQuerySet {
  const rawQueries = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null
      ? (raw as { queries?: unknown }).queries
      : undefined;
  if (!Array.isArray(rawQueries)) {
    throw new EvalQuerySetError(
      'Eval query set must be an array of queries or an object with a "queries" array',
    );
  }
  if (rawQueries.length === 0) {
    throw new EvalQuerySetError(
      "Eval query set must contain at least one query",
    );
  }
  return {
    queries: rawQueries.map((entry, index) =>
      parseEvalQueryEntry(entry, index),
    ),
  };
}
