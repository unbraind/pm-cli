/**
 * @module sdk/query/next-ready-budget
 *
 * Bounds the executable answer as an ordered prefix. The recommendation and
 * its alternatives share one budget; companion queues remain governed by the
 * universal output budget. Measurement includes the two field names and uses
 * the more expensive built-in structured renderer so transport cannot silently
 * enlarge the selected answer beyond this ceiling.
 */
import { estimateReadOutputTokens } from "../read-output-budget.js";
import type { NextResult } from "./next.js";

/** Evidence for a ready-selection ceiling, separate from the whole-response ceiling. */
export interface NextReadyBudgetReceipt {
  /** The exact fields charged to this selection budget. */
  scope: "recommended_and_ready";
  /** Maximum UTF-8 bytes/4 estimate requested by the caller. */
  budget_tokens: number;
  /** Greater of the JSON and TOON costs of the returned selection. */
  estimated_tokens: number;
  /** Whether even the empty selection fits the requested budget. */
  within_budget: boolean;
  /** Rows removed by this budget after the independent row limit. */
  omitted_count: number;
  /** Whether the highest-ranked recommendation was withheld. */
  recommendation_omitted: boolean;
  /** Cost of the full row-limited selection, suitable for a useful retry. */
  restore_budget_tokens: number;
}

/** Trim alternatives before the recommendation, retaining order and complete population counts. */
export function applyNextReadyBudget(result: NextResult, budget: number, hasIntentBudget: boolean): void {
  const selection = { recommended: result.recommended, ready: result.ready };
  const measure = (): number => Math.max(
    estimateReadOutputTokens(selection, "json"),
    estimateReadOutputTokens(selection, "toon"),
  );
  const originalCount = selection.ready.length + Number(selection.recommended !== null);
  const restoreBudget = measure();
  let estimate = restoreBudget;
  const alternatives = selection.ready;
  if (estimate > budget) {
    selection.ready = [];
    estimate = measure();
  }
  if (restoreBudget > budget && estimate <= budget) {
    let lower = 0;
    let upper = alternatives.length;
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      selection.ready = alternatives.slice(0, middle);
      if (measure() <= budget) lower = middle;
      else upper = middle - 1;
    }
    selection.ready = alternatives.slice(0, lower);
    estimate = measure();
  }
  const recommendationOmitted = estimate > budget && selection.recommended !== null;
  if (recommendationOmitted) {
    selection.recommended = null;
    estimate = measure();
  }
  result.recommended = selection.recommended;
  result.ready = selection.ready;
  result.summary.recommended = selection.recommended !== null;
  const omittedCount = originalCount - selection.ready.length - Number(selection.recommended !== null);
  // Intent reads already disclose their complete-response budget. Add a
  // selection receipt only when it conveys an omission or infeasible ceiling.
  if (hasIntentBudget && omittedCount === 0 && estimate <= budget) return;
  result.truncation = {
    ...result.truncation,
    ...(omittedCount > 0 ? { ready_total: result.summary.ready } : {}),
    ready_budget: {
      scope: "recommended_and_ready",
      budget_tokens: budget,
      estimated_tokens: estimate,
      within_budget: estimate <= budget,
      omitted_count: omittedCount,
      recommendation_omitted: recommendationOmitted,
      restore_budget_tokens: restoreBudget,
    },
  };
  if (recommendationOmitted) {
    result.suggestions = [
      `Ready work exists but the selection budget omitted the recommendation. Retry pm next --token-budget ${restoreBudget}; use --output-budget to bound the entire response.`,
    ];
  }
}
