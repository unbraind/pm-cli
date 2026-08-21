import { describe, expect, it } from "vitest";
import { assembleWorkspaceRelationshipGraph } from "../../../../src/sdk/graph/assembly.js";
import { auditWorkspaceRelationshipGraph } from "../../../../src/sdk/graph/governance.js";

describe("hierarchy graph governance", () => {
  it("reports active cycles, cardinality violations, and parent divergence", () => {
    const report = auditWorkspaceRelationshipGraph(
      assembleWorkspaceRelationshipGraph([
        {
          id: "pm-a",
          title: "A",
          status: "open",
          dependencies: [{ id: "pm-b", kind: "child_of" }],
        },
        {
          id: "pm-b",
          title: "B",
          status: "open",
          parent: "pm-c",
          dependencies: [
            { id: "pm-a", kind: "epic" },
            { id: "pm-d", kind: "parent" },
          ],
        },
        { id: "pm-c", title: "C", status: "open" },
        { id: "pm-d", title: "D", status: "open" },
      ] as never),
      { maxSampleSize: 10 },
    );

    expect(
      report.findings.filter((finding) => finding.code.startsWith("hierarchy")),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hierarchy_cycle",
          severity: "error",
          sample: ["pm-a", "pm-b"],
        }),
        expect.objectContaining({
          code: "hierarchy_cardinality_violation",
          severity: "error",
          sample: ["pm-b"],
          evidence: ["pm-b <- pm-a, pm-c, pm-d"],
        }),
        expect.objectContaining({
          code: "hierarchy_direction_violation",
          severity: "error",
          sample: ["pm-b"],
          evidence: ["pm-b: scalar=pm-c dependencies=pm-a,pm-d"],
        }),
      ]),
    );
    expect(report.profile.finding_subjects_by_code).toMatchObject({
      hierarchy_cycle: 2,
      hierarchy_cardinality_violation: 1,
      hierarchy_direction_violation: 1,
    });
  });

  it("downgrades terminal-only defects and accepts legacy assemblies", () => {
    const assembly = assembleWorkspaceRelationshipGraph([
      {
        id: "pm-old-a",
        title: "Old A",
        status: "closed",
        dependencies: [{ id: "pm-old-b", kind: "parent" }],
      },
      {
        id: "pm-old-b",
        title: "Old B",
        status: "canceled",
        dependencies: [{ id: "pm-old-a", kind: "parent" }],
      },
      { id: "pm-old-parent-a", title: "Parent A", status: "closed" },
      { id: "pm-old-parent-b", title: "Parent B", status: "closed" },
      {
        id: "pm-old-child-a",
        title: "Child A",
        status: "closed",
        parent: "pm-old-parent-a",
        dependencies: [{ id: "pm-old-parent-b", kind: "parent" }],
      },
      {
        id: "pm-old-child-b",
        title: "Child B",
        status: "canceled",
        parent: "pm-old-parent-a",
        dependencies: [{ id: "pm-old-parent-b", kind: "parent" }],
      },
    ] as never);
    const report = auditWorkspaceRelationshipGraph(assembly);
    expect(
      report.findings.find(
        (finding) => finding.code === "legacy_hierarchy_cycle",
      ),
    ).toMatchObject({ severity: "info", sample: ["pm-old-a", "pm-old-b"] });
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "legacy_hierarchy_cardinality_violation",
          severity: "info",
          count: 2,
        }),
        expect.objectContaining({
          code: "legacy_hierarchy_direction_violation",
          severity: "info",
          count: 2,
        }),
      ]),
    );
    expect(
      auditWorkspaceRelationshipGraph({ ...assembly }).findings.some(
        (finding) => finding.code.includes("hierarchy"),
      ),
    ).toBe(true);
    const legacyAssembly = { ...assembly };
    delete legacyAssembly.hierarchyIntegrity;
    expect(
      auditWorkspaceRelationshipGraph(legacyAssembly).findings.some(
        (finding) => finding.code.includes("hierarchy"),
      ),
    ).toBe(false);
  });
});
