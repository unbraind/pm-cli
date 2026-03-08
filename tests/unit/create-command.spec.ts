import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCreate, type CreateCommandOptions } from "../../src/cli/commands/create.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks } from "../../src/core/extensions/index.js";
import type { ExtensionHookRegistry } from "../../src/core/extensions/loader.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
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
    file: ["path=src/cli.ts,scope=project,note=entrypoint"],
    test: [
      "command=node scripts/run-tests.mjs test,path=tests/unit/create-command.spec.ts,scope=project,timeout=120,timeout_seconds=120,note=create-coverage",
    ],
    doc: ["path=README.md,scope=project,note=contract"],
    ...overrides,
  };
}

function readCreateHistory(context: TempPmContext, id: string): Array<{ op: string; author: string; message?: string }> {
  const history = context.runCli(["history", id, "--json"], { expectJson: true });
  expect(history.code).toBe(0);
  return (history.json as { history: Array<{ op: string; author: string; message?: string }> }).history;
}

describe("runCreate", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
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

  it("creates an item with normalized fields and deterministic history metadata", async () => {
    await withTempPmPath(async (context) => {
      const result = await runCreate(
        baseCreateOptions({
          parent: "pm-parent-seed",
          reviewer: "reviewer-seed",
          risk: "med",
          confidence: "med",
          sprint: "sprint-42",
          release: "release-2026.03",
          blockedBy: "pm-blocked-seed",
          blockedReason: "waiting on dependency seed",
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
          "body",
        ]),
      );

      expect(result.item.id).toMatch(/^pm-/);
      expect(result.item.type).toBe("Task");
      expect(result.item.status).toBe("open");
      expect(result.item.priority).toBe(1);
      expect(result.item.tags).toEqual(["alpha", "gamma"]);
      expect(result.item.author).toBe("seed-author");
      expect(result.item.parent).toBe("pm-parent-seed");
      expect(result.item.reviewer).toBe("reviewer-seed");
      expect(result.item.risk).toBe("medium");
      expect(result.item.confidence).toBe("medium");
      expect(result.item.sprint).toBe("sprint-42");
      expect(result.item.release).toBe("release-2026.03");
      expect(result.item.blocked_by).toBe("pm-blocked-seed");
      expect(result.item.blocked_reason).toBe("waiting on dependency seed");
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
        `create:${result.item.id}.md`,
        `create:history:${result.item.id}.jsonl`,
        `lock:release:${result.item.id}.lock`,
      ]);
      expect(result.warnings).toEqual(["extension_hook_failed:project:create-write-hook:onWrite"]);
    });
  });

  it("supports explicit none semantics and records unset intent in history message", async () => {
    await withTempPmPath(async (context) => {
      const previousPmAuthor = process.env.PM_AUTHOR;
      process.env.PM_AUTHOR = "   ";
      try {
        const result = await runCreate(
          baseCreateOptions({
            title: "create-none-semantics",
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
            author: "none",
            assignee: "none",
            parent: "none",
            reviewer: "none",
            risk: "none",
            confidence: "none",
            sprint: "none",
            release: "none",
            blockedBy: "none",
            blockedReason: "none",
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
            message: "",
            dep: ["none"],
            comment: ["none"],
            note: ["none"],
            learning: ["none"],
            file: ["none"],
            test: ["none"],
            doc: ["none"],
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
        expect(result.item.author).toBe("unknown");

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

  it("resolves author from PM_AUTHOR and settings when explicit author is none", async () => {
    await withTempPmPath(async (context) => {
      const envAuthor = await runCreate(
        baseCreateOptions({
          title: "create-env-author",
          author: "none",
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
            author: "none",
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

  it("supports omitted optional seed lists and undefined history message input", async () => {
    await withTempPmPath(async (context) => {
      const options = baseCreateOptions({
        title: "create-optional-seeds-omitted",
        dep: undefined,
        comment: undefined,
        note: undefined,
        learning: undefined,
        file: undefined,
        test: undefined,
        doc: undefined,
      });
      delete (options as Partial<CreateCommandOptions>).message;

      const result = await runCreate(options, { path: context.pmPath });
      expect(result.item.dependencies).toBeUndefined();
      expect(result.item.comments).toBeUndefined();
      expect(result.item.notes).toBeUndefined();
      expect(result.item.learnings).toBeUndefined();
      expect(result.item.files).toBeUndefined();
      expect(result.item.tests).toBeUndefined();
      expect(result.item.docs).toBeUndefined();

      const history = readCreateHistory(context, result.item.id);
      const createEntry = [...history].reverse().find((entry) => entry.op === "create");
      expect(createEntry?.message).toBe("");
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
            "path=tests/unit/create-command.spec.ts",
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
});
