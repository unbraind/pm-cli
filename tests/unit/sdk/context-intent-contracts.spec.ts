import { describe, expect, it } from "vitest";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import {
  PM_CONTEXT_INTENT_CONTRACTS,
  applyContextIntentProjection,
  attachContextIntentReceipt,
  attachReadOutputContracts,
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
        limit: "7",
        activityLimit: "6",
        tokenBudget: "9999",
      }),
    ).toMatchObject({
      depth: "full",
      section: ["decisions"],
      limit: "7",
      activityLimit: "6",
      tokenBudget: "9999",
    });
    expect(
      applyContextIntentProjection("context", { for: "handoff" }),
    ).toMatchObject({
      depth: "deep",
      section: ["activity", "progress", "blockers"],
      limit: "2",
      activityLimit: "2",
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
      applyContextIntentProjection("list", {
        for: "triage",
        tokenBudget: "1800",
      }),
    ).toMatchObject({ limit: "10" });
    expect(
      applyContextIntentProjection("list", {
        for: "triage",
        tokenBudget: "3000",
      }),
    ).toMatchObject({ limit: "19" });
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
        reason: "declared_budget_infeasible",
      },
      context_intent: {
        degradation: "budget_receipt_only",
        declaration_feasible: false,
        result_omitted: true,
        within_budget: false,
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

  it("returns bounded recovery guidance instead of recommending an unprojected retry", () => {
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
          restore_with:
            "Increase --token-budget or narrow the request; the unprojected command may be larger.",
        },
      });
    }
  });

  it("retains useful rows through an intermediate budget-compaction tier", () => {
    const recommended = Array.from({ length: 20 }, (_, index) => ({
      id: `pm-${index}`,
      explanation: "x".repeat(2_000),
    }));
    const projected = attachContextIntentReceipt(
      "next",
      { for: "execute" },
      {
        recommended: recommended[0],
        ready: recommended.slice(1),
        blocked: recommended.slice(1, 6),
        decision_needed: recommended.slice(6, 11),
        count: recommended.length,
        has_more: false,
      },
    );
    expect(projected.context_intent).toMatchObject({
      degradation: "budget_row_compaction",
      declaration_feasible: true,
      result_omitted: false,
      within_budget: true,
    });
    expect(projected.recommended).toMatchObject({ id: "pm-0" });
    expect(projected.ready.length).toBeGreaterThanOrEqual(1);
    expect(projected.ready.length).toBeLessThan(recommended.length - 1);
    expect(projected).toMatchObject({ truncated: true, has_more: true });
  });

  it("does not drop rows behind an already-issued pagination cursor", () => {
    const projected = attachContextIntentReceipt(
      "list",
      { for: "triage" },
      {
        items: Array.from({ length: 20 }, (_, index) => ({
          id: `pm-${index}`,
          title: "x".repeat(2_000),
          metadata: Object.fromEntries(
            Array.from({ length: 100 }, (_, field) => [
              `field_${field}`,
              field,
            ]),
          ),
        })),
        next_cursor: "opaque-cursor",
        has_more: true,
      },
    );
    expect(projected).toMatchObject({
      budget_exceeded: { omitted_result: true },
      context_intent: {
        degradation: "budget_receipt_only",
        result_omitted: true,
        within_budget: false,
      },
    });
    expect(projected).not.toHaveProperty("items");
    expect(projected).not.toHaveProperty("next_cursor");
  });

  it("retains the final useful row when unrelated payload fields exceed the budget", () => {
    const projected = attachContextIntentReceipt(
      "next",
      { for: "execute" },
      {
        ready: [{ id: "pm-anchor" }],
        ...Object.fromEntries(
          Array.from({ length: 2500 }, (_, index) => [`field_${index}`, index]),
        ),
      },
    );
    expect(projected).toMatchObject({
      budget_exceeded: { omitted_result: true },
      context_intent: {
        degradation: "budget_receipt_only",
        declaration_feasible: false,
      },
    });
  });

  it("references cursor-chain metadata instead of repeating invariant blocks", () => {
    const cursor = Buffer.from(
      JSON.stringify({ fingerprint: "chain-fingerprint", after_index: 1 }),
    ).toString("base64url");
    const projected = attachReadOutputContracts(
      "list",
      { for: "triage", after: cursor },
      {
        items: [{ id: "pm-2", title: "Second" }],
        filters: { status: "open" },
        sorting: { sort: "priority" },
        completeness: { status: "complete" },
        projection: { mode: "fields" },
        row_contract: { command: "list", row_keys: ["items"] },
      },
    ) as Record<string, unknown>;
    expect(projected).toMatchObject({
      continuation_contract: {
        fingerprint: "chain-fingerprint",
        metadata: "reference",
      },
    });
    for (const key of [
      "applied_limit",
      "completeness",
      "context_intent",
      "count",
      "filters",
      "has_more",
      "now",
      "omission_receipt",
      "projection",
      "row_contract",
      "sorting",
      "total",
      "truncated",
    ]) {
      expect(projected).not.toHaveProperty(key);
    }

    for (const after of [
      Buffer.from(JSON.stringify({ fingerprint: 42 })).toString("base64url"),
      "not-json",
    ]) {
      expect(
        attachReadOutputContracts("list", { after }, { items: [] }),
      ).toMatchObject({
        continuation_contract: {
          fingerprint: "opaque_cursor",
          metadata: "reference",
        },
      });
    }
  });
});
