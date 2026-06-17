import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _testOnlyCreateCommand, runCreate, type CreateCommandOptions } from "../../../src/cli/commands/create.js";
import { parseTypeOptionEntries } from "../../../src/cli/commands/repeatable-metadata-parsers.js";
import {
  clearActiveExtensionHooks,
  setActiveExtensionCommands,
  setActiveExtensionHooks,
  setActiveExtensionRegistrations,
} from "../../../src/core/extensions/index.js";
import { createEmptyExtensionRegistrationRegistry, type ExtensionHookRegistry } from "../../../src/core/extensions/loader.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import type { TempPmContext } from "../../helpers/withTempPmPath.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

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
    setActiveExtensionCommands(null);
    setActiveExtensionRegistrations(null);
    vi.restoreAllMocks();
  });

  it("covers create command pure normalization tails", () => {
    expect(_testOnlyCreateCommand.normalizeDependencyKindInput(undefined)).toBeUndefined();
    expect(_testOnlyCreateCommand.normalizeDependencyKindInput("depends-on")).toBe("blocked_by");
    expect(_testOnlyCreateCommand.normalizeDependencyKindInput("related")).toBe("related");
    expect(_testOnlyCreateCommand.looksLikeStructuredEntry("```yaml\ntext: hi\n```", ["text"])).toBe(true);
    expect(_testOnlyCreateCommand.looksLikeStructuredEntry("- text: hi", ["text"])).toBe(true);
    expect(_testOnlyCreateCommand.looksLikeStructuredEntry("plain text", ["text"])).toBe(false);
    expect(_testOnlyCreateCommand.buildHistoryMessage(undefined, [])).toBe("");
    expect(_testOnlyCreateCommand.buildHistoryMessage("base", ["deadline", "tags"])).toBe(
      "base | explicit_unset=deadline,tags",
    );
    expect(_testOnlyCreateCommand.buildHistoryMessage(undefined, ["deadline"])).toBe("explicit_unset=deadline");
    expect(_testOnlyCreateCommand.normalizeCreatePolicyOptionKey("acceptance-criteria", "Task", "required_create_fields")).toBe(
      "acceptanceCriteria",
    );
    expect(() =>
      _testOnlyCreateCommand.normalizeCreatePolicyOptionKey("not-real", "Task", "required_create_fields"),
    ).toThrow(PmCliError);
    expect(_testOnlyCreateCommand.createExampleTokensForFlag("--priority", "Task", "open")).toEqual(["--priority", "1"]);
    expect(_testOnlyCreateCommand.createExampleTokensForFlag("--message", "Task", "open")).toEqual([
      "--message",
      '"Create Task item"',
    ]);
  });

  it("rejects unknown keys in dep/file/doc/reminder/event/type-option seeds (GH-258)", async () => {
    await withTempPmPath(async (context) => {
      const seed = (overrides: Partial<CreateCommandOptions>): CreateCommandOptions => ({
        title: "gh258-seed",
        type: "Task",
        author: "seed-author",
        ...overrides,
      });
      const cases: Array<[Partial<CreateCommandOptions>, string]> = [
        [{ dep: ["id=a1b2,kind=related,boguskey=v"] }, '--dep does not recognize key "boguskey". Allowed keys: id, kind, type, author, created_at.'],
        [{ file: ["path=src/cli.ts,boguskey=v"] }, '--file does not recognize key "boguskey". Allowed keys: path, scope, note.'],
        [{ doc: ["path=README.md,boguskey=v"] }, '--doc does not recognize key "boguskey". Allowed keys: path, scope, note.'],
        [{ reminder: ["at=2026-03-02T09:00:00.000Z,text=hi,boguskey=v"] }, '--reminder does not recognize key "boguskey". Allowed keys: at, date, text, title.'],
        [{ event: ["start=2026-03-03T08:00:00.000Z,title=t,boguskey=v"] }, '--event does not recognize key "boguskey". Allowed keys: start, date, end, duration, title, description, location, timezone, all_day, recur_freq, recur_interval, recur_count, recur_until, recur_by_weekday, recur_by_month_day, recur_exdates.'],
        [{ typeOption: ["key=color,value=red,boguskey=v"] }, '--type-option does not recognize key "boguskey". Allowed keys: key, value.'],
      ];
      for (const [overrides, message] of cases) {
        await expect(runCreate(seed(overrides), { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.USAGE,
          message,
        });
      }
      // A FIRST-key typo must not bypass validation by being read as a bare id/path (GH-258).
      await expect(
        runCreate(seed({ dep: ["boguskey=v,id=a1b2,kind=related"] }), { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: '--dep does not recognize key "boguskey". Allowed keys: id, kind, type, author, created_at.',
      });
      await expect(
        runCreate(seed({ file: ["boguskey=v,path=src/cli.ts"] }), { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: '--file does not recognize key "boguskey". Allowed keys: path, scope, note.',
      });

      // Bare (non-structured) forms remain valid and skip key validation.
      const ok = await runCreate(seed({ dep: ["pm-related-1"], file: ["docs/plain.md"], doc: ["docs/guide.md"] }), {
        path: context.pmPath,
      });
      expect(ok.item.files).toEqual([{ path: "docs/plain.md", scope: "project" }]);
      expect(ok.item.docs).toEqual([{ path: "docs/guide.md", scope: "project" }]);
    });
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

  it("applies a custom type's config-driven default_status when --status is omitted", async () => {
    await withTempPmPath(async (context) => {
      // Register a custom type whose config-driven default status is in_progress.
      const added = context.runCli([
        "schema",
        "add-type",
        "Spike",
        "--description",
        "Time-boxed investigation",
        "--default-status",
        "in_progress",
      ]);
      expect(added.code).toBe(0);

      // No --status provided => the type's default_status wins over open_status.
      const defaulted = await runCreate(
        {
          title: "spike-default-status",
          description: "should inherit the type default status",
          type: "Spike",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );
      expect(defaulted.item.status).toBe("in_progress");

      // Explicit --status still overrides the type default.
      const explicit = await runCreate(
        {
          title: "spike-explicit-status",
          description: "explicit status overrides the type default",
          type: "Spike",
          status: "open",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );
      expect(explicit.item.status).toBe("open");

      // An unknown configured default degrades to the open status (never blocks).
      const bogus = context.runCli(["schema", "add-type", "Bogus", "--default-status", "notarealstatus"]);
      expect(bogus.code).toBe(0);
      const degraded = await runCreate(
        {
          title: "bogus-default-status",
          description: "invalid default status falls back to open",
          type: "Bogus",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );
      expect(degraded.item.status).toBe("open");
    });
  });

  it("pm create --add-tags extends --tags additively (pm-1lws)", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        {
          title: "create-add-tags",
          description: "additive tag flag on create",
          type: "Task",
          createMode: "progressive",
          tags: "alpha,beta",
          addTags: ["gamma,delta", "delta"],
        },
        { path: context.pmPath },
      );
      expect(result.warnings).toEqual([]);
      expect(result.item.tags).toEqual(["alpha", "beta", "delta", "gamma"]);
    });
  });

  it("pm create --add-tags works on its own without --tags (pm-1lws)", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        {
          title: "create-add-tags-only",
          description: "additive tag flag works standalone",
          type: "Task",
          createMode: "progressive",
          addTags: ["alpha,beta"],
        },
        { path: context.pmPath },
      );
      expect(result.warnings).toEqual([]);
      expect(result.item.tags).toEqual(["alpha", "beta"]);
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

  it("rejects empty template names before runtime template lookup", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          baseCreateOptions({
            title: "create-empty-template",
            template: "   ",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--template must not be empty"),
      });
    });
  });

  it("keeps strict missing title and type guidance explicit", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          {
            description: "strict missing title should mention positional title",
            type: "Task",
            createMode: "strict",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        context: {
          nextSteps: expect.arrayContaining([expect.stringContaining("Title can also be passed as the first positional")]),
        },
      });

      await expect(
        runCreate(
          {
            title: "strict-missing-type",
            description: "strict missing type should not silently default",
            createMode: "strict",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--type"),
      });
    });
  });

  it("accepts type as a structured --dep kind alias", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        baseCreateOptions({
          title: "create-dependency-type-alias",
          dep: ["type=blocked-by,id=dep-blocker,created_at=2026-03-01T00:00:00.000Z"],
        }),
        { path: context.pmPath },
      );

      expect(result.item.dependencies).toEqual([
        {
          id: "pm-dep-blocker",
          kind: "blocked_by",
          created_at: "2026-03-01T00:00:00.000Z",
        },
      ]);
    });
  });

  it("rejects incomplete structured dependencies with missing kind", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          baseCreateOptions({
            title: "create-structured-dep-missing-kind",
            dep: ["id=dep-without-kind"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--dep requires id and kind"),
      });
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

      await expect(
        runCreate(
          {
            title: "empty-schedule-preset",
            description: "Empty preset should fail fast",
            type: "Reminder",
            schedulePreset: " ",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--schedule-preset must not be empty"),
      });

      await expect(
        runCreate(
          {
            title: "unknown-schedule-preset",
            description: "Unknown preset should report allowed values",
            type: "Reminder",
            schedulePreset: "heavy",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Invalid --schedule-preset value"),
      });
    });
  });

  it("rejects unsupported create mode values", async () => {
    await withTempPmPath(async (context) => {
      const blankMode = await runCreate(
        {
          title: "blank-create-mode",
          description: "blank explicit create mode falls back to defaults",
          type: "Task",
          createMode: " ",
        },
        { path: context.pmPath },
      );
      expect(blankMode.item.status).toBe("open");

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

  it("rejects missing parent references by default", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          baseCreateOptions({
            parent: "pm-parent-missing-default",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("allows missing parent references only with the explicit escape hatch", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        baseCreateOptions({
          parent: "pm-parent-missing-default",
          allowMissingParent: true,
        }),
        { path: context.pmPath },
      );

      expect(result.item.parent).toBe("pm-parent-missing-default");
      expect(result.warnings).toEqual(
        expect.arrayContaining(["validation_warning:parent_reference_missing:pm-parent-missing-default"]),
      );
    });
  });

  it("allows missing parent references with the explicit escape hatch under strict policy", async () => {
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

      const result = await runCreate(
        baseCreateOptions({
          parent: "pm-parent-missing-strict",
          allowMissingParent: true,
        }),
        { path: context.pmPath },
      );

      expect(result.item.parent).toBe("pm-parent-missing-strict");
      expect(result.warnings).toEqual(
        expect.arrayContaining(["validation_warning:parent_reference_missing:pm-parent-missing-strict"]),
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
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "--reminder text must not be empty",
      });

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
            event: ["start=2026-03-04T10:00:00.000Z,all_day="],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--event all_day must be one of true|false|1|0|yes|no"),
      });

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
            event: ["start=2026-03-04T10:00:00.000Z,recur_freq=daily,recur_interval="],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--event recur_interval must be an integer >= 1"),
      });

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

  it("keeps the calendar_item_without_schedule prefix stable and appends an actionable hint", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        baseCreateOptions({
          title: "schedule-less-milestone",
          description: "milestone with no schedule",
          type: "Milestone",
          deadline: undefined,
        }),
        { path: context.pmPath },
      );
      expect(result.warnings).toHaveLength(1);
      const warning = result.warnings[0]!;
      // Structured token must stay the prefix — automation/telemetry match on it.
      expect(
        warning.startsWith(`calendar_item_without_schedule:${result.item.id}:no_deadline_or_reminder_or_event`),
      ).toBe(true);
      // The appended hint names every way to attach a schedule (pm-2cgu / GH-174).
      expect(warning).toContain("--deadline");
      expect(warning).toContain("--reminder");
      expect(warning).toContain("--event");
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

  it("lets a default_status satisfy a required create status policy", async () => {
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
            default_status: "in_progress",
            required_create_fields: [],
            required_create_repeatables: [],
            command_option_policies: [{ command: "create", option: "status", required: true }],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const created = await runCreate(
        baseCreateOptions({
          title: "create-default-status-policy",
          type: "Asset",
          status: undefined,
        }),
        { path: context.pmPath },
      );

      expect(created.item.status).toBe("in_progress");
    });
  });

  it("counts --add-tags toward a tags command_option_policy (pm-1lws)", async () => {
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
            command_option_policies: [{ command: "create", option: "tags", enabled: false }],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      // --add-tags must not bypass a policy that disables the tags option.
      await expect(
        runCreate(baseCreateOptions({ type: "Asset", tags: undefined, addTags: ["sneaky"] }), { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--tags"),
      });
    });
  });

  it("rejects combining --unset tags with --add-tags on create (pm-1lws)", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(baseCreateOptions({ tags: undefined, unset: ["tags"], addTags: ["x"] }), { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Cannot combine --unset tags with --add-tags"),
      });
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

  it("uses a built-in type synonym when the requested type is absent", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        baseCreateOptions({
          title: "create-bug-synonym",
          type: "Bug",
        }),
        { path: context.pmPath },
      );

      expect(result.item.type).toBe("Issue");
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

      await expect(
        runCreate(
          baseCreateOptions({
            title: "create-type-option-invalid-value",
            type: "Asset",
            typeOption: ["category=invalid"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        context: {
          code: "invalid_argument_value",
          examples: [expect.stringContaining("pm create")],
          nextSteps: [expect.stringContaining("pm create --help --type Asset")],
        },
      });
    });
  });

  it("sets declared extension item fields through repeatable --field values", async () => {
    await withTempPmPath(async (context) => {
      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.item_fields.push({
        layer: "project",
        name: "github-importer",
        fields: [
          { name: "github_url", type: "string" },
          { name: "github_number", type: "number" },
          { name: "github_synced", type: "boolean" },
        ],
      });
      setActiveExtensionRegistrations(registrations);

      const result = await runCreate(
        baseCreateOptions({
          title: "create-extension-field-values",
          field: ["github_url=https://example.test/1", "github_number=42", "github_synced=true"],
        }),
        { path: context.pmPath },
      );

      expect(result.item.github_url).toBe("https://example.test/1");
      expect(result.item.github_number).toBe(42);
      expect(result.item.github_synced).toBe(true);
      expect(result.changed_fields).toEqual(expect.arrayContaining(["github_url", "github_number", "github_synced"]));
    });
  });

  it("rejects unset conflicts with declared extension item fields on create", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        schema?: { fields?: Array<Record<string, unknown>> };
      };
      settings.schema = {
        ...(settings.schema ?? {}),
        fields: [
          {
            key: "githubUrl",
            metadata_key: "github_url",
            type: "string",
            cli_flag: "github-url",
            commands: ["create"],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.item_fields.push({
        layer: "project",
        name: "github-importer",
        fields: [{ name: "github_url", type: "string" }],
      });
      setActiveExtensionRegistrations(registrations);

      await expect(
        runCreate(
          baseCreateOptions({
            title: "create-extension-field-unset-conflict",
            unset: ["github-url"],
            field: ["github_url=https://example.test/conflict"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Cannot combine --unset github-url with --field github_url=..."),
      });
    });
  });

  it("surfaces extension item-field validation failures as usage errors on create", async () => {
    await withTempPmPath(async (context) => {
      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.item_fields.push({
        layer: "project",
        name: "github-importer",
        fields: [{ name: "github_number", type: "number", default: "not-a-number" }],
      });
      setActiveExtensionRegistrations(registrations);

      await expect(
        runCreate(
          baseCreateOptions({
            title: "create-extension-field-invalid-default",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("github_number"),
      });
    });
  });

  it("rejects unset conflicts with runtime schema fields", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        schema?: { fields?: Array<Record<string, unknown>> };
      };
      settings.schema = {
        ...(settings.schema ?? {}),
        fields: [
          {
            key: "reviewUrl",
            metadata_key: "review_url",
            type: "string",
            cli_flag: "review-url",
            commands: ["create"],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      await expect(
        runCreate(
          baseCreateOptions({
            title: "create-runtime-field-unset-conflict",
            unset: ["review-url"],
            reviewUrl: "https://example.test/review",
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Cannot combine --unset review-url with its value flag"),
      });
    });
  });

  it("allows declared extension item fields when strict schema rejects unknown fields", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        schema?: { unknown_field_policy?: string };
      };
      settings.schema = {
        ...(settings.schema ?? {}),
        unknown_field_policy: "reject",
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.item_fields.push({
        layer: "project",
        name: "github-importer",
        fields: [{ name: "github_url", type: "string" }],
      });
      setActiveExtensionRegistrations(registrations);

      const result = await runCreate(
        baseCreateOptions({
          title: "create-extension-field-strict-schema",
          field: ["github_url=https://example.test/strict"],
        }),
        { path: context.pmPath },
      );

      expect(result.item.github_url).toBe("https://example.test/strict");
    });
  });

  it("enforces command_option_policies for the extension --field setter on create", async () => {
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
            command_option_policies: [{ command: "create", option: "field", required: true }],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.item_fields.push({
        layer: "project",
        name: "github-importer",
        fields: [{ name: "github_url", type: "string" }],
      });
      setActiveExtensionRegistrations(registrations);

      await expect(
        runCreate(baseCreateOptions({ type: "Asset", field: undefined }), { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--field"),
      });

      const created = await runCreate(
        baseCreateOptions({
          type: "Asset",
          field: ["github_url=https://example.test/policy"],
        }),
        { path: context.pmPath },
      );
      expect(created.item.github_url).toBe("https://example.test/policy");
    });
  });

  it("rejects undeclared extension item fields on create", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          baseCreateOptions({
            title: "create-unknown-extension-field",
            field: ["github_url=https://example.test/1"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        context: { code: "extension_item_field_unknown" },
      });
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

describe("create command helper coverage", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
    setActiveExtensionCommands(null);
    setActiveExtensionRegistrations(null);
    vi.restoreAllMocks();
  });

  it("formats invalid log seed key guidance for singular and plural keys", () => {
    expect(_testOnlyCreateCommand.buildInvalidLogSeedKeysMessage("--comment", ["scope"])).toContain(
      "Found unsupported key: scope",
    );
    expect(_testOnlyCreateCommand.buildInvalidLogSeedKeysMessage("--note", ["zeta", "alpha"])).toContain(
      "Found unsupported keys: alpha, zeta",
    );
  });

  it("resolves runtime unset aliases and rejects unsupported create unset tokens", () => {
    const registry = {
      definitions: [
        {
          key: "githubUrl",
          metadata_key: "github_url",
          cli_flag: "github-url",
          cli_aliases: ["gh-url"],
        },
        {
          key: "hidden",
          metadata_key: "hidden",
          cli_flag: "hidden",
          cli_aliases: [],
          allow_unset: false,
        },
      ],
    };

    expect(_testOnlyCreateCommand.resolveRuntimeCreateUnsetDefinition("anything", undefined)).toBeUndefined();
    expect(_testOnlyCreateCommand.resolveRuntimeCreateUnsetDefinition("gh_url", registry)).toEqual({
      optionKey: "githubUrl",
      frontMatterKey: "github_url",
    });
    expect(_testOnlyCreateCommand.resolveRuntimeCreateUnsetDefinition("hidden", registry)).toBeUndefined();
    const parsed = _testOnlyCreateCommand.parseCreateUnsetTargets(["deadline", "gh-url"], registry);
    expect([...parsed.frontMatterKeys].sort()).toEqual(["deadline", "github_url"]);
    expect([...parsed.optionKeys].sort()).toEqual(["deadline", "githubUrl"]);
    expect(() => _testOnlyCreateCommand.parseCreateUnsetTargets(["   "], registry)).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );
    expect(() => _testOnlyCreateCommand.parseCreateUnsetTargets(["none"], registry)).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );
    expect(() => _testOnlyCreateCommand.parseCreateUnsetTargets(["missing"], registry)).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );
  });

  it("normalizes legacy none create tokens into explicit clears and rejects mixed collection entries", async () => {
    await withTempPmPath(async (context) => {
      const created = await runCreate(
        baseCreateOptions({
          title: "create-legacy-none-scalars",
          tags: "none",
          deadline: "none",
          comment: ["none"],
          test: ["null"],
          doc: ["none"],
        }),
        { path: context.pmPath },
      );
      expect(created.item.tags).toEqual([]);
      expect(created.item.deadline).toBeUndefined();
      expect(created.item.comments).toBeUndefined();
      expect(created.item.tests).toBeUndefined();
      expect(created.item.docs).toBeUndefined();
      expect(created.changed_fields).toEqual(
        expect.arrayContaining(["unset:tags", "unset:deadline", "unset:comments", "unset:tests", "unset:docs"]),
      );
      const history = readCreateHistory(context, created.item.id);
      const createEntry = [...history].reverse().find((entry) => entry.op === "create");
      expect(createEntry?.message).toContain("explicit_unset=");

      await expect(
        runCreate(
          baseCreateOptions({
            title: "create-mixed-legacy-none",
            comment: ["none", "text=concrete"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Cannot mix legacy clear token"),
      });
    });
  });

  it("suppresses duplicate explicit unsets when rank legacy-none and unset overlap", async () => {
    await withTempPmPath(async (context) => {
      const created = await runCreate(
        baseCreateOptions({
          title: "create-legacy-none-rank-duplicate-unset",
          unset: ["order"],
          rank: "none",
        }),
        { path: context.pmPath },
      );
      const history = readCreateHistory(context, created.item.id);
      const createEntry = [...history].reverse().find((entry) => entry.op === "create");
      const explicitSuffix = (createEntry?.message ?? "").split("explicit_unset=")[1] ?? "";
      const explicitTokens = explicitSuffix
        .split(",")
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
      expect(explicitTokens.filter((token) => token === "order")).toHaveLength(1);
    });
  });

  it("falls back to scalar option keys when canonical unset lookup returns undefined", async () => {
    await withTempPmPath(async (context) => {
      const originalMapGet = Map.prototype.get;
      const mapGetSpy = vi.spyOn(Map.prototype, "get").mockImplementation(function (
        this: Map<unknown, unknown>,
        key: unknown,
      ) {
        const resolved = originalMapGet.call(this, key);
        if (key === "tags" && resolved === "tags") {
          return undefined;
        }
        return resolved;
      });
      try {
        const created = await runCreate(
          baseCreateOptions({
            title: "create-legacy-none-canonical-fallback",
            tags: "none",
          }),
          { path: context.pmPath },
        );
        expect(created.changed_fields).toContain("unset:tags");
      } finally {
        mapGetSpy.mockRestore();
      }
    });
  });

  it("reads template options from runtime payloads and rejects invalid payload shapes", () => {
    expect(
      _testOnlyCreateCommand.readTemplateOptionsFromRuntimeResult(
        { options: { title: "From template", tags: ["alpha", "beta"] } },
        "sample",
      ),
    ).toEqual({ title: "From template", tags: ["alpha", "beta"] });

    for (const payload of [null, {}, { options: null }, { options: [] }, { options: { tags: ["ok", 1] } }]) {
      expect(() => _testOnlyCreateCommand.readTemplateOptionsFromRuntimeResult(payload, "sample")).toThrow(
        expect.objectContaining({ exitCode: EXIT_CODE.GENERIC_FAILURE }),
      );
    }
  });

  it("rejects template usage when no templates show handler is active", async () => {
    await expect(
      _testOnlyCreateCommand.loadCreateTemplateOptionsFromRuntime("sample", { path: "/tmp/pm-root" }, "/tmp/pm-root"),
    ).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.USAGE,
      message: expect.stringContaining("--template requires the templates package"),
    });
  });

  it("builds type-aware missing-option examples and filters type-option validation errors", () => {
    const errors = [
      'Missing required type option "impact" for type "Issue"',
      'Missing required type option "severity" for type "Issue"',
      'Missing required type option "impact" for type "Issue"',
      'Missing required type option "scope" for type "Task"',
      "Invalid type option priority for type Issue",
    ];
    expect(_testOnlyCreateCommand.collectMissingRequiredTypeOptionKeys(errors, "Issue")).toEqual(["impact", "severity"]);
    expect(_testOnlyCreateCommand.filterNonMissingTypeOptionErrors(errors, "Issue")).toEqual([
      'Missing required type option "scope" for type "Task"',
      "Invalid type option priority for type Issue",
    ]);

    const typeDefinition = {
      name: "Issue",
      options: [
        { key: "impact", values: ["high"] },
        { key: "severity", values: [] },
      ],
    };
    expect(_testOnlyCreateCommand.typeOptionExampleValue(typeDefinition as never, "impact")).toBe("high");
    expect(_testOnlyCreateCommand.typeOptionExampleValue(typeDefinition as never, "severity")).toBe("<value>");
    expect(_testOnlyCreateCommand.createExampleTokensForFlag("--comment", "Issue", "open")).toEqual([
      "--comment",
      "\"author=maintainer,created_at=now,text=Implementation context\"",
    ]);
    expect(_testOnlyCreateCommand.createExampleTokensForFlag("--title", "Issue", "open")).toEqual([
      "--title",
      "\"Issue example title\"",
    ]);
    expect(_testOnlyCreateCommand.createExampleTokensForFlag("--description", "Issue", "open")).toEqual([
      "--description",
      "\"Issue example description\"",
    ]);
    expect(_testOnlyCreateCommand.createExampleTokensForFlag("--type", "Issue", "open")).toEqual(["--type", "Issue"]);
    expect(_testOnlyCreateCommand.createExampleTokensForFlag("--custom", "Issue", "open")).toEqual(["--custom", "\"<value>\""]);
    expect(
      _testOnlyCreateCommand.buildTypeSpecificCreateExample(
        typeDefinition as never,
        ["--priority", "--comment", "--status", "--title"],
        ["impact", "severity"],
        "triage",
      ),
    ).toContain("--type-option impact=high --type-option severity=<value>");
  });

  it("throws specific create required-option errors", () => {
    expect(() => _testOnlyCreateCommand.requireStringOption(undefined, "--title")).toThrow(
      expect.objectContaining({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("human-readable title"),
      }),
    );
    expect(() => _testOnlyCreateCommand.requireStringOption(undefined, "--description")).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE, message: "Missing required option --description" }),
    );
    expect(_testOnlyCreateCommand.requireStringOption("value", "--description")).toBe("value");
  });

  it("normalizes template command paths and merges explicit create options over templates", () => {
    expect(_testOnlyCreateCommand.normalizeExtensionCommandPath("  Templates   SHOW ")).toBe("templates show");
    const merged = _testOnlyCreateCommand.mergeCreateOptionsWithTemplate(
      { title: "template title", tags: ["template"], description: "template description" },
      { title: "explicit title", tags: ["explicit"] },
    );
    expect(merged).toMatchObject({
      title: "explicit title",
      description: "template description",
      tags: ["explicit"],
    });
    expect(merged.tags).not.toBe(["template"]);
  });

  it("detects active templates show handlers by action or normalized command path", () => {
    setActiveExtensionRegistrations(null);
    expect(_testOnlyCreateCommand.hasTemplatesShowHandler()).toBe(false);
    setActiveExtensionRegistrations({
      commands: [{ layer: "project", name: "templates", command: "anything", action: "templates-show" }],
      flags: [],
      hooks: [],
      importers: [],
      exporters: [],
      item_fields: [],
      item_types: [],
    });
    expect(_testOnlyCreateCommand.hasTemplatesShowHandler()).toBe(true);
    setActiveExtensionRegistrations({
      commands: [{ layer: "project", name: "templates", command: "  Templates   Show ", action: "custom-action" }],
      flags: [],
      hooks: [],
      importers: [],
      exporters: [],
      item_fields: [],
      item_types: [],
    });
    expect(_testOnlyCreateCommand.hasTemplatesShowHandler()).toBe(true);
  });

  it("surfaces templates package handler warnings when template resolution is unhandled", async () => {
    setActiveExtensionRegistrations({
      commands: [{ layer: "project", name: "templates", command: "templates show", action: "templates-show" }],
      flags: [],
      hooks: [],
      importers: [],
      exporters: [],
      item_fields: [],
      item_types: [],
    });
    setActiveExtensionCommands({
      overrides: [],
      handlers: [
        {
          layer: "project",
          name: "templates",
          command: "templates show",
          run: () => {
            throw new Error("template missing");
          },
        },
      ],
    });

    await expect(
      _testOnlyCreateCommand.loadCreateTemplateOptionsFromRuntime(
        "sample",
        { path: "/tmp/pm-root" },
        "/tmp/pm-root",
      ),
    ).rejects.toMatchObject<PmCliError>({
      exitCode: EXIT_CODE.USAGE,
      message: expect.stringContaining("extension_command_handler_failed:project:templates:templates show"),
    });
  });
});

