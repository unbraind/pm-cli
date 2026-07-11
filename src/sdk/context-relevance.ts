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
export type ContextRelevanceSignalName =
  (typeof CONTEXT_RELEVANCE_SIGNAL_NAMES)[number];

/** Normalized candidate features; omitted signals are excluded from weighting. */
export type ContextRelevanceSignals = Partial<
  Record<Exclude<ContextRelevanceSignalName, "structural">, number>
>;

/** A project-management object and its derived relevance signals. */
export interface ContextRelevanceCandidate<TItem> {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports item for this contract. */
  item: TItem;
  /** Value that configures or reports signals for this contract. */
  signals?: ContextRelevanceSignals;
}

/** Per-signal weighted contributions used to explain a ranked result. */
export type ContextRelevanceContributions = Record<string, number>;

/** One ranked candidate with deterministic score and explanation metadata. */
export interface RankedContextCandidate<
  TItem,
> extends ContextRelevanceCandidate<TItem> {
  /** Value that configures or reports baseline rank for this contract. */
  baseline_rank: number;
  /** Value that configures or reports rank for this contract. */
  rank: number;
  /** Value that configures or reports score for this contract. */
  score: number;
  /** Value that configures or reports contributions for this contract. */
  contributions: ContextRelevanceContributions;
}

/** Complete output from a context relevance scorer. */
export interface ContextRelevanceReport<TItem> {
  /** Value that configures or reports model for this contract. */
  model: string;
  /** Value that configures or reports available signals for this contract. */
  available_signals: ContextRelevanceSignalName[];
  /** Value that configures or reports ranked for this contract. */
  ranked: RankedContextCandidate<TItem>[];
  /** Value that configures or reports warnings for this contract. */
  warnings?: string[];
}

/** Minimal custom score returned by a replacement or wrapper scorer. */
export interface ContextRelevanceCustomScore {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports score for this contract. */
  score: number;
}

/** Input provided to a custom scorer, including the deterministic default. */
export interface ContextRelevanceScorerInput<TItem> {
  /** Value that configures or reports candidates for this contract. */
  candidates: readonly ContextRelevanceCandidate<TItem>[];
  /** Fallback report used when callers do not provide an override. */
  default_report: ContextRelevanceReport<TItem>;
}

/** Replaceable package/extension scorer contract. */
export type ContextRelevanceScorer<TItem> = (
  input: ContextRelevanceScorerInput<TItem>,
) =>
  | readonly ContextRelevanceCustomScore[]
  | Promise<readonly ContextRelevanceCustomScore[]>;

/** Options for the built-in or replaceable context relevance scorer. */
export interface ScoreContextCandidatesOptions<TItem> {
  /** Value that configures or reports weights for this contract. */
  weights?: Partial<Record<ContextRelevanceSignalName, number>>;
  /** Value that configures or reports scorer for this contract. */
  scorer?: ContextRelevanceScorer<TItem>;
}

/** Governed extension service used to replace or wrap context ranking. */
export const CONTEXT_RELEVANCE_SERVICE = "context_relevance" as const;

/** Command surface requesting an active extension relevance override. */
export type ContextRelevanceSurface = "context" | "next";

const DEFAULT_CONTEXT_RELEVANCE_WEIGHTS: Record<
  ContextRelevanceSignalName,
  number
> = {
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

function assertCandidates<TItem>(
  candidates: readonly ContextRelevanceCandidate<TItem>[],
): void {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (
      typeof candidate.id !== "string" ||
      candidate.id.trim().length === 0 ||
      ids.has(candidate.id)
    ) {
      throw new TypeError(
        "Context relevance candidates require unique non-empty ids",
      );
    }
    ids.add(candidate.id);
    for (const [signal, value] of Object.entries(candidate.signals ?? {})) {
      if (
        signal === "structural" ||
        !CONTEXT_RELEVANCE_SIGNAL_NAMES.includes(
          signal as ContextRelevanceSignalName,
        )
      ) {
        throw new TypeError(`Unknown context relevance signal: ${signal}`);
      }
      if (value === undefined) continue;
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new TypeError(
          `Context relevance signal ${signal} must be a finite number from 0 to 1`,
        );
      }
    }
  }
}

