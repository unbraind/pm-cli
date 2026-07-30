import { describe, expect, it } from "vitest";
import { applyContextIntentProjection } from "../../../src/sdk/context-intent-contracts.js";

describe("read command context intent registration", () => {
  it("applies built-in projections and budgets to every read primitive", () => {
    expect(
      applyContextIntentProjection("context", {
        for: "orient",
      }),
    ).toMatchObject({
      section: ["summary", "focus", "hierarchy", "blockers", "activity"],
      tokenBudget: "2400",
    });
    expect(
      applyContextIntentProjection("get", {
        for: "inspect",
      }),
    ).toMatchObject({ depth: "deep", tokenBudget: "3200" });
    expect(
      applyContextIntentProjection("list", {
        for: "triage",
      }),
    ).toMatchObject({
      fields:
        "id,title,status,type,priority,parent,assignee,reviewer,risk,confidence,sprint,release,blocked_by,blocked_reason,dependencies,updated_at",
      tokenBudget: "1800",
    });
    expect(
      applyContextIntentProjection("next", {
        for: "execute",
      }),
    ).toMatchObject({ readyOnly: true, tokenBudget: "1200" });
    expect(
      applyContextIntentProjection("search", {
        for: "discover",
      }),
    ).toMatchObject({ compact: true, tokenBudget: "1800" });
  });

  it("preserves explicit projection and token options", () => {
    const untouched = { limit: "2" };
    expect(applyContextIntentProjection("list", untouched)).toBe(untouched);
    expect(
      applyContextIntentProjection("next", {
        for: "execute",
        readyOnly: false,
        tokenBudget: "99",
      }),
    ).toMatchObject({ readyOnly: false, tokenBudget: "99" });
    expect(
      applyContextIntentProjection("context", {
        for: "orient",
        section: ["focus"],
      }),
    ).toMatchObject({ section: ["focus"] });
    for (const override of [{ depth: "brief" }, { fields: "id,title" }]) {
      expect(
        applyContextIntentProjection("get", {
          for: "inspect",
          ...override,
        }),
      ).toMatchObject(override);
    }
    for (const override of [
      { brief: false },
      { compact: true },
      { full: true },
      { fields: "id,title" },
    ]) {
      expect(
        applyContextIntentProjection("list", {
          for: "triage",
          ...override,
        }),
      ).toMatchObject(override);
    }
    for (const override of [
      { compact: false },
      { full: true },
      { fields: "id,title" },
    ]) {
      expect(
        applyContextIntentProjection("search", {
          for: "discover",
          ...override,
        }),
      ).toMatchObject(override);
    }
  });

  it("fails unknown intents with nearest-name guidance", () => {
    expect(() =>
      applyContextIntentProjection("next", {
        for: "execut",
      }),
    ).toThrow('Did you mean "execute"?');
  });
});
