import { describe, expect, it } from "vitest";
import {
  CONTEXT_INTENT_LIMIT_OVERRIDE_WARNING,
  applyContextIntentProjection,
  attachContextIntentReceipt,
} from "../../../../src/sdk/context-intent-contracts.js";

describe("GH-1644 intent budgets never silently reduce an explicit --limit", () => {
  it("bounds an explicit limit by the budget without adding undeclared options", () => {
    const projected = applyContextIntentProjection("context", { for: "orient", limit: "10" });
    expect(projected).toMatchObject({ limit: "3", activityLimit: "3" });
    expect(Object.keys(projected).sort()).toEqual(["activityLimit", "depth", "for", "limit", "section", "tokenBudget"]);
    expect(applyContextIntentProjection("context", { for: "orient", limit: "2" })).toMatchObject({ limit: "2" });
    expect(applyContextIntentProjection("list", { for: "triage", limit: "150" })).toMatchObject({ limit: "100" });
    expect(applyContextIntentProjection("search", { for: "discover", limit: "200" }, ["q"])).toMatchObject({ limit: "82" });
  });

  it("discloses the reduction in the receipt, warnings and filters with a retry that keeps the limit", () => {
    // Hosts attach the receipt with the caller's own options, as the CLI output path and SDK runtime do.
    const result = attachContextIntentReceipt("context", { for: "orient", limit: "10" }, {
      filters: { limit: "3" },
      high_level: [],
      low_level: [],
      warnings: ["producer_warning"],
    });
    expect(result.context_intent).toMatchObject({
      binding_constraint: "token_budget",
      budget_derived_limit: 3,
      limit_reason: "The 3000-token orient budget carries 3 rows, so it reduced the caller's --limit 10.",
      limit_override: {
        flag: "--limit",
        requested: 10,
        effective: 3,
        token_budget_for_requested: 7200,
        restore_with: "--token-budget 7200",
      },
    });
    expect(result).toMatchObject({
      filters: { limit: "3", requested_limit: "10" },
      warnings: ["producer_warning", `${CONTEXT_INTENT_LIMIT_OVERRIDE_WARNING}:--limit 10->3`],
    });
    const retry = applyContextIntentProjection("context", { for: "orient", limit: "10", tokenBudget: "7200" });
    expect(retry).toMatchObject({ limit: "10" });
  });

  it("reads the caller's limit from raw host options and restores it with a flag the original command keeps", () => {
    const listed = attachContextIntentReceipt("list", { for: "triage", limit: "150", status: "closed", sort: "updated" }, { items: [] });
    expect(listed.context_intent?.limit_override).toMatchObject({
      requested: 150,
      effective: 100,
      token_budget_for_requested: 3200,
      restore_with: "--token-budget 3200",
    });
    expect(listed).toMatchObject({ warnings: [`${CONTEXT_INTENT_LIMIT_OVERRIDE_WARNING}:--limit 150->100`] });
    expect(listed).not.toHaveProperty("filters");
    const searched = attachContextIntentReceipt("search", { for: "discover", limit: "200" }, { query: "it's", items: [] });
    expect(searched.context_intent?.limit_override?.restore_with).toBe("--token-budget 3680");
    const unbounded = attachContextIntentReceipt("context", { for: "orient", limit: String(Number.MAX_SAFE_INTEGER) }, {});
    expect(unbounded.context_intent?.limit_override).toEqual({
      flag: "--limit",
      requested: Number.MAX_SAFE_INTEGER,
      effective: 3,
    });
    const honoured = attachContextIntentReceipt("context", { for: "orient", limit: "2" }, { filters: { limit: "2" } });
    expect(honoured.context_intent).not.toHaveProperty("limit_override");
    expect(honoured).not.toHaveProperty("warnings");
    expect(honoured.filters).toEqual({ limit: "2" });
  });
});
