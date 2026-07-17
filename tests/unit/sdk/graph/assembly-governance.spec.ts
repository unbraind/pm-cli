import { describe, expect, it } from "vitest";
import {
  assembleWorkspaceRelationshipGraph,
  collectDanglingDependencyReferences,
  collectMissingDependencyTargetIds,
} from "../../../../src/sdk/graph/assembly.js";
import { auditWorkspaceRelationshipGraph } from "../../../../src/sdk/graph/governance.js";
import {
  RelationshipGraph,
  RelationshipKindRegistry,
} from "../../../../src/sdk/relationships.js";

describe("workspace relationship graph assembly", () => {
  it("normalizes references, preserves missing endpoints, and partitions historical debt", () => {
    const items = [
      {
        id: "pm-root",
        title: "Root",
        status: "open",
        parent: " PM-PARENT ",
        blocked_by: "no-active-blocker",
        dependencies: [
          { id: "PM-PARENT", kind: "related" },
          { id: "pm-missing", kind: "blocked_by" },
          null,
          { id: "  ", kind: "related" },
          { id: "pm-other" },
        ],
      },
      { id: "pm-parent", title: "Parent", status: "open" },
      { id: "pm-other", title: "Other", status: "open" },
      {
        id: "pm-history",
        title: "History",
        status: "closed",
        dependencies: [{ id: "pm-gone", kind: "related" }],
      },
    ] as never;

    const assembly = assembleWorkspaceRelationshipGraph(items);
    expect(assembly.graph.hasNode("pm-missing")).toBe(true);
    expect(assembly.graph.hasNode("pm-gone")).toBe(true);
    expect(assembly.graph.hasNode("no-active-blocker")).toBe(false);
    expect(assembly.graph.edges()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "pm-root", target: "pm-parent", kind: "parent" }),
        expect.objectContaining({ source: "pm-root", target: "pm-missing", kind: "blocked_by" }),
        expect.objectContaining({ source: "pm-root", target: "pm-other", kind: "related" }),
      ]),
    );
    expect(assembly.dangling.active.map((row) => row.target_id)).toEqual([
      "no-active-blocker",
      "pm-missing",
    ]);
    expect(assembly.dangling.legacy_terminal.map((row) => row.target_id)).toEqual([
      "pm-gone",
    ]);
    expect(assembly.details.find((row) => row.id === "pm-missing")).toEqual({
      id: "pm-missing",
      title: "[missing] pm-missing",
      status: "missing",
    });
  });

  it("deduplicates missing ids case-insensitively and supports custom terminal predicates", () => {
    const dangling = collectDanglingDependencyReferences(
      [
        {
          id: "pm-a",
          status: "archived",
          parent: "MISSING",
          dependencies: [{ id: "missing", kind: "related" }, 7],
        },
        { id: "pm-b", status: "open", blocked_by: "none" },
      ] as never,
      (status) => status === "archived",
    );
    expect(dangling.active).toEqual([]);
    expect(dangling.legacy_terminal).toHaveLength(2);
    expect(collectMissingDependencyTargetIds(dangling).map((id) => id.toLowerCase())).toEqual([
      "missing",
    ]);
  });
});
describe("relationship graph governance", () => {
  const assembly = assembleWorkspaceRelationshipGraph([
    {
      id: "pm-a",
      title: "A",
      status: "open",
      dependencies: [{ id: "pm-b", kind: "blocked_by" }],
    },
    {
      id: "pm-b",
      title: "B",
      status: "open",
      dependencies: [{ id: "pm-a", kind: "blocked_by" }],
    },
    {
      id: "pm-active-missing",
      title: "Active missing",
      status: "open",
      dependencies: [
        { id: "pm-missing", kind: "blocked_by" },
        { id: "no-active-blocker", kind: "related" },
      ],
    },
    {
      id: "pm-history",
      title: "History",
      status: "closed",
      dependencies: [{ id: "pm-gone", kind: "related" }],
    },
    { id: "pm-stale", title: "Stale", status: "blocked" },
    {
      id: "pm-sparse",
      title: "Sparse",
      status: "open",
      dependencies: [{ id: "pm-a", kind: "related" }],
    },
    { id: "pm-exempt", title: "Exempt", status: "open" },
  ] as never);

  it("reports integrity, ordering, lifecycle, and coverage findings with bounded evidence", () => {
    const report = auditWorkspaceRelationshipGraph(assembly, {
      exemptIsolates: ["PM-EXEMPT"],
      maxSampleSize: 1,
    });
    expect(report.findings.map((finding) => finding.code)).toEqual([
      "missing_reference_active",
      "ordering_cycle",
      "isolated_active_node",
      "stale_lifecycle_block",
      "legacy_no_blocker_sentinel",
      "missing_reference_terminal",
      "sparse_active_node",
    ]);
    expect(report.findings.find((finding) => finding.code === "ordering_cycle")).toMatchObject({
      severity: "error",
      count: 2,
      sample: ["pm-a"],
      sample_truncated: true,
    });
    expect(report.findings.find((finding) => finding.code === "stale_lifecycle_block")?.sample).toEqual([
      "pm-stale",
    ]);
    expect(report.profile).toMatchObject({
      nodes: 9,
      active_nodes: 6,
      missing_nodes: 2,
      isolated_active_nodes: 2,
      edges_by_kind: {
        blocked_by: 3,
        related: 2,
      },
    });
  });

  it("supports custom lifecycle policies, rejects invalid bounds, and honors cancellation", () => {
    const custom = auditWorkspaceRelationshipGraph(assembly, {
      isTerminal: (status) => status === "closed" || status === "blocked",
      isBlocked: () => false,
      exemptIsolates: ["pm-exempt"],
    });
    expect(custom.findings.some((finding) => finding.code === "stale_lifecycle_block")).toBe(false);
    expect(() => auditWorkspaceRelationshipGraph(assembly, { maxSampleSize: 0 })).toThrow(
      /Invalid audit sample bound/,
    );
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      auditWorkspaceRelationshipGraph(assembly, { signal: controller.signal }),
    ).toThrow();
  });

  it("orders multiple cycles and distinguishes missing, terminal, and open predecessors", () => {
    const multiCycle = assembleWorkspaceRelationshipGraph([
      { id: "pm-a", title: "A", status: "open", dependencies: [{ id: "pm-b", kind: "blocked_by" }] },
      { id: "pm-b", title: "B", status: "open", dependencies: [{ id: "pm-a", kind: "blocked_by" }] },
      { id: "pm-c", title: "C", status: "open", dependencies: [{ id: "pm-d", kind: "blocked_by" }] },
      { id: "pm-d", title: "D", status: "open", dependencies: [{ id: "pm-c", kind: "blocked_by" }] },
      { id: "pm-open", title: "Open", status: "open" },
      { id: "pm-done", title: "Done", status: "closed" },
      { id: "pm-backed", title: "Backed", status: "blocked", dependencies: [{ id: "pm-open", kind: "blocked_by" }] },
      { id: "pm-stale", title: "Stale", status: "blocked", dependencies: [{ id: "pm-done", kind: "blocked_by" }] },
    ] as never);
    const report = auditWorkspaceRelationshipGraph(multiCycle);
    expect(
      report.findings
        .filter((finding) => finding.code === "ordering_cycle")
        .map((finding) => finding.sample),
    ).toEqual([["pm-a", "pm-b"], ["pm-c", "pm-d"]]);
    expect(
      report.findings.find((finding) => finding.code === "stale_lifecycle_block")?.sample,
    ).toEqual(["pm-stale"]);

    const withoutPredecessorDetails = {
      ...multiCycle,
      details: multiCycle.details.filter((detail) => detail.id !== "pm-open"),
    };
    expect(
      auditWorkspaceRelationshipGraph(withoutPredecessorDetails).findings
        .find((finding) => finding.code === "stale_lifecycle_block")?.sample,
    ).toEqual(["pm-stale"]);
  });

  it("handles an empty workspace without findings", () => {
    expect(
      auditWorkspaceRelationshipGraph(assembleWorkspaceRelationshipGraph([])),
    ).toEqual({
      findings: [],
      profile: {
        nodes: 0,
        edges: 0,
        edges_by_kind: {},
        active_nodes: 0,
        missing_nodes: 0,
        isolated_active_nodes: 0,
        degree_leq_one_active_nodes: 0,
      },
    });
  });

  it("orients default-precedence ordering kinds and sorts shared successors", () => {
    const registry = new RelationshipKindRegistry();
    registry.register({
      kind: "proceeds",
      direction: "directed",
      ordering: true,
      hierarchy: false,
      outgoing: "many",
      incoming: "many",
      lifecycle: "persistent",
      compatibilityVersion: 1,
      allowSelf: false,
    });
    const base = assembleWorkspaceRelationshipGraph([
      { id: "pm-a", title: "A", status: "open" },
      { id: "pm-b", title: "B", status: "open" },
      { id: "pm-c", title: "C", status: "open" },
    ] as never);
    const report = auditWorkspaceRelationshipGraph({
      ...base,
      graph: new RelationshipGraph(
        ["pm-a", "pm-b", "pm-c"],
        [
          { source: "pm-a", target: "pm-c", kind: "proceeds" },
          { source: "pm-a", target: "pm-b", kind: "proceeds" },
          { source: "pm-b", target: "pm-c", kind: "proceeds" },
        ],
        registry,
      ),
    });
    expect(report.findings.some((finding) => finding.code === "ordering_cycle")).toBe(false);
    expect(report.profile.edges_by_kind).toEqual({ proceeds: 3 });
  });
});
