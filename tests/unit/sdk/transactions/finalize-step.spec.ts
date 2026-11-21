import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PmClient,
  WorkspaceTransactionInterruptedError,
  abandonItemTransaction,
  commitItemMutations,
  previewItemMutations,
  readItemTransaction,
  runWithActiveExtensions,
  type BulkItemMutation,
} from "../../../../src/sdk/index.js";
import { applyItemFinalization, assertValidItemFinalization } from "../../../../src/sdk/transactions/item-finalization.js";
import { SETTINGS_DEFAULTS } from "../../../../src/core/shared/constants.js";
import { readSettings, writeSettings } from "../../../../src/core/store/settings.js";
import { writeTestExtension } from "../../../helpers/extensions.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const author = "transaction-test";
const lifecycle = { status: "closed", close_reason: "Closed at the source", closed_at: "2020-01-02T00:00:00.000Z", created_at: "2019-01-01T00:00:00.000Z", source_issue: 42 };

/** History operations and the transaction phase each event's message ends with. */
async function historyOps(pmPath: string, id: string): Promise<string[]> {
  const lines = (await readFile(path.join(pmPath, "history", `${id}.jsonl`), "utf8")).trim().split("\n");
  return lines.map((line) => { const entry = JSON.parse(line) as { op: string; message?: string }; return `${entry.op}:${entry.message?.split(" ").at(-1) ?? ""}`; });
}

/** Create one open task and return its client and document. */
async function seed(pmPath: string, options: Record<string, unknown> = {}) {
  const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
  const item = (await client.create({ title: "Original", type: "Task", ...options })).item;
  return { client, item };
}

