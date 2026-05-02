import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runNormalize } from "../../src/cli/commands/normalize.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

interface CreateTaskOptions {
  tags?: string;
  status?: string;
  description?: string;
}

function createTask(context: TempPmContext, title: string, options: CreateTaskOptions = {}): string {
  const created = context.runCli(
    [
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
      options.status ?? "open",
      "--priority",
      "1",
      "--tags",
      options.tags ?? "normalize,unit",
      "--message",
      `Create ${title}`,
    ],
    { expectJson: true },
  );
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

function getItem(context: TempPmContext, id: string): Record<string, unknown> {
  const result = context.runCli(["get", id, "--json"], { expectJson: true });
  expect(result.code).toBe(0);
  return (result.json as { item: Record<string, unknown> }).item;
}

function upsertTopLevelField(document: string, key: string, value: string): string {
  const linePattern = new RegExp(`^${key}:.*$`, "m");
  const nextLine = `${key}: ${value}`;
  if (linePattern.test(document)) {
    return document.replace(linePattern, nextLine);
  }
  return document.replace(/\nbody:/m, `\n${nextLine}\nbody:`);
}

async function seedActiveLifecycleDriftFields(context: TempPmContext, id: string): Promise<void> {
  const itemPath = path.join(context.pmPath, "tasks", `${id}.toon`);
  const before = await readFile(itemPath, "utf8");
  const withBlockedReason = upsertTopLevelField(before, "blocked_reason", "todo");
  const withResolution = upsertTopLevelField(withBlockedReason, "resolution", "none");
  const withActualResult = upsertTopLevelField(withResolution, "actual_result", "n/a");
  const after = upsertTopLevelField(withActualResult, "close_reason", "stale close reason while still open");
  expect(after).not.toBe(before);
  await writeFile(itemPath, after, "utf8");
}

async function seedClosedLowSignalResolutionFields(context: TempPmContext, id: string): Promise<void> {
  const itemPath = path.join(context.pmPath, "tasks", `${id}.toon`);
  const before = await readFile(itemPath, "utf8");
  const withResolution = upsertTopLevelField(before, "resolution", "none");
  const withExpected = upsertTopLevelField(withResolution, "expected_result", "n/a");
  const after = upsertTopLevelField(withExpected, "actual_result", "todo");
  expect(after).not.toBe(before);
  await writeFile(itemPath, after, "utf8");
}

describe("runNormalize", () => {
  it("produces dry-run plans for active cleanup and closed backfill without mutating items", async () => {
    await withTempPmPath(async (context) => {
      const activeId = createTask(context, "normalize-dry-run-active", { tags: "normalize-dry-run" });
      const closedId = createTask(context, "normalize-dry-run-closed", { tags: "normalize-dry-run" });

      await seedActiveLifecycleDriftFields(context, activeId);

      const closed = context.runCli(["close", closedId, "Completed normalization dry-run fixture", "--json"], { expectJson: true });
      expect(closed.code).toBe(0);

      const beforeActive = getItem(context, activeId);
      const beforeClosed = getItem(context, closedId);

      const result = await runNormalize(
        {
          list: { tag: "normalize-dry-run", includeBody: true },
          dryRun: true,
        },
        { path: context.pmPath },
      );

      expect(result.mode).toBe("dry_run");
      expect(result.dry_run).toBe(true);
      expect(result.matched_count).toBe(2);
      expect(result.ids).toEqual([]);
      expect(result.rules).toEqual(
        expect.arrayContaining([
          "active_close_reason",
          "active_closure_like_metadata",
          "closed_resolution_backfill",
        ]),
      );

      const activePlan = result.item_plans.find((plan) => plan.id === activeId);
      expect(activePlan).toBeDefined();
      expect(activePlan?.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "blocked_reason", after: null }),
          expect.objectContaining({ field: "resolution", after: null }),
          expect.objectContaining({ field: "actual_result", after: null }),
          expect.objectContaining({ field: "close_reason", after: null }),
        ]),
      );

      const closedPlan = result.item_plans.find((plan) => plan.id === closedId);
      expect(closedPlan).toBeDefined();
      expect(closedPlan?.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "resolution", rule: "closed_resolution_backfill" }),
          expect.objectContaining({ field: "expected_result", rule: "closed_resolution_backfill" }),
          expect.objectContaining({ field: "actual_result", rule: "closed_resolution_backfill" }),
        ]),
      );

      const afterActive = getItem(context, activeId);
      const afterClosed = getItem(context, closedId);
      expect(afterActive).toMatchObject(beforeActive);
      expect(afterClosed).toMatchObject(beforeClosed);
    });
  });

  it("applies planned normalize mutations and reports skipped rows for unchanged items", async () => {
    await withTempPmPath(async (context) => {
      const closedId = createTask(context, "normalize-apply-closed", { tags: "normalize-apply" });
      const cleanId = createTask(context, "normalize-apply-clean", { tags: "normalize-apply" });

      const closed = context.runCli(["close", closedId, "Completed normalize apply fixture", "--json"], { expectJson: true });
      expect(closed.code).toBe(0);
      await seedClosedLowSignalResolutionFields(context, closedId);

      const result = await runNormalize(
        {
          list: { tag: "normalize-apply", includeBody: true },
          apply: true,
          allowAuditUpdate: true,
          message: "normalize apply unit test",
        },
        { path: context.pmPath },
      );

      expect(result.mode).toBe("apply");
      expect(result.dry_run).toBe(false);
      expect(result.matched_count).toBe(2);
      expect(result.updated_count).toBe(1);
      expect(result.skipped_count).toBe(1);
      expect(result.failed_count).toBe(0);
      expect(result.ids).toEqual([closedId]);

      const closedItem = getItem(context, closedId);
      expect(typeof closedItem.resolution).toBe("string");
      expect(typeof closedItem.expected_result).toBe("string");
      expect(typeof closedItem.actual_result).toBe("string");
      expect(String(closedItem.resolution)).toContain("Resolution normalized");
      expect(String(closedItem.expected_result)).toContain("Expected closure outcome");
      expect(String(closedItem.actual_result)).toContain("Actual closure outcome");

      const cleanItem = getItem(context, cleanId);
      expect(cleanItem.resolution).toBeUndefined();
      expect(cleanItem.expected_result).toBeUndefined();
      expect(cleanItem.actual_result).toBeUndefined();
    });
  });

  it("rejects conflicting --dry-run and --apply options", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "normalize-invalid-mode");
      await expect(
        runNormalize(
          {
            list: {},
            dryRun: true,
            apply: true,
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("rejects invalid status filters", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "normalize-invalid-status");
      await expect(
        runNormalize(
          {
            status: "invalid-status",
            list: {},
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });
});
