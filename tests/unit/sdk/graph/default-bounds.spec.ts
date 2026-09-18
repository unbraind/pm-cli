import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serializeItemDocument } from "../../../../src/core/item/item-format.js";
import { runGraph, GRAPH_SUBCOMMAND_VALUES } from "../../../../src/sdk/graph/run.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("graph default bounds", () => {
  it("bounds every graph subcommand on a thousand-item workspace and restores explicit full traversals", async () => {
    await withTempPmPath(async (context) => {
      const contracts = context.runCli(["contracts", "--command", "graph", "--flags-only", "--json"]);
      expect(contracts.status).toBe(0);
      expect(JSON.parse(contracts.stdout)).toMatchObject({ command_flags: [expect.objectContaining({ flags: expect.arrayContaining([
        { flag: "--limit", description: "Maximum rows per collection; default 10. Use --full to remove the row cap." },
        { flag: "--max-paths", description: "Maximum enumerated paths; default 5." },
      ]) })] });
      // A long hierarchy and ordering chain exercises both depth and population.
      const ids = Array.from({ length: 1000 }, (_, index) => `pm-node${String(index).padStart(4, "0")}`);
      for (const [index, id] of ids.entries()) {
        await writeFile(path.join(context.pmPath, "tasks", `${id}.toon`), serializeItemDocument({
          metadata: {
            id, title: `Graph node ${index}`, description: "Graph bound regression fixture", type: "Task", status: "open", priority: 2,
            created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
            ...(index === 0 ? {} : { parent: ids[index - 1], dependencies: [{ id: ids[index - 1], kind: "blocked_by" }] }),
          },
          body: "",
        }, { format: "toon" }));
      }
      for (const subcommand of GRAPH_SUBCOMMAND_VALUES) {
        const root = ["ancestors", "predecessors"].includes(subcommand) ? ids.at(-1)! : ids[0];
        const result = await runGraph(subcommand, root, ids[2], {}, { path: context.pmPath });
        expect(Buffer.byteLength(JSON.stringify(result)), subcommand).toBeLessThan(24_000);
        if ("ids" in result) expect(result.ids, subcommand).toHaveLength(10);
        if ("rows" in result) expect(result.rows!.length, subcommand).toBeLessThanOrEqual(10);
        if ("critical_path" in result) expect(result.critical_path!.length).toBeLessThanOrEqual(10);
        await expect(runGraph(subcommand, root, ids[2], { full: true, limit: 1 }, { path: context.pmPath })).rejects.toThrow("accepts either --full or --limit, not both");
      }
      const zero = context.runCli(["graph", "impact", ids[0]!, "--limit", "0", "--json"]);
      expect(zero.status).toBe(0);
      const zeroResult = JSON.parse(zero.stdout);
      expect(zeroResult).toMatchObject({ count: 0, truncated: true, next_cursor: expect.any(String) });
      const sdkZero = await runGraph("impact", ids[0], undefined, { limit: 0 }, { path: context.pmPath });
      expect(sdkZero).toMatchObject({ count: 0, next_cursor: zeroResult.next_cursor });
      const resumed = await runGraph("impact", ids[0], undefined, { after: zeroResult.next_cursor }, { path: context.pmPath });
      expect(resumed).toMatchObject({ count: 10 });
      const first = await runGraph("descendants", ids[0], undefined, {}, { path: context.pmPath });
      expect(first).toMatchObject({ count: 10, truncated: true });
      const next = await runGraph("descendants", ids[0], undefined, { after: "next_cursor" in first ? first.next_cursor : undefined }, { path: context.pmPath });
      expect(next).toMatchObject({ ids: ids.slice(11, 21) });
      const full = await runGraph("descendants", ids[0], undefined, { full: true }, { path: context.pmPath });
      expect(full).toMatchObject({ count: 999, truncated: false, ids: ids.slice(1) });
    });
  }, 60_000);
});
