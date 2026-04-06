import { describe, expect, it } from "vitest";
import { runUpdateMany } from "../../src/cli/commands/update-many.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

interface CreateTaskOptions {
  tags?: string;
  assignee?: string;
  description?: string;
}

function createTask(context: TempPmContext, title: string, options: CreateTaskOptions = {}): string {
  const args = [
    "create",
    "--json",
    "--title",
    title,
    "--description",
    options.description ?? `${title} description`,
    "--type",
    "Task",
    "--create-mode",
    "progressive",
    "--status",
    "open",
    "--priority",
    "1",
    "--tags",
    options.tags ?? "update-many,unit",
    "--body",
    "",
    "--deadline",
    "2026-03-01T00:00:00.000Z",
    "--estimate",
    "30",
    "--acceptance-criteria",
    `${title} acceptance`,
    "--author",
    "seed-author",
    "--message",
    `Create ${title}`,
  ];
  if (options.assignee !== undefined) {
    args.push("--assignee", options.assignee);
  }
  const created = context.runCli(args, { expectJson: true });
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

function getItemDescription(context: TempPmContext, id: string): string {
  const result = context.runCli(["get", id, "--json"], { expectJson: true });
  expect(result.code).toBe(0);
  return String((result.json as { item: { description: string } }).item.description);
}

describe("runUpdateMany", () => {
  it("produces dry-run plans without mutating matched items", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createTask(context, "bulk-dry-run-a", { tags: "bulk-dry-run" });
      createTask(context, "bulk-dry-run-b", { tags: "bulk-dry-run" });

      const beforeDescription = getItemDescription(context, firstId);
      const result = await runUpdateMany(
        {
          list: {
            tag: "bulk-dry-run",
            includeBody: true,
          },
          update: {
            description: "planned description update",
            message: "dry-run test",
          },
          dryRun: true,
        },
        { path: context.pmPath },
      );

      expect(result.mode).toBe("dry_run");
      expect(result.dry_run).toBe(true);
      expect(result.matched_count).toBe(2);
      expect(result.ids).toEqual([]);
      expect(result.item_plans?.every((row) => row.changes.length > 0)).toBe(true);
      expect(getItemDescription(context, firstId)).toBe(beforeDescription);
    });
  });

  it("applies bulk updates with checkpoint creation and supports rollback", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createTask(context, "bulk-apply-a", {
        tags: "bulk-apply",
        description: "bulk apply A",
      });
      const secondId = createTask(context, "bulk-apply-b", {
        tags: "bulk-apply",
        assignee: "foreign-assignee",
        description: "bulk apply B",
      });

      const apply = await runUpdateMany(
        {
          list: {
            tag: "bulk-apply",
            includeBody: true,
          },
          update: {
            description: "bulk applied description",
            allowAuditUpdate: true,
            message: "bulk apply command",
          },
        },
        { path: context.pmPath },
      );

      expect(apply.mode).toBe("apply");
      expect(apply.updated_count).toBe(2);
      expect(apply.failed_count).toBe(0);
      expect(apply.checkpoint?.id).toBeTruthy();
      expect(apply.ids).toEqual(expect.arrayContaining([firstId, secondId]));
      expect(getItemDescription(context, firstId)).toBe("bulk applied description");
      expect(getItemDescription(context, secondId)).toBe("bulk applied description");

      const checkpointId = apply.checkpoint?.id;
      expect(checkpointId).toBeTruthy();
      const rollback = await runUpdateMany(
        {
          list: {},
          update: {
            author: "rollback-author",
            message: "rollback bulk apply",
          },
          rollback: checkpointId,
        },
        { path: context.pmPath },
      );

      expect(rollback.mode).toBe("rollback");
      expect(rollback.restored_count).toBe(2);
      expect(rollback.failed_count).toBe(0);
      expect(getItemDescription(context, firstId)).toBe("bulk apply A");
      expect(getItemDescription(context, secondId)).toBe("bulk apply B");
    });
  });

  it("rejects rollback mode when mutation flags are also provided", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runUpdateMany(
          {
            list: {},
            update: {
              description: "should not be accepted with rollback",
            },
            rollback: "checkpoint-1",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });
});
