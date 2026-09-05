/**
 * @module sdk/query/duplicate-candidates
 *
 * Lossless prefix filtering for Jaccard joins. A globally ordered prefix of
 * length n-ceil(threshold*n)+1 must intersect the corresponding prefix of
 * every qualifying set. Exact titles and issue codes remain independent
 * signals, including titles with no word tokens.
 */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import type { PreparedSimilarityText } from "../similarity-scoring.js";

/** Declared safety bound applies to retained pairs, never silently to recall. */
export const MAX_DUPLICATE_CANDIDATE_PAIRS = 1_000_000;

/** Generate every potentially qualifying pair once, with an explicit exhaustive oracle. */
export function collectDuplicateCandidatePairs(
  items: readonly { prepared: PreparedSimilarityText }[],
  maxPairs = MAX_DUPLICATE_CANDIDATE_PAIRS,
  threshold = 0.8,
  exhaustive = false,
): Set<string> {
  const candidates = new Set<string>();
  /** Deduplicate a candidate pair and refuse before publishing an over-budget result. */
  const add = (left: number, right: number): void => {
    candidates.add(`${left}:${right}`);
    if (candidates.size > maxPairs) {
      throw new PmCliError(
        `Duplicate sweep exceeded ${maxPairs} candidate pairs; narrow it with statuses or since.`,
        EXIT_CODE.CONFLICT,
        { code: "duplicate_sweep_cost_limit", required: "Narrow the duplicate query or increase its similarity threshold. No partial result was returned." },
      );
    }
  };
  if (exhaustive || threshold === 0) {
    for (let right = 0; right < items.length; right += 1) {
      for (let left = 0; left < right; left += 1) add(left, right);
    }
    return candidates;
  }
  const frequencies = new Map<string, number>();
  for (const { prepared } of items) {
    for (const token of prepared.tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  const exact = new Map<string, number[]>();
  const codes = new Map<string, number[]>();
  const prefixes = new Map<string, number[]>();
  for (const [right, { prepared }] of items.entries()) {
    const tokens = [...prepared.tokens].sort((left, other) =>
      frequencies.get(left)! - frequencies.get(other)! || left.localeCompare(other),
    );
    // An epsilon expands rather than shrinks the prefix at floating boundaries.
    const prefixLength = tokens.length - Math.ceil(threshold * tokens.length - 1e-12) + 1;
    const signals: Array<{ index: Map<string, number[]>; keys: string[]; lengthFilter: boolean }> = [
      { index: exact, keys: [prepared.normalized], lengthFilter: false },
      { index: codes, keys: threshold <= 0.99 ? prepared.issueCodes : [], lengthFilter: false },
      { index: prefixes, keys: tokens.length === 0 ? [""] : tokens.slice(0, prefixLength), lengthFilter: true },
    ];
    for (const signal of signals) {
      appendPostingCandidates(items, right, signal, threshold, add);
    }
  }
  return candidates;
}

/** Join one exact/code/prefix posting list, applying the Jaccard length bound only to tokens. */
function appendPostingCandidates(
  items: readonly { prepared: PreparedSimilarityText }[],
  right: number,
  signal: { index: Map<string, number[]>; keys: string[]; lengthFilter: boolean },
  threshold: number,
  add: (left: number, right: number) => void,
): void {
  const rightLength = items[right].prepared.tokens.length;
  for (const key of signal.keys) {
    const posting = signal.index.get(key) ?? [];
    for (const left of posting) {
      const leftLength = items[left].prepared.tokens.length;
      if (signal.lengthFilter && Math.min(leftLength, rightLength) / Math.max(leftLength, rightLength) + 1e-12 < threshold) continue;
      add(left, right);
    }
    posting.push(right);
    signal.index.set(key, posting);
  }
}
