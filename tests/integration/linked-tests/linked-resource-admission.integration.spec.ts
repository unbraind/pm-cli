import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_CODE, PmClient } from "../../../src/sdk/index.js";
import { runLinkedTests, runTest } from "../../../src/sdk/test/execution.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { overwriteTaskTests, setTestResultTracking } from "../../helpers/pmWorkspace.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

/** Retain item and history bytes, including unexpected creates and run receipts. */
async function capture(context: TempPmContext) {
  return Promise.all(["tasks", "history"].map(async (folder) =>
    Promise.all((await readdir(path.join(context.pmPath, folder))).sort().map(async (name) =>
      [name, await readFile(path.join(context.pmPath, folder, name), "utf8")]))));
}

describe("linked-resource admission and recovery", () => {
  it("refuses assignment-only tests through SDK and CLI without durable changes", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "No false test evidence", createMode: "progressive" });
      const client = new PmClient({ pmRoot: context.pmPath });
      const before = await capture(context);
      for (const attempt of [
        () => runTest(id, { add: ["status=passed"], run: true }, { path: context.pmPath }),
        () => runTest(id, { add: ["command=RESULT=passed # note"], run: true }, { path: context.pmPath }),
        () => runTest(id, { add: ["command=# note"], run: true }, { path: context.pmPath }),
        () => runTest(id, { add: ["command=RESULT=passed;"], run: true }, { path: context.pmPath }),
        () => runTest(id, { addJson: ['{"command":"RESULT=passed"}'] }, { path: context.pmPath }),
        () => client.update(id, { test: ["command=RESULT=passed"] }),
        () => client.create({ title: "Refused create", type: "Task", createMode: "progressive", test: ["command=RESULT=passed"] }),
      ]) {
        await expect(attempt()).rejects.toMatchObject({ code: "linked_test_command_not_executable", exitCode: 2 });
        expect(await capture(context)).toEqual(before);
      }
      for (const args of [
        ["test", id, "--add", "status=passed"],
        ["test", id, "--add", "command=RESULT=passed"],
        ["test", id, "--add-json", '{"command":"RESULT=passed; # note"}'],
        ["test", id, "--add-json", '{"command":"RESULT=passed"}'],
        ["update", id, "--test", "command=RESULT=passed"],
      ]) {
        const result = context.runCli([...args, "--json"]);
        expect(result.code).toBe(2);
        expect(JSON.parse(result.stderr)).toMatchObject({ code: "linked_test_command_not_executable" });
        expect(await capture(context)).toEqual(before);
      }
    });
  });

  it.each(["status=passed", "RESULT=passed # note", "RESULT=passed;"])("refuses legacy assignment-only execution %s without recording a pass, but permits removal", async (command) => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Legacy assignment", createMode: "progressive" });
      await setTestResultTracking(context.pmPath, true);
      await overwriteTaskTests(context, id, [{ command, scope: "project" }]);
      const before = await capture(context);
      await expect(runLinkedTests([{ command, scope: "project" }], 5)).rejects.toMatchObject({ code: "linked_test_command_not_executable" });
      const refused = context.runCli(["test", id, "--run", "--fail-on-empty-test-run", "--json"]);
      expect(refused.code).toBe(2);
      expect(JSON.parse(refused.stderr)).toMatchObject({ code: "linked_test_command_not_executable" });
      expect(JSON.parse(refused.stderr).required).toContain("--add");
      expect(await capture(context)).toEqual(before);
      await expect(runTest(id, { add: ["command=node --version"], run: true }, { path: context.pmPath })).rejects.toMatchObject({ code: "linked_test_command_not_executable", context: { changed: false } });
      expect(await capture(context)).toEqual(before);
      const selected = await runTest(id, { add: ["command=node --version"], run: true, onlyLast: true }, { path: context.pmPath });
      expect(selected.run_results).toMatchObject([{ status: "passed" }]);
      expect(context.runCli(["test", id, "--remove", `command=${command}`, "--json"]).code).toBe(0);
    });
  });

  it.skipIf(process.platform === "win32")("executes real commands after quoted environment assignments", async () => {
    const results = await runLinkedTests([{ command: 'IGNORED=1;# first line\nVALUE="two words" node -e "console.log(process.env.VALUE)";', scope: "project" }], 5);
    expect(results).toMatchObject([{ status: "passed", stdout: "two words\n" }]);
  });

  it("repairs positional paths using executable argv while leaving the refused operation unchanged", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Copyable resource recovery", createMode: "progressive" });
      for (const command of ["files", "docs"]) {
        for (const value of ["a path with 'quotes' and $variables.md", 'a, path with "quotes".md']) {
          const before = await capture(context);
          const refused = context.runCli([command, id, value, "--json"]);
          expect(refused.code).toBe(2);
          const error = JSON.parse(refused.stderr) as { recovery: { suggested_retry_args: string[] } };
          expect(error.recovery.suggested_retry_args).toEqual(["--full-changed-fields", "item", command, id, "--add", `path=${JSON.stringify(value)}`, "--json"]);
          expect(await capture(context)).toEqual(before);
          expect(context.runCli(error.recovery.suggested_retry_args).code).toBe(0);
          const stored = context.runCli(["get", id, "--full", "--json"], { expectJson: true }).json as { item: Record<string, unknown> };
          expect(stored.item[command]).toContainEqual(expect.objectContaining({ path: value }));
        }
      }
      const before = await capture(context);
      const refused = context.runCli(["test", id, "timeout_seconds=3600", "--json"]);
      expect(refused.code).toBe(2);
      const error = JSON.parse(refused.stderr) as { required: string; recovery: { suggested_retry_args?: string[] } };
      expect(error.required).toContain("command");
      expect(error.required).toContain("timeout_seconds=3600");
      expect(error.recovery.suggested_retry_args).toBeUndefined();
      expect(await capture(context)).toEqual(before);
    });
  });

  it("replays explicitly structured test commands without swallowing timeout metadata", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Structured test recovery", createMode: "progressive" });
      for (const key of ["command", "cmd"]) {
        const before = await capture(context);
        const refused = context.runCli(["test", id, `${key}=node --version,timeout_seconds=90`, "--json"]);
        expect(refused.code).toBe(2);
        expect(await capture(context)).toEqual(before);
        const error = JSON.parse(refused.stderr) as { recovery: { suggested_retry_args: string[] } };
        expect(context.runCli(error.recovery.suggested_retry_args).code).toBe(0);
        const stored = await new PmClient({ pmRoot: context.pmPath }).get(id, { full: true });
        expect(stored.item.tests).toContainEqual(expect.objectContaining({ command: "node --version", timeout_seconds: 90 }));
      }
      const literal = 'node -e "console.log(1,2)"';
      const refused = context.runCli(["test", id, literal, "--json"]);
      expect(refused.code).toBe(2);
      const error = JSON.parse(refused.stderr) as { recovery: { suggested_retry_args: string[] } };
      expect(context.runCli(error.recovery.suggested_retry_args).code).toBe(0);
      const stored = await new PmClient({ pmRoot: context.pmPath }).get(id, { full: true });
      expect(stored.item.tests).toContainEqual(expect.objectContaining({ command: literal }));
    });
  });

  it("never suggests registering a positional command that SDK admission would refuse", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Admitted recovery only", createMode: "progressive" });
      const before = await capture(context);
      for (const value of ["command=RESULT=passed,timeout_seconds=90", "cmd=# note", "# note", "command=RESULT=passed;"]) {
        const refused = context.runCli(["test", id, value, "--json"]);
        expect(refused.code).toBe(2);
        const error = JSON.parse(refused.stderr) as { required: string; recovery: { suggested_retry_args?: string[] } };
        expect(error.recovery.suggested_retry_args).toBeUndefined();
        expect(error.required).toContain("command=<actual command>");
        expect(error.required).toContain(`test ${id}`);
        expect(await capture(context)).toEqual(before);
      }
    });
  });

  it("returns a complete CLI batch with legacy configuration refusals and later successes", async () => {
    await withTempPmPath(async (context) => {
      const ids = ["Before", "Mixed", "After"].map((title) => createTestItemId(context, { title, createMode: "progressive" })).sort();
      await overwriteTaskTests(context, ids[0], [{ command: "node --version", scope: "project" }]);
      await overwriteTaskTests(context, ids[1], [{ command: "RESULT=passed # note", scope: "project" }, { command: 'node -e "console.log(\'middle\')"', scope: "project" }]);
      await overwriteTaskTests(context, ids[2], [{ command: 'node -e "console.log(\'last\')"', scope: "project" }]);
      await setTestResultTracking(context.pmPath, false);
      const before = await capture(context);
      const batch = context.runCli(["test-all", "--json"]);
      expect(batch.code).toBe(EXIT_CODE.DEPENDENCY_FAILED);
      const result = JSON.parse(batch.stdout);
      expect(result).toMatchObject({ ok: false, passed: 3, failed: 1, skipped: 0, totals: { items: 3, linked_tests: 4, failure_categories: { config_refusal: 1 } } });
      expect(result.results.map((entry: { id: string }) => entry.id)).toEqual(ids);
      expect(result.results[1].run_results).toMatchObject([{ status: "refused", failure_category: "config_refusal", exit_code: null }, { status: "passed", stdout: "middle\n" }]);
      expect(result.results[2].run_results).toMatchObject([{ status: "passed", stdout: "last\n" }]);
      expect(await capture(context)).toEqual(before);
    });
  });
});
