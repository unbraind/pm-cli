import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTestAll } from "../../src/cli/commands/test-all.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { parseItemDocument, serializeItemDocument } from "../../src/item-format.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

afterEach(() => {
  vi.restoreAllMocks();
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

async function overwriteTaskTests(
  context: TempPmContext,
  id: string,
  tests: Array<Record<string, unknown>>,
): Promise<void> {
  const toonPath = path.join(context.pmPath, "tasks", `${id}.toon`);
  const markdownPath = path.join(context.pmPath, "tasks", `${id}.md`);
  let taskPath = toonPath;
  let source: string;
  try {
    source = await readFile(taskPath, "utf8");
  } catch {
    taskPath = markdownPath;
    source = await readFile(taskPath, "utf8");
  }
  const format = taskPath.endsWith(".toon") ? "toon" : "json_markdown";
  const parsed = parseItemDocument(source, { format });
  parsed.front_matter.tests = tests as unknown as never;
  await writeFile(taskPath, serializeItemDocument(parsed, { format }), "utf8");
}

async function writeSchemaTypeExtension(pmRoot: string, extensionDirName: string, typeName: string): Promise<void> {
  const extensionDir = path.join(pmRoot, "extensions", extensionDirName);
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    path.join(extensionDir, "manifest.json"),
    `${JSON.stringify(
      {
        name: `${extensionDirName}-ext`,
        version: "1.0.0",
        entry: "index.mjs",
        capabilities: ["schema"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(extensionDir, "index.mjs"),
    [
      "export function activate(api) {",
      "  api.registerItemTypes([",
      `    { name: \"${typeName}\", folder: \"${typeName.toLowerCase()}\" },`,
      "  ]);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("runTestAll", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-test-all-not-init-"));
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
      await expect(runTestAll({ status: "invalid" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
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

      const inProgressOnly = await runTestAll({ status: "in-progress" }, { path: context.pmPath });
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
        testEntries: ["command=node -e \"process.stdout.write('skip-placeholder')\",scope=project"],
      });
      await overwriteTaskTests(context, skippedTaskId, [{ path: "tests/sample.spec.ts", scope: "project" }]);
      createTaskWithTests(context, {
        title: "Closed Task",
        status: "closed",
        testEntries: ["command=node --version,scope=project"],
      });

      const openOnly = await runTestAll({ status: "open", timeout: "30" }, { path: context.pmPath });
      expect(openOnly.totals.items).toBe(3);
      expect(openOnly.totals.linked_tests).toBe(3);
      expect(openOnly.passed).toBeGreaterThanOrEqual(1);
      expect(openOnly.failed).toBeGreaterThanOrEqual(1);
      expect(openOnly.skipped).toBeGreaterThanOrEqual(1);
      expect(openOnly.totals.failure_categories.assertion_failure).toBeGreaterThanOrEqual(1);
      expect(openOnly.results.every((entry) => entry.status === "open")).toBe(true);
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
          "command=node -e \"process.stdout.write([process.env.RUN_LEVEL||'',process.env.PORT||'',process.env.PM_SHARED_HOST_SAFE||'',String(process.env.DELETE_ME===undefined)].join('|'))\",scope=project,env_set=Z_HINT=yes;A_HINT=yes,env_clear=DELETE_ME",
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
      expect(result.totals.items).toBe(1);
      expect(result.totals.linked_tests).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.passed).toBe(1);
      expect(result.results[0]?.run_results[0]?.stdout ?? "").toContain("run-level|0|1|true");
    });
  });

  it("executes linked commands with project and global extension type parity", async () => {
    await withTempPmPath(async (context) => {
      const globalPmRoot = context.env.PM_GLOBAL_PATH;
      expect(typeof globalPmRoot).toBe("string");
      await writeSchemaTypeExtension(context.pmPath, "project-test-all-type", "ProjectAsset");
      await writeSchemaTypeExtension(globalPmRoot as string, "global-test-all-type", "GlobalAsset");

      createTaskWithTests(context, {
        title: "Project Type Filter Source",
        status: "open",
        testEntries: ["command=node dist/cli.js list --type ProjectAsset --limit 1 --json,scope=project"],
      });
      createTaskWithTests(context, {
        title: "Global Type Filter Source",
        status: "open",
        testEntries: ["command=node dist/cli.js list --type GlobalAsset --limit 1 --json,scope=project"],
      });

      const result = await runTestAll({ status: "open", timeout: "30", pmContext: "tracker" }, { path: context.pmPath });
      expect(result.totals.items).toBe(2);
      expect(result.totals.linked_tests).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.passed).toBe(2);
      expect(result.skipped).toBe(0);
    });
  });

  it("deduplicates duplicate command and path entries across items", async () => {
    await withTempPmPath(async (context) => {
      const duplicateCommand = "command=node -e \"process.stdout.write('dup-command-token')\",scope=project";
      const uniqueCommand = "command=node -e \"process.stdout.write('unique-command-token')\",scope=project";
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
        { command: "node -e \"process.stdout.write('dup-command-token')\"", scope: "project" },
        { path: duplicatePath, scope: "project" },
      ]);
      await overwriteTaskTests(context, secondDuplicateId, [
        { command: "node -e \"process.stdout.write('dup-command-token')\"", scope: "project" },
        { path: duplicatePath, scope: "project" },
        { command: "node -e \"process.stdout.write('unique-command-token')\"", scope: "project" },
      ]);

      const result = await runTestAll({ status: "open", timeout: "30" }, { path: context.pmPath });
      expect(result.totals.items).toBe(2);
      expect(result.totals.linked_tests).toBe(5);
      expect(result.passed).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(3);

      const runResults = result.results.flatMap((entry) => entry.run_results);
      const duplicateCommandRuns = runResults.filter((entry) => (entry.command ?? "").includes("dup-command-token"));
      expect(duplicateCommandRuns).toHaveLength(2);
      expect(duplicateCommandRuns.filter((entry) => entry.status === "passed")).toHaveLength(1);
      expect(duplicateCommandRuns.filter((entry) => entry.status === "skipped")).toHaveLength(1);
      expect(duplicateCommandRuns.some((entry) => (entry.error ?? "").includes("Duplicate linked test skipped"))).toBe(true);

      const duplicatePathRuns = runResults.filter((entry) => entry.path === "tests/duplicate-path.spec.ts");
      expect(duplicatePathRuns).toHaveLength(2);
      expect(duplicatePathRuns.filter((entry) => entry.status === "skipped")).toHaveLength(2);
      expect(duplicatePathRuns.some((entry) => (entry.error ?? "").includes("No command configured"))).toBe(true);
      expect(duplicatePathRuns.some((entry) => (entry.error ?? "").includes("Duplicate linked test skipped"))).toBe(true);

      const uniqueCommandRuns = runResults.filter((entry) => (entry.command ?? "").includes("unique-command-token"));
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
          command: "node -e \"process.stderr.write('warn\\\\n'); process.stdout.write(JSON.stringify({count:2,a:1,z:1}))\"",
          scope: "project",
          assert_stdout_contains: ["count", "a"],
          assert_stdout_regex: ["count", "\\\\{\\\"count\\\""],
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
          command: "node -e \"process.stderr.write('warn\\\\n'); process.stdout.write(JSON.stringify({count:2,a:1,z:1}))\"",
          scope: "project",
          assert_stdout_contains: ["count", "a"],
          assert_stdout_regex: ["count", "\\\\{\\\"count\\\""],
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

      const result = await runTestAll({ status: "open", timeout: "20" }, { path: context.pmPath });
      expect(result.totals.items).toBe(2);
      expect(result.totals.linked_tests).toBe(2);
      expect(result.passed + result.failed + result.skipped).toBe(2);
      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(result.skipped).toBe(0);
      const runResults = result.results.flatMap((entry) => entry.run_results);
      expect(runResults.filter((entry) => entry.command?.includes("JSON.stringify({count:2,a:1,z:1})"))).toHaveLength(2);
      expect(runResults.some((entry) => (entry.error ?? "").includes("Duplicate linked test skipped"))).toBe(false);
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

      await overwriteTaskTests(context, firstId, [{ command: "node --version", scope: "project", shared_host_safe: true }]);
      await overwriteTaskTests(context, secondId, [{ command: "node --version", scope: "project", shared_host_safe: false }]);

      const result = await runTestAll({ status: "open", timeout: "20" }, { path: context.pmPath });
      expect(result.totals.items).toBe(2);
      expect(result.totals.linked_tests).toBe(2);
      expect(result.passed).toBe(2);
      expect(result.skipped).toBe(0);
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

      const result = await runTestAll({ status: "open" }, { path: context.pmPath });
      expect(result.totals.items).toBe(2);
      expect(result.totals.linked_tests).toBe(2);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(1);

      const runResults = result.results.flatMap((entry) => entry.run_results);
      const slowRuns = runResults.filter((entry) => (entry.command ?? "").includes("slow-dup-timeout-token"));
      expect(slowRuns).toHaveLength(2);
      expect(slowRuns.filter((entry) => entry.status === "passed")).toHaveLength(1);
      expect(slowRuns.filter((entry) => entry.status === "skipped")).toHaveLength(1);
      expect(slowRuns.some((entry) => (entry.error ?? "").includes("Duplicate linked test skipped"))).toBe(true);
    });
  });

  it("deterministically keeps the larger timeout when duplicate commands appear in one item", async () => {
    await withTempPmPath(async (context) => {
      const slowDuplicateCommand =
        "command=node -e \"const end=Date.now()+1100; while(Date.now()<end){}; process.stdout.write('single-item-timeout-token')\",scope=project";

      createTaskWithTests(context, {
        title: "Single Item Timeout Variants",
        status: "open",
        testEntries: [`${slowDuplicateCommand},timeout_seconds=1`, `${slowDuplicateCommand},timeout_seconds=5`],
      });

      const result = await runTestAll({ status: "open" }, { path: context.pmPath });
      expect(result.totals.items).toBe(1);
      expect(result.totals.linked_tests).toBe(2);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(1);

      const timeoutRuns = result.results
        .flatMap((entry) => entry.run_results)
        .filter((entry) => (entry.command ?? "").includes("single-item-timeout-token"));
      expect(timeoutRuns).toHaveLength(2);
      expect(timeoutRuns.filter((entry) => entry.status === "passed")).toHaveLength(1);
      expect(timeoutRuns.filter((entry) => entry.status === "skipped")).toHaveLength(1);
    });
  });

  it("deduplicates equal-timeout duplicate commands deterministically", async () => {
    await withTempPmPath(async (context) => {
      const equalTimeoutCommand = "command=node -e \"process.stdout.write('equal-timeout-token')\",scope=project";

      createTaskWithTests(context, {
        title: "Equal Timeout Duplicate Source",
        status: "open",
        testEntries: [`${equalTimeoutCommand},timeout_seconds=3,note=first`, `${equalTimeoutCommand},timeout_seconds=3,note=second`],
      });

      const result = await runTestAll({ status: "open" }, { path: context.pmPath });
      expect(result.totals.items).toBe(1);
      expect(result.totals.linked_tests).toBe(2);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(1);

      const runResults = result.results.flatMap((entry) => entry.run_results);
      const equalRuns = runResults.filter((entry) => (entry.command ?? "").includes("equal-timeout-token"));
      expect(equalRuns).toHaveLength(2);
      expect(equalRuns.filter((entry) => entry.status === "passed")).toHaveLength(1);
      expect(equalRuns.filter((entry) => entry.status === "skipped")).toHaveLength(1);
    });
  });

  it("keeps the existing timeout when duplicate command omits timeout_seconds", async () => {
    await withTempPmPath(async (context) => {
      const mixedTimeoutId = createTaskWithTests(context, {
        title: "Mixed Timeout Duplicate Source",
        status: "open",
        testEntries: ["command=node -e \"process.stdout.write('mixed-timeout-seed')\",scope=project"],
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

      const result = await runTestAll({ status: "open" }, { path: context.pmPath });
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
        ["config", "project", "set", "item-format", "--format", "json_markdown", "--json"],
        { expectJson: true },
      );
      expect(formatResult.code).toBe(0);

      const mixedTimeoutId = createTaskWithTests(context, {
        title: "Mixed Path Timeout Duplicate Source",
        status: "open",
        testEntries: ["command=node -e \"process.stdout.write('mixed-path-timeout-seed')\",scope=project"],
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

      const result = await runTestAll({ status: "open" }, { path: context.pmPath });
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
        testEntries: ["command=node -e \"process.stdout.write('placeholder-a')\",scope=project"],
      });
      const malformedB = createTaskWithTests(context, {
        title: "Malformed B",
        status: "open",
        testEntries: ["command=node -e \"process.stdout.write('placeholder-b')\",scope=project"],
      });

      await overwriteTaskTests(context, malformedA, [{ scope: "project" }]);
      await overwriteTaskTests(context, malformedB, [{ scope: "project" }]);

      const result = await runTestAll({ status: "open", timeout: "30" }, { path: context.pmPath });
      expect(result.totals.items).toBe(2);
      expect(result.totals.linked_tests).toBe(2);
      expect(result.passed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(2);

      const runResults = result.results.flatMap((entry) => entry.run_results);
      expect(runResults).toHaveLength(2);
      expect(runResults.every((entry) => entry.status === "skipped")).toBe(true);
      expect(runResults.some((entry) => (entry.error ?? "").includes("No command configured for this linked test."))).toBe(
        true,
      );
      expect(runResults.some((entry) => (entry.error ?? "").includes("Duplicate linked test skipped"))).toBe(true);
    });
  });

  it("reports fail-on-skipped aggregate policy triggers", async () => {
    await withTempPmPath(async (context) => {
      const malformed = createTaskWithTests(context, {
        title: "Fail On Skipped Aggregate",
        status: "open",
        testEntries: ["command=node -e \"process.stdout.write('placeholder')\",scope=project"],
      });
      await overwriteTaskTests(context, malformed, [{ path: "tests/legacy-path-only.spec.ts", scope: "project" }]);
      const result = await runTestAll({ status: "open", failOnSkipped: true }, { path: context.pmPath });
      expect(result.skipped).toBeGreaterThan(0);
      expect(result.fail_on_skipped_triggered).toBe(true);
    });
  });

  it("supports PM context mismatch guards and PM assertion policy in test-all", async () => {
    await withTempPmPath(async (context) => {
      createTaskWithTests(context, {
        title: "Test-All PM Context Guard",
        status: "open",
        testEntries: ["command=node dist/cli.js list-all --type Task --limit 200 --json,scope=project"],
      });

      const schemaDefault = await runTestAll(
        {
          status: "open",
        },
        { path: context.pmPath },
      );
      expect(schemaDefault.failed).toBe(1);
      expect(schemaDefault.results[0]?.run_results[0]?.error ?? "").toContain("context mismatch");

      const schemaStrict = await runTestAll(
        {
          status: "open",
          failOnContextMismatch: true,
        },
        { path: context.pmPath },
      );
      expect(schemaStrict.failed).toBe(1);
      expect(schemaStrict.results[0]?.run_results[0]?.error ?? "").toContain("context mismatch");

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
      expect(requireAssertions.results[0]?.run_results[0]?.error ?? "").toContain("requires assertions");
    });
  });

  it("runs unique markdown-format tests without injecting timeout_seconds", async () => {
    await withTempPmPath(async (context) => {
      const formatResult = context.runCli(
        ["config", "project", "set", "item-format", "--format", "json_markdown", "--json"],
        { expectJson: true },
      );
      expect(formatResult.code).toBe(0);

      createTaskWithTests(context, {
        title: "Markdown Unique Timeout Source",
        status: "open",
        testEntries: ["command=node -e \"process.stdout.write('markdown-unique-timeout-token')\",scope=project"],
      });

      const result = await runTestAll({ status: "open" }, { path: context.pmPath });
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
        testEntries: ['command=node -e "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)",scope=project'],
      });

      const previousForceKillDelay = process.env.PM_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS;
      process.env.PM_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS = "20";
      try {
        const startedAt = Date.now();
        const result = await runTestAll({ status: "open", timeout: "0.02" }, { path: context.pmPath });
        const elapsedMs = Date.now() - startedAt;

        expect(elapsedMs).toBeLessThan(3000);
        expect(result.totals.items).toBe(1);
        expect(result.totals.linked_tests).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.passed).toBe(0);
        expect(result.skipped).toBe(0);
        expect(result.results[0]?.run_results[0]?.status).toBe("failed");
        expect(result.results[0]?.run_results[0]?.error ?? "").toContain("timed out after");
      } finally {
        if (previousForceKillDelay === undefined) {
          delete process.env.PM_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS;
        } else {
          process.env.PM_LINKED_TEST_TIMEOUT_FORCE_KILL_DELAY_MS = previousForceKillDelay;
        }
      }
    });
  });

  it("emits linked-test progress when progress mode is forced in non-interactive runs", async () => {
    await withTempPmPath(async (context) => {
      createTaskWithTests(context, {
        title: "Forced Progress Test-All Source",
        status: "open",
        testEntries: ['command=node -e "setTimeout(() => {}, 60)",scope=project,timeout_seconds=5'],
      });

      const previousHeartbeatInterval = process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS;
      process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS = "10";
      const originalIsTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, "isTTY", {
        value: false,
        configurable: true,
      });
      const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const result = await runTestAll({ status: "open", timeout: "5", progress: true }, { path: context.pmPath });
        expect(result.totals.items).toBe(1);
        expect(result.passed).toBe(1);
        expect(result.failed).toBe(0);
        expect(result.skipped).toBe(0);

        const stderrOutput = stderrWriteSpy.mock.calls.map((entry) => String(entry[0])).join("");
        expect(stderrOutput).toContain("[pm test] linked-test 1/1 start");
        expect(stderrOutput).toContain("[pm test] linked-test 1/1 running");
        expect(stderrOutput).toContain("[pm test] linked-test 1/1 end status=passed");
      } finally {
        if (previousHeartbeatInterval === undefined) {
          delete process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS;
        } else {
          process.env.PM_LINKED_TEST_HEARTBEAT_INTERVAL_MS = previousHeartbeatInterval;
        }
        Object.defineProperty(process.stderr, "isTTY", {
          value: originalIsTTY,
          configurable: true,
        });
      }
    });
  });
});
