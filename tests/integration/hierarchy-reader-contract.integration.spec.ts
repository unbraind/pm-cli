import { describe, expect, it } from "vitest";
import { runGet } from "../../src/cli/commands/get.js";
import { runGraph } from "../../src/cli/commands/graph.js";
import { runList } from "../../src/cli/commands/list.js";
import { BUILTIN_RELATIONSHIP_KINDS } from "../../src/sdk/relationship-kinds/contract.js";
import type { GraphTraversalResult } from "../../src/sdk/graph/run.js";
import {
  withTempPmPath,
  type TempPmContext,
} from "../helpers/withTempPmPath.js";

function createTask(context: TempPmContext, id: string): void {
  const result = context.runCli(
    [
      "create",
      "--id",
      id,
      "--title",
      id,
      "--description",
      `Hierarchy reader fixture ${id}`,
      "--type",
      "Task",
      "--status",
      "open",
      "--json",
    ],
    { expectJson: true },
  );
  expect(result.code).toBe(0);
}

describe("registry-driven hierarchy readers", () => {
  it("gives list, get tree, child rollups, and graph traversal one answer for every accepted hierarchy spelling", async () => {
    await withTempPmPath(async (context) => {
      const rootId = "pm-hierarchy-root";
      createTask(context, rootId);
      const hierarchyInputs = BUILTIN_RELATIONSHIP_KINDS.filter(
        (definition) => definition.hierarchy,
      ).flatMap((definition) =>
        [definition.kind, ...(definition.aliases ?? [])].map((kind) => ({
          definition,
          kind,
        })),
      );
      const childIds: string[] = [];
      for (const [index, { definition, kind }] of hierarchyInputs.entries()) {
        const childId = `pm-hierarchy-child-${index}`;
        childIds.push(childId);
        createTask(context, childId);
        const holderId =
          definition.hierarchyDirection === "source_parent" ? rootId : childId;
        const targetId = holderId === rootId ? childId : rootId;
        const result = context.runCli(
          [
            "update",
            holderId,
            "--dep",
            `id=${targetId},kind=${kind},author=reader-contract,created_at=2026-08-21T00:00:00.000Z`,
            "--json",
          ],
          { expectJson: true },
        );
        expect(result.code).toBe(0);
      }

      const listed = await runList(
        undefined,
        { parent: rootId, full: true, noTruncate: true },
        { path: context.pmPath },
      );
      expect(listed.items.map((item) => item.id).sort()).toEqual(
        [...childIds].sort(),
      );

      const tree = await runGet(
        rootId,
        { path: context.pmPath },
        { tree: true },
      );
      expect(tree.tree?.items.map((item) => item.id).sort()).toEqual(
        [...childIds].sort(),
      );
      const rollup = await runGet(
        rootId,
        { path: context.pmPath },
        { fields: "id,children" },
      );
      expect(rollup.children?.count).toBe(childIds.length);

      const descendants = (await runGraph(
        "descendants",
        rootId,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphTraversalResult;
      expect(descendants.ids.sort()).toEqual([...childIds].sort());
      for (const childId of childIds) {
        const ancestors = (await runGraph(
          "ancestors",
          childId,
          undefined,
          {},
          { path: context.pmPath },
        )) as GraphTraversalResult;
        const childDescendants = (await runGraph(
          "descendants",
          childId,
          undefined,
          {},
          { path: context.pmPath },
        )) as GraphTraversalResult;
        expect(ancestors.ids).toContain(rootId);
        expect(childDescendants.ids).not.toContain(rootId);
        expect(
          ancestors.ids.filter((id) => childDescendants.ids.includes(id)),
        ).toEqual([]);
      }
    });
  });
});
