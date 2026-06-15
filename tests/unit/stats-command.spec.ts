import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { _testOnly as statsInternals, runStats } from "../../src/cli/commands/stats.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks } from "../../src/core/extensions/index.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createItem(
  context: TempPmContext,
  params: {
    title: string;
    type:
      | "Epic"
      | "Feature"
      | "Task"
      | "Chore"
      | "Issue"
      | "Event"
      | "Reminder"
      | "Milestone"
      | "Meeting";
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

  it("covers stats pure helper branches", async () => {
    expect(statsInternals.zeroByType(["Task", "Custom"])).toEqual({ Task: 0, Custom: 0 });
    expect(statsInternals.zeroByStatus(["open", "qa"])).toEqual({ open: 0, qa: 0 });
    expect(statsInternals.countNonEmptyLines("")).toBe(0);
    expect(statsInternals.countNonEmptyLines("  \n\t\n")).toBe(0);
    expect(statsInternals.countNonEmptyLines("one\n\n two \n")).toBe(2);

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-stats-helper-"));
    try {
      expect(await statsInternals.readHistoryStreamContents(tempDir)).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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
        Decision: 0,
        Event: 0,
        Reminder: 0,
        Milestone: 0,
        Meeting: 0,
        Plan: 0,
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

  it("fails in strict mode when required history streams are missing", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, {
        title: "Strict stats missing stream",
        type: "Task",
        status: "open",
      });
      const strictSet = context.runCli(
        ["config", "project", "set", "history-missing-stream-policy", "--policy", "strict_error", "--json"],
        { expectJson: true },
      );
      expect(strictSet.code).toBe(0);
      await rm(path.join(context.pmPath, "history", `${id}.jsonl`), { force: true });

      await expect(runStats({ path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
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
        Decision: 0,
        Event: 0,
        Reminder: 0,
        Milestone: 0,
        Meeting: 0,
        Plan: 0,
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

  it("omits storage metrics by default and attaches aggregate metrics with the storage option", async () => {
    await withTempPmPath(async (context) => {
      const epicId = createItem(context, {
        title: "Storage Epic",
        type: "Epic",
        status: "open",
      });
      createItem(context, {
        title: "Storage Task",
        type: "Task",
        status: "open",
      });
      const update = context.runCli(
        ["update", epicId, "--json", "--description", "deeper", "--author", "test-author", "--message", "Deepen epic stream"],
        { expectJson: true },
      );
      expect(update.code).toBe(0);

      const withoutStorage = await runStats({ path: context.pmPath });
      expect(withoutStorage.storage).toBeUndefined();

      const withStorage = await runStats({ path: context.pmPath }, { storage: true });
      expect(withStorage.storage).toBeDefined();
      const storage = withStorage.storage!;
      expect(storage.total_streams).toBe(withStorage.totals.history_streams);
      expect(storage.total_lines).toBe(withStorage.totals.history_entries);
      expect(storage.total_bytes).toBeGreaterThan(0);
      // The epic has the deepest stream (create + update = 2 entries).
      expect(storage.deepest_by_lines[0]).toMatchObject({ id: epicId, lines: 2 });
      expect(storage.largest_by_bytes.length).toBeGreaterThan(0);
      expect(storage.oldest_entry).toMatchObject({ id: expect.any(String), ts: expect.any(String) });
      expect(storage.newest_entry).toMatchObject({ id: expect.any(String), ts: expect.any(String) });
    });
  });

  it("attaches assignee/tag/priority breakdowns and respects the tag-prefix filter", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Breakdown Item",
        type: "Task",
        status: "open",
      });

      const withoutBreakdowns = await runStats({ path: context.pmPath });
      expect(withoutBreakdowns.breakdowns).toBeUndefined();

      const stats = await runStats(
        { path: context.pmPath },
        { byAssignee: true, byTag: true, byPriority: true, tagPrefix: "stats" },
      );
      expect(stats.breakdowns).toBeDefined();
      expect(stats.breakdowns?.assignee).toBeDefined();
      expect(stats.breakdowns?.tag).toBeDefined();
      expect(stats.breakdowns?.priority).toBeDefined();
    });
  });

  it("attaches metadata coverage only when requested", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Coverage Item",
        type: "Task",
        status: "open",
      });

      const withoutCoverage = await runStats({ path: context.pmPath });
      expect(withoutCoverage.metadata_coverage).toBeUndefined();

      const stats = await runStats({ path: context.pmPath }, { metadataCoverage: true });
      expect(stats.metadata_coverage).toBeDefined();
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
