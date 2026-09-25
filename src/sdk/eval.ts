/**
 * @module sdk/eval
 *
 * Implements the `pm eval` command surface (pm-u8n5): a search-relevance
 * evaluation runner that scores a human-curated golden-query set against the
 * live retrieval path and reports nDCG@k, MRR@k, precision@k, and recall@k per
 * query plus the macro average. With `--fail-under` it doubles as a CI gate so
 * relevance regressions — from corpus changes, hybrid-weight changes, or
 * provider swaps (including the offline BM25 provider, pm-75k9) — fail the build
 * instead of silently degrading retrieval quality.
 */
import { evaluateMetricFloors } from "../core/search/eval-thresholds.js";
import { assertInitializedTracker } from "./environment/tracker-preflight.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  aggregateEvalMetrics,
  DEFAULT_EVAL_K,
  EVAL_QUERY_SET_EXAMPLE,
  EVAL_QUERY_SET_SCHEMA_ID,
  evaluateRanking,
  parseEvalQuerySet,
  type EvalSearchMode,
  type QueryEvalMetrics,
} from "../core/search/eval.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { coercePositiveInteger } from "../core/shared/primitives.js";
import { resolvePmRoot } from "../core/store/paths.js";
import { runSearch } from "./query/search.js";

export {
  EVAL_QUERY_SET_CONTRACT,
  EVAL_QUERY_SET_EXAMPLE,
  EVAL_QUERY_SET_SCHEMA_ID,
  parseEvalQuerySet,
} from "../core/search/eval.js";

/** Relative location (under the pm root) of the default golden-query set. A git-tracked, human-curated file so relevance ground truth lives alongside the tracker it evaluates. */
export const DEFAULT_EVAL_QUERIES_RELATIVE_PATH = path.join(
  "search",
  "eval-queries.json",
);

/** Actionable context attached to every query-set loading or validation error. */
const EVAL_QUERY_SET_ERROR_CONTEXT = {
  schema: EVAL_QUERY_SET_SCHEMA_ID,
  examples: [JSON.stringify(EVAL_QUERY_SET_EXAMPLE)],
  nextSteps: [
    "Create a git-tracked golden-query JSON file that follows the schema, then re-run pm eval.",
  ],
};

/** Evaluation inputs shared by SDK hosts and the CLI adapter. */
export interface EvalOptions {
  /** Default retrieval mode for queries that do not set their own (keyword|semantic|hybrid). */
  mode?: string;
  /** Metric cutoff (`@k`); positive integer, defaults to {@link DEFAULT_EVAL_K}. */
  k?: string | number;
  /** Gate threshold: exit non-zero when the aggregate nDCG@k falls below this `[0,1]` value. */
  failUnder?: string | number;
  /** Override path to the golden-query JSON file (defaults to `<pmRoot>/search/eval-queries.json`). */
  queries?: string;
  /** Output format override: json|toon. */
  format?: string;
}

/** Per-query relevance report row emitted by {@link runEval}. */
export interface EvalQueryReport {
  /** Original golden-query text used for retrieval. */
  query: string;
  /** Resolved retrieval mode after applying query and run defaults. */
  mode: EvalSearchMode;
  /** Number of unique items judged relevant to this query. */
  relevant_total: number;
  /** Relevant items found within the ranking cutoff. */
  retrieved_relevant: number;
  /** Normalized discounted cumulative gain at the selected cutoff. */
  ndcg: number;
  /** Reciprocal rank of the first relevant result, or zero when absent. */
  mrr: number;
  /** Fraction of positions at the selected cutoff containing relevant items. */
  precision: number;
  /** Fraction of judged relevant items retrieved at the selected cutoff. */
  recall: number;
  /** Failed per-query floors, compared against unrounded scores. */
  violations?: string[];
}

