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
import fs from "node:fs/promises";
import path from "node:path";
import {
  aggregateEvalMetrics,
  DEFAULT_EVAL_K,
  evaluateRanking,
  parseEvalQuerySet,
  type EvalSearchMode,
  type QueryEvalMetrics,
} from "../core/search/eval.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { coercePositiveInteger } from "../core/shared/primitives.js";
import { pathExists } from "../core/fs/fs-utils.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { runSearch } from "./query/search.js";

/** Relative location (under the pm root) of the default golden-query set. A git-tracked, human-curated file so relevance ground truth lives alongside the tracker it evaluates. */
export const DEFAULT_EVAL_QUERIES_RELATIVE_PATH = path.join(
  "search",
  "eval-queries.json",
);

/** Documents the eval command options payload exchanged by command, SDK, and package integrations. */
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
  /** Value that configures or reports query for this contract. */
  query: string;
  /** Value that configures or reports mode for this contract. */
  mode: EvalSearchMode;
  /** Value that configures or reports relevant total for this contract. */
  relevant_total: number;
  /** Value that configures or reports retrieved relevant for this contract. */
  retrieved_relevant: number;
  /** Value that configures or reports ndcg for this contract. */
  ndcg: number;
  /** Value that configures or reports mrr for this contract. */
  mrr: number;
  /** Value that configures or reports precision for this contract. */
  precision: number;
  /** Value that configures or reports recall for this contract. */
  recall: number;
}

/** Documents the eval result payload exchanged by command, SDK, and package integrations. */
export interface EvalResult {
  /** Value that configures or reports k for this contract. */
  k: number;
  /** Number of query entries represented by this result. */
  query_count: number;
  /** Value that configures or reports aggregate for this contract. */
  aggregate: {
    ndcg: number;
    mrr: number;
    precision: number;
    recall: number;
  };
  /** Value that configures or reports queries for this contract. */
  queries: EvalQueryReport[];
  /** Present only when `--fail-under` was supplied. */
  fail_under?: number;
  /** Whether the aggregate nDCG met the gate (always true when no gate is set). */
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
        examples: [
          `echo '[{"query":"offline search","relevant_ids":["pm-75k9"]}]' > ${queriesPath}`,
          "pm eval --queries ./my-eval.json",
        ],
        nextSteps: [
          "Create a git-tracked golden-query JSON file (an array of {query, relevant_ids, mode?} objects), then re-run pm eval.",
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

/** Resolves the caller override or tracker-owned default golden-query path. */
const resolveEvalQueriesPath = (
  pmRoot: string,
  queries: string | undefined,
): string =>
  queries
    ? path.resolve(process.cwd(), queries)
    : path.join(pmRoot, DEFAULT_EVAL_QUERIES_RELATIVE_PATH);

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
    passed: failUnder === undefined || aggregate.ndcg >= failUnder,
  };
};

/**
 * Run the search-relevance evaluation (pm-u8n5). Loads the golden-query set
 * (default `<pmRoot>/search/eval-queries.json`, overridable via `--queries`),
 * runs each query through {@link runSearch} at the resolved mode, scores the
 * returned ranking with the nDCG/MRR/precision/recall metrics, and macro-averages
 * across queries. When `--fail-under` is supplied, `passed` reflects whether the
 * aggregate nDCG@k cleared the threshold; the CLI layer maps a failed gate to a
 * non-zero exit code.
 */
export const runEval = async (
  options: EvalOptions,
  global: GlobalOptions,
): Promise<EvalResult> => {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const k = parseEvalK(options.k);
  const defaultMode = parseEvalMode(options.mode);
  const failUnder = parseFailUnder(options.failUnder);
  const queriesPath = resolveEvalQueriesPath(pmRoot, options.queries);
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
