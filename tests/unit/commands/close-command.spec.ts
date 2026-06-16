import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { _testOnly as closeManyInternals } from "../../../src/cli/commands/close-many.js";
import { runClose } from "../../../src/cli/commands/close.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { readSettings } from "../../../src/core/store/settings.js";
import { createTestItemId, type TestItemStatus } from "../../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

interface CreateTaskOptions {
  status?: TestItemStatus;
  assignee?: string;
  parent?: string;
}

function createTask(context: TempPmContext, title: string, options: CreateTaskOptions = {}): string {
  return createTestItemId(context, {
    title,
    status: options.status,
    tags: "close,unit",
    estimate: "20",
    assignee: options.assignee,
    parent: options.parent ?? "none",
  });
}

function latestCloseAuthor(context: TempPmContext, id: string): string | undefined {
  const history = context.runCli(["history", id, "--json", "--full"], { expectJson: true });
  expect(history.code).toBe(0);
  const entries = (history.json as { history: Array<{ op: string; author: string }> }).history;
  return [...entries].reverse().find((entry) => entry.op === "close")?.author;
}

function itemStatus(context: TempPmContext, id: string): string {
  const result = context.runCli(["get", id, "--json"], { expectJson: true });
  expect(result.code).toBe(0);
  return (result.json as { item: { status: string } }).item.status;
}

async function patchTaskToon(context: TempPmContext, id: string, patch: (content: string) => string): Promise<void> {
  const filePath = path.join(context.pmPath, "tasks", `${id}.toon`);
  await writeFile(filePath, patch(await readFile(filePath, "utf8")), "utf8");
}

