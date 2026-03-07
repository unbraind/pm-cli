import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runTestAll } from "../../src/cli/commands/test-all.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { parseItemDocument, serializeItemDocument } from "../../src/item-format.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createTaskWithTests(
  context: TempPmContext,
  params: {
    title: string;
    status: "open" | "closed";
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
  const taskPath = path.join(context.pmPath, "tasks", `${id}.md`);
  const source = await readFile(taskPath, "utf8");
  const parsed = parseItemDocument(source);
  parsed.front_matter.tests = tests as unknown as never;
  await writeFile(taskPath, serializeItemDocument(parsed), "utf8");
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
      createTaskWithTests(context, {
        title: "Skipped Task",
        status: "open",
        testEntries: ["path=tests/sample.spec.ts,scope=project"],
      });
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

  it("deduplicates duplicate command and path entries across items", async () => {
    await withTempPmPath(async (context) => {
      const duplicateCommand = "command=node -e \"process.stdout.write('dup-command-token')\",scope=project";
      const uniqueCommand = "command=node -e \"process.stdout.write('unique-command-token')\",scope=project";
      const duplicatePath = "path=tests/duplicate-path.spec.ts,scope=project";

      createTaskWithTests(context, {
        title: "First Duplicate Source",
        status: "open",
        testEntries: [duplicateCommand, duplicatePath],
      });
      createTaskWithTests(context, {
        title: "Second Duplicate Source",
        status: "open",
        testEntries: [duplicateCommand, duplicatePath, uniqueCommand],
      });

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

  it("handles malformed linked tests without path via deterministic duplicate skip behavior", async () => {
    await withTempPmPath(async (context) => {
      const malformedA = createTaskWithTests(context, {
        title: "Malformed A",
        status: "open",
        testEntries: ["path=tests/placeholder-a.spec.ts,scope=project"],
      });
      const malformedB = createTaskWithTests(context, {
        title: "Malformed B",
        status: "open",
        testEntries: ["path=tests/placeholder-b.spec.ts,scope=project"],
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
});