describe("transaction-owned finalization step (GH-1656)", () => {
  it("commits exact lifecycle and extension fields as one journaled step", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const { client, item } = await seed(pmPath, { sprint: "import-1" });
      const result = await commitItemMutations({ pmRoot: pmPath, author, transactionId: "finalize-commit", mutations: [
        { op: "update", id: item.id, options: { title: "Changed" } },
        { op: "finalize", id: item.id.replace(/^pm-/u, ""), set: lifecycle, unset: ["sprint"] },
      ] });
      expect(Object.values(result.results)).toEqual([{ id: item.id, op: "update" }, { id: item.id, op: "finalize" }]);
      expect((await client.get(item.id)).item).toMatchObject({ title: "Changed", ...lifecycle });
      expect((await client.get(item.id)).item).not.toHaveProperty("sprint");
      expect(await historyOps(pmPath, item.id)).toEqual(["create:", "update:apply", "import:apply"]);
      const entry = JSON.parse((await readFile(path.join(pmPath, "history", `${item.id}.jsonl`), "utf8")).trim().split("\n").at(-1)!);
      expect(entry.context.item_transaction_step).toBe(entry.message);
      // Replaying the committed plan adopts the applied step instead of writing again.
      await expect(commitItemMutations({ pmRoot: pmPath, author, transactionId: "finalize-commit", mutations: [
        { op: "update", id: item.id, options: { title: "Changed" } },
        { op: "finalize", id: item.id.replace(/^pm-/u, ""), set: lifecycle, unset: ["sprint"] },
      ] })).resolves.toMatchObject({ status: "committed" });
      expect(await historyOps(pmPath, item.id)).toHaveLength(3);
    });
  });

  it("restores the pre-batch document when the committing observer fails after finalization", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const { client, item } = await seed(pmPath);
      const failure = await commitItemMutations({ pmRoot: pmPath, author, transactionId: "finalize-rollback", mutations: [
        { op: "update", id: item.id, options: { title: "Changed" } },
        { op: "finalize", id: item.id, set: lifecycle },
      ], onTransition: ({ transition }) => { if (transition === "committing") throw new Error("Synthetic finalization failure"); } }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ message: "Synthetic finalization failure" });
      const restored = (await client.get(item.id)).item as Record<string, unknown>;
      expect(restored).toMatchObject({ title: "Original", status: "open", created_at: item.created_at, updated_at: item.updated_at });
      expect(restored).not.toHaveProperty("closed_at");
      expect(restored).not.toHaveProperty("source_issue");
      expect(await historyOps(pmPath, item.id)).toEqual(["create:", "update:apply", "import:apply", "restore:compensate", "restore:compensate"]);
      expect((await readItemTransaction(pmPath, "finalize-rollback"))?.journal.status).toBe("compensated");
    });
  });

  it.each(["commit", "rollback"])("finalizes an item created earlier in the same batch: %s", async (mode) => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const run = commitItemMutations({ pmRoot: pmPath, author, transactionId: `finalize-created-${mode}`, createCompensation: "delete", mutations: [
        { op: "create", id: "pm-imported", options: { title: "Imported", type: "Task" } },
        { op: "finalize", id: "pm-imported", set: lifecycle },
      ], onTransition: ({ transition }) => { if (mode === "rollback" && transition === "committing") throw new Error("Abort the import"); } });
      if (mode === "commit") {
        await expect(run).resolves.toMatchObject({ status: "committed" });
        expect((await client.get("pm-imported")).item).toMatchObject({ title: "Imported", ...lifecycle });
        return;
      }
      await expect(run).rejects.toThrow("Abort the import");
      await expect(client.get("pm-imported")).rejects.toMatchObject({ exitCode: 3 });
      expect(await historyOps(pmPath, "pm-imported")).toEqual(["create:apply", "import:apply", "restore:compensate", "delete:compensate"]);
    });
  });

  it("still refuses to compensate past another writer's change (negative control)", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const { client, item } = await seed(pmPath);
      const failure = await commitItemMutations({ pmRoot: pmPath, author, transactionId: "finalize-peer", mutations: [{ op: "finalize", id: item.id, set: lifecycle }], onTransition: async ({ transition }) => {
        if (transition !== "committing") return;
        await client.update(item.id, { description: "Unowned write" });
        throw new Error("Abort after peer edit");
      } }).catch((error: unknown) => error);
      expect((failure as AggregateError).errors).toEqual([expect.objectContaining({ message: "Abort after peer edit" }), expect.objectContaining({ context: expect.objectContaining({ code: "transaction_partial_mutation" }) })]);
      expect((await client.get(item.id)).item).toMatchObject({ ...lifecycle, description: "Unowned write" });
      expect((await readItemTransaction(pmPath, "finalize-peer"))?.journal.status).toBe("compensating");
    });
  });

  it.each(["applied", "pending"])("recovers an interrupted journal deterministically: %s", async (state) => {
    await withTempPmPath(async ({ pmPath }) => {
      const { client, item } = await seed(pmPath);
      const mutations: BulkItemMutation[] = [{ op: "finalize", id: item.id, set: lifecycle }];
      const interruptAt = state === "applied" ? "step_applied" : "prepared";
      await expect(commitItemMutations({ pmRoot: pmPath, author, transactionId: "finalize-recover", mutations, onTransition: ({ transition }) => {
        if (transition === interruptAt) throw new WorkspaceTransactionInterruptedError("crash around the finalization write");
      } })).rejects.toBeInstanceOf(WorkspaceTransactionInterruptedError);
      expect(await historyOps(pmPath, item.id)).toEqual(state === "applied" ? ["create:", "import:apply"] : ["create:"]);
      await expect(commitItemMutations({ pmRoot: pmPath, author, transactionId: "finalize-recover", mutations })).resolves.toMatchObject({ status: "committed", recovered: true });
      expect((await client.get(item.id)).item).toMatchObject(lifecycle);
      expect(await historyOps(pmPath, item.id)).toEqual(["create:", "import:apply"]);
    });
  });

  it("appends no event for a finalization that changes nothing, and re-applies it as the same no-op", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const { item } = await seed(pmPath, { tags: "b,a" });
      const mutations: BulkItemMutation[] = [{ op: "finalize", id: item.id, set: { status: "open", tags: ["B", "a"] }, unset: ["closed_at"] }];
      for (const transactionId of ["finalize-noop", "finalize-noop", "finalize-noop-again"]) {
        await expect(commitItemMutations({ pmRoot: pmPath, author, transactionId, mutations })).resolves.toMatchObject({ status: "committed" });
      }
      expect(await historyOps(pmPath, item.id)).toEqual(["create:"]);
      await expect(applyItemFinalization({ pmRoot: pmPath, id: item.id, author, message: "direct", set: { status: "open" } })).resolves.toMatchObject({ changedFields: [], item: { id: item.id } });
      // An unset-only row is a complete finalization.
      await expect(commitItemMutations({ pmRoot: pmPath, author, transactionId: "finalize-unset-only", mutations: [{ op: "finalize", id: item.id, unset: ["tags"] }] })).resolves.toMatchObject({ status: "committed" });
      expect(await historyOps(pmPath, item.id)).toEqual(["create:", "import:apply"]);
      await expect(applyItemFinalization({ pmRoot: pmPath, id: item.id, author, message: "direct", set: { sprint: "s2" }, force: true })).resolves.toMatchObject({ changedFields: ["sprint"] });
    });
  });

  it.each(["direct call", "caller scope"])("lets an installed extension's guard judge the finalization as an import: %s", async (mode) => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTestExtension({
        root: path.join(pmPath, "extensions", "import-guard"),
        name: "import-guard",
        manifestOverrides: { capabilities: ["hooks"] },
        entrySource: `export default { activate(api) { api.hooks.beforeMutation((context) => context.operation === "import" && context.after?.metadata.sprint === "denied"
          ? { allow: false, code: "import_denied", remediation: "Use another sprint." } : { allow: true }); } };`,
      });
      const { client, item } = await seed(pmPath);
      const finalize = (sprint: string) => {
        const commit = () => commitItemMutations({ pmRoot: pmPath, author, transactionId: `finalize-guard-${sprint}`, mutations: [{ op: "finalize", id: item.id, set: { sprint } }] });
        return mode === "direct call" ? commit() : runWithActiveExtensions({ path: pmPath }, commit);
      };
      await expect(finalize("denied")).rejects.toMatchObject({ context: { code: "import_denied" } });
      expect((await client.get(item.id)).item).not.toHaveProperty("sprint");
      await expect(finalize("allowed")).resolves.toMatchObject({ status: "committed" });
      expect((await client.get(item.id)).item).toMatchObject({ sprint: "allowed" });
    });
  });

  it("re-checks the match guard under the item lock", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const { client, item } = await seed(pmPath, { sprint: "source-1" });
      const finalize = (value: string) => commitItemMutations({ pmRoot: pmPath, author, transactionId: `finalize-match-${value}`, mutations: [{ op: "finalize", id: item.id, set: { closed_at: lifecycle.closed_at }, match: { key: "sprint", value } }] });
      await expect(finalize("source-2")).rejects.toMatchObject({ context: { code: "upsert_match_changed" } });
      expect((await client.get(item.id)).item).not.toHaveProperty("closed_at");
      await expect(finalize("source-1")).resolves.toMatchObject({ status: "committed" });
      expect((await client.get(item.id)).item).toMatchObject({ closed_at: lifecycle.closed_at });
    });
  });

  it("honors the assignee-ownership check unless the row forces it", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const { client, item } = await seed(pmPath, { assignee: "someone-else" });
      await writeSettings(pmPath, { ...await readSettings(pmPath), governance: { ...SETTINGS_DEFAULTS.governance, preset: "custom", ownership_enforcement: "strict" } });
      const finalize = (force: boolean) => commitItemMutations({ pmRoot: pmPath, author, transactionId: `finalize-force-${force}`, mutations: [{ op: "finalize", id: item.id, set: { closed_at: lifecycle.closed_at }, force }] });
      await expect(finalize(false)).rejects.toThrow("is assigned to someone-else");
      expect((await client.get(item.id)).item).not.toHaveProperty("closed_at");
      await expect(finalize(true)).resolves.toMatchObject({ status: "committed" });
    });
  });

  it.each([
    ["a value the reader refuses", { status: 5 }, "status must be a non-empty string"],
    ["a value stored in another shape", { tags: "a" }, 'set "tags" is not stored as declared (a string value normalizes to a array)'],
    ["a value normalized away", { assignee: "  " }, 'set "assignee" is not stored as declared (a string value normalizes to an absent field)'],
  ])("refuses %s before anything is written", async (_label, set, message) => {
    await withTempPmPath(async ({ pmPath }) => {
      const { item } = await seed(pmPath, { tags: "kept" });
      const failure = await commitItemMutations({ pmRoot: pmPath, author, transactionId: "finalize-invalid", mutations: [{ op: "finalize", id: item.id, set }] }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ context: { code: "finalization_invalid_document", item_id: item.id } });
      expect((failure as Error).message).toContain(message);
      expect(await historyOps(pmPath, item.id)).toEqual(["create:"]);
    });
  });

  it("previews a finalization in the staged tracker and abandons an interrupted one", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const { client, item } = await seed(pmPath);
      const mutations: BulkItemMutation[] = [{ op: "finalize", id: item.id, set: lifecycle }];
      const preview = await previewItemMutations({ pmRoot: pmPath, author, transactionId: "finalize-preview", mutations });
      expect(preview.records).toEqual([expect.objectContaining({ index: 0, id: item.id, op: "finalize", execution: "applied", item: expect.objectContaining(lifecycle) })]);
      expect(await historyOps(pmPath, item.id)).toEqual(["create:"]);
      await expect(commitItemMutations({ pmRoot: pmPath, author, transactionId: "finalize-abandon", mutations, onTransition: ({ transition }) => {
        if (transition === "step_applied") throw new WorkspaceTransactionInterruptedError("crash after the finalization write");
      } })).rejects.toBeInstanceOf(WorkspaceTransactionInterruptedError);
      await expect(abandonItemTransaction({ pmRoot: pmPath, author, transactionId: "finalize-abandon", reason: "Source import withdrawn" })).resolves.toMatchObject({ journal: { status: "abandoned" } });
      expect((await client.get(item.id)).item).toMatchObject({ status: "open", created_at: item.created_at });
    });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["an empty patch", {}, "requires at least one field in set or unset"],
    ["a non-object set", { set: ["closed_at"] }, "set must be an object of front-matter fields"],
    ["a null set", { set: null }, "set must be an object of front-matter fields"],
    ["a non-array unset", { unset: "closed_at" }, "unset must be an array of front-matter field names"],
    ["a malformed field name", { set: { "Closed-At": "x" } }, 'names an invalid field "Closed-At"'],
    ["an inherited field name", { unset: ["constructor"] }, 'names an invalid field "constructor"'],
    ["a non-string unset entry", { unset: [7] }, "names an invalid field 7"],
    ["a writer-derived field", { set: { updated_at: "2020-01-01T00:00:00.000Z" } }, 'cannot change "updated_at"'],
    ["the storage-selecting type", { unset: ["type"] }, 'cannot change "type"'],
    ["a null value", { set: { assignee: null } }, 'set "assignee" must be a non-null JSON value'],
    ["a non-finite number", { set: { order: Number.NaN } }, 'set "order" must be a non-null JSON value'],
    ["a nested undefined", { set: { source: { at: undefined } } }, 'set "source" must be a non-null JSON value'],
    ["a class instance", { set: { closed_at: new Date(0) } }, 'set "closed_at" must be a non-null JSON value'],
    ["a nested class instance", { set: { sources: [new Map()] } }, 'set "sources" must be a non-null JSON value'],
    ["a field both set and unset", { set: { sprint: "s1" }, unset: ["sprint"] }, 'both sets and unsets "sprint"'],
    ["a repeated unset", { unset: ["sprint", "sprint"] }, "unset repeats a field"],
    ["an unsupported key", { set: { sprint: "s1" }, options: { title: "ignored" } }, "has unsupported keys: options"],
    ["a non-boolean force", { set: { sprint: "s1" }, force: "yes" }, "force must be a boolean"],
    ["a malformed match guard", { set: { sprint: "s1" }, match: { key: "" } }, "Bulk finalize mutation 1 match must be an object"],
  ])("rejects %s before any journal work", async (_label, row, message) => {
    await withTempPmPath(async ({ pmPath }) => {
      const mutations = [{ op: "finalize", id: "pm-any", ...row }] as unknown as BulkItemMutation[];
      await expect(commitItemMutations({ pmRoot: pmPath, author, transactionId: "finalize-shape", mutations })).rejects.toThrow(message);
      await expect(readItemTransaction(pmPath, "finalize-shape")).resolves.toBeUndefined();
    });
  });

  it("accepts nested JSON values and names the row in direct validation", () => {
    expect(() => assertValidItemFinalization({ set: { sources: [{ number: 1, open: false, note: null }] } }, "Row")).not.toThrow();
    expect(() => assertValidItemFinalization({ unset: ["id"] }, "Row")).toThrow('Row cannot change "id"');
  });
});
