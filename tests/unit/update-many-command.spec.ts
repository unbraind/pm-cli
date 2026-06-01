import { describe, expect, it } from "vitest";
import { runUpdateMany } from "../../src/cli/commands/update-many.js";
import { matchesRuntimeFilters } from "../../src/core/schema/runtime-field-filters.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
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
  const result = context.runCli(["get", id, "--full", "--json"], { expectJson: true });
  expect(result.code).toBe(0);
  const item = (result.json as { item: { tests?: Array<{ command?: string }> } }).item;
  return Array.isArray(item.tests) ? item.tests : [];
}

describe("runUpdateMany", () => {
  it("matches object-valued runtime filters without depending on key insertion order", () => {
    expect(
      matchesRuntimeFilters(
        { payload: { b: 2, a: 1 } },
        { payload: { a: 1, b: 2 } },
      ),
    ).toBe(true);
  });

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

  it("returns actionable mutation-flag guidance when no update flags are provided", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "bulk-no-mutation-guidance");
      await expect(
        runUpdateMany(
          {
            list: {
              tag: "update-many,unit",
            },
            update: {},
            dryRun: true,
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--status"),
      });
      await expect(
        runUpdateMany(
          {
            list: {
              tag: "update-many,unit",
            },
            update: {},
            dryRun: true,
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        message: expect.stringContaining("--replace-tests"),
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

  it("supports --add-tags and --remove-tags from CLI wiring (pm-1lws)", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createTask(context, "bulk-tags-a", { tags: "bulk-tags,legacy" });
      const secondId = createTask(context, "bulk-tags-b", { tags: "bulk-tags,legacy" });

      const updateResult = context.runCli(
        [
          "update-many",
          "--json",
          "--filter-tag",
          "bulk-tags",
          "--add-tags",
          "fix,security",
          "--remove-tags",
          "legacy",
          "--message",
          "bulk additive tag mutation",
        ],
        { expectJson: true },
      );
      expect(updateResult.code).toBe(0);
      const updateJson = updateResult.json as { updated_count?: number; failed_count?: number };
      expect(updateJson.updated_count).toBe(2);
      expect(updateJson.failed_count).toBe(0);

      const first = context.runCli(["get", firstId, "--json"], { expectJson: true });
      const second = context.runCli(["get", secondId, "--json"], { expectJson: true });
      expect((first.json as { item: { tags?: string[] } }).item.tags).toEqual(["bulk-tags", "fix", "security"]);
      expect((second.json as { item: { tags?: string[] } }).item.tags).toEqual(["bulk-tags", "fix", "security"]);
    });
  });

  it("treats --add-tags alone as actionable and previews the tag plan (pm-1lws)", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createTask(context, "addonly-a", { tags: "addonly" });
      createTask(context, "addonly-b", { tags: "addonly" });

      const dryRun = context.runCli(
        ["update-many", "--json", "--filter-tag", "addonly", "--add-tags", "batch", "--dry-run"],
        { expectJson: true },
      );
      expect(dryRun.code).toBe(0);
      const plans = (dryRun.json as { item_plans: Array<{ changes: Array<{ field: string; after: unknown }> }> }).item_plans;
      const tagChange = plans[0]?.changes.find((change) => change.field === "tags");
      expect(tagChange?.after).toEqual(["addonly", "batch"]);

      const apply = context.runCli(["update-many", "--json", "--filter-tag", "addonly", "--add-tags", "batch"], {
        expectJson: true,
      });
      expect((apply.json as { updated_count: number; skipped_count: number }).updated_count).toBe(2);
      const first = context.runCli(["get", firstId, "--json"], { expectJson: true });
      expect((first.json as { item: { tags?: string[] } }).item.tags).toEqual(["addonly", "batch"]);
    });
  });

  it("composes --tags replace with --add-tags additions in one update-many call", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "replace-add", { tags: "old" });
      const apply = context.runCli(
        ["update-many", "--json", "--filter-tag", "old", "--tags", "fresh", "--add-tags", "extra"],
        { expectJson: true },
      );
      expect((apply.json as { updated_count: number }).updated_count).toBe(1);
      const got = context.runCli(["get", id, "--json"], { expectJson: true });
      expect((got.json as { item: { tags?: string[] } }).item.tags).toEqual(["extra", "fresh"]);
    });
  });

  it("skips items when an additive tag mutation is a no-op (tag already present)", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "noop-tag", { tags: "keep" });
      const apply = context.runCli(["update-many", "--json", "--filter-tag", "keep", "--add-tags", "keep"], {
        expectJson: true,
      });
      const json = apply.json as { updated_count: number; skipped_count: number };
      expect(json.updated_count).toBe(0);
      expect(json.skipped_count).toBe(1);
    });
  });

  it("supports status mutations from CLI --status options", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createTask(context, "bulk-status-a", { tags: "bulk-status" });
      const secondId = createTask(context, "bulk-status-b", { tags: "bulk-status" });

      const updateResult = context.runCli(
        [
          "update-many",
          "--json",
          "--filter-tag",
          "bulk-status",
          "--status",
          "in_progress",
          "--message",
          "bulk status transition",
        ],
        { expectJson: true },
      );
      expect(updateResult.code).toBe(0);
      const updateJson = updateResult.json as {
        updated_count?: number;
        failed_count?: number;
      };
      expect(updateJson.updated_count).toBe(2);
      expect(updateJson.failed_count).toBe(0);

      const first = context.runCli(["get", firstId, "--json"], { expectJson: true });
      const second = context.runCli(["get", secondId, "--json"], { expectJson: true });
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect((first.json as { item: { status: string } }).item.status).toBe("in_progress");
      expect((second.json as { item: { status: string } }).item.status).toBe("in_progress");
    });
  });

  it("accepts shared update metadata flags from CLI wiring", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createTask(context, "bulk-shared-flags-a", { tags: "bulk-shared-flags" });
      const secondId = createTask(context, "bulk-shared-flags-b", { tags: "bulk-shared-flags" });

      const parentCreate = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Bulk shared parent feature",
          "--description",
          "Parent for update-many shared flag test",
          "--type",
          "Feature",
          "--create-mode",
          "progressive",
          "--status",
          "open",
          "--priority",
          "1",
          "--message",
          "create parent for shared flag test",
        ],
        { expectJson: true },
      );
      expect(parentCreate.code).toBe(0);
      const parentId = (parentCreate.json as { item: { id: string } }).item.id;

      const updateResult = context.runCli(
        [
          "update-many",
          "--json",
          "--filter-tag",
          "bulk-shared-flags",
          "--assignee",
          "bulk-owner",
          "--parent",
          parentId,
          "--blocked-by",
          "pm-dependency",
          "--blocked-reason",
          "blocked in shared-flag test",
          "--unblock-note",
          "resume once dependency closes",
          "--message",
          "bulk apply shared metadata",
        ],
        { expectJson: true },
      );
      expect(updateResult.code).toBe(0);
      const updateJson = updateResult.json as {
        updated_count?: number;
        failed_count?: number;
      };
      expect(updateJson.updated_count).toBe(2);
      expect(updateJson.failed_count).toBe(0);

      const first = context.runCli(["get", firstId, "--json"], { expectJson: true });
      const second = context.runCli(["get", secondId, "--json"], { expectJson: true });
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect((first.json as { item: Record<string, unknown> }).item).toMatchObject({
        assignee: "bulk-owner",
        parent: parentId,
        blocked_by: "pm-dependency",
        blocked_reason: "blocked in shared-flag test",
        unblock_note: "resume once dependency closes",
      });
      expect((second.json as { item: Record<string, unknown> }).item).toMatchObject({
        assignee: "bulk-owner",
        parent: parentId,
        blocked_by: "pm-dependency",
        blocked_reason: "blocked in shared-flag test",
        unblock_note: "resume once dependency closes",
      });
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
