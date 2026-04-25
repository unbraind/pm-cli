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

function getItemTests(context: TempPmContext, id: string): Array<{ command?: string }> {
  const result = context.runCli(["get", id, "--json"], { expectJson: true });
  expect(result.code).toBe(0);
  const item = (result.json as { item: { tests?: Array<{ command?: string }> } }).item;
  return Array.isArray(item.tests) ? item.tests : [];
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

  it("accepts rollback-only CLI invocations without misclassifying control flags as mutations", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createTask(context, "bulk-cli-rollback-a", {
        tags: "bulk-cli-rollback",
        description: "bulk cli rollback A",
      });
      const secondId = createTask(context, "bulk-cli-rollback-b", {
        tags: "bulk-cli-rollback",
        description: "bulk cli rollback B",
      });

      const applyResult = context.runCli(
        [
          "update-many",
          "--json",
          "--filter-tag",
          "bulk-cli-rollback",
          "--description",
          "bulk cli rollback updated",
          "--message",
          "bulk cli apply",
        ],
        { expectJson: true },
      );
      expect(applyResult.code).toBe(0);
      const checkpointId = (applyResult.json as { checkpoint?: { id?: string } }).checkpoint?.id;
      expect(typeof checkpointId).toBe("string");

      const rollbackResult = context.runCli(
        [
          "update-many",
          "--json",
          "--rollback",
          checkpointId as string,
          "--author",
          "rollback-author",
          "--message",
          "bulk cli rollback",
        ],
        { expectJson: true },
      );
      expect(rollbackResult.code).toBe(0);
      const rollbackJson = rollbackResult.json as {
        mode: string;
        rollback_checkpoint_id?: string;
        restored_count?: number;
      };
      expect(rollbackJson.mode).toBe("rollback");
      expect(rollbackJson.rollback_checkpoint_id).toBe(checkpointId);
      expect(rollbackJson.restored_count).toBe(2);
      expect(getItemDescription(context, firstId)).toBe("bulk cli rollback A");
      expect(getItemDescription(context, secondId)).toBe("bulk cli rollback B");
    });
  });

  it("treats linked-array mutation flags as actionable in dry-run and apply modes", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createTask(context, "bulk-linked-tests-a", { tags: "bulk-linked-tests" });
      const secondId = createTask(context, "bulk-linked-tests-b", { tags: "bulk-linked-tests" });
      const originalTestCommand = "command=node scripts/run-tests.mjs test -- tests/seed-a.spec.ts,scope=project,timeout_seconds=240";
      const replacementTestCommand =
        "command=node scripts/run-tests.mjs test -- tests/replaced.spec.ts,scope=project,timeout_seconds=240";

      const seed = context.runCli(
        ["update", firstId, "--json", "--test", originalTestCommand, "--message", "seed linked test"],
        { expectJson: true },
      );
      expect(seed.code).toBe(0);
      expect(getItemTests(context, firstId).map((entry) => entry.command)).toEqual([
        "node scripts/run-tests.mjs test -- tests/seed-a.spec.ts",
      ]);
      expect(getItemTests(context, secondId)).toEqual([]);

      const dryRun = await runUpdateMany(
        {
          list: {
            tag: "bulk-linked-tests",
            includeBody: true,
          },
          update: {
            replaceTests: true,
            test: [replacementTestCommand],
            message: "bulk linked tests dry-run",
          },
          dryRun: true,
        },
        { path: context.pmPath },
      );

      expect(dryRun.mode).toBe("dry_run");
      expect(dryRun.matched_count).toBe(2);
      expect(dryRun.item_plans?.every((row) => row.changes.some((change) => change.field === "tests"))).toBe(true);
      expect(getItemTests(context, firstId).map((entry) => entry.command)).toEqual([
        "node scripts/run-tests.mjs test -- tests/seed-a.spec.ts",
      ]);
      expect(getItemTests(context, secondId)).toEqual([]);

      const apply = await runUpdateMany(
        {
          list: {
            tag: "bulk-linked-tests",
            includeBody: true,
          },
          update: {
            replaceTests: true,
            test: [replacementTestCommand],
            message: "bulk linked tests apply",
          },
        },
        { path: context.pmPath },
      );

      expect(apply.mode).toBe("apply");
      expect(apply.matched_count).toBe(2);
      expect(apply.updated_count).toBe(2);
      expect(apply.skipped_count).toBe(0);
      expect(apply.failed_count).toBe(0);
      expect(getItemTests(context, firstId).map((entry) => entry.command)).toEqual([
        "node scripts/run-tests.mjs test -- tests/replaced.spec.ts",
      ]);
      expect(getItemTests(context, secondId).map((entry) => entry.command)).toEqual([
        "node scripts/run-tests.mjs test -- tests/replaced.spec.ts",
      ]);
    });
  });
});
