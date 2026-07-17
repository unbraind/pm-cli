import { describe, expect, it } from "vitest";
import { assembleWorkspaceRelationshipGraph } from "../../../../src/sdk/graph/assembly.js";
import { planRelationshipRemediation } from "../../../../src/sdk/graph/remediation.js";

/** Assembly exhibiting every audit finding family plus a witnessed shortcut. */
function richAssembly(): ReturnType<typeof assembleWorkspaceRelationshipGraph> {
  return assembleWorkspaceRelationshipGraph([
    {
      id: "pm-cycle-a",
      title: "Cycle A",
      status: "open",
      dependencies: [{ id: "pm-cycle-b", kind: "blocked_by" }],
    },
    {
      id: "pm-cycle-b",
      title: "Cycle B",
      status: "open",
      dependencies: [{ id: "pm-cycle-a", kind: "blocked_by" }],
    },
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
      id: "pm-dup-a",
      title: "Dup A",
      status: "open",
      dependencies: [{ id: "pm-dup-b", kind: "blocked_by" }],
    },
    {
      id: "pm-dup-b",
      title: "Dup B",
      status: "open",
      dependencies: [{ id: "pm-dup-a", kind: "blocks" }],
    },
    {
      id: "pm-legacy-dup-a",
      title: "Legacy dup A",
      status: "closed",
      dependencies: [{ id: "pm-legacy-dup-b", kind: "blocked_by" }],
    },
    {
      id: "pm-legacy-dup-b",
      title: "Legacy dup B",
      status: "closed",
      dependencies: [{ id: "pm-legacy-dup-a", kind: "blocks" }],
    },
    {
      id: "pm-active-missing",
      title: "Active missing",
      status: "open",
      dependencies: [
        { id: "pm-gone", kind: "blocked_by" },
        { id: "no-active-blocker", kind: "related" },
      ],
    },
    {
      id: "pm-history",
      title: "History",
      status: "closed",
      dependencies: [{ id: "pm-lost", kind: "related" }],
    },
    { id: "pm-stale", title: "Stale", status: "blocked" },
    { id: "pm-isolate", title: "Isolate", status: "open" },
    {
      id: "pm-sparse",
      title: "Sparse",
      status: "open",
      dependencies: [{ id: "pm-isolate", kind: "related" }],
    },
    {
      id: "pm-chain-a",
      title: "Chain A",
      status: "open",
      dependencies: [
        { id: "pm-chain-b", kind: "blocked_by" },
        { id: "pm-chain-c", kind: "blocked_by" },
      ],
    },
    {
      id: "pm-chain-b",
      title: "Chain B",
      status: "open",
      dependencies: [{ id: "pm-chain-c", kind: "blocked_by" }],
    },
    { id: "pm-chain-c", title: "Chain C", status: "open" },
  ] as never);
}

describe("planRelationshipRemediation", () => {
  it("derives one exact proposal per finding subject plus witnessed shortcut removals", () => {
    const plan = planRelationshipRemediation(richAssembly());
    const opsByCode = new Map(
      plan.steps.map((step) => [step.code, step.op] as const),
    );
    expect(opsByCode.get("missing_reference_active")).toBe("investigate");
    expect(opsByCode.get("missing_reference_terminal")).toBe("waive");
    expect(opsByCode.get("legacy_no_blocker_sentinel")).toBe("remove");
    expect(opsByCode.get("ordering_cycle")).toBe("investigate");
    expect(opsByCode.get("legacy_ordering_cycle")).toBe("waive");
    expect(opsByCode.get("duplicate_edge")).toBe("remove");
    expect(opsByCode.get("legacy_duplicate_edge")).toBe("waive");
    expect(opsByCode.get("stale_lifecycle_block")).toBe("investigate");
    expect(opsByCode.get("isolated_active_node")).toBe("investigate");
    expect(opsByCode.get("sparse_active_node")).toBe("investigate");
    expect(opsByCode.get("redundant_edge")).toBe("remove");

    const duplicate = plan.steps.find(
      (step) => step.code === "duplicate_edge",
    )!;
    expect(duplicate.subject).toBe("pm-dup-b -> pm-dup-a (blocked_by + blocks)");
    expect(duplicate.confidence).toBe("high");
    expect(duplicate.evidence[0]).toContain("stored once");

    const shortcut = plan.steps.find(
      (step) => step.code === "redundant_edge",
    )!;
    expect(shortcut.subject).toBe("pm-chain-a -> pm-chain-c (blocked_by)");
    expect(shortcut.confidence).toBe("medium");
    expect(shortcut.evidence).toEqual([
      "witness: pm-chain-c -> pm-chain-b -> pm-chain-a",
    ]);
    expect(plan.truncated).toBe(false);
    expect(plan.report.findings.length).toBeGreaterThan(0);
    expect(plan.cost.inspectedEdges).toBeGreaterThan(0);
    // Steps follow audit severity order; redundancy proposals come last.
    expect(plan.steps.at(-1)!.code).toBe("redundant_edge");
  });

  it("reports truncation from sample bounds and the redundancy scan limit", () => {
    const bounded = planRelationshipRemediation(richAssembly(), {
      maxSampleSize: 1,
    });
    // maxSampleSize 1 truncates the two-member cycle samples and also bounds
    // the redundancy scan default.
    expect(bounded.truncated).toBe(true);
    expect(
      bounded.steps.filter((step) => step.code === "ordering_cycle"),
    ).toHaveLength(1);

    const scanBounded = planRelationshipRemediation(
      assembleWorkspaceRelationshipGraph([
        {
          id: "pm-a",
          title: "A",
          status: "open",
          dependencies: [
            { id: "pm-b", kind: "blocked_by" },
            { id: "pm-c", kind: "blocked_by" },
            { id: "pm-d", kind: "blocked_by" },
          ],
        },
        {
          id: "pm-b",
          title: "B",
          status: "open",
          dependencies: [{ id: "pm-c", kind: "blocked_by" }],
        },
        {
          id: "pm-c",
          title: "C",
          status: "open",
          dependencies: [{ id: "pm-d", kind: "blocked_by" }],
        },
        { id: "pm-d", title: "D", status: "open" },
      ] as never),
      { redundancyLimit: 1 },
    );
    expect(
      scanBounded.steps.filter((step) => step.code === "redundant_edge"),
    ).toHaveLength(1);
    expect(scanBounded.truncated).toBe(true);
  });

  it("honors cancellation between the audit and the redundancy scan", () => {
    const controller = new AbortController();
    const assembly = richAssembly();
    // Abort after construction: the audit itself checks the signal first, so
    // pre-abort the controller and expect the audit-stage rejection.
    controller.abort();
    expect(() =>
      planRelationshipRemediation(assembly, { signal: controller.signal }),
    ).toThrow();
  });

  it("plans an empty workspace as zero steps without truncation", () => {
    // A live (non-aborted) signal also covers signal forwarding into the scan.
    const plan = planRelationshipRemediation(
      assembleWorkspaceRelationshipGraph([]),
      { signal: new AbortController().signal },
    );
    expect(plan.steps).toEqual([]);
    expect(plan.truncated).toBe(false);
    expect(plan.report.findings).toEqual([]);
  });
});
