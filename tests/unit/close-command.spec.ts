import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runClose } from "../../src/cli/commands/close.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { createTestItemId, type TestItemStatus } from "../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

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

describe("runClose", () => {
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

  it("rejects blank close reason text", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "close-blank-reason");
      await expect(runClose(id, "   ", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
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
