import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runUpdate } from "../../src/cli/commands/update.js";
import { _testOnlyUpdateManyCommand, runUpdateMany } from "../../src/cli/commands/update-many.js";
import {
  checkpointFilePath,
  createCheckpointId,
  loadMutationCheckpoint,
  normalizeCheckpointId,
  restoreCheckpointItems,
  writeMutationCheckpoint,
} from "../../src/core/checkpoint/mutation-checkpoint.js";
import { matchesRuntimeFilters } from "../../src/core/schema/runtime-field-filters.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
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

function getItemPriority(context: TempPmContext, id: string): number {
  const result = context.runCli(["get", id, "--json"], { expectJson: true });
  expect(result.code).toBe(0);
  return Number((result.json as { item: { priority: number } }).item.priority);
}

function getItemTests(context: TempPmContext, id: string): Array<{ command?: string }> {
  const result = context.runCli(["get", id, "--full", "--json"], { expectJson: true });
  expect(result.code).toBe(0);
  const item = (result.json as { item: { tests?: Array<{ command?: string }> } }).item;
  return Array.isArray(item.tests) ? item.tests : [];
}

function getItemMetadataValue(context: TempPmContext, id: string, key: string): unknown {
  const result = context.runCli(["get", id, "--full", "--json"], { expectJson: true });
  expect(result.code).toBe(0);
  return (result.json as { item: Record<string, unknown> }).item[key];
}

