/**
 * @module sdk/read-output-budget
 *
 * Implements deterministic, bounded result compaction for the universal
 * read-output contract without expanding its public declaration module.
 */
import type { PmReadOutputReceipt } from "./read-output-contracts.js";
import {
  countReadOutputRows,
  readOutputBudgetCollections,
} from "./read-output-rows.js";

interface StringCompactionState {
  /** Whether at least one string was shortened. */
  compacted: boolean;
}

const MAX_ESTIMATE_ITERATIONS = 8;
const MAX_COMPACTION_ITERATIONS = 64;
const RECOVERY_MARGIN_NUMERATOR = 5;
const RECOVERY_MARGIN_DENOMINATOR = 4;
const RECOVERY_ROUNDING_TOKENS = 100;

/** Input to the deterministic finite-retry recommendation contract. */
export interface PmReadOutputRecoveryBudgetInput {
  /** Ceiling that already bound and truncated the response. */
  effective_budget_tokens: number;
  /** Measured cost of the useful result before row compaction. */
  measured_result_tokens: number;
}

/** Executable next-budget recommendation shared by CLI, SDK, and MCP. */
export interface PmReadOutputRecoveryBudget {
  /** Rounded finite retry ceiling, or the only truthful safe fallback. */
  output_budget: number | "unbounded";
  /** Ratio to the binding request, absent when finite arithmetic is unsafe. */
  recovery_budget_multiplier: number | null;
  /** Stable algorithm revision for consumers and fixtures. */
  rule_version: "v1";
}

/**
 * Recommend a retry that is strictly larger than both the binding request and
 * the pre-compaction result, with a 25% envelope margin rounded to 100 tokens.
 */
export function resolveReadOutputRecoveryBudget(
  input: PmReadOutputRecoveryBudgetInput,
): PmReadOutputRecoveryBudget {
  const binding = Math.trunc(input.effective_budget_tokens);
  const measured = Math.trunc(input.measured_result_tokens);
  if (
    !Number.isSafeInteger(binding) ||
    binding <= 0 ||
    !Number.isSafeInteger(measured) ||
    measured <= 0
  ) {
    return {
      output_budget: "unbounded",
      recovery_budget_multiplier: null,
      rule_version: "v1",
    };
  }
  const baseline = Math.max(binding + 1, measured);
  const withMargin = Math.ceil(
    (baseline * RECOVERY_MARGIN_NUMERATOR) / RECOVERY_MARGIN_DENOMINATOR,
  );
  const rounded =
    Math.ceil(withMargin / RECOVERY_ROUNDING_TOKENS) *
    RECOVERY_ROUNDING_TOKENS;
  if (!Number.isSafeInteger(rounded)) {
    return {
      output_budget: "unbounded",
      recovery_budget_multiplier: null,
      rule_version: "v1",
    };
  }
  return {
    output_budget: rounded,
    recovery_budget_multiplier: rounded / binding,
    rule_version: "v1",
  };
}

/** Estimate the conservative token cost of a JSON-shaped result. */
export function estimateReadOutputTokens(result: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(result), "utf8") / 4);
}

/** Return whether a value is a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Recursively shorten explanatory strings and record whether content changed. */
function compactStrings(value: unknown, state: StringCompactionState): unknown {
  if (typeof value === "string") {
    if (value.length <= 240) return value;
    state.compacted = true;
    return `${value.slice(0, 240)}…`;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => compactStrings(entry, state));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      compactStrings(entry, state),
    ]),
  );
}

/** Update a receipt to the fixed-point estimate of the result containing it. */
export function updateReadOutputReceiptEstimate(
  result: Record<string, unknown>,
  receipt: PmReadOutputReceipt,
): void {
  let estimate = receipt.estimated_tokens;
  for (let iteration = 0; iteration < MAX_ESTIMATE_ITERATIONS; iteration += 1) {
    receipt.estimated_tokens = estimate;
    const measured = estimateReadOutputTokens(result);
    if (measured === estimate) return;
    estimate = measured;
  }
  receipt.estimated_tokens = estimate;
}

/** Reduce the largest row collection until the budget fits or no rows can move. */
function compactRowsToBudget(
  result: Record<string, unknown>,
  receipt: PmReadOutputReceipt,
  budget: number,
  minimumRowsByPath: ReadonlyMap<string, number>,
): void {
  for (
    let iteration = 0;
    iteration < MAX_COMPACTION_ITERATIONS;
    iteration += 1
  ) {
    updateReadOutputReceiptEstimate(result, receipt);
    if (receipt.estimated_tokens <= budget) return;
    const candidate = readOutputBudgetCollections(result)
      .filter((collection) => {
        const length = Array.isArray(collection.value)
          ? collection.value.length
          : Object.keys(collection.value).length;
        return (
          length > Math.max(1, minimumRowsByPath.get(collection.path) ?? 0)
        );
      })
      .map((collection) => ({
        collection,
        length: Array.isArray(collection.value)
          ? collection.value.length
          : Object.keys(collection.value).length,
      }))
      .sort(
        (left, right) =>
          right.length - left.length ||
          left.collection.path.localeCompare(right.collection.path),
      )[0]?.collection;
    if (!candidate) return;
    const minimumRows = Math.max(1, minimumRowsByPath.get(candidate.path) ?? 0);
    if (Array.isArray(candidate.value)) {
      candidate.value.splice(
        -Math.min(
          candidate.value.length - minimumRows,
          Math.max(1, Math.ceil(candidate.value.length / 2)),
        ),
      );
    } else {
      const keys = Object.keys(candidate.value);
      for (const key of keys.slice(
        -Math.min(
          keys.length - minimumRows,
          Math.max(1, Math.ceil(keys.length / 2)),
        ),
      )) {
        delete candidate.value[key];
      }
    }
    receipt.rows_compacted = true;
    receipt.compacted_row_paths = [
      ...new Set([...(receipt.compacted_row_paths ?? []), candidate.path]),
    ].sort((left, right) => left.localeCompare(right));
    result.has_more = true;
    result.truncated = true;
    if (typeof result.count === "number") {
      result.count = countReadOutputRows(result);
    }
  }
}

/** Compact strings and rows in place, then return the final exact estimate. */
export function compactReadOutputToBudget(
  result: Record<string, unknown>,
  receipt: PmReadOutputReceipt,
  budget: number,
  minimumRowsByPath: ReadonlyMap<string, number> = new Map(),
): Record<string, unknown> {
  const stringCompactionState: StringCompactionState = { compacted: false };
  const compacted = compactStrings(result, stringCompactionState) as Record<
    string,
    unknown
  >;
  receipt.strings_compacted = stringCompactionState.compacted;
  compacted.read_output = receipt;
  compactRowsToBudget(compacted, receipt, budget, minimumRowsByPath);
  updateReadOutputReceiptEstimate(compacted, receipt);
  return compacted;
}