/** Rounded ranking evidence and the verdict computed from unrounded metrics. */
export interface EvalResult {
  /** Maximum ranking positions scored for each query. */
  k: number;
  /** Number of query entries represented by this result. */
  query_count: number;
  /** Equal-weight macro averages across all evaluated queries. */
  aggregate: {
    ndcg: number;
    mrr: number;
    precision: number;
    recall: number;
  };
  /** Individual query scores and any failed declared floors. */
  queries: EvalQueryReport[];
  /** Present only when `--fail-under` was supplied. */
  fail_under?: number;
  /** Whether every declared per-query floor and optional aggregate nDCG threshold passed. */
  passed: boolean;
}

const VALID_EVAL_MODES: ReadonlySet<string> = new Set<EvalSearchMode>([
  "keyword",
  "semantic",
  "hybrid",
]);

type EvalQuery = ReturnType<typeof parseEvalQuerySet>["queries"][number];

/** Resolves and validates the default retrieval mode for an evaluation run. */
const parseEvalMode = (raw: string | undefined): EvalSearchMode => {
  if (raw === undefined) {
    return "keyword";
  }
  const normalized = raw.trim().toLowerCase();
  if (!VALID_EVAL_MODES.has(normalized)) {
    throw new PmCliError(
      "Eval --mode must be one of keyword|semantic|hybrid",
      EXIT_CODE.USAGE,
    );
  }
  return normalized as EvalSearchMode;
};

/** Resolves and validates the positive ranking cutoff for an evaluation run. */
const parseEvalK = (raw: string | number | undefined): number => {
  if (raw === undefined || raw === "") {
    return DEFAULT_EVAL_K;
  }
  const parsed = coercePositiveInteger(raw);
  if (parsed === null) {
    throw new PmCliError(
      "Eval --k must be a positive integer",
      EXIT_CODE.USAGE,
    );
  }
  return parsed;
};

/** Resolves and validates an optional normalized nDCG gate threshold. */
const parseFailUnder = (
  raw: string | number | undefined,
): number | undefined => {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const normalized = String(raw).trim();
  const parsed = Number(normalized);
  if (
    [
      normalized.length === 0,
      !Number.isFinite(parsed),
      parsed < 0,
      parsed > 1,
    ].includes(true)
  ) {
    throw new PmCliError(
      "Eval --fail-under must be a number in the range [0, 1]",
      EXIT_CODE.USAGE,
    );
  }
  return parsed;
};

/** Round a metric to four decimals to keep the JSON output compact and stable. */
const roundMetric = (value: number): number =>
  Math.round(value * 10_000) / 10_000;

/** Reads a golden-query file and translates missing-file failures to CLI guidance. */
const readEvalQuerySetFile = async (queriesPath: string): Promise<string> => {
  try {
    return await fs.readFile(queriesPath, "utf8");
  } catch {
    throw new PmCliError(
      `Eval query set not found at ${queriesPath}`,
      EXIT_CODE.NOT_FOUND,
      {
        ...EVAL_QUERY_SET_ERROR_CONTEXT,
        examples: [
          `echo '${JSON.stringify(EVAL_QUERY_SET_EXAMPLE)}' > ${queriesPath}`,
          "pm eval --queries ./my-eval.json",
        ],
      },
    );
  }
};

