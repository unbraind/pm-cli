import { describe, expect, it } from "vitest";

import { assembleWorkspaceRelationshipGraph } from "../../../../src/sdk/graph/assembly";
import { auditWorkspaceRelationshipGraph } from "../../../../src/sdk/graph/governance";

describe("relationship graph structural governance", () => {
  it("profiles cut structure and typed reachability to outcome milestones", () => {
    const assembly = assembleWorkspaceRelationshipGraph([
      {
        id: "pm-outcome",
        title: "Outcome milestone: dependable delivery",
        status: "closed",
        type: "Milestone",
      },
      {
        id: "pm-epic",
        title: "Delivery epic",
        status: "open",
        type: "Epic",
        parent: "pm-outcome",
      },
      {
        id: "pm-task",
        title: "Delivery task",
        status: "in_progress",
        type: "Task",
        parent: "pm-epic",
      },
      {
        id: "pm-done",
        title: "Delivered task",
        status: "closed",
        type: "Task",
        parent: "pm-task",
      },
      {
        id: "pm-unrelated",
        title: "Historical orphan",
        status: "closed",
        type: "Task",
      },
    ] as never);

    const profile = auditWorkspaceRelationshipGraph(assembly).profile;

    expect(profile).toMatchObject({
      articulation_points: 2,
      bridge_edges: 3,
      outcome_nodes: 1,
      active_outcome_reachable_nodes: 2,
      active_outcome_unreachable_nodes: 0,
      active_outcome_reachability_basis_points: 10_000,
      terminal_nodes: 2,
      terminal_outcome_reachable_nodes: 1,
      terminal_outcome_unreachable_nodes: 1,
      terminal_outcome_reachability_basis_points: 5_000,
      outcome_reachable_nodes: 3,
      outcome_unreachable_nodes: 1,
      outcome_reachability_basis_points: 7_500,
      finding_subjects_by_code: expect.objectContaining({
        duplicate_dependency_row: 0,
        legacy_duplicate_edge: 0,
        missing_reference_terminal: 0,
      }),
    });
  });

  it("excludes active and terminal outcome milestones from reachability populations", () => {
    const assembly = assembleWorkspaceRelationshipGraph([
      {
        id: "pm-active-outcome",
        title: "Outcome milestone: active objective",
        status: "open",
        type: "Milestone",
      },
      {
        id: "pm-active-work",
        title: "Active outcome work",
        status: "open",
        type: "Task",
        parent: "pm-active-outcome",
      },
      {
        id: "pm-terminal-outcome",
        title: "Outcome milestone: delivered objective",
        status: "closed",
        type: "Milestone",
      },
      {
        id: "pm-terminal-work",
        title: "Delivered outcome work",
        status: "closed",
        type: "Task",
        parent: "pm-terminal-outcome",
      },
    ] as never);

    expect(auditWorkspaceRelationshipGraph(assembly).profile).toMatchObject({
      outcome_reachability_basis: {
        source_to_target:
          "discovered_from,implements,incident_from,parent,recurs_from,verifies",
        target_to_source: "child",
        both: "supersedes",
      },
      outcome_nodes: 2,
      active_outcome_reachable_nodes: 1,
      active_outcome_unreachable_nodes: 0,
      terminal_nodes: 1,
      terminal_outcome_reachable_nodes: 1,
      terminal_outcome_unreachable_nodes: 0,
      outcome_reachable_nodes: 2,
      outcome_unreachable_nodes: 0,
      outcome_reachability_basis_points: 10_000,
    });
  });

  it("uses every declared semantic outcome direction while preserving a disconnected negative control", () => {
    const assembly = assembleWorkspaceRelationshipGraph([
      {
        id: "pm-outcome",
        title: "Outcome milestone: semantic lineage",
        status: "open",
        type: "Milestone",
        dependencies: [{ id: "pm-child-carried", kind: "child" }],
      },
      {
        id: "pm-living",
        title: "Living replacement",
        status: "open",
        type: "Feature",
        dependencies: [
          { id: "pm-outcome", kind: "implements" },
          { id: "pm-archived", kind: "supersedes" },
        ],
      },
      {
        id: "pm-archived",
        title: "Archived predecessor",
        status: "canceled",
        type: "Feature",
      },
      {
        id: "pm-proof",
        title: "Verification evidence",
        status: "closed",
        type: "Task",
        dependencies: [{ id: "pm-living", kind: "verifies" }],
      },
      {
        id: "pm-disconnected",
        title: "Genuinely disconnected work",
        status: "closed",
        type: "Task",
      },
      {
        id: "pm-child-carried",
        title: "Inverse hierarchy lineage",
        status: "closed",
        type: "Task",
      },
    ] as never);
    expect(auditWorkspaceRelationshipGraph(assembly).profile).toMatchObject({
      active_outcome_reachable_nodes: 1,
      terminal_outcome_reachable_nodes: 3,
      terminal_outcome_unreachable_nodes: 1,
      outcome_reachable_nodes: 4,
      outcome_unreachable_nodes: 1,
      outcome_reachability_basis_points: 8_000,
    });
  });

  it("requires typed hierarchy or implements paths instead of arbitrary related edges", () => {
    const assembly = assembleWorkspaceRelationshipGraph([
      {
        id: "pm-outcome",
        title: "Outcome milestone: contextual planning",
        status: "closed",
        type: "Milestone",
      },
      {
        id: "pm-related",
        title: "Merely associated work",
        status: "open",
        type: "Task",
        dependencies: [{ id: "pm-outcome", kind: "related" }],
      },
      {
        id: "pm-implements",
        title: "Outcome implementation",
        status: "open",
        type: "Task",
        dependencies: [{ id: "pm-outcome", kind: "implements" }],
      },
    ] as never);

    expect(auditWorkspaceRelationshipGraph(assembly).profile).toMatchObject({
      active_outcome_reachable_nodes: 1,
      active_outcome_unreachable_nodes: 1,
      active_outcome_reachability_basis_points: 5_000,
      terminal_outcome_reachability_basis_points: 0,
      outcome_reachable_nodes: 1,
      outcome_unreachable_nodes: 1,
      outcome_reachability_basis_points: 5_000,
    });
  });

  it("deduplicates nodes reached through both hierarchy and implementation paths", () => {
    const assembly = assembleWorkspaceRelationshipGraph([
      {
        id: "pm-outcome",
        title: "Outcome milestone: convergent context",
        status: "closed",
        type: "Milestone",
      },
      {
        id: "pm-epic",
        title: "Context epic",
        status: "open",
        type: "Epic",
        parent: "pm-outcome",
      },
      {
        id: "pm-task",
        title: "Context task",
        status: "open",
        type: "Task",
        parent: "pm-epic",
        dependencies: [{ id: "pm-outcome", kind: "implements" }],
      },
    ] as never);

    expect(auditWorkspaceRelationshipGraph(assembly).profile).toMatchObject({
      active_outcome_reachable_nodes: 2,
      active_outcome_unreachable_nodes: 0,
      active_outcome_reachability_basis_points: 10_000,
      terminal_outcome_reachability_basis_points: 0,
      outcome_reachable_nodes: 2,
      outcome_unreachable_nodes: 0,
      outcome_reachability_basis_points: 10_000,
    });
  });
});
