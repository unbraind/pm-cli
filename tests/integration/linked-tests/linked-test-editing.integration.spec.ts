import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runTest, type TestCommandOptions } from "../../../src/sdk/test/execution.js";
import { runTestAll } from "../../../src/sdk/test/batch.js";
import { updateLinkedTest, type LinkedTestMetadataPatch, type LinkedTestUpdateSelector } from "../../../src/sdk/test/update.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { overwriteTaskTests, setTestResultTracking } from "../../helpers/pmWorkspace.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

/** Capture authoritative item and history bytes without including derived runtime files. */
async function capture(context: TempPmContext, id: string) {
  const name = (await readdir(path.join(context.pmPath, "tasks"))).find((file) => file === `${id}.toon` || file === `${id}.md`);
  expect(name).toBeDefined();
  return {
    item: await readFile(path.join(context.pmPath, "tasks", name!), "utf8"),
    history: await readFile(path.join(context.pmPath, "history", `${id}.jsonl`), "utf8"),
  };
}

describe("linked-test editing and configuration admission", () => {
  it("refuses invalid contexts on SDK and both CLI intake paths before persistence", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "context admission", createMode: "progressive" });
      const before = await capture(context, id);
      for (const workspace_context_mode of [undefined, "source"]) {
        await expect(runTest(id, { addJson: [JSON.stringify({ command: "node -e 1", pm_context_mode: "none", workspace_context_mode })] }, { path: context.pmPath })).rejects.toMatchObject({ code: "linked_test_context_invalid" });
      }
      for (const args of [
        ["test", id, "--add", "command=node -e 1,pm_context_mode=none"],
        ["test", id, "--add-json", '{"command":"node -e 1","pm_context_mode":"none"}'],
        ["update", id, "--test", "command=node -e 1,pm_context_mode=none"],
      ]) {
        const refused = context.runCli([...args, "--json"], { expectJson: true });
        expect(refused.code).toBe(2);
        expect(refused.stderr).toContain("workspace_context_mode");
        expect(await capture(context, id)).toEqual(before);
      }
      const refusedCreate = context.runCli(["create", "Task", "invalid linked context", "--create-mode", "progressive", "--test", "command=node -e 1,pm_context_mode=none", "--json"]);
      expect(refusedCreate.code).toBe(2);
      expect(await capture(context, id)).toEqual(before);
      const valid = await runTest(id, { addJson: [JSON.stringify([
        { command: "node -e 1", pm_context_mode: "none", workspace_context_mode: "isolated" },
        { command: "node -e 2", pm_context_mode: "none", workspace_context_mode: "snapshot" },
      ])] }, { path: context.pmPath });
      expect(valid.tests).toHaveLength(2);
      expect(valid.tests.map((test) => test.workspace_context_mode)).toEqual(["isolated", "snapshot"]);
    });
  });

  it("edits one entry in place, preserving provenance, unrelated fields and no-op bytes", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "metadata patch", createMode: "progressive" });
      const added = await runTest(id, { addJson: [JSON.stringify([
        { command: "node -e 1", path: "first.mjs", timeout_seconds: 60, note: "old" },
        { command: "node --version", note: "untouched" },
      ])] }, { path: context.pmPath });
      const before = await capture(context, id);
      const edited = context.runCli(["test", id, "--update-index", "1", "--set-json", '{"note":"corrected","timeout_seconds":90}', "--json"], { expectJson: true });
      expect(edited.code).toBe(0);
      const current = await runTest(id, { list: true }, { path: context.pmPath });
      expect(current.tests[0]).toMatchObject({ ...added.tests[0], note: "corrected", timeout_seconds: 90, updated_by: expect.any(String), updated_at: expect.any(String) });
      expect(current.tests[1]).toEqual(added.tests[1]);
      const after = await capture(context, id);
      const events = after.history.slice(before.history.length).trim().split("\n").map((line) => JSON.parse(line) as { op: string; patch: Array<{ path: string }> });
      expect(events).toHaveLength(1);
      expect(events[0].op).toBe("tests_update");
      expect(events[0].patch.map((entry) => entry.path)).toEqual(expect.arrayContaining(["/metadata/tests/0/note", "/metadata/tests/0/timeout_seconds"]));
      expect(context.runCli(["test", id, "--update", "command=node -e 1", "--set-json", '{"note":"corrected","timeout_seconds":90}', "--json"]).code).toBe(0);
      expect(await capture(context, id)).toEqual(after);
      const patch = { path: "./tests/example.mjs", assert_stdout_contains: [" second ", "first", "first"] };
      const normalized = await updateLinkedTest(id, { selector: { index: 1 }, patch }, { path: context.pmPath });
      expect(normalized.tests[0]).toMatchObject({ path: "./tests/example.mjs", assert_stdout_contains: ["first", "second"] });
      const normalizedBytes = await capture(context, id);
      expect((await updateLinkedTest(id, { selector: { command: "node -e 1" }, patch }, { path: context.pmPath })).changed).toBe(false);
      expect(await capture(context, id)).toEqual(normalizedBytes);
      expect(context.runCli(["history", id, "--verify", "--strict-exit", "--json"]).code).toBe(0);
    });
  });

  it("provides a typed SDK editor and rejects malformed external payloads without writes", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "SDK metadata editor", createMode: "progressive" });
      await runTest(id, { add: ["command=node -e 1,path=one.mjs,note=first"] }, { path: context.pmPath });
      const before = await capture(context, id);
      for (const selector of [null, [], {}, { index: 0 }, { command: "" }, { path: "" }, { command: "node -e 1", path: "one.mjs" }]) {
        await expect(updateLinkedTest(id, { selector: selector as unknown as LinkedTestUpdateSelector, patch: { note: "wrong" } }, { path: context.pmPath })).rejects.toThrow();
        expect(await capture(context, id)).toEqual(before);
      }
      for (const patch of [null, [], {}, { scope: null }, { scope: "invalid" }, { timeout_seconds: -1 }, { unknown: "value" }, { updated_by: "forged" }, { note: 7 }]) {
        await expect(updateLinkedTest(id, { selector: { index: 1 }, patch: patch as unknown as LinkedTestMetadataPatch }, { path: context.pmPath })).rejects.toThrow();
        expect(await capture(context, id)).toEqual(before);
      }
      for (const options of [{ updateIndex: 1 }, { setJson: "{}" }, { update: "node -e 1", updateIndex: 1, setJson: "{}" }, { updateIndex: 1, setJson: "{" }, { updateIndex: 1, setJson: '{"note":"wrong"}', run: true }, { updateIndex: 1, setJson: '{"note":"wrong"}', add: ["node -e 2"] }]) {
        await expect(runTest(id, options, { path: context.pmPath })).rejects.toThrow();
        expect(await capture(context, id)).toEqual(before);
      }
      const edited = await updateLinkedTest(id, { selector: { path: "one.mjs" }, patch: { note: "SDK edit" }, author: "editor" }, { path: context.pmPath });
      expect(edited).toMatchObject({ changed: true, updated_index: 1, updated_fields: ["note"] });
      expect(edited.tests[0]).toMatchObject({ updated_by: "editor", provenance: { author: "test-author" } });
      const cleared = await runTest(id, { update: "node -e 1", setJson: '{"note":null}' }, { path: context.pmPath });
      expect(cleared).toMatchObject({ changed: true, updated_index: 1, updated_fields: ["note"] });
      expect(cleared.tests[0]).not.toHaveProperty("note");
      const transport = await runTest(id, { update: "command=node -e 1", setJson: '{"note":"transport edit"}' }, { path: context.pmPath });
      expect(transport.tests[0].note).toBe("transport edit");
      expect((await runTest(id, { update: "path=one.mjs", setJson: '{"note":"transport edit"}' }, { path: context.pmPath })).changed).toBe(false);
      const legacyId = createTestItemId(context, { title: "legacy path entry", createMode: "progressive" });
      await overwriteTaskTests(context, legacyId, [{ path: "legacy.mjs", scope: "project" }]);
      const legacy = await updateLinkedTest(legacyId, { selector: { path: "legacy.mjs" }, patch: { note: "path metadata" } }, { path: context.pmPath });
      expect(legacy.tests[0]).not.toHaveProperty("command");
      expect(legacy.tests[0]).not.toHaveProperty("provenance");
    });
  });

  it.each([
    { flag: "--list", args: [], options: { list: true } },
    { flag: "--timeout", args: ["60"], options: { timeout: "60" } },
    { flag: "--timeout", args: [""], options: { timeout: "" } },
    { flag: "--progress", args: [], options: { progress: true } },
    { flag: "--metric-below", args: ["latency=10"], options: { metricBelow: "latency=10" } },
    { flag: "--metric-below", args: [""], options: { metricBelow: "" } },
    { flag: "--metric-diff", args: ["latency"], options: { metricDiff: "latency" } },
    { flag: "--metric-diff", args: [""], options: { metricDiff: "" } },
  ])("refuses $flag $args on edits through SDK and CLI before persistence", async ({ flag, args, options }) => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "edit option admission", createMode: "progressive" });
      await runTest(id, { add: ["command=node -e 1,note=original"] }, { path: context.pmPath });
      const before = await capture(context, id);
      await expect(runTest(id, { updateIndex: 1, setJson: '{"note":"wrong"}', ...options }, { path: context.pmPath })).rejects.toMatchObject({ exitCode: 2 });
      expect(await capture(context, id)).toEqual(before);
      expect(context.runCli(["test", id, "--update-index", "1", "--set-json", '{"note":"wrong"}', flag, ...args, "--json"]).code).toBe(2);
      expect(await capture(context, id)).toEqual(before);
    });
  });

  it("retains a command or path when editing legacy path-only entries", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "linked-test identity", createMode: "progressive" });
      await overwriteTaskTests(context, id, [{ path: "legacy.mjs", scope: "project", note: "original" }]);
      const before = await capture(context, id);
      for (const patch of [{ path: null }, { path: "" }, { path: " " }, { path: null, note: "wrong" }]) {
        await expect(updateLinkedTest(id, { selector: { path: "legacy.mjs" }, patch }, { path: context.pmPath })).rejects.toMatchObject({ exitCode: 2 });
        expect(await capture(context, id)).toEqual(before);
        await expect(runTest(id, { updateIndex: 1, setJson: JSON.stringify(patch) }, { path: context.pmPath })).rejects.toMatchObject({ exitCode: 2 });
        expect(await capture(context, id)).toEqual(before);
        expect(context.runCli(["test", id, "--update-index", "1", "--set-json", JSON.stringify(patch), "--json"]).code).toBe(2);
        expect(await capture(context, id)).toEqual(before);
      }
      const renamed = await updateLinkedTest(id, { selector: { path: "legacy.mjs" }, patch: { path: "renamed.mjs" } }, { path: context.pmPath });
      expect(renamed.tests[0]).toMatchObject({ path: "renamed.mjs", note: "original" });
      expect(renamed.tests[0]).not.toHaveProperty("command");
      expect(renamed.tests[0]).not.toHaveProperty("provenance");
      const after = await capture(context, id);
      const events = after.history.slice(before.history.length).trim().split("\n").map((line) => JSON.parse(line) as { op: string; patch: Array<{ path: string }> });
      expect(events).toHaveLength(1);
      expect(events[0].op).toBe("tests_update");
      expect(events[0].patch.map((entry) => entry.path)).toContain("/metadata/tests/0/path");
      expect((await updateLinkedTest(id, { selector: { path: "renamed.mjs" }, patch: { path: "renamed.mjs" } }, { path: context.pmPath })).changed).toBe(false);
      expect(await capture(context, id)).toEqual(after);
    });
  });

  it("refuses every other active run directive and collection operation on metadata edits", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "complete edit admission", createMode: "progressive" });
      await runTest(id, { add: ["command=node -e 1,note=original"] }, { path: context.pmPath });
      const before = await capture(context, id);
      const incompatible = [
        { run: true }, { match: "node" }, { onlyIndex: 1 }, { onlyLast: true },
        { envSet: ["FLAG=1"] }, { envClear: ["FLAG"] }, { sharedHostSafe: true },
        { pmContext: "none" }, { overrideLinkedPmContext: true },
        { workspaceContext: "snapshot" }, { overrideLinkedWorkspaceContext: true },
        { allowUntrustedLinkedTests: true }, { acknowledgeLinkedTests: true },
        { failOnContextMismatch: true }, { failOnSkipped: true }, { failOnEmptyTestRun: true },
        { requireAssertionsForPm: true }, { checkContext: true }, { autoPmContext: true },
        { measure: ["latency=10"] }, { add: ["node -e 2"] },
        { addJson: ['{"command":"node -e 2"}'] }, { remove: ["command=node -e 1"] }, { removeIndex: [1] },
      ] satisfies TestCommandOptions[];
      for (const options of incompatible) {
        await expect(runTest(id, { updateIndex: 1, setJson: '{"note":"wrong"}', ...options }, { path: context.pmPath })).rejects.toMatchObject({ exitCode: 2 });
        expect(await capture(context, id)).toEqual(before);
      }
    });
  });

  it("refuses absent, ambiguous and unsafe patches atomically and supports explicit clearing", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "atomic selectors", createMode: "progressive" });
      const empty = await capture(context, id);
      await expect(updateLinkedTest(id, { selector: { index: 1 }, patch: { note: "wrong" } }, { path: context.pmPath })).rejects.toMatchObject({ code: "linked_test_update_no_match" });
      expect(await capture(context, id)).toEqual(empty);
      await runTest(id, { addJson: [JSON.stringify([
        { command: "node -e 1", path: "shared.mjs", note: "retain" },
        { command: "node --version", path: "shared.mjs" },
      ])] }, { path: context.pmPath });
      const before = await capture(context, id);
      for (const selector of [{ path: "shared.mjs" }, { command: "missing" }, { index: 3 }]) {
        await expect(updateLinkedTest(id, { selector, patch: { note: "wrong" } }, { path: context.pmPath })).rejects.toMatchObject({
          code: "path" in selector ? "linked_test_update_ambiguous" : "linked_test_update_no_match",
        });
        expect(await capture(context, id)).toEqual(before);
      }
      for (const args of [
        ["--update", "path=shared.mjs", "--set-json", '{"note":"wrong"}'],
        ["--update", "missing", "--set-json", '{"note":"wrong"}'],
        ["--update-index", "3", "--set-json", '{"note":"wrong"}'],
        ["--update-index", "1", "--set-json", '{"pm_context_mode":"none"}'],
        ["--update-index", "1", "--set-json", '{"provenance":{}}'],
        ["--update-index", "1", "--set-json", '{"command":"node -e 2"}'],
        ["--update-index", "1", "--set-json", '{}'],
      ]) {
        expect(context.runCli(["test", id, ...args, "--json"]).code).not.toBe(0);
        expect(await capture(context, id)).toEqual(before);
      }
      const cleared = context.runCli(["test", id, "--update-index", "1", "--set-json", '{"note":null,"path":null,"pm_context_mode":"none","workspace_context_mode":"isolated"}', "--json"]);
      expect(cleared.code).toBe(0);
      const result = await runTest(id, { list: true }, { path: context.pmPath });
      expect(result.tests[0]).not.toHaveProperty("note");
      expect(result.tests[0]).not.toHaveProperty("path");
      expect(result.tests[0].provenance).toBeDefined();
    });
  });

  it("reports legacy refusals without a subprocess exit and keeps real failures distinct", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "refusal semantics", createMode: "progressive" });
      await setTestResultTracking(context.pmPath, false);
      await overwriteTaskTests(context, id, [{ command: 'node -e "process.stdout.write(\'EXECUTED\')"', pm_context_mode: "none", scope: "project" }]);
      const result = await runTest(id, { run: true }, { path: context.pmPath });
      expect(result.ok).toBe(false);
      expect(result.run_results[0]).toMatchObject({ status: "refused", failure_category: "config_refusal", exit_code: null });
      expect(result.run_results[0].stdout).toBeUndefined();
      expect(result.failure_categories).toMatchObject({ config_refusal: 1, assertion_failure: 0 });
      const all = await runTestAll({}, { path: context.pmPath });
      expect(all.ok).toBe(false);
      expect(all.totals.failure_categories.config_refusal).toBe(1);
      expect(context.runCli(["test", id, "--run", "--json"]).code).toBe(5);
      await overwriteTaskTests(context, id, [{ command: 'node -e "process.exit(7)"', scope: "project" }]);
      const executed = await runTest(id, { run: true }, { path: context.pmPath });
      expect(executed.run_results[0]).toMatchObject({ status: "failed", failure_category: "assertion_failure", exit_code: 7 });
    });
  });
});