describe("runCreate c8-exposed coverage gaps (pm-eifq)", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
    setActiveExtensionCommands(null);
    setActiveExtensionRegistrations(null);
    vi.restoreAllMocks();
  });

  it("accepts plain-text comment/note/learning seeds that are not key=value structured", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        baseCreateOptions({
          title: "create-plaintext-log-seeds",
          comment: ["just a plain comment without kv"],
          note: ["just a plain note"],
          learning: ["just a plain learning"],
        }),
        { path: context.pmPath },
      );
      expect(result.item.comments?.at(0)?.text).toBe("just a plain comment without kv");
      expect(result.item.notes?.at(0)?.text).toBe("just a plain note");
      expect(result.item.learnings?.at(0)?.text).toBe("just a plain learning");
    });
  });

  it("falls back to the configured governance default type when --type is omitted", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        governance?: { create_default_type?: string };
      };
      settings.governance = {
        ...(settings.governance ?? {}),
        create_default_type: "Feature",
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const result = await runCreate(
        {
          title: "create-default-type-from-governance",
          description: "governance default type fallback",
          type: undefined,
          createMode: "progressive",
        },
        { path: context.pmPath },
      );
      expect(result.item.type).toBe("Feature");
    });
  });

  it("falls back to the built-in Task type when no governance default is configured", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        {
          title: "create-default-task-fallback",
          description: "Task fallback when --type omitted",
          type: undefined,
          createMode: "progressive",
        },
        { path: context.pmPath },
      );
      expect(result.item.type).toBe("Task");
    });
  });

  it("suppresses the default-type fallback under explicit strict mode and demands --type", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          {
            title: "create-strict-no-type",
            description: "explicit strict mode skips default-type fallback",
            type: undefined,
            createMode: "strict",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--type"),
      });
    });
  });

  it("creates with an empty description when --description is omitted", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        {
          title: "create-no-description",
          type: "Task",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );
      expect(result.item.description).toBe("");
    });
  });

  it("rejects strict create when a required option is targeted by --unset", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        item_types?: { definitions?: Array<Record<string, unknown>> };
      };
      settings.item_types = {
        definitions: [
          {
            name: "Task",
            folder: "tasks",
            command_option_policies: [
              { command: "create", option: "assignee", required: true },
              { command: "create", option: "reviewer", required: true },
            ],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      await expect(
        runCreate(
          {
            title: "create-strict-required-clear",
            description: "strict required clear conflict",
            type: "Task",
            createMode: "strict",
            assignee: undefined,
            reviewer: undefined,
            unset: ["assignee", "reviewer"],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Strict create mode requires concrete values"),
      });
    });
  });

  it("rejects combining a repeatable clear flag with its value flag", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          baseCreateOptions({
            title: "create-clear-deps-conflict",
            clearDeps: true,
            dep: ["id=a1b2,kind=related"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Cannot combine --clear-deps with --dep"),
      });
    });
  });

  it("rejects combining --unset for a scalar field with that field's value flag", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runCreate(
          baseCreateOptions({
            title: "create-scalar-unset-conflict",
            deadline: "2026-03-01T00:00:00.000Z",
            unset: ["deadline"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Cannot combine --unset deadline"),
      });
    });
  });

  it("persists runtime schema field values into the created item", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        schema?: { fields?: Array<Record<string, unknown>> };
      };
      settings.schema = {
        ...(settings.schema ?? {}),
        fields: [
          {
            key: "reviewUrl",
            metadata_key: "review_url",
            type: "string",
            cli_flag: "review-url",
            commands: ["create"],
          },
        ],
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const result = await runCreate(
        baseCreateOptions({
          title: "create-runtime-field-value",
          reviewUrl: "https://example.test/runtime",
        } as Partial<CreateCommandOptions>),
        { path: context.pmPath },
      );
      expect((result.item as Record<string, unknown>).review_url).toBe("https://example.test/runtime");
      expect(result.changed_fields).toEqual(expect.arrayContaining(["review_url"]));
    });
  });

  it("surfaces extension item-field allowed-value validation failures as usage errors", async () => {
    await withTempPmPath(async (context) => {
      const registrations = createEmptyExtensionRegistrationRegistry();
      registrations.item_fields.push({
        layer: "project",
        name: "enum-importer",
        fields: [{ name: "github_stage", type: "string", values: ["alpha", "beta"] }],
      });
      setActiveExtensionRegistrations(registrations);

      await expect(
        runCreate(
          baseCreateOptions({
            title: "create-extension-field-bad-enum",
            field: ["github_stage=gamma"],
          }),
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("github_stage"),
      });
    });
  });

  it("reports an unresolved template (without warnings) when no handler matches", async () => {
    await withTempPmPath(async (context) => {
      setActiveExtensionRegistrations({
        commands: [{ layer: "project", name: "templates", command: "templates show", action: "templates-show" }],
        flags: [],
        hooks: [],
        importers: [],
        exporters: [],
        item_fields: [],
        item_types: [],
      });
      // hasTemplatesShowHandler() is true via the registration above, but no command
      // handler matches "templates show" => handled:false with empty warnings.
      setActiveExtensionCommands({ overrides: [], handlers: [] });

      await expect(
        runCreate(
          {
            title: "create-template-unresolved",
            type: "Task",
            createMode: "progressive",
            template: "missing-template",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining('Unable to resolve template "missing-template"'),
      });
    });
  });

  it("merges template options resolved from an active templates show handler", async () => {
    await withTempPmPath(async (context) => {
      setActiveExtensionRegistrations({
        commands: [{ layer: "project", name: "templates", command: "templates show", action: "templates-show" }],
        flags: [],
        hooks: [],
        importers: [],
        exporters: [],
        item_fields: [],
        item_types: [],
      });
      setActiveExtensionCommands({
        overrides: [],
        handlers: [
          {
            layer: "project",
            name: "templates",
            command: "templates show",
            run: () => ({ options: { description: "from template", tags: "template-tag" } }),
          },
        ],
      });

      const result = await runCreate(
        {
          title: "create-from-template",
          type: "Task",
          createMode: "progressive",
          template: "bug-report",
        },
        { path: context.pmPath },
      );
      expect(result.item.description).toBe("from template");
      expect(result.item.tags).toEqual(["template-tag"]);
    });
  });

  it("derives a non-default blocked status when blocking a located dependency", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        schema?: { statuses?: Array<Record<string, unknown>> };
      };
      const customStatuses = [
        { id: "open", roles: ["default_open", "active"] },
        { id: "waiting", roles: ["blocked"] },
        { id: "stalled", roles: ["blocked"] },
        { id: "closed", roles: ["terminal", "terminal_done", "default_close"] },
      ];
      settings.schema = {
        ...(settings.schema ?? {}),
        statuses: customStatuses,
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      // The file-backed status set is merged into the runtime registry, so it must
      // also omit the built-in "blocked" id for the non-default blocked-status path.
      await writeFile(
        path.join(context.pmPath, "schema", "statuses.json"),
        `${JSON.stringify({ statuses: customStatuses }, null, 2)}\n`,
        "utf8",
      );

      const blocker = await runCreate(
        {
          title: "create-blocker-target",
          description: "blocking target",
          type: "Task",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );

      const blocked = await runCreate(
        {
          title: "create-blocked-derived-status",
          description: "blocked-by derives the non-default blocked status",
          type: "Task",
          createMode: "progressive",
          blockedBy: blocker.item.id,
        },
        { path: context.pmPath },
      );
      // Two blocked-role statuses with no "blocked" id force the sorted-first fallback ("stalled" < "waiting").
      expect(blocked.item.status).toBe("stalled");
      expect(blocked.item.dependencies?.some((dep) => dep.kind === "blocked_by")).toBe(true);
    });
  });

  it("degrades to the open status when blocking with no blocked-role statuses configured", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        schema?: { statuses?: Array<Record<string, unknown>> };
      };
      const noBlockedStatuses = [
        { id: "open", roles: ["default_open", "active"] },
        { id: "closed", roles: ["terminal", "terminal_done", "default_close"] },
      ];
      settings.schema = {
        ...(settings.schema ?? {}),
        statuses: noBlockedStatuses,
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      await writeFile(
        path.join(context.pmPath, "schema", "statuses.json"),
        `${JSON.stringify({ statuses: noBlockedStatuses }, null, 2)}\n`,
        "utf8",
      );

      const blocker = await runCreate(
        {
          title: "create-no-blocked-blocker",
          description: "blocking target without blocked statuses",
          type: "Task",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );

      const blocked = await runCreate(
        {
          title: "create-no-blocked-derived",
          description: "blocked-by with no blocked statuses degrades to open",
          type: "Task",
          createMode: "progressive",
          blockedBy: blocker.item.id,
        },
        { path: context.pmPath },
      );
      // No blocked-role status exists, so the sorted-first lookup is undefined and falls back to open_status.
      expect(blocked.item.status).toBe("open");
      expect(blocked.item.dependencies?.some((dep) => dep.kind === "blocked_by")).toBe(true);
    });
  });
});

