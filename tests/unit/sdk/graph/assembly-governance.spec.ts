import { describe, expect, it } from "vitest";
import {
  assembleWorkspaceRelationshipGraph,
  collectDanglingDependencyReferences,
  collectDuplicateDependencyRows,
  collectMissingDependencyTargetIds,
} from "../../../../src/sdk/graph/assembly.js";
import {
  auditWorkspaceRelationshipGraph,
  diffRelationshipAuditSnapshots,
} from "../../../../src/sdk/graph/governance.js";
import { planRelationshipRemediation } from "../../../../src/sdk/graph/remediation.js";
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
        expect.objectContaining({
          source: "pm-root",
          target: "pm-parent",
          kind: "parent",
        }),
        expect.objectContaining({
          source: "pm-root",
          target: "pm-missing",
          kind: "blocked_by",
        }),
        expect.objectContaining({
          source: "pm-root",
          target: "pm-other",
          kind: "related",
        }),
      ]),
    );
    expect(assembly.dangling.active.map((row) => row.target_id)).toEqual([
      "no-active-blocker",
      "pm-missing",
    ]);
    expect(
      assembly.dangling.legacy_terminal.map((row) => row.target_id),
    ).toEqual(["pm-gone"]);
    expect(assembly.details.find((row) => row.id === "pm-missing")).toEqual({
      id: "pm-missing",
      title: "[missing] pm-missing",
      status: "missing",
    });

    const padded = assembleWorkspaceRelationshipGraph([
      {
        id: " pm-padded ",
        title: "Padded",
        status: "open",
        dependencies: [{ id: "pm-target", kind: "related" }],
      },
      { id: " pm-target ", title: "Target", status: "open" },
    ] as never);
    expect(padded.graph.nodes()).toEqual(["pm-padded", "pm-target"]);
    expect(padded.details.map((detail) => detail.id)).toEqual([
      "pm-padded",
      "pm-target",
    ]);
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
    expect(
      collectMissingDependencyTargetIds(dangling).map((id) => id.toLowerCase()),
    ).toEqual(["missing"]);
  });

  it("preserves custom registry edges and ignores malformed legacy item ids", () => {
    const registry = new RelationshipKindRegistry();
    registry.register({
      kind: "commits_to",
      direction: "directed",
      ordering: true,
      hierarchy: false,
      outgoing: "many",
      incoming: "many",
      lifecycle: "persistent",
      compatibilityVersion: 1,
      allowSelf: true,
    });
    const items = [
      {
        id: "commit-a",
        title: "Commit A",
        status: "open",
        dependencies: [{ id: "commit-b", kind: "commits_to" }],
      },
      { id: "commit-b", title: "Commit B", status: "open" },
      null,
      { title: "Missing id", status: "open" },
      { id: 42, title: "Numeric id", status: "open" },
      { id: "  ", title: "Empty id", status: "open" },
    ] as never;

    const assembly = assembleWorkspaceRelationshipGraph(
      items,
      undefined,
      registry,
    );
    expect(assembly.graph.edges()).toEqual([
      { source: "commit-a", target: "commit-b", kind: "commits_to" },
    ]);
    expect(assembly.details.map((detail) => detail.id)).toEqual([
      "commit-a",
      "commit-b",
    ]);
    expect(collectDanglingDependencyReferences(items)).toEqual({
      active: [],
      legacy_terminal: [],
      no_active_blocker_sentinels: [],
    });
  });

  it("canonicalizes case variants of the same missing endpoint", () => {
    const assembly = assembleWorkspaceRelationshipGraph([
      {
        id: "pm-a",
        title: "A",
        status: "open",
        dependencies: [{ id: "PM-MISSING", kind: "related" }],
      },
      {
        id: "pm-b",
        title: "B",
        status: "open",
        dependencies: [{ id: "pm-missing", kind: "related" }],
      },
    ] as never);

    expect(assembly.graph.edges()).toHaveLength(2);
    expect(new Set(assembly.graph.edges().map((edge) => edge.target))).toEqual(
      new Set(["PM-MISSING"]),
    );
    expect(assembly.graph.nodes()).toContain("PM-MISSING");
    expect(assembly.missingIdSet).toEqual(new Set(["pm-missing"]));
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
    expect(
      report.findings.find((finding) => finding.code === "ordering_cycle"),
    ).toMatchObject({
      severity: "error",
      count: 2,
      sample: ["pm-a"],
      sample_truncated: true,
    });
    expect(
      report.findings.find(
        (finding) => finding.code === "stale_lifecycle_block",
      )?.sample,
    ).toEqual(["pm-stale"]);
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
    const customAssembly = assembleWorkspaceRelationshipGraph([
      ...assembly.details
        .filter((detail) => detail.status !== "missing")
        .map((detail) => ({ ...detail })),
      {
        id: "pm-custom-terminal",
        title: "Custom terminal",
        status: "blocked",
        dependencies: [{ id: "pm-custom-missing", kind: "related" }],
      },
    ] as never);
    const custom = auditWorkspaceRelationshipGraph(customAssembly, {
      isTerminal: (status) => status === "closed" || status === "blocked",
      isBlocked: () => false,
      exemptIsolates: ["pm-exempt"],
    });
    expect(
      custom.findings.some(
        (finding) => finding.code === "stale_lifecycle_block",
      ),
    ).toBe(false);
    expect(
      custom.findings.find(
        (finding) => finding.code === "missing_reference_terminal",
      )?.sample,
    ).toContain("pm-custom-terminal -> pm-custom-missing (related)");
    expect(
      custom.findings.find(
        (finding) => finding.code === "missing_reference_active",
      )?.sample ?? [],
    ).not.toContain("pm-custom-terminal -> pm-custom-missing (related)");
    expect(() =>
      auditWorkspaceRelationshipGraph(assembly, { maxSampleSize: 0 }),
    ).toThrow(/Invalid audit sample bound/);
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      auditWorkspaceRelationshipGraph(assembly, { signal: controller.signal }),
    ).toThrow();
  });

  it("orders multiple cycles and distinguishes missing, terminal, and open predecessors", () => {
    const multiCycle = assembleWorkspaceRelationshipGraph([
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
        id: "pm-c",
        title: "C",
        status: "open",
        dependencies: [{ id: "pm-d", kind: "blocked_by" }],
      },
      {
        id: "pm-d",
        title: "D",
        status: "open",
        dependencies: [{ id: "pm-c", kind: "blocked_by" }],
      },
      { id: "pm-open", title: "Open", status: "open" },
      { id: "pm-done", title: "Done", status: "closed" },
      {
        id: "pm-backed",
        title: "Backed",
        status: "blocked",
        dependencies: [{ id: "pm-open", kind: "blocked_by" }],
      },
      {
        id: "pm-stale",
        title: "Stale",
        status: "blocked",
        dependencies: [{ id: "pm-done", kind: "blocked_by" }],
      },
    ] as never);
    const report = auditWorkspaceRelationshipGraph(multiCycle);
    expect(
      report.findings
        .filter((finding) => finding.code === "ordering_cycle")
        .map((finding) => finding.sample),
    ).toEqual([
      ["pm-a", "pm-b"],
      ["pm-c", "pm-d"],
    ]);
    expect(
      report.findings.find(
        (finding) => finding.code === "stale_lifecycle_block",
      )?.sample,
    ).toEqual(["pm-stale"]);

    const withoutPredecessorDetails = {
      ...multiCycle,
      details: multiCycle.details.filter((detail) => detail.id !== "pm-open"),
    };
    expect(
      auditWorkspaceRelationshipGraph(withoutPredecessorDetails).findings.find(
        (finding) => finding.code === "stale_lifecycle_block",
      )?.sample,
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
        coverage_by_type: {},
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
    expect(
      report.findings.some((finding) => finding.code === "ordering_cycle"),
    ).toBe(false);
    expect(report.profile.edges_by_kind).toEqual({ proceeds: 3 });
  });

  it("downgrades terminal-only ordering cycles to informational legacy findings", () => {
    const report = auditWorkspaceRelationshipGraph(
      assembleWorkspaceRelationshipGraph([
        {
          id: "pm-old-a",
          title: "Old A",
          status: "closed",
          dependencies: [{ id: "pm-old-b", kind: "blocked_by" }],
        },
        {
          id: "pm-old-b",
          title: "Old B",
          status: "canceled",
          dependencies: [{ id: "pm-old-a", kind: "blocked_by" }],
        },
        {
          id: "pm-live-a",
          title: "Live A",
          status: "open",
          dependencies: [{ id: "pm-live-b", kind: "blocked_by" }],
        },
        {
          id: "pm-live-b",
          title: "Live B",
          status: "closed",
          dependencies: [{ id: "pm-live-a", kind: "blocked_by" }],
        },
      ] as never),
    );
    // pm-live-a/pm-live-b touch one active member and stay an error; the
    // pm-old pair is exclusively terminal and downgrades to legacy info.
    expect(
      report.findings.find((finding) => finding.code === "ordering_cycle"),
    ).toMatchObject({ severity: "error", sample: ["pm-live-a", "pm-live-b"] });
    expect(
      report.findings.find(
        (finding) => finding.code === "legacy_ordering_cycle",
      ),
    ).toMatchObject({
      severity: "info",
      count: 2,
      sample: ["pm-old-a", "pm-old-b"],
    });
  });

  it("reports duplicated same-family spellings split by endpoint lifecycle", () => {
    const report = auditWorkspaceRelationshipGraph(
      assembleWorkspaceRelationshipGraph([
        {
          id: "pm-dup-a",
          title: "Dup A",
          status: "open",
          dependencies: [{ id: "pm-dup-b", kind: "blocked_by" }],
        },
        {
          id: "pm-dup-b",
          title: "Dup B",
          status: "closed",
          dependencies: [
            { id: "pm-dup-a", kind: "blocks" },
            { id: "pm-dup-c", kind: "blocks" },
          ],
        },
        {
          id: "pm-dup-c",
          title: "Dup C",
          status: "open",
          dependencies: [{ id: "pm-dup-b", kind: "blocked_by" }],
        },
        {
          id: "pm-legacy-a",
          title: "Legacy A",
          status: "closed",
          dependencies: [{ id: "pm-legacy-b", kind: "blocked_by" }],
        },
        {
          id: "pm-legacy-b",
          title: "Legacy B",
          status: "canceled",
          dependencies: [{ id: "pm-legacy-a", kind: "blocks" }],
        },
      ] as never),
    );
    // Both spellings state "pm-dup-b before pm-dup-a"; the reciprocal pair is
    // NOT an ordering cycle precisely because it collapses onto one oriented
    // relation, and only the duplicate detector can report it.
    expect(
      report.findings.some((finding) =>
        ["ordering_cycle", "legacy_ordering_cycle"].includes(finding.code),
      ),
    ).toBe(false);
    // Two groups share the semantic tail pm-dup-b, exercising deterministic
    // ordering across groups with equal tails.
    expect(
      report.findings.find((finding) => finding.code === "duplicate_edge"),
    ).toMatchObject({
      severity: "info",
      count: 2,
      sample: [
        "pm-dup-b -> pm-dup-a (blocked_by + blocks)",
        "pm-dup-b -> pm-dup-c (blocked_by + blocks)",
      ],
    });
    expect(
      report.findings.find(
        (finding) => finding.code === "legacy_duplicate_edge",
      ),
    ).toMatchObject({
      severity: "info",
      count: 1,
      sample: ["pm-legacy-b -> pm-legacy-a (blocked_by + blocks)"],
    });
  });

  it("treats members missing from trimmed assembly details as conservatively active", () => {
    const base = assembleWorkspaceRelationshipGraph([
      {
        id: "pm-trim-a",
        title: "Trim A",
        status: "closed",
        dependencies: [{ id: "pm-trim-b", kind: "blocked_by" }],
      },
      {
        id: "pm-trim-b",
        title: "Trim B",
        status: "closed",
        dependencies: [{ id: "pm-trim-a", kind: "blocks" }],
      },
    ] as never);
    const trimmed = {
      ...base,
      details: base.details.filter((detail) => detail.id !== "pm-trim-b"),
    };
    // Both stored holders are terminal, but the trimmed endpoint's lifecycle
    // is unknown, so the duplicate must stay in the actionable finding.
    expect(
      auditWorkspaceRelationshipGraph(trimmed).findings.find(
        (finding) => finding.code === "duplicate_edge",
      )?.sample,
    ).toEqual(["pm-trim-b -> pm-trim-a (blocked_by + blocks)"]);
  });

  it("keeps duplicates with an active semantic head in the active finding", () => {
    const report = auditWorkspaceRelationshipGraph(
      assembleWorkspaceRelationshipGraph([
        {
          id: "pm-head-open",
          title: "Head open",
          status: "open",
          dependencies: [{ id: "pm-tail-closed", kind: "blocks" }],
        },
        {
          id: "pm-tail-closed",
          title: "Tail closed",
          status: "closed",
          dependencies: [{ id: "pm-head-open", kind: "blocked_by" }],
        },
      ] as never),
    );
    // The oriented tail (pm-head-open) is active even though the stored
    // holder of one spelling is terminal, so the pair stays actionable.
    expect(
      report.findings.find((finding) => finding.code === "duplicate_edge")
        ?.sample,
    ).toEqual(["pm-head-open -> pm-tail-closed (blocked_by + blocks)"]);
  });

  it("reports self-cycles and ignores malformed isolate exemptions", () => {
    const registry = new RelationshipKindRegistry();
    registry.register({
      kind: "revises",
      direction: "directed",
      ordering: true,
      hierarchy: false,
      outgoing: "many",
      incoming: "many",
      lifecycle: "persistent",
      compatibilityVersion: 1,
      allowSelf: true,
    });
    const selfCycle = assembleWorkspaceRelationshipGraph(
      [
        {
          id: "pm-self",
          title: "Self",
          status: "open",
          dependencies: [{ id: "pm-self", kind: "revises" }],
        },
      ] as never,
      undefined,
      registry,
    );

    const report = auditWorkspaceRelationshipGraph(selfCycle, {
      exemptIsolates: [null, 42, "pm-self"] as never,
    });
    expect(
      report.findings.find((finding) => finding.code === "ordering_cycle"),
    ).toMatchObject({
      count: 1,
      sample: ["pm-self"],
      sample_truncated: false,
    });
  });
});

