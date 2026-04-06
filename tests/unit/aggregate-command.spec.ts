import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAggregate } from "../../src/cli/commands/aggregate.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createItem(
  context: TempPmContext,
  params: {
    title: string;
    type: "Feature" | "Task" | "Issue" | "Chore";
    status: "open" | "closed";
    parent?: string;
  },
): string {
  const args = [
    "create",
    "--json",
    "--title",
    params.title,
    "--description",
    `${params.title} description`,
    "--type",
    params.type,
    "--status",
    params.status,
    "--priority",
    "1",
    "--tags",
    "aggregate,unit",
    "--body",
    "",
    "--deadline",
    "none",
    "--estimate",
    "15",
    "--acceptance-criteria",
    `${params.title} acceptance`,
    "--author",
    "test-author",
    "--message",
    `Create ${params.title}`,
    "--assignee",
    "none",
    "--dep",
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
  if (params.parent) {
    args.push("--parent", params.parent);
  }
  const created = context.runCli(args, { expectJson: true });
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

describe("runAggregate", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-aggregate-not-init-"));
    try {
      await expect(runAggregate({ groupBy: "parent,type", count: true }, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("groups child counts by parent and type", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createItem(context, {
        title: "Aggregate Parent Feature",
        type: "Feature",
        status: "open",
      });
      createItem(context, {
        title: "Aggregate Child Task A",
        type: "Task",
        status: "open",
        parent: parentId,
      });
      createItem(context, {
        title: "Aggregate Child Task B",
        type: "Task",
        status: "closed",
        parent: parentId,
      });
      createItem(context, {
        title: "Aggregate Child Issue",
        type: "Issue",
        status: "open",
        parent: parentId,
      });
      createItem(context, {
        title: "Unparented Task",
        type: "Task",
        status: "open",
      });

      const result = await runAggregate(
        {
          groupBy: "parent,type",
          count: true,
        },
        { path: context.pmPath },
      );

      expect(result.filters.group_by).toEqual(["parent", "type"]);
      expect(result.count).toBe(2);
      expect(result.groups).toEqual([
        {
          group: {
            parent: parentId,
            type: "Issue",
          },
          count: 1,
        },
        {
          group: {
            parent: parentId,
            type: "Task",
          },
          count: 2,
        },
      ]);
      expect(result.totals.items_considered).toBe(5);
      expect(result.totals.items_skipped_unparented).toBe(2);
      expect(result.totals.items_grouped).toBe(3);
    });
  });

  it("includes unparented groups when includeUnparented is enabled", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createItem(context, {
        title: "Aggregate Parent",
        type: "Feature",
        status: "open",
      });
      createItem(context, {
        title: "Parented Child Task",
        type: "Task",
        status: "open",
        parent: parentId,
      });
      createItem(context, {
        title: "Unparented Task",
        type: "Task",
        status: "open",
      });

      const result = await runAggregate(
        {
          groupBy: "parent,type",
          count: true,
          includeUnparented: true,
          type: "Task",
        },
        { path: context.pmPath },
      );

      expect(result.count).toBe(2);
      expect(result.groups).toEqual([
        {
          group: {
            parent: parentId,
            type: "Task",
          },
          count: 1,
        },
        {
          group: {
            parent: null,
            type: "Task",
          },
          count: 1,
        },
      ]);
      expect(result.totals.items_skipped_unparented).toBe(0);
      expect(result.totals.items_grouped).toBe(2);
    });
  });

  it("validates required and supported options", async () => {
    await withTempPmPath(async (context) => {
      await expect(runAggregate({ groupBy: "parent,type" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runAggregate(
          {
            groupBy: "parent,unknown",
            count: true,
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runAggregate({ count: true, status: "invalid-status" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>(
        {
          exitCode: EXIT_CODE.USAGE,
        },
      );
    });
  });
});
