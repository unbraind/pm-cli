import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runNormalize } from "../../../packages/pm-governance-audit/extensions/governance-audit/normalize.ts";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

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

      const sensitiveCloseReason = "Completed normalize apply fixture TOKEN_SENTINEL PRIVATE_IP_SENTINEL LOCAL_PATH_SENTINEL";
      const closed = context.runCli(["close", closedId, sensitiveCloseReason, "--json"], { expectJson: true });
      expect(closed.code).toBe(0);
      await seedClosedLowSignalResolutionFields(context, closedId);

      const result = await runNormalize(
        {
          list: { tag: "normalize-apply", includeBody: true },
          apply: true,
          allowOwnershipMetadataBypass: true,
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
      expect(String(closedItem.resolution)).not.toContain(sensitiveCloseReason);
      expect(String(closedItem.expected_result)).not.toContain(sensitiveCloseReason);
      expect(String(closedItem.actual_result)).not.toContain(sensitiveCloseReason);
      expect(String(closedItem.resolution)).not.toContain("PRIVATE_IP_SENTINEL");
      expect(String(closedItem.expected_result)).not.toContain("TOKEN_SENTINEL");
      expect(String(closedItem.actual_result)).not.toContain("LOCAL_PATH_SENTINEL");

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
  it("accepts normalized status filters and skips closed high-signal fields", async () => {
    await withTempPmPath(async (context) => {
      const openId = createTask(context, "normalize-valid-status-open", { tags: "normalize-status-valid", status: "in_progress" });
      const closedId = createTask(context, "normalize-valid-status-closed", { tags: "normalize-status-valid", status: "closed" });

      const closedPath = path.join(context.pmPath, "tasks", `${closedId}.toon`);
      const closedBefore = await readFile(closedPath, "utf8");
      const withHighSignalResolution = upsertTopLevelField(closedBefore, "resolution", "Manually resolved with concrete evidence");
      await writeFile(closedPath, withHighSignalResolution, "utf8");

      const inProgress = await runNormalize(
        {
          status: "in-progress",
          list: { tag: "normalize-status-valid", includeBody: true },
          dryRun: true,
        },
        { path: context.pmPath },
      );
      expect(inProgress.matched_count).toBe(1);
      expect(inProgress.item_plans[0]?.id).toBe(openId);

      const closed = await runNormalize(
        {
          status: "closed",
          list: { tag: "normalize-status-valid", includeBody: true },
          dryRun: true,
        },
        { path: context.pmPath },
      );
      expect(closed.matched_count).toBe(1);
      const closedPlan = closed.item_plans.find((plan) => plan.id === closedId);
      expect(closedPlan?.changes.some((change) => change.field === "resolution")).toBe(false);
    });
  });

  it("records failed apply rows when normalize updates are blocked by ownership enforcement", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "normalize-apply-failure", { tags: "normalize-apply-failure" });
      const strictSet = context.runCli(["config", "set", "governance_ownership_enforcement", "strict", "--json"], { expectJson: true });
      expect(strictSet.code).toBe(0);

      const assigned = context.runCli(
        ["update", id, "--json", "--assignee", "foreign-owner", "--author", "test-author", "--message", "assign owner"],
        { expectJson: true },
      );
      expect(assigned.code).toBe(0);
      await seedActiveLifecycleDriftFields(context, id);

      const result = await runNormalize(
        {
          list: { tag: "normalize-apply-failure", includeBody: true },
          apply: true,
          author: "test-author",
        },
        { path: context.pmPath },
      );

      expect(result.mode).toBe("apply");
      expect(result.updated_count).toBe(0);
      expect(result.failed_count).toBe(1);
      expect(result.rows?.[0]).toMatchObject({
        id,
        status: "failed",
      });
      expect(String(result.rows?.[0]?.error)).toContain("assigned");
    });
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-normalize-not-init-"));
    try {
      await expect(runNormalize({ list: {} }, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses missing-close-reason wording for closed backfill values", async () => {
    await withTempPmPath(async (context) => {
      // GH-249: `pm create --status closed` records a close_reason under
      // governance.require_close_reason. Disable it so this fixture genuinely
      // lacks a close_reason and exercises the missing-close-reason wording.
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        governance?: Record<string, unknown>;
      };
      settings.governance = { ...settings.governance, require_close_reason: false };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const closedId = createTask(context, "normalize-closed-no-close-reason", {
        tags: "normalize-no-close-reason",
        status: "closed",
      });
      await seedClosedLowSignalResolutionFields(context, closedId);

      const result = await runNormalize(
        {
          status: "closed",
          list: { tag: "normalize-no-close-reason", includeBody: true },
          dryRun: true,
        },
        { path: context.pmPath },
      );

      const plan = result.item_plans.find((entry) => entry.id === closedId);
      const resolutionChange = plan?.changes.find((change) => change.field === "resolution");
      expect(typeof resolutionChange?.after).toBe("string");
      expect(String(resolutionChange?.after)).toContain("Resolution normalized from closed status because");
      expect(String(resolutionChange?.after)).toContain("the field was missing or low-signal");
    });
  });

  it("skips active high-signal lifecycle metadata cleanup", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "normalize-high-signal-active", {
        tags: "normalize-high-signal-active",
        status: "open",
      });
      const itemFile = path.join(context.pmPath, "tasks", `${id}.toon`);
      const before = await readFile(itemFile, "utf8");
      const after = upsertTopLevelField(before, "resolution", "Documented remediation with explicit evidence");
      await writeFile(itemFile, after, "utf8");

      const result = await runNormalize(
        {
          status: "open",
          list: { tag: "normalize-high-signal-active", includeBody: true },
          dryRun: true,
        },
        { path: context.pmPath },
      );

      const plan = result.item_plans.find((entry) => entry.id === id);
      expect(plan).toBeDefined();
      expect(plan?.changes.some((change) => change.field === "resolution")).toBe(false);
    });
  });

  it("handles unknown item statuses via raw-token fallback", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "normalize-unknown-status", {
        tags: "normalize-unknown-status",
      });
      const listed = context.runCli(["list", "--json", "--tag", "normalize-unknown-status"], { expectJson: true });
      expect(listed.code).toBe(0);
      const listedItems = (listed.json as { items: Array<Record<string, unknown>> }).items;
      const baseItem = listedItems.find((entry) => entry.id === id);
      expect(baseItem).toBeDefined();

      vi.resetModules();
      vi.doMock("../../../src/cli/commands/list.js", () => ({
        runList: vi.fn().mockResolvedValue({
          items: [{ ...baseItem, status: "mystery_status" }],
          filters: { tag: "normalize-unknown-status" },
          warnings: [],
          now: "2026-06-16T00:00:00.000Z",
        }),
      }));

      const { runNormalize: mockedRunNormalize } = await import("../../../packages/pm-governance-audit/extensions/governance-audit/normalize.ts");
      try {
        const result = await mockedRunNormalize(
          {
            list: { tag: "normalize-unknown-status", includeBody: true },
            dryRun: true,
          },
          { path: context.pmPath },
        );

        expect(result.matched_count).toBe(1);
        expect(result.item_plans[0]?.id).toBe(id);
      } finally {
        vi.doUnmock("../../../src/cli/commands/list.js");
        vi.resetModules();
      }
    });
  });

  it("falls back to nowIso when list output omits timestamp", async () => {
    await withTempPmPath(async (context) => {
      vi.resetModules();
      vi.doMock("../../../src/cli/commands/list.js", () => ({
        runList: vi.fn().mockResolvedValue({
          items: [],
          filters: {},
          warnings: [],
        }),
      }));

      const { runNormalize: mockedRunNormalize } = await import("../../../packages/pm-governance-audit/extensions/governance-audit/normalize.ts");
      try {
        const result = await mockedRunNormalize({ list: {}, dryRun: true }, { path: context.pmPath });
        expect(result.generated_at).toMatch(/[0-9]{4}-[0-9]{2}-[0-9]{2}T/);
      } finally {
        vi.doUnmock("../../../src/cli/commands/list.js");
        vi.resetModules();
      }
    });
  });

  it("applies normalize updates when --force is set", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "normalize-force-apply", {
        tags: "normalize-force-apply",
        status: "open",
      });
      await seedActiveLifecycleDriftFields(context, id);

      const result = await runNormalize(
        {
          list: { tag: "normalize-force-apply", includeBody: true },
          apply: true,
          force: true,
          author: "test-author",
          message: "normalize force apply test",
        },
        { path: context.pmPath },
      );

      expect(result.mode).toBe("apply");
      expect(result.updated_count).toBe(1);
      expect(result.failed_count).toBe(0);
      expect(result.ids).toEqual([id]);
    });
  });
});
