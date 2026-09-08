import { describe, expect, it } from "vitest";
import { applyReadOutputDimensions, isReadOutputBudgetExceeded } from "../../../../src/sdk/read-output-contracts.js";

describe("binding output budget recovery hints", () => {
  it("places the binding budget remedy before alias hints and makes progress when executed", () => {
    const items = Array.from({ length: 300 }, (_, index) => ({ id: `pm-${index}`, title: `Evidence ${index} ${"content ".repeat(20)}` }));
    const source = { items, count: items.length, total: items.length, has_more: false };
    const limited = applyReadOutputDimensions("list", { limit: 5000, outputBudget: 2000 }, source);
    expect(isReadOutputBudgetExceeded(limited)).toBe(false);
    if (isReadOutputBudgetExceeded(limited)) throw new Error("Test fixture must retain useful rows");
    expect(limited.read_output?.migration_hints[0]).toContain("2000-token");
    expect(limited.read_output?.migration_hints[0]).toContain("--output-budget");
    expect(limited.read_output?.migration_hints[0]).toContain("--output-cursor");
    expect(limited.read_output?.migration_hints).toContain("--limit is a compatibility alias; prefer --output-limit <n>.");
    const retry = applyReadOutputDimensions("list", { limit: 5000, outputBudget: "unbounded" }, source);
    expect(retry).toMatchObject({ count: 300, has_more: false });
    const complete = applyReadOutputDimensions("list", { outputLimit: 5000, outputBudget: 2000 }, { items: [], count: 0 });
    expect(complete.read_output?.migration_hints ?? []).toEqual([]);
  });
  it("identifies a spent session budget instead of suggesting a row-limit change", () => {
    const items = Array.from({ length: 100 }, (_, index) => ({ id: `pm-${index}`, title: "evidence ".repeat(80) }));
    const result = applyReadOutputDimensions("list", {
      outputBudget: "unbounded", outputSession: { version: 1, id: "review", token_budget: 4000, spent_tokens: 2000, seen_item_ids: [] },
    }, { items, count: items.length });
    expect(isReadOutputBudgetExceeded(result)).toBe(false);
    if (isReadOutputBudgetExceeded(result)) throw new Error("Fixture must retain useful rows");
    expect(result.read_output?.migration_hints[0]).toContain("remaining 2000-token session budget");
    expect(result.read_output?.migration_hints[0]).toContain("new output session");
  });

});
