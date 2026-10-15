import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import { PmClient } from "../../../../src/sdk/runtime.js";
import { runRelease, type ReleaseMutationOptions } from "../../../../src/sdk/lifecycle/claim.js";

describe("release handoff guidance", () => {
  it("rejects malformed destinations and ownership-only bypass before changing queue state", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath });
      expect(context.runCli(["schema", "add-status", "review", "--role", "active"]).code).toBe(0);
      await client.create({ id: "pm-bypasshandoff", title: "Handoff bypass boundary", type: "Task", createMode: "progressive" });
      await client.claim("pm-bypasshandoff");
      await expect(runRelease("pm-bypasshandoff", false, { path: context.pmPath }, { handoff: 42, message: "Ready" } as unknown as ReleaseMutationOptions)).rejects.toThrow("configured non-terminal status");
      await expect(runRelease("pm-bypasshandoff", false, { path: context.pmPath }, { handoff: "review", message: "Ready", ownershipReleaseBypass: true } as ReleaseMutationOptions)).rejects.toThrow("only clears ownership");
      expect((await client.get("pm-bypasshandoff")).item).toMatchObject({ status: "open", assignee: expect.any(String) });
    });
  });
  it("returns source SDK guidance for unfinished work and no warning for open work", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath });
      await client.create({ id: "pm-handoff", title: "SDK handoff", type: "Task", status: "in_progress" });
      const released = await runRelease("pm-handoff", false, { path: context.pmPath });
      expect(released).toMatchObject({ item: { status: "in_progress" }, warnings: ["released_unclaimed_in_progress"] });
      await client.update("pm-handoff", { status: "open" });
      expect((await runRelease("pm-handoff", false, { path: context.pmPath })).warnings).toBeUndefined();
    });
  });

  it("uses the configured in-progress role for custom workflow statuses", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-status", "review", "--role", "active"]).code).toBe(0);
      await writeFile(join(context.pmPath, "schema", "workflows.json"), JSON.stringify({ workflow: { in_progress_status: "review" } }));
      const client = new PmClient({ pmRoot: context.pmPath });
      await client.create({ id: "pm-review", title: "Custom handoff", type: "Task", status: "review" });
      expect(await runRelease("pm-review", false, { path: context.pmPath })).toMatchObject({
        item: { status: "review" }, warnings: ["released_unclaimed_in_progress"],
        suggestions: [expect.stringContaining("remains review")],
      });
    });
  });

  it("preserves status while explaining how to stop work after releasing", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(["create", "--title", "Handoff work", "--type", "Task", "--create-mode", "progressive", "--status", "in_progress", "--json"], { expectJson: true });
      expect(created.code).toBe(0);
      const id = String((created.json as { item: { id: string } }).item.id);
      expect(context.runCli(["claim", id]).code).toBe(0);
      const released = context.runCli(["release", id, "--json"], { expectJson: true });
      expect(released.code).toBe(0);
      expect(released.json).toMatchObject({ item: { status: "in_progress" }, warnings: ["released_unclaimed_in_progress"], suggestions: [expect.stringContaining(`pm release ${id} --pause`)] });
    });
  });
});
