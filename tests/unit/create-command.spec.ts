import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCreate, type CreateCommandOptions } from "../../src/cli/commands/create.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks } from "../../src/core/extensions/index.js";
import type { ExtensionHookRegistry } from "../../src/core/extensions/loader.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import type { TempPmContext } from "../helpers/withTempPmPath.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

function baseCreateOptions(overrides: Partial<CreateCommandOptions> = {}): CreateCommandOptions {
  return {
    title: "create-seed",
    description: "create seed description",
    type: "Task",
    status: "open",
    priority: "1",
    tags: "gamma,alpha,gamma",
    body: "create seed body",
    deadline: "2026-03-01T00:00:00.000Z",
    estimatedMinutes: "30",
    acceptanceCriteria: "create seed acceptance",
    author: "seed-author",
    message: "create seed message",
    assignee: "seed-assignee",
    dep: ["id=a1b2,kind=related,author=dep-author,created_at=2026-01-01T00:00:00.000Z"],
    comment: ["author=comment-author,text=seed comment"],
    note: ["author=note-author,text=seed note"],
    learning: ["author=learning-author,text=seed learning"],
    file: ["path=src/cli.ts,note=entrypoint"],
    test: [
      "command=node scripts/run-tests.mjs test,path=tests/unit/create-command.spec.ts,timeout=120,timeout_seconds=120,note=create-coverage",
    ],
    doc: ["path=README.md,note=documentation"],
    ...overrides,
  };
}

function readCreateHistory(context: TempPmContext, id: string): Array<{ op: string; author: string; message?: string }> {
  const history = context.runCli(["history", id, "--json", "--full"], { expectJson: true });
  expect(history.code).toBe(0);
  return (history.json as { history: Array<{ op: string; author: string; message?: string }> }).history;
}

