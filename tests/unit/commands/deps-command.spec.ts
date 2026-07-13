import { describe, expect, it } from "vitest";
import { runDeps } from "../../../src/cli/commands/deps.js";
import { collectDanglingDependencyReferences } from "../../../src/sdk/dependencies.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

function createTask(context: TempPmContext, title: string, deps: string[] = ["none"]): string {
  const args = [
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
    "--tags",
    "deps,unit",
    "--body",
    "",
    "--deadline",
    "none",
    "--estimate",
    "10",
    "--acceptance-criteria",
    `${title} acceptance`,
    "--author",
    "test-author",
    "--message",
    `Create ${title}`,
    "--assignee",
    "none",
    "--comment",
    "none",
    "--note",
    "none",
    "--learning",
    "none",
    "--file",
    "none",
    "--test",
    "none",
    "--doc",
    "none",
  ];
  for (const dep of deps) {
    args.push("--dep", dep);
  }
  const created = context.runCli(args, { expectJson: true });
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

describe("runDeps", () => {
  it("partitions active, terminal, custom-terminal, and sentinel references", () => {
    const items = [
      { id: "pm-active", status: "open", parent: "pm-missing-active" },
      {
        id: "pm-closed",
        status: "closed",
        blocked_by: "no-active-blocker",
        dependencies: [{ id: "pm-missing-legacy", kind: "related" }],
      },
      { id: "pm-blocked", status: "blocked", parent: "pm-custom-terminal" },
    ] as const;

    const defaultSummary = collectDanglingDependencyReferences(items);
    expect(defaultSummary.active.map((row) => row.target_id)).toEqual([
      "pm-missing-active",
      "pm-custom-terminal",
    ]);
    expect(defaultSummary.legacy_terminal.map((row) => row.target_id)).toEqual([
      "no-active-blocker",
      "pm-missing-legacy",
    ]);
    expect(defaultSummary.no_active_blocker_sentinels).toHaveLength(1);

    const activeSentinelSummary = collectDanglingDependencyReferences([
      {
        id: "pm-active-sentinel",
        status: "open",
        blocked_by: "no-active-blocker",
      },
    ]);
    expect(activeSentinelSummary.active).toHaveLength(1);
    expect(activeSentinelSummary.no_active_blocker_sentinels).toHaveLength(1);

    const customSummary = collectDanglingDependencyReferences(
      items,
      (status) => status === "closed" || status === "blocked",
    );
    expect(customSummary.active.map((row) => row.target_id)).toEqual([
      "pm-missing-active",
    ]);
    expect(customSummary.legacy_terminal.map((row) => row.target_id)).toContain(
      "pm-custom-terminal",
    );

    const sameHolderAndTarget = collectDanglingDependencyReferences([
      {
        id: "pm-tie-breaker",
        status: "open",
        parent: "pm-shared-target",
        dependencies: [{ id: "pm-shared-target", kind: "related" }],
      },
    ]);
    expect(sameHolderAndTarget.active.map((row) => row.kind)).toEqual([
      "parent",
      "related",
    ]);
    expect(sameHolderAndTarget.active.map((row) => row.source)).toEqual([
      "parent",
      "dependency",
    ]);

    const distinctBlockedBySources = collectDanglingDependencyReferences([
      {
        id: "pm-blocked-sources",
        status: "open",
        blocked_by: "pm-shared-blocker",
        dependencies: [{ id: "pm-shared-blocker", kind: "blocked_by" }],
      },
    ]);
    expect(distinctBlockedBySources.active.map((row) => row.source)).toEqual([
      "blocked_by",
      "dependency",
    ]);

    const malformedRuntimeTargets = collectDanglingDependencyReferences([
      {
        id: "pm-malformed-runtime",
        status: "open",
        parent: 42,
        blocked_by: false,
        dependencies: [
          null,
          true,
          { id: true, kind: "related" },
          { id: "pm-missing-default-kind" },
        ],
      } as unknown as Parameters<typeof collectDanglingDependencyReferences>[0][number],
    ]);
    expect(malformedRuntimeTargets.active).toEqual([
      expect.objectContaining({
        target_id: "pm-missing-default-kind",
        kind: "related",
        source: "dependency",
      }),
    ]);
  });

  it("fails when tracker is not initialized", async () => {
    await expect(runDeps("pm-missing", {}, { path: "/tmp/pm-deps-missing-root" })).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.NOT_FOUND,
    });
  });

  it("validates format and item existence", async () => {
    await withTempPmPath(async (context) => {
      await expect(runDeps("pm-does-not-exist", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });

      const id = createTask(context, "deps-invalid-format");
      await expect(runDeps(id, { format: "diagram" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runDeps(id, { maxDepth: "-1" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runDeps(id, { collapse: "all" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("renders deterministic tree output including missing dependencies", async () => {
    await withTempPmPath(async (context) => {
      const leafId = createTask(context, "deps-leaf");
      const middleId = createTask(context, "deps-middle", [
        `id=${leafId},kind=blocks,author=test-author,created_at=now`,
      ]);
      const rootId = createTask(context, "deps-root", [
        `id=${middleId},kind=blocks,author=test-author,created_at=now`,
        "id=pm-missing-dependency,kind=related,author=test-author,created_at=now",
      ]);

      const result = await runDeps(rootId, { format: "tree" }, { path: context.pmPath });
      expect(result.format).toBe("tree");
      expect(result.node_count).toBe(4);
      expect(result.edge_count).toBe(3);
      expect(result.missing_count).toBe(1);
      expect(result.tree?.id).toBe(rootId);
      expect(result.tree?.missing).toBe(false);
      expect(result.tree?.dependencies.map((entry) => `${entry.via}:${entry.id}`)).toEqual([
        `blocks:${middleId}`,
        "related:pm-missing-dependency",
      ]);
      const middleNode = result.tree?.dependencies[0];
      expect(middleNode?.dependencies.map((entry) => `${entry.via}:${entry.id}`)).toEqual([`blocks:${leafId}`]);
      const missingNode = result.tree?.dependencies[1];
      expect(missingNode?.missing).toBe(true);

      const caseInsensitiveResult = await runDeps(rootId.toUpperCase(), { format: "tree" }, { path: context.pmPath });
      expect(caseInsensitiveResult.tree?.id).toBe(rootId);
      expect(caseInsensitiveResult.node_count).toBe(4);
    });
  });

  it("supports max-depth truncation for dense trees", async () => {
    await withTempPmPath(async (context) => {
      const leafId = createTask(context, "deps-depth-leaf");
      const middleId = createTask(context, "deps-depth-middle", [
        `id=${leafId},kind=blocks,author=test-author,created_at=now`,
      ]);
      const rootId = createTask(context, "deps-depth-root", [
        `id=${middleId},kind=blocks,author=test-author,created_at=now`,
      ]);

      const result = await runDeps(rootId, { format: "tree", maxDepth: "1" }, { path: context.pmPath });
      expect(result.format).toBe("tree");
      expect(result.tree?.id).toBe(rootId);
      expect(result.tree?.dependencies).toHaveLength(1);
      expect(result.tree?.dependencies[0]?.id).toBe(middleId);
      expect(result.tree?.dependencies[0]?.truncated).toBe(true);
      expect(result.tree?.dependencies[0]?.dependencies).toEqual([]);
      expect(result.node_count).toBe(2);
      expect(result.edge_count).toBe(1);
    });
  });

  it("collapses repeated subtrees when collapse mode is enabled", async () => {
    await withTempPmPath(async (context) => {
      const sharedLeafId = createTask(context, "deps-shared-leaf");
      const leftId = createTask(context, "deps-left", [`id=${sharedLeafId},kind=related,author=test-author,created_at=now`]);
      const rightId = createTask(context, "deps-right", [`id=${sharedLeafId},kind=related,author=test-author,created_at=now`]);
      const rootId = createTask(context, "deps-repeat-root", [
        `id=${leftId},kind=blocks,author=test-author,created_at=now`,
        `id=${rightId},kind=blocks,author=test-author,created_at=now`,
      ]);

      const result = await runDeps(rootId, { format: "tree", collapse: "repeated" }, { path: context.pmPath });
      const seenSharedLeafNodes: Array<{ collapsed?: boolean }> = [];
      type VisitNode = { id: string; collapsed?: boolean; dependencies: VisitNode[] };
      const visit = (node: VisitNode): void => {
        if (node.id === sharedLeafId) {
          seenSharedLeafNodes.push({ collapsed: node.collapsed });
        }
        for (const child of node.dependencies) {
          visit(child);
        }
      };
      if (result.tree) {
        visit(result.tree as VisitNode);
      }
      expect(seenSharedLeafNodes).toHaveLength(2);
      expect(seenSharedLeafNodes.filter((entry) => entry.collapsed === true)).toHaveLength(1);
    });
  });

  it("supports summary mode without full tree/graph payloads", async () => {
    await withTempPmPath(async (context) => {
      const rootId = createTask(context, "deps-summary-root");
      const result = await runDeps(rootId, { format: "tree", summary: true }, { path: context.pmPath });
      expect(result.node_count).toBe(1);
      expect(result.edge_count).toBe(0);
      expect(result.missing_count).toBe(0);
      expect(result.tree).toBeUndefined();
      expect(result.graph).toBeUndefined();
    });
  });

  it("counts shared summary graphs without materializing result payloads", async () => {
    await withTempPmPath(async (context) => {
      const sharedId = createTask(context, "deps-summary-shared", [
        "id=pm-summary-missing,kind=related,author=test-author,created_at=now",
      ]);
      const leftId = createTask(context, "deps-summary-left", [
        `id=${sharedId},kind=related,author=test-author,created_at=now`,
      ]);
      const rightId = createTask(context, "deps-summary-right", [
        `id=${sharedId},kind=related,author=test-author,created_at=now`,
      ]);
      const rootId = createTask(context, "deps-summary-dag", [
        `id=${leftId},kind=blocks,author=test-author,created_at=now`,
        `id=${rightId},kind=blocks,author=test-author,created_at=now`,
      ]);

      const full = await runDeps(rootId, { format: "graph", summary: true }, { path: context.pmPath });
      expect(full).toMatchObject({ node_count: 5, edge_count: 5, missing_count: 1 });
      expect(full.tree).toBeUndefined();
      expect(full.graph).toBeUndefined();

      const bounded = await runDeps(rootId, { summary: true, maxDepth: 1 }, { path: context.pmPath });
      expect(bounded).toMatchObject({ node_count: 3, edge_count: 2, missing_count: 0 });
    });
  });

  it("renders graph output for cycles without infinite recursion", async () => {
    await withTempPmPath(async (context) => {
      const upstreamId = createTask(context, "deps-cycle-upstream");
      const rootId = createTask(context, "deps-cycle-root", [
        `id=${upstreamId},kind=blocks,author=test-author,created_at=now`,
      ]);
      const update = context.runCli(
        [
          "update",
          upstreamId,
          "--json",
          "--dep",
          `id=${rootId},kind=related,author=test-author,created_at=now`,
          "--author",
          "test-author",
          "--message",
          "Create cycle for deps graph",
        ],
        { expectJson: true },
      );
      expect(update.code).toBe(0);

      const result = await runDeps(rootId, { format: "graph" }, { path: context.pmPath });
      expect(result.format).toBe("graph");
      expect(result.node_count).toBe(2);
      expect(result.edge_count).toBe(2);
      expect(result.missing_count).toBe(0);
      expect(result.graph?.nodes.map((node) => node.id)).toEqual([rootId, upstreamId].sort((left, right) => left.localeCompare(right)));
      const expectedEdges = [
        { from: rootId, to: upstreamId, kind: "blocks" },
        { from: upstreamId, to: rootId, kind: "related" },
      ].sort((left, right) => {
        const byFrom = left.from.localeCompare(right.from);
        if (byFrom !== 0) return byFrom;
        const byTo = left.to.localeCompare(right.to);
        if (byTo !== 0) return byTo;
        return left.kind.localeCompare(right.kind);
      });
      expect(result.graph?.edges).toEqual(expectedEdges);
    });
  });

  it("accepts numeric max-depth values and keeps deterministic ordering for duplicate dependency edges", async () => {
    await withTempPmPath(async (context) => {
      const targetId = createTask(context, "deps-order-target");
      const rootId = createTask(context, "deps-order-root", [
        `id=${targetId},kind=related,author=test-author,created_at=2026-01-02T00:00:00.000Z`,
        `id=${targetId},kind=related,author=test-author,created_at=2026-01-01T00:00:00.000Z`,
        `id=${targetId},kind=blocks,author=test-author,created_at=2026-01-03T00:00:00.000Z`,
      ]);

      const tree = await runDeps(rootId, { format: "tree", maxDepth: 1 as unknown as string }, { path: context.pmPath });
      expect(tree.tree?.dependencies.map((entry) => entry.via)).toEqual(["blocks", "related"]);

      const graph = await runDeps(rootId, { format: "graph" }, { path: context.pmPath });
      const edgeKinds = (graph.graph?.edges ?? [])
        .filter((edge) => edge.from === rootId && edge.to === targetId)
        .map((edge) => edge.kind);
      expect(edgeKinds).toEqual(["blocks", "related"]);
    });
  });
});
