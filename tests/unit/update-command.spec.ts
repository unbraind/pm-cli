import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runUpdate } from "../../src/cli/commands/update.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

afterEach(() => {
  vi.restoreAllMocks();
});

interface CreateTaskOptions {
  type?: string;
  assignee?: string;
  deadline?: string;
  estimate?: string;
  acceptanceCriteria?: string;
}

function createTask(context: TempPmContext, title: string, options: CreateTaskOptions = {}): string {
  const args = [
    "create",
    "--json",
    "--title",
    title,
    "--description",
    `${title} description`,
    "--type",
    options.type ?? "Task",
    "--create-mode",
    "progressive",
    "--status",
    "open",
    "--priority",
    "1",
    "--tags",
    "update,unit",
    "--body",
    "",
    "--deadline",
    options.deadline ?? "2026-03-01T00:00:00.000Z",
    "--estimate",
    options.estimate ?? "30",
    "--acceptance-criteria",
    options.acceptanceCriteria ?? `${title} acceptance`,
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

function latestUpdateAuthor(context: TempPmContext, id: string): string | undefined {
  const history = context.runCli(["history", id, "--json", "--full"], { expectJson: true });
  expect(history.code).toBe(0);
  const entries = (history.json as { history: Array<{ op: string; author: string }> }).history;
  return [...entries].reverse().find((entry) => entry.op === "update")?.author;
}

function latestUpdateOperation(context: TempPmContext, id: string): string | undefined {
  const history = context.runCli(["history", id, "--json", "--full"], { expectJson: true });
  expect(history.code).toBe(0);
  const entries = (history.json as { history: Array<{ op: string }> }).history;
  return [...entries].reverse().find((entry) => entry.op.startsWith("update"))?.op;
}

function setGovernancePreset(context: TempPmContext, preset: "minimal" | "default" | "strict" | "custom"): void {
  const result = context.runCli(["config", "project", "set", "governance-preset", "--policy", preset, "--json"], {
    expectJson: true,
  });
  expect(result.code).toBe(0);
}

describe("runUpdate", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-update-not-init-"));
    try {
      await expect(runUpdate("pm-missing", { description: "new description" }, { path: tempDir })).rejects.toMatchObject<
        PmCliError
      >({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a noop success when no field-changing flag is provided (pm-7cup)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-no-flags");
      const result = await runUpdate(id, {}, { path: context.pmPath });
      expect(result.changed_fields).toEqual([]);
      expect(result.warnings).toContain("noop_no_update_fields");
      const item = result.item as { id: string };
      expect(item.id).toBe(id);
    });
  });

  it("returns NOT_FOUND for unknown id with did-you-mean suggestion (pm-99x5)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "did-you-mean-seed");
      // Mutate one character of the known id so Levenshtein distance == 1.
      const mistyped = `${id.slice(0, -1)}${id.endsWith("a") ? "b" : "a"}`;
      await expect(runUpdate(mistyped, {}, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
        context: {
          nextSteps: expect.arrayContaining([expect.stringContaining(id)]),
        },
      });
    });
  });

  it("auto-routes pm update --status closed --close-reason to pm close (pm-12ib)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "auto-route-close");
      const result = await runUpdate(
        id,
        { status: "closed", closeReason: "done via auto-route" },
        { path: context.pmPath },
      );
      expect(result.changed_fields).toEqual(expect.arrayContaining(["status", "close_reason"]));
      expect(result.warnings).toContain("auto_routed_from_update_to_close");
      const item = result.item as { status: string; close_reason: string };
      expect(item.status).toBe("closed");
      expect(item.close_reason).toBe("done via auto-route");
    });
  });

  it("rejects pm update --status closed --close-reason combined with other field updates (pm-12ib)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "auto-route-close-with-others");
      await expect(
        runUpdate(
          id,
          { status: "closed", closeReason: "done", title: "new title" },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("enforces update command_option_policies required and disabled options", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        item_types?: { definitions?: Array<Record<string, unknown>> };
      };
      settings.item_types = {
        definitions: [
          {
            name: "Asset",
            folder: "assets",
            required_create_fields: [],
            required_create_repeatables: [],
            command_option_policies: [
              { command: "update", option: "message", required: true },
              { command: "update", option: "goal", enabled: false },
            ],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const id = createTask(context, "update-policy-seed");

      await expect(
        runUpdate(
          id,
          {
            type: "Asset",
            status: "in_progress",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--message"),
      });

      await expect(
        runUpdate(
          id,
          {
            type: "Asset",
            goal: "forbidden-goal",
            message: "attempt disabled goal option",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--goal"),
      });

      const updated = await runUpdate(
        id,
        {
          type: "Asset",
          status: "in_progress",
          message: "apply update policy compliant change",
        },
        { path: context.pmPath },
      );
      expect((updated.item as Record<string, unknown>).type).toBe("Asset");
      expect((updated.item as Record<string, unknown>).status).toBe("in_progress");
    });
  });

  it("rejects unsupported update command_option_policies option keys", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        item_types?: { definitions?: Array<Record<string, unknown>> };
      };
      settings.item_types = {
        definitions: [
          {
            name: "Task",
            command_option_policies: [{ command: "update", option: "not_real_option", enabled: false }],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const id = createTask(context, "update-policy-invalid-option");
      await expect(
        runUpdate(
          id,
          {
            status: "in_progress",
            message: "trigger policy validation",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
        message: expect.stringContaining("command_option_policies"),
      });
    });
  });

  it("updates scalar fields with valid values", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-explicit-values");
      const parentId = createTask(context, "update-parent-existing");
      const result = await runUpdate(
        id,
        {
          title: "updated title",
          description: "updated description",
          body: "updated body content",
          status: "blocked",
          priority: "4",
          type: "Issue",
          tags: "zeta,alpha,alpha",
          deadline: "+1d",
          estimatedMinutes: "45",
          acceptanceCriteria: "new acceptance",
          definitionOfReady: " ready with fixtures ",
          order: "8",
          assignee: " next-assignee ",
          goal: " goal-next ",
          objective: " objective-next ",
          value: " value-next ",
          impact: " impact-next ",
          outcome: " outcome-next ",
          whyNow: " why-now-next ",
          parent: ` ${parentId} `,
          reviewer: " reviewer-next ",
          risk: "med",
          confidence: "88",
          sprint: " sprint-next ",
          release: " release-next ",
          blockedBy: " pm-blocking-next ",
          blockedReason: " blocked waiting reason ",
          unblockNote: " unblocked after dependency update ",
          reporter: " reporter-next ",
          severity: "med",
          environment: " linux:node25 ",
          reproSteps: " run command and inspect output ",
          resolution: " update metadata parser ",
          expectedResult: " issue metadata should persist ",
          actualResult: " issue metadata was missing ",
          affectedVersion: " 0.1.0 ",
          fixedVersion: " 0.1.1 ",
          component: " cli/update ",
          regression: "true",
          customerImpact: " triage reports missing details ",
          reminder: [
            "at=2026-03-03T12:00:00.000Z,text= reminder beta ",
            "at=2026-03-03T12:00:00.000Z,text=reminder alpha",
          ],
          event: [
            "start=2026-03-04T08:00:00.000Z,title=Daily defaults,recur_freq=daily",
            "start=2026-03-05T10:00:00.000Z,end=2026-03-05T11:00:00.000Z,title=Planning review,all_day=yes",
            "start=2026-03-06T09:00:00.000Z,title=Recurring standup,all_day=false,recur_freq=weekly,recur_by_weekday=fri|mon|fri,recur_by_month_day=10|2,recur_exdates=2026-03-13T09:00:00.000Z|2026-03-06T09:00:00.000Z",
          ],
          author: " explicit-author ",
          message: "apply explicit update",
        },
        { path: context.pmPath },
      );

      expect(result.warnings).toEqual([]);
      expect(result.changed_fields).toEqual(
        expect.arrayContaining([
          "title",
          "description",
          "body",
          "status",
          "priority",
          "type",
          "tags",
          "deadline",
          "estimated_minutes",
          "acceptance_criteria",
          "definition_of_ready",
          "order",
          "goal",
          "objective",
          "value",
          "impact",
          "outcome",
          "why_now",
          "assignee",
          "parent",
          "reviewer",
          "risk",
          "confidence",
          "sprint",
          "release",
          "blocked_by",
          "blocked_reason",
          "unblock_note",
          "reporter",
          "severity",
          "environment",
          "repro_steps",
          "resolution",
          "expected_result",
          "actual_result",
          "affected_version",
          "fixed_version",
          "component",
          "regression",
          "customer_impact",
          "reminders",
          "events",
        ]),
      );

      const item = result.item as Record<string, unknown>;
      expect(item.title).toBe("updated title");
      expect(item.description).toBe("updated description");
      expect(item.status).toBe("blocked");
      expect(item.priority).toBe(4);
      expect(item.type).toBe("Issue");
      expect(item.tags).toEqual(["alpha", "zeta"]);
      expect(typeof item.deadline).toBe("string");
      expect(Number.isNaN(Date.parse(String(item.deadline)))).toBe(false);
      expect(item.estimated_minutes).toBe(45);
      expect(item.acceptance_criteria).toBe("new acceptance");
      expect(item.definition_of_ready).toBe("ready with fixtures");
      expect(item.order).toBe(8);
      expect(item.assignee).toBe("next-assignee");
      expect(item.goal).toBe("goal-next");
      expect(item.objective).toBe("objective-next");
      expect(item.value).toBe("value-next");
      expect(item.impact).toBe("impact-next");
      expect(item.outcome).toBe("outcome-next");
      expect(item.why_now).toBe("why-now-next");
      expect(item.parent).toBe(parentId);
      expect(item.reviewer).toBe("reviewer-next");
      expect(item.risk).toBe("medium");
      expect(item.confidence).toBe(88);
      expect(item.sprint).toBe("sprint-next");
      expect(item.release).toBe("release-next");
      expect(item.blocked_by).toBe("pm-blocking-next");
      expect(item.blocked_reason).toBe("blocked waiting reason");
      expect(item.unblock_note).toBe("unblocked after dependency update");
      expect(item.reporter).toBe("reporter-next");
      expect(item.severity).toBe("medium");
      expect(item.environment).toBe("linux:node25");
      expect(item.repro_steps).toBe("run command and inspect output");
      expect(item.resolution).toBe("update metadata parser");
      expect(item.expected_result).toBe("issue metadata should persist");
      expect(item.actual_result).toBe("issue metadata was missing");
      expect(item.affected_version).toBe("0.1.0");
      expect(item.fixed_version).toBe("0.1.1");
      expect(item.component).toBe("cli/update");
      expect(item.regression).toBe(true);
      expect(item.customer_impact).toBe("triage reports missing details");
      const loaded = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(loaded.code).toBe(0);
      expect((loaded.json as { body: string }).body).toBe("updated body content");
      expect(item.reminders).toEqual([
        { at: "2026-03-03T12:00:00.000Z", text: "reminder alpha" },
        { at: "2026-03-03T12:00:00.000Z", text: "reminder beta" },
      ]);
      expect(item.events).toEqual([
        {
          start_at: "2026-03-04T08:00:00.000Z",
          title: "Daily defaults",
          recurrence: {
            freq: "daily",
          },
        },
        {
          start_at: "2026-03-05T10:00:00.000Z",
          end_at: "2026-03-05T11:00:00.000Z",
          title: "Planning review",
          all_day: true,
        },
        {
          start_at: "2026-03-06T09:00:00.000Z",
          title: "Recurring standup",
          all_day: false,
          recurrence: {
            freq: "weekly",
            by_weekday: ["mon", "fri"],
            by_month_day: [2, 10],
            exdates: ["2026-03-06T09:00:00.000Z", "2026-03-13T09:00:00.000Z"],
          },
        },
      ]);
      expect(latestUpdateAuthor(context, id)).toBe("explicit-author");

      const mediumConfidence = await runUpdate(
        id,
        {
          confidence: "med",
          author: "next-assignee",
          message: "normalize confidence med alias",
        },
        { path: context.pmPath },
      );
      expect((mediumConfidence.item as Record<string, unknown>).confidence).toBe("medium");

      const highConfidence = await runUpdate(
        id,
        {
          confidence: "high",
          author: "next-assignee",
          message: "set confidence text level",
        },
        { path: context.pmPath },
      );
      expect((highConfidence.item as Record<string, unknown>).confidence).toBe("high");

      const falseRegression = await runUpdate(
        id,
        {
          regression: "0",
          author: "next-assignee",
          message: "set regression false alias",
        },
        { path: context.pmPath },
      );
      expect((falseRegression.item as Record<string, unknown>).regression).toBe(false);
    });
  });

  it("supports explicit unset/clear semantics and clears assignee for canceled status", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-unset-fields", { assignee: "active-owner" });
      const result = await runUpdate(
        id,
        {
          description: "closed description",
          status: "canceled",
          unset: [
            "deadline",
            "estimate",
            "acceptance-criteria",
            "definition-of-ready",
            "order",
            "goal",
            "objective",
            "value",
            "impact",
            "outcome",
            "why-now",
            "assignee",
            "parent",
            "reviewer",
            "risk",
            "confidence",
            "sprint",
            "release",
            "blocked-by",
            "blocked-reason",
            "unblock-note",
            "reporter",
            "severity",
            "environment",
            "repro-steps",
            "resolution",
            "expected-result",
            "actual-result",
            "affected-version",
            "fixed-version",
            "component",
            "regression",
            "customer-impact",
          ],
          clearReminders: true,
          clearEvents: true,
          author: "active-owner",
          message: "cancel and clear optional fields",
        },
        { path: context.pmPath },
      );

      expect(result.changed_fields).toEqual(
        expect.arrayContaining([
          "description",
          "status",
          "deadline",
          "estimated_minutes",
          "acceptance_criteria",
          "definition_of_ready",
          "order",
          "goal",
          "objective",
          "value",
          "impact",
          "outcome",
          "why_now",
          "assignee",
          "parent",
          "reviewer",
          "risk",
          "confidence",
          "sprint",
          "release",
          "blocked_by",
          "blocked_reason",
          "unblock_note",
          "reporter",
          "severity",
          "environment",
          "repro_steps",
          "resolution",
          "expected_result",
          "actual_result",
          "affected_version",
          "fixed_version",
          "component",
          "regression",
          "customer_impact",
          "reminders",
          "events",
        ]),
      );

      const item = result.item as Record<string, unknown>;
      expect(item.status).toBe("canceled");
      expect(item.deadline).toBeUndefined();
      expect(item.estimated_minutes).toBeUndefined();
      expect(item.acceptance_criteria).toBeUndefined();
      expect(item.definition_of_ready).toBeUndefined();
      expect(item.order).toBeUndefined();
      expect(item.goal).toBeUndefined();
      expect(item.objective).toBeUndefined();
      expect(item.value).toBeUndefined();
      expect(item.impact).toBeUndefined();
      expect(item.outcome).toBeUndefined();
      expect(item.why_now).toBeUndefined();
      expect(item.assignee).toBeUndefined();
      expect(item.parent).toBeUndefined();
      expect(item.reviewer).toBeUndefined();
      expect(item.risk).toBeUndefined();
      expect(item.confidence).toBeUndefined();
      expect(item.sprint).toBeUndefined();
      expect(item.release).toBeUndefined();
      expect(item.blocked_by).toBeUndefined();
      expect(item.blocked_reason).toBeUndefined();
      expect(item.unblock_note).toBeUndefined();
      expect(item.reporter).toBeUndefined();
      expect(item.severity).toBeUndefined();
      expect(item.environment).toBeUndefined();
      expect(item.repro_steps).toBeUndefined();
      expect(item.resolution).toBeUndefined();
      expect(item.expected_result).toBeUndefined();
      expect(item.actual_result).toBeUndefined();
      expect(item.affected_version).toBeUndefined();
      expect(item.fixed_version).toBeUndefined();
      expect(item.component).toBeUndefined();
      expect(item.regression).toBeUndefined();
      expect(item.customer_impact).toBeUndefined();
      expect(item.reminders).toBeUndefined();
      expect(item.events).toBeUndefined();
    });
  });

  it("rejects blank assignee values and requires --unset assignee", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-blank-assignee");
      await expect(
        runUpdate(
          id,
          {
            description: "clear assignee with whitespace",
            assignee: "   ",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      const cleared = await runUpdate(
        id,
        {
          description: "clear assignee with explicit unset",
          unset: ["assignee"],
        },
        { path: context.pmPath },
      );
      const item = cleared.item as Record<string, unknown>;
      expect(item.assignee).toBeUndefined();
    });
  });

  it("accepts in-progress status alias and stores canonical status", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-status-alias");
      const result = await runUpdate(
        id,
        {
          status: "in-progress",
          message: "set status using alias",
        },
        { path: context.pmPath },
      );

      const item = result.item as Record<string, unknown>;
      expect(item.status).toBe("in_progress");
    });
  });

  it("auto-clears close_reason when reopening from closed to non-terminal status", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-reopen-clears-close-reason");
      const closed = context.runCli(
        ["close", id, "Completed work", "--json", "--author", "test-author", "--message", "close for reopen test"],
        { expectJson: true },
      );
      expect(closed.code).toBe(0);
      expect((closed.json as { item: { close_reason?: string } }).item.close_reason).toBe("Completed work");

      const reopened = await runUpdate(
        id,
        {
          status: "open",
          author: "test-author",
          message: "reopen item",
        },
        { path: context.pmPath },
      );

      const item = reopened.item as Record<string, unknown>;
      expect(item.status).toBe("open");
      expect(item.close_reason).toBeUndefined();
      expect(reopened.changed_fields).toEqual(expect.arrayContaining(["status", "close_reason"]));
    });
  });

  it("supports explicit close_reason set and clear via unset flag", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-explicit-close-reason");

      const setReason = await runUpdate(
        id,
        {
          closeReason: "Paused pending dependency triage",
          author: "test-author",
          message: "set close reason explicitly",
        },
        { path: context.pmPath },
      );
      expect((setReason.item as Record<string, unknown>).close_reason).toBe("Paused pending dependency triage");
      expect(setReason.changed_fields).toContain("close_reason");

      const clearedReason = await runUpdate(
        id,
        {
          unset: ["close-reason"],
          author: "test-author",
          message: "clear close reason explicitly",
        },
        { path: context.pmPath },
      );
      expect((clearedReason.item as Record<string, unknown>).close_reason).toBeUndefined();
      expect(clearedReason.changed_fields).toContain("close_reason");
    });
  });

  it("accepts month-relative and normalized date-string deadline updates", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-deadline-format-expansion");

      const monthRelative = await runUpdate(
        id,
        {
          deadline: "+6m",
          author: "update-deadline-owner",
          message: "set month-relative deadline",
        },
        { path: context.pmPath },
      );
      expect(Number.isNaN(Date.parse(String((monthRelative.item as Record<string, unknown>).deadline)))).toBe(false);

      const normalizedDateString = await runUpdate(
        id,
        {
          deadline: "2026-03-31T13-59Z",
          author: "update-deadline-owner",
          message: "set normalized date-string deadline",
        },
        { path: context.pmPath },
      );
      expect((normalizedDateString.item as Record<string, unknown>).deadline).toBe("2026-03-31T13:59:00.000Z");
    });
  });

  it("validates enum and numeric inputs", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-invalid-values");

      await expect(runUpdate(id, { status: "not-a-status" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { status: "closed" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: 'Invalid --status value "closed". Use "pm close <ID> <TEXT>" to close an item.',
      });
      await expect(runUpdate(id, { type: "NotAType" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { priority: "9" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { priority: "nope" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { risk: "extreme" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { confidence: "-1" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { confidence: "uncertain" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { severity: "urgent" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { closeReason: "   " }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { regression: "sometimes" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { order: "3.7" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { order: "1", rank: "2" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("warns for non-conforming sprint and release values under default policy", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-sprint-release-warn");

      const result = await runUpdate(
        id,
        {
          sprint: "Sprint 2026 W14",
          release: "Release Candidate 1",
          message: "set non-conforming sprint/release metadata",
        },
        { path: context.pmPath },
      );

      expect((result.item as Record<string, unknown>).sprint).toBe("Sprint 2026 W14");
      expect((result.item as Record<string, unknown>).release).toBe("Release Candidate 1");
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          "validation_warning:sprint_format:Sprint 2026 W14",
          "validation_warning:release_format:Release Candidate 1",
        ]),
      );
    });
  });

  it("rejects non-conforming sprint and release values under strict policy", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-sprint-release-strict");
      const settingsPath = path.join(context.pmPath, "settings.json");
      const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as {
        validation?: { sprint_release_format?: string };
      };
      parsed.validation = {
        ...(parsed.validation ?? {}),
        sprint_release_format: "strict_error",
      };
      await writeFile(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

      await expect(
        runUpdate(
          id,
          {
            release: "Release Candidate 1",
            message: "attempt invalid release in strict mode",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("warns for missing parent references under default policy", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-parent-warn");
      const result = await runUpdate(
        id,
        {
          parent: "pm-parent-missing-default",
          message: "set missing parent reference under warn policy",
        },
        { path: context.pmPath },
      );

      expect((result.item as Record<string, unknown>).parent).toBe("pm-parent-missing-default");
      expect(result.warnings).toEqual(
        expect.arrayContaining(["validation_warning:parent_reference_missing:pm-parent-missing-default"]),
      );
    });
  });

  it("rejects missing parent references under strict policy", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-parent-strict");
      setGovernancePreset(context, "strict");

      await expect(
        runUpdate(
          id,
          {
            parent: "pm-parent-missing-strict",
            message: "attempt missing parent in strict mode",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("rejects undefined parent placeholder tokens", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-parent-undefined");
      await expect(
        runUpdate(
          id,
          {
            parent: "undefined",
            message: "attempt undefined parent placeholder",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("adds and removes dependencies for existing items", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-dependency-mutations");
      const added = await runUpdate(
        id,
        {
          dep: [
            "id=dep-alpha,kind=blocks,author=dep-owner,created_at=2026-03-01T00:00:00.000Z",
            "id=dep-alpha,kind=blocks,author=duplicate-owner,created_at=2026-03-03T00:00:00.000Z",
            "id=dep-beta,kind=related,author=dep-owner,source_kind=imported,created_at=2026-03-02T00:00:00.000Z",
            "dep-gamma",
          ],
          message: "add dependencies through update command",
        },
        { path: context.pmPath },
      );

      expect(added.changed_fields).toContain("dependencies");
      expect((added.item as { dependencies?: Array<Record<string, unknown>> }).dependencies).toEqual([
        {
          id: "pm-dep-alpha",
          kind: "blocks",
          created_at: "2026-03-01T00:00:00.000Z",
          author: "dep-owner",
        },
        {
          id: "pm-dep-beta",
          kind: "related",
          created_at: "2026-03-02T00:00:00.000Z",
          author: "dep-owner",
          source_kind: "imported",
        },
        expect.objectContaining({
          id: "pm-dep-gamma",
          kind: "related",
        }),
      ]);

      const removedById = await runUpdate(
        id,
        {
          depRemove: ["dep-alpha"],
          message: "remove dependency by id",
        },
        { path: context.pmPath },
      );
      expect((removedById.item as { dependencies?: Array<Record<string, unknown>> }).dependencies).toEqual([
        {
          id: "pm-dep-beta",
          kind: "related",
          created_at: "2026-03-02T00:00:00.000Z",
          author: "dep-owner",
          source_kind: "imported",
        },
        expect.objectContaining({
          id: "pm-dep-gamma",
          kind: "related",
        }),
      ]);

      const removedBySelector = await runUpdate(
        id,
        {
          depRemove: ["id=dep-beta,kind=related,source_kind=imported", "dep-gamma"],
          message: "remove dependency by selector",
        },
        { path: context.pmPath },
      );
      expect((removedBySelector.item as { dependencies?: Array<Record<string, unknown>> }).dependencies).toBeUndefined();
    });
  });

  it("supports clearing dependencies with --clear-deps", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-clear-dependencies");
      await runUpdate(
        id,
        {
          dep: ["id=dep-clear,kind=blocks,created_at=2026-03-01T00:00:00.000Z"],
          message: "seed one dependency before clear",
        },
        { path: context.pmPath },
      );

      const cleared = await runUpdate(
        id,
        {
          clearDeps: true,
          message: "clear dependency list",
        },
        { path: context.pmPath },
      );
      expect(cleared.changed_fields).toContain("dependencies");
      expect((cleared.item as { dependencies?: Array<Record<string, unknown>> }).dependencies).toBeUndefined();
    });
  });

  it("reinterprets legacy none/null tokens as deterministic unset and clear actions", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-legacy-none-compat");

      await runUpdate(
        id,
        {
          tags: "alpha,beta",
          deadline: "2026-03-15T00:00:00.000Z",
          dep: ["id=dep-seed,kind=blocks,created_at=2026-03-01T00:00:00.000Z"],
          comment: ["text=seed comment payload"],
          file: ["path=README.md,scope=project"],
          test: ["command=node scripts/run-tests.mjs test -- tests/unit/update-command.spec.ts,scope=project"],
          doc: ["path=README.md,scope=project"],
          reminder: ["at=2026-03-20T09:00:00.000Z,text=seed reminder"],
          event: ["start=2026-03-21T09:00:00.000Z,title=seed event"],
          message: "seed mutable fields",
        },
        { path: context.pmPath },
      );

      const cleared = await runUpdate(
        id,
        {
          tags: "none",
          deadline: "null",
          dep: ["none"],
          comment: ["null"],
          file: ["none"],
          test: ["null"],
          doc: ["none"],
          reminder: ["none"],
          event: ["null"],
          message: "legacy none clear compatibility",
        },
        { path: context.pmPath },
      );

      const item = cleared.item as Record<string, unknown>;
      expect(item.tags === undefined || (Array.isArray(item.tags) && item.tags.length === 0)).toBe(true);
      expect(item.deadline).toBeUndefined();
      expect(item.dependencies).toBeUndefined();
      expect(item.comments).toBeUndefined();
      expect(item.files).toBeUndefined();
      expect(item.tests).toBeUndefined();
      expect(item.docs).toBeUndefined();
      expect(item.reminders).toBeUndefined();
      expect(item.events).toBeUndefined();
    });
  });

  it("supports atomic dependency replacement with --replace-deps", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-replace-dependencies");
      await runUpdate(
        id,
        {
          dep: [
            "id=dep-alpha,kind=blocks,created_at=2026-03-01T00:00:00.000Z",
            "id=dep-beta,kind=related,created_at=2026-03-02T00:00:00.000Z",
          ],
          message: "seed dependencies before replacement",
        },
        { path: context.pmPath },
      );

      const replaced = await runUpdate(
        id,
        {
          replaceDeps: true,
          dep: ["id=dep-gamma,kind=related,created_at=2026-03-03T00:00:00.000Z"],
          message: "replace dependencies atomically",
        },
        { path: context.pmPath },
      );

      expect(replaced.changed_fields).toContain("dependencies");
      expect((replaced.item as { dependencies?: Array<Record<string, unknown>> }).dependencies).toEqual([
        {
          id: "pm-dep-gamma",
          kind: "related",
          created_at: "2026-03-03T00:00:00.000Z",
        },
      ]);
    });
  });

  it("supports atomic linked test replacement with --replace-tests", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-replace-tests");
      await runUpdate(
        id,
        {
          test: [
            "command=node scripts/run-tests.mjs test -- tests/unit/update-command.spec.ts,scope=project",
            "command=node scripts/run-tests.mjs test -- tests/unit/create-command.spec.ts,scope=project",
          ],
          message: "seed tests before replacement",
        },
        { path: context.pmPath },
      );

      const replaced = await runUpdate(
        id,
        {
          replaceTests: true,
          test: [
            "command=node scripts/run-tests.mjs test -- tests/unit/validate-command.spec.ts,scope=project",
            "command=node scripts/run-tests.mjs test -- tests/unit/validate-command.spec.ts,scope=project",
          ],
          message: "replace tests atomically",
        },
        { path: context.pmPath },
      );

      expect(replaced.changed_fields).toContain("tests");
      expect((replaced.item as { tests?: Array<Record<string, unknown>> }).tests).toEqual([
        {
          command: "node scripts/run-tests.mjs test -- tests/unit/validate-command.spec.ts",
          scope: "project",
        },
      ]);
    });
  });

  it("validates --replace-tests requirements and preserves clear/value conflict behavior", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-replace-tests-validation");

      await expect(
        runUpdate(
          id,
          {
            replaceTests: true,
            message: "missing replacement values",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--replace-tests requires at least one --test entry"),
      });

      await expect(
        runUpdate(
          id,
          {
            replaceTests: true,
            clearTests: true,
            test: ["command=node scripts/run-tests.mjs test -- tests/unit/update-command.spec.ts,scope=project"],
            message: "conflicting replacement and clear flags",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--replace-tests cannot be combined with --clear-tests"),
      });

      await expect(
        runUpdate(
          id,
          {
            clearTests: true,
            test: ["command=node scripts/run-tests.mjs test -- tests/unit/update-command.spec.ts,scope=project"],
            message: "clear/value conflict still rejected",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Cannot combine --clear-tests with --test"),
      });
    });
  });

  it("supports transactional linked collection mutations in a single update", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-transactional-annotate");

      const result = await runUpdate(
        id,
        {
          description: "update description and append linked collections",
          comment: ["text=comment from update transaction"],
          note: ["text=note from update transaction"],
          learning: ["text=learning from update transaction"],
          file: ["path=src/cli/main.ts,note=update transaction file"],
          test: ["command=node scripts/run-tests.mjs test -- tests/unit/update-command.spec.ts"],
          doc: ["path=README.md,note=update transaction doc"],
          author: "transaction-owner",
          message: "update metadata and linked collections transactionally",
        },
        { path: context.pmPath },
      );

      expect(result.changed_fields).toEqual(
        expect.arrayContaining(["description", "comments", "notes", "learnings", "files", "tests", "docs"]),
      );
      const item = result.item as {
        description?: string;
        comments?: Array<{ text: string }>;
        notes?: Array<{ text: string }>;
        learnings?: Array<{ text: string }>;
        files?: Array<{ path: string; scope: string }>;
        tests?: Array<{ command: string; scope: string }>;
        docs?: Array<{ path: string; scope: string }>;
      };
      expect(item.description).toBe("update description and append linked collections");
      expect(item.comments?.at(-1)?.text).toBe("comment from update transaction");
      expect(item.notes?.at(-1)?.text).toBe("note from update transaction");
      expect(item.learnings?.at(-1)?.text).toBe("learning from update transaction");
      expect(item.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/cli/main.ts", scope: "project" })]));
      expect(item.tests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: "node scripts/run-tests.mjs test -- tests/unit/update-command.spec.ts",
            scope: "project",
          }),
        ]),
      );
      expect(item.docs).toEqual(expect.arrayContaining([expect.objectContaining({ path: "README.md", scope: "project" })]));

      const history = context.runCli(["history", id, "--json", "--full"], { expectJson: true });
      expect(history.code).toBe(0);
      const updateOps = (history.json as { history: Array<{ op: string; message?: string }> }).history.filter(
        (entry) => entry.op === "update",
      );
      expect(updateOps).toHaveLength(1);
      expect(updateOps[0]?.message).toBe("update metadata and linked collections transactionally");
    });
  });

  it("clears transactional linked collections with explicit clear flags", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-transactional-clear");
      await runUpdate(
        id,
        {
          comment: ["text=seed comment"],
          note: ["text=seed note"],
          learning: ["text=seed learning"],
          file: ["path=src/cli/main.ts,scope=project"],
          test: ["command=node scripts/run-tests.mjs test -- tests/unit/update-command.spec.ts,scope=project"],
          doc: ["path=README.md,scope=project"],
          message: "seed transactional linked collections",
        },
        { path: context.pmPath },
      );

      const cleared = await runUpdate(
        id,
        {
          clearComments: true,
          clearNotes: true,
          clearLearnings: true,
          clearFiles: true,
          clearTests: true,
          clearDocs: true,
          message: "clear transactional linked collections",
        },
        { path: context.pmPath },
      );

      expect(cleared.changed_fields).toEqual(
        expect.arrayContaining(["comments", "notes", "learnings", "files", "tests", "docs"]),
      );
      const item = cleared.item as Record<string, unknown>;
      expect(item.comments).toBeUndefined();
      expect(item.notes).toBeUndefined();
      expect(item.learnings).toBeUndefined();
      expect(item.files).toBeUndefined();
      expect(item.tests).toBeUndefined();
      expect(item.docs).toBeUndefined();
    });
  });

  it("validates dependency mutation payloads", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-invalid-dependencies");

      await expect(
        runUpdate(
          id,
          {
            dep: ["none", "id=dep-one,kind=blocks"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            dep: ["id=dep-one"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            dep: ["id=undefined,kind=blocks"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            depRemove: ["none"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            depRemove: ["undefined"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            depRemove: ["kind=blocks"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            clearDeps: true,
            dep: ["id=dep-clear,kind=blocks"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            replaceDeps: true,
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            replaceDeps: true,
            dep: ["id=dep-replaced,kind=blocks"],
            depRemove: ["dep-replaced"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            comment: ["none", "text=mixed comment payload"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          {
            file: ["none", "path=README.md,scope=project"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("validates reminder update inputs", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-invalid-reminders");

      const dateTitleAliasResult = await runUpdate(
        id,
        { reminder: ["date=2026-03-03T12:00:00.000Z,title=date title alias"], message: "set date title alias reminder" },
        { path: context.pmPath },
      );
      expect(dateTitleAliasResult.item.reminders?.[0]).toMatchObject({
        at: "2026-03-03T12:00:00.000Z",
        text: "date title alias",
      });

      await expect(
        runUpdate(
          id,
          { reminder: ["none", "at=2026-03-03T12:00:00.000Z,text=mixed"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { reminder: ["text=missing-at"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { reminder: ["at=+1d,text=   "] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { reminder: ["at=+3d+1h,text=compound-relative"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining('Invalid reminder.at value "+3d+1h"'),
      });
    });
  });

  it("validates event update inputs", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-invalid-events");

      const dateAliasResult = await runUpdate(
        id,
        { event: ["date=2026-03-03T12:00:00.000Z,title=date alias"], message: "set date alias event" },
        { path: context.pmPath },
      );
      expect(dateAliasResult.item.events?.[0]).toMatchObject({
        start_at: "2026-03-03T12:00:00.000Z",
        title: "date alias",
      });

      await expect(
        runUpdate(
          id,
          { event: ["none", "start=2026-03-03T12:00:00.000Z,title=mixed"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["title=missing-start"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,end=2026-03-03T11:00:00.000Z"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,title=   "] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,description=   "] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,location=   "] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,timezone=   "] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,all_day=maybe"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,recur_interval=2"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,recur_freq=daily,recur_interval=0"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,recur_freq=daily,recur_count=0"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,recur_freq=daily,recur_until=2026-03-02T12:00:00.000Z"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=2026-03-03T12:00:00.000Z,recur_freq=monthly,recur_by_month_day=0"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runUpdate(
          id,
          { event: ["start=+3d,end=+3d+1h,title=compound-relative"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining('Invalid event.end value "+3d+1h"'),
      });
    });
  });

  it("resolves update author from env, settings, and unknown fallback", async () => {
    await withTempPmPath(async (context) => {
      const envAuthorId = createTask(context, "update-env-author");
      await runUpdate(
        envAuthorId,
        {
          description: "env-based author update",
          message: "env author",
        },
        { path: context.pmPath },
      );
      expect(latestUpdateAuthor(context, envAuthorId)).toBe("test-author");

      const previousPmAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const settingsPath = path.join(context.pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
        settings.author_default = "settings-author";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const settingsAuthorId = createTask(context, "update-settings-author");
        await runUpdate(
          settingsAuthorId,
          {
            description: "settings-based author update",
            message: "settings author",
          },
          { path: context.pmPath },
        );
        expect(latestUpdateAuthor(context, settingsAuthorId)).toBe("settings-author");

        settings.author_default = "   ";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const unknownAuthorId = createTask(context, "update-unknown-author");
        await runUpdate(
          unknownAuthorId,
          {
            description: "unknown author update",
            author: "   ",
            message: "unknown author",
          },
          { path: context.pmPath },
        );
        expect(latestUpdateAuthor(context, unknownAuthorId)).toBe("unknown");
      } finally {
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });

  it("blocks foreign assignment updates unless forced", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-force", { assignee: "foreign-assignee" });
      setGovernancePreset(context, "strict");

      await expect(runUpdate(id, { description: "blocked update" }, { path: context.pmPath })).rejects.toMatchObject<
        PmCliError
      >({
        exitCode: EXIT_CODE.CONFLICT,
      });

      const forced = await runUpdate(
        id,
        {
          description: "forced update",
          force: true,
          message: "force update for foreign assignment",
        },
        { path: context.pmPath },
      );

      const item = forced.item as Record<string, unknown>;
      expect(item.description).toBe("forced update");
    });
  });

  it("allows non-owner metadata updates with --allow-audit-update", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-audit-override", { assignee: "foreign-assignee" });
      const result = await runUpdate(
        id,
        {
          description: "audited metadata update",
          allowAuditUpdate: true,
          message: "audit override metadata sync",
        },
        { path: context.pmPath },
      );
      expect((result.item as Record<string, unknown>).description).toBe("audited metadata update");
      expect(result.audit_update).toBe(true);
      expect(latestUpdateOperation(context, id)).toBe("update_audit");
    });
  });

  it("rejects lifecycle and ownership fields when --allow-audit-update is used", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-audit-scope-guard", { assignee: "foreign-assignee" });
      await expect(
        runUpdate(
          id,
          {
            allowAuditUpdate: true,
            status: "blocked",
            message: "attempt lifecycle mutation via audit mode",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--status"),
      });
    });
  });

  it("allows non-owner dependency additions with --allow-audit-dep-update", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-audit-dep-override", { assignee: "foreign-assignee" });
      const result = await runUpdate(
        id,
        {
          allowAuditDepUpdate: true,
          dep: ["id=dep-audit,kind=related,author=audit-owner,created_at=2026-03-01T00:00:00.000Z"],
          message: "audit dependency add",
        },
        { path: context.pmPath },
      );
      expect((result.item as { dependencies?: Array<Record<string, unknown>> }).dependencies).toEqual([
        {
          id: "pm-dep-audit",
          kind: "related",
          author: "audit-owner",
          created_at: "2026-03-01T00:00:00.000Z",
        },
      ]);
      expect(result.audit_update).toBe(true);
      expect(latestUpdateOperation(context, id)).toBe("update_audit");
    });
  });

  it("rejects non-dependency mutations when --allow-audit-dep-update is used", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-audit-dep-scope-guard", { assignee: "foreign-assignee" });
      await expect(
        runUpdate(
          id,
          {
            allowAuditDepUpdate: true,
            status: "blocked",
            dep: ["id=dep-audit,kind=related"],
            message: "attempt lifecycle mutation in dep-audit mode",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--status"),
      });

      await expect(
        runUpdate(
          id,
          {
            allowAuditDepUpdate: true,
            message: "missing dependency payload",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("requires at least one --dep"),
      });
    });
  });

  it("accepts colon and markdown formats for update type-option entries", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        item_types?: { definitions?: Array<Record<string, unknown>> };
      };
      settings.item_types = {
        definitions: [
          {
            name: "Asset",
            folder: "assets",
            required_create_fields: [],
            required_create_repeatables: [],
            options: [
              { key: "category", values: ["feature", "maintenance"] },
              { key: "workflow", values: ["seeded", "regression"] },
            ],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const id = createTask(context, "update-type-option-colon", { type: "Asset" });
      const colonResult = await runUpdate(
        id,
        {
          typeOption: ["category:maintenance"],
          message: "update type option colon",
        },
        { path: context.pmPath },
      );
      expect((colonResult.item as { type_options?: Record<string, string> }).type_options).toEqual({
        category: "maintenance",
      });

      const markdownResult = await runUpdate(
        id,
        {
          typeOption: ["key: workflow\nvalue: regression"],
          message: "update type option markdown",
        },
        { path: context.pmPath },
      );
      expect((markdownResult.item as { type_options?: Record<string, string> }).type_options).toEqual({
        workflow: "regression",
      });
    });
  });

  it("accepts stdin token for update repeatable entries", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-repeatable-stdin");
      const stdin = new PassThrough();
      stdin.end(["at: +1d", "text: reminder from stdin"].join("\n"));
      Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
      vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream);

      const updated = await runUpdate(
        id,
        {
          reminder: ["-"],
          message: "update reminder from stdin",
        },
        { path: context.pmPath },
      );

      expect((updated.item as { reminders?: Array<{ text: string }> }).reminders?.at(0)?.text).toBe("reminder from stdin");
    });
  });

  it("accepts stdin token for update body value", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-body-stdin");
      const stdin = new PassThrough();
      stdin.end("body from stdin token");
      Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
      vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream);

      const updated = await runUpdate(
        id,
        {
          body: "-",
          message: "update body from stdin",
        },
        { path: context.pmPath },
      );

      expect(updated.changed_fields).toContain("body");
      const loaded = context.runCli(["get", id, "--json"], { expectJson: true });
      expect((loaded.json as { body: string }).body).toBe("body from stdin token");
    });
  });
});
