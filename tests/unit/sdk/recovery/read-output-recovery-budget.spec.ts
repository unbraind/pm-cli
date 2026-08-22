import { describe, expect, it } from "vitest";
import { resolveReadOutputRecoveryBudget } from "../../../../src/sdk/read-output-budget.js";
import { applyReadOutputDimensions } from "../../../../src/sdk/read-output-contracts.js";
import { PM_READ_OUTPUT_SURFACES } from "../../../../src/sdk/read-output-contracts.js";

describe("read output recovery budgets", () => {
  it("always recommends a rounded ceiling above the binding request and measured result", () => {
    expect(
      resolveReadOutputRecoveryBudget({
        effective_budget_tokens: 4_500,
        measured_result_tokens: 5_100,
      }),
    ).toEqual({
      output_budget: 6_400,
      recovery_budget_multiplier: 6_400 / 4_500,
      rule_version: "v1",
    });
  });

  it("still increases the ceiling when compaction made the measured envelope smaller", () => {
    const recovery = resolveReadOutputRecoveryBudget({
      effective_budget_tokens: 4_500,
      measured_result_tokens: 1_100,
    });
    expect(recovery).toMatchObject({
      output_budget: 5_700,
      rule_version: "v1",
    });
    expect(recovery.output_budget).toBeGreaterThan(4_500);
  });

  it("falls back to unbounded when a safe finite recovery cannot be represented", () => {
    expect(
      resolveReadOutputRecoveryBudget({
        effective_budget_tokens: Number.MAX_SAFE_INTEGER,
        measured_result_tokens: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({
      output_budget: "unbounded",
      recovery_budget_multiplier: null,
      rule_version: "v1",
    });
  });

  it("fails closed for every invalid finite input boundary", () => {
    for (const input of [
      { effective_budget_tokens: Number.NaN, measured_result_tokens: 1 },
      { effective_budget_tokens: 0, measured_result_tokens: 1 },
      { effective_budget_tokens: 1, measured_result_tokens: Number.NaN },
      { effective_budget_tokens: 1, measured_result_tokens: 0 },
    ]) {
      expect(resolveReadOutputRecoveryBudget(input)).toEqual({
        output_budget: "unbounded",
        recovery_budget_multiplier: null,
        rule_version: "v1",
      });
    }
  });

  it("emits an executable monotonic retry for compacted non-continuable collections", () => {
    const result = applyReadOutputDimensions(
      "contracts",
      { outputBudget: 4_500 },
      {
        row_contract: { row_keys: ["inventory"], continuation_row_keys: [] },
        inventory: Array.from({ length: 180 }, (_, index) => ({
          key: `contract-${index}`,
          description: "bounded recovery evidence ".repeat(20),
        })),
      },
    ) as Record<string, unknown>;
    const disclosure = result.output_budget_truncation as {
      continuation_available: boolean;
      budget_tokens: number;
      recovery: { sdk: { outputBudget: number | "unbounded" } };
    };
    expect(disclosure.continuation_available).toBe(false);
    expect(disclosure.recovery.sdk.outputBudget).not.toBe(1_200);
    expect(disclosure.recovery.sdk.outputBudget).toBeGreaterThan(
      disclosure.budget_tokens,
    );
  });

  it("keeps the generated non-resumable producer corpus monotonic", () => {
    for (const surface of PM_READ_OUTPUT_SURFACES) {
      const result = applyReadOutputDimensions(
        surface,
        { outputBudget: 1_200 },
        {
          row_contract: {
            row_keys: ["inventory"],
            continuation_row_keys: [],
          },
          inventory: Array.from({ length: 80 }, (_, index) => ({
            key: `${surface}-${index}`,
            evidence: "generated producer recovery evidence ".repeat(12),
          })),
        },
      ) as Record<string, unknown>;
      const disclosure = result.output_budget_truncation as {
        continuation_available: boolean;
        budget_tokens: number;
        recovery: { sdk: { outputBudget: number | "unbounded" } };
      };
      expect(disclosure.continuation_available, surface).toBe(false);
      expect(disclosure.recovery.sdk.outputBudget, surface).toEqual(
        expect.any(Number),
      );
      expect(
        disclosure.recovery.sdk.outputBudget as number,
        surface,
      ).toBeGreaterThan(disclosure.budget_tokens);
    }
  });
});
