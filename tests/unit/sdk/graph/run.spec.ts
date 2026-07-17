import { describe, expect, it } from "vitest";
import {
  GRAPH_SUBCOMMAND_VALUES,
  parseGraphSubcommand,
  runGraph,
} from "../../../../src/cli/commands/graph.js";
import type {
  GraphAnalyzeResult,
  GraphAuditResult,
  GraphCommunitiesResult,
  GraphDominatorsResult,
  GraphImpactResult,
  GraphPathsResult,
  GraphRedundancyResult,
  GraphTraversalResult,
} from "../../../../src/sdk/graph/run.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../../../helpers/withTempPmPath.js";

function createItem(
  context: TempPmContext,
  title: string,
  extraArgs: string[] = [],
): string {
  const created = context.runCli(
    [
      "create",
      "--json",
      "--title",
      title,
      "--description",
      `${title} description`,
      "--type",
      "Task",
      "--status",
      "open",
      "--priority",
      "1",
      "--author",
      "graph-spec",
      ...extraArgs,
    ],
    { expectJson: true },
  );
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

/**
 * Build one shared workspace shape:
 *
 *   epic ← feat ← task            (parent hierarchy)
 *   task ←(blocked_by)← follower  (ordering: follower is blocked by task)
 *   task →(blocked_by)→ pm-ghost  (missing ordering endpoint placeholder)
 */
async function seedWorkspace(context: TempPmContext): Promise<{
  epic: string;
  feat: string;
  task: string;
  follower: string;
}> {
  const epic = createItem(context, "Graph epic");
  const feat = createItem(context, "Graph feature", ["--parent", epic]);
  const task = createItem(context, "Graph task", [
    "--parent",
    feat,
    "--dep",
    "id=pm-ghost,kind=blocked_by",
  ]);
  const follower = createItem(context, "Graph follower", [
    "--dep",
    `id=${task},kind=blocked_by`,
  ]);
  return { epic, feat, task, follower };
}

describe("parseGraphSubcommand", () => {
  it("accepts every published subcommand case-insensitively", () => {
    for (const subcommand of GRAPH_SUBCOMMAND_VALUES) {
      expect(parseGraphSubcommand(subcommand.toUpperCase(), "pm-1", "pm-2")).toBe(subcommand);
    }
  });

  it("rejects unknown subcommands with a usage error listing the choices", () => {
    expect(() => parseGraphSubcommand("neighbours", "pm-1", undefined)).toThrowError(
      expect.objectContaining({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("ancestors, descendants"),
      }) as never,
    );
  });

  it("requires a root id for rooted subcommands and a target for paths", () => {
    expect(() => parseGraphSubcommand("ancestors", undefined, undefined)).toThrowError(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }) as never,
    );
    expect(() => parseGraphSubcommand("impact", "  ", undefined)).toThrowError(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }) as never,
    );
    expect(() => parseGraphSubcommand("paths", "pm-1", "  ")).toThrowError(
      expect.objectContaining({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("source and a target"),
      }) as never,
    );
    expect(() => parseGraphSubcommand("dominators", undefined, undefined)).toThrowError(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }) as never,
    );
    expect(parseGraphSubcommand("analyze", undefined, undefined)).toBe("analyze");
    expect(parseGraphSubcommand("communities", undefined, undefined)).toBe("communities");
    expect(parseGraphSubcommand("redundancy", undefined, undefined)).toBe("redundancy");
  });
});

