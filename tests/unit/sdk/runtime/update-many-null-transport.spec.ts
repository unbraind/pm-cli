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

  it.each(["filterAssignee", "ids", "limit", "offset"])("refuses a flat null on the selection key %s instead of clearing a field", async (key) => {
    await withTempPmPath(async ({ pmPath }) => {
      const { id, updateMany, read } = await seed(pmPath);
      const failure = await updateMany({ ids: [id], description: "changed", [key]: null }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ message: `update-many "${key}" selects rows and cannot be null. No changes were made.`, context: { code: "invalid_argument_value", field: key, changed: false } });
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
    expect(updateManyOptionsFromFlat({ ids: ["a"], assignee: null, bogus: null, priority: 2 }, true).update).toMatchObject({ assignee: null, bogus: null, priority: "2" });
    expect(updateManyOptionsFromFlat({ ids: ["a"], update: { assignee: null } }, true).update).toMatchObject({ assignee: null });
    expect(updateManyOptionsFromFlat({ ids: ["a"], assignee: null, priority: 2 }).update.assignee).toBeUndefined();
    expect(updateManyOptionsFromFlat({ ids: ["a"], update: { assignee: null } }).update.assignee).toBeUndefined();
  });
});
