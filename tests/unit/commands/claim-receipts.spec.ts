import { describe, expect, it } from "vitest";
import { PmClient, runAction } from "../../../src/sdk/runtime.js";
import { createTaskFixture } from "../../helpers/createTaskFixture.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("claim transport receipts", () => {
  it("keeps CLI ownership evidence compact and preserves explicit full and identity output", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(context, "pm-claimreceipt", "Claim receipt transport acceptance");
      expect(context.runCli(["update", "pm-claimreceipt", "--description", "Detailed context. ".repeat(1_000)]).code).toBe(0);
      const run = (flags: string[]) => context.runCli(["claim", "pm-claimreceipt", "--json", ...flags], { expectJson: true, preserveDefaultMutationOutput: true });
      const first = run([]);
      expect(first.code, first.stderr).toBe(0);
      expect(first.json).toMatchObject({ id: "pm-claimreceipt", status: "open", claimed_by: "test-author", previous_assignee: null, forced: false, changed_field_count: 2 });
      expect(first.json).not.toHaveProperty("item");
      expect(first.stdout.length).toBeLessThan(350);
      const quiet = context.runCli(["claim", "pm-claimreceipt", "--quiet"], { preserveDefaultMutationOutput: true });
      expect(quiet.code).toBe(0);
      expect(quiet.stdout).toBe("");
      expect(run([]).json).toHaveProperty("changed_field_count", 0);
      expect(run(["--full-changed-fields"]).json).toMatchObject({ item: { id: "pm-claimreceipt", assignee: "test-author" }, changed_fields: [] });
      expect(run(["--id-only"]).json).toEqual({ id: "pm-claimreceipt", status: "open" });
      expect(run(["--author", "contender", "--if-available"]).json).toMatchObject({ id: "pm-claimreceipt", skipped: true, claimed_by: "test-author", changed_field_count: 0 });
    });
  });

  it("shares MCP projection while typed SDK claims remain complete", async () => {
    await withTempPmPath(async (context) => {
      const id = "pm-mcpreceipt";
      createTaskFixture(context, id, "MCP and SDK ownership receipt acceptance");
      const args = { path: context.pmPath, noExtensions: true, author: "test-author" };
      expect(await runAction({ ...args, action: "claim", id })).toMatchObject({ id, changed_field_count: 2, claimed_by: "test-author" });
      expect(await runAction({ ...args, action: "claim", id, idOnly: true })).toEqual({ id, status: "open" });
      expect(await new PmClient({ pmRoot: context.pmPath, noExtensions: true, author: "test-author" }).claim(id)).toMatchObject({ item: { id }, changed_fields: [] });
      const selected = await runAction({ ...args, action: "claim", next: true });
      expect(selected).toMatchObject({ id, available: true, attempts: 1, changed_field_count: 0 });
      expect(selected).not.toHaveProperty("item");
      expect(await runAction({ ...args, action: "claim", fullChangedFields: true, options: { id } })).toMatchObject({ item: { id }, changed_fields: [] });
      expect(await runAction({ ...args, action: "claim", fullChangedFields: true, options: { next: true } })).toMatchObject({ item: { id }, recommendation: expect.any(Object) });
      const contender = { ...args, author: "contender", action: "claim", id };
      expect(await runAction({ ...contender, options: { ifAvailable: true } })).toMatchObject({ id, skipped: true, changed_field_count: 0 });
      expect(await runAction({ ...contender, force: true })).toMatchObject({ id, claimed_by: "contender", previous_assignee: "test-author", forced: true, warnings: ["claim_takeover:test-author->contender"] });
      expect(await runAction({ ...args, action: "claim", id, options: { force: true } })).toMatchObject({ id, forced: true, claimed_by: "test-author" });
      expect(await runAction({ ...args, action: "claim", next: true, options: { tag: "absent", ifAvailable: true } })).toMatchObject({ available: false, item: null, skipped: true, attempts: 0 });
      await expect(runAction({ ...args, action: "claim" })).rejects.toThrow("Missing required argument: id");
    });
  });
});
