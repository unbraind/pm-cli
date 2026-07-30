import { describe, expect, it } from "vitest";
import {
  applyContextIntentProjection,
  attachContextIntentReceipt,
} from "../../../src/sdk/context-intent-contracts.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("read command context intent registration", () => {
  it("applies built-in projections and budgets to every read primitive", () => {
    expect(
      applyContextIntentProjection("context", {
        for: "orient",
      }),
    ).toMatchObject({
      depth: "standard",
      section: ["hierarchy", "blockers", "activity"],
      tokenBudget: "2400",
    });
    expect(
      applyContextIntentProjection("get", {
        for: "inspect",
      }),
    ).toMatchObject({ depth: "standard", tokenBudget: "3200" });
    expect(
      applyContextIntentProjection("list", {
        for: "triage",
      }),
    ).toMatchObject({
      fields:
        "id,title,status,type,priority,parent,assignee,reviewer,risk,confidence,sprint,release,blocked_by,blocked_reason,dependencies,updated_at",
      limit: "2",
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
    ).toMatchObject({ compact: true, limit: "15", tokenBudget: "1800" });
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

  it("discloses resolved intent budgets only when an intent was selected", () => {
    const result = attachContextIntentReceipt(
      "list",
      { for: "triage" },
      { items: [{ id: "pm-a" }], count: 1 },
    );
    expect(result).toMatchObject({
      context_intent: {
        command: "list",
        intent: "triage",
        token_budget: 1800,
        within_budget: true,
        degradation: "bounded_fields_and_rows",
      },
    });
    expect(result.context_intent.estimated_tokens).toBeGreaterThan(0);
    expect(attachContextIntentReceipt("list", {}, { items: [] })).toEqual({
      items: [],
    });
  });

  it("compacts oversized intent results to their declared budget", () => {
    const result = attachContextIntentReceipt(
      "next",
      { for: "execute" },
      {
        recommended: Array.from({ length: 20 }, (_, index) => ({
          id: `pm-${index}`,
          explanation: "x".repeat(2_000),
        })),
      },
    );
    expect(result.context_intent).toMatchObject({
      degradation: "recursive_budget_compaction",
      within_budget: true,
    });
    expect(result.context_intent!.estimated_tokens).toBeLessThanOrEqual(1_200);
    expect(result.recommended).toHaveLength(1);
  });

  it("executes every declared CLI intent and returns one usage contract for unknown values", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--id",
          "pm-intent-proof",
          "--title",
          "Intent proof",
          "--type",
          "Task",
          "--json",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);

      for (const args of [
        ["context", "--for", "orient", "--json"],
        ["context", "--for", "handoff", "--json"],
        ["get", "pm-intent-proof", "--for", "inspect", "--json"],
        ["list", "--for", "triage", "--json"],
        ["next", "--for", "execute", "--json"],
        ["search", "Intent proof", "--for", "discover", "--json"],
      ]) {
        const result = context.runCli(args, { expectJson: true });
        expect(result.code, args.join(" ")).toBe(0);
        expect(result.json).toHaveProperty(
          "context_intent.within_budget",
          true,
        );
      }

      const invalid = context.runCli(
        ["context", "--for", "hierarchy", "--json"],
        { preserveDefaultMutationOutput: true },
      );
      expect(invalid.code).toBe(2);
      expect(JSON.parse(invalid.stderr)).toMatchObject({
        code: "unknown_context_intent",
        exit_code: 2,
        next_steps: ["pm context --for handoff"],
      });
      expect(invalid.stderr).not.toContain("Context --section");
    });
  });
});
