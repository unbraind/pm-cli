/**
 * @module sdk/dependencies/context-budget-recovery
 * Finds verified retry budgets while bounding query work and distinguishing proved minima from partial searches.
 */
import type { PmTokenBudgetRecovery } from "../../core/shared/errors.js";

/** A real packer probe distinguishes its own floor from an independent output constraint. */
export type ContextBudgetProbe = "fits" | "native_floor" | "output_constraints";

/** Inputs derived from one immutable relationship assembly and preserved retry options. */
interface ContextBudgetRecoveryInput {
  /** Failed query's requested token ceiling. */
  requested: number;
  /** Initial upper candidate derived from the kernel's canonical default. */
  initialBudget: number;
  /** Conservative graph and text-size work estimate for each packer evaluation. */
  workUnits: number;
  /** Evaluate the real preserved query at one positive integer budget. */
  probe: (tokens: number) => ContextBudgetProbe;
}

/** Produce explicit unavailable advice without inventing a numeric minimum. */
function unavailable(
  requested: number,
  reason: PmTokenBudgetRecovery["reason"],
): PmTokenBudgetRecovery {
  return {
    requested_tokens: requested,
    feasible_tokens: null,
    minimum_feasible_tokens: null,
    minimum_status: "unavailable",
    basis: "canonical_retry",
    reason,
  };
}

/** Find one native-success upper bound in at most sixteen growth evaluations. */
function nativeUpperBound(
  input: ContextBudgetRecoveryInput,
  probe: ContextBudgetRecoveryInput["probe"],
): number | undefined {
  let upper = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(input.initialBudget, input.requested + 1),
  );
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (probe(upper) !== "native_floor") return upper;
    if (upper === Number.MAX_SAFE_INTEGER) return undefined;
    upper = Math.min(Number.MAX_SAFE_INTEGER, upper * 2);
  }
  return undefined;
}

/** Establish a working retry and prove a global minimum only after exhaustive lower-budget verification. */
export function findContextBudgetRecovery(
  input: ContextBudgetRecoveryInput,
): PmTokenBudgetRecovery {
  if (input.workUnits > 1_000_000)
    return unavailable(input.requested, "query_cost_limit");
  const cache = new Map<number, ContextBudgetProbe>();
  let feasible: number | undefined;
  const probe = (tokens: number): ContextBudgetProbe => {
    let outcome = cache.get(tokens);
    if (outcome === undefined) {
      outcome = input.probe(tokens);
      cache.set(tokens, outcome);
    }
    if (outcome === "fits") feasible = Math.min(feasible ?? tokens, tokens);
    return outcome;
  };
  const upper = nativeUpperBound(input, probe);
  if (upper === undefined) return unavailable(input.requested, "search_limit");
  let left = 0;
  let right = upper;
  for (let step = 0; step < 24 && right - left > 1; step += 1) {
    const middle = left + Math.floor((right - left) / 2);
    if (probe(middle) === "native_floor") left = middle;
    else right = middle;
  }
  const verificationLimit = Math.min(
    feasible ?? upper,
    4096,
    Math.floor(100_000 / Math.max(1, input.workUnits)),
  );
  for (let tokens = 1; tokens <= verificationLimit; tokens += 1) {
    if (probe(tokens) === "fits")
      return {
        requested_tokens: input.requested,
        feasible_tokens: tokens,
        minimum_feasible_tokens: tokens,
        minimum_status: "exact",
        basis: "canonical_retry",
      };
  }
  return feasible === undefined
    ? unavailable(input.requested, "output_constraints")
    : {
        requested_tokens: input.requested,
        feasible_tokens: feasible,
        minimum_feasible_tokens: null,
        minimum_status: "feasible_only",
        basis: "canonical_retry",
      };
}
