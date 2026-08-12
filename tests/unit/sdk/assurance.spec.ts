import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assuranceAssertionUpdateIsLoosening,
  createEmptyAssuranceDocument,
  evaluateAssuranceAssertion,
  evaluateAssuranceGate,
  evaluateMeasurement,
  getAssuranceDeclaration,
  listAssuranceDeclarations,
  listAssuranceVerdicts,
  putAssuranceDeclaration,
  recordAssuranceVerdict,
  removeAssuranceDeclaration,
  validateAssertionDefinition,
  validateAssuranceDocument,
  validateGateDefinition,
  validateMeasurementDefinition,
  type AssuranceAssertionDefinition,
  type AssuranceEvaluationContext,
  type AssuranceGateDefinition,
  type AssuranceMeasurementDefinition,
} from "../../../src/sdk/governance/assurance.js";
import {
  getWorkspaceHistoryPath,
  WORKSPACE_HISTORY_ID,
} from "../../../src/sdk/runtime-primitives.js";
import { verifyHistoryChain } from "../../../src/core/history/replay.js";
import { readHistoryEntries } from "../../../src/core/history/read.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const itemsMeasurement: AssuranceMeasurementDefinition = {
  id: "active-issues",
  source: {
    kind: "items",
    statuses: ["open", "in_progress"],
    types: ["Issue"],
    tags: ["quality"],
  },
  max_cost: 20,
};

const assertion: AssuranceAssertionDefinition = {
  id: "active-issues-ceiling",
  measurement_id: itemsMeasurement.id,
  owner_item_id: "pm-owner",
  scope: { kind: "all" },
  ceiling: 1,
  lifetime: "hold",
  enforcement: "block",
  negative_control: {
    cases: [
      { observed: 2, expected: "fail" },
      { observed: 1, expected: "pass" },
    ],
  },
};

const gate: AssuranceGateDefinition = {
  id: "quality",
  assertion_ids: [assertion.id],
  triggers: ["ci", "pre-release"],
};

function evaluationContext(): AssuranceEvaluationContext {
  return {
    tree_id: "tree-123",
    items: [
      {
        id: "pm-a",
        status: "open",
        type: "Issue",
        tags: ["quality"],
        dependencies: [
          { id: "pm-b", kind: "blocks" },
          { id: "pm-b", kind: "related_to" },
        ],
        files: [{ path: "src/a.ts" }],
      },
      {
        id: "pm-b",
        status: "closed",
        type: "Task",
        tags: ["delivery"],
        dependencies: [{ id: "pm-a", kind: "verifies" }],
        tests: [],
      },
    ],
    history: [
      { op: "create", author: "agent-a" },
      { op: "update", author: "agent-b" },
    ],
    terminal_statuses: ["closed", "canceled"],
    external: async (source) => {
      if (source.kind === "health") {
        return { value: 0, population_size: 1, cost: 2 };
      }
      if (source.kind === "provider") {
        return {
          value: source.key === "labels" ? ["lines"] : 98.5,
          population_size: 1,
          cost: 3,
        };
      }
      return { value: 4, population_size: 4, cost: 4 };
    },
  };
}