describe("repeatable metadata parser helpers", () => {
  it("parses type-option entries from compact, colon, and structured forms", () => {
    expect(
      parseTypeOptionEntries([
        "category=checkout",
        "impact: high",
        "key=owner,value=agent-team",
      ]),
    ).toEqual({
      category: "checkout",
      impact: "high",
      owner: "agent-team",
    });
  });

  it("rejects empty or incomplete type-option entries with usage errors", () => {
    for (const entry of ["   ", "missing-separator", "key=owner,value="]) {
      expect(() => parseTypeOptionEntries([entry])).toThrow(expect.objectContaining({ exitCode: EXIT_CODE.USAGE }));
    }
  });

  describe("GH-249: create --status closed honors governance.require_close_reason", () => {
    it("defaults the close reason and warns when no message/resolution is supplied", async () => {
      await withTempPmPath(async (context) => {
        const result = await runCreate(
          {
            title: "direct-closed-default",
            description: "created directly closed without a reason",
            type: "Task",
            status: "closed",
            createMode: "progressive",
          },
          { path: context.pmPath },
        );
        expect(result.item.status).toBe("closed");
        expect(result.item.close_reason).toBe("Closed at creation via pm create");
        expect(result.warnings).toContain("close_reason_defaulted");
      });
    });

    it("uses --message as the close reason without warning", async () => {
      await withTempPmPath(async (context) => {
        const result = await runCreate(
          {
            title: "direct-closed-message",
            description: "created directly closed with a message",
            type: "Task",
            status: "closed",
            message: "shipped in the previous sprint",
            createMode: "progressive",
          },
          { path: context.pmPath },
        );
        expect(result.item.close_reason).toBe("shipped in the previous sprint");
        expect(result.warnings).not.toContain("close_reason_defaulted");
      });
    });

    it("falls back to --resolution as the close reason when no message is given", async () => {
      await withTempPmPath(async (context) => {
        const result = await runCreate(
          {
            title: "direct-closed-resolution",
            description: "created directly closed with a resolution",
            type: "Task",
            status: "closed",
            resolution: "resolved by an upstream fix",
            createMode: "progressive",
          },
          { path: context.pmPath },
        );
        expect(result.item.close_reason).toBe("resolved by an upstream fix");
        expect(result.warnings).not.toContain("close_reason_defaulted");
      });
    });

    it("prefers --message over --resolution when both are provided", async () => {
      await withTempPmPath(async (context) => {
        const result = await runCreate(
          {
            title: "direct-closed-message-precedence",
            description: "message should win over resolution",
            type: "Task",
            status: "closed",
            message: "message wins",
            resolution: "resolution should not win",
            createMode: "progressive",
          },
          { path: context.pmPath },
        );
        expect(result.item.close_reason).toBe("message wins");
        expect(result.warnings).not.toContain("close_reason_defaulted");
      });
    });

    it("records no close reason when governance.require_close_reason is disabled", async () => {
      await withTempPmPath(async (context) => {
        const settingsPath = path.join(context.pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
          governance?: Record<string, unknown>;
        };
        settings.governance = { ...(settings.governance ?? {}), require_close_reason: false };
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const result = await runCreate(
          {
            title: "direct-closed-no-governance",
            description: "closed create with governance disabled records no reason",
            type: "Task",
            status: "closed",
            createMode: "progressive",
          },
          { path: context.pmPath },
        );
        expect(result.item.status).toBe("closed");
        expect(result.item.close_reason).toBeUndefined();
        expect(result.warnings).not.toContain("close_reason_defaulted");
      });
    });
  });
});
