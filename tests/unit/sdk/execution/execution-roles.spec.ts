import { describe, expect, it } from "vitest";
import { renderNextMarkdown, runNext } from "../../../../src/sdk/query/next.js";
import { PmClient } from "../../../../src/sdk/runtime.js";
import { attachContextIntentReceipt } from "../../../../src/sdk/context-intent-contracts.js";
import { collectContextUsageDeliveredItemIds } from "../../../../src/sdk/context-usage.js";
import { runContext } from "../../../../src/sdk/query/context.js";
import { readSettings, writeSettings } from "../../../../src/sdk/runtime-primitives.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("schema-driven work execution", () => {
  it("compacts gate and container worklists without discarding every actionable context row", () => {
    const projected = attachContextIntentReceipt("next", { for: "execute", tokenBudget: 700 }, {
      recommended: null,
      gate_needed: Array.from({ length: 20 }, (_, index) => ({ id: `pm-gate-${index}`, title: `Verify delivery ${index}`, status: "open" })),
      containers: Array.from({ length: 20 }, (_, index) => ({ id: `pm-container-${index}`, title: `Delivery scope ${index}`, status: "open" })),
    });
    expect(projected.context_intent).toMatchObject({ within_budget: true, result_omitted: false, degradation: "budget_row_compaction" });
    expect(projected.context_intent!.estimated_tokens).toBeLessThanOrEqual(700);
    const retained = projected.gate_needed.length + projected.containers.length;
    expect(retained).toBeGreaterThan(0);
    expect(retained).toBeLessThan(40);
  });

  it("retains full gate and container counts in bounded worklists and markdown", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath });
      for (const suffix of ["one", "two"]) {
        await client.create({ id: `pm-gate-${suffix}`, title: `Gate ${suffix}`, type: "Milestone" });
        await client.create({ id: `pm-parent-${suffix}`, title: `Container ${suffix}`, type: "Epic" });
        await client.create({
          id: `pm-child-${suffix}`, title: `Blocked child ${suffix}`, type: "Task",
          parent: `pm-parent-${suffix}`, status: "blocked",
          blockedBy: "pm-missing", blockedReason: "Waiting for prerequisite",
        });
      }
      const result = await runNext({ limit: "1" }, { path: context.pmPath });
      expect(result).toMatchObject({
        recommended: null, summary: { gate_needed: 2, containers: 2, blocked: 2 },
        truncation: { gate_needed_total: 2, containers_total: 2 },
      });
      expect(result.gate_needed).toHaveLength(1);
      expect(result.containers).toHaveLength(1);
      expect(collectContextUsageDeliveredItemIds(result, "next")).toEqual(expect.arrayContaining([
        result.gate_needed![0].id, result.containers![0].id,
      ]));
      expect(result.suggestions?.join(" ")).toContain("outcome gates require verification");
      expect(result.suggestions?.join(" ")).toContain("pm-missing");
      const markdown = renderNextMarkdown(result);
      expect(markdown).toContain("## Gate verification needed");
      expect(markdown).toContain("## Containers");
      expect(markdown).toContain(result.containers![0].id);
    });
  });

  it("keeps gates visible without recommending or claiming them", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(["create", "--type", "Milestone", "--title", "Outcome gate", "--create-mode", "progressive", "--json"], { expectJson: true });
      expect(created.code).toBe(0);
      const result = await runNext({}, { path: context.pmPath });
      expect(result).toMatchObject({ recommended: null, ready: [], gate_needed: [expect.objectContaining({ type: "Milestone" })], summary: { gate_needed: 1 } });
      expect(result.suggestions?.join(" ")).toContain("gate");
      const focus = await runContext({ depth: "brief" }, { path: context.pmPath });
      expect(focus.low_level).toEqual([]);
      const claim = context.runCli(["claim", "--next", "--if-available", "--json"], { expectJson: true });
      expect(claim.code).toBe(0);
      expect(claim.json).toMatchObject({ available: false });
      const optedIn = await runNext({ includeGates: true }, { path: context.pmPath });
      expect(optedIn.recommended?.type).toBe("Milestone");
      const client = new PmClient({ pmRoot: context.pmPath });
      expect(await client.run("next", { options: { includeGates: true } })).toMatchObject({ recommended: { type: "Milestone" } });
      expect(await client.run("claim", { next: true, includeGates: true, ifAvailable: true })).toMatchObject({ available: true, item: { type: "Milestone" } });
    });
  });

  it("preserves configured roles through settings and exposes container worklists", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.item_types.definitions = [
        { name: "Approval", execution_role: "human" },
        { name: "Checkpoint", execution_role: "gate" },
      ];
      await writeSettings(context.pmPath, settings);
      for (const type of ["Approval", "Checkpoint", "Task"]) {
        expect(context.runCli(["create", "--type", type, "--title", `${type} work`, "--create-mode", "progressive"]).code).toBe(0);
      }
      const parent = context.runCli(["create", "--type", "Epic", "--id", "pm-parent", "--title", "Delivery", "--create-mode", "progressive"]);
      expect(parent.code).toBe(0);
      expect(context.runCli(["create", "--type", "Task", "--parent", "pm-parent", "--title", "Deliver leaf", "--create-mode", "progressive"]).code).toBe(0);
      const result = await runNext({}, { path: context.pmPath });
      expect(result).toMatchObject({
        recommended: { type: "Task" },
        gate_needed: [expect.objectContaining({ type: "Checkpoint" })],
        decision_needed: [expect.objectContaining({ type: "Approval" })],
        containers: [expect.objectContaining({ id: "pm-parent" })],
      });
      const optedIn = await runNext({ includeDecisions: true, includeGates: true, includeContainers: true }, { path: context.pmPath });
      expect([optedIn.recommended, ...optedIn.ready].map((row) => row?.type)).toEqual(expect.arrayContaining(["Approval", "Checkpoint", "Epic", "Task"]));
      const blocked = context.runCli(["update", "pm-parent", "--blocked-by", "pm-missing", "--blocked-reason", "Missing prerequisite"]);
      expect(blocked.code).toBe(0);
      const blockedOptIn = await runNext({ includeContainers: true }, { path: context.pmPath });
      expect(blockedOptIn.ready.map(({ id }) => id)).not.toContain("pm-parent");
      expect(blockedOptIn.containers?.[0].blockers).toEqual(expect.arrayContaining([expect.objectContaining({ id: "pm-missing" })]));
    });
  });
});
