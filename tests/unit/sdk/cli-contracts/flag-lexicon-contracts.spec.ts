import { describe, expect, it } from "vitest";
import {
  listPmCommandFlagBudgets,
  listPmFlagLexicon,
  listPmFlagSpellingInventory,
  renderPmFlagLexiconMarkdown,
  resolvePmFlagSemanticConcept,
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
      concept_count: new Set(lexicon.map(({ concept }) => concept)).size,
      baseline_entry_count: 0,
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

  it("classifies semantic concepts while preserving every executable spelling", () => {
    const lexicon = listPmFlagLexicon();
    const inventory = listPmFlagSpellingInventory();
    expect(
      lexicon
        .filter(({ flag }) => flag === "--limit")
        .map(({ concept }) => concept),
    ).toEqual(expect.arrayContaining(["result-row-limit", "result-row-limit"]));
    expect(
      lexicon.find(
        ({ command, flag }) => command === "context" && flag === "--limit",
      ),
    ).toMatchObject({
      concept: "result-row-limit",
      aliases: ["--max-items"],
      value_kind: "number",
    });
    expect(
      lexicon.find(
        ({ command, flag }) => command === "create" && flag === "--file",
      )?.concept,
    ).toBe("linked-file-path");
    expect(
      lexicon.find(
        ({ command, flag }) => command === "plan" && flag === "--file",
      )?.concept,
    ).toBe("plan-definition-file");
    expect(
      Object.fromEntries(
        lexicon
          .filter(({ flag }) => flag === "--full")
          .map(({ command, concept }) => [command, concept]),
      ),
    ).toMatchObject({
      contracts: "contract-catalog-projection",
      deps: "dependency-graph-projection",
      graph: "graph-detail-projection",
      health: "health-diagnostic-projection",
      history: "history-entry-projection",
      list: "list-item-projection",
      search: "search-result-projection",
      validate: "validation-diagnostic-projection",
    });
    expect(
      new Set(
        lexicon
          .filter(({ flag }) => flag === "--full")
          .map(({ concept }) => concept),
      ).size,
    ).toBe(11);
    expect(
      inventory.find(
        ({ command, canonical_flag: canonicalFlag }) =>
          command === "context" && canonicalFlag === "--limit",
      )?.accepted_spellings,
    ).toEqual(["--limit", "--max-items"]);
  });

  it("fails closed when a historical canonical or alias spelling disappears", () => {
    const lexicon = listPmFlagLexicon();
    const budgets = listPmCommandFlagBudgets();
    const baseline = listPmFlagSpellingInventory();
    const contextLimit = lexicon.find(
      ({ command, flag }) => command === "context" && flag === "--limit",
    )!;
    const report = verifyPmFlagLexicon(
      lexicon
        .filter((entry) => entry !== contextLimit)
        .map((entry) =>
          entry.command === "ctx" && entry.flag === "--limit"
            ? { ...entry, aliases: [] }
            : entry,
        ),
      budgets,
      baseline,
    );
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "removed_canonical_spelling" }),
        expect.objectContaining({ code: "removed_compatibility_spelling" }),
      ]),
    );
  });

  it("fails closed when a command exposes full projection without a semantic concept", () => {
    expect(() =>
      resolvePmFlagSemanticConcept("unmapped-command", "--full"),
    ).toThrow(
      "Command unmapped-command exposes --full without a registered projection concept.",
    );
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

    expect(
      verifyPmFlagLexicon(
        [seed, { ...seed, command: "ctx", flag: "--synthetic-fields" }],
        [
          { command: "context", current: 1, maximum: 1 },
          { command: "ctx", current: 1, maximum: 1 },
        ],
      ).findings,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "semantic_spelling_collision" }),
      ]),
    );
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
      ])
        .findings.filter(({ code }) => code === "inconsistent_concept_kind")
        .map(({ detail }) => detail),
    ).toEqual([
      "alpha uses both string and boolean.",
      "beta uses both string and boolean.",
    ]);
  });
});
