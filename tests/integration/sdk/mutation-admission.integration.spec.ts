import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PmClient } from "../../../src/sdk/index.js";
import { runTest, type TestCommandOptions } from "../../../src/sdk/test/execution.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

/** Snapshot authoritative documents and history, including unexpected new items. */
async function capture(context: TempPmContext) {
  const entries = await Promise.all(["tasks", "history"].map(async (folder) =>
    Promise.all((await readdir(path.join(context.pmPath, folder))).sort().map(async (file) =>
      [path.join(folder, file), await readFile(path.join(context.pmPath, folder, file), "utf8")]))));
  return entries.flat();
}

describe("mutation request admission", () => {
  it("rejects unknown and misplaced native SDK fields without partial mutations", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "SDK input admission", createMode: "progressive" });
      const clients = [new PmClient({ pmRoot: context.pmPath }), PmClient.forActiveExtensionHost({ pmRoot: context.pmPath })];
      const before = await capture(context);
      for (const client of clients) {
        for (const attempt of [
          () => client.update(id, { priorty: 0 } as never),
          () => client.update(id, { priority: 3, statsu: "closed" } as never),
          () => client.update(id, { cod: "ambiguous typo" } as never),
          () => client.update(id, JSON.parse('{"__proto__":{"priority":4}}')),
          () => client.create({ title: "must not exist", createMode: "progressive", priorty: 0 } as never),
          () => client.run("create", { options: { title: "must not exist", type: "Task", estimateMinutez: 5 } }),
          () => client.run("update", { id, options: { unrelatedUnknownField: 1 } }),
          () => client.run("update", { id, priorty: 4 }),
          () => client.run("update", { id, priority: 4 }),
        ]) {
          await expect(attempt()).rejects.toMatchObject({ exitCode: 2, code: "invalid_argument_value", context: { reason: "unknown_mutation_option", changed: false } });
          expect(await capture(context)).toEqual(before);
        }
      }
      await expect(clients[0].update(id, { priorty: 0 } as never)).rejects.toThrow("priority");
      await expect(clients[0].update(id, { cod: "ambiguous typo" } as never)).rejects.toThrow(/"body"|"doc"|"id"/u);
      for (const options of [null, [], "priority=4"]) {
        await expect(clients[0].run("update", { id, options } as never)).rejects.toMatchObject({ code: "invalid_argument_value", context: { changed: false } });
        expect(await capture(context)).toEqual(before);
      }
      const updated = await clients[0].update(id, { priority: 3 });
      expect(updated.changed_fields).toContain("priority");
      expect(context.runCli(["history", id, "--verify", "--strict-exit", "--json"]).code).toBe(0);
    });
  });

  it("preserves native aliases and runtime schema option identities", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-field", "external_id", "--type", "string", "--commands", "create,update", "--json"]).code).toBe(0);
      const client = new PmClient({ pmRoot: context.pmPath });
      const created = await client.run("create", { title: "schema option admission", type: "Task", options: { externalId: "original", createMode: "progressive" } }) as { id: string };
      await client.run("update", { id: created.id, options: { externalId: "revised", estimatedMinutes: "42" } });
      const result = await client.get(created.id, { full: true });
      expect(result.item).toMatchObject({ external_id: "revised", estimated_minutes: 42 });
      await expect(client.run("update", { id: created.id, options: { externalOd: "typo" } })).rejects.toThrow("externalId");
    });
  });

  it("admits every run directive and effective selection before adding or removing links", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "test option admission", createMode: "progressive" });
      await runTest(id, { add: ["command=node --version"] }, { path: context.pmPath });
      const before = await capture(context);
      const invalid = [
        { timeout: "abc" }, { timeout: "0" }, { pmContext: "bogus" },
        { workspaceContext: "bogus" }, { envSet: ["NOEQUALS"] },
        { envClear: ["BAD=NAME"] }, { onlyIndex: 0 }, { onlyIndex: 50 },
        { match: "absent" }, { onlyLast: true, onlyIndex: 1 },
      ] satisfies TestCommandOptions[];
      for (const edit of [{ add: ["command=node -e 1"] }, { removeIndex: [1] }]) {
        for (const options of invalid) {
          await expect(runTest(id, { ...edit, ...options, run: true }, { path: context.pmPath })).rejects.toMatchObject({ exitCode: 2, context: { changed: false } });
          expect(await capture(context)).toEqual(before);
        }
      }
      for (const args of [["--timeout", "abc"], ["--pm-context", "bogus"], ["--env-set", "NOEQUALS"], ["--only-index", "0"], ["--progress"]]) {
        const refused = context.runCli(["test", id, "--add", "command=node -e 1", ...args, "--json"], { expectJson: true });
        expect(refused.code).toBe(2);
        expect(refused.stderr).toContain(args[0]);
        expect(JSON.parse(refused.stderr)).toMatchObject({ code: "invalid_argument_value", changed: false });
        expect(await capture(context)).toEqual(before);
      }
      const accepted = await runTest(id, { add: ["command=node -e 1"], run: true, onlyIndex: 2 }, { path: context.pmPath });
      expect(accepted).toMatchObject({ changed: true, ok: true, selection: { selected_indexes: [2] } });
      expect(accepted.run_results).toHaveLength(1);
    });
  });
});
