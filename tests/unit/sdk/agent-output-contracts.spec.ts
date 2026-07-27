import { describe, expect, it } from "vitest";
import {
  PM_COMMAND_OUTPUT_BUDGET_CONTRACTS,
  PM_CORE_COMMAND_NAMES,
  PM_OUTPUT_DEGRADATION_STEPS,
  definePmCommandOutputBudget,
  estimatePmOutputTokens,
  resolvePmCommandOutputBudget,
} from "../../../src/sdk/cli-contracts.js";

describe("agent output contracts", () => {
  it("declares exactly one deterministic budget for every built-in command", () => {
    expect(PM_COMMAND_OUTPUT_BUDGET_CONTRACTS).toHaveLength(
      PM_CORE_COMMAND_NAMES.length,
    );
    expect(
      new Set(
        PM_COMMAND_OUTPUT_BUDGET_CONTRACTS.map(
          (contract) => contract.command,
        ),
      ).size,
    ).toBe(PM_CORE_COMMAND_NAMES.length);
    for (const contract of PM_COMMAND_OUTPUT_BUDGET_CONTRACTS) {
      expect(contract.default_max_estimated_tokens).toBeGreaterThan(0);
      expect(contract.degradation_ladder).toEqual(
        PM_OUTPUT_DEGRADATION_STEPS,
      );
      expect(contract.allows_unbounded_opt_out).toBe(true);
      expect(contract.token_estimate).toBe("ceil(utf8_bytes / 4)");
    }
  });

  it("resolves root commands, rejects unknown commands, and estimates UTF-8 tokens", () => {
    expect(resolvePmCommandOutputBudget("contracts --summary")).toMatchObject({
      command: "contracts",
      budget_class: "discovery",
    });
    expect(resolvePmCommandOutputBudget("unknown")).toBeNull();
    expect(estimatePmOutputTokens(0)).toBe(0);
    expect(estimatePmOutputTokens(5)).toBe(2);
    expect(estimatePmOutputTokens(-4)).toBe(0);
  });

  it("preserves package-authored literal budget definitions", () => {
    const contract = definePmCommandOutputBudget({
      command: "get",
      budget_class: "read",
      default_max_estimated_tokens: 800,
      degradation_ladder: ["compact", "summary"],
      allows_unbounded_opt_out: false,
      token_estimate: "ceil(utf8_bytes / 4)",
    } as const);

    expect(contract.default_max_estimated_tokens).toBe(800);
    expect(contract.degradation_ladder).toEqual(["compact", "summary"]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid package-authored token ceiling (%s)",
    (defaultMaxEstimatedTokens) => {
      expect(() =>
        definePmCommandOutputBudget({
          command: "get",
          budget_class: "read",
          default_max_estimated_tokens: defaultMaxEstimatedTokens,
          degradation_ladder: ["summary"],
          allows_unbounded_opt_out: false,
          token_estimate: "ceil(utf8_bytes / 4)",
        }),
      ).toThrow(
        new RangeError(
          "default_max_estimated_tokens must be a positive safe integer",
        ),
      );
    },
  );
});
