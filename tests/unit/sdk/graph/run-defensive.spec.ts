import { describe, expect, it, vi } from "vitest";
import { runGraph } from "../../../../src/sdk/graph/run.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

vi.mock("../../../../src/sdk/graph/traversal.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../src/sdk/graph/traversal.js")
    >();
  return {
    ...actual,
    hierarchyAncestors: () => {
      throw new Error("kernel exploded");
    },
  };
});

describe("runGraph defensive error handling", () => {
  it("rethrows non-TypeError kernel failures unchanged instead of masking them as usage", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Defensive graph target",
          "--description",
          "Defensive graph target description",
          "--type",
          "Task",
          "--status",
          "open",
          "--author",
          "graph-spec",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;
      await expect(
        runGraph("ancestors", id, undefined, {}, { path: context.pmPath }),
      ).rejects.toThrow("kernel exploded");
    });
  });
});
