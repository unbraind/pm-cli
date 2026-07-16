import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _testOnlyTestAll,
  runTestAll,
} from "../../../src/cli/commands/test-all.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import * as itemTestRunTracking from "../../../src/core/test/item-test-run-tracking.js";
import {
  loadTaskMetadata,
  overwriteTaskTests,
  setGovernancePreset,
  setTestResultTracking,
  writeSchemaTypeExtension,
} from "../../helpers/pmWorkspace.js";
import {
  withTempPmPath,
  type TempPmContext,
} from "../../helpers/withTempPmPath.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("includes path-linked execution metadata in deduplication identity", () => {
  const base = { path: "tests/shared.spec.ts", scope: "project" } as const;
  const plain = _testOnlyTestAll.buildLinkedTestKey(base);
  expect(
    _testOnlyTestAll.buildLinkedTestKey({ ...base, env_set: { PORT: "0" } }),
  ).not.toBe(plain);
  expect(
    _testOnlyTestAll.buildLinkedTestKey({ ...base, env_clear: ["DEBUG"] }),
  ).not.toBe(plain);
  expect(
    _testOnlyTestAll.buildLinkedTestKey({
      ...base,
      pm_context_mode: "tracker",
    }),
  ).not.toBe(plain);
  expect(
    _testOnlyTestAll.buildLinkedTestKey({ ...base, shared_host_safe: true }),
  ).not.toBe(plain);
  expect(
    _testOnlyTestAll.buildLinkedTestKey({
      ...base,
      assert_stdout_contains: ["ok"],
    }),
  ).not.toBe(plain);
});

function createTaskWithTests(
  context: TempPmContext,
  params: {
    title: string;
    status: "open" | "in_progress" | "closed";
    testEntries: string[];
  },
): string {
  const args = [
    "create",
    "--json",
    "--title",
    params.title,
    "--description",
    `${params.title} description`,
    "--type",
    "Task",
    "--status",
    params.status,
    "--priority",
    "1",
    "--tags",
    "testing",
    "--body",
    "",
    "--deadline",
    "none",
    "--estimate",
    "10",
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
    "--doc",
    "none",
  ];

  for (const testEntry of params.testEntries) {
    args.push("--test", testEntry);
  }

  const result = context.runCli(args, { expectJson: true });
  expect(result.code).toBe(0);
  return (result.json as { item: { id: string } }).item.id;
}

