/**
 * @module sdk/context-relevance
 *
 * Public, deterministic context-ranking and evaluation primitives. The scorer
 * accepts already-derived signals so package authors can reuse the same model
 * with core, extension, or project-specific feature stores.
 */
import { runActiveServiceOverride } from "../core/extensions/index.js";

/** Canonical signal keys understood by the built-in relevance model. */
export const CONTEXT_RELEVANCE_SIGNAL_NAMES = [
  "structural",
  "recency",
  "activity_density",
  "graph_proximity",
  "claim_focus",
  "priority_pressure",
  "risk_pressure",
  "deadline_pressure",
  "knowledge_density",
  "author_affinity",
  "semantic_similarity",
] as const;

/** A normalized signal consumed by the built-in context relevance scorer. */
export type ContextRelevanceSignalName = (typeof CONTEXT_RELEVANCE_SIGNAL_NAMES)[number];

/** Normalized candidate features; omitted signals are excluded from weighting. */
export type ContextRelevanceSignals = Partial<Record<Exclude<ContextRelevanceSignalName, "structural">, number>>;

/** A project-management object and its derived relevance signals. */
export interface ContextRelevanceCandidate<TItem> {
  id: string;
  item: TItem;
  signals?: ContextRelevanceSignals;
}

/** Per-signal weighted contributions used to explain a ranked result. */
export type ContextRelevanceContributions = Record<string, number>;

/** One ranked candidate with deterministic score and explanation metadata. */
export interface RankedContextCandidate<TItem> extends ContextRelevanceCandidate<TItem> {
  baseline_rank: number;
  rank: number;
  score: number;
  contributions: ContextRelevanceContributions;
}

/** Complete output from a context relevance scorer. */
export interface ContextRelevanceReport<TItem> {
  model: string;
  available_signals: ContextRelevanceSignalName[];
  ranked: RankedContextCandidate<TItem>[];
  warnings?: string[];
}

/** Minimal custom score returned by a replacement or wrapper scorer. */
export interface ContextRelevanceCustomScore {
  id: string;
  score: number;
}

/** Input provided to a custom scorer, including the deterministic default. */
export interface ContextRelevanceScorerInput<TItem> {
  candidates: readonly ContextRelevanceCandidate<TItem>[];
  default_report: ContextRelevanceReport<TItem>;
}

/** Replaceable package/extension scorer contract. */
export type ContextRelevanceScorer<TItem> = (
  input: ContextRelevanceScorerInput<TItem>,
) => readonly ContextRelevanceCustomScore[] | Promise<readonly ContextRelevanceCustomScore[]>;

/** Options for the built-in or replaceable context relevance scorer. */
export interface ScoreContextCandidatesOptions<TItem> {
  weights?: Partial<Record<ContextRelevanceSignalName, number>>;
  scorer?: ContextRelevanceScorer<TItem>;
}

/** Governed extension service used to replace or wrap context ranking. */
export const CONTEXT_RELEVANCE_SERVICE = "context_relevance" as const;

/** Command surface requesting an active extension relevance override. */
export type ContextRelevanceSurface = "context" | "next";

const DEFAULT_CONTEXT_RELEVANCE_WEIGHTS: Record<ContextRelevanceSignalName, number> = {
  structural: 0.4,
  recency: 0.35,
  activity_density: 0.25,
  graph_proximity: 0.15,
  claim_focus: 0.6,
  priority_pressure: 0.35,
  risk_pressure: 0.2,
  deadline_pressure: 0.45,
  knowledge_density: 0.25,
  author_affinity: 0.2,
  semantic_similarity: 0.5,
};
const JSON_TOKEN_ENCODER = new TextEncoder();

function assertCandidates<TItem>(candidates: readonly ContextRelevanceCandidate<TItem>[]): void {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate.id !== "string" || candidate.id.trim().length === 0 || ids.has(candidate.id)) {
      throw new TypeError("Context relevance candidates require unique non-empty ids");
    }
    ids.add(candidate.id);
    for (const [signal, value] of Object.entries(candidate.signals ?? {})) {
      if (signal === "structural" || !CONTEXT_RELEVANCE_SIGNAL_NAMES.includes(signal as ContextRelevanceSignalName)) {
        throw new TypeError(`Unknown context relevance signal: ${signal}`);
      }
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new TypeError(`Context relevance signal ${signal} must be a finite number from 0 to 1`);
      }
    }
  }
}

function resolveWeights(
  overrides: Partial<Record<ContextRelevanceSignalName, number>> | undefined,
): Record<ContextRelevanceSignalName, number> {
  const weights = { ...DEFAULT_CONTEXT_RELEVANCE_WEIGHTS, ...overrides };
  for (const [signal, weight] of Object.entries(weights)) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new TypeError(`Context relevance weight ${signal} must be a finite non-negative number`);
    }
  }
  return weights;
}

