import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PmClient, runAction } from "../../../src/sdk/runtime.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("configured lifecycle handoff", () => {
  it.each(["SDK", "MCP flat", "MCP nested", "CLI"])("records an atomic evidence-backed handoff through %s", async (transport) => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-status", "review", "--role", "active", "--alias", "qa"]).code).toBe(0);
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true, author: "test-author" });
      const id = "pm-handoff";
      await client.create({ id, title: "Verify the implementation", type: "Task", createMode: "progressive" });
      await client.claim(id, { start: true });
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const before = await readFile(historyPath, "utf8");
      const message = "Implementation complete; verifier should run the linked regression.";
      const options = { handoff: "qa", message };
      const common = { id, action: "release", path: context.pmPath, noExtensions: true, author: "test-author" };
      let result: unknown;
      if (transport === "SDK") result = await client.release(id, options);
      else if (transport === "MCP flat") result = await runAction({ ...common, ...options, fullChangedFields: true });
      else if (transport === "MCP nested") result = await runAction({ ...common, options, fullChangedFields: true });
      else {
        const released = context.runCli(["release", id, "--handoff", "qa", "--message", message, "--json"], { expectJson: true });
        expect(released.code, released.stderr).toBe(0);
        result = released.json;
      }
      expect(result).toMatchObject({ item: { id, status: "review" }, changed_fields: expect.arrayContaining(["status", "assignee", "claim_principal"]), handoff: { from_status: "in_progress", to_status: "review", message } });
      expect(result).not.toHaveProperty("warnings");
      const current = (await client.get(id)).item;
      expect(current).not.toHaveProperty("assignee");
      expect(current).not.toHaveProperty("claim_principal");
      const after = await readFile(historyPath, "utf8");
      expect(after.startsWith(before)).toBe(true);
      const appended = after.slice(before.length).trim().split("\n").map((line) => JSON.parse(line));
      expect(appended).toHaveLength(1);
      expect(appended[0]).toMatchObject({ op: "release", author: "test-author", message, patch: expect.arrayContaining([expect.objectContaining({ path: "/metadata/status", value: "review" }), expect.objectContaining({ op: "remove", path: "/metadata/assignee" })]) });
      expect(context.runCli(["history", id, "--verify"]).code).toBe(0);
      if (transport === "MCP nested") {
        await client.claim(id);
        expect(await runAction({ ...common, ...options })).toMatchObject({ id, status: "review", handoff: { from_status: "review", to_status: "review", message } });
      }
      expect((await client.list({ status: "review" })).items.map((item) => item.id)).toContain(id);
      expect((await client.list({ status: "in_progress" })).items).toHaveLength(0);
      const queue = await client.context({ depth: "full" });
      expect(queue.low_level).toEqual(expect.arrayContaining([expect.objectContaining({ id, status: "review" })]));
      expect(queue.summary.in_progress).toBe(0);
      await client.claim(id);
      const sameQueue = await client.release(id, { handoff: "review", message: "Verification deferred; keep the review queue." });
      expect(sameQueue.changed_fields).not.toContain("status");
      await client.claim(id, { start: true });
      expect((await client.get(id)).item.status).toBe("in_progress");
      await client.release(id, { handoff: "review", message: "Rework verified; ready for final check." });
      const closed = await client.close(id, "Verified", { validateClose: "strict", resolution: "Implemented", expectedResult: "Regression passes", actualResult: "Regression passed" });
      expect(closed.item.status).toBe("closed");
    });
  });

  it("refuses invalid handoffs without releasing ownership or appending item history", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-status", "review", "--role", "active"]).code).toBe(0);
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true, author: "test-author" });
      const id = "pm-invalidhandoff";
      await client.create({ id, title: "Preserve owner", type: "Task", createMode: "progressive" });
      await client.claim(id, { start: true });
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const before = await readFile(historyPath, "utf8");
      for (const options of [
        { handoff: "unknown", message: "Ready" },
        { handoff: "closed", message: "Ready" },
        { handoff: "in_progress", message: "Ready" },
        { handoff: "review" },
        { handoff: "review", message: "   " },
        { handoff: "", message: "Ready" },
        { handoff: "review", pause: true, message: "Ready" },
      ]) {
        await expect(client.release(id, options)).rejects.toThrow();
        expect(await readFile(historyPath, "utf8")).toBe(before);
        expect((await client.get(id)).item).toMatchObject({ status: "in_progress", assignee: "test-author" });
      }
      const refused = context.runCli(["release", id, "--pause", "--handoff", "review", "--message", "Ready", "--json"]);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("--handoff cannot be combined with --pause");
      expect(await readFile(historyPath, "utf8")).toBe(before);
      expect((await client.get(id)).item).toMatchObject({ status: "in_progress", assignee: "test-author" });
      expect(context.runCli(["config", "set", "governance-ownership-enforcement", "strict"]).code).toBe(0);
      await expect(new PmClient({ pmRoot: context.pmPath, author: "other" }).release(id, { handoff: "review", message: "Ready" })).rejects.toThrow();
      expect(await readFile(historyPath, "utf8")).toBe(before);
      await client.release(id, { pause: true });
      await expect(client.release(id, { handoff: "review", message: "Ready" })).rejects.toThrow();
      await client.close(id, "Completed", { validateClose: "off" });
      await expect(client.release(id, { handoff: "review", message: "Ready", force: true })).rejects.toThrow();
    });
  });

  it("preserves strict transition refusal and reports advisory policy without losing ownership evidence", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-status", "review", "--role", "active"]).code).toBe(0);
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true, author: "test-author" });
      const id = "pm-policyhandoff";
      await client.create({ id, title: "Governed queue", type: "Task", createMode: "progressive" });
      await client.claim(id, { start: true });
      await writeFile(path.join(context.pmPath, "schema", "workflows.json"), JSON.stringify({ type_workflows: [{ type: "Task", allowed_transitions: [] }] }));
      expect(context.runCli(["config", "set", "governance-workflow-enforcement", "strict"]).code).toBe(0);
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const before = await readFile(historyPath, "utf8");
      await expect(client.release(id, { handoff: "review", message: "Ready" })).rejects.toThrow("Disallowed transition");
      expect(await readFile(historyPath, "utf8")).toBe(before);
      expect((await client.get(id)).item).toMatchObject({ status: "in_progress", assignee: "test-author" });
      expect(context.runCli(["config", "set", "governance-workflow-enforcement", "warn"]).code).toBe(0);
      expect(await client.release(id, { handoff: "review", message: "Policy advisory reviewed" })).toMatchObject({ item: { status: "review" }, warnings: [expect.stringContaining("workflow_transition_not_allowed")] });
    });
  });
});
