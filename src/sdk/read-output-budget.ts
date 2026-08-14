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
