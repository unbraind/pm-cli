import { describe, expect, it } from "vitest";
import { runClose } from "../../../src/cli/commands/close.js";
import {
  _testOnlyPlanCommand as planInternals,
  runPlan,
} from "../../../src/cli/commands/plan.js";
import {
  isTerminalPlanMode,
  shouldCompletePlanOnClose,
} from "../../../src/core/item/plan-lifecycle.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const GLOBAL = {
  json: true,
  quiet: true,
  noPager: true,
} as unknown as Parameters<typeof runPlan>[0]["global"];

/** Execute a Plan subcommand against the supplied isolated tracker. */
async function plan(
  pmPath: string,
  subcommand: Parameters<typeof runPlan>[0]["subcommand"],
  options: Parameters<typeof runPlan>[0]["options"],
  id?: string,
  stepRef?: string,
) {
  return runPlan({
    subcommand,
    id,
    stepRef,
    options,
    global: { ...GLOBAL, path: pmPath },
  });
}

describe("Plan lifecycle integrity regressions", () => {
  it("classifies terminal modes and close eligibility without assuming seeded steps", () => {
    expect(isTerminalPlanMode(undefined)).toBe(false);
    expect(isTerminalPlanMode("completed")).toBe(true);
    expect(shouldCompletePlanOnClose({ type: "Plan" } as never)).toBe(false);
    expect(
      shouldCompletePlanOnClose({
        type: "Plan",
        plan_steps: [{ status: "pending" }],
      } as never),
    ).toBe(false);
    expect(
      shouldCompletePlanOnClose({
        type: "Task",
        plan_steps: [{ status: "completed" }],
      } as never),
    ).toBe(false);
  });

  it("creates seeded cross-owner Plans as one complete state", async () => {
    await withTempPmPath(async (context) => {
      const created = await plan(context.pmPath, "create", {
        title: "Atomic seeded Plan",
        author: "author-a",
        assignee: "owner-b",
        stepTitle: "Implement",
        file: "path=src/feature.ts,scope=project",
        test: "command=pnpm test,note=regression",
        doc: "path=docs/feature.md,scope=project",
      });

      const stored = context.runCli(["get", created.plan.id, "--json"], {
        expectJson: true,
      }).json as { item: { assignee?: string } };
      expect(stored.item.assignee).toBe("owner-b");
      expect(created.step).toMatchObject({
        files: [{ path: "src/feature.ts", scope: "project" }],
        tests: [{ command: "pnpm test", note: "regression" }],
        docs: [{ path: "docs/feature.md", scope: "project" }],
      });
    });
  });

  it("preflights malformed seeded evidence without leaving a partial Plan", async () => {
    await withTempPmPath(async (context) => {
      const before = context.runCli(["list-all", "--json"], {
        expectJson: true,
      }).json as { items: unknown[] };

      await expect(
        plan(context.pmPath, "create", {
          title: "Must roll back",
          author: "author-a",
          assignee: "owner-b",
          stepTitle: "Implement",
          file: "scope=project",
        }),
      ).rejects.toMatchObject({
        context: { code: "malformed_plan_step_evidence" },
      });

      const after = context.runCli(["list-all", "--json"], {
        expectJson: true,
      }).json as { items: unknown[] };
      expect(after.items).toHaveLength(before.items.length);
    });
  });

  it("persists update-step artifacts, de-duplicates them, and rejects malformed input", async () => {
    await withTempPmPath(async (context) => {
      const created = await plan(context.pmPath, "create", {
        title: "Evidence Plan",
        author: "test-author",
        stepTitle: "Implement",
      });
      const evidence = {
        file: "path=src/evidence.ts,scope=project",
        test: "command=pnpm test,note=linked",
        doc: "path=docs/evidence.md,scope=project",
        author: "test-author",
      };
      await plan(
        context.pmPath,
        "update-step",
        evidence,
        created.plan.id,
        "plan-step-001",
      );
      const updated = await plan(
        context.pmPath,
        "update-step",
        evidence,
        created.plan.id,
        "plan-step-001",
      );

      expect(updated.step?.files).toEqual([
        { path: "src/evidence.ts", scope: "project" },
      ]);
      expect(updated.step?.tests).toEqual([
        { command: "pnpm test", note: "linked" },
      ]);
      expect(updated.step?.docs).toEqual([
        { path: "docs/evidence.md", scope: "project" },
      ]);
      await expect(
        plan(
          context.pmPath,
          "update-step",
          { file: "not-a-pair", author: "test-author" },
          created.plan.id,
          "plan-step-001",
        ),
      ).rejects.toMatchObject({
        context: { code: "malformed_plan_step_evidence" },
      });
    });
  });

  it("persists resume and approve scope changes", async () => {
    await withTempPmPath(async (context) => {
      const created = await plan(context.pmPath, "create", {
        title: "Scoped Plan",
        scope: "old",
        author: "test-author",
      });
      await plan(
        context.pmPath,
        "resume",
        {
          resumeContext: "Continue from checkpoint",
          scope: "resume scope",
          author: "test-author",
        },
        created.plan.id,
      );
      const approved = await plan(
        context.pmPath,
        "approve",
        {
          mode: "approved",
          scope: "approved scope",
          author: "test-author",
        },
        created.plan.id,
      );

      expect(approved.plan.scope).toBe("approved scope");
      expect(approved.plan.mode).toBe("approved");
    });
  });

  it("completes Plan mode during close and rejects later mutation with a typed error", async () => {
    await withTempPmPath(async (context) => {
      const created = await plan(context.pmPath, "create", {
        title: "Terminal Plan",
        mode: "executing",
        author: "test-author",
        stepTitle: "Done",
        stepStatus: "completed",
      });
      const closed = await runClose(
        created.plan.id,
        "completed",
        { author: "test-author" },
        { path: context.pmPath },
      );
      expect(closed.changed_fields).toContain("plan_mode");

      const shown = await plan(
        context.pmPath,
        "show",
        { depth: "deep" },
        created.plan.id,
      );
      expect(shown.plan.mode).toBe("completed");
      await expect(
        plan(
          context.pmPath,
          "resume",
          {
            resumeContext: "should fail",
            author: "test-author",
          },
          created.plan.id,
        ),
      ).rejects.toMatchObject({
        context: { code: "terminal_plan_mutation" },
      });
    });
  });

  it("audits removed Plan metadata fields through the before-and-after key union", () => {
    const before = new Map([
      ["plan_mode", JSON.stringify("executing")],
      ["plan_resume_context", JSON.stringify("checkpoint")],
    ]);
    expect(
      planInternals.changedPlanMetadataFields(before, {
        id: "pm-plan",
        title: "Plan",
        type: "Plan",
        status: "open",
        priority: 2,
        created_at: "2026-07-25T00:00:00.000Z",
        updated_at: "2026-07-25T00:00:00.000Z",
        plan_mode: "completed",
      }),
    ).toEqual(["plan_mode", "plan_resume_context"]);
  });
});
