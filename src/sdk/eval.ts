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
export type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { coercePositiveInteger } from "../core/shared/primitives.js";
import { pathExists } from "../core/fs/fs-utils.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";

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

/** Minimal retrieval result consumed by the SDK evaluation harness. */
export interface EvalSearchResult {
  /** Ranked result rows; only each row's string `id` field is scored. */
  items: readonly unknown[];
}

/**
 * Retrieval adapter used by {@link runSearchEval}.
 *
 * Keeping retrieval injectable lets custom SDK consumers evaluate their own
 * search implementation while the pm CLI supplies its canonical search
 * primitive through a thin presentation adapter.
 */
export type EvalSearchRunner = (
  query: string,
  options: { mode: EvalSearchMode; limit: string; fields: "id" },
  global: GlobalOptions,
) => Promise<EvalSearchResult>;

const VALID_EVAL_MODES: ReadonlySet<string> = new Set<EvalSearchMode>([
  "keyword",
  "semantic",
  "hybrid",
]);

function parseEvalMode(raw: string | undefined): EvalSearchMode {
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
}

function parseEvalK(raw: string | number | undefined): number {
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
}

function parseFailUnder(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new PmCliError(
      "Eval --fail-under must be a number in the range [0, 1]",
      EXIT_CODE.USAGE,
    );
  }
  return parsed;
}

/** Round a metric to four decimals to keep the JSON output compact and stable. */
function roundMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

async function loadEvalQuerySet(
  queriesPath: string,
): Promise<ReturnType<typeof parseEvalQuerySet>> {
  let raw: string;
  try {
    raw = await fs.readFile(queriesPath, "utf8");
  } catch {
    throw new PmCliError(
      `Eval query set not found at ${queriesPath}`,
      EXIT_CODE.NOT_FOUND,
      {
        examples: [
          'echo \'[{"query":"offline search","relevant_ids":["pm-75k9"]}]\' > ' +
            queriesPath,
          "pm eval --queries ./my-eval.json",
        ],
        nextSteps: [
          "Create a git-tracked golden-query JSON file (an array of {query, relevant_ids, mode?} objects), then re-run pm eval.",
        ],
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    // JSON.parse only ever throws a SyntaxError (an Error subclass).
    throw new PmCliError(
      `Eval query set at ${queriesPath} is not valid JSON: ${(error as Error).message}`,
      EXIT_CODE.USAGE,
    );
  }
  try {
    return parseEvalQuerySet(parsed);
  } catch (error: unknown) {
    // parseEvalQuerySet only ever throws EvalQuerySetError (an Error subclass
    // with a precise, author-actionable message) — surface it as a usage error.
    throw new PmCliError((error as Error).message, EXIT_CODE.USAGE);
  }
}

/**
 * Run the search-relevance evaluation (pm-u8n5). Loads the golden-query set
 * (default `<pmRoot>/search/eval-queries.json`, overridable via `--queries`),
 * runs each query through {@link runSearch} at the resolved mode, scores the
 * returned ranking with the nDCG/MRR/precision/recall metrics, and macro-averages
 * across queries. When `--fail-under` is supplied, `passed` reflects whether the
 * aggregate nDCG@k cleared the threshold; the CLI layer maps a failed gate to a
 * non-zero exit code.
 */
export async function runSearchEval(
  options: EvalOptions,
  global: GlobalOptions,
  search: EvalSearchRunner,
): Promise<EvalResult> {
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
  const queriesPath = options.queries
    ? path.resolve(process.cwd(), options.queries)
    : path.join(pmRoot, DEFAULT_EVAL_QUERIES_RELATIVE_PATH);
  const querySet = await loadEvalQuerySet(queriesPath);

  const reports: EvalQueryReport[] = [];
  // Aggregate and gate on the UNROUNDED metrics; rounding is applied only to the
  // emitted report values so display precision never flips a --fail-under decision.
  const rawMetrics: QueryEvalMetrics[] = [];
  for (const evalQuery of querySet.queries) {
    const mode = evalQuery.mode ?? defaultMode;
    const searchResult = await search(
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
    rawMetrics.push(metrics);
    reports.push({
      query: evalQuery.query,
      mode,
      relevant_total: metrics.relevant_total,
      retrieved_relevant: metrics.retrieved_relevant,
      ndcg: roundMetric(metrics.ndcg),
      mrr: roundMetric(metrics.mrr),
      precision: roundMetric(metrics.precision),
      recall: roundMetric(metrics.recall),
    });
  }

  const aggregate = aggregateEvalMetrics(rawMetrics);
  const passed = failUnder === undefined || aggregate.ndcg >= failUnder;
  return {
    k,
    query_count: querySet.queries.length,
    aggregate: {
      ndcg: roundMetric(aggregate.ndcg),
      mrr: roundMetric(aggregate.mrr),
      precision: roundMetric(aggregate.precision),
      recall: roundMetric(aggregate.recall),
    },
    queries: reports,
    ...(failUnder !== undefined ? { fail_under: failUnder } : {}),
    passed,
  };
}
