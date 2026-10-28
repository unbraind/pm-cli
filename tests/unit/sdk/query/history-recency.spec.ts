import { describe, expect, it } from "vitest";
import { runHistory, type HistoryResult } from "../../../../src/sdk/query/history.js";
import { runUpdate } from "../../../../src/sdk/lifecycle/update.js";
import { applyReadOutputDimensions } from "../../../../src/sdk/read-output-contracts.js";
import { runAction } from "../../../../src/sdk/runtime.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { runWithHarnessDetectionSignals } from "../../../../src/core/shared/author.js";

/** Compare physical coordinates for projected rows and timestamps for full entries. */
function displayedCoordinates(result: HistoryResult) {
  if (result.compact_history) return result.compact_history.map(row => row.index);
  if (result.provenance_history) return result.provenance_history.map(row => row.version);
  return result.history?.map(row => row.ts);
}

describe("recent history recovery", () => {
  it("honors explicit display order for every projection and latest-entry window", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Ordered history" });
      for (let n = 2; n <= 4; n += 1) {
        await runUpdate(id, { title: `Title ${n}` }, { path: context.pmPath });
      }
      const cases = [{ compact: true }, { provenance: true }, { compact: false }].flatMap(mode =>
        [undefined, "2"].flatMap(limit =>
          (["oldest_first", "newest_first"] as const).map(order => ({ mode, limit, order }))));
      for (const { mode, limit, order } of cases) {
            const result = await runHistory(id, { ...mode, limit, order, diff: true }, { path: context.pmPath });
            const indices = limit ? [3, 4] : [1, 2, 3, 4];
            if (order === "newest_first") indices.reverse();
            expect(result.order).toBe(order);
            expect(result.diff?.map(row => row.index)).toEqual(indices);
            expect(displayedCoordinates(result)).toEqual(result.history ? result.diff?.map(row => row.ts) : indices);
      }
      const limited = await runHistory(id, { compact: true, limit: "2" }, { path: context.pmPath });
      expect(limited.compact_history?.map(row => row.index)).toEqual([4, 3]);
      const args = ["history", id, "--diff", "--order", "oldest_first", "--limit", "2", "--json"];
      const cli = context.runCli(args, { expectJson: true });
      expect(cli.code).toBe(0);
      expect(cli.json).toMatchObject({ order: "oldest_first", diff: [{ index: 3 }, { index: 4 }] });
      expect(await runAction({ action: "history", id, path: context.pmPath, options: { order: "oldest_first", limit: "2", diff: true } }))
        .toMatchObject({ order: "oldest_first", diff: [{ index: 3 }, { index: 4 }] });
      await expect(runHistory(id, { order: "invalid" as "oldest_first" }, { path: "/nonexistent-order-validation" }))
        .rejects.toThrow("--order must be oldest_first or newest_first");
    });
  });

  it("aligns filtered diffs with physical history while replaying excluded updates", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Filtered diff" });
      for (const [index, instance] of ["selected", "excluded", "selected", "excluded"].entries()) {
        await runWithHarnessDetectionSignals({
          env: { CODEX_THREAD_ID: instance }, home_dir: context.tempRoot,
          cwd: context.tempRoot, argv: [], probes_enabled: false,
        }, () => runUpdate(id, { title: `Title ${index + 2}` }, { path: context.pmPath }));
      }
      const full = await runHistory(id, {}, { path: context.pmPath });
      const agentInstance = full.history?.[1]?.agent_instance;
      expect(agentInstance).toBeTypeOf("string");
      for (const mode of [{ compact: true }, { provenance: true }, { compact: false }]) {
        const result = await runHistory(id, { ...mode, agentInstance, diff: true }, { path: context.pmPath });
        const indices = mode.compact === false ? [2, 4] : [4, 2];
        expect(result.diff?.map((row) => row.index)).toEqual(indices);
        expect(result.diff?.find((row) => row.index === 4)?.changes).toContainEqual({ field: "title", before: "Title 3", after: "Title 4" });
      }
      const limited = await runHistory(id, { compact: true, agentInstance, limit: "1", field: "title" }, { path: context.pmPath });
      expect(limited.diff).toMatchObject([{ index: 4, changes: [{ field: "title", before: "Title 3", after: "Title 4" }] }]);
      expect(await runHistory(id, { agentInstance: "absent", diff: true }, { path: context.pmPath })).toMatchObject({ count: 0, diff: [] });
      const cli = context.runCli(["history", id, "--agent-instance", agentInstance!, "--diff", "--field", "title", "--json"], { expectJson: true });
      expect(cli.code).toBe(0);
      expect((cli.json as { diff: Array<{ index: number }> }).diff.map((row) => row.index)).toEqual([4, 2]);
    });
  });

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
      expect(limited.compact_history?.map((row) => row.index)).toEqual([251, 250, 249, 248, 247]);
      const cliFull = context.runCli(["history", id, "--full", "--output-budget", "unbounded", "--json"], { expectJson: true });
      expect(cliFull.code).toBe(0);
      expect(cliFull.json).toMatchObject({ history: full.history, count: 251 });
      expect(await runHistory(id, { verify: true }, { path: context.pmPath })).toEqual(full);
    });
  });
});
