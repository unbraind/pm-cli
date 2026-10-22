/** @module tests/integration/sdk/mcp-mutation-contract.integration Schema-to-persistence mutation proof (pm-gh1538, pm-ap7ilf). */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../../../src/mcp/server.js";
import { PM_MCP_META_KEYS, PM_MCP_PROTOCOL_VERSION, PM_MCP_PROGRESSIVE_DISCOVERY_EXTENSION } from "../../../src/sdk/index.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const meta = {
  [PM_MCP_META_KEYS.protocolVersion]: PM_MCP_PROTOCOL_VERSION,
  [PM_MCP_META_KEYS.clientCapabilities]: { extensions: { [PM_MCP_PROGRESSIVE_DISCOVERY_EXTENSION]: {} } },
};

/** Exercise the same negotiated request boundary as the stdio transport. */
function mcpCall(pmPath: string, name: string, args: Record<string, unknown>) {
  return handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { path: pmPath, ...args }, _meta: meta } });
}

describe("MCP mutation advertised fields", () => {
  it("persists discovered flat fields, respects nested precedence and refuses invalid values atomically", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "MCP update", priority: 1, createMode: "progressive" });
      const call = (name: string, args: Record<string, unknown>) => mcpCall(context.pmPath, name, args);
      const discovered = await call("pm_discover", { query: "pm_update", includeSchema: true, outputBudget: "unbounded" });
      expect(discovered?.structuredContent).toMatchObject({ result: { tools: expect.arrayContaining([
        expect.objectContaining({ name: "pm_update", input_schema: expect.objectContaining({ properties: expect.objectContaining({ priority: expect.any(Object), status: expect.any(Object) }) }) }),
      ]) } });
      const flat = await call("pm_update", { id, options: {}, priority: 4, status: "in_progress" });
      expect(flat?.isError).toBeUndefined();
      expect(flat?.structuredContent).toMatchObject({ result: { changed_field_count: 2 } });
      const get = () => context.runCli(["get", id, "--full", "--json"], { expectJson: true }).json;
      expect(get()).toMatchObject({ item: { priority: 4, status: "in_progress" } });

      const mixed = await call("pm_run", { action: "update", id, priority: 3, title: "flat title", options: { priority: 2 } });
      expect(mixed?.isError).toBeUndefined();
      expect(get()).toMatchObject({ item: { priority: 2, title: "flat title" } });
      expect((await call("pm_update", { id, options: { force: false, clearComments: false, comment: [] } }))?.isError).toBeUndefined();
      // Public parameter aliases and scalar/list normalization must reach the same persistence path.
      await call("pm_update", { id, options: {}, estimate: 17, tags: ["first", "second"], linkedFile: "path=src/example.ts", comment: "flat evidence", body: "-" });
      expect(get()).toMatchObject({ item: { estimated_minutes: 17, tags: ["first", "second"], body: "-", files: [expect.objectContaining({ path: "src/example.ts" })], comments: [expect.objectContaining({ text: "flat evidence" })] } });

      const bytes = () => Promise.all([
        readFile(path.join(context.pmPath, "tasks", `${id}.toon`)),
        readFile(path.join(context.pmPath, "history", `${id}.jsonl`)),
      ]);
      const before = await bytes();
      for (const malformed of [
        { priority: false }, { title: false }, { status: [] },
        { linkedFile: 4 }, { linkedFile: ["path=src/partial.ts", 4] }, { force: "false" },
        { options: null }, { options: [] },
        { options: { priority: false, title: "must not persist" } },
      ]) {
        await expect(call("pm_update", { id, options: {}, title: "must not persist", ...malformed })).rejects.toMatchObject({ exitCode: 2, context: { changed: false } });
        expect(await bytes()).toEqual(before);
      }
      await expect(call("pm_update", { id, priority: 99, title: "must not persist", options: {} })).rejects.toMatchObject({ exitCode: 2 });
      expect(await bytes()).toEqual(before);
      expect(context.runCli(["history", id, "--verify", "--strict-exit", "--json"]).code).toBe(0);
    });
  });

  it("honors create metadata, nested aliases and custom fields before recording any writes", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-field", "delivery_channel", "--type", "string", "--commands", "create,update", "--json"]).code).toBe(0);
      const create = (args: Record<string, unknown>) => mcpCall(context.pmPath, "pm_create", { title: "Canonical creation", type: "Task", options: { createMode: "progressive" }, ...args });
      const created = await create({ id: "pm-mcpflat", deadline: "2026-11-01", estimate: 17, priority: 4, regression: false, allowDuplicate: false, deliveryChannel: "email", linkedFile: "path=src/create.ts", options: { createMode: "progressive", priority: 2 } });
      expect(created?.structuredContent).toMatchObject({ result: { id: "pm-mcpflat" } });
      const get = (id: string) => context.runCli(["get", id, "--full", "--json"], { expectJson: true }).json;
      expect(get("pm-mcpflat")).toMatchObject({ item: { deadline: expect.stringContaining("2026-11-01"), estimated_minutes: 17, priority: 2, regression: false, delivery_channel: "email", files: [expect.objectContaining({ path: "src/create.ts" })] } });
      const nested = await create({ id: "pm-unused", title: "Nested creation metadata", estimate: 99, options: { createMode: "progressive", id: "pm-mcpnested", estimatedMinutes: "23" } });
      expect(nested?.structuredContent).toMatchObject({ result: { id: "pm-mcpnested" } });
      expect(get("pm-mcpnested")).toMatchObject({ item: { estimated_minutes: 23 } });
      await create({ id: "pm-imported", title: "Imported terminal work", status: "closed", closeReason: "Imported completion", completedAt: "2026-10-01T12:00:00Z", options: { createMode: "progressive", resolution: "Imported completion", expectedResult: "Imported", actualResult: "Imported" } });
      expect(get("pm-imported")).toMatchObject({ item: { status: "closed", close_reason: "Imported completion", completed_at: "2026-10-01T12:00:00.000Z" } });
      expect(context.runCli(["history", "pm-imported", "--verify", "--strict-exit", "--json"]).code).toBe(0);
      const snapshot = async () => Promise.all((await readdir(context.pmPath, { recursive: true }))
        .filter((entry) => /^(?:tasks|history)[\\/].+\.(?:toon|jsonl)$/u.test(entry)).sort()
        .map(async (entry) => [entry, await readFile(path.join(context.pmPath, entry))]));
      const before = await snapshot();
      for (const invalid of [{ priority: false }, { type: false }, { comment: ["partial", 4] }, { options: null }]) {
        await expect(create({ id: "pm-invalid", title: "Refused creation", ...invalid })).rejects.toMatchObject({ exitCode: 2, context: { changed: false } });
        expect(await snapshot()).toEqual(before);
      }
      await expect(create({ id: "pm-invalid", title: "Refused parent", parent: "pm-absent", allowMissingParent: true, options: { createMode: "progressive", allow_missing_parent: false } })).rejects.toThrow(/parent/iu);
      expect(await snapshot()).toEqual(before);
    });
  });
});
