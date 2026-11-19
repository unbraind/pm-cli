import { describe, expect, it } from "vitest";
import "../../../../src/core/output/output.js";
import {
  _testOnly,
  mirrorReadOutputReceiptEstimate,
  withDeliveredOutputRenderer,
} from "../../../../src/sdk/read-output-budget.js";
import type { PmReadOutputReceipt } from "../../../../src/sdk/read-output-contracts.js";

/**
 * GH-1753 review: a compaction candidate's estimate is settled again from zero
 * only at a digit boundary, and that retry is kept only when it converges and
 * fits. These renderers measure a pure function of the estimate they print,
 * which is the shape of a delivered renderer whose layout depends on it.
 */
function settle(tokensFor: (estimate: number) => number, start: number): { estimate: number; mirrored: number[] } {
  const receipt = { estimated_tokens: start } as PmReadOutputReceipt;
  const result: Record<string, unknown> = { read_output: receipt };
  const mirrored: number[] = [];
  mirrorReadOutputReceiptEstimate(receipt, (_result, estimate) => mirrored.push(estimate));
  const render = (value: unknown): string =>
    "x".repeat(4 * tokensFor(Number((value as { read_output: PmReadOutputReceipt }).read_output.estimated_tokens)));
  withDeliveredOutputRenderer("json", render, () => _testOnly.settleCandidateEstimate(result, receipt, 999, "json"));
  return { estimate: receipt.estimated_tokens, mirrored };
}

describe("digit-boundary retry of a compaction candidate's estimate (GH-1753)", () => {
  it("never accepts a retry that stopped at the iteration limit below the budget", () => {
    // From 1001 the page is a fixed point; from zero it alternates 1100 and 500 and stops at 500.
    const tokensFor = (estimate: number): number => (estimate === 0 || estimate === 500 ? 1100 : estimate === 1100 ? 500 : 1001);
    const settled = settle(tokensFor, 1001);
    expect(settled.estimate).toBe(1001);
    expect(settled.mirrored.at(-1)).toBe(1001);
  });

  it("restores the first estimate directly when the retry misses, so the next candidate keeps its seed", () => {
    // A three-cycle from 1000 stops at 1003; the retry converges at 1001, still over the budget.
    const cycle: Record<number, number> = { 1000: 1002, 1002: 1003, 1003: 1000 };
    const tokensFor = (estimate: number): number => cycle[estimate] ?? 1001;
    const settled = settle(tokensFor, 1000);
    // Settling again from 1003 would advance the cycle to 1002.
    expect(settled.estimate).toBe(1003);
    expect(settled.mirrored.at(-1)).toBe(1003);
  });

  it("keeps a converged retry that fits", () => {
    const tokensFor = (estimate: number): number => (estimate >= 1000 ? 1000 : 999);
    expect(settle(tokensFor, 1500).estimate).toBe(999);
  });
});
