import { describe, expect, it } from "vitest";
import {
  PM_CONTEXT_INTENT_CONTRACTS,
  composeContextIntentContracts,
  resolveContextIntentContract,
} from "../../../src/sdk/context-intent-contracts.js";

describe("context intent contracts", () => {
  it("publishes bounded built-in projections for every read primitive", () => {
    expect(PM_CONTEXT_INTENT_CONTRACTS.map(({ command, intent }) => `${command}:${intent}`)).toEqual([
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
    expect(resolveContextIntentContract("next", "execute", composed)?.description).toBe(
      "Workspace execution view.",
    );
    expect(resolveContextIntentContract("package-report", "release", composed)).toMatchObject({
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
      composeContextIntentContracts([], [
        {
          command: "next",
          intent: "execute",
          description: "Package collision.",
          included_field_groups: ["recommended"],
          token_budget: 1,
        },
      ]),
    ).toThrow("Duplicate");
    expect(resolveContextIntentContract("custom", "view")).toBeUndefined();
    expect(() => resolveContextIntentContract("context", "zzz")).toThrow(
      'Did you mean "orient"?',
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
});