describe("duplicate dependency row integrity", () => {
  const duplicated = [
    {
      id: "pm-active",
      title: "Active",
      status: "open",
      type: "Task",
      dependencies: [
        { id: "PM-Twin", kind: "related" },
        { id: "pm-twin", kind: "related" },
        { id: "pm-twin", kind: "blocked_by" },
        { id: "  ", kind: "related" },
        null,
      ],
    },
    {
      id: "pm-done",
      title: "Done",
      status: "closed",
      dependencies: [
        { id: "pm-twin", kind: "related" },
        { id: "pm-twin", kind: "related" },
        { id: "pm-twin", kind: "related" },
      ],
    },
    { id: "pm-twin", title: "Twin", status: "open", type: "Task" },
    { id: "   ", title: "Blank", status: "open" },
  ] as never;

  it("collects raw same-identity rows case-insensitively before graph dedup", () => {
    expect(collectDuplicateDependencyRows(duplicated)).toEqual([
      {
        holder_id: "pm-active",
        target_id: "PM-Twin",
        kind: "related",
        occurrences: 2,
        holder_status: "open",
        legacy_terminal: false,
      },
      {
        holder_id: "pm-done",
        target_id: "pm-twin",
        kind: "related",
        occurrences: 3,
        holder_status: "closed",
        legacy_terminal: true,
      },
    ]);

    expect(
      collectDuplicateDependencyRows([
        {
          id: "pm-holder",
          status: "open",
          dependencies: [
            { id: "pm-z", kind: "related" },
            { id: "pm-z", kind: "related" },
            { id: "pm-a", kind: "related" },
            { id: "pm-a", kind: "related" },
            { id: "pm-a", kind: "blocked_by" },
            { id: "pm-a", kind: "blocked_by" },
          ],
        },
      ] as never),
    ).toEqual([
      expect.objectContaining({ target_id: "pm-a", kind: "blocked_by" }),
      expect.objectContaining({ target_id: "pm-a", kind: "related" }),
      expect.objectContaining({ target_id: "pm-z", kind: "related" }),
    ]);
  });

  it("reports the active and legacy duplicate-row audit families with remediation plans", () => {
    const assembly = assembleWorkspaceRelationshipGraph(duplicated);
    const report = auditWorkspaceRelationshipGraph(assembly);
    expect(
      report.findings.find(
        (finding) => finding.code === "duplicate_dependency_row",
      ),
    ).toMatchObject({
      severity: "warning",
      count: 1,
      sample: ["pm-active -> PM-Twin (related x2)"],
    });
    expect(
      report.findings.find(
        (finding) => finding.code === "legacy_duplicate_dependency_row",
      ),
    ).toMatchObject({
      severity: "info",
      count: 1,
      sample: ["pm-done -> pm-twin (related x3)"],
    });
    const plan = planRelationshipRemediation(assembly);
    expect(
      plan.steps.find((step) => step.code === "duplicate_dependency_row"),
    ).toMatchObject({ op: "remove", confidence: "high" });
    expect(
      plan.steps.find(
        (step) => step.code === "legacy_duplicate_dependency_row",
      ),
    ).toMatchObject({ op: "waive", confidence: "high" });
  });
});

