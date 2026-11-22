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

  it("refuses an undeclared update-many key by name before any row changes, as a single update does", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-field", "external_id", "--type", "string", "--commands", "create,update,update_many", "--json"]).code).toBe(0);
      expect(context.runCli(["schema", "add-field", "filter_region", "--type", "string", "--commands", "create,update,update_many", "--json"]).code).toBe(0);
      expect(context.runCli(["schema", "add-field", "region_code", "--type", "string", "--commands", "create,list", "--json"]).code).toBe(0);
      expect(context.runCli(["schema", "add-field", "single_only", "--type", "string", "--commands", "create,update", "--json"]).code).toBe(0);
      const id = createTestItemId(context, { title: "bulk input admission", createMode: "progressive" });
      const client = new PmClient({ pmRoot: context.pmPath });
      const before = await capture(context);
      const single = await client.run("update", { id, options: { asignee: "x", description: "changed" } }).catch((error: unknown) => error as { message: string; context: Record<string, unknown> });
      for (const options of [
        { ids: [id], asignee: "x", description: "changed" },
        { ids: [id], update: { asignee: "x", description: "changed" } },
        { list: { ids: [id] }, asignee: "x", description: "changed" },
      ]) {
        const bulk = await client.run("update-many", { options }).catch((error: unknown) => error as { message: string; context: Record<string, unknown> });
        // Same key, same nearest name and same typed refusal as the single update.
        expect(bulk).toMatchObject({ exitCode: 2, code: "invalid_argument_value", context: { reason: "unknown_mutation_option", changed: false, field: "asignee" } });
        expect((bulk as { message: string }).message).toBe((single as { message: string }).message.replace("Unknown update option", "Unknown update-many option"));
        expect((bulk as { context: Record<string, unknown> }).context.required).toBe((single as { context: Record<string, unknown> }).context.required);
        expect(await capture(context)).toEqual(before);
      }
      for (const [options, named] of [
        [{ ids: [id], filterBogus: "open", description: "changed" }, "filterBogus"],
        [{ ids: [id], update: { description: "changed" }, dryRnu: true }, "dryRnu"],
        [{ ids: [id], update: { description: "changed" }, priority: 0 }, "update.priority"],
        // A single update's operand selects nothing in bulk: without the refusal every matching row would change.
        [{ id, description: "changed" }, '"ids"'],
        [{ list: { id }, update: { description: "changed" } }, 'update-many list option "id"'],
        // A selector the plan would not read: the list record's status, and a flat selector beside a list record.
        [{ list: { ids: [id], status: "open" }, update: { description: "changed" } }, "list.status"],
        [{ list: {}, ids: [id], update: { description: "changed" } }, '"ids"'],
        [{ list: { ids: [id] }, filterTag: "x", update: { description: "changed" } }, "filterTag"],
        // A misspelled or pre-normalized selector inside the list record would be carried unread and widen the write.
        [{ list: { ids: [id], assigneee: "alice" }, update: { description: "changed" } }, 'update-many list option "assigneee". Did you mean "assignee"?'],
        [{ list: { ids: [id], noNotes: true }, update: { description: "changed" } }, 'update-many list option "noNotes"'],
        // An intent bounds a list command's page, not the rows a bulk write reaches.
        [{ list: { ids: [id], for: "triage" }, update: { description: "changed" } }, 'update-many "list.for" is not read beside this selection. Bound the selection with list.limit.'],
        [{ list: { ids: [id], all: true }, update: { description: "changed" } }, 'State the status selection as filterStatus: "all" beside the list record.'],
        [{ list: { ids: [id], tokenBudget: 1000 }, update: { description: "changed" } }, "list.tokenBudget"],
        // A snake_case selector would select nothing, and CLI input-source flags are not read by the bulk runner.
        [{ ids: [id], filter_status: "open", description: "changed" }, "filter_status"],
        [{ ids: [id], update: { description: "changed", bodyFile: "body.md" } }, "bodyFile"],
        // A runtime field the bulk path does not apply is refused instead of dropped.
        [{ ids: [id], singleOnly: "dropped", description: "changed" }, "singleOnly"],
        [JSON.parse(`{"ids":["${id}"],"description":"changed","__proto__":{"priority":0}}`), "__proto__"],
        [{ ids: [id], update: JSON.parse('{"description":"changed","__proto__":{"priority":0}}') }, "__proto__"],
      ] as const) {
        await expect(client.run("update-many", { options })).rejects.toMatchObject({ message: expect.stringContaining(named), context: { reason: "unknown_mutation_option", changed: false } });
        expect(await capture(context)).toEqual(before);
      }
      // A request with no options at all is judged by the bulk command itself, after admission.
      await expect(client.run("update-many", {})).rejects.toMatchObject({ exitCode: 2 });
      // The action envelope is judged too: a misplaced field names its options placement.
      await expect(client.run("update-many", { asignee: "x", options: { ids: [id], description: "changed" } })).rejects.toMatchObject({ context: { reason: "unknown_mutation_option", field: "asignee", changed: false } });
      await expect(client.run("update-many", { description: "changed", options: { ids: [id] } })).rejects.toThrow("options.description");
      expect(await capture(context)).toEqual(before);
      // A container that is no record, and a force the handler would not read or would misread.
      for (const options of [{ list: [], update: { description: "changed" } }, { ids: [id], update: "description=changed" }]) {
        await expect(client.run("update-many", { options } as never)).rejects.toMatchObject({ context: { reason: "invalid_mutation_option_value", changed: false } });
      }
      await expect(client.run("update-many", { force: true, options: { ids: [id], description: "changed" } })).rejects.toThrow("options.force");
      expect(await capture(context)).toEqual(before);
      for (const options of [null, [], "ids=x"]) {
        await expect(client.run("update-many", { options } as never)).rejects.toMatchObject({ code: "invalid_argument_value", context: { changed: false } });
      }
      // Declared aliases, run controls, runtime schema fields and both spellings stay accepted.
      await expect(client.run("update-many", { options: { ids: [id], externalId: "flat", estimatedMinutes: "5", message: "flat", dryRun: true } })).resolves.toMatchObject({ dry_run: true });
      expect(await capture(context)).toEqual(before);
      await client.run("update-many", { options: { ids: [id], externalId: "flat", estimate: "5", noCheckpoint: true } });
      await client.run("update-many", { options: { list: { ids: [id] }, update: { description: "nested", externalId: "nested" }, checkpoint: false, fullChangedFields: true } });
      expect((await client.get(id, { full: true })).item).toMatchObject({ external_id: "nested", description: "nested", estimated_minutes: 5 });
      // Every selector the list contract reads stays accepted inside the list record, with a runtime field's list filter.
      await expect(client.run("update-many", { options: { list: { ids: [id], assigneeFilter: "unassigned", notes: false, sort: "priority", tree: true, tree_depth: "1", assignee_filter: "unassigned", filterEstimateMissing: false, excludeTerminal: true, lifecycleBucket: "open", regionCode: "none" }, update: { description: "listed" }, dryRun: true } })).resolves.toMatchObject({ dry_run: true });
      // A runtime schema field that shares an intent's name is this tracker's list filter, not an unread intent.
      expect(context.runCli(["schema", "add-field", "token_budget", "--type", "string", "--commands", "create,list", "--json"]).code).toBe(0);
      await expect(client.run("update-many", { options: { list: { ids: [id], tokenBudget: "none" }, update: { description: "filtered" }, dryRun: true } })).resolves.toMatchObject({ dry_run: true });
      // Spellings the dispatch consumes stay accepted: a snake_case output control and the annotation snapshot guard.
      await expect(client.run("update-many", { options: { ids: [id], description: "snake", output_format: "json", dry_run: true } })).resolves.toMatchObject({ dry_run: true });
      await expect(client.run("update-many", { options: { ids: [id], description: "guarded", documentAnnotationSnapshot: { comments: [], notes: [], learnings: [] } } })).resolves.toBeDefined();
      // Attribution stated once beside a nested update record reaches every row; the record's own value wins.
      await client.run("update-many", { options: { ids: [id], update: { description: "attributed" }, author: "outer-author", message: "outer message", force: true, filterStatus: "all", noCheckpoint: true } });
      // An undefined inner value is absent, not an override, and a schema field named filter* beside a list record is a field.
      await client.run("update-many", { options: { list: { ids: [id] }, filterRegion: "west", noCheckpoint: true } });
      expect((await client.get(id, { full: true })).item).toMatchObject({ filter_region: "west" });
      await client.run("update-many", { options: { list: { ids: [id] }, update: { description: "undefined inner", author: undefined }, author: "kept-author", noCheckpoint: true } });
      expect(JSON.parse((await readFile(path.join(context.pmPath, "history", `${id}.jsonl`), "utf8")).trim().split("\n").at(-1)!)).toMatchObject({ author: "kept-author" });
      await client.run("update-many", { options: { ids: [id], update: { description: "inner wins", author: "inner-author" }, author: "outer-author", noCheckpoint: true } });
      const history = (await readFile(path.join(context.pmPath, "history", `${id}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { author: string; message?: string });
      expect(history.at(-4)).toMatchObject({ author: "outer-author", message: "outer message" });
      expect(history.at(-1)).toMatchObject({ author: "inner-author" });
      expect(context.runCli(["history", id, "--verify", "--strict-exit", "--json"]).code).toBe(0);
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