function resolveWeights(
  overrides: Partial<Record<ContextRelevanceSignalName, number>> | undefined,
): Record<ContextRelevanceSignalName, number> {
  const weights = { ...DEFAULT_CONTEXT_RELEVANCE_WEIGHTS };
  for (const [signal, weight] of Object.entries(overrides ?? {})) {
    if (
      weight !== undefined &&
      CONTEXT_RELEVANCE_SIGNAL_NAMES.includes(
        signal as ContextRelevanceSignalName,
      )
    ) {
      weights[signal as ContextRelevanceSignalName] = weight;
    }
  }
  for (const [signal, weight] of Object.entries(weights)) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new TypeError(
        `Context relevance weight ${signal} must be a finite non-negative number`,
      );
    }
  }
  return weights;
}

/** Score candidates with pm's deterministic weighted model. Candidate order is the structural baseline and remains unchanged when no advanced signals exist. */
export function defaultScoreContextCandidates<TItem>(
  candidates: readonly ContextRelevanceCandidate<TItem>[],
  options: Pick<ScoreContextCandidatesOptions<TItem>, "weights"> = {},
): ContextRelevanceReport<TItem> {
  assertCandidates(candidates);
  const weights = resolveWeights(options.weights);
  const denominator = Math.max(candidates.length - 1, 1);
  const available = new Set<ContextRelevanceSignalName>(["structural"]);
  for (const candidate of candidates) {
    for (const [signal, value] of Object.entries(candidate.signals ?? {})) {
      if (value !== undefined)
        available.add(signal as ContextRelevanceSignalName);
    }
  }
  const availableSignals = CONTEXT_RELEVANCE_SIGNAL_NAMES.filter((signal) =>
    available.has(signal),
  );
  const scored = candidates.map(
    (candidate, index): RankedContextCandidate<TItem> => {
      const signalValues: Partial<Record<ContextRelevanceSignalName, number>> =
        {
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
    },
  );
  scored.sort(
    (left, right) =>
      right.score - left.score || left.baseline_rank - right.baseline_rank,
  );
  scored.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  return {
    model: "default-weighted-v1",
    available_signals: availableSignals,
    ranked: scored,
  };
}

/** Score candidates with the default model or a validated replacement/wrapper. */
export async function scoreContextCandidates<TItem>(
  candidates: readonly ContextRelevanceCandidate<TItem>[],
  options: ScoreContextCandidatesOptions<TItem> = {},
): Promise<ContextRelevanceReport<TItem>> {
  const defaultReport = defaultScoreContextCandidates(candidates, options);
  if (!options.scorer) return defaultReport;
  const customScores = await options.scorer({
    candidates,
    default_report: defaultReport,
  });
  const scoreById = new Map<string, number>();
  for (const entry of customScores) {
    if (scoreById.has(entry.id) || !Number.isFinite(entry.score)) {
      throw new TypeError(
        "Context relevance scorer must return one finite score for every candidate",
      );
    }
    scoreById.set(entry.id, entry.score);
  }
  if (
    scoreById.size !== candidates.length ||
    candidates.some((candidate) => !scoreById.has(candidate.id))
  ) {
    throw new TypeError(
      "Context relevance scorer must return one finite score for every candidate",
    );
  }
  const ranked = defaultReport.ranked.map((entry) => {
    const score = scoreById.get(entry.id) as number;
    return { ...entry, score, contributions: { custom: score } };
  });
  ranked.sort(
    (left, right) =>
      right.score - left.score || left.baseline_rank - right.baseline_rank,
  );
  ranked.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  return {
    model: "custom",
    available_signals: defaultReport.available_signals,
    ranked,
  };
}

/** Score command candidates through the public default model and then the active governed `context_relevance` service override, when one is registered. */
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
    return override.warnings.length > 0
      ? { ...defaultReport, warnings: override.warnings }
      : defaultReport;
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
    return {
      ...defaultReport,
      warnings: [
        ...override.warnings,
        "extension_context_relevance_invalid_result",
      ],
    };
  }
  try {
    const report = await scoreContextCandidates(candidates, {
      ...options,
      scorer: () => override.result as ContextRelevanceCustomScore[],
    });
    return override.warnings.length > 0
      ? { ...report, warnings: override.warnings }
      : report;
  } catch {
    return {
      ...defaultReport,
      warnings: [
        ...override.warnings,
        "extension_context_relevance_invalid_result",
      ],
    };
  }
}

/** Input for rank-aware context/next quality evaluation. */
export interface ContextRankingEvaluationInput {
  /** Value that configures or reports ranked ids for this contract. */
  ranked_ids: string[];
  /** Value that configures or reports judgments for this contract. */
  judgments: Record<string, number>;
  /** Value that configures or reports required ids for this contract. */
  required_ids?: string[];
  /** Value that configures or reports continuity ids for this contract. */
  continuity_ids?: string[];
  /** Value that configures or reports actual tokens for this contract. */
  actual_tokens: number;
  /** Value that configures or reports token budget for this contract. */
  token_budget: number;
}