describe("per-type coverage profiles", () => {
  const typedWorkspace = [
    { id: "pm-epic", title: "Epic", status: "open", type: "Epic" },
    {
      id: "pm-task",
      title: "Task",
      status: "open",
      type: "Task",
      parent: "pm-epic",
    },
    { id: "pm-note", title: "Note", status: "open" },
    { id: "pm-old", title: "Old", status: "closed", type: "Task" },
  ] as never;

  it("breaks active connectivity down by declared item type", () => {
    const report = auditWorkspaceRelationshipGraph(
      assembleWorkspaceRelationshipGraph(typedWorkspace),
    );
    expect(report.profile.coverage_by_type).toEqual({
      "(untyped)": { active: 1, isolated: 1, degree_leq_one: 1 },
      Epic: { active: 1, isolated: 0, degree_leq_one: 1 },
      Task: { active: 1, isolated: 0, degree_leq_one: 1 },
    });
  });

  it("suppresses coverage findings for isolate-exempt item types", () => {
    const assembly = assembleWorkspaceRelationshipGraph(typedWorkspace);
    const strict = auditWorkspaceRelationshipGraph(assembly);
    expect(
      strict.findings.find(
        (finding) => finding.code === "isolated_active_node",
      )?.sample,
    ).toEqual(["pm-note"]);
    const exempted = auditWorkspaceRelationshipGraph(assembly, {
      isolateExemptTypes: ["(UNTYPED)", "Task", null] as never,
    });
    expect(
      exempted.findings.find(
        (finding) => finding.code === "isolated_active_node",
      ),
    ).toBeUndefined();
    expect(
      exempted.findings.find(
        (finding) => finding.code === "sparse_active_node",
      )?.sample,
    ).toEqual(["pm-epic"]);
    // The profile keeps counting exempted types; only findings are suppressed.
    expect(exempted.profile.isolated_active_nodes).toBe(1);
  });
});