describe("update-many command helper coverage", () => {
  it("normalizes summary, comparable values, collections, and tag planning", () => {
    expect(
      _testOnlyUpdateManyCommand.sanitizeUpdateOptionsForSummary({
        author: "agent",
        force: true,
        allowAuditUpdate: true,
        message: "msg",
        priority: "2",
        title: "Title",
        body: undefined,
      }),
    ).toEqual({ priority: "2", title: "Title" });
    expect(_testOnlyUpdateManyCommand.hasAnyUpdateMutationInput({ author: "agent", force: true })).toBe(false);
    expect(_testOnlyUpdateManyCommand.hasAnyUpdateMutationInput({ status: "closed" })).toBe(true);
    expect(_testOnlyUpdateManyCommand.hasListFilters(undefined, undefined)).toBe(false);
    expect(_testOnlyUpdateManyCommand.hasListFilters({ ids: " , " }, undefined)).toBe(false);
    expect(_testOnlyUpdateManyCommand.hasListFilters({ ids: "pm-a" }, undefined)).toBe(true);

    expect(_testOnlyUpdateManyCommand.toComparablePreviewValue("priority", " 3 ")).toBe(3);
    expect(_testOnlyUpdateManyCommand.toComparablePreviewValue("priority", "high")).toBe("high");
    expect(_testOnlyUpdateManyCommand.toComparablePreviewValue("estimatedMinutes", " 4.5 ")).toBe(4.5);
    expect(_testOnlyUpdateManyCommand.toComparablePreviewValue("regression", "1")).toBe(true);
    expect(_testOnlyUpdateManyCommand.toComparablePreviewValue("regression", "false")).toBe(false);
    expect(_testOnlyUpdateManyCommand.toComparablePreviewValue("regression", "maybe")).toBe("maybe");
    expect(_testOnlyUpdateManyCommand.toComparablePreviewValue("field" as never, { raw: true })).toEqual({ raw: true });
    expect(_testOnlyUpdateManyCommand.toComparablePreviewValue("title", "  trimmed  ")).toBe("trimmed");
    expect(_testOnlyUpdateManyCommand.toComparablePreviewValue("title", undefined)).toBeUndefined();

    expect(_testOnlyUpdateManyCommand.normalizeUnsetField("acceptance-criteria")).toBe("acceptance_criteria");
    expect(_testOnlyUpdateManyCommand.normalizeUnsetField("custom-field")).toBe("custom_field");
    expect(_testOnlyUpdateManyCommand.normalizeCollectionBeforeValue("type_options", undefined)).toEqual({});
    expect(_testOnlyUpdateManyCommand.normalizeCollectionBeforeValue("comments", undefined)).toEqual([]);
    expect(_testOnlyUpdateManyCommand.collectionValueCount("type_options", { a: 1, b: 2 })).toBe(2);
    expect(_testOnlyUpdateManyCommand.collectionValueCount("comments", ["a", "b"])).toBe(2);
    expect(_testOnlyUpdateManyCommand.collectionValueCount("comments", "none")).toBe(0);
    expect(_testOnlyUpdateManyCommand.normalizeExistingTags(["alpha", 1, "beta"])).toEqual(["alpha", "beta"]);
    expect(_testOnlyUpdateManyCommand.normalizeExistingTags("alpha")).toEqual([]);
    const statusRegistry = {
      definitions: [{ id: "open", role: "active" }],
      alias_to_id: new Map([["open", "open"]]),
    };
    expect(_testOnlyUpdateManyCommand.normalizeStatusFilter(undefined, statusRegistry)).toBeUndefined();
    expect(_testOnlyUpdateManyCommand.normalizeStatusFilter("open", statusRegistry)).toBe("open");
    expect(() =>
      _testOnlyUpdateManyCommand.normalizeStatusFilter("missing", statusRegistry),
    ).toThrow(/Invalid --filter-status/);
    expect(() => _testOnlyUpdateManyCommand.rejectBlankIdsFilter({ ids: "   " })).toThrow(/--ids requires/);

    expect(_testOnlyUpdateManyCommand.buildTagMutationPlan({ tags: ["alpha"] }, {})).toBeUndefined();
    expect(_testOnlyUpdateManyCommand.buildTagMutationPlan({ tags: ["alpha"] }, { addTags: ["alpha"] })).toBeUndefined();
    expect(_testOnlyUpdateManyCommand.buildTagMutationPlan({ tags: ["beta"] }, { tags: "alpha", addTags: ["gamma"], removeTags: ["beta"] })).toEqual({
      field: "tags",
      before: ["beta"],
      after: ["alpha", "gamma"],
    });

    expect(
      _testOnlyUpdateManyCommand.buildCollectionMutationPlans(
        { comments: ["old"], type_options: { risk: "low" } },
        {
          comment: ["author=a,text=b"],
          depRemove: ["pm-old"],
          clearTypeOptions: true,
          replaceTests: true,
          test: ["command=pnpm test"],
        },
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "comments",
          after: expect.objectContaining({ operation: "append", add_count: 1, before_count: 1 }),
        }),
        expect.objectContaining({
          field: "dependencies",
          after: expect.objectContaining({ operation: "merge_remove", remove_count: 1 }),
        }),
        expect.objectContaining({
          field: "type_options",
          before: { risk: "low" },
          after: expect.objectContaining({ operation: "clear_or_reset", clear: true, before_count: 1 }),
        }),
        expect.objectContaining({
          field: "tests",
          after: expect.objectContaining({ operation: "replace", replace: true, add_count: 1 }),
        }),
      ]),
    );
  });
});