describe("runGraph", () => {
  it("fails fast when the tracker is not initialized", async () => {
    await expect(
      runGraph("analyze", undefined, undefined, {}, { path: "/tmp/pm-graph-uninitialized-root" }),
    ).rejects.toMatchObject<Partial<PmCliError>>({ exitCode: EXIT_CODE.NOT_FOUND });
  });

  it("rejects unknown roots and missing-endpoint placeholder ids", async () => {
    await withTempPmPath(async (context) => {
      await seedWorkspace(context);
      await expect(
        runGraph("ancestors", "pm-nope", undefined, {}, { path: context.pmPath }),
      ).rejects.toMatchObject<Partial<PmCliError>>({ exitCode: EXIT_CODE.NOT_FOUND });
      // pm-ghost exists only as a materialized missing placeholder; it is not
      // addressable as a query root.
      await expect(
        runGraph("successors", "pm-ghost", undefined, {}, { path: context.pmPath }),
      ).rejects.toMatchObject<Partial<PmCliError>>({ exitCode: EXIT_CODE.NOT_FOUND });
    });
  });

  it("walks hierarchy ancestors and descendants deterministically", async () => {
    await withTempPmPath(async (context) => {
      const { epic, feat, task } = await seedWorkspace(context);
      const up = (await runGraph(
        "ancestors",
        task.toUpperCase(),
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphTraversalResult;
      expect(up.subcommand).toBe("ancestors");
      expect(up.root).toBe(task);
      expect(up.ids).toEqual([feat, epic]);
      expect(up.count).toBe(2);
      expect(up.truncated).toBe(false);
      expect(up.cost.visited_nodes).toBeGreaterThan(0);

      const empty = (await runGraph(
        "ancestors",
        epic,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphTraversalResult;
      expect(empty.ids).toEqual([]);
      expect(empty.next_cursor).toBeUndefined();

      const down = (await runGraph(
        "descendants",
        epic,
        undefined,
        { kind: "parent" },
        { path: context.pmPath },
      )) as GraphTraversalResult;
      expect(down.ids).toEqual([feat, task]);
    });
  });

  it("bounds traversals with maxDepth, limit, cursor continuation, and summary", async () => {
    await withTempPmPath(async (context) => {
      const { epic, feat, task } = await seedWorkspace(context);
      const shallow = (await runGraph(
        "ancestors",
        task,
        undefined,
        { maxDepth: "1" },
        { path: context.pmPath },
      )) as GraphTraversalResult;
      expect(shallow.ids).toEqual([feat]);
      expect(shallow.truncated).toBe(true);

      const firstPage = (await runGraph(
        "ancestors",
        task,
        undefined,
        { limit: 1 },
        { path: context.pmPath },
      )) as GraphTraversalResult;
      expect(firstPage.ids).toEqual([feat]);
      expect(firstPage.next_cursor).toBeDefined();

      const secondPage = (await runGraph(
        "ancestors",
        task,
        undefined,
        { after: firstPage.next_cursor! },
        { path: context.pmPath },
      )) as GraphTraversalResult;
      expect(secondPage.ids).toEqual([epic]);

      const summary = (await runGraph(
        "ancestors",
        task,
        undefined,
        { summary: true },
        { path: context.pmPath },
      )) as GraphTraversalResult;
      expect(summary.count).toBe(2);
      expect(summary.ids).toBeUndefined();
    });
  });

  it("walks ordering predecessors and successors over blocked_by edges", async () => {
    await withTempPmPath(async (context) => {
      const { task, follower } = await seedWorkspace(context);
      const preds = (await runGraph(
        "predecessors",
        follower,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphTraversalResult;
      expect(preds.ids).toContain(task);

      const succs = (await runGraph(
        "successors",
        task,
        undefined,
        { kind: ["blocked_by"] },
        { path: context.pmPath },
      )) as GraphTraversalResult;
      expect(succs.ids).toEqual([follower]);
    });
  });

  it("translates semantic traversal misuse into usage errors", async () => {
    await withTempPmPath(async (context) => {
      const { task } = await seedWorkspace(context);
      // "related" is a registered kind but not part of the hierarchy family, so
      // the traversal kernel reports semantic misuse as a TypeError which the
      // runner surfaces as a usage failure.
      await expect(
        runGraph("ancestors", task, undefined, { kind: "related" }, { path: context.pmPath }),
      ).rejects.toMatchObject<Partial<PmCliError>>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runGraph("ancestors", task, undefined, { after: "pm-unknown-cursor" }, { path: context.pmPath }),
      ).rejects.toMatchObject<Partial<PmCliError>>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("rejects unregistered kinds and malformed bounds before traversal", async () => {
    await withTempPmPath(async (context) => {
      const { task } = await seedWorkspace(context);
      const usage = (input: Promise<unknown>): Promise<void> =>
        expect(input).rejects.toMatchObject<Partial<PmCliError>>({
          exitCode: EXIT_CODE.USAGE,
        });
      await usage(
        runGraph("ancestors", task, undefined, { kind: "owns" }, { path: context.pmPath }),
      );
      await usage(
        runGraph("ancestors", task, undefined, { maxDepth: "-1" }, { path: context.pmPath }),
      );
      await usage(runGraph("ancestors", task, undefined, { limit: "0" }, { path: context.pmPath }));
      await usage(
        runGraph("impact", task, undefined, { direction: "sideways" }, { path: context.pmPath }),
      );
      await usage(
        runGraph("paths", task, task, { maxPaths: "0" }, { path: context.pmPath }),
      );
      await usage(runGraph("audit", undefined, undefined, { sample: "0" }, { path: context.pmPath }));
    });
  });

  it("enumerates bounded simple paths with per-edge kinds", async () => {
    await withTempPmPath(async (context) => {
      const { epic, follower } = await seedWorkspace(context);
      const paths = (await runGraph(
        "paths",
        follower,
        epic,
        { direction: "both", kind: ["parent", "blocked_by"], maxDepth: "6" },
        { path: context.pmPath },
      )) as GraphPathsResult;
      expect(paths.subcommand).toBe("paths");
      expect(paths.direction).toBe("both");
      expect(paths.count).toBeGreaterThan(0);
      const [first] = paths.paths!;
      expect(first!.nodes[0]).toBe(follower);
      expect(first!.nodes.at(-1)).toBe(epic);
      expect(first!.kinds).toHaveLength(first!.length);

      const zeroLength = (await runGraph(
        "paths",
        follower,
        follower,
        {},
        { path: context.pmPath },
      )) as GraphPathsResult;
      expect(zeroLength.count).toBe(1);
      expect(zeroLength.paths![0]!.length).toBe(0);

      const summary = (await runGraph(
        "paths",
        follower,
        epic,
        { summary: true, maxPaths: 1 },
        { path: context.pmPath },
      )) as GraphPathsResult;
      expect(summary.paths).toBeUndefined();
      expect(summary.count).toBeLessThanOrEqual(1);
    });
  });

  it("reports bounded blast radius with explaining paths for impact", async () => {
    await withTempPmPath(async (context) => {
      const { feat, task, follower } = await seedWorkspace(context);
      const impact = (await runGraph(
        "impact",
        task,
        undefined,
        { direction: "both" },
        { path: context.pmPath },
      )) as GraphImpactResult;
      expect(impact.subcommand).toBe("impact");
      const affectedIds = impact.affected!.map((row) => row.id);
      expect(affectedIds).toEqual(expect.arrayContaining([feat, follower]));
      for (const row of impact.affected!) {
        expect(row.distance).toBeGreaterThan(0);
        expect(row.path[0]).toBe(task);
        expect(row.path.at(-1)).toBe(row.id);
      }

      const bounded = (await runGraph(
        "impact",
        task,
        undefined,
        {
          direction: "both",
          limit: "1",
          summary: true,
          kind: ["blocked_by", "parent"],
          maxDepth: "4",
        },
        { path: context.pmPath },
      )) as GraphImpactResult;
      expect(bounded.count).toBe(1);
      expect(bounded.truncated).toBe(true);
      expect(bounded.affected).toBeUndefined();
    });
  });

  it("summarizes execution and knowledge analytics for analyze", async () => {
    await withTempPmPath(async (context) => {
      const { follower } = await seedWorkspace(context);
      const isolate = createItem(context, "Graph isolate");
      const analyze = (await runGraph(
        "analyze",
        undefined,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphAnalyzeResult;
      expect(analyze.subcommand).toBe("analyze");
      expect(analyze.sample_limit).toBe(10);
      expect(analyze.node_count).toBeGreaterThanOrEqual(6);
      expect(analyze.edge_count).toBeGreaterThanOrEqual(4);
      expect(analyze.execution.acyclic).toBe(true);
      expect(analyze.execution.cycle_count).toBe(0);
      expect(analyze.execution.frontier).not.toContain(follower);
      expect(analyze.execution.critical_path_length).toBeGreaterThanOrEqual(1);
      expect(analyze.knowledge.component_count).toBeGreaterThanOrEqual(2);
      expect(analyze.knowledge.orphans).toContain(isolate);
      expect(analyze.knowledge.hubs![0]!.degree).toBeGreaterThan(0);

      const summary = (await runGraph(
        "analyze",
        undefined,
        undefined,
        { summary: true, limit: 2 },
        { path: context.pmPath },
      )) as GraphAnalyzeResult;
      expect(summary.sample_limit).toBe(2);
      expect(summary.execution.frontier).toBeUndefined();
      expect(summary.execution.critical_path).toBeUndefined();
      expect(summary.execution.cycles).toBeUndefined();
      expect(summary.knowledge.orphans).toBeUndefined();
      expect(summary.knowledge.hubs).toBeUndefined();
    });
  });

  it("clusters the workspace into communities with bounded samples", async () => {
    await withTempPmPath(async (context) => {
      const { epic, follower } = await seedWorkspace(context);
      createItem(context, "Graph isolate");
      const pairLeft = createItem(context, "Graph pair left");
      createItem(context, "Graph pair right", [
        "--dep",
        `id=${pairLeft},kind=related`,
      ]);
      const communities = (await runGraph(
        "communities",
        undefined,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphCommunitiesResult;
      expect(communities.subcommand).toBe("communities");
      expect(communities.converged).toBe(true);
      expect(communities.iterations).toBeGreaterThan(0);
      expect(communities.truncated).toBe(false);
      // epic <- feat <- task <- follower plus the pm-ghost placeholder form
      // one connected cluster; the related pair is the second; the isolate
      // never reaches the size floor.
      expect(communities.community_count).toBe(2);
      expect(communities.largest_community_size).toBe(5);
      expect(communities.communities![0]!.members).toEqual(
        expect.arrayContaining([epic, follower, "pm-ghost"]),
      );

      const bounded = (await runGraph(
        "communities",
        undefined,
        undefined,
        { limit: "1" },
        { path: context.pmPath },
      )) as GraphCommunitiesResult;
      expect(bounded.communities).toHaveLength(1);
      expect(bounded.communities![0]!.members).toHaveLength(1);
      expect(bounded.communities![0]!.size).toBe(5);
      expect(bounded.community_count).toBe(2);
      expect(bounded.truncated).toBe(true);

      const summary = (await runGraph(
        "communities",
        undefined,
        undefined,
        { summary: true, kind: "parent" },
        { path: context.pmPath },
      )) as GraphCommunitiesResult;
      expect(summary.communities).toBeUndefined();
      expect(summary.largest_community_size).toBe(3);
    });
  });

  it("finds transitively redundant edges with witness paths", async () => {
    await withTempPmPath(async (context) => {
      const { task, follower } = await seedWorkspace(context);
      const shortcut = createItem(context, "Graph shortcut", [
        "--dep",
        `id=${follower},kind=blocked_by`,
        "--dep",
        `id=${task},kind=blocked_by`,
      ]);
      const redundancy = (await runGraph(
        "redundancy",
        undefined,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphRedundancyResult;
      expect(redundancy.subcommand).toBe("redundancy");
      expect(redundancy.redundant_count).toBe(1);
      expect(redundancy.truncated).toBe(false);
      expect(redundancy.redundant![0]).toEqual({
        source: shortcut,
        target: task,
        kind: "blocked_by",
        witness: [task, follower, shortcut],
      });
      expect(redundancy.cost.inspected_edges).toBeGreaterThan(0);

      const summary = (await runGraph(
        "redundancy",
        undefined,
        undefined,
        { summary: true, kind: "blocks", maxDepth: "4", limit: "5" },
        { path: context.pmPath },
      )) as GraphRedundancyResult;
      expect(summary.redundant).toBeUndefined();
      expect(summary.redundant_count).toBe(1);

      // "related" is registered but carries no transitive semantics, so the
      // analytics kernel reports misuse which the runner maps to usage.
      await expect(
        runGraph(
          "redundancy",
          undefined,
          undefined,
          { kind: "related" },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<Partial<PmCliError>>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("ranks structural bottlenecks for dominators with bounded rows", async () => {
    await withTempPmPath(async (context) => {
      const { task, follower } = await seedWorkspace(context);
      const dominators = (await runGraph(
        "dominators",
        follower,
        undefined,
        { direction: "outgoing", kind: "blocked_by" },
        { path: context.pmPath },
      )) as GraphDominatorsResult;
      expect(dominators.subcommand).toBe("dominators");
      expect(dominators.root).toBe(follower);
      expect(dominators.direction).toBe("outgoing");
      // follower -> task -> pm-ghost: task gates the placeholder.
      expect(dominators.reachable_count).toBe(3);
      expect(dominators.bottleneck_count).toBe(1);
      expect(dominators.truncated).toBe(false);
      expect(dominators.bottlenecks).toEqual([
        { id: task, idom: follower, dominated_count: 1 },
      ]);

      const summary = (await runGraph(
        "dominators",
        follower,
        undefined,
        { direction: "outgoing", summary: true, limit: "1" },
        { path: context.pmPath },
      )) as GraphDominatorsResult;
      expect(summary.bottlenecks).toBeUndefined();
      expect(summary.reachable_count).toBeGreaterThan(0);
    });
  });

  it("returns zero-valued analytics envelopes for an empty workspace", async () => {
    await withTempPmPath(async (context) => {
      const analyze = (await runGraph(
        "analyze",
        undefined,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphAnalyzeResult;
      expect(analyze.node_count).toBe(0);
      expect(analyze.knowledge.largest_component_size).toBe(0);

      const communities = (await runGraph(
        "communities",
        undefined,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphCommunitiesResult;
      expect(communities.community_count).toBe(0);
      expect(communities.largest_community_size).toBe(0);
    });
  });

  it("runs the governance audit with samples, severity rollups, and exemptions", async () => {
    await withTempPmPath(async (context) => {
      await seedWorkspace(context);
      const isolate = createItem(context, "Graph isolate");
      const audit = (await runGraph(
        "audit",
        undefined,
        undefined,
        { sample: 5 },
        { path: context.pmPath },
      )) as GraphAuditResult;
      expect(audit.subcommand).toBe("audit");
      expect(audit.finding_count).toBeGreaterThan(0);
      const codes = audit.findings!.map((finding) => finding.code);
      expect(codes).toContain("missing_reference_active");
      expect(codes).toContain("isolated_active_node");
      const severityTotal = Object.values(audit.findings_by_severity).reduce(
        (sum, value) => sum + value,
        0,
      );
      expect(severityTotal).toBe(audit.finding_count);
      expect(audit.findings_by_code.missing_reference_active).toBeGreaterThan(0);
      expect(audit.profile).toBeDefined();

      // Exempting the isolate (single comma-separated string spelling, with
      // blank fragments dropped) suppresses its isolation finding.
      const exempted = (await runGraph(
        "audit",
        undefined,
        undefined,
        { exemptIsolate: ` ${isolate} ,`, summary: true },
        { path: context.pmPath },
      )) as GraphAuditResult;
      expect(exempted.findings).toBeUndefined();
      const isolationFindings = audit.findings!.filter(
        (finding) => finding.code === "isolated_active_node",
      );
      expect(isolationFindings.length).toBeGreaterThan(0);
      expect(exempted.findings_by_code.isolated_active_node ?? 0).toBeLessThan(
        audit.findings_by_code.isolated_active_node ?? 0,
      );

      // Repeatable-array exemption spelling (with blank fragments dropped)
      // resolves to the same exemption set as the string form.
      const exemptedArray = (await runGraph(
        "audit",
        undefined,
        undefined,
        { exemptIsolate: [` ${isolate} ,`, ""], summary: true },
        { path: context.pmPath },
      )) as GraphAuditResult;
      expect(exemptedArray.findings_by_code).toEqual(
        exempted.findings_by_code,
      );
    });
  });
});
