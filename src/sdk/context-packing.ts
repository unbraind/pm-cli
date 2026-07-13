/**
 * @module sdk/context-packing
 *
 * Deterministic, token-budget-aware packing primitives for ranked context and
 * next-work candidates. The packer is deliberately storage-agnostic so custom
 * tools can reuse the exact selection contract with their own projections.
 */

/** Detail levels a context candidate may occupy inside a bounded packet. */
export type ContextProjectionLevel = "identity" | "summary" | "full";

/** Stable intent-keyed policies for risk, diversity, and safety-aware packing. */
export const CONTEXT_PACKING_PROFILES = {
  balanced: { redundancyPenalty: 0.35, uncertaintyPenalty: 0.2 },
  context: { redundancyPenalty: 0.45, uncertaintyPenalty: 0.15 },
  next: { redundancyPenalty: 0.25, uncertaintyPenalty: 0.3 },
} as const;

/** Built-in task-set profiles selected from the triggering command intent. */
export type ContextPackingProfile = keyof typeof CONTEXT_PACKING_PROFILES;

/** Token costs for the monotone projection levels of one candidate. */
export interface ContextProjectionCosts {
  /** Stable identity-only representation cost. */
  identity: number;
  /** Compact summary representation cost. */
  summary: number;
  /** Full representation cost. */
  full: number;
}

/** One ranked candidate offered to the context packet optimizer. */
export interface ContextPackingCandidate<TItem> {
  /** Stable candidate identifier. */
  id: string;
  /** Caller-owned value returned unchanged for selected candidates. */
  item: TItem;
  /** One-based relevance rank; lower is better. */
  rank: number;
  /** Normalized relevance score. */
  score: number;
  /** Projection-specific token estimates. */
  token_costs: ContextProjectionCosts;
  /** Candidates sharing a cluster compete through a redundancy penalty. */
  cluster?: string;
  /** Required anchors are admitted before optional candidates. */
  required?: boolean;
  /** Optional credible-width estimate used for risk-adjusted value. */
  uncertainty?: number;
  /** Optional lineage identity used to suppress superseded duplicates. */
  lineage?: string;
}

/** One selected candidate and the projection depth bought for it. */
export interface PackedContextCandidate<
  TItem,
> extends ContextPackingCandidate<TItem> {
  /** Projection depth selected by the packer. */
  projection: ContextProjectionLevel;
  /** Tokens charged to the packet. */
  tokens: number;
  /** Risk- and redundancy-adjusted value used for selection. */
  marginal_value: number;
}

/** Accounting and completeness metadata for one packed context packet. */
export interface ContextPackingReport<TItem> {
  /** Selected candidates in deterministic relevance order. */
  included: PackedContextCandidate<TItem>[];
  /** Ranked candidate identifiers omitted after projection degradation. */
  omitted_ids: string[];
  /** Explicit packet token budget. */
  token_budget: number;
  /** Estimated tokens consumed by selected projections. */
  used_tokens: number;
  /** Tokens left unspent. */
  remaining_tokens: number;
  /** True when every candidate fit at full detail. */
  complete: boolean;
  /** Whether selection inspected every optional candidate before its deadline. */
  selection_complete: boolean;
  /** Machine-readable reason selection stopped. */
  termination_reason: "exhausted" | "latency_budget";
  /** Candidate comparisons completed by the bounded selector. */
  evaluated_candidates: number;
  /** Explicit selection latency budget, or null when unbounded. */
  latency_budget_ms: number | null;
  /** Stable task-set profile disclosed to downstream evaluation. */
  profile: ContextPackingProfile;
  /** Projection degradation order used by the optimizer. */
  degradation_ladder: ContextProjectionLevel[];
}

/** Options controlling deterministic packet selection. */
export interface PackContextCandidatesOptions {
  /** Maximum estimated tokens available to the packet. */
  tokenBudget: number;
  /** Task-set profile disclosed in the result envelope. */
  profile?: ContextPackingProfile;
  /** Penalty applied when a cluster or lineage is already represented. */
  redundancyPenalty?: number;
  /** Risk-aversion coefficient applied to candidate uncertainty. */
  uncertaintyPenalty?: number;
  /** Maximum selector wall-clock time; required anchors remain mask-immune. */
  latencyBudgetMs?: number;
  /** Monotonic clock override for deterministic hosts and tests. */
  readClock?: () => number;
}

const PROJECTION_LEVELS: ContextProjectionLevel[] = [
  "identity",
  "summary",
  "full",
];

