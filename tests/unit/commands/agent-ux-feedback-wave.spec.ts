import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { runComments } from "../../../src/cli/commands/comments.js";
import { _testOnly as contextTestOnly } from "../../../src/cli/commands/context.js";
import type { CalendarRow } from "../../../src/cli/commands/calendar.js";
import { formatPmCliErrorForJson } from "../../../src/cli/error-guidance.js";
import { discoverNearbyPmRoot } from "../../../src/sdk/tracker-root-discovery.js";
import {
  withTempPmPath,
  type TempPmContext,
} from "../../helpers/withTempPmPath.js";

function createTask(
  context: TempPmContext,
  title: string,
  extraArgs: string[] = [],
): string {
  const created = context.runCli(
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
      ...extraArgs,
    ],
    { expectJson: true },
  );
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

describe("agent UX feedback wave", () => {
  it("rejects --message without comment text and ranks from --assignee perspective", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createTask(context, "Assignee perspective", [
        "--status",
        "in_progress",
        "--assignee",
        "bob",
      ]);
      const comment = context.runCli([
        "comment",
        itemId,
        "--message",
        "lost text",
        "--json",
      ]);
      expect(comment.code).toBe(EXIT_CODE.USAGE);
      expect(comment.stderr).toContain("does not provide comment text");
      await expect(
        runComments(itemId, { message: "lost text" }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
        context: { code: "annotation_message_without_text" },
      });

      for (const twin of ["notes", "learnings"] as const) {
        const twinResult = context.runCli([
          twin,
          itemId,
          "--message",
          "lost text",
          "--json",
        ]);
        expect(twinResult.code).toBe(EXIT_CODE.USAGE);
        expect(twinResult.stderr).toContain(
          `does not provide ${twin.replace(/s$/, "")} text`,
        );
        const listAfter = context.runCli([twin, itemId, "--json"], {
          expectJson: true,
        });
        expect((listAfter.json as { count: number }).count).toBe(0);
      }

      const next = context.runCli(
        ["next", "--assignee", "bob", "--json"],
        { expectJson: true },
      );
      expect(next.code).toBe(0);
      expect((next.json as { recommended: { id: string } }).recommended.id).toBe(itemId);
    });
  });

  it("renders full and reference-only agenda row variants", () => {
    const common = {
      at: "2026-01-01T09:00:00.000Z",
      date: "2026-01-01",
      item_id: "pm-agenda",
    };
    expect(
      contextTestOnly.formatAgendaLine({
        ...common,
        kind: "reminder",
        item_priority: 1,
        item_status: "open",
        item_title: "Reminder item",
        reminder_text: "Follow up",
      } as CalendarRow),
    ).toContain("Follow up");
    expect(
      contextTestOnly.formatAgendaLine({
        ...common,
        kind: "event",
        item_priority: 1,
        item_status: "open",
        item_title: "Event item",
        event_title: "Review",
        event_recurring: true,
      } as CalendarRow),
    ).toContain("Review (recurring)");
    expect(
      contextTestOnly.formatAgendaLine({
        ...common,
        kind: "deadline",
        item_priority: 1,
        item_status: "open",
        item_title: "Deadline item",
      } as CalendarRow),
    ).toContain("Deadline item");
    expect(
      contextTestOnly.formatAgendaLine({
        ...common,
        kind: "reminder",
        reference_only: true,
        reminder_text: "Referenced reminder",
      }),
    ).toContain("Referenced reminder");
    expect(
      contextTestOnly.formatAgendaLine({
        ...common,
        kind: "reminder",
        reference_only: true,
      }),
    ).toContain("reminder");
    expect(
      contextTestOnly.formatAgendaLine({
        ...common,
        kind: "event",
        reference_only: true,
        event_title: "Referenced event",
        event_recurring: true,
      }),
    ).toContain("Referenced event (recurring)");
    expect(
      contextTestOnly.formatAgendaLine({
        ...common,
        kind: "event",
        reference_only: true,
        event_recurring: false,
      }),
    ).toContain("event");
    expect(
      contextTestOnly.formatAgendaLine({
        ...common,
        kind: "deadline",
        reference_only: true,
      }),
    ).toContain("see focus item");
  });

  it("warns on a newly created ordering cycle and reports explicit audit units", async () => {
    await withTempPmPath(async (context) => {
      const first = createTask(context, "Cycle first");
      const second = createTask(context, "Cycle second", [
        "--dep",
        `id=${first},kind=blocked_by`,
      ]);
      const update = context.runCli(
        [
          "update",
          first,
          "--dep",
          `id=${second},kind=blocked_by`,
          "--json",
        ],
        { expectJson: true },
      );
      expect(update.code).toBe(0);
      expect((update.json as { warnings: string[] }).warnings).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^ordering_cycle_created:.*run_pm_graph_audit$/),
        ]),
      );

      const audit = context.runCli(["graph", "audit", "--json"], {
        expectJson: true,
      });
      const result = audit.json as {
        finding_count: number;
        findings_by_code: Record<string, number>;
        affected_subjects_by_code: Record<string, number>;
      };
      expect(result.findings_by_code.ordering_cycle).toBe(1);
      expect(result.affected_subjects_by_code.ordering_cycle).toBe(2);
      expect(result.finding_count).toBeGreaterThanOrEqual(1);
    });
  });

  it("uses agenda references for listed focus items", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createTask(context, "Agenda reference", [
        "--deadline",
        "2099-01-01T09:00:00.000Z",
      ]);
      const contextResult = context.runCli(
        ["context", "--limit", "20", "--json"],
        { expectJson: true },
      );
      const event = (
        contextResult.json as {
          agenda: { events: Array<Record<string, unknown>> };
        }
      ).agenda.events.find((entry) => entry.item_id === itemId);
      expect(event).toMatchObject({ item_id: itemId, reference_only: true });
      expect(event).not.toHaveProperty("item_title");
      expect(contextResult.stdout.length).toBeLessThan(12_000);
    });
  });

  it("points unconfigured invocations at a nearby custom tracker", async () => {
    await withTempPmPath(async (context) => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), "pm-nearby-root-"));
      try {
        const customRoot = path.join(workspace, ".pm");
        const secondCustomRoot = path.join(workspace, ".pm-two");
        const ignoredDependencyRoot = path.join(workspace, "node_modules");
        const unrelatedDirectory = path.join(workspace, "scratch");
        await mkdir(customRoot, { recursive: true });
        await mkdir(unrelatedDirectory, { recursive: true });
        await cp(context.pmPath, customRoot, { recursive: true });
        await cp(context.pmPath, secondCustomRoot, { recursive: true });
        await cp(context.pmPath, ignoredDependencyRoot, { recursive: true });
        expect(discoverNearbyPmRoot(workspace)).toBe(customRoot);
        expect(discoverNearbyPmRoot(workspace, customRoot)).toBe(secondCustomRoot);
        expect(discoverNearbyPmRoot(path.join(workspace, "missing"))).toBeUndefined();
        const previousCwd = process.cwd();
        process.chdir(workspace);
        try {
          expect(
            formatPmCliErrorForJson(
              `Tracker is not initialized at ${path.join(workspace, ".agents", "pm")}. Run pm init first.`,
              EXIT_CODE.NOT_FOUND,
            ),
          ).toMatchObject({
            code: "tracker_not_initialized",
            title: "Tracker exists at a custom path",
          });
        } finally {
          process.chdir(previousCwd);
        }
        const env = { ...context.env };
        delete env.PM_PATH;
        const invocation = spawnSync(
          process.execPath,
          [path.resolve("dist/cli.js"), "list", "--json"],
          {
            cwd: workspace,
            env,
            encoding: "utf8",
          },
        );
        expect(invocation.status).toBe(EXIT_CODE.NOT_FOUND);
        expect(invocation.stderr).toContain("Tracker exists at a custom path");
        expect(invocation.stderr).toContain("--pm-path");
        expect(invocation.stderr).toContain("PM_PATH=");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  });
});