describe("runTestAll", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "pm-test-all-not-init-"),
    );
    try {
      await expect(runTestAll({}, { path: tempDir })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("validates status filter", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runTestAll({ status: "invalid" }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTestAll({ limit: "1.5" }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runTestAll({ offset: "-1" }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("formats tracking errors for Error and non-Error throwables", () => {
    expect(
      _testOnlyTestAll.formatTrackingError(new Error("tracking-boom")),
    ).toBe("tracking-boom");
    expect(_testOnlyTestAll.formatTrackingError("plain-tracking-failure")).toBe(
      "plain-tracking-failure",
    );
  });

  it("applies deterministic limit/offset pagination before execution", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createTaskWithTests(context, {
        title: "Pagination First",
        status: "open",
        testEntries: ["command=node --version,scope=project"],
      });
      const secondId = createTaskWithTests(context, {
        title: "Pagination Second",
        status: "open",
        testEntries: ["command=node --version,scope=project"],
      });
      const thirdId = createTaskWithTests(context, {
        title: "Pagination Third",
        status: "open",
        testEntries: ["command=node --version,scope=project"],
      });
      const sortedIds = [firstId, secondId, thirdId].sort((left, right) =>
        left.localeCompare(right),
      );

      const paged = await runTestAll(
        { status: "open", offset: "1", limit: "1", timeout: "20" },
        { path: context.pmPath },
      );
      expect(paged.totals.items).toBe(1);
      expect(paged.results).toHaveLength(1);
      expect(paged.results[0]?.id).toBe(sortedIds[1]);
      expect(paged.totals.linked_tests).toBe(1);

      const offsetOnly = await runTestAll(
        { status: "open", offset: "2", timeout: "20" },
        { path: context.pmPath },
      );
      expect(offsetOnly.totals.items).toBe(1);
      expect(offsetOnly.results[0]?.id).toBe(sortedIds[2]);

      const zeroLimit = await runTestAll(
        { status: "open", limit: "0", timeout: "20" },
        { path: context.pmPath },
      );
      expect(zeroLimit.totals.items).toBe(0);
      expect(zeroLimit.results).toHaveLength(0);
      expect(zeroLimit.totals.linked_tests).toBe(0);
      expect(zeroLimit.ok).toBe(true);

      const strictZeroLimit = await runTestAll(
        { status: "open", limit: "0", timeout: "20", failOnEmptyTestRun: true },
        { path: context.pmPath },
      );
      expect(strictZeroLimit.ok).toBe(false);
      expect(strictZeroLimit.failed).toBe(1);
      expect(strictZeroLimit.totals.failure_categories.empty_run).toBe(1);
      expect(strictZeroLimit.fail_on_empty_test_run_triggered).toBe(true);
      expect(strictZeroLimit.warnings?.[0]).toContain(
        "empty_linked_test_selection",
      );
    });
  });

  it("accepts in-progress status filter alias", async () => {
    await withTempPmPath(async (context) => {
      createTaskWithTests(context, {
        title: "In Progress Alias Filter Task",
        status: "in_progress",
        testEntries: ["command=node --version,scope=project"],
      });
      createTaskWithTests(context, {
        title: "Open Alias Filter Task",
        status: "open",
        testEntries: ["command=node --version,scope=project"],
      });

      const inProgressOnly = await runTestAll(
        { status: "in-progress" },
        { path: context.pmPath },
      );
      expect(inProgressOnly.totals.items).toBe(1);
      expect(inProgressOnly.results).toHaveLength(1);
      expect(inProgressOnly.results[0]?.status).toBe("in_progress");
    });
  });

  it("aggregates pass/fail/skip results and status filtering", async () => {
    await withTempPmPath(async (context) => {
      createTaskWithTests(context, {
        title: "Passing Task",
        status: "open",
        testEntries: [
          "command=node -e \"const p=process.env.PM_PATH||''; const g=process.env.PM_GLOBAL_PATH||''; if(!p||!g||!p.includes('pm-linked-test-')){process.exit(1)}; process.stdout.write(p)\",scope=project",
        ],
      });
      createTaskWithTests(context, {
        title: "Failing Task",
        status: "open",
        testEntries: ["command=node --this-flag-does-not-exist,scope=project"],
      });
      const skippedTaskId = createTaskWithTests(context, {
        title: "Skipped Task",
        status: "open",
        testEntries: [
          "command=node -e \"process.stdout.write('skip-placeholder')\",scope=project",
        ],
      });
      await overwriteTaskTests(context, skippedTaskId, [
        { path: "tests/sample.spec.ts", scope: "project" },
      ]);
      createTaskWithTests(context, {
        title: "Closed Task",
        status: "closed",
        testEntries: ["command=node --version,scope=project"],
      });

      const openOnly = await runTestAll(
        { status: "open", timeout: "30" },
        { path: context.pmPath },
      );
      expect(openOnly.ok).toBe(false);
      expect(openOnly.totals.items).toBe(3);
      expect(openOnly.totals.linked_tests).toBe(3);
      expect(openOnly.passed).toBeGreaterThanOrEqual(1);
      expect(openOnly.failed).toBeGreaterThanOrEqual(1);
      expect(openOnly.skipped).toBeGreaterThanOrEqual(1);
      expect(
        openOnly.totals.failure_categories.assertion_failure,
      ).toBeGreaterThanOrEqual(1);
      expect(openOnly.results.every((entry) => entry.status === "open")).toBe(
        true,
      );
      const envSandboxResult = openOnly.results
        .flatMap((entry) => entry.run_results)
        .find((entry) => entry.command?.includes("process.env.PM_PATH"));
      expect(envSandboxResult?.status).toBe("passed");
      expect(envSandboxResult?.stdout ?? "").toContain("pm-linked-test-");
      expect(envSandboxResult?.stdout ?? "").not.toContain(context.pmPath);

      const allStatuses = await runTestAll({}, { path: context.pmPath });
      expect(allStatuses.totals.items).toBe(4);
      expect(allStatuses.totals.linked_tests).toBe(4);
    });
  });

  it("applies run-level env overrides and shared-host-safe defaults in test-all", async () => {
    await withTempPmPath(async (context) => {
      createTaskWithTests(context, {
        title: "Shared Host Safe Env Source",
        status: "open",
        testEntries: [
          "command=node -e \"process.stdout.write([process.env.RUN_LEVEL||'',process.env.PORT||'',process.env.PM_SHARED_HOST_SAFE||'',String(process.env.DELETE_ME===undefined),String(process.env.A_CLEAR===undefined)].join('|'))\",scope=project,env_set=Z_HINT=yes;A_HINT=yes,env_clear=Z_CLEAR;DELETE_ME;A_CLEAR",
        ],
      });

      const result = await runTestAll(
        {
          status: "open",
          timeout: "20",
          envSet: ["RUN_LEVEL=run-level", "DELETE_ME=remove-me"],
          sharedHostSafe: true,
        },
        { path: context.pmPath },
      );
      expect(result.ok).toBe(true);
      expect(result.totals.items).toBe(1);
      expect(result.totals.linked_tests).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.passed).toBe(1);
      expect(result.results[0]?.ok).toBe(true);
      expect(result.results[0]?.run_results[0]?.stdout ?? "").toContain(
        "run-level|0|1|true|true",
      );
    });
  });

  it("executes linked commands with project and global extension type parity", async () => {
    await withTempPmPath(async (context) => {
      const globalPmRoot = context.env.PM_GLOBAL_PATH;
      expect(typeof globalPmRoot).toBe("string");
      await writeSchemaTypeExtension(
        context.pmPath,
        "project-test-all-type",
        "ProjectAsset",
      );
      await writeSchemaTypeExtension(
        globalPmRoot as string,
        "global-test-all-type",
        "GlobalAsset",
      );

      createTaskWithTests(context, {
        title: "Project Type Filter Source",
        status: "open",
        testEntries: [
          "command=node dist/cli.js list --type ProjectAsset --limit 1 --json,scope=project",
        ],
      });
      createTaskWithTests(context, {
        title: "Global Type Filter Source",
        status: "open",
        testEntries: [
          "command=node dist/cli.js list --type GlobalAsset --limit 1 --json,scope=project",
        ],
      });

      const result = await runTestAll(
        { status: "open", timeout: "30", pmContext: "tracker" },
        { path: context.pmPath },
      );
      expect(result.totals.items).toBe(2);
      expect(result.totals.linked_tests).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.passed).toBe(2);
      expect(result.skipped).toBe(0);
    });
  });

  it("deduplicates duplicate command and path entries across items", async () => {
    await withTempPmPath(async (context) => {
      const duplicateCommand =
        "command=node -e \"process.stdout.write('dup-command-token')\",scope=project";
      const uniqueCommand =
        "command=node -e \"process.stdout.write('unique-command-token')\",scope=project";
      const duplicatePath = "tests/duplicate-path.spec.ts";

      const firstDuplicateId = createTaskWithTests(context, {
        title: "First Duplicate Source",
        status: "open",
        testEntries: [duplicateCommand],
      });
      const secondDuplicateId = createTaskWithTests(context, {
        title: "Second Duplicate Source",
        status: "open",
        testEntries: [duplicateCommand, uniqueCommand],
      });
      await overwriteTaskTests(context, firstDuplicateId, [
        {
          command: "node -e \"process.stdout.write('dup-command-token')\"",
          scope: "project",
        },
        { path: duplicatePath, scope: "project" },
      ]);
      await overwriteTaskTests(context, secondDuplicateId, [
        {
          command: "node -e \"process.stdout.write('dup-command-token')\"",
          scope: "project",
        },
        { path: duplicatePath, scope: "project" },
        {
          command: "node -e \"process.stdout.write('unique-command-token')\"",
          scope: "project",
        },
      ]);

      const result = await runTestAll(
        { status: "open", timeout: "30" },
        { path: context.pmPath },
      );
      expect(result.totals.items).toBe(2);
      expect(result.totals.linked_tests).toBe(5);
      expect(result.passed).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(3);

      const runResults = result.results.flatMap((entry) => entry.run_results);
      const duplicateCommandRuns = runResults.filter((entry) =>
        (entry.command ?? "").includes("dup-command-token"),
      );
      expect(duplicateCommandRuns).toHaveLength(2);
      expect(
        duplicateCommandRuns.filter((entry) => entry.status === "passed"),
      ).toHaveLength(1);
      expect(
        duplicateCommandRuns.filter((entry) => entry.status === "skipped"),
      ).toHaveLength(1);
      expect(
        duplicateCommandRuns.some((entry) =>
          (entry.error ?? "").includes("Duplicate linked test skipped"),
        ),
      ).toBe(true);

      const duplicatePathRuns = runResults.filter(
        (entry) => entry.path === "tests/duplicate-path.spec.ts",
      );
      expect(duplicatePathRuns).toHaveLength(2);
      expect(
        duplicatePathRuns.filter((entry) => entry.status === "skipped"),
      ).toHaveLength(2);
      expect(
        duplicatePathRuns.some((entry) =>
          (entry.error ?? "").includes("No command configured"),
        ),
      ).toBe(true);
      expect(
        duplicatePathRuns.some((entry) =>
          (entry.error ?? "").includes("Duplicate linked test skipped"),
        ),
      ).toBe(true);

      const uniqueCommandRuns = runResults.filter((entry) =>
        (entry.command ?? "").includes("unique-command-token"),
      );
      expect(uniqueCommandRuns).toHaveLength(1);
      expect(uniqueCommandRuns[0]?.status).toBe("passed");
    });
  });

  it("treats assertion-distinct linked commands as unique dedupe keys", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createTaskWithTests(context, {
        title: "Assertion Signature First",
        status: "open",
        testEntries: [
          "command=node -e \"process.stderr.write('warn\\\\n'); process.stdout.write(JSON.stringify({count:2,a:1,z:1}))\",scope=project",
        ],
      });
      const secondId = createTaskWithTests(context, {
        title: "Assertion Signature Second",
        status: "open",
        testEntries: [
          "command=node -e \"process.stderr.write('warn\\\\n'); process.stdout.write(JSON.stringify({count:2,a:1,z:1}))\",scope=project",
        ],
      });

      await overwriteTaskTests(context, firstId, [
        {
          command:
            "node -e \"process.stderr.write('warn\\\\n'); process.stdout.write(JSON.stringify({count:2,a:1,z:1}))\"",
          scope: "project",
          assert_stdout_contains: ["count", "a"],
          assert_stdout_regex: ["count", '\\\\{\\"count\\"'],
          assert_stderr_contains: ["warn", "wa"],
          assert_stderr_regex: ["warn", "wa.*"],
          assert_stdout_min_lines: 0,
          assert_json_field_equals: {
            z: "1",
            a: "1",
          },
          assert_json_field_gte: {
            count: 1,
            a: 1,
          },
        },
      ]);
      await overwriteTaskTests(context, secondId, [
        {
          command:
            "node -e \"process.stderr.write('warn\\\\n'); process.stdout.write(JSON.stringify({count:2,a:1,z:1}))\"",
          scope: "project",
          assert_stdout_contains: ["count", "a"],
          assert_stdout_regex: ["count", '\\\\{\\"count\\"'],
          assert_stderr_contains: ["warn", "wa"],
          assert_stderr_regex: ["warn", "wa.*"],
          assert_stdout_min_lines: 0,
          assert_json_field_equals: {
            z: "1",
            a: "1",
          },
          assert_json_field_gte: {
            count: 3,
            a: 1,
          },
        },
      ]);

      const result = await runTestAll(
        { status: "open", timeout: "20" },
        { path: context.pmPath },
      );
      expect(result.totals.items).toBe(2);
      expect(result.totals.linked_tests).toBe(2);
      expect(result.passed + result.failed + result.skipped).toBe(2);
      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(result.skipped).toBe(0);
      const runResults = result.results.flatMap((entry) => entry.run_results);
      expect(
        runResults.filter((entry) =>
          entry.command?.includes("JSON.stringify({count:2,a:1,z:1})"),
        ),
      ).toHaveLength(2);
      expect(
        runResults.some((entry) =>
          (entry.error ?? "").includes("Duplicate linked test skipped"),
        ),
      ).toBe(false);
    });
  });

  it("treats per-test shared_host_safe metadata as part of dedupe identity", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createTaskWithTests(context, {
        title: "Shared Host Safe True",
        status: "open",
        testEntries: ["command=node --version,scope=project"],
      });
      const secondId = createTaskWithTests(context, {
        title: "Shared Host Safe False",
        status: "open",
        testEntries: ["command=node --version,scope=project"],
      });

      await overwriteTaskTests(context, firstId, [
        { command: "node --version", scope: "project", shared_host_safe: true },
      ]);
      await overwriteTaskTests(context, secondId, [
        {
          command: "node --version",
          scope: "project",
          shared_host_safe: false,
        },
      ]);

      const result = await runTestAll(
        { status: "open", timeout: "20" },
        { path: context.pmPath },
      );
      expect(result.totals.items).toBe(2);
      expect(result.totals.linked_tests).toBe(2);
      expect(result.passed).toBe(2);
      expect(result.skipped).toBe(0);
    });
  });

  it("treats per-test pm_context_mode metadata as part of dedupe identity", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createTaskWithTests(context, {
        title: "PM Context Schema",
        status: "open",
        testEntries: ["command=node --version,scope=project"],
      });
      const secondId = createTaskWithTests(context, {
        title: "PM Context Tracker",
        status: "open",
        testEntries: ["command=node --version,scope=project"],
      });

      await overwriteTaskTests(context, firstId, [
        {
          command: "node --version",
          scope: "project",
          pm_context_mode: "schema",
        },
      ]);
      await overwriteTaskTests(context, secondId, [
        {
          command: "node --version",
          scope: "project",
          pm_context_mode: "tracker",
        },
      ]);

      const result = await runTestAll(
        { status: "open", timeout: "20" },
        { path: context.pmPath },
      );
      expect(result.totals.items).toBe(2);
      expect(result.totals.linked_tests).toBe(2);
      expect(result.passed).toBe(2);
      expect(result.skipped).toBe(0);

      const runResults = result.results.flatMap((entry) => entry.run_results);
      const contextModes = runResults
        .map((entry) => entry.execution_context?.pm_context_mode)
        .filter((value): value is string => typeof value === "string")
        .sort((left, right) => left.localeCompare(right));
      expect(contextModes).toEqual(["schema", "tracker"]);
    });
  });

  it("deduplicates timeout-variant duplicate commands using the maximum timeout", async () => {
    await withTempPmPath(async (context) => {
      const slowDuplicateCommand =
        "command=node -e \"const end=Date.now()+1100; while(Date.now()<end){}; process.stdout.write('slow-dup-timeout-token')\",scope=project";

      createTaskWithTests(context, {
        title: "Slow Duplicate Short Timeout",
        status: "open",
        testEntries: [`${slowDuplicateCommand},timeout_seconds=1`],
      });
      createTaskWithTests(context, {
        title: "Slow Duplicate Long Timeout",
        status: "open",
        testEntries: [`${slowDuplicateCommand},timeout_seconds=5`],
      });

      const result = await runTestAll(
        { status: "open" },
        { path: context.pmPath },
      );
      expect(result.totals.items).toBe(2);
      expect(result.totals.linked_tests).toBe(2);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(1);

      const runResults = result.results.flatMap((entry) => entry.run_results);
      const slowRuns = runResults.filter((entry) =>
        (entry.command ?? "").includes("slow-dup-timeout-token"),
      );
      expect(slowRuns).toHaveLength(2);
      expect(
        slowRuns.filter((entry) => entry.status === "passed"),
      ).toHaveLength(1);
      expect(
        slowRuns.filter((entry) => entry.status === "skipped"),
      ).toHaveLength(1);
      expect(
        slowRuns.some((entry) =>
          (entry.error ?? "").includes("Duplicate linked test skipped"),
        ),
      ).toBe(true);
    });
  });

  it("deterministically keeps the larger timeout when duplicate commands appear in one item", async () => {
    await withTempPmPath(async (context) => {
      const slowDuplicateCommand =
        "command=node -e \"const end=Date.now()+1100; while(Date.now()<end){}; process.stdout.write('single-item-timeout-token')\",scope=project";

      createTaskWithTests(context, {
        title: "Single Item Timeout Variants",
        status: "open",
        testEntries: [
          `${slowDuplicateCommand},timeout_seconds=1`,
          `${slowDuplicateCommand},timeout_seconds=5`,
        ],
      });

      const result = await runTestAll(
        { status: "open" },
        { path: context.pmPath },
      );
      expect(result.totals.items).toBe(1);
      expect(result.totals.linked_tests).toBe(2);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(1);

      const timeoutRuns = result.results
        .flatMap((entry) => entry.run_results)
        .filter((entry) =>
          (entry.command ?? "").includes("single-item-timeout-token"),
        );
      expect(timeoutRuns).toHaveLength(2);
      expect(
        timeoutRuns.filter((entry) => entry.status === "passed"),
      ).toHaveLength(1);
      expect(
        timeoutRuns.filter((entry) => entry.status === "skipped"),
      ).toHaveLength(1);
    });
  });

  it("deduplicates equal-timeout duplicate commands deterministically", async () => {
    await withTempPmPath(async (context) => {
      const equalTimeoutCommand =
        "command=node -e \"process.stdout.write('equal-timeout-token')\",scope=project";

      createTaskWithTests(context, {
        title: "Equal Timeout Duplicate Source",
        status: "open",
        testEntries: [
          `${equalTimeoutCommand},timeout_seconds=3,note=first`,
          `${equalTimeoutCommand},timeout_seconds=3,note=second`,
        ],
      });

      const result = await runTestAll(
        { status: "open" },
        { path: context.pmPath },
      );
      expect(result.totals.items).toBe(1);
      expect(result.totals.linked_tests).toBe(2);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(1);

      const runResults = result.results.flatMap((entry) => entry.run_results);
      const equalRuns = runResults.filter((entry) =>
        (entry.command ?? "").includes("equal-timeout-token"),
      );
      expect(equalRuns).toHaveLength(2);
      expect(
        equalRuns.filter((entry) => entry.status === "passed"),
      ).toHaveLength(1);
      expect(
        equalRuns.filter((entry) => entry.status === "skipped"),
      ).toHaveLength(1);
    });
  });

  it("keeps the existing timeout when duplicate command omits timeout_seconds", async () => {
    await withTempPmPath(async (context) => {
      const mixedTimeoutId = createTaskWithTests(context, {
        title: "Mixed Timeout Duplicate Source",
        status: "open",
        testEntries: [
          "command=node -e \"process.stdout.write('mixed-timeout-seed')\",scope=project",
        ],
      });
      await overwriteTaskTests(context, mixedTimeoutId, [
        {
          command: "node -e \"process.stdout.write('mixed-timeout-token')\"",
          scope: "project",
          timeout_seconds: 3,
        },
        {
          command: "node -e \"process.stdout.write('mixed-timeout-token')\"",
          scope: "project",
        },
      ]);

      const result = await runTestAll(
        { status: "open" },
        { path: context.pmPath },
      );
      expect(result.totals.items).toBe(1);
      expect(result.totals.linked_tests).toBe(2);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });

  it("keeps existing timeout when duplicate path omits timeout_seconds", async () => {
    await withTempPmPath(async (context) => {
      const formatResult = context.runCli(
        [
          "config",
          "project",
          "set",
          "item-format",
          "--format",
          "toon",
          "--json",
        ],
        { expectJson: true },
      );
      expect(formatResult.code).toBe(0);

      const mixedTimeoutId = createTaskWithTests(context, {
        title: "Mixed Path Timeout Duplicate Source",
        status: "open",
        testEntries: [
          "command=node -e \"process.stdout.write('mixed-path-timeout-seed')\",scope=project",
        ],
      });
      await overwriteTaskTests(context, mixedTimeoutId, [
        {
          path: "tests/mixed-path-timeout-target.spec.ts",
          scope: "project",
          timeout_seconds: 0,
          note: "a",
        },
        {
          path: "tests/mixed-path-timeout-target.spec.ts",
          scope: "project",
          note: "z",
        },
      ]);

      const result = await runTestAll(
        { status: "open" },
        { path: context.pmPath },
      );
      expect(result.totals.items).toBe(1);
      expect(result.totals.linked_tests).toBe(2);
      expect(result.passed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(2);
    });
  });

  it("handles malformed linked tests without path via deterministic duplicate skip behavior", async () => {
    await withTempPmPath(async (context) => {
      const malformedA = createTaskWithTests(context, {
        title: "Malformed A",
        status: "open",
        testEntries: [
          "command=node -e \"process.stdout.write('placeholder-a')\",scope=project",
        ],
      });
      const malformedB = createTaskWithTests(context, {
        title: "Malformed B",
        status: "open",
        testEntries: [
          "command=node -e \"process.stdout.write('placeholder-b')\",scope=project",
        ],
      });

      await overwriteTaskTests(context, malformedA, [{ scope: "project" }]);
      await overwriteTaskTests(context, malformedB, [{ scope: "project" }]);

      const result = await runTestAll(
        { status: "open", timeout: "30" },
        { path: context.pmPath },
      );
      expect(result.totals.items).toBe(2);
      expect(result.totals.linked_tests).toBe(2);
      expect(result.passed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(2);

      const runResults = result.results.flatMap((entry) => entry.run_results);
      expect(runResults).toHaveLength(2);
      expect(runResults.every((entry) => entry.status === "skipped")).toBe(
        true,
      );
      expect(
        runResults.some((entry) =>
          (entry.error ?? "").includes(
            "No command configured for this linked test.",
          ),
        ),
      ).toBe(true);
      expect(
        runResults.some((entry) =>
          (entry.error ?? "").includes("Duplicate linked test skipped"),
        ),
      ).toBe(true);
    });
  });

  it("reports fail-on-skipped aggregate policy triggers", async () => {
    await withTempPmPath(async (context) => {
      const malformed = createTaskWithTests(context, {
        title: "Fail On Skipped Aggregate",
        status: "open",
        testEntries: [
          "command=node -e \"process.stdout.write('placeholder')\",scope=project",
        ],
      });
      await overwriteTaskTests(context, malformed, [
        { path: "tests/legacy-path-only.spec.ts", scope: "project" },
      ]);
      const result = await runTestAll(
        { status: "open", failOnSkipped: true },
        { path: context.pmPath },
      );
      expect(result.skipped).toBeGreaterThan(0);
      expect(result.fail_on_skipped_triggered).toBe(true);
    });
  });

  it("fails empty linked-test runs when fail-on-empty-test-run is enabled", async () => {
    await withTempPmPath(async (context) => {
      createTaskWithTests(context, {
        title: "Fail On Empty Test-All Aggregate",
        status: "open",
        testEntries: [
          "command=node -e \"console.log('No projects matched the filters')\",scope=project",
        ],
      });

      const baseline = await runTestAll(
        { status: "open", timeout: "20" },
        { path: context.pmPath },
      );
      expect(baseline.failed).toBe(0);

      const guarded = await runTestAll(
        { status: "open", timeout: "20", failOnEmptyTestRun: true },
        { path: context.pmPath },
      );
      expect(guarded.failed).toBeGreaterThanOrEqual(1);
      const runResults = guarded.results.flatMap((entry) => entry.run_results);
      expect(
        runResults.some((entry) => entry.failure_category === "empty_run"),
      ).toBe(true);
    });
  });

  it("supports PM context mismatch guards and PM assertion policy in test-all", async () => {
    await withTempPmPath(async (context) => {
      createTaskWithTests(context, {
        title: "Test-All PM Context Guard",
        status: "open",
        testEntries: [
          "command=node dist/cli.js list-all --type Task --limit 200 --json,scope=project",
        ],
      });

      const schemaDefault = await runTestAll(
        {
          status: "open",
        },
        { path: context.pmPath },
      );
      expect(schemaDefault.failed).toBe(1);
      expect(schemaDefault.results[0]?.run_results[0]?.error ?? "").toContain(
        "context mismatch",
      );

      const schemaPreflight = await runTestAll(
        {
          status: "open",
          checkContext: true,
        },
        { path: context.pmPath },
      );
      expect(schemaPreflight.failed).toBe(1);
      expect(schemaPreflight.results[0]?.run_results[0]?.error ?? "").toContain(
        "preflight PM context mismatch",
      );
      expect(schemaPreflight.warnings?.[0] ?? "").toContain(
        "context_preflight:",
      );

      const schemaAutoPreflight = await runTestAll(
        {
          status: "open",
          checkContext: true,
          autoPmContext: true,
        },
        { path: context.pmPath },
      );
      expect(schemaAutoPreflight.failed).toBe(0);
      expect(schemaAutoPreflight.passed).toBe(1);
      expect(
        schemaAutoPreflight.results[0]?.run_results[0]?.execution_context
          ?.requested_pm_context_mode,
      ).toBe("auto");
      expect(
        schemaAutoPreflight.results[0]?.run_results[0]?.execution_context
          ?.auto_pm_context_applied,
      ).toBe(true);
      expect(schemaAutoPreflight.warnings?.[0] ?? "").toContain(
        "auto_remediated=1",
      );

      const schemaStrict = await runTestAll(
        {
          status: "open",
          failOnContextMismatch: true,
        },
        { path: context.pmPath },
      );
      expect(schemaStrict.failed).toBe(1);
      expect(schemaStrict.results[0]?.run_results[0]?.error ?? "").toContain(
        "context mismatch",
      );

      const trackerStrict = await runTestAll(
        {
          status: "open",
          pmContext: "tracker",
          failOnContextMismatch: true,
        },
        { path: context.pmPath },
      );
      expect(trackerStrict.failed).toBe(0);
      expect(trackerStrict.passed).toBe(1);

      const requireAssertions = await runTestAll(
        {
          status: "open",
          pmContext: "tracker",
          requireAssertionsForPm: true,
        },
        { path: context.pmPath },
      );
      expect(requireAssertions.failed).toBe(1);
      expect(
        requireAssertions.results[0]?.run_results[0]?.error ?? "",
      ).toContain("requires assertions");

      const overrideTargetId = createTaskWithTests(context, {
        title: "Test-All PM Context Override Target",
        status: "open",
        testEntries: ["command=node --version,scope=project"],
      });
      await overwriteTaskTests(context, overrideTargetId, [
        {
          command: "node dist/cli.js list-all --type Task --limit 201 --json",
          scope: "project",
          pm_context_mode: "schema",
        },
      ]);

      const runLevelTrackerWithoutOverride = await runTestAll(
        {
          status: "open",
          pmContext: "tracker",
          failOnContextMismatch: true,
        },
        { path: context.pmPath },
      );
      const withoutOverrideEntry = runLevelTrackerWithoutOverride.results
        .flatMap((entry) => entry.run_results)
        .find((entry) =>
          entry.command?.includes("list-all --type Task --limit 201 --json"),
        );
      expect(withoutOverrideEntry?.status).toBe("failed");
      expect(withoutOverrideEntry?.execution_context?.pm_context_mode).toBe(
        "schema",
      );
      expect(withoutOverrideEntry?.error ?? "").toContain(
        "pm_context_mode=schema overrides run-level --pm-context tracker",
      );

      const runLevelTrackerWithOverride = await runTestAll(
        {
          status: "open",
          pmContext: "tracker",
          overrideLinkedPmContext: true,
          failOnContextMismatch: true,
        },
        { path: context.pmPath },
      );
      const withOverrideEntry = runLevelTrackerWithOverride.results
        .flatMap((entry) => entry.run_results)
        .find((entry) =>
          entry.command?.includes("list-all --type Task --limit 201 --json"),
        );
      expect(withOverrideEntry?.status).toBe("passed");
      expect(withOverrideEntry?.execution_context?.pm_context_mode).toBe(
        "tracker",
      );
      expect(withOverrideEntry?.execution_context?.mismatch_detected).toBe(
        false,
      );
    });
  });

  it("runs unique markdown-format tests without injecting timeout_seconds", async () => {
    await withTempPmPath(async (context) => {
      const formatResult = context.runCli(
        [
          "config",
          "project",
          "set",
          "item-format",
          "--format",
          "toon",
          "--json",
        ],
        { expectJson: true },
      );
      expect(formatResult.code).toBe(0);

      createTaskWithTests(context, {
        title: "Markdown Unique Timeout Source",
        status: "open",
        testEntries: [
          "command=node -e \"process.stdout.write('markdown-unique-timeout-token')\",scope=project",
        ],
      });

      const result = await runTestAll(
        { status: "open" },
        { path: context.pmPath },
      );
      expect(result.totals.items).toBe(1);
      expect(result.totals.linked_tests).toBe(1);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });

  it("completes deterministically when a linked command ignores SIGTERM on timeout", async () => {
    await withTempPmPath(async (context) => {
      createTaskWithTests(context, {
        title: "Stubborn Timeout Test-All Source",
        status: "open",
        testEntries: [
          "command=node -e \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\",scope=project",
        ],
      });

      const previousForceKillDelay =
        process.env.PM_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS;
      process.env.PM_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS = "20";
      try {
        const startedAt = Date.now();
        const result = await runTestAll(
          { status: "open", timeout: "0.02" },
          { path: context.pmPath },
        );
        const elapsedMs = Date.now() - startedAt;
        const maxElapsedMs = process.platform === "win32" ? 10000 : 3000;

        expect(elapsedMs).toBeLessThan(maxElapsedMs);
        expect(result.totals.items).toBe(1);
        expect(result.totals.linked_tests).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.passed).toBe(0);
        expect(result.skipped).toBe(0);
        expect(result.results[0]?.run_results[0]?.status).toBe("failed");
        expect(result.results[0]?.run_results[0]?.error ?? "").toContain(
          "timed out after",
        );
      } finally {
        if (previousForceKillDelay === undefined) {
          delete process.env.PM_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS;
        } else {
          process.env.PM_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS =
            previousForceKillDelay;
        }
      }
    });
  });

  it("emits linked-test progress when progress mode is forced in non-interactive runs", async () => {
    await withTempPmPath(async (context) => {
      createTaskWithTests(context, {
        title: "Forced Progress Test-All Source",
        status: "open",
        testEntries: [
          'command=node -e "setTimeout(() => {}, 60)",scope=project,timeout_seconds=5',
        ],
      });

      const previousHeartbeatInterval =
        process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS;
      process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS = "10";
      const originalIsTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, "isTTY", {
        value: false,
        configurable: true,
      });
      const stderrWriteSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        const result = await runTestAll(
          { status: "open", timeout: "5", progress: true },
          { path: context.pmPath },
        );
        expect(result.totals.items).toBe(1);
        expect(result.passed).toBe(1);
        expect(result.failed).toBe(0);
        expect(result.skipped).toBe(0);

        const stderrOutput = stderrWriteSpy.mock.calls
          .map((entry) => String(entry[0]))
          .join("");
        expect(stderrOutput).toContain(
          "[pm test-all] selection items=1 linked_tests=1 status=open",
        );
        expect(stderrOutput).toMatch(
          /\[pm test-all\] item 1\/1 start id=pm-[a-z0-9]+ linked_tests=1/,
        );
        expect(stderrOutput).toContain("[pm test] linked-test 1/1 start");
        expect(stderrOutput).toContain("[pm test] linked-test 1/1 running");
        expect(stderrOutput).toContain(
          "[pm test] linked-test 1/1 end status=passed",
        );
        expect(stderrOutput).toMatch(
          /\[pm test-all\] item 1\/1 end id=pm-[a-z0-9]+ status=passed passed=1 failed=0 skipped=0/,
        );
        expect(stderrOutput).toContain(
          "[pm test-all] end status=passed items=1 linked_tests=1 passed=1 failed=0 skipped=0",
        );
      } finally {
        if (previousHeartbeatInterval === undefined) {
          delete process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS;
        } else {
          process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS =
            previousHeartbeatInterval;
        }
        Object.defineProperty(process.stderr, "isTTY", {
          value: originalIsTTY,
          configurable: true,
        });
      }
    });
  });

  it("records test-all item summaries when tracking is enabled", async () => {
    await withTempPmPath(async (context) => {
      const id = createTaskWithTests(context, {
        title: "Track Test-All Summary Source",
        status: "open",
        testEntries: ["command=node --version,scope=project"],
      });
      await setTestResultTracking(context.pmPath, true);

      const previousRunId = process.env.PM_BACKGROUND_TEST_RUN_ID;
      const previousAttempt = process.env.PM_BACKGROUND_TEST_RUN_ATTEMPT;
      const previousResumedFrom =
        process.env.PM_BACKGROUND_TEST_RUN_RESUMED_FROM;
      process.env.PM_BACKGROUND_TEST_RUN_ID = "tr-test-all-success";
      process.env.PM_BACKGROUND_TEST_RUN_ATTEMPT = "3";
      process.env.PM_BACKGROUND_TEST_RUN_RESUMED_FROM = "tr-prior";
      try {
        const result = await runTestAll(
          { status: "open", timeout: "20" },
          { path: context.pmPath },
        );
        expect(result.failed).toBe(0);
        expect(result.warnings).toBeUndefined();
        const itemMetadata = await loadTaskMetadata(context, id);
        const testRuns = (itemMetadata.test_runs ?? []) as Array<
          Record<string, unknown>
        >;
        expect(testRuns).toHaveLength(1);
        expect(testRuns[0]).toMatchObject({
          run_id: "tr-test-all-success",
          kind: "test-all",
          status: "passed",
          attempt: 3,
          resumed_from: "tr-prior",
        });
      } finally {
        if (previousRunId === undefined) {
          delete process.env.PM_BACKGROUND_TEST_RUN_ID;
        } else {
          process.env.PM_BACKGROUND_TEST_RUN_ID = previousRunId;
        }
        if (previousAttempt === undefined) {
          delete process.env.PM_BACKGROUND_TEST_RUN_ATTEMPT;
        } else {
          process.env.PM_BACKGROUND_TEST_RUN_ATTEMPT = previousAttempt;
        }
        if (previousResumedFrom === undefined) {
          delete process.env.PM_BACKGROUND_TEST_RUN_RESUMED_FROM;
        } else {
          process.env.PM_BACKGROUND_TEST_RUN_RESUMED_FROM = previousResumedFrom;
        }
      }
    });
  });

  it("reports tracking warnings when test-all item summary persistence fails", async () => {
    await withTempPmPath(async (context) => {
      const id = createTaskWithTests(context, {
        title: "Track Test-All Warning Source",
        status: "open",
        testEntries: ["command=node --version,scope=project"],
      });
      setGovernancePreset(context, "strict");
      await setTestResultTracking(context.pmPath, true);
      const reassigned = context.runCli(
        [
          "update",
          "--json",
          id,
          "--assignee",
          "other-owner",
          "--message",
          "Reassign for test-all tracking warning",
        ],
        { expectJson: true },
      );
      expect(reassigned.code).toBe(0);

      const result = await runTestAll(
        { status: "open", timeout: "20" },
        { path: context.pmPath },
      );
      expect(result.failed).toBe(0);
      expect(result.warnings?.[0] ?? "").toContain(
        "test_result_tracking_failed",
      );
    });
  });

  it("stringifies non-Error tracking failures in warning output", async () => {
    await withTempPmPath(async (context) => {
      const id = createTaskWithTests(context, {
        title: "Track Test-All Non-Error Warning Source",
        status: "open",
        testEntries: ["command=node --version,scope=project"],
      });
      await setTestResultTracking(context.pmPath, true);
      vi.spyOn(
        itemTestRunTracking,
        "appendTrackedTestRunSummary",
      ).mockRejectedValue("non-error-tracking-failure");

      const result = await runTestAll(
        { status: "open", timeout: "20" },
        { path: context.pmPath },
      );
      expect(result.failed).toBe(0);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          `test_result_tracking_failed:${id}:non-error-tracking-failure`,
        ]),
      );
    });
  });

  it("tracks skipped-only runs as failed summaries when fail-on-skipped is enabled", async () => {
    await withTempPmPath(async (context) => {
      const id = createTaskWithTests(context, {
        title: "Track Test-All Skip Failure Source",
        status: "open",
        testEntries: [
          "command=node -e \"process.stdout.write('skip')\",scope=project",
        ],
      });
      await overwriteTaskTests(context, id, [
        { path: "tests/skip-only.spec.ts", scope: "project" },
      ]);
      await setTestResultTracking(context.pmPath, true);

      const previousAuthor = process.env.PM_AUTHOR;
      process.env.PM_AUTHOR = "   ";
      try {
        const result = await runTestAll(
          { status: "open", failOnSkipped: true },
          { path: context.pmPath },
        );
        expect(result.fail_on_skipped_triggered).toBe(true);
        expect(result.skipped).toBeGreaterThanOrEqual(1);
        const itemMetadata = await loadTaskMetadata(context, id);
        const testRuns = (itemMetadata.test_runs ?? []) as Array<
          Record<string, unknown>
        >;
        expect(testRuns).toHaveLength(1);
        expect(testRuns[0]).toMatchObject({
          kind: "test-all",
          status: "failed",
          fail_on_skipped_triggered: true,
        });
      } finally {
        if (previousAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousAuthor;
        }
      }
    });
  });

  it("tracks summaries when PM_AUTHOR is unset and fallback author is used", async () => {
    await withTempPmPath(async (context) => {
      const id = createTaskWithTests(context, {
        title: "Track Test-All Fallback Author",
        status: "open",
        testEntries: ["command=node --version,scope=project"],
      });
      await setTestResultTracking(context.pmPath, true);

      const previousAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const result = await runTestAll(
          { status: "open", timeout: "20" },
          { path: context.pmPath },
        );
        expect(result.failed).toBe(0);
        const itemMetadata = await loadTaskMetadata(context, id);
        const testRuns = (itemMetadata.test_runs ?? []) as Array<
          Record<string, unknown>
        >;
        expect(testRuns).toHaveLength(1);
        expect(testRuns[0]).toMatchObject({
          kind: "test-all",
          status: "passed",
        });
      } finally {
        if (previousAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousAuthor;
        }
      }
    });
  });
});
