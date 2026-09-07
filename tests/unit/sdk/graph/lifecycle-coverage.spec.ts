import { describe, expect, it } from "vitest";
import { runGraph } from "../../../../src/sdk/graph/run.js";
import { assembleWorkspaceRelationshipGraph } from "../../../../src/sdk/graph/assembly.js";
import { auditWorkspaceRelationshipGraph } from "../../../../src/sdk/graph/governance.js";
import { diffRelationshipAuditSnapshots } from "../../../../src/sdk/graph/governance.js";
import {
  saveGraphAuditBaseline,
  loadGraphAuditBaseline,
  graphAuditBaselinePath,
} from "../../../../src/sdk/graph/durable-cache.js";
import { writeFile } from "node:fs/promises";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("all-status relationship coverage", () => {
  it("measures terminal isolates and semantic membership without changing active counters", () => {
    const assembly = assembleWorkspaceRelationshipGraph([
      { id: "pm-active", title: "Work", status: "open", type: "Task" },
      { id: "pm-done", title: "Done", status: "closed", type: "Task" },
      {
        id: "pm-canceled",
        title: "Canceled",
        status: "canceled",
        type: "Task",
        dependencies: [{ id: "pm-active", kind: "verifies" }],
      },
    ]);
    const { profile } = auditWorkspaceRelationshipGraph(assembly);
    expect(profile.active_nodes).toBe(1);
    expect(profile.coverage_by_lifecycle).toMatchObject({
      all: {
        nodes: 3,
        isolated: 1,
        degree_leq_one: 3,
        semantic_nodes: 2,
        without_semantic_edges: 1,
      },
      active: { nodes: 1, isolated: 0, semantic_nodes: 1 },
      terminal: { nodes: 2, isolated: 1, semantic_nodes: 1 },
    });
    expect(profile.coverage_by_status.closed).toMatchObject({
      nodes: 1,
      isolated: 1,
    });
    expect(profile.coverage_by_status.canceled).toMatchObject({
      nodes: 1,
      semantic_nodes: 1,
    });
  });

  it("honors custom terminal states and excludes placeholders from recorded populations", () => {
    const assembly = assembleWorkspaceRelationshipGraph([
      {
        id: "pm-archived",
        title: "Archive",
        status: "archived",
        type: "Task",
        dependencies: [{ id: "pm-absent", kind: "verifies" }],
      },
    ]);
    const report = auditWorkspaceRelationshipGraph(assembly, {
      isTerminal: (status) => status === "archived",
    });
    expect(report.profile.coverage_by_lifecycle).toMatchObject({
      all: { nodes: 1 },
      active: { nodes: 0 },
      terminal: { nodes: 1 },
    });
    expect(report.profile.coverage_by_status.archived.nodes).toBe(1);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_reference_terminal",
          count: 1,
        }),
      ]),
    );
  });

  it("reports structural cycles independently of historical finding severity", () => {
    const assembly = assembleWorkspaceRelationshipGraph([
      {
        id: "pm-a",
        title: "A",
        status: "closed",
        dependencies: [{ id: "pm-b", kind: "blocked_by" }],
      },
      {
        id: "pm-b",
        title: "B",
        status: "closed",
        dependencies: [{ id: "pm-a", kind: "blocked_by" }],
      },
    ]);
    const report = auditWorkspaceRelationshipGraph(assembly);
    expect(report.profile.ordering_acyclic).toBe(false);
    expect(report.profile.active_ordering_acyclic).toBe(true);
  });

  it("persists lifecycle baselines and measures terminal backfill without inventing legacy measurements", async () => {
    await withTempPmPath(async (context) => {
      const items = [
        { id: "pm-a", title: "A", status: "open" },
        { id: "pm-b", title: "B", status: "closed" },
      ];
      const before = {
        saved_at: "2026-09-07T00:00:00Z",
        fingerprint: "before",
        affected_subjects_by_code: {},
        profile: auditWorkspaceRelationshipGraph(
          assembleWorkspaceRelationshipGraph(items),
        ).profile,
      };
      await saveGraphAuditBaseline(context.pmPath, before);
      expect(await loadGraphAuditBaseline(context.pmPath)).toEqual(before);
      const after = {
        ...before,
        fingerprint: "after",
        profile: auditWorkspaceRelationshipGraph(
          assembleWorkspaceRelationshipGraph([
            items[0],
            { ...items[1], dependencies: [{ id: "pm-a", kind: "verifies" }] },
            { id: "pm-new", title: "New", status: "canceled" },
          ]),
        ).profile,
      };
      const delta = diffRelationshipAuditSnapshots(before, after);
      expect(delta.profile).toMatchObject({
        lifecycle_comparable: true,
        coverage_by_lifecycle: {
          all: { nodes: 1, semantic_nodes: 2 },
          terminal: { nodes: 1, semantic_nodes: 1 },
        },
        coverage_by_status: {
          canceled: { nodes: 1 },
          closed: {
            isolated: -1,
            semantic_nodes: 1,
            degree_histogram: { "0": -1, "1": 1 },
          },
        },
      });
      const reverse = diffRelationshipAuditSnapshots(after, before);
      expect(reverse.profile.coverage_by_status?.canceled.nodes).toBe(-1);
      const {
        coverage_by_lifecycle,
        coverage_by_status: _statuses,
        ...legacyProfile
      } = before.profile;
      await writeFile(
        graphAuditBaselinePath(context.pmPath),
        JSON.stringify({ ...before, profile: legacyProfile }),
      );
      const legacy = await loadGraphAuditBaseline(context.pmPath);
      expect(legacy).toBeDefined();
      expect(
        diffRelationshipAuditSnapshots(legacy!, after).profile,
      ).toMatchObject({ lifecycle_comparable: false });
      expect(
        diffRelationshipAuditSnapshots(legacy!, after).profile,
      ).not.toHaveProperty("coverage_by_lifecycle");
      for (const patch of [
        { coverage_by_lifecycle: null },
        { coverage_by_lifecycle: { ...coverage_by_lifecycle, all: null } },
        { coverage_by_status: [] },
        { ordering_acyclic: "true" },
        {
          coverage_by_lifecycle: {
            ...coverage_by_lifecycle,
            all: { ...coverage_by_lifecycle.all, nodes: -1 },
          },
        },
        {
          coverage_by_lifecycle: {
            ...coverage_by_lifecycle,
            all: { ...coverage_by_lifecycle.all, degree_histogram: null },
          },
        },
        {
          coverage_by_lifecycle: {
            ...coverage_by_lifecycle,
            all: {
              ...coverage_by_lifecycle.all,
              degree_histogram: { "0": 99 },
            },
          },
        },
      ]) {
        await writeFile(
          graphAuditBaselinePath(context.pmPath),
          JSON.stringify({
            ...before,
            profile: { ...before.profile, ...patch },
          }),
        );
        expect(await loadGraphAuditBaseline(context.pmPath)).toBeUndefined();
      }
    });
  });
  it("bounds the summary while persisting complete census baselines and restoring detailed output", async () => {
    await withTempPmPath(async (context) => {
      expect(
        context.runCli([
          "create",
          "Task",
          "Census member",
          "--create-mode",
          "progressive",
        ]).code,
      ).toBe(0);
      const summary = await runGraph(
        "audit",
        undefined,
        undefined,
        { summary: true, saveBaseline: true },
        { path: context.pmPath },
      );
      expect(summary).toMatchObject({
        profile: {
          recorded_nodes: 1,
          coverage_by_lifecycle: { all: { nodes: 1, isolated: 1 } },
        },
      });
      expect(summary).not.toHaveProperty("profile.coverage_by_status");
      expect(summary).not.toHaveProperty(
        "profile.coverage_by_lifecycle.all.degree_histogram",
      );
      expect(summary.projection).toMatchObject({
        mode: "summary",
        declared_field_groups: [
          { name: "result_rows", restore_with: "--full" },
        ],
      });
      const baseline = await loadGraphAuditBaseline(context.pmPath);
      expect(baseline?.profile.coverage_by_status.open.nodes).toBe(1);
      const full = await runGraph(
        "audit",
        undefined,
        undefined,
        { full: true },
        { path: context.pmPath },
      );
      expect(full).toHaveProperty(
        "profile.coverage_by_lifecycle.all.degree_histogram",
        { "0": 1 },
      );
    });
  });

  it("compares newly introduced status names that collide with inherited object keys", () => {
    const snapshot = (status: string) => ({
      saved_at: "2026-09-07T00:00:00Z",
      fingerprint: status,
      affected_subjects_by_code: {},
      profile: auditWorkspaceRelationshipGraph(
        assembleWorkspaceRelationshipGraph([
          { id: "pm-a", title: "A", status },
        ]),
      ).profile,
    });
    const before = snapshot("open");
    for (const status of ["constructor", "__proto__"]) {
      const after = snapshot(status);
      expect(
        diffRelationshipAuditSnapshots(before, after).profile
          .coverage_by_status?.[status],
      ).toMatchObject({ nodes: 1, isolated: 1 });
      expect(
        diffRelationshipAuditSnapshots(after, before).profile
          .coverage_by_status?.[status],
      ).toMatchObject({ nodes: -1, isolated: -1 });
    }
  });
});
