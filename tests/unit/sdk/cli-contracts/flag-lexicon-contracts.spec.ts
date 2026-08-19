import { describe, expect, it } from "vitest";
import {
  listPmCommandFlagBudgets,
  listPmFlagLexicon,
  renderPmFlagLexiconMarkdown,
  verifyPmFlagLexicon,
} from "../../../../src/sdk/cli-contracts/flag-lexicon-contracts.js";

describe("flag lexicon contracts", () => {
  it("publishes a duplicate-free, budgeted core vocabulary", () => {
    const lexicon = listPmFlagLexicon();
    const budgets = listPmCommandFlagBudgets();
    expect(verifyPmFlagLexicon()).toEqual({
      ok: true,
      entry_count: lexicon.length,
      budget_count: budgets.length,
      findings: [],
    });
    expect(lexicon.length).toBeGreaterThan(3_000);
    expect(budgets.length).toBeGreaterThan(60);
    expect(budgets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "context",
          current: lexicon.filter(({ command }) => command === "context")
            .length,
        }),
      ]),
    );
    expect(renderPmFlagLexiconMarkdown()).toContain("| `context` | context |");
  });

  it("fails closed on duplicate concepts, alias collisions, and growth", () => {
    const lexicon = listPmFlagLexicon();
    const budgets = listPmCommandFlagBudgets();
    const seed = lexicon.find(
      ({ command, flag }) => command === "context" && flag === "--fields",
    )!;
    const contextCount = lexicon.filter(
      ({ command }) => command === "context",
    ).length;
    const pinnedBudgets = budgets.map((budget) =>
      budget.command === "context"
        ? { ...budget, current: contextCount, maximum: contextCount }
        : budget,
    );
    const report = verifyPmFlagLexicon(
      [
        ...lexicon,
        { ...seed },
        {
          ...seed,
          flag: "--synthetic",
          aliases: ["--fields"],
          value_kind: "boolean",
        },
      ],
      pinnedBudgets,
    );
    expect(report.ok).toBe(false);
    expect(report.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "alias_collision",
        "budget_exceeded",
        "duplicate_canonical_flag",
        "inconsistent_concept_kind",
      ]),
    );
    const findingOrder = report.findings.map(
      ({ command, code, detail }) => `${command}\u0000${code}\u0000${detail}`,
    );
    expect(findingOrder).toEqual(findingOrder.toSorted());
  });

  it("memoizes the immutable canonical corpus", () => {
    expect(listPmFlagLexicon()).toBe(listPmFlagLexicon());
  });

  it("detects alias collisions independently of row order and requires exact budget coverage", () => {
    const lexicon = listPmFlagLexicon();
    const budgets = listPmCommandFlagBudgets();
    const seed = lexicon.find(
      ({ command, flag }) => command === "context" && flag === "--fields",
    )!;
    const synthetic = {
      ...seed,
      flag: "--synthetic",
      aliases: ["--fields"],
    };
    const withoutContextBudget = budgets.filter(
      ({ command }) => command !== "context",
    );
    const report = verifyPmFlagLexicon(
      [synthetic, ...lexicon],
      [
        ...withoutContextBudget,
        { command: "removed-command", current: 1, maximum: 1 },
      ],
    );
    expect(report.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "alias_collision",
        "missing_budget",
        "stale_budget",
      ]),
    );
  });

  it("uses finding detail as the deterministic final sort key", () => {
    const seed = listPmFlagLexicon().find(
      ({ command, flag }) => command === "context" && flag === "--fields",
    )!;
    const entries = [
      {
        ...seed,
        flag: "--alpha-string",
        concept: "alpha",
        value_kind: "string" as const,
      },
      {
        ...seed,
        flag: "--alpha-boolean",
        concept: "alpha",
        value_kind: "boolean" as const,
      },
      {
        ...seed,
        flag: "--beta-string",
        concept: "beta",
        value_kind: "string" as const,
      },
      {
        ...seed,
        flag: "--beta-boolean",
        concept: "beta",
        value_kind: "boolean" as const,
      },
    ];
    expect(
      verifyPmFlagLexicon(entries, [
        {
          command: "context",
          current: entries.length,
          maximum: entries.length,
        },
      ]).findings.map(({ detail }) => detail),
    ).toEqual([
      "alpha uses both string and boolean.",
      "beta uses both string and boolean.",
    ]);
  });
});
