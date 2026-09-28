import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectMutationResult } from "../../../../src/core/output/mutation-projection.js";
import { runPlan } from "../../../../src/sdk/lifecycle/plan.js";
import { buildPlanMutationReceipt } from "../../../../src/sdk/lifecycle/plan-mutation-receipt.js";
import { runDocs } from "../../../../src/sdk/docs.js";
import { runFiles } from "../../../../src/sdk/files.js";
import { PmClient, runAction } from "../../../../src/sdk/runtime.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("durable evidence and bounded Plan mutation receipts", () => {
  it.each(["files", "docs"] as const)(
    "updates %s notes in one event and preserves retry bytes",
    async (kind) => {
      await withTempPmPath(async (context) => {
        const created = await runPlan({
          subcommand: "create",
          options: { title: "Evidence owner" },
          global: { path: context.pmPath },
        });
        const id = created.plan.id;
        const run = kind === "files" ? runFiles : runDocs;
        const global = { path: context.pmPath };
        await run(
          id,
          { add: ["path=README.md,note=old", "path=z.md,note=other"] },
          global,
        );
        const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
        const before = await readFile(historyPath, "utf8");
        const changed = await run(
          id,
          { add: ["path=./README.md,note=current"] },
          global,
        );
        expect(changed.changed).toBe(true);
        const read = await run(id, {}, global);
        expect(read).toMatchObject({
          [kind]: [
            { path: "README.md", scope: "project", note: "current" },
            { path: "z.md", note: "other" },
          ],
        });
        const after = await readFile(historyPath, "utf8");
        expect(after.trim().split("\n")).toHaveLength(
          before.trim().split("\n").length + 1,
        );
        for (const add of ["README.md", "path=README.md,note=current"]) {
          expect((await run(id, { add: [add] }, global)).changed).toBe(false);
          expect(await readFile(historyPath, "utf8")).toBe(after);
        }
      });
    },
  );

  it("keeps single-step output independent of a thousand unrelated step bodies", async () => {
    await withTempPmPath(async (context) => {
      const global = { path: context.pmPath };
      const created = await runPlan({
        subcommand: "create",
        options: {
          title: "Large execution plan",
          step: Array.from(
            { length: 1000 },
            (_, index) => `Unrelated step ${index}`,
          ),
          resumeContext: "private-resume-detail".repeat(1000),
        },
        global,
      });
      const result = await runPlan({
        subcommand: "update-step",
        id: created.plan.id,
        stepRef: "plan-step-001",
        options: {
          stepStatus: "in_progress",
          stepBody: "large-body-detail".repeat(1000),
        },
        global,
      });
      const receipt = projectMutationResult(result, { compactEnvelope: true });
      expect(receipt).toMatchObject({
        id: created.plan.id,
        action: "update-step",
        step: { id: "plan-step-001", status: "in_progress" },
        steps_summary: { total: 1000, in_progress: 1 },
        inspection_command: `pm plan show ${created.plan.id} --depth deep`,
        omission_receipt: { has_omissions: true },
      });
      const encoded = JSON.stringify(receipt);
      expect(encoded.length).toBeLessThan(4096);
      expect(encoded).not.toContain("large-body-detail");
      expect(encoded).not.toContain("private-resume-detail");
      expect(encoded).not.toContain("Unrelated step 999");
      expect(projectMutationResult(result)).toBe(result);
      for (const mutation_receipt of [
        undefined,
        { kind: "other" },
        { kind: "plan_mutation", id: "wrong" },
        { kind: "plan_mutation", id: created.plan.id, action: "wrong" },
      ]) {
        const unrelated = { ...result, mutation_receipt };
        expect(
          projectMutationResult(unrelated, { compactEnvelope: true }),
        ).toBe(unrelated);
      }
      const warnings = buildPlanMutationReceipt({
        ...result,
        next_actions: [],
        warnings: ["x".repeat(161), "second", "third", "fourth"],
      });
      expect(warnings).toMatchObject({
        warning_count: 4,
        warnings_truncated: true,
        warnings: ["x".repeat(160), "second", "third"],
        next_action: warnings.inspection_command,
      });
      expect(
        buildPlanMutationReceipt({
          ...result,
          next_actions: undefined,
          warnings: ["x".repeat(161)],
        }).warnings_truncated,
      ).toBe(true);
      const shown = await runPlan({
        subcommand: "show",
        id: created.plan.id,
        options: { depth: "deep" },
        global,
      });
      expect(shown.plan.steps).toHaveLength(1000);
      expect(shown.plan.steps?.[0].body).toBe("large-body-detail".repeat(1000));
      expect(projectMutationResult(shown, { compactEnvelope: true })).toBe(
        shown,
      );
      const client = new PmClient({
        pmRoot: context.pmPath,
        noExtensions: true,
      });
      const typed = await client.planApprove(created.plan.id);
      expect(typed.plan.mode).toBe("approved");
      expect(typed.mutation_receipt?.action).toBe("approve");
      const mcp = await runAction({
        action: "plan",
        id: created.plan.id,
        path: context.pmPath,
        noExtensions: true,
        options: { subcommand: "resume", resumeContext: "next checkpoint" },
      });
      expect(mcp).toMatchObject({
        id: created.plan.id,
        kind: "plan_mutation",
        action: "resume",
      });
      expect(JSON.stringify(mcp).length).toBeLessThan(4096);
      const cli = context.runCli(
        ["plan", "complete-step", created.plan.id, "plan-step-001", "--json"],
        { expectJson: true, preserveDefaultMutationOutput: true },
      );
      expect(cli.code).toBe(0);
      expect(cli.json).toMatchObject({
        id: created.plan.id,
        step: { status: "completed" },
        steps_summary: { completed: 1 },
      });
      expect(cli.stdout.length).toBeLessThan(4096);
    });
  });
});
