import { describe, expect, it } from "vitest";
import {
  collectNewOrderingCycleWarnings,
  mutationAdvisoryTestOnly,
} from "../../../../src/sdk/graph/mutation-advisory.js";
import { createRelationshipKindRegistry } from "../../../../src/sdk/relationships.js";
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

  it("builds the ordering digraph directly from item rows with canonical ids", () => {
    const registry = createRelationshipKindRegistry();
    registry.register({
      kind: "sequence",
      direction: "directed",
      ordering: true,
      hierarchy: false,
      outgoing: "many",
      incoming: "many",
      lifecycle: "persistent",
      compatibilityVersion: 1,
      allowSelf: true,
    });
    const items: ItemMetadata[] = [
      {
        ...item("pm-A", [
          blockedBy("PM-B"),
          { ...blockedBy("pm-ghost") },
          { ...blockedBy("no-active-blocker") },
          { id: "pm-b", kind: "unknown-kind" } as unknown as Dependency,
          null as unknown as Dependency,
          { id: "pm-b" } as unknown as Dependency,
          { id: "pm-b", kind: "sequence" } as unknown as Dependency,
        ]),
        blocked_by: "pm-b",
      },
      item("pm-b"),
      { ...item("pm-loner"), id: "   " },
      item("pm-isolated"),
    ];
    const digraph = mutationAdvisoryTestOnly.buildOrderingDigraph(
      items,
      registry,
    );
    // blocked_by orients target-before-source; dangling, sentinel, unknown-kind,
    // associative-default, and malformed rows contribute nothing.
    expect(digraph.successors.get("pm-b")).toEqual(["pm-A", "pm-A"]);
    expect(digraph.successors.get("pm-A")).toEqual(["pm-b"]);
    expect(digraph.predecessors.get("pm-A")).toEqual(["pm-b", "pm-b"]);
    expect(digraph.canonicalIds.get("pm-a")).toBe("pm-A");
    expect(digraph.successors.has("pm-isolated")).toBe(false);

    const component = mutationAdvisoryTestOnly.collectWeakComponent(
      digraph,
      "pm-A",
    );
    expect([...component].sort()).toEqual(["pm-A", "pm-b"]);
    const induced = mutationAdvisoryTestOnly.induceSuccessors(
      digraph,
      new Set(["pm-A"]),
    );
    expect(induced.size).toBe(0);
  });

  it("handles self cycles and defensive non-cycle components", () => {
    const selfAdjacency = new Map([["pm-a", ["pm-a"]]]);
    expect(
      mutationAdvisoryTestOnly.findCyclePath(selfAdjacency, ["pm-a"], "pm-a"),
    ).toEqual(["pm-a", "pm-a"]);

    const chainAdjacency = new Map([
      ["pm-a", ["pm-b"]],
      ["pm-b", ["pm-c"]],
    ]);
    expect(
      mutationAdvisoryTestOnly.findCyclePath(
        chainAdjacency,
        ["pm-a", "pm-b", "pm-c"],
        "pm-a",
      ),
    ).toEqual(["pm-a", "pm-b", "pm-c", "pm-a"]);
    expect(
      mutationAdvisoryTestOnly.findCyclePath(
        new Map([
          ["pm-a", ["pm-outside", "pm-b"]],
          ["pm-b", ["pm-a"]],
        ]),
        ["pm-a", "pm-b"],
        "pm-a",
      ),
    ).toEqual(["pm-a", "pm-b", "pm-a"]);
    expect(
      mutationAdvisoryTestOnly.findCyclePath(
        chainAdjacency,
        ["pm-a", "pm-b", "pm-c"],
        "pm-outside",
      ),
    ).toEqual(["pm-a", "pm-b", "pm-c", "pm-a"]);
    expect(
      mutationAdvisoryTestOnly.findCyclePath(
        chainAdjacency,
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
    // A neighbor outside the member set is skipped even when adjacent.
    const escapingAdjacency = new Map([
      ["pm-a", ["pm-b"]],
      ["pm-b", ["pm-x"]],
    ]);
    expect(
      mutationAdvisoryTestOnly.findPathBackToStart(
        escapingAdjacency,
        new Set(["pm-a", "pm-b"]),
        "pm-a",
        "pm-b",
      ),
    ).toBeUndefined();
  });

  it("scopes detection to the changed item and tolerates unknown ids", () => {
    // The changed item is absent from both snapshots: no warnings, no throw.
    expect(
      collectNewOrderingCycleWarnings(
        [item("pm-a")],
        [item("pm-a")],
        "pm-nowhere",
      ),
    ).toEqual([]);
    // A new cycle in a distant component never warns for the changed item.
    const before = [
      item("pm-a", [blockedBy("pm-b")]),
      item("pm-b"),
      item("pm-far"),
      item("pm-away"),
    ];
    const after = [
      before[0]!,
      before[1]!,
      item("pm-far", [blockedBy("pm-away")]),
      item("pm-away", [blockedBy("pm-far")]),
    ];
    expect(collectNewOrderingCycleWarnings(before, after, "pm-a")).toEqual([]);
    // Case-insensitive changed-item resolution warns with canonical spelling.
    expect(
      collectNewOrderingCycleWarnings(before, after, "PM-FAR"),
    ).toEqual([
      "ordering_cycle_created:pm-far -> pm-away -> pm-far:items_will_not_be_ready:run_pm_graph_audit",
    ]);
  });
});