/** Rank-quality, continuity, recall, and token-budget metrics for one scenario. */
export interface ContextRankingEvaluation {
  /** Value that configures or reports ndcg for this contract. */
  ndcg: number;
  /** Value that configures or reports reciprocal rank for this contract. */
  reciprocal_rank: number;
  /** Value that configures or reports required recall for this contract. */
  required_recall: number;
  /** Value that configures or reports continuity coverage for this contract. */
  continuity_coverage: number;
  /** Value that configures or reports token budget adherence for this contract. */
  token_budget_adherence: number;
  /** Value that configures or reports within token budget for this contract. */
  within_token_budget: boolean;
}

/** Flexible read options accepted by context evaluation scenarios. */
export interface ContextEvaluationReadOptions {
  /** Value that configures or reports explain ranking for this contract. */
  explainRanking?: boolean;
  [key: string]: unknown;
}

/** Minimal item identity consumed by the context evaluation runner. */
export interface ContextEvaluationResultItem {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
}

/** Optional scorer attribution returned by an evaluated read primitive. */
export interface ContextEvaluationResultRanking {
  /** Value that configures or reports items for this contract. */
  items?: Array<{ id: string; contributions: ContextRelevanceContributions }>;
}

/** Structural context result consumed by the evaluation runner. */
export interface ContextEvaluationContextResult {
  /** Value that configures or reports high level for this contract. */
  high_level?: ContextEvaluationResultItem[];
  /** Value that configures or reports low level for this contract. */
  low_level?: ContextEvaluationResultItem[];
  /** Value that configures or reports blocked fallback for this contract. */
  blocked_fallback?: ContextEvaluationResultItem[];
  /** Value that configures or reports ranking for this contract. */
  ranking?: ContextEvaluationResultRanking;
  [key: string]: unknown;
}

/** Structural next result consumed by the evaluation runner. */
export interface ContextEvaluationNextResult {
  /** Value that configures or reports recommended for this contract. */
  recommended?: ContextEvaluationResultItem | null;
  /** Value that configures or reports ready for this contract. */
  ready?: ContextEvaluationResultItem[];
  /** Value that configures or reports ranking for this contract. */
  ranking?: ContextEvaluationResultRanking;
  [key: string]: unknown;
}

/** Read-only SDK surface required by the context evaluation runner. */
export interface ContextEvaluationReader {
  /** Value that configures or reports context for this contract. */
  context(
    options?: ContextEvaluationReadOptions,
  ): Promise<ContextEvaluationContextResult>;
  /** Value that configures or reports next for this contract. */
  next(
    options?: ContextEvaluationReadOptions,
  ): Promise<ContextEvaluationNextResult>;
}

/** One graded context or next scenario evaluated against a real SDK reader. */
export interface ContextEvaluationScenario {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports surface for this contract. */
  surface: ContextRelevanceSurface;
  /** Value that configures or reports options for this contract. */
  options?: ContextEvaluationReadOptions;
  /** Value that configures or reports judgments for this contract. */
  judgments: Record<string, number>;
  /** Value that configures or reports required ids for this contract. */
  required_ids?: string[];
  /** Value that configures or reports continuity ids for this contract. */
  continuity_ids?: string[];
  /** Value that configures or reports token budget for this contract. */
  token_budget: number;
  /** Value that configures or reports rationale for this contract. */
  rationale: string;
}

/** Per-item signal attribution retained by a context evaluation report. */
export interface ContextEvaluationAttribution {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports contributions for this contract. */
  contributions: ContextRelevanceContributions;
}

/** Result of executing and grading one context evaluation scenario. */
export interface ContextEvaluationScenarioReport {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports surface for this contract. */
  surface: ContextRelevanceSurface;
  /** Value that configures or reports rationale for this contract. */
  rationale: string;
  /** Value that configures or reports ranked ids for this contract. */
  ranked_ids: string[];
  /** Value that configures or reports actual tokens for this contract. */
  actual_tokens: number;
  /** Value that configures or reports metrics for this contract. */
  metrics: ContextRankingEvaluation;
  /** Value that configures or reports attribution for this contract. */
  attribution: ContextEvaluationAttribution[];
}

/** Minimum acceptable aggregate metrics for a context evaluation corpus. */
export interface ContextEvaluationThresholds {
  /** Value that configures or reports ndcg for this contract. */
  ndcg: number;
  /** Value that configures or reports reciprocal rank for this contract. */
  reciprocal_rank: number;
  /** Value that configures or reports required recall for this contract. */
  required_recall: number;
  /** Value that configures or reports continuity coverage for this contract. */
  continuity_coverage: number;
  /** Value that configures or reports token budget adherence for this contract. */
  token_budget_adherence: number;
}

