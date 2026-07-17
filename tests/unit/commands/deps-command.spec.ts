import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runDeps } from "../../../src/cli/commands/deps.js";
import { runGraph } from "../../../src/cli/commands/graph.js";
import { buildDepsRelationshipContext } from "../../../src/sdk/dependencies.js";
import { collectDanglingDependencyReferences } from "../../../src/sdk/graph/assembly.js";
import { resetWorkspaceGraphCache } from "../../../src/sdk/graph/cache.js";
import type { GraphAuditResult } from "../../../src/sdk/graph/run.js";
import type { ItemMetadata } from "../../../src/types/index.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { locateItem, readLocatedItem } from "../../../src/core/store/item-store.js";
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
  it("normalizes canonical and missing parent, blocker, and dependency references for context", () => {
    const context = buildDepsRelationshipContext(
      "pm-root",
      [
        {
          id: "pm-root",
          title: "Root",
          status: "open",
          parent: "PM-PARENT",
          blocked_by: "pm-missing-blocker",
          dependencies: [
            { id: "PM-PARENT", kind: "related" },
            { id: "pm-missing-related", kind: "related" },
            { id: "pm-missing-related", kind: "blocks" },
          ],
        },
        { id: "pm-parent", title: "Parent", status: "open" },
        { id: "pm-orphan", title: "Orphan", status: "open", parent: "pm-missing-parent" },
      ] as unknown as ItemMetadata[],
      {},
    );

    expect(context.nodes.map(({ id }) => id)).toEqual([
      "pm-missing-blocker",
      "pm-missing-related",
      "pm-parent",
    ]);
    expect(context.nodes.filter(({ status }) => status === "missing").map(({ id }) => id)).toEqual([
      "pm-missing-blocker",
      "pm-missing-related",
    ]);

    const sentinel = buildDepsRelationshipContext(
      "pm-sentinel",
      [{
        id: "pm-sentinel",
        title: "Sentinel",
        status: "open",
        parent: "no-active-blocker",
        blocked_by: "no-active-blocker",
        dependencies: [{ id: "no-active-blocker", kind: "related" }],
      }] as ItemMetadata[],
      {},
    );
    expect(sentinel.nodes).toEqual([]);
    expect(sentinel.edges).toEqual([]);

    const malformed = buildDepsRelationshipContext(
      "pm-malformed",
      [{
        id: "pm-malformed",
        title: "Malformed",
        status: "open",
        parent: 42,
        blocked_by: false,
        dependencies: [null, true, { id: true }, { id: "none" }, { id: "pm-missing-default" }],
      }] as unknown as ItemMetadata[],
      {},
    );
    expect(malformed.nodes).toEqual([
      expect.objectContaining({ id: "pm-missing-default", status: "missing" }),
    ]);
  });

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
      const located = await locateItem(context.pmPath, rootId);
      expect(located).not.toBeNull();
      if (!located) return;
      const { raw } = await readLocatedItem(located);
      await writeFile(
        located.itemPath,
        raw.replace("pm-missing-dependency,related", "pm-missing-dependency,RELATED"),
        "utf8",
      );

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

  it("projects a dangling parent reference as a typed missing edge", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createTask(context, "deps-parent-to-delete");
      const child = context.runCli(
        ["create", "deps-child", "--type", "Task", "--parent", parentId, "--json"],
        { expectJson: true },
      );
      const childId = (child.json as { item: { id: string } }).item.id;
      expect(
        context.runCli(["delete", parentId, "--force", "--json"], {
          expectJson: true,
        }).code,
      ).toBe(0);

      const result = await runDeps(childId, { format: "tree" }, { path: context.pmPath });
      expect(result).toMatchObject({ missing_count: 1 });
      expect(result.tree?.dependencies).toEqual([
        expect.objectContaining({ id: parentId, via: "parent", missing: true }),
      ]);
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

  it("returns bounded explainable relationship context through deps", async () => {
    await withTempPmPath(async (context) => {
      const prerequisiteId = createTask(context, "context-prerequisite");
      const rootId = createTask(context, "context-root", [
        `id=${prerequisiteId},kind=blocked_by,author=test-author,created_at=now`,
      ]);
      const result = await runDeps(rootId, {
        format: "context",
        maxDepth: 2,
        nodeLimit: "5",
        edgeLimit: "5",
        tokenBudget: "500",
      }, { path: context.pmPath });

      expect(result).toMatchObject({ id: rootId, format: "context", node_count: 2, edge_count: 1, missing_count: 0 });
      expect(result.context).toMatchObject({
        root: { id: rootId, title: "context-root", status: "open" },
        nodes: [{ id: prerequisiteId, reasons: ["prerequisite"] }],
        meta: { exact: true, truncated: false, nodeLimit: 5, edgeLimit: 5, tokenBudget: 500 },
      });

      const defaults = await runDeps(rootId, { format: "context" }, { path: context.pmPath });
      expect(defaults.context?.meta).toMatchObject({ nodeLimit: 20, edgeLimit: 40, tokenBudget: 1200 });
      createTask(context, "context-dependent", [
        `id=${rootId},kind=blocked_by,author=test-author,created_at=now`,
      ]);
      const oneNode = await runDeps(rootId, { format: "context", nodeLimit: 1, maxDepth: 2 }, { path: context.pmPath });
      expect(oneNode.context?.meta.nextCursor).toEqual(expect.any(String));
      const continued = await runDeps(rootId, { format: "context", nodeLimit: 1, maxDepth: 2, cursor: oneNode.context!.meta.nextCursor, summary: true }, { path: context.pmPath });
      expect(continued.context).toBeUndefined();
      await expect(runDeps(rootId, { format: "context", nodeLimit: 0 }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      const danglingId = createTask(context, "context-dangling", [
        "id=pm-missing-prerequisite,kind=blocked_by,author=test-author,created_at=now",
      ]);
      const dangling = await runDeps(danglingId, { format: "context" }, { path: context.pmPath });
      expect(dangling).toMatchObject({ missing_count: 1, node_count: 2, edge_count: 1 });
      expect(dangling.context?.nodes).toEqual([
        expect.objectContaining({ id: "pm-missing-prerequisite", status: "missing", reasons: ["prerequisite"] }),
      ]);
    });
  });

  it("shares the fingerprint-keyed workspace assembly with pm graph", async () => {
    await withTempPmPath(async (context) => {
      const rootId = createTask(context, "cache-shared-root");
      resetWorkspaceGraphCache();
      const packet = await runDeps(
        rootId,
        { format: "context" },
        { path: context.pmPath },
      );
      expect(packet.format).toBe("context");
      // The deps context call populated the shared graph cache, so a graph
      // query over the unchanged workspace reuses the same assembly.
      const audit = (await runGraph(
        "audit",
        undefined,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphAuditResult;
      expect(audit.cache).toMatchObject({ assembly: "hit", result: "miss" });
    });
  });

  it("controls context traversal with direction and kind filters shared across surfaces", async () => {
    await withTempPmPath(async (context) => {
      const prerequisiteId = createTask(context, "ctxdir-prerequisite");
      const rootId = createTask(context, "ctxdir-root", [
        `id=${prerequisiteId},kind=blocked_by,author=test-author,created_at=now`,
      ]);
      const dependentId = createTask(context, "ctxdir-dependent", [
        `id=${rootId},kind=blocked_by,author=test-author,created_at=now`,
      ]);
      const child = context.runCli(
        ["create", "ctxdir-child", "--type", "Task", "--parent", rootId, "--json"],
        { expectJson: true },
      );
      const childId = (child.json as { item: { id: string } }).item.id;

      const both = await runDeps(rootId, { format: "context" }, { path: context.pmPath });
      expect(both.context?.summary).toMatchObject({
        rootId,
        rootStatus: "open",
        directEdges: {
          prerequisite: 1,
          dependent: 1,
          ancestor: 0,
          descendant: 1,
          provenance: 0,
          related: 0,
        },
        directTotal: 3,
        hasMore: false,
      });
      expect(both.context?.nodes.map(({ id, role }) => `${id}:${role}`).sort()).toEqual(
        [
          `${prerequisiteId}:prerequisite`,
          `${dependentId}:dependent`,
          `${childId}:descendant`,
        ].sort(),
      );

      const outgoing = await runDeps(
        rootId,
        { format: "context", direction: "outgoing" },
        { path: context.pmPath },
      );
      expect(outgoing.context?.nodes.map(({ id }) => id)).toEqual([prerequisiteId]);

      const incoming = await runDeps(
        rootId,
        { format: "context", direction: "incoming" },
        { path: context.pmPath },
      );
      expect(incoming.context?.nodes.map(({ id }) => id).sort()).toEqual(
        [dependentId, childId].sort(),
      );

      const parentOnly = await runDeps(
        rootId,
        { format: "context", kind: ["parent"] },
        { path: context.pmPath },
      );
      expect(parentOnly.context?.nodes.map(({ id }) => id)).toEqual([childId]);

      const aliasCsv = await runDeps(
        rootId,
        { format: "context", kind: "depends_on,related" },
        { path: context.pmPath },
      );
      expect(aliasCsv.context?.nodes.map(({ id }) => id).sort()).toEqual(
        [prerequisiteId, dependentId].sort(),
      );

      const blankKinds = await runDeps(
        rootId,
        { format: "context", kind: [" , "] },
        { path: context.pmPath },
      );
      expect(blankKinds.context?.nodes).toHaveLength(3);

      await expect(
        runDeps(rootId, { format: "context", direction: "sideways" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runDeps(rootId, { format: "context", kind: "ownz" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("promotes bounded root evidence pointers into context packets", async () => {
    await withTempPmPath(async (context) => {
      const rootId = createTask(context, "ctxev-root");
      expect(
        context.runCli(["files", rootId, "--add", "src/example.ts", "--json"], {
          expectJson: true,
        }).code,
      ).toBe(0);
      expect(
        context.runCli(["docs", rootId, "--add", "docs/example.md", "--json"], {
          expectJson: true,
        }).code,
      ).toBe(0);
      expect(
        context.runCli(["test", rootId, "--add", "command=echo ok", "--json"], {
          expectJson: true,
        }).code,
      ).toBe(0);
      expect(
        context.runCli(["comments", rootId, "--add", "evidence trail", "--json"], {
          expectJson: true,
        }).code,
      ).toBe(0);

      const result = await runDeps(rootId, { format: "context" }, { path: context.pmPath });
      expect(result.context?.evidence).toEqual([
        "linked:files=1,tests=1,docs=1,comments=1,notes=0,learnings=0",
        "file:src/example.ts",
        "test:echo ok",
        "doc:docs/example.md",
      ]);
      expect(result.context?.summary.evidenceCount).toBe(4);

      const bareId = createTask(context, "ctxev-bare");
      const bare = await runDeps(bareId, { format: "context" }, { path: context.pmPath });
      expect(bare.context?.evidence).toEqual([]);

      // Legacy stores can hold linked tests with a path but no command, or
      // with neither; the pointer projection falls back and then skips.
      const located = await locateItem(context.pmPath, rootId);
      expect(located).not.toBeNull();
      if (!located) return;
      const { raw } = await readLocatedItem(located);
      await writeFile(
        located.itemPath,
        raw.replace(
          "tests[1]{command,scope}:\n  echo ok,project",
          "tests[1]{path,scope}:\n  tests/example.spec.ts,project",
        ),
        "utf8",
      );
      const pathOnly = await runDeps(rootId, { format: "context" }, { path: context.pmPath });
      expect(pathOnly.context?.evidence).toContain("test:tests/example.spec.ts");
      await writeFile(
        located.itemPath,
        raw.replace(
          "tests[1]{command,scope}:\n  echo ok,project",
          "tests[1]{scope}:\n  project",
        ),
        "utf8",
      );
      const pointerless = await runDeps(rootId, { format: "context" }, { path: context.pmPath });
      expect(pointerless.context?.evidence).toEqual([
        "linked:files=1,tests=1,docs=1,comments=1,notes=0,learnings=0",
        "file:src/example.ts",
        "doc:docs/example.md",
      ]);

      const summaryOnly = await runDeps(
        rootId,
        { format: "context", summary: true },
        { path: context.pmPath },
      );
      expect(summaryOnly.context).toBeUndefined();
    });
  });

  it("enumerates traversal-scoped missing references and agrees with tree semantics", async () => {
    await withTempPmPath(async (context) => {
      const rootId = createTask(context, "ctxmiss-root", [
        "id=pm-ctxmiss-gone,kind=blocked_by,author=test-author,created_at=now",
        "id=pm-ctxmiss-lost,kind=related,author=test-author,created_at=now",
      ]);

      const result = await runDeps(rootId, { format: "context" }, { path: context.pmPath });
      expect(result).toMatchObject({
        missing_count: 2,
        missing_scope: "traversal",
        missing_reference_count: 2,
      });
      expect(result.missing_references).toEqual([
        expect.objectContaining({
          holder_id: rootId,
          target_id: "pm-ctxmiss-gone",
          kind: "blocked_by",
          source: "dependency",
          legacy_terminal: false,
        }),
        expect.objectContaining({
          holder_id: rootId,
          target_id: "pm-ctxmiss-lost",
          kind: "related",
          legacy_terminal: false,
        }),
      ]);

      const tree = await runDeps(rootId, { format: "tree" }, { path: context.pmPath });
      expect(tree.missing_count).toBe(result.missing_count);

      const bounded = await runDeps(
        rootId,
        { format: "context", edgeLimit: 1 },
        { path: context.pmPath },
      );
      expect(bounded.missing_reference_count).toBe(2);
      expect(bounded.missing_references).toHaveLength(1);

      const paged = await runDeps(
        rootId,
        { format: "context", nodeLimit: 1 },
        { path: context.pmPath },
      );
      expect(paged.missing_count).toBe(2);

      // Directed blocked_by edges drop out of an incoming-only traversal while
      // the undirected related edge still reaches its missing target.
      const incomingOnly = await runDeps(
        rootId,
        { format: "context", direction: "incoming" },
        { path: context.pmPath },
      );
      expect(incomingOnly).toMatchObject({
        missing_count: 1,
        missing_reference_count: 1,
      });
      expect(incomingOnly.missing_references).toEqual([
        expect.objectContaining({ target_id: "pm-ctxmiss-lost", kind: "related" }),
      ]);

      const summaryOnly = await runDeps(
        rootId,
        { format: "context", summary: true },
        { path: context.pmPath },
      );
      expect(summaryOnly.missing_reference_count).toBe(2);
      expect(summaryOnly.missing_references).toBeUndefined();
    });
  });

  it("filters duplicate missing-reference rows by the active relationship kind", async () => {
    await withTempPmPath(async (context) => {
      const rootId = createTask(context, "ctxmiss-filtered-root", [
        "id=pm-ctxmiss-shared,kind=blocked_by,author=test-author,created_at=now",
        "id=pm-ctxmiss-shared,kind=related,author=test-author,created_at=now",
      ]);
      const located = await locateItem(context.pmPath, rootId);
      expect(located).not.toBeNull();
      if (!located) return;
      const { raw } = await readLocatedItem(located);
      const relatedRow = raw
        .split("\n")
        .find((line) => line.includes("pm-ctxmiss-shared,related,"));
      const blockedRow = raw
        .split("\n")
        .find((line) => line.includes("pm-ctxmiss-shared,blocked_by,"));
      expect(relatedRow).toBeDefined();
      expect(blockedRow).toBeDefined();
      if (!relatedRow || !blockedRow) return;
      await writeFile(
        located.itemPath,
        raw
          .replace("dependencies[2]", "dependencies[4]")
          .replace(
            relatedRow,
            `${relatedRow}\n${relatedRow.replace(",related,", ",custom_unknown,")}`,
          )
          .replace(
            blockedRow,
            `${blockedRow}\n${blockedRow.replace(",blocked_by,", ",depends_on,")}`,
          ),
        "utf8",
      );

      const result = await runDeps(
        rootId,
        { format: "context", kind: "blocked_by" },
        { path: context.pmPath },
      );
      expect(result).toMatchObject({
        missing_count: 1,
        missing_reference_count: 2,
      });
      expect(result.missing_references).toEqual([
        expect.objectContaining({
          target_id: "pm-ctxmiss-shared",
          kind: "blocked_by",
        }),
        expect.objectContaining({
          target_id: "pm-ctxmiss-shared",
          kind: "depends_on",
        }),
      ]);
      const inverse = await runDeps(
        rootId,
        { format: "context", kind: "blocks" },
        { path: context.pmPath },
      );
      expect(inverse.missing_references).toEqual(result.missing_references);
    });
  });

  it("classifies missing references on terminal holders as legacy and skips sentinels", async () => {
    await withTempPmPath(async (context) => {
      const holderId = createTask(context, "ctxlegacy-holder", [
        "id=pm-ctxlegacy-gone,kind=related,author=test-author,created_at=now",
      ]);
      const rootId = createTask(context, "ctxlegacy-root", [
        `id=${holderId},kind=related,author=test-author,created_at=now`,
      ]);
      expect(
        context.runCli(
          ["close", holderId, "verified legacy classification fixture", "--json"],
          { expectJson: true },
        ).code,
      ).toBe(0);

      const result = await runDeps(rootId, { format: "context" }, { path: context.pmPath });
      expect(result.missing_references).toEqual([
        expect.objectContaining({
          holder_id: holderId,
          target_id: "pm-ctxlegacy-gone",
          legacy_terminal: true,
          holder_status: "closed",
        }),
      ]);

      // Create-time id normalization prefixes bare targets, so write the raw
      // legacy sentinel form directly like historical pre-structured items.
      const sentinelId = createTask(context, "ctxlegacy-sentinel", [
        "id=pm-no-active-blocker,kind=blocked_by,author=test-author,created_at=now",
      ]);
      const located = await locateItem(context.pmPath, sentinelId);
      expect(located).not.toBeNull();
      if (!located) return;
      const { raw } = await readLocatedItem(located);
      await writeFile(
        located.itemPath,
        raw.replace("pm-no-active-blocker", "no-active-blocker"),
        "utf8",
      );
      const sentinel = await runDeps(sentinelId, { format: "context" }, { path: context.pmPath });
      expect(sentinel).toMatchObject({
        missing_count: 0,
        missing_reference_count: 0,
        missing_references: [],
      });
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
      const located = await locateItem(context.pmPath, rootId);
      expect(located).not.toBeNull();
      if (!located) return;
      const { raw } = await readLocatedItem(located);
      await writeFile(located.itemPath, raw.replace(targetId, targetId.toUpperCase()), "utf8");

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