describe("assurance SDK", () => {
  it("validates every declaration kind and rejects ambiguous or unproven bounds", () => {
    expect(validateMeasurementDefinition(itemsMeasurement)).toEqual(
      itemsMeasurement,
    );
    expect(validateAssertionDefinition(assertion)).toEqual(assertion);
    expect(validateGateDefinition(gate)).toEqual(gate);
    expect(
      validateAssuranceDocument({
        version: 1,
        measurements: [itemsMeasurement],
        assertions: [assertion],
        gates: [gate],
      }),
    ).toMatchObject({ version: 1 });

    expect(() =>
      validateMeasurementDefinition({ ...itemsMeasurement, id: "bad id" }),
    ).toThrow("stable lowercase id");
    expect(() =>
      validateAssertionDefinition({ ...assertion, floor: 0 }),
    ).toThrow("exactly one polarity");
    expect(() =>
      validateAssertionDefinition({
        ...assertion,
        negative_control: { cases: [{ observed: 2, expected: "fail" }] },
      }),
    ).toThrow("pass and fail");
    expect(() =>
      validateAssertionDefinition({
        ...assertion,
        negative_control: {
          cases: [
            { observed: 0, expected: "fail" },
            { observed: 2, expected: "pass" },
          ],
        },
      }),
    ).toThrow("does not prove");
    expect(() =>
      validateAssertionDefinition({
        ...assertion,
        lifetime: "retire",
      }),
    ).toThrow("retire_reason");
    expect(() =>
      validateGateDefinition({ ...gate, assertion_ids: [] }),
    ).toThrow("at least one assertion");
  });

  it("rejects invalid source, scope, cost, reference, and registry contracts", () => {
    for (const max_cost of [-1, Number.NaN]) {
      expect(() =>
        validateMeasurementDefinition({ ...itemsMeasurement, max_cost }),
      ).toThrow("finite non-negative");
    }
    expect(() =>
      validateMeasurementDefinition({
        id: "deps",
        source: { kind: "dependency_kind", dependency_kind: " " },
      }),
    ).toThrow("requires dependency_kind");
    expect(() =>
      validateMeasurementDefinition({
        id: "deps",
        source: { kind: "dependency_kind" },
      } as unknown as AssuranceMeasurementDefinition),
    ).toThrow("requires dependency_kind");
    for (const kind of ["graph", "validate", "health"] as const) {
      expect(() =>
        validateMeasurementDefinition(
          kind === "graph"
            ? { id: kind, source: { kind, operation: "audit", field: " " } }
            : { id: kind, source: { kind, check: "check", field: " " } },
        ),
      ).toThrow("requires field");
      expect(() =>
        validateMeasurementDefinition(
          (kind === "graph"
            ? { id: kind, source: { kind, operation: "audit" } }
            : {
                id: kind,
                source: { kind, check: "check" },
              }) as unknown as AssuranceMeasurementDefinition,
        ),
      ).toThrow("requires field");
    }
    expect(() =>
      validateMeasurementDefinition({
        id: "provider",
        source: { kind: "provider", provider: "Bad Provider", key: "valid" },
      }),
    ).toThrow("stable lowercase id");
    expect(() =>
      validateMeasurementDefinition({
        id: "provider",
        source: { kind: "provider", provider: "valid", key: "Bad Key" },
      }),
    ).toThrow("stable lowercase id");
    expect(() =>
      validateAssertionDefinition({ ...assertion, owner_item_id: " " }),
    ).toThrow("owner_item_id");
    expect(() =>
      validateAssertionDefinition({
        ...assertion,
        ceiling: -1,
        negative_control: {
          cases: [
            { observed: -1, expected: "pass" },
            { observed: 0, expected: "fail" },
          ],
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateAssertionDefinition({
        ...assertion,
        ceiling: Number.NaN,
      }),
    ).toThrow("finite number");
    expect(() =>
      validateAssertionDefinition({
        ...assertion,
        negative_control: {
          cases: [
            { observed: 2, expected: "fail" },
            { observed: 1, expected: "pass" },
          ],
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateMeasurementDefinition({
        id: "field-without-value",
        source: { kind: "items", field: "priority" },
      }),
    ).toThrow("requires exactly one of equals or state");
    expect(() =>
      validateMeasurementDefinition({
        id: "missing-priority",
        source: { kind: "items", field: "priority", state: "missing" },
      }),
    ).not.toThrow();
    expect(() =>
      validateMeasurementDefinition({
        id: "invalid-state",
        source: { kind: "items", field: "priority", state: "invalid" },
      } as unknown as AssuranceMeasurementDefinition),
    ).toThrow("state must be present or missing");
    expect(() =>
      validateMeasurementDefinition({
        id: "ambiguous-priority",
        source: {
          kind: "items",
          field: "priority",
          equals: null,
          state: "missing",
        },
      }),
    ).toThrow("exactly one of equals or state");
    expect(() =>
      validateMeasurementDefinition({
        id: "predicate-without-field",
        source: { kind: "items", equals: "high" },
      }),
    ).toThrow("equals/state requires field");
    expect(() =>
      validateAssertionDefinition({
        ...assertion,
        scope: { kind: "filter", measurement_id: "Bad Id" },
      }),
    ).toThrow("stable lowercase id");
    expect(() => validateGateDefinition({ ...gate, triggers: [] })).toThrow(
      "at least one trigger",
    );

    const document = {
      version: 1 as const,
      measurements: [itemsMeasurement],
      assertions: [assertion],
      gates: [gate],
    };
    expect(() =>
      validateAssuranceDocument({ ...document, version: 2 as 1 }),
    ).toThrow("unsupported assurance document version");
    expect(() =>
      validateAssuranceDocument({
        ...document,
        measurements: [itemsMeasurement, itemsMeasurement],
      }),
    ).toThrow("duplicate measurement");
    expect(() =>
      validateAssuranceDocument({
        ...document,
        assertions: [assertion, assertion],
      }),
    ).toThrow("duplicate assertion");
    expect(() =>
      validateAssuranceDocument({ ...document, gates: [gate, gate] }),
    ).toThrow("duplicate gate");
    expect(() =>
      validateAssuranceDocument({
        ...document,
        assertions: [{ ...assertion, measurement_id: "missing" }],
      }),
    ).toThrow("references missing measurement");
    expect(() =>
      validateAssuranceDocument({
        ...document,
        assertions: [
          {
            ...assertion,
            scope: { kind: "filter", measurement_id: "missing-scope" },
          },
        ],
      }),
    ).toThrow("scope references missing measurement");
    expect(() =>
      validateAssuranceDocument({
        ...document,
        measurements: [
          itemsMeasurement,
          {
            id: "dangling-derived",
            source: {
              kind: "derived",
              expression: {
                operator: "add",
                operands: [{ measurement: "missing-derived" }],
              },
            },
          },
        ],
      }),
    ).toThrow(
      "derived measurement dangling-derived references missing measurement",
    );
    expect(() =>
      validateAssuranceDocument({
        ...document,
        measurements: [
          itemsMeasurement,
          {
            id: "literal-derived",
            source: { kind: "derived", expression: { literal: -1 } },
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      validateAssuranceDocument({
        ...document,
        gates: [{ ...gate, assertion_ids: ["missing"] }],
      }),
    ).toThrow("references missing assertions");
  });

  it("classifies tightening separately from every material loosening path", () => {
    expect(
      assuranceAssertionUpdateIsLoosening(assertion, {
        ...assertion,
        ceiling: 0,
        negative_control: {
          cases: [
            { observed: 1, expected: "fail" },
            { observed: 0, expected: "pass" },
          ],
        },
      }),
    ).toBe(false);
    expect(
      assuranceAssertionUpdateIsLoosening(assertion, {
        ...assertion,
        ceiling: 2,
        negative_control: {
          cases: [
            { observed: 2, expected: "pass" },
            { observed: 3, expected: "fail" },
          ],
        },
      }),
    ).toBe(true);
    const loosenings: AssuranceAssertionDefinition[] = [
      { ...assertion, measurement_id: "different" },
      { ...assertion, owner_item_id: "different" },
      { ...assertion, scope: { kind: "active" } },
      {
        ...assertion,
        floor: 1,
        ceiling: undefined,
        negative_control: {
          cases: [
            { observed: 1, expected: "pass" },
            { observed: 0, expected: "fail" },
          ],
        },
      },
      { ...assertion, enforcement: "warn" },
      {
        ...assertion,
        lifetime: "retire",
        retire_reason: "Temporary migration bound.",
      },
    ];
    for (const updated of loosenings) {
      expect(assuranceAssertionUpdateIsLoosening(assertion, updated)).toBe(
        true,
      );
    }
    const subset: AssuranceAssertionDefinition = {
      ...assertion,
      ceiling: undefined,
      subset_of: ["a", "b"],
      negative_control: {
        cases: [
          { observed: ["a"], expected: "pass" },
          { observed: ["c"], expected: "fail" },
        ],
      },
    };
    expect(
      assuranceAssertionUpdateIsLoosening(subset, {
        ...subset,
        subset_of: ["a"],
      }),
    ).toBe(false);
    expect(
      assuranceAssertionUpdateIsLoosening(subset, {
        ...subset,
        subset_of: ["a", "b", "c"],
        negative_control: {
          cases: [
            { observed: ["c"], expected: "pass" },
            { observed: ["d"], expected: "fail" },
          ],
        },
      }),
    ).toBe(true);
    expect(
      assuranceAssertionUpdateIsLoosening(
        { ...subset, subset_of: 1 as unknown as string[] },
        subset,
      ),
    ).toBe(true);
    expect(
      assuranceAssertionUpdateIsLoosening(subset, {
        ...subset,
        subset_of: 1 as unknown as string[],
      }),
    ).toBe(true);
    const equals: AssuranceAssertionDefinition = {
      ...assertion,
      ceiling: undefined,
      equals: ["a"],
      negative_control: {
        cases: [
          { observed: ["a"], expected: "pass" },
          { observed: ["b"], expected: "fail" },
        ],
      },
    };
    expect(assuranceAssertionUpdateIsLoosening(equals, equals)).toBe(false);
    expect(
      assuranceAssertionUpdateIsLoosening(equals, {
        ...equals,
        equals: ["b"],
        negative_control: {
          cases: [
            { observed: ["b"], expected: "pass" },
            { observed: ["a"], expected: "fail" },
          ],
        },
      }),
    ).toBe(true);
    const numericBaselines: Array<
      [AssuranceAssertionDefinition, AssuranceAssertionDefinition, boolean]
    > = [
      [
        {
          ...assertion,
          ceiling: undefined,
          floor: 1,
          negative_control: {
            cases: [
              { observed: 1, expected: "pass" },
              { observed: 0, expected: "fail" },
            ],
          },
        },
        {
          ...assertion,
          ceiling: undefined,
          floor: 2,
          negative_control: {
            cases: [
              { observed: 2, expected: "pass" },
              { observed: 1, expected: "fail" },
            ],
          },
        },
        false,
      ],
      [
        {
          ...assertion,
          ceiling: undefined,
          floor: 1,
          negative_control: {
            cases: [
              { observed: 1, expected: "pass" },
              { observed: 0, expected: "fail" },
            ],
          },
        },
        {
          ...assertion,
          ceiling: undefined,
          floor: 0,
          negative_control: {
            cases: [
              { observed: 0, expected: "pass" },
              { observed: -1, expected: "fail" },
            ],
          },
        },
        true,
      ],
      [
        {
          ...assertion,
          ceiling: undefined,
          monotone_nonincreasing: 1,
          negative_control: {
            cases: [
              { observed: 1, expected: "pass" },
              { observed: 2, expected: "fail" },
            ],
          },
        },
        {
          ...assertion,
          ceiling: undefined,
          monotone_nonincreasing: 2,
          negative_control: {
            cases: [
              { observed: 2, expected: "pass" },
              { observed: 3, expected: "fail" },
            ],
          },
        },
        true,
      ],
      [
        {
          ...assertion,
          ceiling: undefined,
          monotone_nondecreasing: 1,
          negative_control: {
            cases: [
              { observed: 1, expected: "pass" },
              { observed: 0, expected: "fail" },
            ],
          },
        },
        {
          ...assertion,
          ceiling: undefined,
          monotone_nondecreasing: 2,
          negative_control: {
            cases: [
              { observed: 2, expected: "pass" },
              { observed: 1, expected: "fail" },
            ],
          },
        },
        false,
      ],
      [
        {
          ...assertion,
          ceiling: undefined,
          zero: true,
          negative_control: {
            cases: [
              { observed: 0, expected: "pass" },
              { observed: 1, expected: "fail" },
            ],
          },
        },
        {
          ...assertion,
          ceiling: undefined,
          zero: true,
          negative_control: {
            cases: [
              { observed: 0, expected: "pass" },
              { observed: 2, expected: "fail" },
            ],
          },
        },
        false,
      ],
    ];
    for (const [before, after, expected] of numericBaselines) {
      expect(assuranceAssertionUpdateIsLoosening(before, after)).toBe(expected);
    }
    expect(
      assuranceAssertionUpdateIsLoosening(
        { ...assertion, lifetime: undefined },
        { ...assertion, lifetime: undefined },
      ),
    ).toBe(false);
  });

  it("evaluates built-in, external, and derived measurements with cost receipts", async () => {
    const context = evaluationContext();
    await expect(
      evaluateMeasurement(itemsMeasurement, context),
    ).resolves.toMatchObject({
      id: "active-issues",
      definition_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      value: 1,
      population_size: 2,
      cost: { units: 2 },
    });
    await expect(
      evaluateMeasurement(
        {
          id: "blocks",
          source: { kind: "dependency_kind", dependency_kind: "blocks" },
        },
        context,
      ),
    ).resolves.toMatchObject({ value: 1, population_size: 2 });
    await expect(
      evaluateMeasurement(
        {
          id: "related",
          source: { kind: "dependency_kind", dependency_kind: "related" },
        },
        context,
      ),
    ).resolves.toMatchObject({ value: 1, population_size: 2 });
    await expect(
      evaluateMeasurement(
        {
          id: "custom-kind",
          source: {
            kind: "dependency_kind",
            dependency_kind: " CUSTOM_KIND ",
          },
        },
        {
          ...context,
          items: [
            {
              id: "custom-source",
              dependencies: [{ id: "custom-target", kind: " CUSTOM_KIND " }],
            },
          ] as never,
        },
      ),
    ).resolves.toMatchObject({
      value: 1,
      population_size: 1,
      contributors: ["custom-source->custom-target"],
    });
    await expect(
      evaluateMeasurement(
        {
          id: "missing-priority",
          source: { kind: "items", field: "priority", state: "missing" },
        },
        context,
      ),
    ).resolves.toMatchObject({ value: 2, population_size: 2 });
    await expect(
      evaluateMeasurement(
        {
          id: "null-priority",
          source: { kind: "items", field: "priority", equals: null },
        },
        {
          ...context,
          items: context.items.map((item, index) =>
            index === 0 ? { ...item, priority: null } : item,
          ),
        },
      ),
    ).resolves.toMatchObject({
      value: 1,
      population_size: 2,
      contributors: ["pm-a"],
    });
    await expect(
      evaluateMeasurement(
        { id: "updates", source: { kind: "history", op: "update" } },
        context,
      ),
    ).resolves.toMatchObject({ value: 1, population_size: 2 });
    await expect(
      evaluateMeasurement(
        {
          id: "missing-tests",
          source: { kind: "links", link: "tests", state: "missing" },
        },
        context,
      ),
    ).resolves.toMatchObject({ value: 2, population_size: 2 });
    await expect(
      evaluateMeasurement(
        {
          id: "health",
          source: { kind: "health", check: "storage", field: "warnings" },
        },
        context,
      ),
    ).resolves.toMatchObject({ value: 0, cost: { units: 2 } });
    await expect(
      evaluateMeasurement(
        {
          id: "coverage",
          source: { kind: "provider", provider: "coverage", key: "lines" },
        },
        context,
      ),
    ).resolves.toMatchObject({ value: 98.5, cost: { units: 3 } });

    const measurements: AssuranceMeasurementDefinition[] = [
      {
        id: "nodes",
        source: { kind: "graph", operation: "audit", field: "nodes" },
      },
      {
        id: "redundant",
        source: { kind: "graph", operation: "redundancy", field: "count" },
      },
      {
        id: "load-bearing",
        source: {
          kind: "derived",
          expression: {
            operator: "subtract",
            operands: [{ measurement: "nodes" }, { measurement: "redundant" }],
          },
        },
      },
    ];
    await expect(
      evaluateMeasurement(measurements[2], context, measurements),
    ).resolves.toMatchObject({ value: 0, cost: { provider_calls: 2 } });
    let providerCalls = 0;
    const memoizedContext: AssuranceEvaluationContext = {
      ...context,
      external: async (source) => {
        providerCalls += 1;
        return context.external(source);
      },
    };
    const sharedLeaf: AssuranceMeasurementDefinition = {
      id: "shared-leaf",
      source: { kind: "provider", provider: "coverage", key: "lines" },
    };
    const memoizedRoot: AssuranceMeasurementDefinition = {
      id: "memoized-root",
      source: {
        kind: "derived",
        expression: {
          operator: "add",
          operands: [
            { measurement: sharedLeaf.id },
            { measurement: sharedLeaf.id },
          ],
        },
      },
    };
    await expect(
      evaluateMeasurement(memoizedRoot, memoizedContext, [
        memoizedRoot,
        sharedLeaf,
      ]),
    ).resolves.toMatchObject({ value: 197, cost: { provider_calls: 1 } });
    expect(providerCalls).toBe(1);
    await expect(
      evaluateMeasurement(
        {
          id: "cycle-a",
          source: { kind: "derived", expression: { measurement: "cycle-b" } },
        },
        context,
        [
          {
            id: "cycle-a",
            source: { kind: "derived", expression: { measurement: "cycle-b" } },
          },
          {
            id: "cycle-b",
            source: { kind: "derived", expression: { measurement: "cycle-a" } },
          },
        ],
      ),
    ).rejects.toThrow("cycle-a -> cycle-b -> cycle-a");
    await expect(
      evaluateMeasurement({ ...itemsMeasurement, max_cost: 1 }, context),
    ).rejects.toThrow("cost ceiling");

    await expect(
      evaluateMeasurement(
        {
          id: "field-match",
          source: { kind: "items", field: "priority", equals: "high" },
        },
        {
          ...context,
          items: [{ id: "a", status: "open", type: "Task", priority: "high" }],
        },
      ),
    ).resolves.toMatchObject({ value: 1 });
    await expect(
      evaluateMeasurement(
        { id: "type-filter", source: { kind: "items", types: ["Feature"] } },
        context,
      ),
    ).resolves.toMatchObject({ value: 0 });
    await expect(
      evaluateMeasurement(
        {
          id: "no-deps",
          source: { kind: "dependency_kind", dependency_kind: "blocks" },
        },
        { ...context, items: [{ id: "none", status: "open", type: "Task" }] },
      ),
    ).resolves.toMatchObject({ value: 0 });
    await expect(
      evaluateMeasurement(
        {
          id: "linked-files",
          source: { kind: "links", link: "files", state: "present" },
        },
        context,
      ),
    ).resolves.toMatchObject({ value: 1 });
    await expect(
      evaluateMeasurement(
        {
          id: "agent-history",
          source: {
            kind: "history",
            author: "agent-a",
            harness: "none",
            model: "none",
          },
        },
        context,
      ),
    ).resolves.toMatchObject({ value: 0 });
    await expect(
      evaluateMeasurement(
        { id: "model-history", source: { kind: "history", model: "model-a" } },
        {
          ...context,
          history: [{ op: "create", author: "a", agent_model: "model-a" }],
        },
      ),
    ).resolves.toMatchObject({ value: 1 });

    const arithmeticCases: Array<
      ["add" | "multiply" | "divide" | "min" | "max", number]
    > = [
      ["add", 6],
      ["multiply", 8],
      ["divide", 2],
      ["min", 2],
      ["max", 4],
    ];
    for (const [operator, expected] of arithmeticCases) {
      await expect(
        evaluateMeasurement(
          {
            id: `derived-${operator}`,
            source: {
              kind: "derived",
              expression: {
                operator,
                operands: [{ literal: 4 }, { literal: 2 }],
              },
            },
          },
          context,
        ),
      ).resolves.toMatchObject({ value: expected });
    }
    await expect(
      evaluateMeasurement(
        {
          id: "empty-derived",
          source: {
            kind: "derived",
            expression: { operator: "add", operands: [] },
          },
        },
        context,
      ),
    ).rejects.toThrow("requires operands");
    await expect(
      evaluateMeasurement(
        {
          id: "divide-zero",
          source: {
            kind: "derived",
            expression: {
              operator: "divide",
              operands: [{ literal: 1 }, { literal: 0 }],
            },
          },
        },
        context,
      ),
    ).rejects.toThrow("divide by zero");
    await expect(
      evaluateMeasurement(
        {
          id: "missing-derived",
          source: { kind: "derived", expression: { measurement: "missing" } },
        },
        context,
      ),
    ).rejects.toThrow("references missing");
    await expect(
      evaluateMeasurement(
        {
          id: "set-derived",
          source: { kind: "derived", expression: { measurement: "set" } },
        },
        context,
        [
          {
            id: "set-derived",
            source: { kind: "derived", expression: { measurement: "set" } },
          },
          {
            id: "set",
            source: { kind: "provider", provider: "coverage", key: "labels" },
          },
        ],
      ),
    ).rejects.toThrow("is not numeric");
    await expect(
      evaluateMeasurement(
        {
          id: "unsupported",
          source: {
            kind: "unsupported",
          } as unknown as AssuranceMeasurementDefinition["source"],
        },
        context,
      ),
    ).rejects.toThrow("unsupported assurance source");
  });

  it("supports every assertion polarity and enforcement result", () => {
    const result = {
      id: "measurement",
      value: 2,
      population_size: 1,
      cost: {
        units: 1,
        items_scanned: 1,
        history_entries: 0,
        provider_calls: 0,
        duration_ms: 0,
      },
      contributors: [],
    };
    const cases: AssuranceAssertionDefinition[] = [
      {
        ...assertion,
        id: "floor",
        floor: 2,
        ceiling: undefined,
        negative_control: {
          cases: [
            { observed: 2, expected: "pass" },
            { observed: 1, expected: "fail" },
          ],
        },
      },
      {
        ...assertion,
        id: "equals",
        equals: 2,
        ceiling: undefined,
        negative_control: {
          cases: [
            { observed: 2, expected: "pass" },
            { observed: 1, expected: "fail" },
          ],
        },
      },
      {
        ...assertion,
        id: "nondecreasing",
        monotone_nondecreasing: 2,
        ceiling: undefined,
        negative_control: {
          cases: [
            { observed: 2, expected: "pass" },
            { observed: 1, expected: "fail" },
          ],
        },
      },
      {
        ...assertion,
        id: "nonincreasing",
        monotone_nonincreasing: 2,
        ceiling: undefined,
        negative_control: {
          cases: [
            { observed: 2, expected: "pass" },
            { observed: 3, expected: "fail" },
          ],
        },
      },
      {
        ...assertion,
        id: "zero",
        zero: true,
        ceiling: undefined,
        negative_control: {
          cases: [
            { observed: 0, expected: "pass" },
            { observed: 1, expected: "fail" },
          ],
        },
      },
    ];
    for (const definition of cases) {
      expect(
        evaluateAssuranceAssertion(
          definition,
          definition.zero === true ? { ...result, value: 0 } : result,
        ),
      ).toMatchObject({ verdict: "pass" });
    }
    const subsetDefinition: AssuranceAssertionDefinition = {
      ...assertion,
      id: "subset",
      subset_of: ["a", "b"],
      ceiling: undefined,
      negative_control: {
        cases: [
          { observed: ["a"], expected: "pass" },
          { observed: ["c"], expected: "fail" },
        ],
      },
    };
    expect(
      evaluateAssuranceAssertion(subsetDefinition, { ...result, value: ["a"] }),
    ).toMatchObject({ verdict: "pass", distance: null });
    expect(
      evaluateAssuranceAssertion(subsetDefinition, { ...result, value: ["c"] }),
    ).toMatchObject({ verdict: "fail" });
    expect(evaluateAssuranceAssertion(subsetDefinition, result)).toMatchObject({
      verdict: "fail",
    });
    expect(
      evaluateAssuranceAssertion(assertion, {
        ...result,
        value: ["not-numeric"],
      }),
    ).toMatchObject({ verdict: "fail" });
  });

  it("returns one deterministic structured gate verdict and proves dry-run behavior", async () => {
    const document = {
      version: 1 as const,
      measurements: [itemsMeasurement],
      assertions: [assertion],
      gates: [gate],
    };
    await expect(
      evaluateAssuranceGate("quality", document, evaluationContext(), {
        trigger: "ci",
        dry_run: true,
      }),
    ).resolves.toMatchObject({
      gate_id: "quality",
      tree_id: "tree-123",
      trigger: "ci",
      dry_run: true,
      verdict: "pass",
      exit_code: 0,
      assertions: [
        {
          assertion_id: "active-issues-ceiling",
          measurement_id: "active-issues",
          observed: 1,
          bound: { polarity: "ceiling", value: 1 },
          distance: 0,
          verdict: "pass",
        },
      ],
    });
    await expect(
      evaluateAssuranceGate("quality", document, evaluationContext(), {
        trigger: "scheduled",
      }),
    ).rejects.toThrow("does not declare trigger");
  });

  it("applies scope and owner-aware lifetime without weakening held guarantees", async () => {
    const context = evaluationContext();
    context.items.push({ id: "pm-owner", status: "closed", type: "Feature" });
    const retiredAssertion: AssuranceAssertionDefinition = {
      ...assertion,
      lifetime: "retire",
      retire_reason:
        "Migration guarantee only applies while delivery remains active.",
    };
    await expect(
      evaluateAssuranceGate(
        gate.id,
        {
          version: 1,
          measurements: [itemsMeasurement],
          assertions: [retiredAssertion],
          gates: [gate],
        },
        context,
        { trigger: "ci" },
      ),
    ).resolves.toMatchObject({ assertions: [{ verdict: "retired" }] });

    const activeScopeAssertion: AssuranceAssertionDefinition = {
      ...assertion,
      scope: { kind: "active" },
    };
    await expect(
      evaluateAssuranceGate(
        gate.id,
        {
          version: 1,
          measurements: [itemsMeasurement],
          assertions: [activeScopeAssertion],
          gates: [gate],
        },
        { ...context, terminal_statuses: undefined },
        { trigger: "ci" },
      ),
    ).resolves.toMatchObject({
      assertions: [{ population_size: 1, verdict: "pass" }],
    });

    const filterMeasurement: AssuranceMeasurementDefinition = {
      id: "quality-scope",
      source: { kind: "items", tags: ["quality"] },
    };
    const filterAssertion: AssuranceAssertionDefinition = {
      ...assertion,
      scope: { kind: "filter", measurement_id: filterMeasurement.id },
    };
    await expect(
      evaluateAssuranceGate(
        gate.id,
        {
          version: 1,
          measurements: [itemsMeasurement, filterMeasurement],
          assertions: [filterAssertion],
          gates: [gate],
        },
        context,
        { trigger: "ci" },
      ),
    ).resolves.toMatchObject({ assertions: [{ population_size: 1 }] });

    const failingContext = evaluationContext();
    failingContext.items.push({
      id: "pm-c",
      status: "open",
      type: "Issue",
      tags: ["quality"],
    });
    for (const [enforcement, verdict] of [
      ["block", "block"],
      ["warn", "warn"],
      ["observe", "pass"],
    ] as const) {
      await expect(
        evaluateAssuranceGate(
          gate.id,
          {
            version: 1,
            measurements: [itemsMeasurement],
            assertions: [{ ...assertion, enforcement }],
            gates: [gate],
          },
          failingContext,
          { trigger: "ci" },
        ),
      ).resolves.toMatchObject({
        verdict,
        exit_code: enforcement === "block" ? 1 : 0,
      });
    }
    await expect(
      evaluateAssuranceGate(
        "missing",
        {
          version: 1,
          measurements: [itemsMeasurement],
          assertions: [assertion],
          gates: [gate],
        },
        context,
        { trigger: "ci" },
      ),
    ).rejects.toThrow("not found");
    await expect(
      evaluateAssuranceGate(
        gate.id,
        {
          version: 1,
          measurements: [itemsMeasurement],
          assertions: [
            {
              ...assertion,
              scope: { kind: "filter", measurement_id: "missing-scope" },
            },
          ],
          gates: [gate],
        },
        context,
        { trigger: "ci" },
      ),
    ).rejects.toThrow("scope references missing measurement");
  });

  it("persists registry mutations and verdicts through the verified workspace history", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      expect((await listAssuranceDeclarations(pmPath, "gate")).items).toEqual(
        [],
      );
      await expect(
        removeAssuranceDeclaration(pmPath, "measurement", "missing", {
          author: "test-author",
        }),
      ).rejects.toThrow("not found");
      expect(createEmptyAssuranceDocument()).toEqual({
        version: 1,
        measurements: [],
        assertions: [],
        gates: [],
      });
      await putAssuranceDeclaration(pmPath, "measurement", itemsMeasurement, {
        author: "test-author",
      });
      await putAssuranceDeclaration(pmPath, "assertion", assertion, {
        author: "test-author",
      });
      await putAssuranceDeclaration(pmPath, "gate", gate, {
        author: "test-author",
      });
      expect(
        (await listAssuranceDeclarations(pmPath, "measurement")).items,
      ).toEqual([itemsMeasurement]);
      expect(
        await getAssuranceDeclaration(pmPath, "assertion", assertion.id),
      ).toEqual(assertion);
      await expect(
        putAssuranceDeclaration(
          pmPath,
          "measurement",
          { ...itemsMeasurement, max_cost: 10 },
          { author: "test-author" },
        ),
      ).resolves.toMatchObject({ changed: true, action: "updated" });
      await expect(
        putAssuranceDeclaration(
          pmPath,
          "assertion",
          {
            ...assertion,
            ceiling: 2,
            negative_control: {
              cases: [
                { observed: 3, expected: "fail" },
                { observed: 2, expected: "pass" },
              ],
            },
          },
          { author: "test-author" },
        ),
      ).rejects.toThrow("verified authorization_decision");
      await expect(
        putAssuranceDeclaration(
          pmPath,
          "assertion",
          {
            ...assertion,
            ceiling: 2,
            authorization_decision: "pm-decision",
            negative_control: {
              cases: [
                { observed: 3, expected: "fail" },
                { observed: 2, expected: "pass" },
              ],
            },
          },
          {
            author: "test-author",
            authorized_decision_ids: ["pm-decision"],
          },
        ),
      ).resolves.toMatchObject({ changed: true, action: "updated" });
      await expect(
        removeAssuranceDeclaration(pmPath, "measurement", itemsMeasurement.id, {
          author: "test-author",
        }),
      ).rejects.toThrow("referenced by assertion");
      await expect(
        removeAssuranceDeclaration(pmPath, "assertion", assertion.id, {
          author: "test-author",
        }),
      ).rejects.toThrow("referenced by gate");

      const verdict = await evaluateAssuranceGate(
        gate.id,
        {
          version: 1,
          measurements: [{ ...itemsMeasurement, max_cost: 10 }],
          assertions: [assertion],
          gates: [gate],
        },
        evaluationContext(),
        { trigger: "ci" },
      );
      await recordAssuranceVerdict(pmPath, verdict, { author: "test-author" });
      await expect(
        recordAssuranceVerdict(pmPath, { ...verdict, dry_run: true }),
      ).rejects.toThrow("not persisted");
      expect(await listAssuranceVerdicts(pmPath, { gate_id: gate.id })).toEqual(
        [verdict],
      );
      expect(await listAssuranceVerdicts(pmPath)).toEqual([verdict]);
      const newerVerdict = {
        ...verdict,
        tree_id: "tree-456",
        evaluated_at: new Date(Date.now() + 1).toISOString(),
      };
      await recordAssuranceVerdict(pmPath, newerVerdict, {
        author: "test-author",
      });
      expect(
        await listAssuranceVerdicts(pmPath, { gate_id: gate.id, limit: 1 }),
      ).toEqual([newerVerdict]);
      await expect(listAssuranceVerdicts(pmPath, { limit: 0 })).rejects.toThrow(
        "integer from 1 through 1000",
      );
      for (const limit of [1.5, 1_001]) {
        await expect(listAssuranceVerdicts(pmPath, { limit })).rejects.toThrow(
          "integer from 1 through 1000",
        );
      }
      const history = await readHistoryEntries(
        getWorkspaceHistoryPath(pmPath),
        WORKSPACE_HISTORY_ID,
      );
      expect(history.map((entry) => entry.op)).toEqual([
        "assurance:measurement:put",
        "assurance:assertion:put",
        "assurance:gate:put",
        "assurance:measurement:put",
        "assurance:assertion:put",
        "assurance:gate:verdict",
        "assurance:gate:verdict",
      ]);
      expect(verifyHistoryChain(history)).toEqual({ ok: true, errors: [] });
      expect(
        JSON.parse(await readFile(path.join(pmPath, "assurance.json"), "utf8")),
      ).toMatchObject({ version: 1 });

      await expect(
        removeAssuranceDeclaration(pmPath, "gate", gate.id, {
          author: "test-author",
        }),
      ).resolves.toMatchObject({ action: "removed" });
      await removeAssuranceDeclaration(pmPath, "assertion", assertion.id, {
        author: "test-author",
      });
      await removeAssuranceDeclaration(
        pmPath,
        "measurement",
        itemsMeasurement.id,
        {
          author: "test-author",
        },
      );
      await putAssuranceDeclaration(pmPath, "measurement", itemsMeasurement, {
        author: "test-author",
      });
      const derivedReference: AssuranceMeasurementDefinition = {
        id: "derived-reference",
        source: {
          kind: "derived",
          expression: { measurement: itemsMeasurement.id },
        },
      };
      await putAssuranceDeclaration(pmPath, "measurement", derivedReference, {
        author: "test-author",
      });
      await expect(
        removeAssuranceDeclaration(pmPath, "measurement", itemsMeasurement.id, {
          author: "test-author",
        }),
      ).rejects.toThrow("referenced by derived measurement");
      await removeAssuranceDeclaration(
        pmPath,
        "measurement",
        derivedReference.id,
        { author: "test-author" },
      );
      const scopeMeasurement: AssuranceMeasurementDefinition = {
        id: "scope-only",
        source: { kind: "items", statuses: ["open"] },
      };
      await putAssuranceDeclaration(pmPath, "measurement", scopeMeasurement, {
        author: "test-author",
      });
      await putAssuranceDeclaration(
        pmPath,
        "assertion",
        {
          ...assertion,
          scope: { kind: "filter", measurement_id: scopeMeasurement.id },
        },
        { author: "test-author" },
      );
      await expect(
        removeAssuranceDeclaration(pmPath, "measurement", scopeMeasurement.id, {
          author: "test-author",
        }),
      ).rejects.toThrow("referenced by assertion");
      await expect(
        getAssuranceDeclaration(pmPath, "measurement", "missing"),
      ).rejects.toThrow("not found");

      await writeFile(path.join(pmPath, "assurance.json"), "{", "utf8");
      await expect(
        listAssuranceDeclarations(pmPath, "measurement"),
      ).rejects.toMatchObject({
        exitCode: 1,
        context: { code: "assurance_registry_invalid" },
      });
      await expect(
        putAssuranceDeclaration(pmPath, "measurement", itemsMeasurement),
      ).rejects.toMatchObject({
        context: { code: "assurance_registry_invalid" },
      });
      await expect(
        removeAssuranceDeclaration(pmPath, "measurement", itemsMeasurement.id),
      ).rejects.toMatchObject({
        context: { code: "assurance_registry_invalid" },
      });
    });
  });
});
