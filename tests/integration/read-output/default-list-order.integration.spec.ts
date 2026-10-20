import { describe, expect, it } from "vitest";
import { PmClient, type ContractsResult } from "../../../src/sdk/runtime.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("default list ordering context (pm-zd46m7)", () => {
  it("preserves ranking, custom projections and bounded continuation across native and CLI reads", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      const low = await client.create({ type: "Task", title: "Lower priority", priority: "3", createMode: "progressive" });
      const high = await client.create({ type: "Task", title: "Higher priority", priority: "0", createMode: "progressive" });
      const first = await client.list({ brief: true, limit: "1" });
      expect(first.items).toEqual([{ id: high.item.id, status: "open", type: "Task", title: "Higher priority", priority: 0 }]);
      expect(first.projection.fields).toContain("priority");
      expect(first).toMatchObject({ sorting: { sort: "default", order: "asc", effective_keys: [
        ["status_registry:nonterminal_before_terminal", "asc"],
        ["priority", "asc"], ["updated_at", "desc"], ["id", "asc"],
      ] }, has_more: true });
      const second = await client.list({ brief: true, limit: "1", after: first.next_cursor! });
      expect(second.items.map((item) => item.id)).toEqual([low.item.id]);
      expect(second.next_cursor).toBeNull();
      expect(second).toMatchObject({ continuation_contract: { metadata: "reference", restore_with: "omit --after" } });
      const contracts = await client.run("contracts", { options: { command: "list", full: true } }) as ContractsResult;
      expect(contracts.list_projections?.find((entry) => entry.command === "list")?.brief_fields)
        .toEqual(first.projection.fields);
      const custom = await client.list({ fields: "id,title" });
      expect(custom.projection.fields).toEqual(["id", "title"]);
      expect(custom.items.every((item) => !Object.hasOwn(item, "priority"))).toBe(true);
      const compact = await client.list({ compact: true });
      expect(compact.sorting).toBeUndefined();
      const full = await client.list({ full: true });
      expect(full.projection).toEqual({ mode: "full", fields: null });
      const sorted = await client.list({ brief: true, sort: "updated", order: "desc" });
      expect(sorted.projection.fields).toEqual(["id", "status", "type", "title", "updated_at"]);
      expect(sorted.sorting).toEqual({ sort: "updated_at", order: "desc" });
      const cli = context.runCli(["list", "--status", "open", "--limit", "1", "--json"], { expectJson: true });
      expect(cli.code, cli.stderr).toBe(0);
      expect(cli.json).toMatchObject({ items: first.items, sorting: first.sorting });
      const toon = context.runCli(["list", "--status", "open", "--limit", "1"]);
      expect(toon.code, toon.stderr).toBe(0);
      expect(toon.stdout).toContain("items[1]{id,status,type,title,priority}");
      expect(toon.stdout).toContain("effective_keys");
      expect(toon.stdout).toContain("nonterminal_before_terminal");
      expect(toon.stdout).toContain("next_cursor");
    });
  });
});