/**
 * Score candidates with pm's deterministic weighted model. Candidate order is
 * the structural baseline and remains unchanged when no advanced signals exist.
 */
export function defaultScoreContextCandidates<TItem>(
  candidates: readonly ContextRelevanceCandidate<TItem>[],
  options: Pick<ScoreContextCandidatesOptions<TItem>, "weights"> = {},
): ContextRelevanceReport<TItem> {
  assertCandidates(candidates);
  const weights = resolveWeights(options.weights);
  const denominator = Math.max(candidates.length - 1, 1);
  const available = new Set<ContextRelevanceSignalName>(["structural"]);
  for (const candidate of candidates) {
    for (const signal of Object.keys(candidate.signals ?? {}) as ContextRelevanceSignalName[]) {
      available.add(signal);
    }
  }
  const availableSignals = CONTEXT_RELEVANCE_SIGNAL_NAMES.filter((signal) => available.has(signal));
  const scored = candidates.map((candidate, index): RankedContextCandidate<TItem> => {
    const signalValues: Partial<Record<ContextRelevanceSignalName, number>> = {
      structural: candidates.length === 1 ? 1 : 1 - index / denominator,
      ...candidate.signals,
    };
    const contributions: ContextRelevanceContributions = {};
    let weightedScore = 0;
    let totalWeight = 0;
    for (const signal of availableSignals) {
      const value = signalValues[signal];
      if (value === undefined) continue;
      const contribution = value * weights[signal];
      contributions[signal] = contribution;
      weightedScore += contribution;
      totalWeight += weights[signal];
    }
    return {
      ...candidate,
      baseline_rank: index + 1,
      rank: 0,
      score: totalWeight === 0 ? 0 : weightedScore / totalWeight,
      contributions,
    };
  });
  scored.sort((left, right) => right.score - left.score || left.baseline_rank - right.baseline_rank);
  scored.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  return { model: "default-weighted-v1", available_signals: availableSignals, ranked: scored };
}

/** Score candidates with the default model or a validated replacement/wrapper. */
export async function scoreContextCandidates<TItem>(
  candidates: readonly ContextRelevanceCandidate<TItem>[],
  options: ScoreContextCandidatesOptions<TItem> = {},
): Promise<ContextRelevanceReport<TItem>> {
  const defaultReport = defaultScoreContextCandidates(candidates, options);
  if (!options.scorer) return defaultReport;
  const customScores = await options.scorer({ candidates, default_report: defaultReport });
  const scoreById = new Map<string, number>();
  for (const entry of customScores) {
    if (scoreById.has(entry.id) || !Number.isFinite(entry.score)) {
      throw new TypeError("Context relevance scorer must return one finite score for every candidate");
    }
    scoreById.set(entry.id, entry.score);
  }
  if (scoreById.size !== candidates.length || candidates.some((candidate) => !scoreById.has(candidate.id))) {
    throw new TypeError("Context relevance scorer must return one finite score for every candidate");
  }
  const ranked = defaultReport.ranked.map((entry) => {
    const score = scoreById.get(entry.id) as number;
    return { ...entry, score, contributions: { custom: score } };
  });
  ranked.sort((left, right) => right.score - left.score || left.baseline_rank - right.baseline_rank);
  ranked.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  return { model: "custom", available_signals: defaultReport.available_signals, ranked };
}

/**
 * Score command candidates through the public default model and then the active
 * governed `context_relevance` service override, when one is registered.
 */
export async function scoreContextCandidatesWithActiveExtensions<TItem>(
  surface: ContextRelevanceSurface,
  candidates: readonly ContextRelevanceCandidate<TItem>[],
  options: Pick<ScoreContextCandidatesOptions<TItem>, "weights"> = {},
): Promise<ContextRelevanceReport<TItem>> {
  const defaultReport = defaultScoreContextCandidates(candidates, options);
  const override = await runActiveServiceOverride(CONTEXT_RELEVANCE_SERVICE, {
    surface,
    candidates,
    default_report: defaultReport,
  });
  if (!override.handled) {
    return override.warnings.length > 0 ? { ...defaultReport, warnings: override.warnings } : defaultReport;
  }
  if (
    !Array.isArray(override.result) ||
    !override.result.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === "string" &&
        typeof (entry as { score?: unknown }).score === "number" &&
        Number.isFinite((entry as { score: number }).score),
    )
  ) {
    return { ...defaultReport, warnings: [...override.warnings, "extension_context_relevance_invalid_result"] };
  }
  try {
    const report = await scoreContextCandidates(candidates, {
      ...options,
      scorer: () => override.result as ContextRelevanceCustomScore[],
    });
    return override.warnings.length > 0 ? { ...report, warnings: override.warnings } : report;
  } catch {
    return { ...defaultReport, warnings: [...override.warnings, "extension_context_relevance_invalid_result"] };
  }
}