/** Canonical aggregate metrics required by every context evaluation corpus. */
export const CONTEXT_EVALUATION_METRIC_NAMES = [
  "ndcg",
  "reciprocal_rank",
  "required_recall",
  "continuity_coverage",
  "token_budget_adherence",
] as const satisfies readonly (keyof ContextEvaluationThresholds)[];

/** Aggregate context evaluation report suitable for a CI quality gate. */
export interface ContextEvaluationCorpusReport {
  /** Number of scenario entries represented by this result. */
  scenario_count: number;
  /** Value that configures or reports aggregate for this contract. */
  aggregate: ContextEvaluationThresholds;
  /** Value that configures or reports scenarios for this contract. */
  scenarios: ContextEvaluationScenarioReport[];
  /** Value that configures or reports passed for this contract. */
  passed: boolean;
  /** Value that configures or reports failures for this contract. */
  failures: string[];
}

function ratioOfPresent(
  expected: readonly string[],
  actual: ReadonlySet<string>,
): number {
  if (expected.length === 0) return 1;
  return expected.filter((id) => actual.has(id)).length / expected.length;
}

/** Evaluate one ranked context packet against graded human judgments. */
export function evaluateContextRanking(
  input: ContextRankingEvaluationInput,
): ContextRankingEvaluation {
  if (
    !Number.isFinite(input.actual_tokens) ||
    input.actual_tokens < 0 ||
    !Number.isFinite(input.token_budget) ||
    input.token_budget <= 0
  ) {
    throw new TypeError(
      "Context ranking token counts require actual_tokens >= 0 and token_budget > 0",
    );
  }
  const judgments = input.judgments ?? {};
  const gains = input.ranked_ids.map((id) => Math.max(0, judgments[id] ?? 0));
  const idealGains = Object.values(judgments)
    .map((grade) => Math.max(0, grade))
    .sort((left, right) => right - left)
    .slice(0, gains.length || 1);
  const discountedGain = (values: readonly number[]) =>
    values.reduce(
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
    token_budget_adherence: withinBudget
      ? 1
      : input.token_budget / input.actual_tokens,
    within_token_budget: withinBudget,
  };
}

function estimateJsonTokens(value: unknown): number {
  return Math.ceil(
    JSON_TOKEN_ENCODER.encode(JSON.stringify(value)).byteLength / 4,
  );
}

function roundEvaluationMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function rankingPayloadForScenario(
  result: ContextEvaluationContextResult | ContextEvaluationNextResult,
  surface: ContextRelevanceSurface,
): { rankedIds: string[]; attribution: ContextEvaluationAttribution[] } {
  const rankedIds =
    surface === "context"
      ? [
          ...((result as ContextEvaluationContextResult).high_level ?? []),
          ...((result as ContextEvaluationContextResult).low_level ?? []),
          ...((result as ContextEvaluationContextResult).blocked_fallback ??
            []),
        ].map((item) => item.id)
      : [
          ...((result as ContextEvaluationNextResult).recommended
            ? [
                (result as ContextEvaluationNextResult)
                  .recommended as ContextEvaluationResultItem,
              ]
            : []),
          ...((result as ContextEvaluationNextResult).ready ?? []),
        ].map((item) => item.id);
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
  if (
    scenario.id.trim().length === 0 ||
    scenario.rationale.trim().length === 0
  ) {
    throw new TypeError(
      "Context evaluation scenarios require non-empty id and rationale values",
    );
  }
  const result =
    scenario.surface === "context"
      ? await reader.context({ ...scenario.options, explainRanking: true })
      : await reader.next({ ...scenario.options, explainRanking: true });
  const { rankedIds, attribution } = rankingPayloadForScenario(
    result,
    scenario.surface,
  );
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
    throw new TypeError(
      "Context evaluation requires at least one scenario report",
    );
  }
  const metrics = CONTEXT_EVALUATION_METRIC_NAMES;
  for (const metric of metrics) {
    if (!Number.isFinite(thresholds[metric])) {
      throw new TypeError(
        `Context evaluation threshold ${metric} must be a finite number`,
      );
    }
  }
  const aggregate = Object.fromEntries(
    metrics.map((metric) => [
      metric,
      roundEvaluationMetric(
        reports.reduce((total, report) => total + report.metrics[metric], 0) /
          reports.length,
      ),
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
