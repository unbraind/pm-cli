import { describe, expect, it } from "vitest";
import { runHistory } from "../../../../src/sdk/query/history.js";
import { runUpdate } from "../../../../src/sdk/lifecycle/update.js";
import { applyReadOutputDimensions } from "../../../../src/sdk/read-output-contracts.js";
import { runAction } from "../../../../src/sdk/runtime.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";

describe("recent history recovery", () => {
  it("keeps the newest of 251 native entries and resumes every older entry exactly once", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Recent handoff" });
      for (let index = 1; index <= 250; index += 1) {
        await runUpdate(id, { title: `Handoff ${index}` }, { path: context.pmPath });
      }
      const full = await runHistory(id, { verify: true }, { path: context.pmPath });
      expect(full.count).toBe(251);
      expect(full.verification?.ok).toBe(true);
      const result = await runHistory(id, { compact: true }, { path: context.pmPath });
      expect(result.compact_history?.[0]?.index).toBe(251);
      const received: number[] = [];
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 251; pageNumber += 1) {
        const page = applyReadOutputDimensions("history", {
          outputBudget: 900, outputCursor: cursor, resolvedOutputFormat: "json",
        }, result as unknown as Record<string, unknown>);
        expect(page).not.toHaveProperty("output_budget_exceeded");
        const rows = page.compact_history as Array<{ index: number }>;
        expect(page.count).toBe(rows.length);
        received.push(...rows.map((row) => row.index));
        cursor = (page.output_budget_truncation as { continuations: Array<{ path: string; cursor: string }> } | undefined)
          ?.continuations.find((entry) => entry.path === "compact_history")?.cursor;
        if (!cursor) break;
      }
      expect(cursor).toBeUndefined();
      expect(received).toEqual(Array.from({ length: 251 }, (_, index) => 251 - index));
      const cli = context.runCli(["history", id, "--json"], { expectJson: true });
      expect(cli.code).toBe(0);
      expect((cli.json as { compact_history: Array<{ index: number }> }).compact_history[0]).toMatchObject({ index: 251 });
      const mcp = await runAction({ action: "history", id, path: context.pmPath, options: { outputBudget: "unbounded" } });
      expect(mcp).toMatchObject({ compact_history: result.compact_history });
      for (const options of [{ full: true }, { compact: false }]) {
        expect(await runAction({ action: "history", id, path: context.pmPath, outputBudget: "unbounded", options }))
          .toMatchObject({ history: full.history, order: "oldest_first", total: 251 });
      }
      const provenance = await runAction({ action: "history", id, path: context.pmPath, outputBudget: "unbounded", options: { provenance: true } }) as { provenance_history: Array<{ version: number }> };
      expect(provenance.provenance_history[0]?.version).toBe(251);
      const diff = await runHistory(id, { compact: true, diff: true }, { path: context.pmPath });
      expect(diff.diff?.map((row) => row.index)).toEqual(received);
      const limited = await runHistory(id, { compact: true, limit: "5" }, { path: context.pmPath });
      expect(limited.compact_history?.map((row) => row.index)).toEqual([247, 248, 249, 250, 251]);
      const cliFull = context.runCli(["history", id, "--full", "--output-budget", "unbounded", "--json"], { expectJson: true });
      expect(cliFull.code).toBe(0);
      expect(cliFull.json).toMatchObject({ history: full.history, count: 251 });
      expect(await runHistory(id, { verify: true }, { path: context.pmPath })).toEqual(full);
    });
  });
});
