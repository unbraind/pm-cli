import { describe, expect, it } from "vitest";
import { runDeps } from "../../src/cli/commands/deps.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

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
});
