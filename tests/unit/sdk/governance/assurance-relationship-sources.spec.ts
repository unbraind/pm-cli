import { describe, expect, it } from "vitest";

import {
  evaluateAssuranceAssertion,
  evaluateMeasurement,
  validateMeasurementDefinition,
  type AssuranceEvaluationContext,
  type AssuranceMeasurementDefinition,
} from "../../../../src/sdk/governance/assurance.js";

const context: AssuranceEvaluationContext = {
  tree_id: "test-tree",
  history: [],
  items: [
    {
      id: "pm-a",
      status: "open",
      type: "Task",
      description: "Implements pm-b and discusses pm-c with pm-d.",
      dependencies: [
        { id: "pm-b", kind: "blocks", source_kind: "evidence:pm-c90tfh" },
        { id: "pm-d", kind: "blocks", source_kind: "cli:update:dep" },
      ],
    },
    {
      id: "pm-b",
      status: "open",
      type: "Task",
      description: "",
      dependencies: [],
    },
    {
      id: "pm-c",
      status: "open",
      type: "Task",
      description: "",
      dependencies: [],
    },
    {
      id: "pm-d",
      status: "open",
      type: "Task",
      description: "Does not depend on pm-c.",
      comments: [{ text: "Unknown pm-ghost is ignored." }],
      dependencies: [],
    },
    {
      id: "pm-ledger",
      status: "open",
      type: "Milestone",
      description: "Ledger: pm-a and pm-c.",
      dependencies: [],
    },
  ],
  external: async () => ({ value: 0, population_size: 0, cost: 0 }),
};

function measurement(
  id: string,
  source: AssuranceMeasurementDefinition["source"],
): AssuranceMeasurementDefinition {
  return { id, source };
}