describe("runUpdateMany", () => {
  it("rejects update-many before tracker initialization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-update-many-uninitialized-"));
    try {
      await expect(
        runUpdateMany(
          {
            list: {},
            update: { description: "not initialized" },
          },
          { path: root },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
        message: expect.stringContaining("Tracker is not initialized"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches object-valued runtime filters without depending on key insertion order", () => {
    expect(
      matchesRuntimeFilters(
        { payload: { b: 2, a: 1 } },
        { payload: { a: 1, b: 2 } },
      ),
    ).toBe(true);
    expect(matchesRuntimeFilters({}, { payload: "undefined" })).toBe(false);
  });

  it("plans runtime field diffs only when preview values change", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.schema.fields = [
        {
          key: "reviewUrl",
          metadata_key: "review_url",
          type: "string",
          cli_flag: "review-url",
          commands: ["update", "update_many"],
        },
      ];
      await writeSettings(context.pmPath, settings);

      const id = createTask(context, "update-many-runtime-preview", { tags: "runtime-preview" });
      await runUpdate(id, { reviewUrl: "https://example.test/old", message: "seed runtime field" }, { path: context.pmPath });

      const noChange = await runUpdateMany(
        {
          list: { ids: id },
          update: {
            reviewUrl: "https://example.test/old",
            message: "preview unchanged runtime field",
          },
          dryRun: true,
        },
        { path: context.pmPath },
      );
      expect(noChange.item_plans?.[0]?.changes).toEqual([]);

      const changed = await runUpdateMany(
        {
          list: { ids: id },
          update: {
            reviewUrl: "https://example.test/new",
            message: "preview changed runtime field",
          },
          dryRun: true,
        },
        { path: context.pmPath },
      );
      expect(changed.item_plans?.[0]?.changes).toEqual([
        {
          field: "review_url",
          before: "https://example.test/old",
          after: "https://example.test/new",
        },
      ]);
    });
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

  it("normalizes scalar preview values and rejects invalid status filters", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "bulk-scalar-preview", { tags: "bulk-scalar-preview" });

      await expect(
        runUpdateMany(
          {
            status: "not-a-status",
            list: { tag: "bulk-scalar-preview" },
            update: { description: "should not matter" },
            dryRun: true,
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Invalid --filter-status value"),
      });

      const dryRun = await runUpdateMany(
        {
          list: { tag: "bulk-scalar-preview", includeBody: true },
          update: {
            priority: "not-numeric",
            estimatedMinutes: "45",
            order: "2.5",
            regression: "true",
            message: "scalar preview",
          },
          dryRun: true,
        },
        { path: context.pmPath },
      );

      expect(dryRun.item_plans?.[0]?.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "priority", after: "not-numeric" }),
          expect.objectContaining({ field: "estimated_minutes", after: 45 }),
          expect.objectContaining({ field: "order", after: 2.5 }),
          expect.objectContaining({ field: "regression", after: true }),
        ]),
      );
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

  it("rejects dry-run rollback mode before loading a checkpoint", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runUpdateMany(
          {
            list: {},
            update: {},
            rollback: "missing-checkpoint",
            dryRun: true,
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "--dry-run cannot be combined with --rollback",
      });
    });
  });

  it("ignores null programmatic filters in rollback mode", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createTask(context, "bulk-null-rollback-a", {
        tags: "bulk-null-rollback",
        description: "bulk null rollback original",
      });
      const apply = await runUpdateMany(
        {
          list: { tag: "bulk-null-rollback" },
          update: {
            description: "bulk null rollback updated",
            message: "bulk null rollback apply",
          },
        },
        { path: context.pmPath },
      );
      const checkpointId = apply.checkpoint?.id;
      expect(typeof checkpointId).toBe("string");

      const rollback = await runUpdateMany(
        {
          rollback: String(checkpointId),
          status: null as unknown as string,
          list: {
            ids: null as unknown as string,
            updatedAfter: null as unknown as string,
          },
          update: {},
        },
        { path: context.pmPath },
      );

      expect(rollback.restored_count).toBe(1);
      expect(getItemDescription(context, firstId)).toBe("bulk null rollback original");
    });
  });

  it("rejects nested status filters in rollback mode", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "bulk-nested-status-rollback", {
        tags: "bulk-nested-status-rollback",
        description: "bulk nested status rollback original",
      });
      const apply = await runUpdateMany(
        {
          list: { tag: "bulk-nested-status-rollback" },
          update: {
            description: "bulk nested status rollback updated",
            message: "bulk nested status rollback apply",
          },
        },
        { path: context.pmPath },
      );
      const checkpointId = apply.checkpoint?.id;
      expect(typeof checkpointId).toBe("string");

      await expect(
        runUpdateMany(
          {
            rollback: String(checkpointId),
            list: { status: "open" },
            update: {},
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "Rollback mode does not accept filter options",
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

  it("does not treat filter-only CLI options as update-many mutations", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createTask(context, "bulk-filter-only-a", { tags: "bulk-filter-only" });
      const result = context.runCli([
        "update-many",
        "--ids",
        firstId,
        "--filter-updated-after",
        "",
        "--filter-created-before",
        "",
        "--json",
      ]);

      expect(result.code).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toContain("No update-many mutation flags provided");
    });
  });

  it("rejects explicit blank ids before bulk mutation", async () => {
    await withTempPmPath(async (context) => {
      const controlId = createTask(context, "bulk-blank-ids-control", { tags: "bulk-blank-ids" });

      const result = context.runCli([
        "update-many",
        "--ids",
        "",
        "--description",
        "must not apply broadly",
        "--json",
      ]);

      expect(result.code).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toContain("--ids requires at least one non-empty item ID");
      expect(getItemDescription(context, controlId)).toBe("bulk-blank-ids-control description");
    });
  });

  it("plans and applies runtime field updates in update-many", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.schema.fields = [
        ...(settings.schema.fields ?? []),
        {
          key: "review_stage",
          type: "string",
          cli_flag: "review-stage",
          commands: ["update_many"],
        },
      ];
      await writeSettings(context.pmPath, settings, "settings:write");
      const id = createTask(context, "bulk-runtime-field", { tags: "bulk-runtime-field" });

      const dryRun = context.runCli(
        ["update-many", "--filter-tag", "bulk-runtime-field", "--review-stage", "ready", "--dry-run", "--json"],
        { expectJson: true },
      );
      expect(dryRun.code).toBe(0);
      const plans = (dryRun.json as { item_plans: Array<{ changes: Array<{ field: string; after: unknown }> }> }).item_plans;
      expect(plans[0]?.changes).toEqual([
        expect.objectContaining({ field: "review_stage", after: "ready" }),
      ]);
      expect(getItemMetadataValue(context, id, "review_stage")).toBeUndefined();

      const apply = context.runCli(
        ["update-many", "--filter-tag", "bulk-runtime-field", "--review-stage", "ready", "--json"],
        { expectJson: true },
      );
      expect(apply.code).toBe(0);
      expect((apply.json as { updated_count: number }).updated_count).toBe(1);
      expect(getItemMetadataValue(context, id, "review_stage")).toBe("ready");
    });
  });

  it("keeps update_many-only runtime fields out of regular update", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.schema.fields = [
        ...(settings.schema.fields ?? []),
        {
          key: "review_stage",
          type: "string",
          cli_flag: "review-stage",
          commands: ["update_many"],
        },
      ];
      await writeSettings(context.pmPath, settings, "settings:write");
      const id = createTask(context, "single-update-runtime-field-scope", { tags: "runtime-field-scope" });

      const result = await runUpdate(id, { reviewStage: "ready" } as never, { path: context.pmPath });

      expect(result.changed_fields).toEqual([]);
      expect(result.warnings).toContain("noop_no_update_fields");
      expect(getItemMetadataValue(context, id, "review_stage")).toBeUndefined();
    });
  });

  it("keeps update-only runtime fields out of update-many", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.schema.fields = [
        ...(settings.schema.fields ?? []),
        {
          key: "single_review_stage",
          type: "string",
          cli_flag: "single-review-stage",
          commands: ["update"],
        },
      ];
      await writeSettings(context.pmPath, settings, "settings:write");
      const id = createTask(context, "bulk-update-runtime-field-scope", { tags: "bulk-runtime-field-scope" });

      const result = await runUpdateMany(
        {
          list: { tag: "bulk-runtime-field-scope" },
          update: { singleReviewStage: "ready" } as never,
        },
        { path: context.pmPath },
      );
      expect(result.updated_count).toBe(0);
      expect(result.rows).toEqual([
        expect.objectContaining({ id, status: "skipped" }),
      ]);
      expect(getItemMetadataValue(context, id, "single_review_stage")).toBeUndefined();
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

  it("applies mixed actionable and no-op rows without writing a checkpoint when disabled", async () => {
    await withTempPmPath(async (context) => {
      const unchangedId = createTask(context, "bulk-mixed-noop-a", {
        tags: "bulk-mixed-noop",
        description: "target description",
      });
      const changedId = createTask(context, "bulk-mixed-noop-b", {
        tags: "bulk-mixed-noop",
        description: "old description",
      });

      const result = await runUpdateMany(
        {
          list: { tag: "bulk-mixed-noop" },
          update: {
            description: "target description",
            message: "mixed no-op update",
          },
          checkpoint: false,
        },
        { path: context.pmPath },
      );

      expect(result.checkpoint).toBeUndefined();
      expect(result.updated_count).toBe(1);
      expect(result.skipped_count).toBe(1);
      expect(result.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: unchangedId, status: "skipped" }),
          expect.objectContaining({ id: changedId, status: "updated" }),
        ]),
      );
      expect(getItemDescription(context, changedId)).toBe("target description");
    });
  });

  it("records failed rows when an item update is rejected during apply", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "bulk-invalid-status", { tags: "bulk-invalid-status" });

      const result = await runUpdateMany(
        {
          list: { tag: "bulk-invalid-status" },
          update: {
            status: "not-a-real-status",
            message: "invalid status update",
          },
          checkpoint: false,
        },
        { path: context.pmPath },
      );

      expect(result.updated_count).toBe(0);
      expect(result.failed_count).toBe(1);
      expect(result.ids).toEqual([]);
      expect(result.rows).toEqual([
        expect.objectContaining({
          id,
          status: "failed",
          error: expect.stringContaining("Invalid --status"),
        }),
      ]);
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

  it("previews unset aliases and collection mutation operations", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "bulk-unset-collections", { tags: "bulk-unset-collections,legacy" });
      const seed = context.runCli(
        [
          "update",
          id,
          "--json",
          "--comment",
          "author=seed-author,text=old comment",
          "--doc",
          "path=README.md,scope=project,note=old doc",
          "--message",
          "seed collections",
        ],
        { expectJson: true },
      );
      expect(seed.code).toBe(0);

      const dryRun = await runUpdateMany(
        {
          list: { tag: "bulk-unset-collections", includeBody: true },
          update: {
            unset: ["deadline", "estimate", "acceptance-criteria", "missing-field"],
            removeTags: ["legacy"],
            comment: ["author=seed-author,text=new comment"],
            clearDocs: true,
            message: "preview unset and collections",
          },
          dryRun: true,
        },
        { path: context.pmPath },
      );

      const changes = dryRun.item_plans?.[0]?.changes ?? [];
      expect(changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "deadline", after: null }),
          expect.objectContaining({ field: "estimated_minutes", after: null }),
          expect.objectContaining({ field: "acceptance_criteria", after: null }),
          expect.objectContaining({ field: "tags", after: ["bulk-unset-collections"] }),
          expect.objectContaining({
            field: "comments",
            after: expect.objectContaining({ operation: "append", add_count: 1, before_count: 1 }),
          }),
          expect.objectContaining({
            field: "docs",
            after: expect.objectContaining({ operation: "clear_or_reset", clear: true, before_count: 1 }),
          }),
        ]),
      );
      expect(changes.some((change) => change.field === "missing-field")).toBe(false);
    });
  });

  describe("--ids explicit allowlist (pm-1h99)", () => {
    it("restricts the mutation to the listed ids only", async () => {
      await withTempPmPath(async (context) => {
        const a = createTask(context, "ids-a", { tags: "ids-batch" });
        const b = createTask(context, "ids-b", { tags: "ids-batch" });
        const c = createTask(context, "ids-c", { tags: "ids-batch" });

        const apply = await runUpdateMany(
          {
            list: { ids: `${a},${b}`, includeBody: true },
            update: { priority: "0", message: "ids subset" },
          },
          { path: context.pmPath },
        );

        expect(apply.mode).toBe("apply");
        expect(apply.matched_count).toBe(2);
        expect(apply.updated_count).toBe(2);
        expect([...apply.ids].sort()).toEqual([a, b].sort());
        // c was outside the allowlist and must be untouched
        expect(getItemPriority(context, c)).toBe(1);
        expect(getItemPriority(context, a)).toBe(0);
      });
    });

    it("intersects --ids with other filters and ignores ids that do not exist", async () => {
      await withTempPmPath(async (context) => {
        const a = createTask(context, "ids-int-a", { tags: "keep" });
        const b = createTask(context, "ids-int-b", { tags: "other" });

        const apply = await runUpdateMany(
          {
            list: { ids: `${a},${b},pm-doesnotexist`, tag: "keep", includeBody: true },
            update: { priority: "0", message: "ids intersect tag" },
          },
          { path: context.pmPath },
        );

        // only a is both in the id allowlist AND tagged "keep"
        expect(apply.matched_count).toBe(1);
        expect(apply.ids).toEqual([a]);
        expect(getItemPriority(context, b)).toBe(1);
      });
    });

    it("echoes the ids filter in the result filters block", async () => {
      await withTempPmPath(async (context) => {
        const a = createTask(context, "ids-echo", { tags: "echo" });
        const result = await runUpdateMany(
          {
            list: { ids: a, includeBody: true },
            update: { priority: "0", message: "echo" },
            dryRun: true,
          },
          { path: context.pmPath },
        );
        expect(result.filters?.ids).toBe(a);
      });
    });
  });
});

