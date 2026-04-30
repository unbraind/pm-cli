import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderContextMarkdown,
  resolveContextOutputFormat,
  runContext,
  type ContextOptions,
} from "../../src/cli/commands/context.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createContextItem(
  context: TempPmContext,
  options: {
    title: string;
    type?: string;
    status?: string;
    priority?: string;
    tags?: string;
    assignee?: string;
    deadline?: string;
    order?: string;
    reminders?: string[];
    events?: string[];
  },
): string {
  const args = [
    "create",
    "--json",
    "--title",
    options.title,
    "--description",
    `${options.title} description`,
    "--type",
    options.type ?? "Task",
    "--status",
    options.status ?? "open",
    "--priority",
    options.priority ?? "1",
    "--tags",
    options.tags ?? "context,unit",
    "--body",
    "",
    "--deadline",
    options.deadline ?? "+1d",
    "--estimate",
    "15",
    "--acceptance-criteria",
    `${options.title} acceptance`,
    "--author",
    "context-test",
    "--message",
    `Create ${options.title}`,
    "--assignee",
    options.assignee ?? "seed-assignee",
    "--dep",
    "id=pm-seed-related,kind=related,author=context-test,created_at=now",
    "--comment",
    "author=context-test,created_at=now,text=seed comment",
    "--note",
    "author=context-test,created_at=now,text=seed note",
    "--learning",
    "author=context-test,created_at=now,text=seed learning",
    "--file",
    "path=README.md,scope=project,note=seed file",
    "--test",
    "command=node dist/cli.js --version,scope=project,note=seed test",
    "--doc",
    "path=README.md,scope=project,note=seed doc",
  ];
  if (options.order !== undefined) {
    args.push("--order", options.order);
  }
  for (const reminder of options.reminders ?? []) {
    args.push("--reminder", reminder);
  }
  for (const event of options.events ?? []) {
    args.push("--event", event);
  }
  const created = context.runCli(args, { expectJson: true });
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

describe("context command module", () => {
  it("resolves output format precedence and conflicts", () => {
    expect(resolveContextOutputFormat({}, { json: false })).toBe("toon");
    expect(resolveContextOutputFormat({ format: "markdown" }, { json: false })).toBe("markdown");
    expect(resolveContextOutputFormat({ format: "  JSON  " }, { json: false })).toBe("json");
    expect(resolveContextOutputFormat({}, { json: true })).toBe("json");
    expect(resolveContextOutputFormat({ format: "json" }, { json: true })).toBe("json");
    expect(() => resolveContextOutputFormat({ format: "toon" }, { json: true })).toThrow(PmCliError);
    expect(() => resolveContextOutputFormat({ format: "xml" }, { json: false })).toThrow(PmCliError);
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-context-not-init-"));
    try {
      await expect(runContext({}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("builds deterministic high-level and low-level focus with agenda context", async () => {
    await withTempPmPath(async (context) => {
      const featureInProgress = createContextItem(context, {
        title: "Feature in progress",
        type: "Feature",
        status: "in_progress",
        priority: "1",
        order: "2",
        deadline: "2026-04-05T09:00:00.000Z",
        events: ["start=2026-04-04T12:00:00.000Z,title=Feature sync"],
      });
      const epicOpen = createContextItem(context, {
        title: "Epic open",
        type: "Epic",
        status: "open",
        priority: "0",
        order: "3",
      });
      const taskOpen = createContextItem(context, {
        title: "Task open critical",
        type: "Task",
        status: "open",
        priority: "0",
        order: "1",
        deadline: "2026-04-04T10:00:00.000Z",
        reminders: ["at=2026-04-04T08:00:00.000Z,text=Task reminder"],
      });
      const issueOpenNoOrder = createContextItem(context, {
        title: "Issue open no order",
        type: "Issue",
        status: "open",
        priority: "0",
        deadline: "2026-04-04T09:00:00.000Z",
      });
      createContextItem(context, {
        title: "Blocked issue",
        type: "Issue",
        status: "blocked",
        priority: "0",
      });
      createContextItem(context, {
        title: "Closed task with deadline",
        type: "Task",
        status: "closed",
        priority: "0",
        deadline: "2026-04-04T13:00:00.000Z",
      });

      const result = await runContext(
        {
          from: "2026-04-04T00:00:00.000Z",
          to: "2026-04-06T00:00:00.000Z",
          limit: "5",
        },
        { path: context.pmPath },
      );

      expect(result.summary.active_items).toBe(4);
      expect(result.summary.in_progress).toBe(1);
      expect(result.summary.open).toBe(3);
      expect(result.summary.blocked).toBe(1);
      expect(result.summary.blocked_fallback_used).toBe(false);

      expect(result.high_level.map((item) => item.id)).toEqual([featureInProgress, epicOpen]);
      expect(result.low_level.map((item) => item.id)).toEqual([taskOpen, issueOpenNoOrder]);
      expect(result.blocked_fallback).toEqual([]);

      expect(result.agenda.summary.events).toBe(4);
      expect(result.agenda.summary.deadlines).toBe(2);
      expect(result.agenda.summary.reminders).toBe(1);
      expect(result.agenda.summary.scheduled).toBe(1);
      expect(result.agenda.events.every((event) => event.item_status !== "closed" && event.item_status !== "canceled")).toBe(true);

      const markdown = renderContextMarkdown(result);
      expect(markdown).toContain("# pm context");
      expect(markdown).toContain("## High-level focus");
      expect(markdown).toContain(featureInProgress);
      expect(markdown).toContain(taskOpen);
      expect(markdown).toContain("[event]");
      expect(markdown).toContain("[reminder]");
      expect(markdown).toContain("[deadline]");
    });
  });

  it("uses blocked fallback when active work is empty", async () => {
    await withTempPmPath(async (context) => {
      const blockedTask = createContextItem(context, {
        title: "Blocked fallback task",
        status: "blocked",
        type: "Task",
        priority: "1",
        deadline: "2026-05-01T10:00:00.000Z",
      });
      createContextItem(context, {
        title: "Draft task",
        status: "draft",
        type: "Task",
        priority: "2",
        deadline: "2026-05-03T10:00:00.000Z",
      });

      const result = await runContext(
        {
          from: "2026-05-01T00:00:00.000Z",
          to: "2026-05-02T00:00:00.000Z",
        },
        { path: context.pmPath },
      );

      expect(result.summary.active_items).toBe(0);
      expect(result.summary.blocked).toBe(1);
      expect(result.summary.blocked_fallback_used).toBe(true);
      expect(result.high_level).toEqual([]);
      expect(result.low_level).toEqual([]);
      expect(result.blocked_fallback.map((item) => item.id)).toEqual([blockedTask]);
      expect(result.agenda.summary.events).toBe(1);

      const markdown = renderContextMarkdown(result);
      expect(markdown).toContain("No high-level active items.");
      expect(markdown).toContain("No low-level active items.");
      expect(markdown).toContain("## Blocked fallback");
    });
  });

  it("applies filters and validates limits", async () => {
    await withTempPmPath(async (context) => {
      const keptId = createContextItem(context, {
        title: "Filtered keep",
        type: "Task",
        status: "open",
        priority: "1",
        assignee: "agent-a",
        tags: "context,keep",
        deadline: "2026-06-01T10:00:00.000Z",
      });
      createContextItem(context, {
        title: "Filtered drop",
        type: "Task",
        status: "open",
        priority: "2",
        assignee: "agent-b",
        tags: "context,drop",
        deadline: "2026-06-01T11:00:00.000Z",
      });

      const options: ContextOptions = {
        type: "Task",
        tag: "keep",
        priority: "1",
        assignee: "agent-a",
        from: "2026-06-01T00:00:00.000Z",
        to: "2026-06-02T00:00:00.000Z",
        limit: "1",
      };
      const result = await runContext(options, { path: context.pmPath });
      expect(result.low_level).toHaveLength(1);
      expect(result.low_level[0]?.id).toBe(keptId);
      expect(result.filters.limit).toBe("1");

      await expect(runContext({ limit: "-1" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runContext({ limit: "1.5" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("renders markdown guidance when agenda has no events", async () => {
    await withTempPmPath(async (context) => {
      createContextItem(context, {
        title: "No agenda seed",
        type: "Feature",
        status: "open",
        priority: "1",
      });

      const result = await runContext(
        {
          from: "2026-07-01T00:00:00.000Z",
          to: "2026-07-02T00:00:00.000Z",
        },
        { path: context.pmPath },
      );
      expect(result.agenda.summary.events).toBe(0);
      const markdown = renderContextMarkdown(result);
      expect(markdown).toContain("No agenda events matched the selected filters.");
    });
  });
});