describe("runCreate", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
    vi.restoreAllMocks();
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-create-not-init-"));
    try {
      await expect(runCreate(baseCreateOptions(), { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses governance create-mode defaults for permissive and strict flows", async () => {
    await withTempPmPath(async (context) => {
      const minimal: CreateCommandOptions = {
        title: "minimal-default-progressive",
        description: "minimal default should allow staged creation",
        type: "Task",
      };
      const defaultResult = await runCreate(minimal, { path: context.pmPath });
      expect(defaultResult.item.title).toBe("minimal-default-progressive");
      expect(defaultResult.item.status).toBe("open");
      expect(defaultResult.item.priority).toBe(2);
      expect(defaultResult.warnings).toEqual([]);

      const settingsPath = path.join(context.pmPath, "settings.json");
      const strictSettings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        governance?: { preset?: string };
      };
      strictSettings.governance = {
        ...(strictSettings.governance ?? {}),
        preset: "strict",
      };
      await writeFile(settingsPath, `${JSON.stringify(strictSettings, null, 2)}\n`, "utf8");

      await expect(runCreate(minimal, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        context: {
          nextSteps: expect.arrayContaining([expect.stringContaining("--create-mode progressive")]),
        },
      });
      await expect(runCreate(minimal, { path: context.pmPath })).rejects.toThrow("Missing required options");

      const scheduleMinimal: CreateCommandOptions = {
        title: "strict-default-event-minimal",
        description: "strict default event should include schedule hint",
        type: "Event",
      };
      await expect(runCreate(scheduleMinimal, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        context: {
          nextSteps: expect.arrayContaining([expect.stringContaining("--schedule-preset lightweight")]),
        },
      });
    });
  });

  it("supports progressive create mode for staged minimal creation", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        {
          title: "progressive-minimal",
          description: "progressive mode staged create",
          type: "Task",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );
      expect(result.warnings).toEqual([]);
      expect(result.item.title).toBe("progressive-minimal");
      expect(result.item.type).toBe("Task");
      expect(result.item.status).toBe("open");
      expect(result.item.priority).toBe(2);
      expect(result.item.tags).toEqual([]);
      expect(result.item.acceptance_criteria).toBeUndefined();
      expect(result.item.assignee).toBeUndefined();
      expect(result.item.dependencies).toBeUndefined();
      expect(result.item.files).toBeUndefined();
      expect(result.item.docs).toBeUndefined();
      expect(result.item.tests).toBeUndefined();
      expect(result.changed_fields).not.toContain("body");
    });
  });

  it("accepts cmd as a structured --test alias without corrupting linked test commands", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        baseCreateOptions({
          title: "create-linked-test-cmd-alias",
          test: ["CMD=node --version,SCOPE=project,note=cmd alias"],
        }),
        { path: context.pmPath },
      );

      expect(result.item.tests).toEqual([
        expect.objectContaining({
          command: "node --version",
          scope: "project",
          note: "cmd alias",
        }),
      ]);
      expect(result.item.tests?.some((entry) => entry.command.includes("cmd="))).toBe(false);
    });
  });

  it("rejects unknown structured --test keys instead of storing them as commands", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          baseCreateOptions({
            title: "create-linked-test-unknown-key",
            test: ["cmd=node --version,name=smoke"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--test does not recognize key \"name\""),
      });

      await expect(
        runCreate(
          baseCreateOptions({
            title: "create-linked-test-command-conflict",
            test: ["command=node --version,cmd=node --help"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--test command and cmd must match"),
      });
    });
  });

  it("keeps bare create --test commands containing equals signs working", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        baseCreateOptions({
          title: "create-linked-test-bare-equals",
          test: ['node -e "process.env.FOO=\\"bar\\""'],
        }),
        { path: context.pmPath },
      );

      expect(result.item.tests).toEqual([
        expect.objectContaining({
          command: 'node -e "process.env.FOO=\\"bar\\""',
          scope: "project",
        }),
      ]);
    });
  });

  it("derives a blocked_by dependency from --blocked-by when it references an existing item", async () => {
    await withTempPmPath(async (context) => {
      const blocker = await runCreate(
        baseCreateOptions({
          title: "create-blocker-seed",
          description: "blocker seed",
          message: "create blocker seed",
        }),
        { path: context.pmPath },
      );

      const blocked = await runCreate(
        baseCreateOptions({
          title: "create-blocked-by-id",
          description: "blocked by an existing item id",
          status: undefined,
          blockedBy: blocker.item.id,
          dep: undefined,
        }),
        { path: context.pmPath },
      );
      expect(blocked.item.blocked_by).toBe(blocker.item.id);
      expect(blocked.item.status).toBe("blocked");
      expect(blocked.item.dependencies).toEqual([
        expect.objectContaining({
          id: blocker.item.id,
          kind: "blocked_by",
          author: "seed-author",
        }),
      ]);

      const explicitStatus = await runCreate(
        baseCreateOptions({
          title: "create-blocked-by-explicit-status",
          description: "explicit status is preserved",
          status: "open",
          blockedBy: blocker.item.id,
          dep: undefined,
        }),
        { path: context.pmPath },
      );
      expect(explicitStatus.item.status).toBe("open");
      expect(explicitStatus.item.dependencies).toEqual([
        expect.objectContaining({ id: blocker.item.id, kind: "blocked_by" }),
      ]);
    });
  });

  it("keeps free-text blocked_by metadata without deriving dependency edges", async () => {
    await withTempPmPath(async (context) => {
      const blocked = await runCreate(
        baseCreateOptions({
          title: "create-blocked-by-free-text",
          description: "blocked by external reason",
          status: undefined,
          blockedBy: "waiting on external vendor",
          dep: undefined,
        }),
        { path: context.pmPath },
      );
      expect(blocked.item.blocked_by).toBe("waiting on external vendor");
      expect(blocked.item.status).toBe("open");
      expect(blocked.item.dependencies).toBeUndefined();
    });
  });

  it("deduplicates derived blocked_by dependency against explicit dependencies", async () => {
    await withTempPmPath(async (context) => {
      const blocker = await runCreate(
        baseCreateOptions({
          title: "create-blocker-dedupe-seed",
          description: "blocker seed",
          message: "create blocker dedupe seed",
        }),
        { path: context.pmPath },
      );
      const blocked = await runCreate(
        baseCreateOptions({
          title: "create-blocked-by-dedupe",
          description: "blocked by explicit and derived dependency",
          status: undefined,
          blockedBy: blocker.item.id,
          dep: [`id=${blocker.item.id},kind=blocked_by,created_at=now`],
        }),
        { path: context.pmPath },
      );
      const blockedByEdges = blocked.item.dependencies?.filter(
        (dependency) => dependency.id === blocker.item.id && dependency.kind === "blocked_by",
      );
      expect(blockedByEdges).toHaveLength(1);
      expect(blocked.item.status).toBe("blocked");
    });
  });

  it("supports schedule lightweight preset for Reminder/Meeting/Event minimal creation", async () => {
    await withTempPmPath(async (context) => {
      for (const type of ["Reminder", "Meeting", "Event"] as const) {
        const result = await runCreate(
          {
            title: `${type} lightweight preset`,
            description: `Minimal ${type.toLowerCase()} creation`,
            type,
            schedulePreset: "lightweight",
          },
          { path: context.pmPath },
        );
        expect(result.item.type).toBe(type);
        expect(result.item.status).toBe("open");
        expect(result.item.priority).toBe(2);
      }
    });
  });

  it("validates schedule preset type scope and strict-mode conflicts", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          {
            title: "task-schedule-preset-invalid",
            description: "Schedule preset must be schedule type only",
            type: "Task",
            schedulePreset: "lightweight",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("only supported for Reminder, Meeting, or Event"),
      });

      await expect(
        runCreate(
          {
            title: "strict-conflict-reminder",
            description: "Strict mode conflict with schedule preset",
            type: "Reminder",
            schedulePreset: "lightweight",
            createMode: "strict",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("cannot be combined with --create-mode strict"),
      });
    });
  });

  it("rejects unsupported create mode values", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          {
            title: "invalid-create-mode",
            description: "invalid create mode should fail",
            type: "Task",
            createMode: "adaptive",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("creates an item with normalized fields and deterministic history metadata", async () => {
    await withTempPmPath(async (context) => {
      const parentSeed = await runCreate(
        baseCreateOptions({
          title: "create-parent-seed",
          description: "parent seed",
          message: "create parent seed",
        }),
        { path: context.pmPath },
      );
      const result = await runCreate(
        baseCreateOptions({
          parent: parentSeed.item.id,
          reviewer: "reviewer-seed",
          risk: "med",
          confidence: "med",
          sprint: "sprint-42",
          release: "release-2026.03",
          blockedBy: "pm-blocked-seed",
          blockedReason: "waiting on dependency seed",
          unblockNote: "dependency unblocked by upstream patch",
          reporter: "reporter-seed",
          severity: "med",
          environment: "linux:node25",
          reproSteps: "run create then update",
          resolution: "workaround documented",
          expectedResult: "create metadata persists",
          actualResult: "metadata mismatch observed",
          affectedVersion: "0.1.0",
          fixedVersion: "0.1.1",
          component: "cli/create",
          regression: "true",
          customerImpact: "high volume issue triage blocked",
          definitionOfReady: "ready when fixtures are prepared",
          order: "7",
          goal: "goal-seed",
          objective: "objective-seed",
          value: "value-seed",
          impact: "impact-seed",
          outcome: "outcome-seed",
          whyNow: "why-now-seed",
          reminder: [
            "at=2026-03-02T09:00:00.000Z,text=reminder beta",
            "at=2026-03-02T09:00:00.000Z,text=reminder alpha",
          ],
          event: [
            "start=2026-03-03T08:00:00.000Z,title=Daily defaults,recur_freq=daily",
            "start=2026-03-04T10:00:00.000Z,end=2026-03-04T11:00:00.000Z,title=Roadmap review,all_day=yes",
            "start=2026-03-05T15:30:00.000Z,title=Weekly sync,all_day=false,recur_freq=weekly,recur_by_weekday=fri|mon|fri,recur_by_month_day=10|2,recur_exdates=2026-03-12T15:30:00.000Z|2026-03-07T15:30:00.000Z",
          ],
        }),
        { path: context.pmPath },
      );

      expect(result.warnings).toEqual([]);
      expect(result.changed_fields).toEqual(
        expect.arrayContaining([
          "id",
          "title",
          "description",
          "type",
          "status",
          "priority",
          "tags",
          "created_at",
          "updated_at",
          "deadline",
          "assignee",
          "author",
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
          "dependencies",
          "comments",
          "notes",
          "learnings",
          "files",
          "tests",
          "docs",
          "reminders",
          "events",
          "body",
        ]),
      );

      expect(result.item.id).toMatch(/^pm-/);
      expect(result.item.type).toBe("Task");
      expect(result.item.status).toBe("open");
      expect(result.item.priority).toBe(1);
      expect(result.item.tags).toEqual(["alpha", "gamma"]);
      expect(result.item.author).toBe("seed-author");
      expect(result.item.parent).toBe(parentSeed.item.id);
      expect(result.item.reviewer).toBe("reviewer-seed");
      expect(result.item.risk).toBe("medium");
      expect(result.item.confidence).toBe("medium");
      expect(result.item.sprint).toBe("sprint-42");
      expect(result.item.release).toBe("release-2026.03");
      expect(result.item.blocked_by).toBe("pm-blocked-seed");
      expect(result.item.blocked_reason).toBe("waiting on dependency seed");
      expect(result.item.unblock_note).toBe("dependency unblocked by upstream patch");
      expect(result.item.reporter).toBe("reporter-seed");
      expect(result.item.severity).toBe("medium");
      expect(result.item.environment).toBe("linux:node25");
      expect(result.item.repro_steps).toBe("run create then update");
      expect(result.item.resolution).toBe("workaround documented");
      expect(result.item.expected_result).toBe("create metadata persists");
      expect(result.item.actual_result).toBe("metadata mismatch observed");
      expect(result.item.affected_version).toBe("0.1.0");
      expect(result.item.fixed_version).toBe("0.1.1");
      expect(result.item.component).toBe("cli/create");
      expect(result.item.regression).toBe(true);
      expect(result.item.customer_impact).toBe("high volume issue triage blocked");
      expect(result.item.definition_of_ready).toBe("ready when fixtures are prepared");
      expect(result.item.order).toBe(7);
      expect(result.item.goal).toBe("goal-seed");
      expect(result.item.objective).toBe("objective-seed");
      expect(result.item.value).toBe("value-seed");
      expect(result.item.impact).toBe("impact-seed");
      expect(result.item.outcome).toBe("outcome-seed");
      expect(result.item.why_now).toBe("why-now-seed");
      expect(result.item.dependencies).toEqual([
        {
          id: "pm-a1b2",
          kind: "related",
          author: "dep-author",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ]);
      expect(result.item.comments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            author: "comment-author",
            text: "seed comment",
          }),
        ]),
      );
      expect(result.item.tests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: "node scripts/run-tests.mjs test",
            path: "tests/unit/create-command.spec.ts",
            scope: "project",
            timeout_seconds: 120,
          }),
        ]),
      );
      expect(result.item.reminders).toEqual([
        { at: "2026-03-02T09:00:00.000Z", text: "reminder alpha" },
        { at: "2026-03-02T09:00:00.000Z", text: "reminder beta" },
      ]);
      expect(result.item.events).toEqual([
        {
          start_at: "2026-03-03T08:00:00.000Z",
          title: "Daily defaults",
          recurrence: {
            freq: "daily",
          },
        },
        {
          start_at: "2026-03-04T10:00:00.000Z",
          end_at: "2026-03-04T11:00:00.000Z",
          title: "Roadmap review",
          all_day: true,
        },
        {
          start_at: "2026-03-05T15:30:00.000Z",
          title: "Weekly sync",
          all_day: false,
          recurrence: {
            freq: "weekly",
            by_weekday: ["mon", "fri"],
            by_month_day: [2, 10],
            exdates: ["2026-03-07T15:30:00.000Z", "2026-03-12T15:30:00.000Z"],
          },
        },
      ]);

      const history = readCreateHistory(context, result.item.id);
      const createEntry = [...history].reverse().find((entry) => entry.op === "create");
      expect(createEntry).toMatchObject({
        op: "create",
        author: "seed-author",
        message: "create seed message",
      });
    });
  });

  it("accepts confidence text levels and numeric values", async () => {
    await withTempPmPath(async (context) => {
      const textConfidence = await runCreate(
        baseCreateOptions({
          title: "create-confidence-text",
          confidence: "high",
          message: "create confidence text",
        }),
        { path: context.pmPath },
      );
      expect(textConfidence.item.confidence).toBe("high");

      const numericConfidence = await runCreate(
        baseCreateOptions({
          title: "create-confidence-numeric",
          confidence: "87",
          message: "create confidence numeric",
        }),
        { path: context.pmPath },
      );
      expect(numericConfidence.item.confidence).toBe(87);
    });
  });

  it("accepts regression false boolean aliases", async () => {
    await withTempPmPath(async (context) => {
      const falseRegression = await runCreate(
        baseCreateOptions({
          title: "create-regression-false",
          regression: "0",
          message: "create regression false",
        }),
        { path: context.pmPath },
      );
      expect(falseRegression.item.regression).toBe(false);
    });
  });

  it("accepts in-progress status alias and stores canonical status", async () => {
    await withTempPmPath(async (context) => {
      const aliasedStatus = await runCreate(
        baseCreateOptions({
          title: "create-status-alias",
          status: "in-progress",
          message: "create with status alias",
        }),
        { path: context.pmPath },
      );
      expect(aliasedStatus.item.status).toBe("in_progress");
    });
  });

  it("dispatches onWrite hooks for item and history writes", async () => {
    await withTempPmPath(async (context) => {
      const events: string[] = [];
      const hooks: ExtensionHookRegistry = {
        beforeCommand: [],
        afterCommand: [],
        onRead: [],
        onWrite: [
          {
            layer: "project",
            name: "create-write-hook",
            run: (hookContext) => {
              events.push(`${hookContext.op}:${path.basename(hookContext.path)}`);
              if (hookContext.op === "create:history") {
                throw new Error("history write hook failure");
              }
            },
          },
        ],
        onIndex: [],
      };
      setActiveExtensionHooks(hooks);

      const result = await runCreate(
        baseCreateOptions({
          title: "create-hook-dispatch",
          message: "create hook coverage",
        }),
        { path: context.pmPath },
      );

      expect(events).toEqual([
        `lock:create:${result.item.id}.lock`,
        `create:${result.item.id}.toon`,
        `create:history:${result.item.id}.jsonl`,
        `lock:release:${result.item.id}.lock`,
      ]);
      expect(result.warnings).toEqual(["extension_hook_failed:project:create-write-hook:onWrite"]);
    });
  });

  it("accepts month-relative and normalized date-string deadline inputs", async () => {
    await withTempPmPath(async (context) => {
      const monthRelative = await runCreate(
        baseCreateOptions({
          title: "create-month-relative-deadline",
          deadline: "+6m",
          message: "create month-relative deadline",
        }),
        { path: context.pmPath },
      );
      expect(Number.isNaN(Date.parse(String(monthRelative.item.deadline)))).toBe(false);

      const normalizedDateString = await runCreate(
        baseCreateOptions({
          title: "create-normalized-date-string-deadline",
          deadline: "2026-03-31T13-59Z",
          message: "create normalized date-string deadline",
        }),
        { path: context.pmPath },
      );
      expect(normalizedDateString.item.deadline).toBe("2026-03-31T13:59:00.000Z");
    });
  });

  it("supports explicit unset/clear semantics in progressive mode and records unset intent in history message", async () => {
    await withTempPmPath(async (context) => {
      const previousPmAuthor = process.env.PM_AUTHOR;
      process.env.PM_AUTHOR = "   ";
      try {
        const result = await runCreate(
          baseCreateOptions({
            title: "create-unset-semantics",
            createMode: "progressive",
            deadline: undefined,
            estimatedMinutes: undefined,
            acceptanceCriteria: undefined,
            definitionOfReady: undefined,
            order: undefined,
            rank: undefined,
            goal: undefined,
            objective: undefined,
            value: undefined,
            impact: undefined,
            outcome: undefined,
            whyNow: undefined,
            author: undefined,
            assignee: undefined,
            parent: undefined,
            reviewer: undefined,
            risk: undefined,
            confidence: undefined,
            sprint: undefined,
            release: undefined,
            blockedBy: undefined,
            blockedReason: undefined,
            unblockNote: undefined,
            reporter: undefined,
            severity: undefined,
            environment: undefined,
            reproSteps: undefined,
            resolution: undefined,
            expectedResult: undefined,
            actualResult: undefined,
            affectedVersion: undefined,
            fixedVersion: undefined,
            component: undefined,
            regression: undefined,
            customerImpact: undefined,
            reminder: undefined,
            event: undefined,
            dep: undefined,
            comment: undefined,
            note: undefined,
            learning: undefined,
            file: undefined,
            test: undefined,
            doc: undefined,
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
              "author",
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
            clearDeps: true,
            clearComments: true,
            clearNotes: true,
            clearLearnings: true,
            clearFiles: true,
            clearTests: true,
            clearDocs: true,
            clearReminders: true,
            clearEvents: true,
          }),
          { path: context.pmPath },
        );

        expect(result.item.deadline).toBeUndefined();
        expect(result.item.estimated_minutes).toBeUndefined();
        expect(result.item.acceptance_criteria).toBeUndefined();
        expect(result.item.definition_of_ready).toBeUndefined();
        expect(result.item.order).toBeUndefined();
        expect(result.item.goal).toBeUndefined();
        expect(result.item.objective).toBeUndefined();
        expect(result.item.value).toBeUndefined();
        expect(result.item.impact).toBeUndefined();
        expect(result.item.outcome).toBeUndefined();
        expect(result.item.why_now).toBeUndefined();
        expect(result.item.assignee).toBeUndefined();
        expect(result.item.parent).toBeUndefined();
        expect(result.item.reviewer).toBeUndefined();
        expect(result.item.risk).toBeUndefined();
        expect(result.item.confidence).toBeUndefined();
        expect(result.item.sprint).toBeUndefined();
        expect(result.item.release).toBeUndefined();
        expect(result.item.blocked_by).toBeUndefined();
        expect(result.item.blocked_reason).toBeUndefined();
        expect(result.item.unblock_note).toBeUndefined();
        expect(result.item.reporter).toBeUndefined();
        expect(result.item.severity).toBeUndefined();
        expect(result.item.environment).toBeUndefined();
        expect(result.item.repro_steps).toBeUndefined();
        expect(result.item.resolution).toBeUndefined();
        expect(result.item.expected_result).toBeUndefined();
        expect(result.item.actual_result).toBeUndefined();
        expect(result.item.affected_version).toBeUndefined();
        expect(result.item.fixed_version).toBeUndefined();
        expect(result.item.component).toBeUndefined();
        expect(result.item.regression).toBeUndefined();
        expect(result.item.customer_impact).toBeUndefined();
        expect(result.item.dependencies).toBeUndefined();
        expect(result.item.comments).toBeUndefined();
        expect(result.item.notes).toBeUndefined();
        expect(result.item.learnings).toBeUndefined();
        expect(result.item.files).toBeUndefined();
        expect(result.item.tests).toBeUndefined();
        expect(result.item.docs).toBeUndefined();
        expect(result.item.reminders).toBeUndefined();
        expect(result.item.events).toBeUndefined();
        expect(result.item.author).toBeUndefined();

        expect(result.changed_fields).toEqual(
          expect.arrayContaining([
            "unset:author",
            "unset:deadline",
            "unset:estimated_minutes",
            "unset:acceptance_criteria",
            "unset:definition_of_ready",
            "unset:order",
            "unset:goal",
            "unset:objective",
            "unset:value",
            "unset:impact",
            "unset:outcome",
            "unset:why_now",
            "unset:assignee",
            "unset:parent",
            "unset:reviewer",
            "unset:risk",
            "unset:confidence",
            "unset:sprint",
            "unset:release",
            "unset:blocked_by",
            "unset:blocked_reason",
            "unset:unblock_note",
            "unset:reporter",
            "unset:severity",
            "unset:environment",
            "unset:repro_steps",
            "unset:resolution",
            "unset:expected_result",
            "unset:actual_result",
            "unset:affected_version",
            "unset:fixed_version",
            "unset:component",
            "unset:regression",
            "unset:customer_impact",
            "unset:dependencies",
            "unset:comments",
            "unset:notes",
            "unset:learnings",
            "unset:files",
            "unset:tests",
            "unset:docs",
            "unset:reminders",
            "unset:events",
          ]),
        );

        const history = readCreateHistory(context, result.item.id);
        const createEntry = [...history].reverse().find((entry) => entry.op === "create");
        expect(createEntry?.message).toContain("explicit_unset=");
        expect(createEntry?.message).toContain("acceptance_criteria");
      } finally {
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });

  it("enforces strict author clear policy and supports progressive author fallback", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          baseCreateOptions({
            title: "create-strict-author-unset-rejected",
            createMode: "strict",
            author: undefined,
            unset: ["author"],
            message: "strict unset author",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toThrow("Strict create mode requires concrete values");

      const envAuthor = await runCreate(
        baseCreateOptions({
          title: "create-env-author",
          createMode: "progressive",
          author: undefined,
          message: "env fallback",
        }),
        { path: context.pmPath },
      );
      expect(envAuthor.item.author).toBe("test-author");

      const previousPmAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const settingsPath = path.join(context.pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
        settings.author_default = "settings-author";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const settingsAuthor = await runCreate(
          baseCreateOptions({
            title: "create-settings-author",
            createMode: "progressive",
            author: undefined,
            message: "settings fallback",
          }),
          { path: context.pmPath },
        );
        expect(settingsAuthor.item.author).toBe("settings-author");
      } finally {
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });

  it("requires message for built-in type defaults even when optional seed lists are omitted", async () => {
    await withTempPmPath(async (context) => {
      const options = baseCreateOptions({
        title: "create-optional-seeds-omitted",
        createMode: "strict",
        dep: undefined,
        comment: undefined,
        note: undefined,
        learning: undefined,
        file: undefined,
        test: undefined,
        doc: undefined,
      });
      delete (options as Partial<CreateCommandOptions>).message;

      await expect(runCreate(options, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--message"),
      });
    });
  });

  it("uses fallback author and default scope/timeout branches for linked seed values", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        baseCreateOptions({
          title: "create-default-seed-branches",
          comment: ["text=seed comment without explicit author"],
          file: ["path=src/cli.ts"],
          test: [
            "command=node dist/cli.js --version,timeout=15",
            "command=node -e \"process.stdout.write('create-path-metadata')\",path=tests/unit/create-command.spec.ts",
          ],
          doc: ["path=README.md"],
        }),
        { path: context.pmPath },
      );

      expect(result.item.comments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            author: "seed-author",
            text: "seed comment without explicit author",
          }),
        ]),
      );
      expect(result.item.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "src/cli.ts",
            scope: "project",
          }),
        ]),
      );
      expect(result.item.tests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: "node dist/cli.js --version",
            scope: "project",
            timeout_seconds: 15,
          }),
          expect.objectContaining({
            path: "tests/unit/create-command.spec.ts",
            command: "node -e \"process.stdout.write('create-path-metadata')\"",
            scope: "project",
          }),
        ]),
      );
      expect(result.item.docs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "README.md",
            scope: "project",
          }),
        ]),
      );
    });
  });

  it("rejects path-only linked test seed entries", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          baseCreateOptions({
            title: "create-path-only-test-seed",
            test: ["path=tests/unit/create-command.spec.ts"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runCreate(
          baseCreateOptions({
            title: "create-path-only-test-seed-message",
            test: ["path=tests/unit/create-command.spec.ts"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toThrow("--test requires command=<value>");
    });
  });

  it("accepts intuitive rich agent seed inputs without dropping metadata", async () => {
    await withTempPmPath(async (context) => {
      const parent = await runCreate(
        baseCreateOptions({
          title: "intuitive-parent",
          description: "parent for bare dependency seed",
          createMode: "progressive",
        }),
        { path: context.pmPath },
      );

      const result = await runCreate(
        baseCreateOptions({
          title: "intuitive-agent-seeds",
          createMode: "progressive",
          dep: [parent.item.id],
          comment: ["author=agent,text=Implemented parser fallback,scope=project,evidence=manual dogfood"],
          note: ["Agent note with comma, scope: project, and retry context"],
          learning: ["text=Keep the first rich agent payload intact,source=dogfood"],
          file: ["src/cli/commands/create.ts"],
          test: ["node scripts/run-tests.mjs test -- tests/unit/create-command.spec.ts"],
          doc: ["README.md"],
        }),
        { path: context.pmPath },
      );

      expect(result.item.dependencies).toEqual([
        expect.objectContaining({
          id: parent.item.id,
          kind: "related",
        }),
      ]);
      expect(result.item.comments?.[0]).toMatchObject({
        author: "agent",
        text: "author=agent,text=Implemented parser fallback,scope=project,evidence=manual dogfood",
      });
      expect(result.item.notes?.[0]?.text).toBe("Agent note with comma, scope: project, and retry context");
      expect(result.item.learnings?.[0]?.text).toBe("text=Keep the first rich agent payload intact,source=dogfood");
      expect(result.item.files).toEqual([
        expect.objectContaining({
          path: "src/cli/commands/create.ts",
          scope: "project",
        }),
      ]);
      expect(result.item.tests).toEqual([
        expect.objectContaining({
          command: "node scripts/run-tests.mjs test -- tests/unit/create-command.spec.ts",
          scope: "project",
        }),
      ]);
      expect(result.item.docs).toEqual([
        expect.objectContaining({
          path: "README.md",
          scope: "project",
        }),
      ]);
    });
  });

  it("parses linked-test runtime directives and assertion metadata in create seeds", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        baseCreateOptions({
          title: "create-linked-test-directive-assertions",
          test: [
            "command=node --version,scope=project,timeout_seconds=25,env_set=PORT=0;DEBUG=1,env_clear=PLAYWRIGHT_BASE_URL;TMPDIR,shared_host_safe=yes,assert_stdout_contains=v,assert_stdout_regex=v\\\\d+,assert_stderr_contains=warn,assert_stderr_regex=warn,assert_stdout_min_lines=0,assert_json_field_equals=flag=true;status=ok,assert_json_field_gte=count=2,note=directive-seed",
          ],
        }),
        { path: context.pmPath },
      );
      const linked = result.item.tests?.[0];
      expect(linked).toMatchObject({
        command: "node --version",
        scope: "project",
        timeout_seconds: 25,
        env_set: {
          DEBUG: "1",
          PORT: "0",
        },
        shared_host_safe: true,
        assert_stdout_contains: ["v"],
        assert_stdout_regex: ["v\\\\d+"],
        assert_stderr_contains: ["warn"],
        assert_stderr_regex: ["warn"],
        assert_stdout_min_lines: 0,
        assert_json_field_equals: {
          flag: "true",
          status: "ok",
        },
        assert_json_field_gte: {
          count: 2,
        },
        note: "directive-seed",
      });
      expect(linked?.env_clear).toEqual(expect.arrayContaining(["PLAYWRIGHT_BASE_URL", "TMPDIR"]));
    });
  });

  it("rejects invalid linked-test runtime directives and assertion metadata", async () => {
    await withTempPmPath(async (context) => {
      const invalidFragments = [
        "env_set=PORT",
        "env_set=PM_PATH=/tmp/unsafe",
        "env_clear=FORCE_COLOR",
        "env_clear=1INVALID",
        "shared_host_safe=maybe",
        "assert_stdout_regex=[",
        "assert_stderr_regex=[",
        "assert_stdout_min_lines=-1",
        "assert_stdout_min_lines=1.5",
        "assert_json_field_equals=count",
        "assert_json_field_equals==value",
        "assert_json_field_gte=count",
        "assert_json_field_gte=count=abc",
      ];
      for (const [index, fragment] of invalidFragments.entries()) {
        await expect(
          runCreate(
            baseCreateOptions({
              title: `create-invalid-linked-test-${index}`,
              test: [`command=node --version,scope=project,${fragment}`],
            }),
            { path: context.pmPath },
          ),
        ).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.USAGE,
        });
      }
    });
  });

  it("validates enum and numeric required fields", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          baseCreateOptions({
            type: "NotAType",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            status: "not-a-status",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            priority: "8",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            risk: "extreme",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            confidence: "101",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            confidence: "uncertain",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            severity: "urgent",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            regression: "sometimes",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            order: "2.5",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            order: "1",
            rank: "2",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("warns for non-conforming sprint and release values under default policy", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        baseCreateOptions({
          sprint: "Sprint 2026 W14",
          release: "Release Candidate 1",
        }),
        { path: context.pmPath },
      );

      expect(result.item.sprint).toBe("Sprint 2026 W14");
      expect(result.item.release).toBe("Release Candidate 1");
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
        runCreate(
          baseCreateOptions({
            sprint: "Sprint 2026 W14",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("warns for missing parent references under default policy", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        baseCreateOptions({
          parent: "pm-parent-missing-default",
        }),
        { path: context.pmPath },
      );

      expect(result.item.parent).toBe("pm-parent-missing-default");
      expect(result.warnings).toEqual(
        expect.arrayContaining(["validation_warning:parent_reference_missing:pm-parent-missing-default"]),
      );
    });
  });

  it("rejects missing parent references under strict policy", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as {
        governance?: {
          preset?: string;
          parent_reference?: string;
        };
      };
      parsed.governance = {
        ...(parsed.governance ?? {}),
        preset: "custom",
        parent_reference: "strict_error",
      };
      await writeFile(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

      await expect(
        runCreate(
          baseCreateOptions({
            parent: "pm-parent-missing-strict",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("rejects undefined parent placeholder tokens", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          baseCreateOptions({
            parent: "undefined",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("reinterprets legacy none/null tokens as deterministic unset and clear actions", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        baseCreateOptions({
          title: "create-legacy-none-compat",
          template: "none",
          tags: "none",
          deadline: "null",
          rank: "none",
          dep: ["none"],
          comment: ["null"],
          file: ["none"],
          test: ["null"],
          doc: ["none"],
          reminder: ["none"],
          event: ["null"],
          typeOption: ["none"],
        }),
        { path: context.pmPath },
      );

      const item = result.item as Record<string, unknown>;
      expect(item.tags === undefined || (Array.isArray(item.tags) && item.tags.length === 0)).toBe(true);
      expect(item.deadline).toBeUndefined();
      expect(item.order).toBeUndefined();
      expect(item.dependencies).toBeUndefined();
      expect(item.comments).toBeUndefined();
      expect(item.files).toBeUndefined();
      expect(item.tests).toBeUndefined();
      expect(item.docs).toBeUndefined();
      expect(item.reminders).toBeUndefined();
      expect(item.events).toBeUndefined();
      expect(item.type_options).toBeUndefined();
    });
  });

  it("validates dependency seed input", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          baseCreateOptions({
            dep: ["none", "id=a1b2,kind=related,created_at=now"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            dep: ["id=,kind=related,created_at=now"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            dep: ["id=a1b2,kind=invalid-kind,created_at=now"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            dep: ["id=a1b2,kind=related,created_at=not-a-date"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            dep: ["id=undefined,kind=related,created_at=now"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("validates comment seed parsing", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          baseCreateOptions({
            comment: ["none", "author=a,text=b"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            comment: ["author=comment-author"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("accepts plain-text shorthand for create comment seeds", async () => {
    await withTempPmPath(async (context) => {
      const plainText = await runCreate(
        baseCreateOptions({
          title: "create-comment-plain-text",
          comment: ["plain text create comment shorthand"],
        }),
        { path: context.pmPath },
      );
      expect(plainText.item.comments?.at(0)).toEqual(
        expect.objectContaining({
          author: "seed-author",
          text: "plain text create comment shorthand",
        }),
      );

      const colonText = await runCreate(
        baseCreateOptions({
          title: "create-comment-plain-text-colon",
          comment: ["context: create comment shorthand with colon"],
        }),
        { path: context.pmPath },
      );
      expect(colonText.item.comments?.at(0)).toEqual(
        expect.objectContaining({
          author: "seed-author",
          text: "context: create comment shorthand with colon",
        }),
      );
    });
  });

  it("preserves ambiguous unquoted key-like continuations for log seed text", async () => {
    await withTempPmPath(async (context) => {
      for (const field of ["comment", "note", "learning"] as const) {
        const overrides: Partial<CreateCommandOptions> = {
          title: `create-ambiguous-${field}-seed`,
        };
        overrides[field] = ["author=seed-author,text=hello,scope:project"];
        const result = await runCreate(baseCreateOptions(overrides), { path: context.pmPath });
        const entries = result.item[`${field}s` as "comments" | "notes" | "learnings"];
        expect(entries?.at(0)).toEqual(
          expect.objectContaining({
            author: "seed-author",
            text: "author=seed-author,text=hello,scope:project",
          }),
        );
      }

      const preserved = await runCreate(
        baseCreateOptions({
          title: "create-ambiguous-comment-seed-multiple-keys",
          comment: ["author=seed-author,text=hello,scope:project,priority:1"],
        }),
        { path: context.pmPath },
      );
      expect(preserved.item.comments?.at(0)).toEqual(
        expect.objectContaining({
          author: "seed-author",
          text: "author=seed-author,text=hello,scope:project,priority:1",
        }),
      );
    });
  });

  it("accepts quoted and markdown log seed formats for comment text", async () => {
    await withTempPmPath(async (context) => {
      const quoted = await runCreate(
        baseCreateOptions({
          title: "create-comment-quoted-text",
          comment: ['author=quoted-author,text="hello,scope:project"'],
        }),
        { path: context.pmPath },
      );
      expect(quoted.item.comments?.at(0)).toEqual(
        expect.objectContaining({
          author: "quoted-author",
          text: "hello,scope:project",
        }),
      );

      const markdown = await runCreate(
        baseCreateOptions({
          title: "create-comment-markdown-text",
          comment: ["author: markdown-author\ntext: markdown seeded comment"],
        }),
        { path: context.pmPath },
      );
      expect(markdown.item.comments?.at(0)).toEqual(
        expect.objectContaining({
          author: "markdown-author",
          text: "markdown seeded comment",
        }),
      );
    });
  });

  it("validates linked file, test, and doc seed parsing", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          baseCreateOptions({
            file: ["none", "path=src/cli.ts"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            file: ["scope=project"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            file: ["path=src/cli.ts,scope=invalid"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            test: ["none", "command=node dist/cli.js --version"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            test: ["scope=project"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            test: ["command=node dist/cli.js --version,scope=project,timeout=1,timeout_seconds=2"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            doc: ["none", "path=README.md"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            doc: ["scope=project"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("validates reminder seed parsing", async () => {
    await withTempPmPath(async (context) => {
      const dateTitleAliasResult = await runCreate(
        baseCreateOptions({
          reminder: ["date=2026-03-02T09:00:00.000Z,title=date title alias"],
        }),
        { path: context.pmPath },
      );
      expect(dateTitleAliasResult.item.reminders?.[0]).toMatchObject({
        at: "2026-03-02T09:00:00.000Z",
        text: "date title alias",
      });

      await expect(
        runCreate(
          baseCreateOptions({
            reminder: ["none", "at=2026-03-02T09:00:00.000Z,text=mixed"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            reminder: ["text=missing-at"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            reminder: ["at=+1d,text=   "],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            reminder: ['at=+1d,text="   "'],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            reminder: ["at=+3d+1h,text=compound-relative"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining('Invalid reminder.at value "+3d+1h"'),
      });
      await expect(
        runCreate(
          baseCreateOptions({
            reminder: ["at=+3d+1h,text=compound-relative"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toThrow("Compound relative expressions like +3d+1h are not supported");
    });
  });

  it("validates event seed parsing", async () => {
    await withTempPmPath(async (context) => {
      const dateAliasResult = await runCreate(
        baseCreateOptions({
          event: ["date=2026-03-04T10:00:00.000Z,title=date alias"],
        }),
        { path: context.pmPath },
      );
      expect(dateAliasResult.item.events?.[0]).toMatchObject({
        start_at: "2026-03-04T10:00:00.000Z",
        title: "date alias",
      });

      await expect(
        runCreate(
          baseCreateOptions({
            event: ["none", "start=2026-03-04T10:00:00.000Z,title=mixed"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            event: ["title=missing-start"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            event: ["start=2026-03-04T10:00:00.000Z,end=2026-03-04T09:00:00.000Z"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      const instantEventResult = await runCreate(
        baseCreateOptions({
          event: ["start=2026-03-04T10:00:00.000Z,end=2026-03-04T10:00:00.000Z,title=instant"],
        }),
        { path: context.pmPath },
      );
      expect(instantEventResult.item.events?.[0]).toMatchObject({
        start_at: "2026-03-04T10:00:00.000Z",
        title: "instant",
      });
      expect(instantEventResult.item.events?.[0]?.end_at).toBeUndefined();

      await expect(
        runCreate(
          baseCreateOptions({
            event: ["start=2026-03-04T10:00:00.000Z,title=   "],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            event: ["start=2026-03-04T10:00:00.000Z,description=   "],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            event: ["start=2026-03-04T10:00:00.000Z,location=   "],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            event: ["start=2026-03-04T10:00:00.000Z,timezone=   "],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            event: ["start=2026-03-04T10:00:00.000Z,all_day=maybe"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            event: ["start=2026-03-04T10:00:00.000Z,recur_interval=2"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            event: ["start=2026-03-04T10:00:00.000Z,recur_freq=daily,recur_interval=0"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            event: ["start=2026-03-04T10:00:00.000Z,recur_freq=daily,recur_count=0"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            event: ["start=2026-03-04T10:00:00.000Z,recur_freq=daily,recur_until=2026-03-03T10:00:00.000Z"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            event: ["start=2026-03-04T10:00:00.000Z,recur_freq=monthly,recur_by_month_day=0"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await expect(
        runCreate(
          baseCreateOptions({
            event: ["start=+3d,end=+3d+1h,title=compound-relative"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining('Invalid event.end value "+3d+1h"'),
      });
      await expect(
        runCreate(
          baseCreateOptions({
            event: ["start=+3d,end=+3d+1h,title=compound-relative"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toThrow("Compound relative expressions like +3d+1h are not supported");
    });
  });

  it("treats equal start/end as an instant event and rejects end earlier than start", async () => {
    await withTempPmPath(async (context) => {
      const instant = await runCreate(
        baseCreateOptions({
          event: ["start=2026-03-04T10:00:00.000Z,end=2026-03-04T10:00:00.000Z,title=instant"],
        }),
        { path: context.pmPath },
      );
      expect(instant.item.events?.[0]).toMatchObject({ start_at: "2026-03-04T10:00:00.000Z", title: "instant" });
      expect(instant.item.events?.[0]?.end_at).toBeUndefined();

      await expect(
        runCreate(
          baseCreateOptions({
            event: ["start=2026-03-04T10:00:00.000Z,end=2026-03-04T09:00:00.000Z"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("end must be strictly after start"),
      });
    });
  });

  it("supports duration= to derive event end and rejects end+duration together", async () => {
    await withTempPmPath(async (context) => {
      const withDuration = await runCreate(
        baseCreateOptions({
          event: ["start=2026-03-04T10:00:00.000Z,duration=2h,title=meeting"],
        }),
        { path: context.pmPath },
      );
      expect(withDuration.item.events?.[0]).toMatchObject({
        start_at: "2026-03-04T10:00:00.000Z",
        end_at: "2026-03-04T12:00:00.000Z",
        title: "meeting",
      });

      const withPlusDuration = await runCreate(
        baseCreateOptions({
          event: ["start=2026-03-04T10:00:00.000Z,duration=+1d,title=allhands"],
        }),
        { path: context.pmPath },
      );
      expect(withPlusDuration.item.events?.[0]?.end_at).toBe("2026-03-05T10:00:00.000Z");

      await expect(
        runCreate(
          baseCreateOptions({
            event: ["start=2026-03-04T10:00:00.000Z,end=2026-03-04T11:00:00.000Z,duration=2h"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("mutually exclusive"),
      });

      // A zero-length duration collapses to an instant event, matching equal
      // explicit start/end (no longer rejected).
      const zeroDuration = await runCreate(
        baseCreateOptions({
          event: ["start=2026-03-04T10:00:00.000Z,duration=0h,title=instant"],
        }),
        { path: context.pmPath },
      );
      expect(zeroDuration.item.events?.[0]?.start_at).toBe("2026-03-04T10:00:00.000Z");
      expect(zeroDuration.item.events?.[0]?.end_at).toBeUndefined();
    });
  });

  it("warns when creating an Event item with no attached schedule", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        baseCreateOptions({
          title: "schedule-less-event",
          description: "event with no time set",
          type: "Event",
        }),
        { path: context.pmPath },
      );
      expect(result.warnings).toEqual([`event_without_schedule:${result.item.id}:no_time_set`]);

      const scheduled = await runCreate(
        baseCreateOptions({
          title: "scheduled-event",
          description: "event with a time",
          type: "Event",
          event: ["start=2026-03-04T10:00:00.000Z,title=kickoff"],
        }),
        { path: context.pmPath },
      );
      expect(scheduled.warnings).toEqual([]);
    });
  });

  it("enforces create command_option_policies required and disabled options for custom types", async () => {
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
              { command: "create", option: "message", required: true },
              { command: "create", option: "severity", enabled: false },
              { command: "create", option: "goal", visible: false },
            ],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const missingMessage = baseCreateOptions({
        type: "Asset",
        message: undefined,
      });
      await expect(runCreate(missingMessage, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--message"),
      });

      await expect(
        runCreate(
          baseCreateOptions({
            type: "Asset",
            severity: "high",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--severity"),
      });

      const created = await runCreate(
        baseCreateOptions({
          type: "Asset",
          message: "create asset policy-compliant item",
          severity: undefined,
        }),
        { path: context.pmPath },
      );
      expect(created.item.type).toBe("Asset");
      expect(created.item.severity).toBeUndefined();
    });
  });

  it("aggregates missing required create options into a deterministic usage error", async () => {
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
              { command: "create", option: "message", required: true },
              { command: "create", option: "goal", required: true },
            ],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      await expect(
        runCreate(
          baseCreateOptions({
            type: "Asset",
            message: undefined,
            goal: undefined,
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runCreate(
          baseCreateOptions({
            type: "Asset",
            message: undefined,
            goal: undefined,
          }),
          { path: context.pmPath },
        ),
      ).rejects.toThrow('Missing required options --goal, --message for type "Asset"');
    });
  });

  it("aggregates missing required create and type-option requirements with next valid example guidance", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        item_types?: { definitions?: Array<Record<string, unknown>> };
        governance?: { preset?: string };
      };
      settings.governance = {
        ...(settings.governance ?? {}),
        preset: "strict",
      };
      settings.item_types = {
        definitions: [
          {
            name: "Asset",
            folder: "assets",
            required_create_fields: [],
            required_create_repeatables: [],
            command_option_policies: [{ command: "create", option: "message", required: true }],
            options: [{ key: "category", values: ["feature", "maintenance"], required: true }],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      await expect(
        runCreate(
          baseCreateOptions({
            type: "Asset",
            message: undefined,
            typeOption: undefined,
          }),
          { path: context.pmPath },
        ),
      ).rejects.toThrow('Missing required options --message, --type-option category=<value> for type "Asset"');

      await expect(
        runCreate(
          baseCreateOptions({
            type: "Asset",
            message: undefined,
            typeOption: undefined,
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        context: {
          code: "missing_required_option",
          examples: [expect.stringContaining("--type-option category=feature")],
          nextSteps: expect.arrayContaining([
            expect.stringContaining("pm create --help --type Asset"),
            expect.stringContaining("--create-mode progressive"),
          ]),
        },
      });
    });
  });

  it("rejects create policies that make an option required and disabled", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        item_types?: { definitions?: Array<Record<string, unknown>> };
      };
      settings.item_types = {
        definitions: [
          {
            name: "Asset",
            required_create_fields: [],
            required_create_repeatables: [],
            command_option_policies: [
              { command: "create", option: "message", required: true, enabled: false },
            ],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      await expect(
        runCreate(
          baseCreateOptions({
            type: "Asset",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.CONFLICT });
    });
  });

  it("rejects unsupported create command_option_policies option keys", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        item_types?: { definitions?: Array<Record<string, unknown>> };
      };
      settings.item_types = {
        definitions: [
          {
            name: "Asset",
            required_create_fields: [],
            required_create_repeatables: [],
            command_option_policies: [{ command: "create", option: "not_real_option", required: true }],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      await expect(
        runCreate(
          baseCreateOptions({
            type: "Asset",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
        message: expect.stringContaining("command_option_policies"),
      });
    });
  });

  it("rolls back item write if history append fails", async () => {
    await withTempPmPath(async (context) => {
      const tasksDir = path.join(context.pmPath, "tasks");
      const beforeFiles = await readdir(tasksDir);

      const historyDir = path.join(context.pmPath, "history");
      await rm(historyDir, { recursive: true, force: true });
      await writeFile(historyDir, "not-a-directory", "utf8");

      await expect(
        runCreate(
          baseCreateOptions({
            title: "create-history-failure-rollback",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toBeTruthy();

      const afterFiles = await readdir(tasksDir);
      expect(afterFiles).toEqual(beforeFiles);
    });
  });

  it("accepts colon and markdown formats for type-option entries", async () => {
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

      const colonResult = await runCreate(
        baseCreateOptions({
          title: "create-type-option-colon",
          type: "Asset",
          typeOption: ["category:feature"],
        }),
        { path: context.pmPath },
      );
      expect(colonResult.item.type_options).toEqual({ category: "feature" });

      const markdownResult = await runCreate(
        baseCreateOptions({
          title: "create-type-option-markdown",
          type: "Asset",
          typeOption: ["key: workflow\nvalue: seeded"],
        }),
        { path: context.pmPath },
      );
      expect(markdownResult.item.type_options).toEqual({ workflow: "seeded" });
    });
  });

  it("accepts stdin token for create repeatable seed entries", async () => {
    await withTempPmPath(async (context) => {
      const stdin = new PassThrough();
      stdin.end(["author: stdin-author", "text: stdin seeded comment"].join("\n"));
      Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
      vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream);

      const result = await runCreate(
        baseCreateOptions({
          title: "create-repeatable-stdin",
          comment: ["-"],
        }),
        { path: context.pmPath },
      );
      expect(result.item.comments?.at(0)?.author).toBe("stdin-author");
      expect(result.item.comments?.at(0)?.text).toBe("stdin seeded comment");
    });
  });
});