/** Input for rank-aware context/next quality evaluation. */
export interface ContextRankingEvaluationInput {
  ranked_ids: string[];
  judgments: Record<string, number>;
  required_ids?: string[];
  continuity_ids?: string[];
  actual_tokens: number;
  token_budget: number;
}

/** Rank-quality, continuity, recall, and token-budget metrics for one scenario. */
export interface ContextRankingEvaluation {
  ndcg: number;
  reciprocal_rank: number;
  required_recall: number;
  continuity_coverage: number;
  token_budget_adherence: number;
  within_token_budget: boolean;
}

/** Flexible read options accepted by context evaluation scenarios. */
export interface ContextEvaluationReadOptions {
  explainRanking?: boolean;
  [key: string]: unknown;
}

/** Minimal item identity consumed by the context evaluation runner. */
export interface ContextEvaluationResultItem {
  id: string;
}

/** Optional scorer attribution returned by an evaluated read primitive. */
export interface ContextEvaluationResultRanking {
  items?: Array<{ id: string; contributions: ContextRelevanceContributions }>;
}

/** Structural context result consumed by the evaluation runner. */
export interface ContextEvaluationContextResult {
  high_level?: ContextEvaluationResultItem[];
  low_level?: ContextEvaluationResultItem[];
  blocked_fallback?: ContextEvaluationResultItem[];
  ranking?: ContextEvaluationResultRanking;
  [key: string]: unknown;
}

/** Structural next result consumed by the evaluation runner. */
export interface ContextEvaluationNextResult {
  ready?: ContextEvaluationResultItem[];
  ranking?: ContextEvaluationResultRanking;
  [key: string]: unknown;
}

/** Read-only SDK surface required by the context evaluation runner. */
export interface ContextEvaluationReader {
  context(options?: ContextEvaluationReadOptions): Promise<ContextEvaluationContextResult>;
  next(options?: ContextEvaluationReadOptions): Promise<ContextEvaluationNextResult>;
}

/** One graded context or next scenario evaluated against a real SDK reader. */
export interface ContextEvaluationScenario {
  id: string;
  surface: ContextRelevanceSurface;
  options?: ContextEvaluationReadOptions;
  judgments: Record<string, number>;
  required_ids?: string[];
  continuity_ids?: string[];
  token_budget: number;
  rationale: string;
}

/** Per-item signal attribution retained by a context evaluation report. */
export interface ContextEvaluationAttribution {
  id: string;
  contributions: ContextRelevanceContributions;
}

/** Result of executing and grading one context evaluation scenario. */
export interface ContextEvaluationScenarioReport {
  id: string;
  surface: ContextRelevanceSurface;
  rationale: string;
  ranked_ids: string[];
  actual_tokens: number;
  metrics: ContextRankingEvaluation;
  attribution: ContextEvaluationAttribution[];
}

/** Minimum acceptable aggregate metrics for a context evaluation corpus. */
export interface ContextEvaluationThresholds {
  ndcg: number;
  reciprocal_rank: number;
  required_recall: number;
  continuity_coverage: number;
  token_budget_adherence: number;
}

/** Aggregate context evaluation report suitable for a CI quality gate. */
export interface ContextEvaluationCorpusReport {
  scenario_count: number;
  aggregate: ContextEvaluationThresholds;
  scenarios: ContextEvaluationScenarioReport[];
  passed: boolean;
  failures: string[];
}

function ratioOfPresent(expected: readonly string[], actual: ReadonlySet<string>): number {
  if (expected.length === 0) return 1;
  return expected.filter((id) => actual.has(id)).length / expected.length;
}

/** Evaluate one ranked context packet against graded human judgments. */
export function evaluateContextRanking(input: ContextRankingEvaluationInput): ContextRankingEvaluation {
  if (!Number.isFinite(input.actual_tokens) || input.actual_tokens < 0 || !Number.isFinite(input.token_budget) || input.token_budget <= 0) {
    throw new TypeError("Context ranking token counts require actual_tokens >= 0 and token_budget > 0");
  }
  const gains = input.ranked_ids.map((id) => Math.max(0, input.judgments[id] ?? 0));
  const idealGains = Object.values(input.judgments).map((grade) => Math.max(0, grade)).sort((left, right) => right - left).slice(0, gains.length || 1);
  const discountedGain = (values: readonly number[]) => values.reduce(
    (total, grade, index) => total + (2 ** grade - 1) / Math.log2(index + 2),
    0,
  );
  const ideal = discountedGain(idealGains);
  const firstRelevant = gains.findIndex((grade) => grade > 0);
  const actualIds = new Set(input.ranked_ids);
  const withinBudget = input.actual_tokens <= input.token_budget;
  return {
    ndcg: ideal === 0 ? 1 : discountedGain(gains) / ideal,
    reciprocal_rank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    required_recall: ratioOfPresent(input.required_ids ?? [], actualIds),
    continuity_coverage: ratioOfPresent(input.continuity_ids ?? [], actualIds),
    token_budget_adherence: withinBudget ? 1 : input.token_budget / input.actual_tokens,
    within_token_budget: withinBudget,
  };
}