describe("mutation-checkpoint shared module", () => {
  const SCHEMA_VERSION = 1;
  let root: string;

  async function makeRoot(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), "pm-ckpt-"));
  }

  it("normalizeCheckpointId trims valid ids and rejects empty/invalid ids", () => {
    expect(normalizeCheckpointId("  close-many-123_x.y-z  ")).toBe("close-many-123_x.y-z");
    expect(() => normalizeCheckpointId("   ")).toThrowError(PmCliError);
    let usage: unknown;
    try {
      normalizeCheckpointId("bad id/with slash");
    } catch (error) {
      usage = error;
    }
    expect((usage as PmCliError).exitCode).toBe(EXIT_CODE.USAGE);
  });

  it("createCheckpointId embeds the prefix and a compact timestamp", () => {
    const id = createCheckpointId("close-many", "2026-06-04T15:59:09.123Z");
    expect(id).toMatch(/^close-many-20260604155909-[a-z0-9]{1,6}$/);
  });

  it("writes and round-trips a checkpoint, preserving command-specific fields", async () => {
    root = await makeRoot();
    try {
      const id = createCheckpointId("close-many", "2026-06-04T00:00:00.000Z");
      const payload = {
        schema_version: SCHEMA_VERSION,
        id,
        created_at: "2026-06-04T00:00:00.000Z",
        author: "tester",
        reason: "bulk close",
        items: [{ id: "pm-a", target_updated_at: "2026-06-03T00:00:00.000Z" }],
      };
      const writtenPath = await writeMutationCheckpoint(root, "close-many", id, payload);
      expect(writtenPath).toBe(checkpointFilePath(root, "close-many", id));

      const loaded = await loadMutationCheckpoint(root, "close-many", id, SCHEMA_VERSION);
      expect(loaded.id).toBe(id);
      expect(loaded.author).toBe("tester");
      expect(loaded.created_at).toBe("2026-06-04T00:00:00.000Z");
      expect(loaded.items).toEqual([{ id: "pm-a", target_updated_at: "2026-06-03T00:00:00.000Z" }]);
      expect(loaded.record.reason).toBe("bulk close");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies defaults when optional record fields are missing", async () => {
    root = await makeRoot();
    try {
      const id = "close-many-defaults";
      await writeMutationCheckpoint(root, "close-many", id, {
        schema_version: SCHEMA_VERSION,
        items: [{ id: "pm-x", target_updated_at: "2026-06-03T00:00:00.000Z" }],
      });
      const loaded = await loadMutationCheckpoint(root, "close-many", id, SCHEMA_VERSION);
      expect(loaded.id).toBe(id);
      expect(loaded.author).toBe("unknown");
      expect(typeof loaded.created_at).toBe("string");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function expectLoadFailure(contents: string, expected: string, code: number): Promise<void> {
    const dir = await makeRoot();
    try {
      const id = "close-many-bad";
      const filePath = checkpointFilePath(dir, "close-many", id);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, contents);
      let caught: unknown;
      try {
        await loadMutationCheckpoint(dir, "close-many", id, SCHEMA_VERSION);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PmCliError);
      expect((caught as PmCliError).message).toContain(expected);
      expect((caught as PmCliError).exitCode).toBe(code);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("rejects a missing checkpoint with NOT_FOUND", async () => {
    const dir = await makeRoot();
    try {
      let caught: unknown;
      try {
        await loadMutationCheckpoint(dir, "close-many", "missing-id", SCHEMA_VERSION);
      } catch (error) {
        caught = error;
      }
      expect((caught as PmCliError).exitCode).toBe(EXIT_CODE.NOT_FOUND);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed checkpoint payloads with descriptive errors", async () => {
    await expectLoadFailure("{not-json", "contains invalid JSON", EXIT_CODE.GENERIC_FAILURE);
    await expectLoadFailure("null", "is invalid", EXIT_CODE.GENERIC_FAILURE);
    await expectLoadFailure(JSON.stringify({ schema_version: 99, items: [] }), "unsupported schema version", EXIT_CODE.GENERIC_FAILURE);
    await expectLoadFailure(JSON.stringify({ schema_version: SCHEMA_VERSION }), "is missing items", EXIT_CODE.GENERIC_FAILURE);
    await expectLoadFailure(
      JSON.stringify({ schema_version: SCHEMA_VERSION, items: [42] }),
      "invalid item entry",
      EXIT_CODE.GENERIC_FAILURE,
    );
    await expectLoadFailure(
      JSON.stringify({ schema_version: SCHEMA_VERSION, items: [{ target_updated_at: "x" }] }),
      "without ID",
      EXIT_CODE.GENERIC_FAILURE,
    );
    await expectLoadFailure(
      JSON.stringify({ schema_version: SCHEMA_VERSION, items: [{ id: "pm-a" }] }),
      "without target_updated_at",
      EXIT_CODE.GENERIC_FAILURE,
    );
  });

  it("restoreCheckpointItems records per-item success and failure without aborting", async () => {
    const result = await restoreCheckpointItems(
      [
        { id: "pm-ok", target_updated_at: "2026-06-03T00:00:00.000Z" },
        { id: "pm-fail", target_updated_at: "2026-06-03T00:00:00.000Z" },
      ],
      async (id) => {
        if (id === "pm-fail") {
          throw new Error("restore blew up");
        }
        return { changed_fields: ["status"], warnings: [] };
      },
    );
    expect(result.restored_ids).toEqual(["pm-ok"]);
    expect(result.failed_count).toBe(1);
    expect(result.rows).toEqual([
      { id: "pm-ok", status: "restored", changed_fields: ["status"], warnings: [] },
      { id: "pm-fail", status: "failed", error: "restore blew up" },
    ]);
  });
});