describe("runClose", () => {
  it("covers close-many pure helper branches", () => {
    expect(closeManyInternals.activeListOptions(undefined)).toEqual({});
    expect(
      closeManyInternals.activeListOptions({
        ids: " pm-a, ",
        tag: "  ",
        limit: "0",
        offset: null as never,
      }),
    ).toEqual({ ids: " pm-a, ", limit: "0" });
    expect(closeManyInternals.hasCloseManyFilters(undefined, undefined)).toBe(false);
    expect(closeManyInternals.hasCloseManyFilters({ ids: " , " }, undefined)).toBe(false);
    expect(closeManyInternals.hasCloseManyFilters({ ids: "pm-a" }, undefined)).toBe(true);
    expect(closeManyInternals.hasCloseManyFilters({ limit: "10" }, undefined)).toBe(false);
    expect(closeManyInternals.hasCloseManyRollbackConflicts({ limit: "10" }, undefined)).toBe(true);
    expect(closeManyInternals.resolveReason("  done  ", true)).toBe("done");
    expect(closeManyInternals.resolveReason(undefined, false)).toBeUndefined();
    expect(() => closeManyInternals.resolveReason(" ", true)).toThrow(PmCliError);
    expect(() => closeManyInternals.rejectBlankIdsFilter({ ids: "   " })).toThrow(PmCliError);

    const parents = new Map([
      ["child", "parent"],
      ["parent", "root"],
      ["cycle-a", "cycle-b"],
      ["cycle-b", "cycle-a"],
    ]);
    const cache = new Map<string, number>([["root", 0]]);
    expect(closeManyInternals.hierarchyDepth("child", parents, cache)).toBe(2);
    expect(closeManyInternals.hierarchyDepth("child", parents, cache)).toBe(2);
    expect(closeManyInternals.hierarchyDepth("cycle-a", parents, new Map())).toBe(2);
  });

  it("builds active child indexes from tracker front matter", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createTask(context, "close-many-index-parent");
      const childB = createTask(context, "close-many-index-child-b", { parent: parentId });
      const childA = createTask(context, "close-many-index-child-a", { parent: parentId });
      const closedChild = createTask(context, "close-many-index-child-closed", { parent: parentId, status: "closed" });

      const settings = await readSettings(context.pmPath);
      const index = await closeManyInternals.buildActiveChildrenByParent(context.pmPath, settings);

      expect(index.parentByChild.get(childA)).toBe(parentId);
      expect(index.parentByChild.get(closedChild)).toBe(parentId);
      expect(index.childrenByParent.get(parentId)).toEqual([childA, childB].sort());
    });
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-close-not-init-"));
    try {
      await expect(runClose("pm-missing", "done", {}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown --validate-close values", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-invalid-validate-mode");
      await expect(
        runClose(
          id,
          "reason",
          {
            validateClose: "loud",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Invalid --validate-close mode"),
      });
    });
  });

  it("closes assigned active items and clears assignment", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-assigned-item", {
        status: "in_progress",
        assignee: "explicit-author",
      });

      const result = await runClose(
        id,
        "Implementation finished",
        {
          author: " explicit-author ",
          message: "Close assigned item",
        },
        { path: context.pmPath },
      );

      expect(result.warnings).toEqual([]);
      expect(result.changed_fields).toEqual(expect.arrayContaining(["status", "close_reason", "assignee"]));
      const item = result.item as Record<string, unknown>;
      expect(item.status).toBe("closed");
      expect(item.close_reason).toBe("Implementation finished");
      expect(item.assignee).toBeUndefined();
      expect(latestCloseAuthor(context, id)).toBe("explicit-author");
    });
  });

  it("closes unassigned active items without assignee changed field", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-unassigned-item");
      const result = await runClose(
        id,
        "No assignee to clear",
        {
          message: "Close unassigned item",
        },
        { path: context.pmPath },
      );

      expect(result.changed_fields).toEqual(expect.arrayContaining(["status", "close_reason"]));
      expect(result.changed_fields).not.toContain("assignee");
      const item = result.item as Record<string, unknown>;
      expect(item.status).toBe("closed");
      expect(item.close_reason).toBe("No assignee to clear");
      expect(item.assignee).toBeUndefined();
    });
  });

  it("closes duplicate items with canonical target metadata and validation fields", async () => {
    await withTempPmPath(async (context) => {
      const canonicalId = createTask(context, "canonical duplicate target");
      const duplicateId = createTask(context, "duplicate close candidate");

      const result = await runClose(
        duplicateId,
        "Duplicate of canonical target",
        {
          duplicateOf: canonicalId,
          validateClose: "strict",
          message: "Close duplicate",
        },
        { path: context.pmPath },
      );

      expect(result.warnings).toEqual([]);
      expect(result.changed_fields).toEqual(
        expect.arrayContaining(["status", "close_reason", "duplicate_of", "resolution", "expected_result", "actual_result"]),
      );
      expect(result.item).toMatchObject({
        id: duplicateId,
        status: "closed",
        duplicate_of: canonicalId,
        resolution: `Duplicate of ${canonicalId}`,
      });
    });
  });

  it("auto-fills the close reason for duplicate closures under close-reason governance", async () => {
    await withTempPmPath(async (context) => {
      const canonicalId = createTask(context, "canonical duplicate auto reason target");
      const duplicateId = createTask(context, "duplicate auto reason candidate");
      const nonDuplicateId = createTask(context, "non duplicate missing reason candidate");

      const result = await runClose(
        duplicateId,
        undefined,
        {
          duplicateOf: canonicalId,
          validateClose: "strict",
          message: "Close duplicate with auto reason",
        },
        { path: context.pmPath },
      );

      expect(result.warnings).toEqual([]);
      expect(result.changed_fields).toEqual(
        expect.arrayContaining(["status", "close_reason", "duplicate_of", "resolution", "expected_result", "actual_result"]),
      );
      expect(result.item).toMatchObject({
        id: duplicateId,
        status: "closed",
        close_reason: `Duplicate of ${canonicalId}`,
        duplicate_of: canonicalId,
      });

      await expect(
        runClose(
          nonDuplicateId,
          undefined,
          {
            validateClose: "warn",
            message: "Close without required reason",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        context: expect.objectContaining({ code: "close_reason_required" }),
      });
    });
  });

  it("derives the close reason from --resolution when no explicit reason is given (pm-7x8d)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "resolution-as-close-reason candidate");
      const result = await runClose(
        id,
        undefined,
        {
          resolution: "  Fixed by patch xyz  ",
          message: "Close with resolution only",
        },
        { path: context.pmPath },
      );
      expect(result.changed_fields).toEqual(expect.arrayContaining(["status", "close_reason", "resolution"]));
      expect(result.item).toMatchObject({
        id,
        status: "closed",
        close_reason: "Fixed by patch xyz",
        resolution: "Fixed by patch xyz",
      });
    });
  });

  it("prefers explicit reason text over --resolution and --duplicate-of for the close reason", async () => {
    await withTempPmPath(async (context) => {
      const canonicalId = createTask(context, "resolution-precedence canonical");
      const id = createTask(context, "resolution-precedence candidate");
      const result = await runClose(
        id,
        "Explicit closing summary",
        {
          duplicateOf: canonicalId,
          resolution: "Resolution summary",
          message: "Close with explicit reason",
        },
        { path: context.pmPath },
      );
      expect(result.item).toMatchObject({
        id,
        status: "closed",
        close_reason: "Explicit closing summary",
        duplicate_of: canonicalId,
        resolution: "Resolution summary",
      });
    });
  });

  it("still requires a reason when neither --reason, --duplicate-of, nor --resolution is provided", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "no-reason-source candidate");
      await expect(runClose(id, undefined, { message: "no reason" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        context: expect.objectContaining({ code: "close_reason_required" }),
      });
    });
  });

  it("does not report duplicate fallback fields when explicit close metadata already exists", async () => {
    await withTempPmPath(async (context) => {
      const canonicalId = createTask(context, "canonical duplicate existing metadata target");
      const duplicateId = createTask(context, "duplicate existing metadata candidate");
      const update = context.runCli(
        [
          "update",
          duplicateId,
          "--json",
          "--resolution",
          "Already triaged as duplicate",
          "--expected-result",
          "Existing expected result",
          "--actual-result",
          "Existing actual result",
          "--message",
          "Seed closure metadata",
        ],
        { expectJson: true },
      );
      expect(update.code).toBe(0);

      const result = await runClose(
        duplicateId,
        "Duplicate of canonical target",
        {
          duplicateOf: canonicalId,
          validateClose: "strict",
          message: "Close duplicate",
        },
        { path: context.pmPath },
      );

      expect(result.changed_fields).toEqual(expect.arrayContaining(["status", "close_reason", "duplicate_of"]));
      expect(result.changed_fields).not.toContain("resolution");
      expect(result.changed_fields).not.toContain("expected_result");
      expect(result.changed_fields).not.toContain("actual_result");
      expect(result.item).toMatchObject({
        resolution: "Already triaged as duplicate",
        expected_result: "Existing expected result",
        actual_result: "Existing actual result",
      });
    });
  });

  it("fills duplicate fallback fields when close metadata is blank", async () => {
    await withTempPmPath(async (context) => {
      const canonicalId = createTask(context, "canonical duplicate blank metadata target");
      const duplicateId = createTask(context, "duplicate blank metadata candidate");
      await patchTaskToon(context, duplicateId, (content) =>
        content.replace(
          "author: seed-author\n",
          'author: seed-author\nresolution: "   "\nexpected_result: ""\nactual_result: "   "\n',
        ),
      );

      const result = await runClose(
        duplicateId,
        "Duplicate of canonical target",
        {
          duplicateOf: canonicalId,
          validateClose: "strict",
          message: "Close duplicate",
        },
        { path: context.pmPath },
      );

      expect(result.changed_fields).toEqual(expect.arrayContaining(["resolution", "expected_result", "actual_result"]));
      expect(result.item).toMatchObject({
        resolution: `Duplicate of ${canonicalId}`,
        expected_result: `Canonical item ${canonicalId} tracks the work.`,
        actual_result: `Closed as duplicate of ${canonicalId}.`,
      });
    });
  });

  it("rejects duplicate closure when the canonical target does not exist", async () => {
    await withTempPmPath(async (context) => {
      const duplicateId = createTask(context, "duplicate missing target");

      await expect(
        runClose(
          duplicateId,
          "Duplicate of missing item",
          {
            duplicateOf: "pm-missing-target",
            validateClose: "warn",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("rejects duplicate closure when the item references itself", async () => {
    await withTempPmPath(async (context) => {
      const duplicateId = createTask(context, "duplicate self target");

      await expect(
        runClose(
          duplicateId,
          "Duplicate of itself",
          {
            duplicateOf: duplicateId,
            validateClose: "warn",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        context: expect.objectContaining({ code: "duplicate_target_self" }),
      });
    });
  });

  it("rejects duplicate closure when the canonical target points back to the closing item", async () => {
    await withTempPmPath(async (context) => {
      const closingId = createTask(context, "duplicate circular closing item");
      const targetId = createTask(context, "duplicate circular target");
      await patchTaskToon(context, targetId, (content) => content.replace("author: seed-author\n", `author: seed-author\nduplicate_of: ${closingId}\n`));

      await expect(
        runClose(
          closingId,
          "Duplicate of circular target",
          {
            duplicateOf: targetId,
            validateClose: "warn",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        context: expect.objectContaining({ code: "duplicate_target_circular" }),
      });
    });
  });

  it("rejects duplicate closure when the canonical target chain points back to the closing item", async () => {
    await withTempPmPath(async (context) => {
      const closingId = createTask(context, "duplicate indirect circular closing item");
      const targetId = createTask(context, "duplicate indirect circular target");
      const intermediateId = createTask(context, "duplicate indirect circular intermediate");
      await patchTaskToon(context, targetId, (content) =>
        content.replace("author: seed-author\n", `author: seed-author\nduplicate_of: ${intermediateId}\n`),
      );
      await patchTaskToon(context, intermediateId, (content) =>
        content.replace("author: seed-author\n", `author: seed-author\nduplicate_of: ${closingId}\n`),
      );

      await expect(
        runClose(
          closingId,
          "Duplicate of indirect circular target",
          {
            duplicateOf: targetId,
            validateClose: "warn",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        context: expect.objectContaining({ code: "duplicate_target_circular" }),
      });
    });
  });

  it("rejects duplicate closure when the canonical target is itself a duplicate", async () => {
    await withTempPmPath(async (context) => {
      const closingId = createTask(context, "duplicate target duplicate closing item");
      const targetId = createTask(context, "duplicate target duplicate candidate");
      const canonicalId = createTask(context, "duplicate target duplicate canonical");
      await patchTaskToon(context, targetId, (content) =>
        content.replace("author: seed-author\n", `author: seed-author\nduplicate_of: ${canonicalId}\n`),
      );

      await expect(
        runClose(
          closingId,
          "Duplicate of duplicate target",
          {
            duplicateOf: targetId,
            validateClose: "warn",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        context: expect.objectContaining({ code: "duplicate_target_is_duplicate" }),
      });
    });
  });

  it("rejects duplicate closure when target loops to itself without referencing the closing item", async () => {
    await withTempPmPath(async (context) => {
      const closingId = createTask(context, "duplicate non-closing loop closing item");
      const targetId = createTask(context, "duplicate non-closing loop target");
      const intermediateId = createTask(context, "duplicate non-closing loop intermediate");
      await patchTaskToon(context, targetId, (content) =>
        content.replace("author: seed-author\n", `author: seed-author\nduplicate_of: ${intermediateId}\n`),
      );
      await patchTaskToon(context, intermediateId, (content) =>
        content.replace("author: seed-author\n", `author: seed-author\nduplicate_of: ${targetId}\n`),
      );

      await expect(
        runClose(
          closingId,
          "duplicate loop without closing-id reference",
          {
            duplicateOf: targetId,
            validateClose: "warn",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        context: expect.objectContaining({ code: "duplicate_target_is_duplicate" }),
      });
    });
  });

  it("handles nullish cached duplicate lookups defensively", async () => {
    await withTempPmPath(async (context) => {
      const closingId = createTask(context, "duplicate cache-nullish closing item");
      const targetId = createTask(context, "duplicate cache-nullish target");
      const intermediateId = createTask(context, "duplicate cache-nullish intermediate");
      await patchTaskToon(context, targetId, (content) =>
        content.replace("author: seed-author\n", `author: seed-author\nduplicate_of: ${intermediateId}\n`),
      );
      await patchTaskToon(context, intermediateId, (content) =>
        content.replace("author: seed-author\n", `author: seed-author\nduplicate_of: ${targetId}\n`),
      );

      const originalGet = Map.prototype.get;
      let forcedNullishOnce = false;
      const getSpy = vi.spyOn(Map.prototype, "get").mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
        if (!forcedNullishOnce && key === targetId && this.has(key)) {
          forcedNullishOnce = true;
          return null;
        }
        return originalGet.call(this, key);
      });
      try {
        await expect(
          runClose(
            closingId,
            "duplicate loop with defensive cache fallback",
            {
              duplicateOf: targetId,
              validateClose: "warn",
            },
            { path: context.pmPath },
          ),
        ).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.USAGE,
        });
      } finally {
        getSpy.mockRestore();
      }
    });
  });

  it("rejects blank close reason text with actionable guidance", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-blank-reason");
      const error = await runClose(id, "   ", {}, { path: context.pmPath }).then(
        () => {
          throw new Error("expected runClose to reject");
        },
        (caught: unknown) => caught as PmCliError,
      );
      expect(error.exitCode).toBe(EXIT_CODE.USAGE);
      // Never-block: the error must tell an agent how to recover, not just name
      // the internal governance knob.
      expect(error.context.code).toBe("close_reason_required");
      expect(error.context.examples?.some((example) => example.includes("--reason"))).toBe(true);
      expect(error.context.nextSteps?.some((step) => step.includes("governance-require-close-reason"))).toBe(true);
    });
  });

  it("warns when --validate-close warn is enabled and resolution fields are missing", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-validate-warn");
      const result = await runClose(
        id,
        "close with warn validation",
        {
          validateClose: "warn",
        },
        { path: context.pmPath },
      );
      const item = result.item as Record<string, unknown>;
      expect(item.status).toBe("closed");
      expect(result.warnings).toEqual([
        `close_validation_missing_fields:${id}:resolution,expected_result,actual_result`,
      ]);
    });
  });

  it("warns when closing a parent with active child items", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createTask(context, "close-parent-active-child");
      const childId = createTask(context, "close-child-active", { parent: parentId });
      const result = await runClose(
        parentId,
        "close parent with active child",
        {
          validateClose: "warn",
        },
        { path: context.pmPath },
      );
      expect(result.warnings).toContain(`close_validation_active_children:${parentId}:${childId}`);
    });
  });

  it("lists active child warning ids in sorted order", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createTask(context, "close-parent-sorted-child-warning");
      const childZ = createTask(context, "close-child-zeta", { parent: parentId });
      const childA = createTask(context, "close-child-alpha", { parent: parentId });
      const result = await runClose(
        parentId,
        "close parent with sorted child warning",
        {
          validateClose: "warn",
        },
        { path: context.pmPath },
      );
      expect(result.warnings).toContain(`close_validation_active_children:${parentId}:${[childA, childZ].sort().join(",")}`);
    });
  });

  it("fails when --validate-close strict is enabled and resolution fields are missing", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-validate-strict");
      await expect(
        runClose(
          id,
          "close with strict validation",
          {
            validateClose: "strict",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("fails when --validate-close strict is enabled and active child items remain", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createTask(context, "close-strict-active-child-parent");
      const childId = createTask(context, "close-strict-active-child", { parent: parentId });

      await expect(
        runClose(
          parentId,
          "close with strict child validation",
          {
            validateClose: "strict",
            resolution: "Parent appears done",
            expectedResult: "No child work remains",
            actualResult: "Child work is still open",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining(childId),
      });
    });
  });

  it("pm close accepts --expected and --actual short aliases as commander flags (pm-1lws)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-short-alias-flags");
      const result = context.runCli(
        [
          "close",
          id,
          "Done with short aliases",
          "--json",
          "--validate-close",
          "strict",
          "--resolution",
          "Implemented and merged",
          "--expected",
          "Short --expected sets expected_result",
          "--actual",
          "Short --actual sets actual_result",
        ],
        { expectJson: true },
      );
      expect(result.code).toBe(0);
      const payload = result.json as {
        item: { status: string; expected_result?: string; actual_result?: string };
      };
      expect(payload.item.status).toBe("closed");
      expect(payload.item.expected_result).toBe("Short --expected sets expected_result");
      expect(payload.item.actual_result).toBe("Short --actual sets actual_result");
    });
  });

  it("accepts inline resolution/expected_result/actual_result so --validate-close strict succeeds in one shot (pm-fl0c #11)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-inline-closure-fields");
      const result = await runClose(
        id,
        "All AC met",
        {
          validateClose: "strict",
          resolution: "Implemented and merged",
          expectedResult: "Inline closure flags accepted",
          actualResult: "Closure validation passes in one call",
        },
        { path: context.pmPath },
      );
      expect(result.warnings).toEqual([]);
      const item = result.item as Record<string, unknown>;
      expect(item.status).toBe("closed");
      expect(item.resolution).toBe("Implemented and merged");
      expect(item.expected_result).toBe("Inline closure flags accepted");
      expect(item.actual_result).toBe("Closure validation passes in one call");
      expect(result.changed_fields).toEqual(
        expect.arrayContaining(["status", "close_reason", "resolution", "expected_result", "actual_result"]),
      );
    });
  });

  it("ignores blank inline closure fields while applying non-blank values", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-blank-inline-resolution");
      const result = await runClose(
        id,
        "close with partially blank inline fields",
        {
          validateClose: "off",
          resolution: "   ",
          expectedResult: "expected kept",
          actualResult: "actual kept",
        },
        { path: context.pmPath },
      );
      const item = result.item as Record<string, unknown>;
      expect(item.close_reason).toBe("close with partially blank inline fields");
      expect(item.resolution).toBeUndefined();
      expect(item.expected_result).toBe("expected kept");
      expect(item.actual_result).toBe("actual kept");
      expect(result.changed_fields).toContain("expected_result");
      expect(result.changed_fields).toContain("actual_result");
      expect(result.changed_fields).not.toContain("resolution");
    });
  });

  it("uses settings author fallback when option and PM_AUTHOR are unset", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-settings-author");
      const previousPmAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;

      try {
        const settingsPath = path.join(context.pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
        settings.author_default = "settings-author";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const result = await runClose(
          id,
          "close using settings author fallback",
          {
            message: "Close with settings fallback author",
          },
          { path: context.pmPath },
        );

        const item = result.item as Record<string, unknown>;
        expect(item.status).toBe("closed");
        expect(item.close_reason).toBe("close using settings author fallback");
        expect(latestCloseAuthor(context, id)).toBe("settings-author");
      } finally {
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });

  it("emits an informational closed_with_active_children note under minimal governance (C3)", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createTask(context, "close-parent-minimal-gov");
      const childId = createTask(context, "close-child-minimal-gov", { parent: parentId });
      const result = await runClose(
        parentId,
        "close parent under minimal governance",
        {
          validateClose: "off",
        },
        { path: context.pmPath },
      );
      const item = result.item as Record<string, unknown>;
      expect(item.status).toBe("closed");
      // Off mode never blocks, but still surfaces the orphaning risk.
      expect(result.warnings).toContain(`closed_with_active_children:${parentId}:${childId}`);
      expect(result.warnings).not.toContain(`close_validation_active_children:${parentId}:${childId}`);
    });
  });

  it("clears stale blocked_by metadata and dependency edge on terminal close (C4)", async () => {
    await withTempPmPath(async (context) => {
      const blockerId = createTask(context, "close-c4-blocker");
      const blockedId = createTask(context, "close-c4-blocked");
      const updated = context.runCli(
        ["update", blockedId, "--blocked-by", blockerId, "--blocked-reason", "waiting on blocker", "--json"],
        { expectJson: true },
      );
      expect(updated.code).toBe(0);

      const result = await runClose(blockedId, "blocker resolved, work done", {}, { path: context.pmPath });
      const item = result.item as Record<string, unknown>;
      expect(item.status).toBe("closed");
      expect(item.blocked_by).toBeUndefined();
      expect(item.blocked_reason).toBeUndefined();
      expect(item.dependencies).toBeUndefined();
      expect(result.changed_fields).toEqual(expect.arrayContaining(["blocked_by", "blocked_reason", "dependencies"]));
      expect(result.warnings).toContain(`closed_cleared_blocked_by:${blockedId}:${blockerId}`);
    });
  });

  it("clears a stale blocked_reason on close even when blocked_by is absent (C4)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-c4-reason-only");
      const updated = context.runCli(
        ["update", id, "--blocked-reason", "lingering reason without a blocker", "--json"],
        { expectJson: true },
      );
      expect(updated.code).toBe(0);

      const result = await runClose(id, "done despite stale reason", {}, { path: context.pmPath });
      const item = result.item as Record<string, unknown>;
      expect(item.blocked_reason).toBeUndefined();
      expect(result.changed_fields).toContain("blocked_reason");
      expect(result.warnings).toContain(`closed_cleared_blocked_by:${id}:unknown`);
    });
  });

  it("clears stale close_reason when close reasons are optional and no reason is provided", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-clear-stale-reason");
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        governance?: { require_close_reason?: boolean };
      };
      settings.governance = {
        ...(settings.governance ?? {}),
        require_close_reason: false,
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      await patchTaskToon(context, id, (content) =>
        content.replace("author: seed-author\n", 'author: seed-author\nclose_reason: "stale previous reason"\n'),
      );

      const result = await runClose(
        id,
        undefined,
        {
          validateClose: "off",
          message: "Close without reason after disabling reason governance",
        },
        { path: context.pmPath },
      );

      expect(result.item.close_reason).toBeUndefined();
      expect(result.changed_fields).toContain("close_reason");
    });
  });

  it("clears an orphan blocked_by dependency edge on close even without the scalar (C4)", async () => {
    await withTempPmPath(async (context) => {
      const blockerId = createTask(context, "close-c4-orphan-blocker");
      const blockedId = createTask(context, "close-c4-orphan-blocked");
      // Add a blocked_by dependency edge directly (no scalar blocked_by set).
      const updated = context.runCli(
        ["update", blockedId, "--dep", `id=${blockerId},kind=blocked_by`, "--json"],
        { expectJson: true },
      );
      expect(updated.code).toBe(0);

      const result = await runClose(blockedId, "done, drop orphan edge", {}, { path: context.pmPath });
      const item = result.item as Record<string, unknown>;
      expect(item.dependencies).toBeUndefined();
      expect(result.changed_fields).toContain("dependencies");
      expect(result.warnings).toContain(`closed_cleared_blocked_by:${blockedId}:${blockerId}`);
    });
  });

  it("keeps non-blocking dependency edges when clearing stale blocked_by edge on close (C4)", async () => {
    await withTempPmPath(async (context) => {
      const blockerId = createTask(context, "close-c4-mixed-blocker");
      const relatedId = createTask(context, "close-c4-mixed-related");
      const blockedId = createTask(context, "close-c4-mixed-blocked");
      const updated = context.runCli(
        [
          "update",
          blockedId,
          "--dep",
          `id=${blockerId},kind=blocked_by`,
          "--dep",
          `id=${relatedId},kind=related`,
          "--json",
        ],
        { expectJson: true },
      );
      expect(updated.code).toBe(0);

      const result = await runClose(blockedId, "done, keep related edge", {}, { path: context.pmPath });
      const item = result.item as { dependencies?: Array<{ id: string; kind: string }> };
      expect(item.dependencies).toEqual([expect.objectContaining({ id: relatedId, kind: "related" })]);
      expect(result.changed_fields).toContain("dependencies");
      expect(result.warnings).toContain(`closed_cleared_blocked_by:${blockedId}:${blockerId}`);
    });
  });

  it("rejects terminal items unless forced and supports unknown author fallback", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-terminal-item", { status: "closed" });
      await expect(runClose(id, "already terminal", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
      });

      const previousPmAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;

      try {
        const settingsPath = path.join(context.pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
        settings.author_default = "   ";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const forced = await runClose(
          id,
          "forced terminal close",
          {
            author: "   ",
            message: "force close",
            force: true,
          },
          { path: context.pmPath },
        );

        const item = forced.item as Record<string, unknown>;
        expect(item.status).toBe("closed");
        expect(item.close_reason).toBe("forced terminal close");
        expect(latestCloseAuthor(context, id)).toBe("unknown");
      } finally {
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });
});

