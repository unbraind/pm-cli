import { describe, expect, it, vi } from "vitest";
import { runGraph } from "../../../../src/sdk/graph/run.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const kernelFailure = vi.hoisted(() => new Error("kernel exploded"));

vi.mock("../../../../src/sdk/graph/traversal.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../src/sdk/graph/traversal.js")
    >();
  return {
    ...actual,
    hierarchyAncestors: () => {
      throw kernelFailure;
    },
  };
});

vi.mock("../../../../src/sdk/graph/analytics.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../src/sdk/graph/analytics.js")
    >();
  return {
    ...actual,
    // Non-convergence is not constructible from a small deterministic
    // workspace, so the envelope's iteration-bound truncation path is
    // exercised through a stubbed analysis instead.
    detectRelationshipCommunities: () => ({
      value: { communities: [], iterations: 16, converged: false },
      meta: { visitedNodes: 3, inspectedEdges: 4, truncated: true },
    }),
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
      // The exact thrown instance must surface — remapping it to a usage
      // error with the same message would break this identity check.
      await expect(
        runGraph("ancestors", id, undefined, {}, { path: context.pmPath }),
      ).rejects.toBe(kernelFailure);
    });
  });

  it("marks the communities envelope truncated when propagation never converges", async () => {
    await withTempPmPath(async (context) => {
      const communities = (await runGraph(
        "communities",
        undefined,
        undefined,
        {},
        { path: context.pmPath },
      )) as { converged: boolean; truncated: boolean; community_count: number };
      expect(communities.converged).toBe(false);
      expect(communities.truncated).toBe(true);
      expect(communities.community_count).toBe(0);
    });
  });
});