function assertPackingCandidate<TItem>(
  candidate: ContextPackingCandidate<TItem>,
): void {
  if (
    !candidate.id.trim() ||
    !Number.isInteger(candidate.rank) ||
    candidate.rank < 1
  ) {
    throw new TypeError(
      "Context packing candidates require a non-empty id and positive integer rank",
    );
  }
  if (!Number.isFinite(candidate.score) || candidate.score < 0) {
    throw new TypeError(
      "Context packing candidate scores must be finite and non-negative",
    );
  }
  const costs = PROJECTION_LEVELS.map((level) => candidate.token_costs[level]);
  if (
    costs.some((cost) => !Number.isInteger(cost) || cost < 1) ||
    costs[0]! > costs[1]! ||
    costs[1]! > costs[2]!
  ) {
    throw new TypeError(
      "Context projection costs must be positive monotone integers",
    );
  }
  if (
    candidate.uncertainty !== undefined &&
    (!Number.isFinite(candidate.uncertainty) || candidate.uncertainty < 0)
  ) {
    throw new TypeError(
      "Context packing uncertainty must be finite and non-negative",
    );
  }
}

function resolvePackingPenalties(options: PackContextCandidatesOptions): {
  redundancy: number;
  uncertainty: number;
  profile: ContextPackingProfile;
} {
  if (!Number.isInteger(options.tokenBudget) || options.tokenBudget < 1) {
    throw new TypeError(
      "Context packing tokenBudget must be a positive integer",
    );
  }
  const profile = options.profile ?? "balanced";
  const policy = CONTEXT_PACKING_PROFILES[profile];
  if (!policy) throw new TypeError("Unknown context packing profile");
  const redundancy = options.redundancyPenalty ?? policy.redundancyPenalty;
  const uncertainty = options.uncertaintyPenalty ?? policy.uncertaintyPenalty;
  if (
    !Number.isFinite(redundancy) ||
    redundancy < 0 ||
    redundancy > 1 ||
    !Number.isFinite(uncertainty) ||
    uncertainty < 0
  ) {
    throw new TypeError(
      "Context packing penalties must be finite and within their supported ranges",
    );
  }
  if (
    options.latencyBudgetMs !== undefined &&
    (!Number.isFinite(options.latencyBudgetMs) || options.latencyBudgetMs <= 0)
  ) {
    throw new TypeError("Context packing latencyBudgetMs must be positive");
  }
  return { redundancy, uncertainty, profile };
}

function orderPackingCandidates<TItem>(
  candidates: readonly ContextPackingCandidate<TItem>[],
): ContextPackingCandidate<TItem>[] {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    assertPackingCandidate(candidate);
    if (ids.has(candidate.id)) {
      throw new TypeError("Context packing candidates require unique ids");
    }
    ids.add(candidate.id);
  }
  return [...candidates].sort(
    (left, right) => left.rank - right.rank || left.id.localeCompare(right.id),
  );
}

function findBestAffordableCandidate<TItem>(
  candidates: ContextPackingCandidate<TItem>[],
  remaining: number,
  valueOf: (candidate: ContextPackingCandidate<TItem>) => number,
  deadline: number,
  readClock: () => number,
): { index: number; evaluated: number; timedOut: boolean } {
  let bestIndex = -1;
  let evaluated = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    if (index % 128 === 0 && readClock() >= deadline) {
      return { index: bestIndex, evaluated, timedOut: true };
    }
    const candidate = candidates[index]!;
    if (candidate.token_costs.identity > remaining) continue;
    evaluated += 1;
    const best = bestIndex < 0 ? undefined : candidates[bestIndex];
    const density = valueOf(candidate) / candidate.token_costs.identity;
    const bestDensity =
      best === undefined
        ? Number.NEGATIVE_INFINITY
        : valueOf(best) / best.token_costs.identity;
    if (
      density > bestDensity ||
      (density === bestDensity &&
        best !== undefined &&
        (candidate.rank < best.rank ||
          (candidate.rank === best.rank &&
            candidate.id.localeCompare(best.id) < 0)))
    ) {
      bestIndex = index;
    }
  }
  return { index: bestIndex, evaluated, timedOut: false };
}

