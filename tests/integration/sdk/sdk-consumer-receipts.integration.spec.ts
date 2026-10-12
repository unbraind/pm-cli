import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PmClient, runContextEvaluationScenario, type ContextEvaluationReader } from "../../../src/sdk/index.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import { expectJsonErrorEnvelope } from "../../helpers/jsonErrorEnvelope.js";

describe("SDK consumer receipts", () => {
  it("evaluates PmClient directly and refuses infeasible independent and shared budgets", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      const created = await client.create({ title: "Evaluation anchor", type: "Task", createMode: "progressive" });
      const id = created.item.id;
      const reader: ContextEvaluationReader = client;
      for (const surface of ["context", "next"] as const) {
        const scenario = { id: `direct-${surface}`, surface, judgments: { [id]: 3 }, required_ids: [id], token_budget: 10_000, rationale: "Grade the actual public client packet and retain its attribution." };
        const report = await runContextEvaluationScenario(scenario, reader);
        expect(report.ranked_ids).toContain(id);
        expect(report.metrics.required_recall).toBe(1);
        expect(report.attribution.map((row) => row.id)).toContain(id);
        await expect(runContextEvaluationScenario({ ...scenario, options: { outputBudget: 1 } }, reader)).rejects.toMatchObject({ context: { code: "context_evaluation_read_incomplete" } });
        await expect(runContextEvaluationScenario({ ...scenario, options: {
          outputBudget: "unbounded", outputSession: { version: 1, id: "spent-session", token_budget: 2000, spent_tokens: 2000, seen_item_ids: [] },
        } }, reader)).rejects.toThrow("remaining output-session budget");
      }
    });
  });

  it("refuses reserved external-reference input without changing existing item or immutable history bytes", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(["create", "--title", "Reference anchor", "--type", "Task", "--create-mode", "progressive", "--json"], { expectJson: true });
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;
      const item = path.join(context.pmPath, "tasks", `${id}.toon`);
      const history = path.join(context.pmPath, "history", `${id}.jsonl`);
      const original = await Promise.all([readFile(item), readFile(history)]);
      for (const args of [
        ["create", "--stdin-json", "--create-mode", "progressive", "--json"],
        ["update", id, "--stdin-json", "--json"],
      ]) {
        const refusal = context.runCli(args, { input: JSON.stringify({ title: "Refused reference", type: "Task", external_ref: "GH-1442" }), expectJson: true });
        expect(refusal.code).toBe(2);
        const error = expectJsonErrorEnvelope(refusal.stderr, { code: "core_item_field_requires_dedicated_flag", exit_code: 2 });
        expect(error.next_steps?.[0]).toContain("No dedicated create/update CLI mutation flag");
        expect(error.recovery?.suggested_flags).toBeUndefined();
        expect(await Promise.all([readFile(item), readFile(history)])).toEqual(original);
      }
    });
  });
});
