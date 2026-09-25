/**
 * @module core/search/eval-thresholds
 *
 * Validates and evaluates per-query retrieval floors independently of aggregate
 * scores. Shared by the public evaluator and repository quality gates.
 */

/** Ranking metrics eligible for a declared quality floor. */
export const EVAL_METRIC_NAMES = ["ndcg", "mrr", "precision", "recall"] as const;

/** Optional normalized lower bounds; omitted metrics impose no constraint. */
export type EvalMetricFloors = Partial<Record<typeof EVAL_METRIC_NAMES[number], number>>;

/** Reject malformed or misspelled floors rather than silently weakening a quality contract. */
export function parseEvalMetricFloors(value: unknown): EvalMetricFloors {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Eval minimum must be an object of metric floors");
  }
  const result: EvalMetricFloors = {};
  for (const [key, floor] of Object.entries(value)) {
    if (!EVAL_METRIC_NAMES.some((metric) => metric === key)) {
      throw new TypeError(`Unknown eval minimum metric: ${key}`);
    }
    if (typeof floor !== "number" || !Number.isFinite(floor) || floor < 0 || floor > 1) {
      throw new TypeError(`Eval minimum.${key} must be a finite number in [0, 1]`);
    }
    result[key as typeof EVAL_METRIC_NAMES[number]] = floor;
  }
  return result;
}

/** Compare unrounded metrics to validated floors and return stable, actionable violations. */
export function evaluateMetricFloors(
  metrics: Record<typeof EVAL_METRIC_NAMES[number], number>,
  floors: EvalMetricFloors,
): string[] {
  const validated = parseEvalMetricFloors(floors);
  const violations: string[] = [];
  for (const metric of EVAL_METRIC_NAMES) {
    const minimum = validated[metric];
    if (minimum === undefined) continue;
    const actual = metrics[metric];
    if (!Number.isFinite(actual) || actual < 0 || actual > 1) {
      violations.push(`${metric}:invalid`);
    } else if (actual < minimum) {
      violations.push(`${metric}:${actual}<${minimum}`);
    }
  }
  return violations;
}
