import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectMutationResult } from "../../../../src/core/output/mutation-projection.js";
import { runPlan } from "../../../../src/sdk/lifecycle/plan.js";
import { buildPlanMutationReceipt } from "../../../../src/sdk/lifecycle/plan-mutation-receipt.js";
import { runDocs } from "../../../../src/sdk/docs.js";
import { runFiles } from "../../../../src/sdk/files.js";
import { runInit } from "../../../../src/sdk/init.js";
import { PmClient, runAction } from "../../../../src/sdk/runtime.js";
import type { PlanMutationReceipt } from "../../../../src/sdk/index.js";
import { quoteCommandArg } from "../../../../src/sdk/command-line.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import { handleRequest } from "../../../../src/mcp/server.js";

describe("durable evidence and bounded Plan mutation receipts", () => {
  it.each([false, true])("keeps MCP recovery path-neutral with fullChangedFields=%s", async (fullChangedFields) => {
    await withTempPmPath(async (context) => {
      const response = await handleRequest({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: fullChangedFields ? "pm_run" : "pm_plan", arguments: {
          path: context.pmPath,
          ...(fullChangedFields ? { action: "plan", fullChangedFields: true } : {}),
          options: { subcommand: "create", title: "Remote recovery", step: ["Inspect evidence"] },
        } },
      });
      expect(response?.isError).not.toBe(true);
      if (response?.structuredContent === undefined) {
        throw new Error("MCP mutation did not return structured content");
      }
      const result = (response.structuredContent as { result: PlanMutationReceipt & { mutation_receipt?: PlanMutationReceipt } }).result;
      const receipt = fullChangedFields ? result.mutation_receipt : result;
      if (receipt === undefined) {
        throw new Error("MCP mutation did not return a receipt");
      }
      expect(receipt.inspection_command).toBe(`pm plan show ${receipt.id} --depth deep`);
      expect(receipt.omission_receipt.omitted_field_groups[0].restore_with).toBe(receipt.inspection_command);
      expect(JSON.stringify(receipt)).not.toContain(context.pmPath);
      expect(receipt.next_action).not.toContain("--pm-path");
      const shown = await handleRequest({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "pm_plan", arguments: {
          path: context.pmPath, id: receipt.id,
          options: { subcommand: "show", depth: "deep" },
        } },
      });
      expect(shown?.structuredContent).toMatchObject({ result: { plan: { id: receipt.id, steps: [{ title: "Inspect evidence" }] } } });
    });
  });
  it("qualifies recovery with a non-default tracker containing shell-significant characters", async () => {
    await withTempPmPath(async (context) => {
      const pmRoot = path.join(context.tempRoot, "tracker space $literal");
      await runInit(undefined, { path: pmRoot }, { defaults: true });
      const created = await runPlan({
        subcommand: "create",
        options: { title: "Explicit tracker" },
        global: { path: pmRoot },
      });
      const receipt = created.mutation_receipt;
      const command = `pm plan show ${created.plan.id} --depth deep --pm-path ${quoteCommandArg(pmRoot)}`;
      expect(receipt?.inspection_command).toBe(command);
      expect(
        receipt?.omission_receipt.omitted_field_groups[0].restore_with,
      ).toBe(command);
      expect(receipt?.next_action).toContain(
        `--pm-path ${quoteCommandArg(pmRoot)}`,
      );
      const recovered = context.runCli(
        [
          "plan",
          "show",
          created.plan.id,
          "--depth",
          "deep",
          "--pm-path",
          pmRoot,
          "--json",
        ],
        { expectJson: true },
      );
      expect(recovered.code).toBe(0);
      expect(recovered.json).toMatchObject({
        plan: { id: created.plan.id, title: "Explicit tracker" },
      });
      expect(
        context.runCli(["plan", "show", created.plan.id, "--json"]).code,
      ).not.toBe(0);
    });
  });
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
        await run(id, { add: ["path=old.md,note=migrated"] }, global);
        const collision = await run(
          id,
          {
            migrate: ["from=old.md,to=README.md"],
            add: ["path=README.md,note=collision revision"],
          },
          global,
        );
        expect(collision.changed).toBe(true);
        expect(await run(id, {}, global)).toMatchObject({
          [kind]: [
            { path: "README.md", note: "collision revision" },
            { path: "z.md", note: "other" },
          ],
        });
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
            /** Distinct persisted titles make accidental unrelated-step disclosure observable. */
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
      const typedReceipt: PlanMutationReceipt | undefined =
        result.mutation_receipt;
      const receipt = projectMutationResult(result, { compactEnvelope: true });
      expect(receipt).toEqual(typedReceipt);
      expect(receipt).toMatchObject({
        id: created.plan.id,
        action: "update-step",
        step: { id: "plan-step-001", status: "in_progress" },
        steps_summary: { total: 1000, in_progress: 1 },
        inspection_command: `pm plan show ${created.plan.id} --depth deep --pm-path ${quoteCommandArg(context.pmPath)}`,
        omission_receipt: { has_omissions: true },
      });
      const encoded = JSON.stringify(receipt);
      expect(encoded.length).toBeLessThan(4096);
      expect(encoded).not.toContain("large-body-detail");
      expect(encoded).not.toContain("private-resume-detail");
      expect(encoded).not.toContain("Unrelated step 999");
      expect(projectMutationResult(result)).toBe(result);
      expect(
        projectMutationResult(result, { changedFields: "compact" }),
      ).toEqual(receipt);
      expect(result.mutation_receipt?.inspection_command).toContain(
        context.pmPath,
      );
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
      const warnings = buildPlanMutationReceipt(
        {
          ...result,
          next_actions: [],
          warnings: ["x".repeat(161), "second", "third", "fourth"],
        },
        context.pmPath,
      );
      expect(warnings).toMatchObject({
        warning_count: 4,
        warnings_truncated: true,
        warnings: ["x".repeat(160), "second", "third"],
        next_action: warnings.inspection_command,
      });
      expect(
        buildPlanMutationReceipt(
          {
            ...result,
            next_actions: undefined,
            warnings: ["x".repeat(161)],
          },
          context.pmPath,
        ).warnings_truncated,
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
      const compactFlag = context.runCli(
        [
          "plan",
          "complete-step",
          created.plan.id,
          "plan-step-001",
          "--no-changed-fields",
          "--json",
        ],
        { expectJson: true, preserveDefaultMutationOutput: true },
      );
      expect(compactFlag.code).toBe(0);
      expect(compactFlag.json).toMatchObject({
        kind: "plan_mutation",
        id: created.plan.id,
      });
      expect(compactFlag.stdout.length).toBeLessThan(4096);
    });
  });
});
