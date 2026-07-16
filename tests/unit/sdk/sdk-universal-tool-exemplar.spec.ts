import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runUniversalToolCli } from "../../../docs/examples/sdk-custom-tool/src/cli.js";
import {
  readProjectedItemId,
  requireCreatedId,
  requireFinalStatus,
  runUniversalToolScenario,
  type UniversalToolScenarioResult,
} from "../../../docs/examples/sdk-custom-tool/src/index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("SDK-only universal project tool exemplar", () => {
  it("runs customization, lifecycle, context, graph, and governance without CLI imports", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pm-sdk-custom-tool-"));
    tempRoots.push(workspace);
    await writeFile(path.join(workspace, "README.md"), "# Custom tool workspace\n", "utf8");

    const result = await runUniversalToolScenario({
      workspace,
      author: "sdk-exemplar-test",
    });

    expect(result).toMatchObject({
      customType: "Deliverable",
      customStatus: "reviewing",
      projectStatus: "closed",
      claimedBy: "sdk-exemplar-test",
      releasedPreviousAssignee: "sdk-exemplar-test",
      commentCount: 1,
      noteCount: 1,
      learningCount: 1,
      linkedFileCount: 1,
      linkedDocCount: 1,
      dependencyEdges: 1,
      healthOk: true,
      historyDriftOk: true,
    });
    expect(result.projectId).toMatch(/^work-/);
    expect(result.childId).toMatch(/^work-/);
    expect(result.listedIds).toEqual(expect.arrayContaining([result.projectId, result.childId]));
    expect(result.searchedIds).toContain(result.projectId);
    expect(result.activeItemsBeforeClose).toBeGreaterThanOrEqual(2);
  });

  it("normalizes supported SDK projections and rejects missing lifecycle evidence", () => {
    expect(requireCreatedId({ item: { id: "work-parent" } }, "deliverable")).toBe("work-parent");
    expect(() => requireCreatedId({ item: undefined }, "deliverable")).toThrow(/deliverable/);
    expect(readProjectedItemId(null)).toBeUndefined();
    expect(readProjectedItemId({ id: "work-flat" })).toBe("work-flat");
    expect(readProjectedItemId({ item: { id: "work-nested" } })).toBe("work-nested");
    expect(readProjectedItemId({ item: { id: 3 } })).toBeUndefined();
    expect(requireFinalStatus("closed")).toBe("closed");
    expect(() => requireFinalStatus(undefined)).toThrow(/status is missing/);
  });

  it("adapts usage errors and successful scenarios to an executable contract", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const acceptedAuthors: string[] = [];
    const scenarioResult = {
      customType: "Deliverable",
      customStatus: "reviewing",
      projectId: "work-parent",
      childId: "work-child",
      projectStatus: "closed",
      claimedBy: "sdk-exemplar-test",
      releasedPreviousAssignee: "sdk-exemplar-test",
      listedIds: ["work-parent", "work-child"],
      searchedIds: ["work-parent"],
      activeItemsBeforeClose: 2,
      commentCount: 1,
      noteCount: 1,
      learningCount: 1,
      linkedFileCount: 1,
      linkedDocCount: 1,
      dependencyEdges: 1,
      healthOk: true,
      historyDriftOk: true,
    } satisfies UniversalToolScenarioResult;
    const runScenario = async ({ author }: { author: string }): Promise<UniversalToolScenarioResult> => {
      acceptedAuthors.push(author);
      return scenarioResult;
    };

    await expect(
      runUniversalToolCli([], undefined, (value) => output.push(value), (value) => errors.push(value), runScenario),
    ).resolves.toBe(2);
    await expect(
      runUniversalToolCli(
        ["/tmp/custom"],
        undefined,
        (value) => output.push(value),
        (value) => errors.push(value),
        runScenario,
      ),
    ).resolves.toBe(0);
    await expect(
      runUniversalToolCli(
        ["/tmp/custom"],
        "explicit-author",
        (value) => output.push(value),
        (value) => errors.push(value),
        runScenario,
      ),
    ).resolves.toBe(0);

    expect(errors).toEqual(["Usage: pm-custom <workspace>\n"]);
    expect(acceptedAuthors).toEqual(["pm-sdk-custom-tool", "explicit-author"]);
    expect(output).toHaveLength(2);
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject(scenarioResult);
  });

});
