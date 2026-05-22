import { afterEach, describe, expect, it, vi } from "vitest";
import { runPlan, PLAN_SUBCOMMANDS, PLAN_SHOW_DEPTH_VALUES } from "../../src/cli/commands/plan.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

const GLOBAL = { json: true, quiet: true, noPager: true } as unknown as Parameters<typeof runPlan>[0]["global"];

afterEach(() => {
  vi.restoreAllMocks();
});

interface PlanFixture {
  context: TempPmContext;
  planId: string;
}

async function bootstrapPlan(context: TempPmContext): Promise<PlanFixture> {
  const result = await runPlan({
    subcommand: "create",
    options: {
      title: "Test Plan",
      scope: "test scope",
      harness: "claude-code",
      mode: "draft",
      author: "test-author",
    } as Parameters<typeof runPlan>[0]["options"],
    global: { ...GLOBAL, path: context.pmPath },
  });
  return { context, planId: result.plan.id };
}

describe("runPlan command family", () => {
  it("exposes the canonical subcommand list and show depth values", () => {
    expect(PLAN_SUBCOMMANDS).toContain("create");
    expect(PLAN_SUBCOMMANDS).toContain("materialize");
    expect(PLAN_SUBCOMMANDS).toContain("show");
    expect(PLAN_SHOW_DEPTH_VALUES).toEqual(["brief", "standard", "deep"]);
  });

  it("create requires --title", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runPlan({
          subcommand: "create",
          options: { author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("create produces a Plan item with plan_mode/scope/harness and brief projection", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      expect(planId).toMatch(/^pm-/);
      const show = await runPlan({
        subcommand: "show",
        id: planId,
        options: { depth: "brief" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(show.plan.mode).toBe("draft");
      expect(show.plan.harness).toBe("claude-code");
      expect(show.plan.scope).toBe("test scope");
      expect(show.plan.steps_summary.total).toBe(0);
      expect(show.next_actions).toEqual(expect.arrayContaining([expect.stringContaining("add-step")]));
    });
  });

  it("show supports field projection for low-token Plan inspection", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      await runPlan({
        subcommand: "add-step",
        id: planId,
        options: { stepTitle: "project me", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });

      const projected = await runPlan({
        subcommand: "show",
        id: planId,
        options: { depth: "deep", fields: "id,title,steps_summary" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(projected.plan).toEqual({
        id: planId,
        title: "Test Plan",
        steps_summary: {
          total: 1,
          pending: 1,
          in_progress: 0,
          blocked: 0,
          completed: 0,
          skipped: 0,
          superseded: 0,
        },
      });
      expect(projected.next_actions).toEqual(expect.arrayContaining([expect.stringContaining("approve")]));
      await expect(
        runPlan({
          subcommand: "show",
          id: planId,
          options: { fields: "id,typo,steps_summary" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Unknown Plan --fields value(s): typo"),
      });
    });
  });

  it("rejects pm plan commands on non-Plan items", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli([
        "create",
        "--json",
        "--title",
        "Not a plan",
        "--description",
        "regular task",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--author",
        "test-author",
        "--message",
        "create task",
      ], { expectJson: true });
      const id = ((created.json as { item: { id: string } }).item).id;
      await expect(
        runPlan({
          subcommand: "show",
          id,
          options: {} as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("add-step enforces single in_progress invariant without --allow-multiple-active", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      await runPlan({
        subcommand: "add-step",
        id: planId,
        options: { stepTitle: "Step one", stepStatus: "in_progress", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      await expect(
        runPlan({
          subcommand: "add-step",
          id: planId,
          options: { stepTitle: "Step two", stepStatus: "in_progress", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.CONFLICT });
    });
  });

  it("supports the full step lifecycle: add, update, complete, block, reorder, remove", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      const add1 = await runPlan({
        subcommand: "add-step",
        id: planId,
        options: { stepTitle: "first", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(add1.step?.id).toBe("plan-step-001");
      await runPlan({
        subcommand: "add-step",
        id: planId,
        options: { stepTitle: "second", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      const updated = await runPlan({
        subcommand: "update-step",
        id: planId,
        stepRef: "plan-step-001",
        options: { stepStatus: "in_progress", stepEvidence: "started", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(updated.step?.status).toBe("in_progress");
      const completed = await runPlan({
        subcommand: "complete-step",
        id: planId,
        stepRef: "plan-step-001",
        options: { stepEvidence: "done", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(completed.step?.status).toBe("completed");
      await expect(
        runPlan({
          subcommand: "block-step",
          id: planId,
          stepRef: "plan-step-002",
          options: { author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      const blocked = await runPlan({
        subcommand: "block-step",
        id: planId,
        stepRef: "plan-step-002",
        options: { stepBlockedReason: "needs review", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(blocked.step?.status).toBe("blocked");
      const reordered = await runPlan({
        subcommand: "reorder-step",
        id: planId,
        stepRef: "plan-step-002",
        reorderTo: 1,
        options: { author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(reordered.plan.steps?.[0]?.id).toBe("plan-step-002");
      const removed = await runPlan({
        subcommand: "remove-step",
        id: planId,
        stepRef: "plan-step-002",
        options: { author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(removed.plan.steps_summary.total).toBe(1);
    });
  });

  it("link and unlink mutate step linked_items, with promote-to-item-dep", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      const related = context.runCli([
        "create",
        "--json",
        "--title",
        "Related",
        "--description",
        "related task",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "2",
        "--author",
        "test-author",
        "--message",
        "create related",
      ], { expectJson: true });
      const relatedId = (related.json as { item: { id: string } }).item.id;
      await runPlan({
        subcommand: "add-step",
        id: planId,
        options: { stepTitle: "first", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      const linked = await runPlan({
        subcommand: "link",
        id: planId,
        stepRef: "plan-step-001",
        options: { link: relatedId, linkKind: "related", linkNote: "n", promoteToItemDep: true, author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(linked.step?.linked_items?.[0]?.id).toBe(relatedId);
      expect(linked.plan.linked_items?.some((dep) => dep.id === relatedId)).toBe(true);
      const unlinked = await runPlan({
        subcommand: "unlink",
        id: planId,
        stepRef: "plan-step-001",
        options: { link: relatedId, author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(unlinked.step?.linked_items ?? []).toEqual([]);
    });
  });

  it("appends decision, discovery, validation log entries and updates resume_context", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      const dec = await runPlan({
        subcommand: "decision",
        id: planId,
        options: { decisionText: "pick A", decisionRationale: "reason", decisionEvidence: "ev", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(dec.plan.decisions?.length).toBe(1);
      const disc = await runPlan({
        subcommand: "discovery",
        id: planId,
        options: { discoveryText: "found", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(disc.plan.discoveries?.length).toBe(1);
      const val = await runPlan({
        subcommand: "validation",
        id: planId,
        options: { validationText: "check", validationCommand: "pm health", validationExpected: "ok", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(val.plan.validation?.length).toBe(1);
      const resume = await runPlan({
        subcommand: "resume",
        id: planId,
        options: { resumeContext: "where we are", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(resume.plan.resume_context).toBe("where we are");
    });
  });

  it("accepts shorthand decision/discovery/validation text options for MCP-style calls", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      const dec = await runPlan({
        subcommand: "decision",
        id: planId,
        options: { decision: "pick shorthand", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(dec.plan.decisions?.[0]?.decision).toBe("pick shorthand");
      const disc = await runPlan({
        subcommand: "discovery",
        id: planId,
        options: { discovery: "found shorthand", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(disc.plan.discoveries?.[0]?.text).toBe("found shorthand");
      const val = await runPlan({
        subcommand: "validation",
        id: planId,
        options: { validation: "check shorthand", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(val.plan.validation?.[0]?.text).toBe("check shorthand");
      const cliDecision = context.runCli(["plan", "decision", planId, "--decision", "cli decision", "--json", "--author", "test-author"], { expectJson: true });
      expect(cliDecision.code).toBe(0);
      expect((cliDecision.json as { plan: { decisions?: Array<{ decision: string }> } }).plan.decisions?.at(-1)?.decision).toBe("cli decision");
      const cliDiscovery = context.runCli(["plan", "discovery", planId, "--discovery", "cli discovery", "--json", "--author", "test-author"], { expectJson: true });
      expect(cliDiscovery.code).toBe(0);
      expect((cliDiscovery.json as { plan: { discoveries?: Array<{ text: string }> } }).plan.discoveries?.at(-1)?.text).toBe("cli discovery");
      const cliValidation = context.runCli(["plan", "validation", planId, "--validation", "cli validation", "--json", "--author", "test-author"], { expectJson: true });
      expect(cliValidation.code).toBe(0);
      expect((cliValidation.json as { plan: { validation?: Array<{ text: string }> } }).plan.validation?.at(-1)?.text).toBe("cli validation");
    });
  });

  it("approve flips plan_mode and materialize creates child items", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      await runPlan({
        subcommand: "add-step",
        id: planId,
        options: { stepTitle: "to materialize", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      const approved = await runPlan({
        subcommand: "approve",
        id: planId,
        options: { author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(approved.plan.mode).toBe("approved");
      const materialized = await runPlan({
        subcommand: "materialize",
        id: planId,
        options: { steps: "plan-step-001", materializeType: "Task", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(materialized.materialized?.length).toBe(1);
      expect(materialized.materialized?.[0]?.type).toBe("Task");
    });
  });

  it("materialize supports --steps all without adding reverse child dependencies to the plan", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      await runPlan({
        subcommand: "add-step",
        id: planId,
        options: { stepTitle: "first materialized", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      await runPlan({
        subcommand: "add-step",
        id: planId,
        options: { stepTitle: "second materialized", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });

      const result = await runPlan({
        subcommand: "materialize",
        id: planId,
        options: { steps: "all", materializeType: "Task", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });

      const materializedIds = new Set(result.materialized?.map((entry) => entry.id) ?? []);
      expect(materializedIds.size).toBe(2);
      expect(result.plan.linked_items?.filter((entry) => materializedIds.has(entry.id))).toEqual([]);
      expect(result.plan.steps?.every((step) => step.linked_items?.some((link) => materializedIds.has(link.id) && link.kind === "implements"))).toBe(true);
      const validation = context.runCli(["validate", "--check-lifecycle", "--dependency-cycle-severity", "error", "--json"], { expectJson: true });
      expect(validation.code).toBe(0);
    });
  });

  it("create supports claim and from-search options and accepts blocks/blockedBy deps", async () => {
    await withTempPmPath(async (context) => {
      const related = context.runCli([
        "create",
        "--json",
        "--title",
        "Related",
        "--description",
        "related",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "2",
        "--author",
        "test-author",
        "--message",
        "create related",
      ], { expectJson: true });
      const relatedId = (related.json as { item: { id: string } }).item.id;
      const result = await runPlan({
        subcommand: "create",
        options: {
          title: "Claimed Plan",
          scope: "claim test",
          harness: "codex",
          mode: "research",
          parent: relatedId,
          related: relatedId,
          blocks: relatedId,
          blockedBy: relatedId,
          resumeContext: "initial context",
          tags: "agent,plan",
          priority: "1",
          body: "plan body",
          claim: true,
          fromSearch: "search query",
          author: "test-author",
        } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(result.plan.mode).toBe("research");
      expect(result.plan.harness).toBe("codex");
      expect(result.plan.resume_context).toBe("initial context");
      expect(result.plan.linked_items?.length).toBeGreaterThan(0);
    });
  });

  it("add-step accepts file/test/doc bag inputs and step body/owner", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      const added = await runPlan({
        subcommand: "add-step",
        id: planId,
        options: {
          stepTitle: "rich step",
          stepBody: "body",
          stepOwner: "test-author",
          file: "path=src/x.ts,scope=project,note=file-note",
          test: "command=node t,path=t.ts,note=test-note",
          doc: "path=docs/x.md,scope=project,note=doc-note",
          author: "test-author",
        } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(added.step?.files?.[0]?.path).toBe("src/x.ts");
      expect(added.step?.tests?.[0]?.command).toBe("node t");
      expect(added.step?.docs?.[0]?.path).toBe("docs/x.md");
    });
  });

  it("rejects bad file/test/doc parse inputs and unknown plan modes/statuses", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      await expect(
        runPlan({
          subcommand: "add-step",
          id: planId,
          options: { stepTitle: "bad", file: "src/x.ts", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runPlan({
          subcommand: "add-step",
          id: planId,
          options: { stepTitle: "bad-test", test: "note=oops", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runPlan({
          subcommand: "add-step",
          id: planId,
          options: { stepTitle: "bad-doc", doc: "note=oops", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runPlan({
          subcommand: "create",
          options: { title: "bad-mode", mode: "ridiculous", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runPlan({
          subcommand: "create",
          options: { title: "bad-harness", harness: "robot", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await runPlan({
        subcommand: "add-step",
        id: planId,
        options: { stepTitle: "one", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      await expect(
        runPlan({
          subcommand: "update-step",
          id: planId,
          stepRef: "plan-step-001",
          options: { stepStatus: "not-a-status", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runPlan({
          subcommand: "show",
          id: planId,
          options: { depth: "ginormous" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runPlan({
          subcommand: "show",
          id: planId,
          options: { fields: "" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runPlan({
          subcommand: "link",
          id: planId,
          stepRef: "plan-step-001",
          options: { linkKind: "telepathy", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("step ref lookups support numeric order and reject missing steps", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      await runPlan({
        subcommand: "add-step",
        id: planId,
        options: { stepTitle: "by-order", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      const updated = await runPlan({
        subcommand: "update-step",
        id: planId,
        stepRef: "1",
        options: { stepEvidence: "lookup by order", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(updated.step?.evidence).toBe("lookup by order");
      await expect(
        runPlan({
          subcommand: "update-step",
          id: planId,
          stepRef: "plan-step-099",
          options: { stepEvidence: "missing", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.NOT_FOUND });
      await expect(
        runPlan({
          subcommand: "update-step",
          id: planId,
          stepRef: " ",
          options: { stepEvidence: "blank", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("materialize rejects missing --steps and invalid --materialize-type", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      await runPlan({
        subcommand: "add-step",
        id: planId,
        options: { stepTitle: "one", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      await expect(
        runPlan({
          subcommand: "materialize",
          id: planId,
          options: { author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runPlan({
          subcommand: "materialize",
          id: planId,
          options: { steps: "plan-step-001", materializeType: "NoSuchType", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("link rejects when no link target is provided and supports unknown plan id show", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      await runPlan({
        subcommand: "add-step",
        id: planId,
        options: { stepTitle: "one", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      await expect(
        runPlan({
          subcommand: "link",
          id: planId,
          stepRef: "plan-step-001",
          options: { author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runPlan({
          subcommand: "unlink",
          id: planId,
          stepRef: "plan-step-001",
          options: { author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runPlan({
          subcommand: "show",
          id: "pm-doesnt-exist",
          options: {} as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.NOT_FOUND });
      await expect(
        runPlan({
          subcommand: "resume",
          id: planId,
          options: { author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runPlan({
          subcommand: "decision",
          id: planId,
          options: { author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runPlan({
          subcommand: "discovery",
          id: planId,
          options: { author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runPlan({
          subcommand: "validation",
          id: planId,
          options: { author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("dispatch requires id for non-create subcommands and reorder requires integer", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      const cases: Array<Parameters<typeof runPlan>[0]> = [
        { subcommand: "add-step", options: {} as never, global: { ...GLOBAL, path: context.pmPath } },
        { subcommand: "update-step", options: {} as never, global: { ...GLOBAL, path: context.pmPath } },
        { subcommand: "complete-step", options: {} as never, global: { ...GLOBAL, path: context.pmPath } },
        { subcommand: "block-step", options: {} as never, global: { ...GLOBAL, path: context.pmPath } },
        { subcommand: "remove-step", options: {} as never, global: { ...GLOBAL, path: context.pmPath } },
        { subcommand: "link", options: {} as never, global: { ...GLOBAL, path: context.pmPath } },
        { subcommand: "unlink", options: {} as never, global: { ...GLOBAL, path: context.pmPath } },
        { subcommand: "approve", options: {} as never, global: { ...GLOBAL, path: context.pmPath } },
        { subcommand: "materialize", options: {} as never, global: { ...GLOBAL, path: context.pmPath } },
        { subcommand: "reorder-step", options: {} as never, global: { ...GLOBAL, path: context.pmPath } },
        { subcommand: "decision", options: {} as never, global: { ...GLOBAL, path: context.pmPath } },
        { subcommand: "discovery", options: {} as never, global: { ...GLOBAL, path: context.pmPath } },
        { subcommand: "validation", options: {} as never, global: { ...GLOBAL, path: context.pmPath } },
        { subcommand: "resume", options: {} as never, global: { ...GLOBAL, path: context.pmPath } },
        { subcommand: "reorder-step", id: planId, stepRef: "plan-step-001", options: {} as never, global: { ...GLOBAL, path: context.pmPath } },
      ];
      for (const args of cases) {
        await expect(runPlan(args)).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      }
    });
  });

  it("materialize propagates step linked_items as related deps on new items", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      const related = context.runCli([
        "create",
        "--json",
        "--title",
        "Related",
        "--description",
        "related",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "2",
        "--author",
        "test-author",
        "--message",
        "create related",
      ], { expectJson: true });
      const relatedId = (related.json as { item: { id: string } }).item.id;
      await runPlan({
        subcommand: "add-step",
        id: planId,
        options: { stepTitle: "with link", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      await runPlan({
        subcommand: "link",
        id: planId,
        stepRef: "plan-step-001",
        options: { link: relatedId, linkKind: "blocks", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      const result = await runPlan({
        subcommand: "materialize",
        id: planId,
        options: { steps: "plan-step-001", materializeType: "Task", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(result.materialized?.length).toBe(1);
    });
  });

  it("add-step normalizes empty body/owner/evidence to undefined and rejects empty step title", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      const added = await runPlan({
        subcommand: "add-step",
        id: planId,
        options: { stepTitle: "minimal", stepBody: "   ", stepOwner: "   ", stepEvidence: "  ", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(added.step?.body).toBeUndefined();
      expect(added.step?.owner).toBeUndefined();
      expect(added.step?.evidence).toBeUndefined();
      await expect(
        runPlan({
          subcommand: "add-step",
          id: planId,
          options: { stepTitle: "   ", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("update-step accepts stepReplacement and rejects blocked transition without reason", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      await runPlan({
        subcommand: "add-step",
        id: planId,
        options: { stepTitle: "one", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      const updated = await runPlan({
        subcommand: "update-step",
        id: planId,
        stepRef: "plan-step-001",
        options: { stepStatus: "superseded", stepReplacement: "plan-step-002", author: "test-author" } as Parameters<typeof runPlan>[0]["options"],
        global: { ...GLOBAL, path: context.pmPath },
      });
      expect(updated.step?.superseded_by).toBe("plan-step-002");
    });
  });

  it("requires initialized tracker before running plan", async () => {
    const result = await runPlan({
      subcommand: "show",
      id: "pm-anything",
      options: {} as Parameters<typeof runPlan>[0]["options"],
      global: { ...GLOBAL, path: "/tmp/pm-plan-uninit-not-real" } as never,
    }).catch((error) => error);
    expect(result).toBeInstanceOf(PmCliError);
    expect((result as PmCliError).exitCode).toBe(EXIT_CODE.NOT_FOUND);
  });

  it("rejects unknown subcommands and missing args", async () => {
    await withTempPmPath(async (context) => {
      const { planId } = await bootstrapPlan(context);
      await expect(
        runPlan({
          subcommand: "unknown" as never,
          id: planId,
          options: {} as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runPlan({
          subcommand: "show",
          options: {} as Parameters<typeof runPlan>[0]["options"],
          global: { ...GLOBAL, path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });
});
