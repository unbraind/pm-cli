/**
 * @module sdk/read-output-budget
 *
 * Implements deterministic, bounded result compaction for the universal
 * read-output contract without expanding its public declaration module.
 */
import type { PmReadOutputReceipt } from "./read-output-contracts.js";

interface StringCompactionState {
  /** Whether at least one string was shortened. */
  compacted: boolean;
}

const MAX_ESTIMATE_ITERATIONS = 8;
const MAX_COMPACTION_ITERATIONS = 64;

/** Return whether a value is a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Resolve declared row keys, falling back to top-level array properties. */
function rowKeys(result: Record<string, unknown>): string[] {
  const contract = result.row_contract;
  if (isRecord(contract) && Array.isArray(contract.row_keys)) {
    return contract.row_keys.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  return Object.entries(result)
    .filter(([, value]) => Array.isArray(value))
    .map(([key]) => key);
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
    const measured = Math.ceil(
      Buffer.byteLength(JSON.stringify(result), "utf8") / 4,
    );
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
): void {
  const keys = rowKeys(result);
  for (
    let iteration = 0;
    iteration < MAX_COMPACTION_ITERATIONS;
    iteration += 1
  ) {
    updateReadOutputReceiptEstimate(result, receipt);
    if (receipt.estimated_tokens <= budget) return;
    const candidate = keys
      .map((key) => ({
        key,
        rows: Array.isArray(result[key]) ? (result[key] as unknown[]) : [],
      }))
      .filter(({ rows }) => rows.length > 1)
      .sort(
        (left, right) =>
          right.rows.length - left.rows.length ||
          left.key.localeCompare(right.key),
      )[0];
    if (!candidate) return;
    candidate.rows.splice(-Math.max(1, Math.ceil(candidate.rows.length / 2)));
    receipt.rows_compacted = true;
    result.has_more = true;
    result.truncated = true;
    if (typeof result.count === "number") {
      result.count = keys.reduce(
        (total, key) =>
          total + (Array.isArray(result[key]) ? result[key].length : 0),
        0,
      );
    }
  }
}

/** Compact strings and rows in place, then return the final exact estimate. */
export function compactReadOutputToBudget(
  result: Record<string, unknown>,
  receipt: PmReadOutputReceipt,
  budget: number,
): Record<string, unknown> {
  const stringCompactionState: StringCompactionState = { compacted: false };
  const compacted = compactStrings(result, stringCompactionState) as Record<
    string,
    unknown
  >;
  receipt.strings_compacted = stringCompactionState.compacted;
  compacted.read_output = receipt;
  compactRowsToBudget(compacted, receipt, budget);
  updateReadOutputReceiptEstimate(compacted, receipt);
  return compacted;
}