/** Parses golden-query JSON while preserving a path-specific usage diagnostic. */
const parseEvalQuerySetJson = (raw: string, queriesPath: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (error: unknown) {
    throw new PmCliError(
      /* c8 ignore next -- JSON.parse throws Error instances; String fallback protects nonstandard hosts. */
      `Eval query set at ${queriesPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODE.USAGE,
      EVAL_QUERY_SET_ERROR_CONTEXT,
    );
  }
};

/** Applies the structured golden-query contract and preserves its diagnostics. */
const validateEvalQuerySet = (
  parsed: unknown,
): ReturnType<typeof parseEvalQuerySet> => {
  try {
    return parseEvalQuerySet(parsed);
  } catch (error: unknown) {
    throw new PmCliError(
      /* c8 ignore next -- parseEvalQuerySet throws Error instances; String fallback protects nonstandard hosts. */
      error instanceof Error ? error.message : String(error),
      EXIT_CODE.USAGE,
      EVAL_QUERY_SET_ERROR_CONTEXT,
    );
  }
};

/** Loads and validates a golden-query set from one resolved filesystem path. */
const loadEvalQuerySet = async (
  queriesPath: string,
): Promise<ReturnType<typeof parseEvalQuerySet>> =>
  validateEvalQuerySet(
    parseEvalQuerySetJson(await readEvalQuerySetFile(queriesPath), queriesPath),
  );

/** Executes and scores one golden query without rounding its aggregate input. */
const evaluateEvalQuery = async (
  evalQuery: EvalQuery,
  defaultMode: EvalSearchMode,
  k: number,
  global: GlobalOptions,
): Promise<{ report: EvalQueryReport; metrics: QueryEvalMetrics }> => {
  const mode = evalQuery.mode ?? defaultMode;
  const searchResult = await runSearch(
    evalQuery.query,
    { mode, limit: String(k), fields: "id" },
    global,
  );
  const rankedIds = searchResult.items
    .map((item) => (item as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string");
  const metrics = evaluateRanking(
    rankedIds,
    new Set(evalQuery.relevant_ids),
    k,
  );
  return {
    metrics,
    report: {
      query: evalQuery.query,
      ...(evalQuery.minimum === undefined ? {} : { violations: evaluateMetricFloors(metrics, evalQuery.minimum) }),
      mode,
      relevant_total: metrics.relevant_total,
      retrieved_relevant: metrics.retrieved_relevant,
      ndcg: roundMetric(metrics.ndcg),
      mrr: roundMetric(metrics.mrr),
      precision: roundMetric(metrics.precision),
      recall: roundMetric(metrics.recall),
    },
  };
};

/** Shapes rounded aggregate metrics and the optional gate result. */
const buildEvalResult = (
  k: number,
  reports: EvalQueryReport[],
  rawMetrics: QueryEvalMetrics[],
  failUnder: number | undefined,
): EvalResult => {
  const aggregate = aggregateEvalMetrics(rawMetrics);
  return {
    k,
    query_count: reports.length,
    aggregate: {
      ndcg: roundMetric(aggregate.ndcg),
      mrr: roundMetric(aggregate.mrr),
      precision: roundMetric(aggregate.precision),
      recall: roundMetric(aggregate.recall),
    },
    queries: reports,
    ...(failUnder !== undefined ? { fail_under: failUnder } : {}),
    passed: (failUnder === undefined || aggregate.ndcg >= failUnder) && reports.every((report) => (report.violations?.length ?? 0) === 0),
  };
};

/**
 * Run the search-relevance evaluation (pm-u8n5). Loads the golden-query set
 * (default `<pmRoot>/search/eval-queries.json`, overridable via `--queries`),
 * runs each query through {@link runSearch} at the resolved mode, scores the
 * returned ranking with the nDCG/MRR/precision/recall metrics, and macro-averages
 * across queries. `passed` requires every declared per-query minimum and, when
 * supplied, the aggregate `--fail-under` threshold. The CLI maps any failed
 * threshold to a non-zero exit code.
 */
export const runEval = async (
  options: EvalOptions,
  global: GlobalOptions,
): Promise<EvalResult> => {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await assertInitializedTracker(pmRoot);
  const k = parseEvalK(options.k);
  const defaultMode = parseEvalMode(options.mode);
  const failUnder = parseFailUnder(options.failUnder);
  const queriesPath = options.queries
    ? path.resolve(process.cwd(), options.queries)
    : path.join(pmRoot, DEFAULT_EVAL_QUERIES_RELATIVE_PATH);
  const querySet = await loadEvalQuerySet(queriesPath);

  const reports: EvalQueryReport[] = [];
  // Aggregate and gate on the UNROUNDED metrics; rounding is applied only to the
  // emitted report values so display precision never flips a --fail-under decision.
  const rawMetrics: QueryEvalMetrics[] = [];
  for (const evalQuery of querySet.queries) {
    const { report, metrics } = await evaluateEvalQuery(
      evalQuery,
      defaultMode,
      k,
      global,
    );
    rawMetrics.push(metrics);
    reports.push(report);
  }
  return buildEvalResult(k, reports, rawMetrics, failUnder);
};
