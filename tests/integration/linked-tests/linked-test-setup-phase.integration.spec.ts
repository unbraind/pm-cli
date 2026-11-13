/** GH-1671: linked-test setup entries run first in the shared sandbox, stop the run when they fail, and need item format 3. */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runTest } from "../../../src/sdk/test/execution.js";
import { runTestAll } from "../../../src/sdk/test/batch.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

// Both commands run in the per-run isolated workspace, so nothing touches the source checkout.
const WRITE_BUILD = `node -e "require('fs').writeFileSync('built.txt','ok')"`;
const READ_BUILD = `node -e "require('fs').readFileSync('built.txt'); console.log('Tests 1 passed')"`;
const isolated = (command: string, phase?: "setup") => ({
  command,
  workspace_context_mode: "isolated",
  ...(phase === undefined ? {} : { phase }),
});

async function readItemFile(context: TempPmContext, id: string): Promise<string> {
  const name = (await readdir(path.join(context.pmPath, "tasks"))).find((file) => file.startsWith(`${id}.`));
  return await readFile(path.join(context.pmPath, "tasks", name!), "utf8");
}

describe("linked-test setup phase", () => {
  it("runs a setup entry before the regular command in the same sandbox; without it the command fails", async () => {
    await withTempPmPath(async (context) => {
      const global = { path: context.pmPath };
      const id = createTestItemId(context, { title: "setup ordering", createMode: "progressive" });
      await runTest(id, { addJson: [JSON.stringify(isolated(READ_BUILD))] }, global);
      // Negative control: the regular command needs the setup's output.
      const withoutSetup = await runTest(id, { run: true }, global);
      expect(withoutSetup.ok).toBe(false);
      expect(withoutSetup.run_results.map((row) => row.status)).toEqual(["failed"]);
      expect(await readItemFile(context, id)).not.toContain("pm_format_version");

      // Stored after the regular command, the setup entry still runs first.
      await runTest(id, { addJson: [JSON.stringify(isolated(WRITE_BUILD, "setup"))] }, global);
      const stored = await readItemFile(context, id);
      expect(stored).toContain("pm_format_version: 3");
      expect(stored).toContain("phase: setup");
      const run = await runTest(id, { run: true }, global);
      expect(run.ok).toBe(true);
      expect(run.run_results.map((row) => [row.command, row.status, row.phase])).toEqual([
        [WRITE_BUILD, "passed", "setup"],
        [READ_BUILD, "passed", undefined],
      ]);
      expect(run.selection).toMatchObject({ selected_indexes: [2, 1], selected_count: 2, skipped_count: 0 });
      expect(run.failure_categories?.setup_failed).toBe(0);

      // Selecting only the regular command still runs the setup first and reports it.
      const selected = await runTest(id, { run: true, onlyIndex: 1 }, global);
      expect(selected.run_results.map((row) => row.status)).toEqual(["passed", "passed"]);
      expect(selected.selection).toMatchObject({ selector: "only-index", selected_indexes: [2, 1], setup_indexes: [2] });

      // Through the CLI, the quiet run reports a passing setup row like any other.
      const cli = context.runCli(["test", id, "--run", "--json"], { expectJson: true });
      expect(cli.code).toBe(0);
    });
  }, 60_000);

  it("reports a failing setup as setup_failed and runs no later linked command", async () => {
    await withTempPmPath(async (context) => {
      const global = { path: context.pmPath };
      const id = createTestItemId(context, { title: "setup failure", createMode: "progressive" });
      const markerPath = path.join(context.tempRoot, "ran.txt").replaceAll("\\", "/");
      const marker = `node -e "require('fs').writeFileSync('${markerPath}', 'x')"`;
      await runTest(id, { addJson: [JSON.stringify([
        isolated(`node -e "process.exit(3)"`, "setup"),
        isolated(WRITE_BUILD, "setup"),
        { command: marker },
      ])] }, global);
      const run = await runTest(id, { run: true }, global);
      expect(run.ok).toBe(false);
      expect(run.run_results.map((row) => [row.status, row.phase, row.failure_category])).toEqual([
        ["failed", "setup", "setup_failed"],
        ["skipped", "setup", undefined],
        ["skipped", undefined, undefined],
      ]);
      expect(run.run_results[0]).toMatchObject({ exit_code: 3, setup_failure_cause: "assertion_failure" });
      expect(run.run_results[2]?.error).toBe(
        `Skipped because setup entry "node -e "process.exit(3)"" did not pass (setup_failed); no later linked command ran.`,
      );
      expect(run.failure_categories).toMatchObject({ setup_failed: 1, assertion_failure: 0 });
      await expect(readFile(path.join(context.tempRoot, "ran.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const cli = context.runCli(["test", id, "--run", "--json"], { expectJson: true });
      expect(cli.code).not.toBe(0);
      expect((cli.json as { failure_categories: Record<string, number> }).failure_categories.setup_failed).toBe(1);
    });
  }, 60_000);

  it("runs each item's setup for that item in test-all instead of deduplicating it across items", async () => {
    await withTempPmPath(async (context) => {
      const global = { path: context.pmPath };
      const ids = [
        createTestItemId(context, { title: "first item", createMode: "progressive" }),
        createTestItemId(context, { title: "second item", createMode: "progressive" }),
      ];
      for (const [index, id] of ids.entries()) {
        // Distinct regular commands, so the cross-item dedup of regular tests does not hide either one.
        const read = READ_BUILD.replace("Tests 1 passed", `Tests 1 passed for item ${index + 1}`);
        await runTest(id, { addJson: [JSON.stringify([isolated(read), isolated(WRITE_BUILD, "setup")])] }, global);
      }
      const batch = await runTestAll({}, global);
      expect(batch.ok).toBe(true);
      // A deduplicated setup would leave the second item's isolated sandbox without built.txt.
      expect(batch.results.map((result) => result.run_results.map((row) => [row.status, row.phase]))).toEqual([
        [["passed", "setup"], ["passed", undefined]],
        [["passed", "setup"], ["passed", undefined]],
      ]);
    });
  }, 60_000);

  it("accepts phase on every intake path, edits it as metadata and refuses unknown phases before persistence", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli([
        "create", "Task", "created with setup", "--create-mode", "progressive",
        "--test", "command=node -e 1,phase=setup", "--json",
      ], { expectJson: true });
      expect(created.code).toBe(0);
      // The test runner may request the legacy full create envelope; read the id from either shape.
      const receipt = created.json as { id?: string; item?: { id: string } };
      const id = (receipt.item?.id ?? receipt.id) as string;
      expect((await runTest(id, { list: true }, { path: context.pmPath })).tests.map((test) => test.phase)).toEqual(["setup"]);
      const before = await readItemFile(context, id);
      expect(before).toContain("pm_format_version: 3");
      for (const args of [
        ["test", id, "--add", "command=node -e 2,phase=teardown"],
        ["test", id, "--add-json", '{"command":"node -e 2","phase":"teardown"}'],
        ["update", id, "--test", "command=node -e 2,phase=teardown"],
      ]) {
        const refused = context.runCli([...args, "--json"]);
        expect(refused.code).toBe(2);
        expect(refused.stderr).toContain('phase\\" must be one of: setup, test');
        expect(await readItemFile(context, id)).toBe(before);
      }
      const added = context.runCli(["test", id, "--add", "command=node -e 3,phase=test", "--json"], { expectJson: true });
      expect(added.code).toBe(0);
      expect((added.json as { tests: Array<Record<string, unknown>> }).tests.every((test) => !("phase" in test))).toBe(true);
      // phase is editable metadata: promote the regular entry to a setup entry and back.
      const promoted = context.runCli(["test", id, "--update-index", "2", "--set-json", '{"phase":"setup"}', "--json"], { expectJson: true });
      expect(promoted.code).toBe(0);
      const listed = await runTest(id, { list: true }, { path: context.pmPath });
      expect(listed.tests.map((test) => test.phase)).toEqual(["setup", "setup"]);
      context.runCli(["test", id, "--update-index", "2", "--set-json", '{"phase":null}', "--json"]);
      const demoted = await runTest(id, { list: true }, { path: context.pmPath });
      expect(demoted.tests.map((test) => test.phase)).toEqual(["setup", undefined]);
    });
  }, 60_000);
});