function selectIdentityCandidates<TItem>(params: {
  ordered: ContextPackingCandidate<TItem>[];
  tokenBudget: number;
  redundancyPenalty: number;
  uncertaintyPenalty: number;
  deadline: number;
  readClock: () => number;
}): {
  included: PackedContextCandidate<TItem>[];
  remaining: number;
  selectionComplete: boolean;
  evaluatedCandidates: number;
} {
  const represented = new Set<string>();
  const included: PackedContextCandidate<TItem>[] = [];
  let remaining = params.tokenBudget;
  const valueOf = (candidate: ContextPackingCandidate<TItem>): number => {
    const key = candidate.lineage ?? candidate.cluster;
    const redundancy =
      key && represented.has(key) ? 1 - params.redundancyPenalty : 1;
    return Math.max(
      0,
      (candidate.score -
        params.uncertaintyPenalty * (candidate.uncertainty ?? 0)) *
        redundancy,
    );
  };
  const admit = (candidate: ContextPackingCandidate<TItem>): void => {
    const tokens = candidate.token_costs.identity;
    included.push({
      ...candidate,
      projection: "identity",
      tokens,
      marginal_value: valueOf(candidate),
    });
    remaining -= tokens;
    const key = candidate.lineage ?? candidate.cluster;
    if (key) represented.add(key);
  };

  for (const candidate of params.ordered.filter((entry) => entry.required)) {
    if (candidate.token_costs.identity <= remaining) admit(candidate);
  }
  const optional = params.ordered.filter((entry) => !entry.required);
  let selectionComplete = true;
  let evaluatedCandidates = 0;
  while (optional.length > 0) {
    const selection = findBestAffordableCandidate(
      optional,
      remaining,
      valueOf,
      params.deadline,
      params.readClock,
    );
    evaluatedCandidates += selection.evaluated;
    if (selection.timedOut) selectionComplete = false;
    if (selection.index < 0 || selection.timedOut) break;
    admit(optional.splice(selection.index, 1)[0]!);
  }
  return {
    included,
    remaining,
    selectionComplete,
    evaluatedCandidates,
  };
}

function upgradeSelectedProjections<TItem>(
  included: PackedContextCandidate<TItem>[],
  initialRemaining: number,
): number {
  let remaining = initialRemaining;
  for (const target of ["summary", "full"] as const) {
    const previous: ContextProjectionLevel =
      target === "summary" ? "identity" : "summary";
    const upgrades = [...included].sort((left, right) => {
      const leftCost = left.token_costs[target] - left.token_costs[previous];
      const rightCost = right.token_costs[target] - right.token_costs[previous];
      return (
        right.marginal_value / Math.max(rightCost, 1) -
          left.marginal_value / Math.max(leftCost, 1) || left.rank - right.rank || left.id.localeCompare(right.id)
      );
    });
    for (const entry of upgrades) {
      if (entry.projection !== previous) continue;
      const extra = entry.token_costs[target] - entry.tokens;
      if (extra > remaining) continue;
      entry.projection = target;
      entry.tokens += extra;
      remaining -= extra;
    }
  }
  return remaining;
}

/**
 * Packs ranked candidates under an explicit token budget. Required anchors are
 * admitted first, optional rows compete by marginal value per token, and then
 * selected rows are upgraded from identity to summary to full detail. This
 * guarantees projection degradation happens before omission.
 */
export function packContextCandidates<TItem>(
  candidates: readonly ContextPackingCandidate<TItem>[],
  options: PackContextCandidatesOptions,
): ContextPackingReport<TItem> {
  const penalties = resolvePackingPenalties(options);
  const ordered = orderPackingCandidates(candidates);
  const readClock = options.readClock ?? performance.now.bind(performance);
  const deadline =
    options.latencyBudgetMs === undefined
      ? Number.POSITIVE_INFINITY
      : readClock() + options.latencyBudgetMs;
  const selection = selectIdentityCandidates({
    ordered,
    tokenBudget: options.tokenBudget,
    redundancyPenalty: penalties.redundancy,
    uncertaintyPenalty: penalties.uncertainty,
    deadline,
    readClock,
  });
  const { included } = selection;
  const remaining = upgradeSelectedProjections(included, selection.remaining);
  included.sort(
    (left, right) => left.rank - right.rank || left.id.localeCompare(right.id),
  );
  const selected = new Set(included.map((entry) => entry.id));
  return {
    included,
    omitted_ids: ordered
      .filter((entry) => !selected.has(entry.id))
      .map((entry) => entry.id),
    token_budget: options.tokenBudget,
    used_tokens: options.tokenBudget - remaining,
    remaining_tokens: remaining,
    complete:
      selection.selectionComplete &&
      included.length === candidates.length &&
      included.every((entry) => entry.projection === "full"),
    selection_complete: selection.selectionComplete,
    termination_reason: selection.selectionComplete
      ? "exhausted"
      : "latency_budget",
    evaluated_candidates: selection.evaluatedCandidates,
    latency_budget_ms: options.latencyBudgetMs ?? null,
    profile: penalties.profile,
    degradation_ladder: ["full", "summary", "identity"],
  };
}
