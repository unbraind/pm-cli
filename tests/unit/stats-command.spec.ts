import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runStats } from "../../src/cli/commands/stats.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks } from "../../src/core/extensions/index.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createItem(
  context: TempPmContext,
  params: {
    title: string;
    type: "Epic" | "Feature" | "Task" | "Chore" | "Issue";
    status: "open" | "blocked" | "closed";
  },
): string {
  const create = context.runCli(
    [
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
      "stats,coverage",
      "--body",
      "seed body",
      "--deadline",
      "none",
      "--estimate",
      "20",
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
    ],
    { expectJson: true },
  );
  expect(create.code).toBe(0);
  return (create.json as { item: { id: string } }).item.id;
}

describe("runStats", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-stats-not-init-"));
    try {
      await expect(runStats({ path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns zeroed history totals when history directory is missing", async () => {
    await withTempPmPath(async (context) => {
      await rm(path.join(context.pmPath, "history"), { recursive: true, force: true });
      const stats = await runStats({ path: context.pmPath });
      expect(stats.totals).toEqual({
        items: 0,
        history_streams: 0,
        history_entries: 0,
      });
      expect(stats.by_type).toEqual({
        Epic: 0,
        Feature: 0,
        Task: 0,
        Chore: 0,
        Issue: 0,
      });
      expect(stats.by_status).toEqual({
        draft: 0,
        open: 0,
        in_progress: 0,
        blocked: 0,
        closed: 0,
        canceled: 0,
      });
      expect(stats.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it("aggregates deterministic item and history summaries", async () => {
    await withTempPmPath(async (context) => {
      const epicId = createItem(context, {
        title: "Stats Epic",
        type: "Epic",
        status: "open",
      });
      createItem(context, {
        title: "Stats Task",
        type: "Task",
        status: "blocked",
      });
      createItem(context, {
        title: "Stats Issue",
        type: "Issue",
        status: "closed",
      });

      const update = context.runCli(
        ["update", epicId, "--json", "--description", "updated", "--author", "test-author", "--message", "Update epic"],
        { expectJson: true },
      );
      expect(update.code).toBe(0);

      const append = context.runCli(
        ["append", epicId, "--json", "--body", "extra body", "--author", "test-author", "--message", "Append epic body"],
        { expectJson: true },
      );
      expect(append.code).toBe(0);

      await writeFile(path.join(context.pmPath, "history", "empty.jsonl"), "", "utf8");

      const stats = await runStats({ path: context.pmPath });
      expect(stats.totals).toEqual({
        items: 3,
        history_streams: 4,
        history_entries: 5,
      });
      expect(stats.by_type).toEqual({
        Epic: 1,
        Feature: 0,
        Task: 1,
        Chore: 0,
        Issue: 1,
      });
      expect(stats.by_status).toEqual({
        draft: 0,
        open: 1,
        in_progress: 0,
        blocked: 1,
        closed: 1,
        canceled: 0,
      });
      expect(stats.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it("dispatches active onRead hooks for history scans without changing output shape", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createItem(context, {
        title: "Stats Hook Item",
        type: "Task",
        status: "open",
      });
      await writeFile(path.join(context.pmPath, "history", "extra.jsonl"), "", "utf8");

      const events: string[] = [];
      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onWrite: [],
        onRead: [
          {
            layer: "project",
            name: "boom-read-hook",
            run: () => {
              throw new Error("boom-read");
            },
          },
          {
            layer: "project",
            name: "ok-read-hook",
            run: (hookContext) => {
              events.push(path.basename(hookContext.path));
            },
          },
        ],
        onIndex: [],
      });

      const stats = await runStats({ path: context.pmPath });
      expect(stats.totals.items).toBe(1);
      expect(stats.by_type.Task).toBe(1);
      expect(stats.by_status.open).toBe(1);
      expect(events).toContain("history");
      expect(events).toContain(`${itemId}.jsonl`);
      expect(events).toContain("extra.jsonl");
    });
  });
});
