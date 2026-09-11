import { describe, expect, it } from "vitest";
import { PmClient, runAction, buildPmActionToolInputSchema } from "../../src/sdk/index.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("compound lifecycle transport receipts", () => {
  it("advertises projection controls and reports committed ownership when the later update fails", async () => {
    for (const action of ["release", "start-task", "pause-task", "close-task"] as const) {
      expect(buildPmActionToolInputSchema(action)).toMatchObject({ properties: { idOnly: { type: "boolean" }, fullChangedFields: { type: "boolean" } } });
    }
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      const { item } = await client.create({ title: "Partial composition", createMode: "progressive" });
      await expect(runAction({ action: "claim", id: item.id, path: context.pmPath, start: true, noExtensions: true, options: { priority: "invalid" } })).rejects.toMatchObject({
        context: { item_id: item.id, why: expect.stringContaining("claim completed"), nextSteps: expect.arrayContaining([expect.stringContaining(`pm get ${item.id}`)]) },
      });
      const persisted = (await client.get(item.id)).item;
      expect(persisted.status).toBe("open");
      expect(persisted.assignee).toBeTruthy();
    });
  });
  it("bounds canonical and alias output while preserving full SDK snapshots", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      const description = "Detailed project context. ".repeat(1000);
      const { item } = await client.create({ title: "Compound receipts", description, createMode: "progressive" });
      const common = { id: item.id, path: context.pmPath, noExtensions: true };
      for (const alias of [false, true]) {
        const started = await runAction({ ...common, action: alias ? "start-task" : "claim", options: { start: true } });
        expect(started).toMatchObject({ id: item.id, action: "start_task", status: "in_progress", claim: { changed_field_count: 2 }, update: { status: "in_progress" } });
        expect(JSON.stringify(started).length).toBeLessThan(1000);
        const paused = await runAction({ ...common, action: alias ? "pause-task" : "release", options: { pause: true } });
        expect(paused).toMatchObject({ id: item.id, action: "pause_task", status: "open", release: { changed_field_count: 2 } });
        expect(JSON.stringify(paused).length).toBeLessThan(1000);
      }
      expect((await client.startTask(item.id)).update.item.description).toBe(description);
      expect(await runAction({ ...common, action: "release", pause: true, idOnly: true })).toEqual({ id: item.id, status: "open" });
      const result = context.runCli(["claim", item.id, "--start", "--json"], { expectJson: true, preserveDefaultMutationOutput: true });
      expect(result.code, result.stderr).toBe(0);
      expect(result.json).toMatchObject({ id: item.id, status: "in_progress", action: "start_task" });
      expect(result.stdout.length).toBeLessThan(1500);
      const full = context.runCli(["release", item.id, "--pause", "--json", "--full-changed-fields"], { expectJson: true });
      expect(full.json).toMatchObject({ release: { item: { description } } });
      const closed = await runAction({ ...common, action: "close", reason: "Verified", releaseAssignment: true, options: { validateClose: "warn" } });
      expect(closed).toMatchObject({ id: item.id, status: "closed", action: "close_task", close: { close_reason: "Verified" }, release: { changed_field_count: 0 } });
      expect(JSON.stringify(closed).length).toBeLessThan(1500);
    });
  });
});
