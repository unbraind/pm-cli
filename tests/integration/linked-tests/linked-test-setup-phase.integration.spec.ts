/** GH-1671: linked-test setup entries run first in the shared sandbox, stop the run when they fail, and need item format 3. */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCreate } from "../../../src/sdk/lifecycle/create.js";
import { runLinkedTests, runTest } from "../../../src/sdk/test/execution.js";
import { _testOnlyTestAll, runTestAll } from "../../../src/sdk/test/batch.js";
import type { LinkedTest } from "../../../src/types/index.js";
import { overwriteTaskTests } from "../../helpers/pmWorkspace.js";
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

  it("blocks an item's later entries behind a refused setup in test-all and never reserves their dedupe keys", async () => {
    await withTempPmPath(async (context) => {
      const global = { path: context.pmPath };
      const markerPath = path.join(context.tempRoot, "ran.txt").replaceAll("\\", "/");
      const marker = `node -e "require('fs').appendFileSync('${markerPath}', 'x')"`;
      const refusedId = createTestItemId(context, { title: "refused setup", createMode: "progressive" });
      const laterId = createTestItemId(context, { title: "same command later", createMode: "progressive" });
      await runTest(refusedId, { addJson: [JSON.stringify([{ command: "node -e 1", phase: "setup" }, { command: marker }])] }, global);
      // An imported assignment-only setup is refused before dispatch; nothing after it may run.
      const stored = (await runTest(refusedId, { list: true }, global)).tests;
      await overwriteTaskTests(context, refusedId, [{ ...stored[0], command: "X=1" }, stored[1]] as unknown as Array<Record<string, unknown>>);
      await runTest(laterId, { addJson: [JSON.stringify({ command: marker })] }, global);
      const batch = await runTestAll({}, global);
      const byId = new Map(batch.results.map((result) => [result.id, result]));
      expect(byId.get(refusedId)?.run_results.map((row) => [row.status, row.phase, row.failure_category])).toEqual([
        ["refused", "setup", "config_refusal"],
        ["skipped", undefined, undefined],
      ]);
      // The other item's identical command has a different setup signature, so it runs: exactly one marker write.
      expect(byId.get(laterId)?.run_results.map((row) => row.status)).toEqual(["passed"]);
      expect(await readFile(path.join(context.tempRoot, "ran.txt"), "utf8")).toBe("x");
    });
  }, 60_000);

  it("deduplicates a regular test across items only when their setup entries match, and frees the key when the setup fails", async () => {
    await withTempPmPath(async (context) => {
      const global = { path: context.pmPath };
      const [built, empty, flakyFirst, flakySecond] = ["built", "no build", "flaky first", "flaky second"].map((title) =>
        createTestItemId(context, { title, createMode: "progressive" }),
      );
      // Same regular command, different setup: the second item must run (and fail) it, not skip it as a duplicate.
      await runTest(built!, { addJson: [JSON.stringify([isolated(WRITE_BUILD, "setup"), isolated(READ_BUILD)])] }, global);
      await runTest(empty!, { addJson: [JSON.stringify([isolated(`node -e "0"`, "setup"), isolated(READ_BUILD)])] }, global);
      // Identical setups whose first execution fails: the second item still runs the command.
      const flagPath = path.join(context.tempRoot, "flaky.flag").replaceAll("\\", "/");
      const flaky = `node -e "const fs=require('fs'); if (!fs.existsSync('${flagPath}')) { fs.writeFileSync('${flagPath}', ''); process.exit(1); } fs.writeFileSync('built.txt', 'ok')"`;
      const flakyRead = READ_BUILD.replace("Tests 1 passed", "Tests 1 passed flaky");
      for (const id of [flakyFirst!, flakySecond!]) {
        await runTest(id, { addJson: [JSON.stringify([isolated(flaky, "setup"), isolated(flakyRead)])] }, global);
      }
      const batch = await runTestAll({}, global);
      const byId = new Map(batch.results.map((result) => [result.id, result.run_results.map((row) => row.status)]));
      expect(byId.get(built!)).toEqual(["passed", "passed"]);
      expect(byId.get(empty!)).toEqual(["passed", "failed"]);
      const flakyRows = [byId.get(flakyFirst!), byId.get(flakySecond!)];
      expect(flakyRows).toContainEqual(["failed", "skipped"]);
      expect(flakyRows).toContainEqual(["passed", "passed"]);
      expect(batch.ok).toBe(false);
    });
  }, 90_000);

  it("keys test-all timeouts by setup signature and leaves every setup entry its own timeout", () => {
    const setup = (timeout: number, command = "npm run build"): LinkedTest => ({ command, scope: "project", phase: "setup", timeout_seconds: timeout });
    const regular = (timeout: number): LinkedTest => ({ command: "node --test", scope: "project", timeout_seconds: timeout });
    const item = (id: string, tests: LinkedTest[]) => ({ item: { id, status: "open" as const }, tests });
    const map = _testOnlyTestAll.buildEffectiveTimeoutByKey([
      item("pm-a", [setup(1), regular(30)]),
      item("pm-b", [setup(300), regular(60)]),
      item("pm-c", [regular(90)]),
      item("pm-d", [setup(5, "npm run other"), regular(10)]),
      // Codex round 2: the dedupe key collapses whitespace, but quoted whitespace changes what a setup writes.
      item("pm-e", [setup(5, `node -e "write('a  b')"`), regular(20)]),
      item("pm-f", [setup(5, `node -e "write('a b')"`), regular(25)]),
    ] as never);
    const plainKey = _testOnlyTestAll.buildLinkedTestKey(regular(0));
    // Setups are absent (each runs with its own timeout); regular tests key on their item's setup signature.
    expect([...map.keys()].some((key) => key.startsWith("command:project:npm run"))).toBe(false);
    expect(map.get(plainKey)).toBe(90);
    // Items with the same setup share one key and its widest timeout; a different setup gets its own key.
    const setupKeys = [...map.keys()].filter((key) => key.includes(":setup["));
    expect(setupKeys).toHaveLength(4);
    expect(setupKeys.map((key) => map.get(key)).sort((left, right) => Number(left) - Number(right))).toEqual([10, 20, 25, 60]);
  });

  it("exempts a setup entry from the implicit name-filter receipt check that a regular command must pass", async () => {
    await withTempPmPath(async (context) => {
      const global = { path: context.pmPath };
      const filtered = `node -e "0" -- --test-name-pattern=warmup`;
      const id = createTestItemId(context, { title: "filtered setup", createMode: "progressive" });
      await runTest(id, { addJson: [JSON.stringify([{ command: filtered, phase: "setup" }, { command: `node -e "console.log('Tests 1 passed')"` }])] }, global);
      const run = await runTest(id, { run: true }, global);
      expect(run.run_results.map((row) => [row.status, row.phase])).toEqual([["passed", "setup"], ["passed", undefined]]);
      // Negative control: the same command as a regular test still needs a positive execution receipt.
      const regular = createTestItemId(context, { title: "filtered regular", createMode: "progressive" });
      await runTest(regular, { addJson: [JSON.stringify({ command: filtered })] }, global);
      expect((await runTest(regular, { run: true }, global)).run_results[0]).toMatchObject({ status: "failed", failure_category: "empty_run" });
    });
  }, 60_000);

  it("reports a refusal planned after a setup that fails at run time as the skip it became", async () => {
    await withTempPmPath(async (context) => {
      const global = { path: context.pmPath };
      const id = createTestItemId(context, { title: "runtime setup failure", createMode: "progressive" });
      await runTest(id, { addJson: [JSON.stringify([{ command: `node -e "process.exit(1)"`, phase: "setup" }, { command: "node -e 2" }])] }, global);
      const stored = (await runTest(id, { list: true }, global)).tests;
      await overwriteTaskTests(context, id, [stored[0], { ...stored[1], command: "X=1" }] as unknown as Array<Record<string, unknown>>);
      const batch = await runTestAll({}, global);
      const result = batch.results.find((entry) => entry.id === id)!;
      expect(result.run_results.map((row) => [row.status, row.phase, row.failure_category])).toEqual([
        ["failed", "setup", "setup_failed"],
        ["skipped", undefined, undefined],
      ]);
      expect(result.failure_categories).toMatchObject({ setup_failed: 1, config_refusal: 0 });
    });
  }, 60_000);

  it("orders setup entries first inside the exported runLinkedTests and fails a setup entry that cannot execute", async () => {
    await withTempPmPath(async (context) => {
      const results = await runLinkedTests(
        [isolated(READ_BUILD) as LinkedTest, isolated(WRITE_BUILD, "setup") as LinkedTest],
        60,
        { sourceRoots: { projectPmRoot: context.pmPath, globalPmRoot: context.env.PM_GLOBAL_PATH! }, allowUntrustedLinkedTests: true, untrustedLinkedTestsPolicyEnabled: true },
      );
      expect(results.map((row) => [row.command, row.status, row.phase])).toEqual([
        [WRITE_BUILD, "passed", "setup"],
        [READ_BUILD, "passed", undefined],
      ]);
      // A setup entry without a command never executes; the run fails instead of skipping everything behind a pass.
      const global = { path: context.pmPath };
      const id = createTestItemId(context, { title: "path-only setup", createMode: "progressive" });
      await runTest(id, { addJson: [JSON.stringify([{ command: "node -e 1", phase: "setup" }, { command: "node -e 2" }])] }, global);
      const stored = (await runTest(id, { list: true }, global)).tests;
      const { command: _command, ...pathOnly } = { ...stored[0], path: "docs/setup.md" };
      await overwriteTaskTests(context, id, [pathOnly, stored[1]] as unknown as Array<Record<string, unknown>>);
      const run = await runTest(id, { run: true }, global);
      expect(run.ok).toBe(false);
      expect(run.run_results.map((row) => [row.status, row.failure_category])).toEqual([
        ["failed", "setup_failed"],
        ["skipped", undefined],
      ]);
    });
  }, 60_000);

  it("stamps format 3 when an SDK create stores a setup entry, and refuses a project pin that cannot refuse it", async () => {
    await withTempPmPath(async (context) => {
      const global = { path: context.pmPath };
      const created = await runCreate({ title: "sdk setup create", type: "Task", createMode: "progressive", test: ["command=node -e 1,phase=setup"] }, global);
      expect(created.item.pm_format_version).toBe(3);
      const plain = await runCreate({ title: "sdk plain create", type: "Task", createMode: "progressive", test: ["command=node -e 1"] }, global);
      expect(plain.item.pm_format_version).toBeUndefined();
      await writeFile(path.join(path.dirname(path.dirname(context.pmPath)), "package.json"), JSON.stringify({ devDependencies: { "@unbrained/pm-cli": "2026.10.9" } }));
      await expect(runCreate({ title: "pinned too old", type: "Task", createMode: "progressive", test: ["command=node -e 1,phase=setup"] }, global)).rejects.toMatchObject({
        code: "project_runtime_item_format_incompatible",
      });
    });
  }, 60_000);
});
