import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runUpdate } from "../../src/cli/commands/update.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

interface CreateTaskOptions {
  assignee?: string;
  deadline?: string;
  estimate?: string;
  acceptanceCriteria?: string;
}

function createTask(context: TempPmContext, title: string, options: CreateTaskOptions = {}): string {
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
      "--assignee",
      options.assignee ?? "none",
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

  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

function latestUpdateAuthor(context: TempPmContext, id: string): string | undefined {
  const history = context.runCli(["history", id, "--json"], { expectJson: true });
  expect(history.code).toBe(0);
  const entries = (history.json as { history: Array<{ op: string; author: string }> }).history;
  return [...entries].reverse().find((entry) => entry.op === "update")?.author;
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

  it("requires at least one update flag", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-no-flags");
      await expect(runUpdate(id, {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("updates scalar fields with valid values", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-explicit-values");
      const result = await runUpdate(
        id,
        {
          title: "updated title",
          description: "updated description",
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
          parent: " pm-parent-next ",
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
      expect(item.parent).toBe("pm-parent-next");
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

  it("supports explicit none-unset semantics and clears assignee for canceled status", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-unset-fields", { assignee: "active-owner" });
      const result = await runUpdate(
        id,
        {
          description: "closed description",
          status: "canceled",
          deadline: "none",
          estimatedMinutes: "none",
          acceptanceCriteria: "none",
          definitionOfReady: "none",
          order: "none",
          rank: "none",
          goal: "none",
          objective: "none",
          value: "none",
          impact: "none",
          outcome: "none",
          whyNow: "none",
          assignee: "none",
          parent: "none",
          reviewer: "none",
          risk: "none",
          confidence: "none",
          sprint: "none",
          release: "none",
          blockedBy: "none",
          blockedReason: "none",
          unblockNote: "none",
          reporter: "none",
          severity: "none",
          environment: "none",
          reproSteps: "none",
          resolution: "none",
          expectedResult: "none",
          actualResult: "none",
          affectedVersion: "none",
          fixedVersion: "none",
          component: "none",
          regression: "none",
          customerImpact: "none",
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
    });
  });

  it("clears assignee when assignee is blank whitespace", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-blank-assignee");
      const result = await runUpdate(
        id,
        {
          description: "clear assignee with whitespace",
          assignee: "   ",
        },
        { path: context.pmPath },
      );

      const item = result.item as Record<string, unknown>;
      expect(item.assignee).toBeUndefined();
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
});
