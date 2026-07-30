import { describe, expect, it } from "vitest";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import {
  PM_CONTEXT_INTENT_CONTRACTS,
  applyContextIntentProjection,
  attachContextIntentReceipt,
  composeContextIntentContracts,
  resolveContextIntentContract,
} from "../../../src/sdk/context-intent-contracts.js";

describe("context intent contracts", () => {
  it("publishes bounded built-in projections for every read primitive", () => {
    expect(
      PM_CONTEXT_INTENT_CONTRACTS.map(
        ({ command, intent }) => `${command}:${intent}`,
      ),
    ).toEqual([
      "context:orient",
      "context:handoff",
      "get:inspect",
      "list:triage",
      "next:execute",
      "search:discover",
    ]);
    expect(resolveContextIntentContract("next", "execute")).toMatchObject({
      included_field_groups: ["recommended"],
      token_budget: 1200,
    });
  });

  it("composes workspace and package declarations with deterministic precedence", () => {
    const composed = composeContextIntentContracts(
      [
        {
          command: "next",
          intent: "execute",
          description: "Workspace execution view.",
          included_field_groups: ["recommended", "blocked"],
          token_budget: 1500,
        },
      ],
      [
        {
          command: "package-report",
          intent: "release",
          description: "Package release context.",
          included_field_groups: ["changes", "gates"],
          token_budget: 900,
        },
      ],
    );
    expect(
      resolveContextIntentContract("next", "execute", composed)?.description,
    ).toBe("Workspace execution view.");
    expect(
      resolveContextIntentContract("package-report", "release", composed),
    ).toMatchObject({
      included_field_groups: ["changes", "gates"],
      source: "package",
    });
  });

  it("rejects malformed, duplicate, and unknown intent lookups with suggestions", () => {
    expect(() =>
      composeContextIntentContracts([
        {
          command: "next",
          intent: "execute",
          description: " ",
          included_field_groups: [],
          token_budget: 1,
        },
      ]),
    ).toThrow("description");
    for (const invalid of [
      {
        command: "bad command",
        intent: "view",
        description: "Invalid command.",
        included_field_groups: ["rows"],
        token_budget: 1,
      },
      {
        command: "custom",
        intent: "view",
        description: "Invalid budget.",
        included_field_groups: ["rows"],
        token_budget: 0,
      },
      {
        command: "custom",
        intent: "view",
        description: "Invalid fields.",
        included_field_groups: [" "],
        token_budget: 1,
      },
    ]) {
      expect(() => composeContextIntentContracts([invalid])).toThrow();
    }
    expect(() =>
      composeContextIntentContracts([
        {
          command: "custom",
          intent: "view",
          description: "First.",
          included_field_groups: ["rows"],
          token_budget: 10,
        },
        {
          command: "custom",
          intent: "view",
          description: "Second.",
          included_field_groups: ["rows"],
          token_budget: 10,
        },
      ]),
    ).toThrow("Duplicate");
    expect(() =>
      composeContextIntentContracts(
        [],
        [
          {
            command: "next",
            intent: "execute",
            description: "Package collision.",
            included_field_groups: ["recommended"],
            token_budget: 1,
          },
        ],
      ),
    ).toThrow("Duplicate");
    expect(resolveContextIntentContract("custom", "view")).toBeUndefined();
    expect(() => resolveContextIntentContract("context", "zzz")).toThrow(
      'Did you mean "orient"?',
    );
    expect(() => resolveContextIntentContract("context", "hierarchy")).toThrow(
      expect.objectContaining<Partial<PmCliError>>({
        code: "unknown_context_intent",
        exitCode: EXIT_CODE.USAGE,
        context: expect.objectContaining({
          field: "for",
          nextSteps: ["pm context --for handoff"],
        }),
      }),
    );
    expect(() =>
      resolveContextIntentContract("custom", "cc", [
        {
          command: "custom",
          intent: "bb",
          description: "Second.",
          included_field_groups: ["rows"],
          token_budget: 1,
        },
        {
          command: "custom",
          intent: "aa",
          description: "First.",
          included_field_groups: ["rows"],
          token_budget: 1,
        },
      ]),
    ).toThrow('Did you mean "aa"?');
    expect(() => resolveContextIntentContract("next", "execut")).toThrow(
      'Unknown context intent "execut" for next. Did you mean "execute"?',
    );
  });

  it("preserves explicit controls and applies handoff and alias defaults", () => {
    expect(
      applyContextIntentProjection("context", {
        for: "handoff",
        depth: "full",
        section: ["decisions"],
        tokenBudget: "9999",
      }),
    ).toMatchObject({
      depth: "full",
      section: ["decisions"],
      tokenBudget: "9999",
    });
    expect(
      applyContextIntentProjection("context", { for: "handoff" }),
    ).toMatchObject({
      depth: "deep",
      section: ["activity", "progress", "blockers"],
    });
    expect(
      applyContextIntentProjection("list", {
        for: "triage",
        fields: "id,title",
        limit: "9",
      }),
    ).toMatchObject({ fields: "id,title", limit: "9" });
    expect(
      applyContextIntentProjection("search", {
        for: "discover",
        full: true,
        limit: "8",
      }),
    ).toMatchObject({ full: true, limit: "8" });
    expect(
      attachContextIntentReceipt("list-open", { for: "triage" }, { items: [] }),
    ).toMatchObject({
      context_intent: { command: "list", intent: "triage" },
    });
    expect(
      attachContextIntentReceipt(
        "next",
        { for: "execute", tokenBudget: 2400 },
        { recommended: [] },
      ),
    ).toMatchObject({
      context_intent: { token_budget: 2400 },
    });
    expect(
      attachContextIntentReceipt(
        "next",
        { for: "execute", tokenBudget: "2401" },
        { recommended: [] },
      ),
    ).toMatchObject({
      context_intent: { token_budget: 2401 },
    });
    expect(
      attachContextIntentReceipt(
        "next",
        { for: "execute", tokenBudget: "invalid" },
        { recommended: [] },
      ),
    ).toMatchObject({
      context_intent: { token_budget: 1200 },
    });
    expect(
      attachContextIntentReceipt("package-report", { for: "release" }, {}),
    ).toEqual({});
  });

  it("falls back to a bounded receipt when recursive compaction cannot fit", () => {
    const oversized = Object.fromEntries(
      Array.from({ length: 2500 }, (_, index) => [`field_${index}`, index]),
    );
    const projected = attachContextIntentReceipt(
      "next",
      { for: "execute" },
      oversized,
    );
    expect(projected).toMatchObject({
      budget_exceeded: {
        omitted_result: true,
        restore_with: "Repeat the original command without --for.",
      },
      context_intent: {
        degradation: "budget_receipt_only",
        within_budget: true,
      },
    });
    expect(projected.context_intent!.estimated_tokens).toBeLessThanOrEqual(
      projected.context_intent!.token_budget,
    );
  });

  it("reports the exact serialized token estimate and a stable source", () => {
    const projected = attachContextIntentReceipt(
      "next",
      { for: "execute" },
      { value: "xxx" },
    );
    expect(projected.context_intent!.estimated_tokens).toBe(
      Math.ceil(Buffer.byteLength(JSON.stringify(projected), "utf8") / 4),
    );

    expect(
      resolveContextIntentContract("custom", "view", [
        {
          command: "custom",
          intent: "view",
          description: "Locally scoped declaration without a source.",
          included_field_groups: ["rows"],
          token_budget: 1200,
        },
      ]),
    ).toMatchObject({ source: "core" });
  });

  it("rejects explicit ceilings that cannot contain the minimum receipt", () => {
    expect(() =>
      attachContextIntentReceipt(
        "next",
        { for: "execute", tokenBudget: 1 },
        { recommended: [] },
      ),
    ).toThrow(
      expect.objectContaining<Partial<PmCliError>>({
        code: "invalid_argument_value",
        exitCode: EXIT_CODE.USAGE,
        context: expect.objectContaining({
          field: "tokenBudget",
        }),
      }),
    );
  });

  it("returns invocation-safe recovery guidance for positional reads", () => {
    const oversized = Object.fromEntries(
      Array.from({ length: 2500 }, (_, index) => [`field_${index}`, index]),
    );
    for (const [command, intent] of [
      ["get", "inspect"],
      ["search", "discover"],
    ] as const) {
      expect(
        attachContextIntentReceipt(command, { for: intent }, oversized),
      ).toMatchObject({
        budget_exceeded: {
          restore_with: "Repeat the original command without --for.",
        },
      });
    }
  });

  it("never drops result rows while compacting explanatory strings", () => {
    const recommended = Array.from({ length: 20 }, (_, index) => ({
      id: `pm-${index}`,
      explanation: "x".repeat(2_000),
    }));
    const projected = attachContextIntentReceipt(
      "next",
      { for: "execute" },
      { recommended, count: recommended.length, has_more: false },
    );
    expect(projected).toMatchObject({
      budget_exceeded: { omitted_result: true },
      context_intent: {
        degradation: "budget_receipt_only",
        within_budget: true,
      },
    });
    expect(projected).not.toHaveProperty("recommended");
    expect(projected).not.toHaveProperty("count");
    expect(projected).not.toHaveProperty("has_more");
  });
});