describe("assurance relationship measurement sources", () => {
  it("partitions dependency-kind counts by exact, prefix, and presence provenance", async () => {
    await expect(
      evaluateMeasurement(
        measurement("evidence", {
          kind: "dependency_kind",
          dependency_kind: "blocks",
          source_kind_prefix: "evidence:",
        }),
        context,
      ),
    ).resolves.toMatchObject({
      value: 1,
      contributors: ["pm-a->pm-b@evidence:pm-c90tfh"],
    });
    await expect(
      evaluateMeasurement(
        measurement("default", {
          kind: "dependency_kind",
          dependency_kind: "blocks",
          source_kind: "cli:update:dep",
        }),
        context,
      ),
    ).resolves.toMatchObject({ value: 1 });
    await expect(
      evaluateMeasurement(
        measurement("present", {
          kind: "dependency_kind",
          dependency_kind: "blocks",
          source_kind_state: "present",
        }),
        context,
      ),
    ).resolves.toMatchObject({ value: 2 });
  });

  it("counts distinct unlinked prose pairs once and returns bounded subject diagnostics", async () => {
    await expect(
      evaluateMeasurement(
        measurement("prose-gap", {
          kind: "prose_edge_gap",
          sample_limit: 2,
          exemptions: [
            {
              holder_id: "pm-d",
              target_id: "pm-c",
              text_contains: "does not depend on",
              reason: "Explicit negative statement",
            },
            {
              holder_id: "pm-ledger",
              reason: "Roadmap ledger names work without asserting an edge",
            },
          ],
        }),
        context,
      ),
    ).resolves.toMatchObject({
      value: 1,
      population_size: 5,
      contributors: ["pm-a->pm-c|subject=explicit"],
      partitions: { explicit_subject: 1, implicit_subject: 0 },
    });
  });

  it("classifies missing provenance and omits blank source markers from contributors", async () => {
    const result = await evaluateMeasurement(
      measurement("missing", {
        kind: "dependency_kind",
        dependency_kind: "blocks",
        source_kind_state: "missing",
      }),
      {
        ...context,
        items: [
          {
            id: "pm-holder",
            status: "open",
            type: "Task",
            dependencies: [
              { id: "pm-target", kind: "blocks" },
              { id: "pm-other", kind: "blocks", source_kind: "   " },
              { id: "pm-cited", kind: "blocks", source_kind: "evidence:test" },
            ],
          },
        ],
      },
    );

    expect(result).toMatchObject({
      value: 2,
      contributors: ["pm-holder->pm-target", "pm-holder->pm-other"],
    });
  });

  it("reads every prose surface once, honors scalar links, and keeps the strongest pair classification", async () => {
    const result = await evaluateMeasurement(
      measurement("all-prose", { kind: "prose_edge_gap" }),
      {
        ...context,
        items: [
          {
            id: "pm-holder",
            status: "open",
            type: "Task",
            description: 42,
            body: "pm-holder pm-one pm-three pm-unknown",
            comments: [
              "pm-two",
              { text: "pm-three" },
              { value: "pm-four" },
              null,
            ],
            notes: [{ text: "pm-four" }],
            learnings: "pm-four",
            parent: "pm-one",
            blocked_by: "pm-two",
          },
          { id: "pm-one", status: "open", type: "Task" },
          { id: "pm-two", status: "open", type: "Task" },
          { id: "pm-three", status: "open", type: "Task" },
          { id: "pm-four", status: "open", type: "Task" },
        ],
      },
    );

    expect(result).toMatchObject({
      value: 2,
      population_size: 5,
      contributors: [
        "pm-holder->pm-four|subject=implicit",
        "pm-holder->pm-three|subject=explicit",
      ],
      partitions: { explicit_subject: 1, implicit_subject: 1 },
    });
    expect(result.cost.units).toBe(14);
    expect(
      evaluateAssuranceAssertion(
        {
          id: "all-prose-ceiling",
          measurement_id: "all-prose",
          owner_item_id: "pm-holder",
          scope: { kind: "all" },
          ceiling: 2,
          enforcement: "block",
          negative_control: {
            cases: [
              { observed: 2, expected: "pass" },
              { observed: 3, expected: "fail" },
            ],
          },
        },
        result,
      ),
    ).toMatchObject({
      verdict: "pass",
      partitions: { explicit_subject: 1, implicit_subject: 1 },
    });
  });

  it("rejects ambiguous provenance filters and unreasoned or unbounded prose configuration", () => {
    expect(() =>
      validateMeasurementDefinition(
        measurement("ambiguous", {
          kind: "dependency_kind",
          dependency_kind: "blocks",
          source_kind: "one",
          source_kind_prefix: "two",
        }),
      ),
    ).toThrow("at most one source_kind predicate");
    expect(() =>
      validateMeasurementDefinition(
        measurement("unreasoned", {
          kind: "prose_edge_gap",
          exemptions: [{ holder_id: "pm-a", reason: "" }],
        }),
      ),
    ).toThrow("require holder_id and reason");
    expect(() =>
      validateMeasurementDefinition(
        measurement("unbounded", {
          kind: "prose_edge_gap",
          sample_limit: 0,
        }),
      ),
    ).toThrow("positive integer");
    expect(() =>
      validateMeasurementDefinition(
        measurement("empty-provenance", {
          kind: "dependency_kind",
          dependency_kind: "blocks",
          source_kind: " ",
        }),
      ),
    ).toThrow("provenance values must not be empty");
    expect(() =>
      validateMeasurementDefinition(
        measurement("empty-prefix", {
          kind: "dependency_kind",
          dependency_kind: "blocks",
          source_kind_prefix: " ",
        }),
      ),
    ).toThrow("provenance values must not be empty");
    expect(() =>
      validateMeasurementDefinition(
        measurement("invalid-state", {
          kind: "dependency_kind",
          dependency_kind: "blocks",
          source_kind_state: "unknown",
        } as never),
      ),
    ).toThrow("source_kind_state must be present or missing");
    expect(() =>
      validateMeasurementDefinition(
        measurement("empty-selector", {
          kind: "prose_edge_gap",
          exemptions: [
            { holder_id: "pm-a", target_id: " ", reason: "Reviewed" },
          ],
        }),
      ),
    ).toThrow("exemption selectors must not be empty");
    expect(() =>
      validateMeasurementDefinition(
        measurement("fractional-limit", {
          kind: "prose_edge_gap",
          sample_limit: 1.5,
        }),
      ),
    ).toThrow("positive integer");
  });
});