interface CloseManyResultPayload {
  mode: string;
  matched_count?: number;
  closed_count?: number;
  skipped_count?: number;
  failed_count?: number;
  restored_count?: number;
  ids?: string[];
  rows?: Array<{ id: string; status: string; skip_reason?: string; error?: string }>;
  item_plans?: Array<{ id: string; status: string; action: string; skip_reason?: string; active_child_ids?: string[] }>;
  checkpoint?: { id: string; rollback_command: string };
}

describe("runCloseMany via CLI", () => {
  it("fails when close-many tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-close-many-not-init-"));
    try {
      const { runCloseMany } = await import("../../../src/cli/commands/close-many.js");
      await expect(
        runCloseMany(
          {
            list: { ids: "pm-missing" },
            reason: "not initialized",
          },
          { path: tempDir },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires at least one filter before scoping a bulk close", async () => {
    await withTempPmPath(async (context) => {
      const result = context.runCli(["close-many", "--reason", "no filter supplied", "--json"]);
      expect(result.code).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toContain("at least one filter");
    });
  });

  it("rejects null and empty programmatic filters instead of matching every item", async () => {
    await withTempPmPath(async (context) => {
      createTestItemId(context, { title: "close-many-null-filter", tags: "null-filter", status: "open" });

      await expect(
        import("../../../src/cli/commands/close-many.js").then(({ runCloseMany }) =>
          runCloseMany(
            {
              status: null as unknown as string,
              list: { ids: "" },
              reason: "null filter should not match all",
            },
            { path: context.pmPath },
          ),
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("rejects whitespace-only close-many filters instead of matching every item", async () => {
    await withTempPmPath(async (context) => {
      createTestItemId(context, { title: "close-many-blank-filter", tags: "blank-filter", status: "open" });
      const { runCloseMany } = await import("../../../src/cli/commands/close-many.js");

      await expect(
        runCloseMany(
          {
            status: " , ",
            list: { tag: "   " },
            reason: "blank filters should not match all",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("accepts a status-scoped close-many call when list options are omitted", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, {
        title: "close-many-status-only",
        tags: "status-only",
        status: "open",
      });
      const { runCloseMany } = await import("../../../src/cli/commands/close-many.js");

      const result = await runCloseMany(
        {
          status: "open",
          reason: "status-only close-many dry-run",
          dryRun: true,
        },
        { path: context.pmPath },
      );

      expect(result.matched_count).toBeGreaterThanOrEqual(1);
      expect(result.item_plans?.some((plan) => plan.id === id && plan.action === "close")).toBe(true);
    });
  });

  it("accepts a nested list status filter as close-many scope", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, {
        title: "close-many-nested-status",
        tags: "nested-status",
        status: "open",
      });
      const { runCloseMany } = await import("../../../src/cli/commands/close-many.js");

      const result = await runCloseMany(
        {
          list: { status: "open" },
          reason: "nested status close-many dry-run",
          dryRun: true,
        },
        { path: context.pmPath },
      );

      expect(result.matched_count).toBeGreaterThanOrEqual(1);
      expect(result.item_plans?.some((plan) => plan.id === id && plan.action === "close")).toBe(true);
    });
  });

  it("ignores inactive programmatic filters when another close-many filter scopes the batch", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, {
        title: "close-many-inactive-filter",
        tags: "inactive-filter",
        status: "open",
      });
      const { runCloseMany } = await import("../../../src/cli/commands/close-many.js");

      const result = await runCloseMany(
        {
          list: { tag: "inactive-filter", ids: " , ", updatedAfter: null as unknown as string },
          reason: "inactive filters ignored",
          dryRun: true,
        },
        { path: context.pmPath },
      );

      expect(result.matched_count).toBe(1);
      expect(result.item_plans?.[0]?.id).toBe(id);
    });
  });

  it("requires a shared close reason for apply and dry-run", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "close-many-needs-reason");
      const result = context.runCli(["close-many", "--filter-tag", "close", "--json"]);
      expect(result.code).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toContain("requires a shared close reason");

      const dryRun = context.runCli(["close-many", "--filter-tag", "close", "--dry-run", "--json"]);
      expect(dryRun.code).not.toBe(0);
      expect(`${dryRun.stderr}${dryRun.stdout}`).toContain("requires a shared close reason");
    });
  });

  it("previews matched plans in dry-run without mutating any items", async () => {
    await withTempPmPath(async (context) => {
      const openId = createTestItemId(context, { title: "close-many-dry-open", tags: "dryrun", status: "open" });
      const closedId = createTestItemId(context, {
        title: "close-many-dry-closed",
        tags: "dryrun",
        status: "closed",
      });

      const result = context.runCli(
        ["close-many", "--filter-tag", "dryrun", "--reason", "dry-run preview", "--dry-run", "--json"],
        { expectJson: true },
      );
      expect(result.code).toBe(0);
      const payload = result.json as CloseManyResultPayload;
      expect(payload.mode).toBe("dry_run");
      expect(payload.matched_count).toBe(2);
      const plans = payload.item_plans ?? [];
      const openPlan = plans.find((plan) => plan.id === openId);
      const closedPlan = plans.find((plan) => plan.id === closedId);
      expect(openPlan?.action).toBe("close");
      expect(closedPlan?.action).toBe("skip");
      expect(closedPlan?.skip_reason).toBe("already_terminal");

      // Dry-run must not mutate: the open item stays open.
      expect(itemStatus(context, openId)).toBe("open");
    });
  });

  it("closes matched open items, skips already-terminal matches, and emits a rollback checkpoint", async () => {
    await withTempPmPath(async (context) => {
      const openId = createTestItemId(context, { title: "close-many-apply-open", tags: "apply", status: "open" });
      const alreadyClosedId = createTestItemId(context, {
        title: "close-many-apply-closed",
        tags: "apply",
        status: "closed",
      });

      const result = context.runCli(
        ["close-many", "--filter-tag", "apply", "--reason", "bulk apply close", "--json"],
        { expectJson: true },
      );
      expect(result.code).toBe(0);
      const payload = result.json as CloseManyResultPayload;
      expect(payload.mode).toBe("apply");
      expect(payload.closed_count).toBe(1);
      expect(payload.skipped_count).toBe(1);
      expect(payload.failed_count).toBe(0);
      expect(payload.ids).toEqual([openId]);
      const closedRow = (payload.rows ?? []).find((row) => row.id === openId);
      const skippedRow = (payload.rows ?? []).find((row) => row.id === alreadyClosedId);
      expect(closedRow?.status).toBe("closed");
      expect(skippedRow?.status).toBe("skipped");
      expect(skippedRow?.skip_reason).toBe("already_terminal");
      expect(typeof payload.checkpoint?.id).toBe("string");
      expect(payload.checkpoint?.rollback_command).toContain("close-many --rollback");

      // The matched open item is now closed.
      expect(itemStatus(context, openId)).toBe("closed");
    });
  });

  it("re-closes an already-terminal match under --force", async () => {
    await withTempPmPath(async (context) => {
      createTestItemId(context, { title: "close-many-force-closed", tags: "force", status: "closed" });

      const result = context.runCli(
        ["close-many", "--filter-tag", "force", "--reason", "force re-close", "--force", "--json"],
        { expectJson: true },
      );
      expect(result.code).toBe(0);
      const payload = result.json as CloseManyResultPayload;
      expect(payload.mode).toBe("apply");
      expect(payload.closed_count).toBe(1);
      expect(payload.skipped_count).toBe(0);
    });
  });

  it("rolls back a prior apply checkpoint to restore items to their pre-close state", async () => {
    await withTempPmPath(async (context) => {
      const openId = createTestItemId(context, { title: "close-many-rollback", tags: "rollback", status: "open" });

      const apply = context.runCli(
        ["close-many", "--filter-tag", "rollback", "--reason", "close before rollback", "--json"],
        { expectJson: true },
      );
      expect(apply.code).toBe(0);
      const applyPayload = apply.json as CloseManyResultPayload;
      const checkpointId = applyPayload.checkpoint?.id;
      expect(typeof checkpointId).toBe("string");
      expect(itemStatus(context, openId)).toBe("closed");

      const rollback = context.runCli(
        ["close-many", "--rollback", String(checkpointId), "--json"],
        { expectJson: true },
      );
      expect(rollback.code).toBe(0);
      const rollbackPayload = rollback.json as CloseManyResultPayload;
      expect(rollbackPayload.mode).toBe("rollback");
      expect(rollbackPayload.restored_count).toBe(1);
      // The item is restored to its prior open status.
      expect(itemStatus(context, openId)).toBe("open");
    });
  });

  it("rejects limit and offset in rollback mode", async () => {
    await withTempPmPath(async (context) => {
      const openId = createTestItemId(context, {
        title: "close-many-rollback-limit",
        tags: "rollback-limit",
        status: "open",
      });

      const apply = context.runCli(
        ["close-many", "--filter-tag", "rollback-limit", "--reason", "close before rollback", "--json"],
        { expectJson: true },
      );
      expect(apply.code).toBe(0);
      expect(itemStatus(context, openId)).toBe("closed");
      const checkpointId = (apply.json as CloseManyResultPayload).checkpoint?.id;

      const rollback = context.runCli(["close-many", "--rollback", String(checkpointId), "--limit", "1", "--json"]);
      expect(rollback.code).not.toBe(0);
      expect(`${rollback.stderr}${rollback.stdout}`).toContain("Rollback mode does not accept filter options");

      const offsetRollback = context.runCli([
        "close-many",
        "--rollback",
        String(checkpointId),
        "--offset",
        "1",
        "--json",
      ]);
      expect(offsetRollback.code).not.toBe(0);
      expect(`${offsetRollback.stderr}${offsetRollback.stdout}`).toContain("Rollback mode does not accept filter options");
    });
  });

  it("rejects numeric rollback limit and offset without crashing", async () => {
    await withTempPmPath(async (context) => {
      const openId = createTestItemId(context, {
        title: "close-many-rollback-numeric-limit",
        tags: "rollback-numeric-limit",
        status: "open",
      });
      const { runCloseMany } = await import("../../../src/cli/commands/close-many.js");
      const apply = await runCloseMany(
        {
          list: { tag: "rollback-numeric-limit" },
          reason: "close before numeric rollback guard",
        },
        { path: context.pmPath },
      );
      expect(apply.closed_count).toBe(1);
      expect(itemStatus(context, openId)).toBe("closed");

      await expect(
        runCloseMany(
          {
            rollback: String(apply.checkpoint?.id),
            list: { limit: 1 as unknown as string, offset: 0 as unknown as string },
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Rollback mode does not accept filter options"),
      });
    });
  });

  it("treats numeric offset as a rollback filter conflict", async () => {
    expect(closeManyInternals.hasCloseManyRollbackConflicts({ offset: 0 as unknown as string }, undefined)).toBe(true);
  });

  it("uses default rollback message when none is provided", async () => {
    await withTempPmPath(async (context) => {
      const openId = createTestItemId(context, {
        title: "close-many-rollback-default-message",
        tags: "rollback-default-message",
        status: "open",
      });
      const { runCloseMany } = await import("../../../src/cli/commands/close-many.js");
      const apply = await runCloseMany(
        {
          list: { tag: "rollback-default-message" },
          reason: "create checkpoint for default rollback message",
        },
        { path: context.pmPath },
      );
      expect(itemStatus(context, openId)).toBe("closed");
      const rollback = await runCloseMany(
        {
          rollback: String(apply.checkpoint?.id),
          list: {},
        },
        { path: context.pmPath },
      );
      expect(rollback.mode).toBe("rollback");
      expect(rollback.restored_count).toBe(1);
      expect(itemStatus(context, openId)).toBe("open");
    });
  });

  it("rejects dry-run rollback mode before reading a checkpoint", async () => {
    await withTempPmPath(async (context) => {
      const { runCloseMany } = await import("../../../src/cli/commands/close-many.js");

      await expect(
        runCloseMany(
          {
            rollback: "missing-checkpoint",
            list: {},
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

  it("can apply without creating a rollback checkpoint", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "close-many-no-checkpoint", tags: "no-checkpoint", status: "open" });
      const { runCloseMany } = await import("../../../src/cli/commands/close-many.js");

      const result = await runCloseMany(
        {
          list: { tag: "no-checkpoint" },
          reason: "close without checkpoint",
          checkpoint: false,
        },
        { path: context.pmPath },
      );

      expect(result.mode).toBe("apply");
      expect(result.checkpoint).toBeUndefined();
      expect(result.closed_count).toBe(1);
      expect(result.ids).toEqual([id]);
      expect(itemStatus(context, id)).toBe("closed");
    });
  });

  it("directly applies, skips terminal rows, and rolls back from the generated checkpoint", async () => {
    await withTempPmPath(async (context) => {
      const openId = createTestItemId(context, { title: "close-many-direct-open", tags: "direct-apply", status: "open" });
      const closedId = createTestItemId(context, {
        title: "close-many-direct-closed",
        tags: "direct-apply",
        status: "closed",
      });
      const { runCloseMany } = await import("../../../src/cli/commands/close-many.js");

      const apply = await runCloseMany(
        {
          list: { tag: "direct-apply" },
          reason: "direct apply close",
          author: "direct-author",
        },
        { path: context.pmPath },
      );

      expect(apply.mode).toBe("apply");
      expect(apply.closed_count).toBe(1);
      expect(apply.skipped_count).toBe(1);
      expect(apply.failed_count).toBe(0);
      expect(apply.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: openId, status: "closed" }),
          expect.objectContaining({ id: closedId, status: "skipped", skip_reason: "already_terminal" }),
        ]),
      );
      expect(itemStatus(context, openId)).toBe("closed");

      const rollback = await runCloseMany(
        {
          rollback: String(apply.checkpoint?.id),
          list: {},
          author: "rollback-author",
          message: "direct rollback",
        },
        { path: context.pmPath },
      );

      expect(rollback.mode).toBe("rollback");
      expect(rollback.restored_count).toBe(1);
      expect(rollback.failed_count).toBe(0);
      expect(rollback.ids).toEqual([openId]);
      expect(itemStatus(context, openId)).toBe("open");
    });
  });

  it("directly returns failed rows when strict validation rejects a close", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "close-many-direct-strict", tags: "direct-strict", status: "open" });
      const { runCloseMany } = await import("../../../src/cli/commands/close-many.js");

      const result = await runCloseMany(
        {
          list: { tag: "direct-strict" },
          reason: "direct strict close",
          validateClose: "strict",
          checkpoint: false,
        },
        { path: context.pmPath },
      );

      expect(result.mode).toBe("apply");
      expect(result.closed_count).toBe(0);
      expect(result.failed_count).toBe(1);
      expect(result.rows).toEqual([
        expect.objectContaining({
          id,
          status: "failed",
          error: expect.stringContaining("missing resolution"),
        }),
      ]);
      expect(itemStatus(context, id)).toBe("open");
    });
  });

  it("annotates active-child orphans for matched parents in dry-run", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createTestItemId(context, {
        title: "close-many-parent",
        tags: "orphan-parent",
        status: "open",
      });
      const childId = createTestItemId(context, {
        title: "close-many-child",
        tags: "orphan-child",
        status: "open",
        parent: parentId,
      });

      const result = context.runCli(
        ["close-many", "--ids", parentId, "--reason", "close parent", "--dry-run", "--json"],
        { expectJson: true },
      );
      expect(result.code).toBe(0);
      const payload = result.json as CloseManyResultPayload;
      const parentPlan = (payload.item_plans ?? []).find((plan) => plan.id === parentId);
      expect(parentPlan?.active_child_ids).toContain(childId);
    });
  });

  it("keeps only still-open external children in close-many dry-run plan annotations", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createTestItemId(context, {
        title: "close-many-mixed-children-parent",
        tags: "mixed-children,parent-tag",
        status: "open",
      });
      const matchedChildId = createTestItemId(context, {
        title: "close-many-mixed-children-matched",
        tags: "mixed-children,parent-tag",
        status: "open",
        parent: parentId,
      });
      const externalChildId = createTestItemId(context, {
        title: "close-many-mixed-children-external",
        tags: "external-child-tag",
        status: "open",
        parent: parentId,
      });
      const { runCloseMany } = await import("../../../src/cli/commands/close-many.js");
      const payload = await runCloseMany(
        {
          list: { ids: `${parentId},${matchedChildId}` },
          reason: "mixed children dry-run",
          dryRun: true,
        },
        { path: context.pmPath },
      );
      const parentPlan = (payload.item_plans ?? []).find((plan) => plan.id === parentId);
      const childPlan = (payload.item_plans ?? []).find((plan) => plan.id === matchedChildId);
      expect(parentPlan).toBeDefined();
      expect(parentPlan?.active_child_ids).toEqual([externalChildId]);
      expect(childPlan?.active_child_ids).toBeUndefined();
    });
  });

  it("accepts dry-run validation mode metadata without requiring a reason when governance allows empty close reasons", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, {
        title: "close-many-dry-run-validate-close",
        tags: "dry-validate-close",
        status: "open",
      });
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        governance?: { require_close_reason?: boolean };
      };
      settings.governance = {
        ...(settings.governance ?? {}),
        require_close_reason: false,
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      const { runCloseMany } = await import("../../../src/cli/commands/close-many.js");

      const result = await runCloseMany(
        {
          list: { ids: id },
          validateClose: "warn",
          dryRun: true,
        },
        { path: context.pmPath },
      );
      expect(result.mode).toBe("dry_run");
      expect(result.reason).toBeUndefined();
      expect(result.validate_close).toBe("warn");
    });
  });

  it("surfaces per-row warnings and omits shared reason when governance allows empty close reasons", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, {
        title: "close-many-row-warnings",
        tags: "row-warnings",
        status: "open",
      });
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        governance?: { require_close_reason?: boolean };
      };
      settings.governance = {
        ...(settings.governance ?? {}),
        require_close_reason: false,
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      const { runCloseMany } = await import("../../../src/cli/commands/close-many.js");

      const result = await runCloseMany(
        {
          list: { ids: id },
          checkpoint: true,
          validateClose: "warn",
          // Intentionally omit reason so result object exercises the undefined branch.
        },
        { path: context.pmPath },
      );

      expect(result.mode).toBe("apply");
      expect(result.reason).toBeUndefined();
      expect(result.validate_close).toBe("warn");
      const closedRow = (result.rows ?? []).find((row) => row.id === id);
      expect(closedRow?.status).toBe("closed");
      expect(closedRow?.warnings?.some((warning) => warning.startsWith("close_validation_missing_fields:"))).toBe(true);
    });
  });

  it("closes children before parents when both are matched in strict mode", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createTestItemId(context, {
        title: "close-many-strict-parent",
        tags: "strict-family",
        status: "open",
      });
      const childId = createTestItemId(context, {
        title: "close-many-strict-child",
        tags: "strict-family",
        status: "open",
        parent: parentId,
      });
      const grandchildId = createTestItemId(context, {
        title: "close-many-strict-grandchild",
        tags: "strict-family",
        status: "open",
        parent: childId,
      });

      const preview = context.runCli(
        ["close-many", "--filter-tag", "strict-family", "--reason", "strict family close", "--dry-run", "--json"],
        { expectJson: true },
      );
      expect(preview.code).toBe(0);
      const previewPayload = preview.json as CloseManyResultPayload;
      const parentPlan = (previewPayload.item_plans ?? []).find((plan) => plan.id === parentId);
      expect(parentPlan?.active_child_ids).toBeUndefined();

      const result = context.runCli(
        [
          "close-many",
          "--filter-tag",
          "strict-family",
          "--reason",
          "strict family close",
          "--validate-close",
          "strict",
          "--resolution",
          "finished",
          "--expected-result",
          "family closed",
          "--actual-result",
          "family closed",
          "--json",
        ],
        { expectJson: true },
      );

      expect(result.code).toBe(0);
      const payload = result.json as CloseManyResultPayload;
      expect(payload.failed_count).toBe(0);
      expect(payload.closed_count).toBe(3);
      expect(payload.rows?.map((row) => row.id)).toEqual([grandchildId, childId, parentId]);
      expect(itemStatus(context, parentId)).toBe("closed");
      expect(itemStatus(context, childId)).toBe("closed");
      expect(itemStatus(context, grandchildId)).toBe("closed");
    });
  });

  it("reports a failed row when --validate-close strict finds missing closure fields", async () => {
    await withTempPmPath(async (context) => {
      createTestItemId(context, { title: "close-many-strict", tags: "strict-validate", status: "open" });

      const result = context.runCli(
        [
          "close-many",
          "--filter-tag",
          "strict-validate",
          "--reason",
          "strict closure",
          "--validate-close",
          "strict",
          "--json",
        ],
        { expectJson: true },
      );
      expect(result.code).toBe(0);
      const payload = result.json as CloseManyResultPayload;
      expect(payload.mode).toBe("apply");
      expect(payload.failed_count ?? 0).toBeGreaterThanOrEqual(1);
      const failedRow = (payload.rows ?? []).find((row) => row.status === "failed");
      expect(failedRow).toBeDefined();
    });
  });
});
