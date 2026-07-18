import { describe, expect, it } from "vitest";
import {
  collectNewOrderingCycleWarnings,
  mutationAdvisoryTestOnly,
} from "../../../../src/sdk/graph/mutation-advisory.js";
import {
  RelationshipGraph,
  createRelationshipKindRegistry,
} from "../../../../src/sdk/relationships.js";
import type { Dependency, ItemMetadata } from "../../../../src/types/index.js";

function item(id: string, dependencies?: Dependency[]): ItemMetadata {
  return {
    id,
    title: id,
    description: "",
    type: "Task",
    status: "open",
    priority: 2,
    tags: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    dependencies,
  };
}

function blockedBy(id: string): Dependency {
  return {
    id,
    kind: "blocked_by",
    author: "test",
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("ordering-cycle mutation advisories", () => {
  it("reports a stable path for a newly introduced cycle", () => {
    const before = [item("pm-a", [blockedBy("pm-b")]), item("pm-b")];
    const after = [
      before[0]!,
      item("pm-b", [blockedBy("pm-a")]),
    ];

    expect(collectNewOrderingCycleWarnings(before, after, "pm-b")).toEqual([
      "ordering_cycle_created:pm-b -> pm-a -> pm-b:items_will_not_be_ready:run_pm_graph_audit",
    ]);
  });

  it("does not repeat legacy cycles or cycles unrelated to the changed item", () => {
    const cycle = [
      item("pm-a", [blockedBy("pm-b")]),
      item("pm-b", [blockedBy("pm-a")]),
      item("pm-c"),
    ];
    expect(collectNewOrderingCycleWarnings(cycle, cycle, "pm-b")).toEqual([]);
    expect(
      collectNewOrderingCycleWarnings(
        [item("pm-a"), item("pm-b"), item("pm-c")],
        cycle,
        "pm-c",
      ),
    ).toEqual([]);
  });

  it("handles self cycles and defensive non-cycle components", () => {
    const registry = createRelationshipKindRegistry();
    registry.register({
      kind: "sequence",
      direction: "directed",
      ordering: true,
      precedence: "source_before_target",
      hierarchy: false,
      outgoing: "many",
      incoming: "many",
      lifecycle: "persistent",
      compatibilityVersion: 1,
      allowSelf: true,
    });
    registry.register({
      kind: "sequence-default",
      direction: "directed",
      ordering: true,
      hierarchy: false,
      outgoing: "many",
      incoming: "many",
      lifecycle: "persistent",
      compatibilityVersion: 1,
      allowSelf: false,
    });
    const selfGraph = new RelationshipGraph(
      ["pm-a"],
      [{ source: "pm-a", target: "pm-a", kind: "sequence" }],
      registry,
    );
    expect(
      mutationAdvisoryTestOnly.findCyclePath(selfGraph, ["pm-a"], "pm-a"),
    ).toEqual(["pm-a", "pm-a"]);

    const defensiveGraph = new RelationshipGraph(
      ["pm-a", "pm-b", "pm-c"],
      [
        { source: "pm-a", target: "pm-b", kind: "sequence" },
        { source: "pm-b", target: "pm-c", kind: "sequence" },
      ],
      registry,
    );
    expect(
      mutationAdvisoryTestOnly.findCyclePath(
        defensiveGraph,
        ["pm-a", "pm-b", "pm-c"],
        "pm-a",
      ),
    ).toEqual(["pm-a", "pm-b", "pm-c", "pm-a"]);

    const branchingGraph = new RelationshipGraph(
      ["pm-a", "pm-b", "pm-c", "pm-d"],
      [
        { source: "pm-a", target: "pm-d", kind: "sequence" },
        { source: "pm-a", target: "pm-d", kind: "sequence-default" },
        { source: "pm-c", target: "pm-d", kind: "related" },
        { source: "pm-a", target: "pm-c", kind: "sequence" },
        { source: "pm-a", target: "pm-b", kind: "sequence" },
        { source: "pm-b", target: "pm-b", kind: "sequence" },
        { source: "pm-b", target: "pm-c", kind: "sequence" },
        { source: "pm-b", target: "pm-d", kind: "sequence" },
      ],
      registry,
    );
    expect(
      mutationAdvisoryTestOnly.buildOrderingAdjacency(branchingGraph).get("pm-a"),
    ).toEqual(["pm-b", "pm-c", "pm-d", "pm-d"]);
    expect(
      mutationAdvisoryTestOnly.findCyclePath(
        branchingGraph,
        ["pm-a", "pm-b", "pm-c"],
        "pm-outside",
      ),
    ).toEqual(["pm-a", "pm-b", "pm-c", "pm-a"]);
    expect(
      mutationAdvisoryTestOnly.findCyclePath(
        branchingGraph,
        ["pm-missing"],
        "pm-missing",
      ),
    ).toEqual(["pm-missing", "pm-missing"]);
    expect(
      mutationAdvisoryTestOnly.findPathBackToStart(
        new Map(),
        new Set(["pm-a", "pm-missing"]),
        "pm-a",
        "pm-missing",
      ),
    ).toBeUndefined();
  });
});