function estimateJsonTokens(value: unknown): number {
  return Math.ceil(JSON_TOKEN_ENCODER.encode(JSON.stringify(value)).byteLength / 4);
}

function roundEvaluationMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function rankingPayloadForScenario(
  result: ContextEvaluationContextResult | ContextEvaluationNextResult,
  surface: ContextRelevanceSurface,
): { rankedIds: string[]; attribution: ContextEvaluationAttribution[] } {
  const rankedIds = surface === "context"
    ? [
        ...((result as ContextEvaluationContextResult).high_level ?? []),
        ...((result as ContextEvaluationContextResult).low_level ?? []),
        ...((result as ContextEvaluationContextResult).blocked_fallback ?? []),
      ]
        .map((item) => item.id)
    : ((result as ContextEvaluationNextResult).ready ?? []).map((item) => item.id);
  const servedIds = new Set(rankedIds);
  const attribution = (result.ranking?.items ?? [])
    .filter((item) => servedIds.has(item.id))
    .map((item) => ({ id: item.id, contributions: item.contributions }));
  return { rankedIds, attribution };
}

/** Execute one graded scenario through public SDK context/next read primitives. */
export async function runContextEvaluationScenario(
  scenario: ContextEvaluationScenario,
  reader: ContextEvaluationReader,
): Promise<ContextEvaluationScenarioReport> {
  if (scenario.id.trim().length === 0 || scenario.rationale.trim().length === 0) {
    throw new TypeError("Context evaluation scenarios require non-empty id and rationale values");
  }
  const result = scenario.surface === "context"
    ? await reader.context({ ...scenario.options, explainRanking: true })
    : await reader.next({ ...scenario.options, explainRanking: true });
  const { rankedIds, attribution } = rankingPayloadForScenario(result, scenario.surface);
  const packet = { ...result, ranking: undefined };
  const actualTokens = estimateJsonTokens(packet);
  return {
    id: scenario.id,
    surface: scenario.surface,
    rationale: scenario.rationale,
    ranked_ids: rankedIds,
    actual_tokens: actualTokens,
    metrics: evaluateContextRanking({
      ranked_ids: rankedIds,
      judgments: scenario.judgments,
      required_ids: scenario.required_ids,
      continuity_ids: scenario.continuity_ids,
      actual_tokens: actualTokens,
      token_budget: scenario.token_budget,
    }),
    attribution,
  };
}

/** Aggregate scenario reports and evaluate every metric against explicit thresholds. */
export function summarizeContextEvaluationReports(
  reports: readonly ContextEvaluationScenarioReport[],
  thresholds: ContextEvaluationThresholds,
): ContextEvaluationCorpusReport {
  if (reports.length === 0) {
    throw new TypeError("Context evaluation requires at least one scenario report");
  }
  const metrics = Object.keys(thresholds) as Array<keyof ContextEvaluationThresholds>;
  const aggregate = Object.fromEntries(
    metrics.map((metric) => [
      metric,
      roundEvaluationMetric(reports.reduce((total, report) => total + report.metrics[metric], 0) / reports.length),
    ]),
  ) as unknown as ContextEvaluationThresholds;
  const failures = metrics
    .filter((metric) => aggregate[metric] < thresholds[metric])
    .map((metric) => `${metric}:${aggregate[metric]}<${thresholds[metric]}`);
  return {
    scenario_count: reports.length,
    aggregate,
    scenarios: [...reports],
    passed: failures.length === 0,
    failures,
  };
}

/** Execute a same-workspace scenario corpus through public SDK read primitives. */
export async function runContextEvaluationCorpus(
  scenarios: readonly ContextEvaluationScenario[],
  reader: ContextEvaluationReader,
  thresholds: ContextEvaluationThresholds,
): Promise<ContextEvaluationCorpusReport> {
  const reports: ContextEvaluationScenarioReport[] = [];
  for (const scenario of scenarios) {
    reports.push(await runContextEvaluationScenario(scenario, reader));
  }
  return summarizeContextEvaluationReports(reports, thresholds);
}
