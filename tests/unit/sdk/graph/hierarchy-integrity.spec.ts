import { describe, expect, it } from "vitest";
import {
  analyzeHierarchyIntegrity,
  assertHierarchyMutationAllowed,
  collectHierarchyRelations,
  formatHierarchyRelation,
} from "../../../../src/sdk/graph/hierarchy-integrity.js";
import { createRelationshipKindRegistry } from "../../../../src/sdk/relationships.js";
import type { Dependency, ItemMetadata } from "../../../../src/types/index.js";

const timestamp = "2026-01-01T00:00:00.000Z";

function item(
  id: string,
  options: {
    parent?: string;
    dependencies?: Dependency[];
    status?: ItemMetadata["status"];
  } = {},
): ItemMetadata {
  return {
    id,
    title: id,
    description: "",
    type: "Task",
    status: options.status ?? "open",
    priority: 2,
    tags: [],
    created_at: timestamp,
    updated_at: timestamp,
    ...(options.parent === undefined ? {} : { parent: options.parent }),
    ...(options.dependencies === undefined
      ? {}
      : { dependencies: options.dependencies }),
  };
}

function dependency(id: string, kind: string): Dependency {
  return {
    id,
    kind,
    author: "test",
    created_at: timestamp,
    source_kind: "test:hierarchy",
  };
}