describe("diffRelationshipAuditSnapshots", () => {
  it("returns signed non-zero deltas across findings and profile", () => {
    const baseline = {
      saved_at: "2026-07-19T00:00:00.000Z",
      fingerprint: "aaa",
      affected_subjects_by_code: { ordering_cycle: 2, duplicate_edge: 1 },
      profile: {
        nodes: 10,
        edges: 12,
        edges_by_kind: { related: 8, parent: 4 },
        active_nodes: 5,
        missing_nodes: 1,
        isolated_active_nodes: 2,
        degree_leq_one_active_nodes: 3,
        coverage_by_type: {},
      },
    };
    const current = {
      saved_at: "2026-07-20T00:00:00.000Z",
      fingerprint: "bbb",
      affected_subjects_by_code: { ordering_cycle: 1, missing_reference_active: 4 },
      profile: {
        nodes: 12,
        edges: 12,
        edges_by_kind: { related: 8, blocked_by: 2, parent: 2 },
        active_nodes: 6,
        missing_nodes: 1,
        isolated_active_nodes: 0,
        degree_leq_one_active_nodes: 3,
        coverage_by_type: {},
      },
    };
    expect(diffRelationshipAuditSnapshots(baseline, current)).toEqual({
      baseline_saved_at: "2026-07-19T00:00:00.000Z",
      same_snapshot: false,
      affected_subjects_by_code: {
        duplicate_edge: -1,
        missing_reference_active: 4,
        ordering_cycle: -1,
      },
      profile: {
        nodes: 2,
        edges: 0,
        active_nodes: 1,
        missing_nodes: 0,
        isolated_active_nodes: -2,
        degree_leq_one_active_nodes: 0,
        edges_by_kind: { blocked_by: 2, parent: -2 },
      },
    });
    expect(
      diffRelationshipAuditSnapshots(baseline, {
        ...baseline,
        saved_at: "2026-07-21T00:00:00.000Z",
      }).same_snapshot,
    ).toBe(true);
  });
});
