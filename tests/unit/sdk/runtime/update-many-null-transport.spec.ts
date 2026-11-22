import { describe, expect, it } from "vitest";
import { PmClient, runAction } from "../../../../src/sdk/index.js";
import { markMcpMutationTransportInput, updateManyOptionsFromFlat } from "../../../../src/sdk/runtime-input.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

type Fields = Record<string, unknown>;

/** The two runAction spellings of one update-many request. */
const SPELLINGS: ReadonlyArray<[string, (id: string, fields: Fields) => Fields]> = [
  ["flat", (id, fields) => ({ ids: [id], ...fields })],
  ["nested", (id, fields) => ({ ids: [id], update: fields })],
  ["nested with a list record", (id, fields) => ({ list: { ids: id }, update: fields })],
];

async function seed(pmPath: string) {
  const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
  const id = (await client.create({ title: "Row", type: "Task", assignee: "alice", sprint: "s1" })).item.id;
  const updateMany = (options: Fields, mcp = false) => {
    const args = { action: "update-many", path: pmPath, noExtensions: true, author: "transport-test", options };
    return runAction(mcp ? markMcpMutationTransportInput(args) : args);
  };
  const read = async () => (await client.get(id)).item as Record<string, unknown>;
  return { id, updateMany, read };
}

describe("update-many typed null transport (pm-w7clh6)", () => {
  it.each(SPELLINGS)("clears a clearable field and applies the rest of the update: %s", async (_name, build) => {
    await withTempPmPath(async ({ pmPath }) => {
      const { id, updateMany, read } = await seed(pmPath);
      await expect(updateMany(build(id, { assignee: null, sprint: null, description: "changed" }))).resolves.toMatchObject({ updated_count: 1 });
      const item = await read();
      expect(item).toMatchObject({ description: "changed" });
      expect(item).not.toHaveProperty("assignee");
      expect(item).not.toHaveProperty("sprint");
    });
  });

  it.each(SPELLINGS)("refuses a null on a field unset cannot clear, by name, before any row changes: %s", async (_name, build) => {
    await withTempPmPath(async ({ pmPath }) => {
      const { id, updateMany, read } = await seed(pmPath);
      await expect(updateMany(build(id, { title: null, description: "changed" }))).rejects.toThrow("update title must be a string.");
      // An alias spelling keeps its own name in the refusal, as a single update's does.
      await expect(updateMany(build(id, { unblock_note: null, description: "changed" }))).rejects.toThrow("update unblock_note must be a string.");
      expect(await read()).toMatchObject({ assignee: "alice", description: "" });
    });
  });

  it.each<[string, (id: string) => Fields]>([
    ["filterAssignee", (id) => ({ ids: [id], description: "changed", filterAssignee: null })],
    ["ids", () => ({ description: "changed", ids: null })],
    ["limit", (id) => ({ ids: [id], description: "changed", limit: null })],
    ["offset", (id) => ({ ids: [id], description: "changed", offset: null })],
    // A nested list record is the same selection: a null there must not widen the update to every row.
    ["list.assignee", (id) => ({ list: { ids: id, assignee: null }, update: { description: "changed" } })],
    // Null controls would be read as absent: an unfiltered run, or a real write where a dry run was meant.
    ["list", () => ({ list: null, update: { description: "changed" } })],
    ["dryRun", (id) => ({ ids: [id], description: "changed", dryRun: null })],
    ["update", (id) => ({ ids: [id], description: "changed", update: null })],
    // Beside a nested update record an outer field is not an update field, so its null means nothing.
    ["assignee", (id) => ({ ids: [id], assignee: null, update: { description: "changed" } })],
    // A key that is no declared update option has no clear rule; a schema field would store the text "null".
    ["customer_tier", (id) => ({ ids: [id], description: "changed", customer_tier: null })],
    ["customer_tier", (id) => ({ ids: [id], update: { description: "changed", customer_tier: null } })],
  ])("refuses a typed null on %s by name instead of dropping or storing it", async (key, build) => {
    await withTempPmPath(async ({ pmPath }) => {
      const { id, updateMany, read } = await seed(pmPath);
      const failure = await updateMany(build(id)).catch((error: unknown) => error);
      // Option admission (pm-xp7ldt) names an undeclared or misplaced key before the null rule reads its value.
      const message = key === "assignee" || key === "customer_tier" ? expect.stringMatching(new RegExp(`^Unknown update-many option "${key}"\\. .* No changes were made\\.$`, "u")) : `update-many "${key}" cannot be null. No changes were made.`;
      expect(failure).toMatchObject({ message, context: { code: "invalid_argument_value", field: key, changed: false } });
      expect(await read()).toMatchObject({ assignee: "alice", description: "" });
    });
  });

  it("keeps an MCP client's null as an omitted argument", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const { id, updateMany, read } = await seed(pmPath);
      await expect(updateMany({ ids: [id], assignee: null, filterAssignee: null, description: "changed" }, true)).resolves.toMatchObject({ updated_count: 1 });
      expect(await read()).toMatchObject({ assignee: "alice", description: "changed" });
    });
  });

  it("carries nulls under the canonical option only for a typed dispatch", () => {
    expect(updateManyOptionsFromFlat({ ids: ["a"], assignee: null, blockedBy: null, priority: 2 }, true).update).toMatchObject({ assignee: null, blockedBy: null, priority: "2" });
    expect(() => updateManyOptionsFromFlat({ ids: ["a"], bogus: null }, true)).toThrow('update-many "bogus" cannot be null.');
    expect(updateManyOptionsFromFlat({ ids: ["a"], bogus: null, list: { assignee: null }, update: { title: "x" } }).update).toMatchObject({ title: "x" });
    expect(updateManyOptionsFromFlat({ ids: ["a"], update: { assignee: null } }, true).update).toMatchObject({ assignee: null });
    expect(updateManyOptionsFromFlat({ ids: ["a"], assignee: null, priority: 2 }).update.assignee).toBeUndefined();
    expect(updateManyOptionsFromFlat({ ids: ["a"], update: { assignee: null } }).update.assignee).toBeUndefined();
  });
});
