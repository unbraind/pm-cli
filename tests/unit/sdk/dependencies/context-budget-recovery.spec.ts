import { describe, expect, it, vi } from "vitest";
import { findContextBudgetRecovery } from "../../../../src/sdk/dependencies/context-budget-recovery.js";

describe("bounded context budget recovery", () => {
  it("proves a global minimum without assuming that feasibility is monotone", () => {
    const result = findContextBudgetRecovery({
      requested: 1,
      initialBudget: 1200,
      workUnits: 1,
      probe: (tokens) =>
        tokens === 3 || tokens >= 700 ? "fits" : "native_floor",
    });
    expect(result).toMatchObject({
      minimum_status: "exact",
      minimum_feasible_tokens: 3,
      feasible_tokens: 3,
    });
  });

  it("grows an upper bound and distinguishes a verified value from an unproved minimum", () => {
    const result = findContextBudgetRecovery({
      requested: 1,
      initialBudget: 10,
      workUnits: 100_000,
      probe: (tokens) => (tokens >= 500 ? "fits" : "native_floor"),
    });
    expect(result).toMatchObject({
      minimum_status: "feasible_only",
      minimum_feasible_tokens: null,
      feasible_tokens: 500,
    });
  });

  it("distinguishes independent output constraints from the native floor", () => {
    expect(
      findContextBudgetRecovery({
        requested: 1,
        initialBudget: 1200,
        workUnits: 100_000,
        probe: (tokens) =>
          tokens >= 50 ? "output_constraints" : "native_floor",
      }),
    ).toMatchObject({
      minimum_status: "unavailable",
      feasible_tokens: null,
      reason: "output_constraints",
    });
  });

  it("does not evaluate an oversized query just to construct its diagnostic", () => {
    const probe = vi.fn(() => "fits" as const);
    expect(
      findContextBudgetRecovery({
        requested: 1,
        initialBudget: 1200,
        workUnits: 1_000_001,
        probe,
      }),
    ).toMatchObject({
      minimum_status: "unavailable",
      reason: "query_cost_limit",
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("bounds unsuccessful growth instead of inventing a feasible value", () => {
    const probe = vi.fn(() => "native_floor" as const);
    expect(
      findContextBudgetRecovery({
        requested: 1,
        initialBudget: 1200,
        workUnits: 1,
        probe,
      }),
    ).toMatchObject({ minimum_status: "unavailable", reason: "search_limit" });
    expect(probe.mock.calls.length).toBeLessThanOrEqual(16);
  });

  it("never overflows a safe integer candidate", () => {
    const budgets: number[] = [];
    expect(
      findContextBudgetRecovery({
        requested: Number.MAX_SAFE_INTEGER - 1,
        initialBudget: Number.MAX_SAFE_INTEGER,
        workUnits: 1,
        probe: (tokens) => {
          budgets.push(tokens);
          return "native_floor";
        },
      }),
    ).toMatchObject({ reason: "search_limit" });
    expect(budgets).toEqual([Number.MAX_SAFE_INTEGER]);
  });

  it("preserves unexpected packer failures", () => {
    const defect = new TypeError("unrelated packer failure");
    expect(() =>
      findContextBudgetRecovery({
        requested: 1,
        initialBudget: 1200,
        workUnits: 1,
        probe: () => {
          throw defect;
        },
      }),
    ).toThrow(defect);
  });
});
