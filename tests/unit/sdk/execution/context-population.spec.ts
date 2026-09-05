import { describe, expect, it } from "vitest";
import { runContext } from "../../../../src/sdk/query/context.js";
import { PmClient } from "../../../../src/sdk/runtime.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("context population accounting", () => {
  it("counts terminal and blocked work within the requested subtree", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath });
      await client.create({ id: "pm-scope", title: "Scope", type: "Epic" });
      await client.create({ id: "pm-outside", title: "Outside", type: "Task" });
      for (const status of ["open", "in_progress", "closed", "canceled"]) {
        await client.create({
          id: `pm-${status.replaceAll("_", "")}`, title: `${status} work`,
          type: "Task", parent: "pm-scope", status,
          message: "Fixture records the lifecycle state for population accounting",
        });
      }
      await client.update("pm-open", { blockedBy: "pm-outside", blockedReason: "External subtree prerequisite" });
      const result = await runContext({ parent: "pm-scope", limit: "1", depth: "brief" }, { path: context.pmPath });
      expect(result.summary).toMatchObject({
        scope: "matching_items", total_items: 5, active_items: 3,
        open: 2, in_progress: 1, closed: 1, canceled: 1, blocked: 1,
      });
    });
  });

  it("keeps population counts stable across bounded focus pages and intents", async () => {
    await withTempPmPath(async (context) => {
      for (let index = 0; index < 6; index += 1) {
        const created = context.runCli(["create", "--title", `Population task ${index}`,
          "--type", "Task", "--create-mode", "progressive", "--json"]);
        expect(created.status).toBe(0);
      }
      for (const limit of ["1", "3"]) {
        const result = await runContext({ limit, depth: "brief" }, { path: context.pmPath });
        expect(result.summary).toMatchObject({
          scope: "matching_items", active_items: 6, open: 6, in_progress: 0,
          blocked: 0, total_items: 6, closed: 0, canceled: 0,
        });
        expect(result.summary.returned_focus?.active_items).toBeLessThanOrEqual(Number(limit));
      }
      for (const intent of ["orient", "handoff"]) {
        const response = context.runCli(["context", "--for", intent, "--limit", "1", "--json"], { expectJson: true });
        expect(response.status).toBe(0);
        expect(response.json).toMatchObject({ summary: { scope: "matching_items", open: 6 }, omission_receipt: { summary_scope: "matching_items" } });
      }
    });
  });
});
