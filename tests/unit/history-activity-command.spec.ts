import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runActivity } from "../../src/cli/commands/activity.js";
import { readHistoryEntries, runHistory } from "../../src/cli/commands/history.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks, type ExtensionHookRegistry } from "../../src/core/extensions/index.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createItem(context: TempPmContext, title: string): string {
  const result = context.runCli(
    [
      "create",
      "--json",
      "--title",
      title,
      "--description",
      `${title} description`,
      "--type",
      "Task",
      "--status",
      "open",
      "--priority",
      "1",
      "--tags",
      "history,test",
      "--body",
      "",
      "--deadline",
      "none",
      "--estimate",
      "10",
      "--acceptance-criteria",
      `${title} acceptance`,
      "--author",
      "test-author",
      "--message",
      `Create ${title}`,
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
    ],
    { expectJson: true },
  );
  expect(result.code).toBe(0);
  return (result.json as { item: { id: string } }).item.id;
}

describe("runHistory and runActivity", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-history-not-init-"));
    try {
      await expect(runHistory("pm-missing", {}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(runActivity({}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("validates --limit values", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Limit Validation");
      await expect(runHistory(id, { limit: "-1" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runActivity({ limit: "not-a-number" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("returns item history with optional limiting and handles empty/missing history files", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "History Retrieval");
      context.runCli(
        ["append", id, "--json", "--body", "extra body", "--author", "test-author", "--message", "Append for history"],
        { expectJson: true },
      );

      const allHistory = await runHistory(id, {}, { path: context.pmPath });
      expect(allHistory.id).toBe(id);
      expect(allHistory.count).toBeGreaterThanOrEqual(2);
      expect(allHistory.limit).toBeNull();

      const limited = await runHistory(id, { limit: "1" }, { path: context.pmPath });
      expect(limited.count).toBe(1);
      expect(limited.limit).toBe(1);

      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      await writeFile(historyPath, "   \n", "utf8");
      const emptyHistory = await runHistory(id, {}, { path: context.pmPath });
      expect(emptyHistory.count).toBe(0);

      await rm(historyPath, { force: true });
      const missingHistory = await runHistory(id, {}, { path: context.pmPath });
      expect(missingHistory.count).toBe(0);
    });
  });

  it("fails when history target item does not exist", async () => {
    await withTempPmPath(async (context) => {
      await expect(runHistory("pm-does-not-exist", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("rejects malformed history lines", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Malformed History");
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      await appendFile(historyPath, "not-json\n", "utf8");
      await expect(readHistoryEntries(historyPath, id)).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
      });
    });
  });

  it("aggregates activity across item history files deterministically", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createItem(context, "Activity One");
      context.runCli(
        ["update", firstId, "--json", "--status", "in_progress", "--author", "test-author", "--message", "Progress first"],
        { expectJson: true },
      );

      const secondId = createItem(context, "Activity Two");
      const historyDir = path.join(context.pmPath, "history");
      await writeFile(path.join(historyDir, "ignore-me.txt"), "noop", "utf8");

      const allActivity = await runActivity({}, { path: context.pmPath });
      expect(allActivity.count).toBeGreaterThanOrEqual(3);
      expect(allActivity.activity.some((entry) => entry.id === firstId)).toBe(true);
      expect(allActivity.activity.some((entry) => entry.id === secondId)).toBe(true);
      expect(allActivity.limit).toBeNull();

      for (let index = 1; index < allActivity.activity.length; index += 1) {
        const previous = allActivity.activity[index - 1];
        const current = allActivity.activity[index];
        expect(previous.ts.localeCompare(current.ts) >= 0).toBe(true);
      }

      const limited = await runActivity({ limit: "1" }, { path: context.pmPath });
      expect(limited.count).toBe(1);
      expect(limited.limit).toBe(1);
    });
  });

  it("returns empty activity when history directory is missing", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, "Activity Missing History Directory");
      await rm(path.join(context.pmPath, "history"), { recursive: true, force: true });

      const activity = await runActivity({}, { path: context.pmPath });
      expect(activity).toEqual({
        activity: [],
        count: 0,
        limit: null,
      });
    });
  });

  it("propagates non-ENOENT history directory read errors", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, "Activity Invalid History Directory");
      const historyDir = path.join(context.pmPath, "history");
      await rm(historyDir, { recursive: true, force: true });
      await writeFile(historyDir, "not-a-directory", "utf8");

      await expect(runActivity({}, { path: context.pmPath })).rejects.toMatchObject({
        code: "ENOTDIR",
      });
    });
  });

  it("dispatches onRead hooks for activity history directory scans", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Activity Hook Directory");
      const events: string[] = [];
      const hooks: ExtensionHookRegistry = {
        beforeCommand: [],
        afterCommand: [],
        onWrite: [],
        onRead: [
          {
            layer: "project",
            name: "activity-read-hook",
            run: (hookContext) => {
              events.push(path.basename(hookContext.path));
            },
          },
        ],
        onIndex: [],
      };
      setActiveExtensionHooks(hooks);

      const activity = await runActivity({}, { path: context.pmPath });
      expect(activity.count).toBeGreaterThanOrEqual(1);
      expect(events).toContain("history");
      expect(events).toContain(`${id}.jsonl`);
    });
  });

  it("sorts same-timestamp activity by id and operation", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createItem(context, "Tie Break One");
      const secondId = createItem(context, "Tie Break Two");
      const tieTs = "2026-01-01T00:00:00.000Z";
      const historyDir = path.join(context.pmPath, "history");

      await writeFile(
        path.join(historyDir, `${firstId}.jsonl`),
        `${JSON.stringify({
          ts: tieTs,
          author: "test-author",
          op: "z-op",
          patch: [],
          before_hash: "before-1",
          after_hash: "after-1",
        })}\n${JSON.stringify({
          ts: tieTs,
          author: "test-author",
          op: "a-op",
          patch: [],
          before_hash: "before-2",
          after_hash: "after-2",
        })}\n`,
        "utf8",
      );

      await writeFile(
        path.join(historyDir, `${secondId}.jsonl`),
        `${JSON.stringify({
          ts: tieTs,
          author: "test-author",
          op: "m-op",
          patch: [],
          before_hash: "before-3",
          after_hash: "after-3",
        })}\n`,
        "utf8",
      );

      const activity = await runActivity({}, { path: context.pmPath });
      expect(activity.count).toBe(3);

      const expectedOrder =
        firstId.localeCompare(secondId) < 0
          ? [
              { id: firstId, op: "a-op" },
              { id: firstId, op: "z-op" },
              { id: secondId, op: "m-op" },
            ]
          : [
              { id: secondId, op: "m-op" },
              { id: firstId, op: "a-op" },
              { id: firstId, op: "z-op" },
            ];

      expect(activity.activity.map((entry) => ({ id: entry.id, op: entry.op }))).toEqual(expectedOrder);
    });
  });
});