describe("hierarchy integrity", () => {
  it("normalizes scalar, canonical, inverse, and alias spellings into one parent relation", () => {
    const items = [
      item("pm-parent", {
        dependencies: [
          dependency("pm-child-b", "child"),
          dependency("pm-child-c", "task"),
        ],
      }),
      item("pm-child-a", { parent: "pm-parent" }),
      item("pm-child-b"),
      item("pm-child-c"),
      item("pm-child-d", {
        dependencies: [dependency("pm-parent", "child_of")],
      }),
    ];
    const analysis = analyzeHierarchyIntegrity(items);

    expect(
      analysis.relations.map((row) => [
        row.parent_id,
        row.child_id,
        row.source,
        row.kind,
      ]),
    ).toEqual([
      ["pm-parent", "pm-child-a", "scalar_parent", "parent"],
      ["pm-parent", "pm-child-b", "dependency", "child"],
      ["pm-parent", "pm-child-c", "dependency", "child"],
      ["pm-parent", "pm-child-d", "dependency", "parent"],
    ]);
    expect(analysis.cycles).toEqual([]);
    expect(analysis.cardinality_violations).toEqual([]);
    expect(analysis.divergences).toEqual([]);
    expect(collectHierarchyRelations(items)).toEqual(analysis.relations);
  });

  it("reports active and terminal cycles with deterministic members", () => {
    const analysis = analyzeHierarchyIntegrity([
      item("pm-a", { dependencies: [dependency("pm-b", "child_of")] }),
      item("pm-b", { dependencies: [dependency("pm-a", "child_of")] }),
      item("pm-c", {
        status: "closed",
        dependencies: [dependency("pm-d", "child_of")],
      }),
      item("pm-d", {
        status: "closed",
        dependencies: [dependency("pm-c", "child_of")],
      }),
    ]);

    expect(analysis.cycles).toEqual([
      { item_ids: ["pm-a", "pm-b"], legacy_terminal: false },
      { item_ids: ["pm-c", "pm-d"], legacy_terminal: true },
    ]);
  });

  it("separates scalar divergence from dependency-only cardinality violations", () => {
    const analysis = analyzeHierarchyIntegrity([
      item("pm-parent-a", {
        dependencies: [dependency("pm-child", "child")],
      }),
      item("pm-parent-b", {
        dependencies: [dependency("pm-child", "task")],
      }),
      item("pm-child", { parent: "pm-parent-c" }),
      item("pm-parent-c"),
      item("pm-parent-d", {
        dependencies: [dependency("pm-child-only", "child")],
      }),
      item("pm-parent-e", {
        dependencies: [dependency("pm-child-only", "child")],
      }),
      item("pm-child-only"),
    ]);

    expect(analysis.cardinality_violations).toEqual([
      {
        child_id: "pm-child",
        parent_ids: ["pm-parent-a", "pm-parent-b", "pm-parent-c"],
        legacy_terminal: false,
      },
      {
        child_id: "pm-child-only",
        parent_ids: ["pm-parent-d", "pm-parent-e"],
        legacy_terminal: false,
      },
    ]);
    expect(analysis.divergences).toEqual([
      {
        child_id: "pm-child",
        scalar_parent_id: "pm-parent-c",
        dependency_parent_ids: ["pm-parent-a", "pm-parent-b"],
        legacy_terminal: false,
      },
    ]);
  });

  it("classifies terminal cardinality and divergence as historical debt", () => {
    const analysis = analyzeHierarchyIntegrity([
      item("pm-old-a", { status: "closed" }),
      item("pm-old-b", { status: "canceled" }),
      item("pm-old-child", {
        status: "closed",
        parent: "pm-old-a",
        dependencies: [dependency("pm-old-b", "parent")],
      }),
    ]);

    expect(analysis.cardinality_violations[0]?.legacy_terminal).toBe(true);
    expect(analysis.divergences[0]?.legacy_terminal).toBe(true);
  });

  it("sorts divergence rows independently of caller item order", () => {
    const analysis = analyzeHierarchyIntegrity([
      item("pm-z-child", {
        parent: "pm-parent-a",
        dependencies: [dependency("pm-parent-b", "parent")],
      }),
      item("pm-parent-b"),
      item("pm-a-child", {
        parent: "pm-parent-a",
        dependencies: [dependency("pm-parent-b", "parent")],
      }),
      item("pm-parent-a"),
    ]);

    expect(analysis.divergences.map((row) => row.child_id)).toEqual([
      "pm-a-child",
      "pm-z-child",
    ]);
  });

  it("rejects only newly introduced hierarchy defects and names exact endpoints", () => {
    const before = [
      item("pm-a", { dependencies: [dependency("pm-b", "child_of")] }),
      item("pm-b"),
    ];
    const after = [
      before[0]!,
      item("pm-b", { dependencies: [dependency("pm-a", "epic")] }),
    ];

    expect(() => assertHierarchyMutationAllowed(before, after, "PM-B")).toThrow(
      expect.objectContaining({
        code: "hierarchy_cycle_created",
        context: expect.objectContaining({
          source_id: "pm-b",
          verification_errors: ["pm-a", "pm-b"],
        }),
      }),
    );
    expect(() =>
      assertHierarchyMutationAllowed(after, after, "pm-b"),
    ).not.toThrow();
    expect(() =>
      assertHierarchyMutationAllowed(before, after, " "),
    ).not.toThrow();
  });

  it("rejects a new parent divergence before persistence but permits repair", () => {
    const before = [item("pm-a"), item("pm-b"), item("pm-child")];
    const divergent = [
      before[0]!,
      before[1]!,
      item("pm-child", {
        parent: "pm-a",
        dependencies: [dependency("pm-b", "parent")],
      }),
    ];

    expect(() =>
      assertHierarchyMutationAllowed(before, divergent, "pm-child"),
    ).toThrow(
      expect.objectContaining({
        code: "hierarchy_parent_divergence_created",
        context: expect.objectContaining({
          target_id: "pm-child",
          verification_errors: ["pm-a", "pm-b"],
        }),
      }),
    );
    expect(() =>
      assertHierarchyMutationAllowed(divergent, before, "pm-child"),
    ).not.toThrow();
  });

  it("permits monotonic repair that leaves a smaller pre-existing defect", () => {
    const cyclic = [
      item("pm-a", { dependencies: [dependency("pm-b", "parent")] }),
      item("pm-b", { dependencies: [dependency("pm-c", "parent")] }),
      item("pm-c", { dependencies: [dependency("pm-a", "parent")] }),
    ];
    const smallerCycle = [
      cyclic[0]!,
      item("pm-b", { dependencies: [dependency("pm-a", "parent")] }),
      item("pm-c"),
    ];
    expect(() =>
      assertHierarchyMutationAllowed(cyclic, smallerCycle, "pm-b"),
    ).not.toThrow();

    const overCardinality = [
      item("pm-a"),
      item("pm-b"),
      item("pm-c"),
      item("pm-child", {
        dependencies: [
          dependency("pm-a", "parent"),
          dependency("pm-b", "parent"),
          dependency("pm-c", "parent"),
        ],
      }),
    ];
    const fewerParents = [
      ...overCardinality.slice(0, 3),
      item("pm-child", {
        dependencies: [
          dependency("pm-a", "parent"),
          dependency("pm-b", "parent"),
        ],
      }),
    ];
    expect(() =>
      assertHierarchyMutationAllowed(
        overCardinality,
        fewerParents,
        "pm-child",
      ),
    ).not.toThrow();
  });

  it("uses extension hierarchy semantics and formats exact stored rows", () => {
    const registry = createRelationshipKindRegistry();
    registry.register({
      kind: "contains",
      direction: "directed",
      ordering: false,
      hierarchy: true,
      outgoing: "many",
      incoming: "one",
      lifecycle: "persistent",
      compatibilityVersion: 1,
      allowSelf: false,
    });
    const analysis = analyzeHierarchyIntegrity(
      [
        item("pm-parent", {
          dependencies: [dependency("pm-child", "contains")],
        }),
        item("pm-child"),
      ],
      undefined,
      registry,
    );

    expect(analysis.relations[0]).toMatchObject({
      parent_id: "pm-parent",
      child_id: "pm-child",
      kind: "contains",
    });
    expect(formatHierarchyRelation(analysis.relations[0]!)).toBe(
      "pm-parent -> pm-child (contains dependency on pm-parent)",
    );
    expect(
      formatHierarchyRelation(
        analyzeHierarchyIntegrity([
          item("pm-parent"),
          item("pm-scalar-child", { parent: "pm-parent" }),
        ]).relations[0]!,
      ),
    ).toBe("pm-parent -> pm-scalar-child (scalar parent on pm-scalar-child)");
    expect(registry.require("contains").hierarchyDirection).toBe(
      "source_parent",
    );
  });

  it("ignores malformed, unknown, missing-target, and non-hierarchy rows", () => {
    const malformed = item("pm-a", {
      dependencies: [
        dependency("pm-missing", "child"),
        dependency("pm-b", "related"),
        { ...dependency("pm-b", "unknown") },
        null as unknown as Dependency,
      ],
    });
    const analysis = analyzeHierarchyIntegrity([
      malformed,
      item("pm-b"),
      { ...item("pm-empty"), id: " " },
    ]);

    expect(analysis.relations).toEqual([]);
  });
});
