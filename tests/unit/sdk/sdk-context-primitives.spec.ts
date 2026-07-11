import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PmClient,
  append,
  config,
  comments,
  deps,
  docs,
  files,
  filesDiscover,
  gc,
  health,
  init,
  learnings,
  notes,
  profile,
  profileApply,
  profileLint,
  profileList,
  profileShow,
  schema,
  schemaAddField,
  schemaAddStatus,
  schemaAddType,
  schemaApplyPreset,
  schemaInferTypes,
  schemaList,
  schemaListFields,
  schemaRemoveField,
  schemaRemoveStatus,
  schemaRemoveType,
  schemaShow,
  schemaShowField,
  schemaShowStatus,
  validate,
  type AppendResult,
  type ClaimResult,
  type CloseResult,
  type CloseTaskResult,
  type CommentsResult,
  type CopyResult,
  type CreateResult,
  type DeleteResult,
  type FocusResult,
  type GcResult,
  type HealthResult,
  type PauseTaskResult,
  type PlanCommandResult,
  type ReleaseResult,
  type RestoreResult,
  type SchemaAddFieldResult,
  type SchemaAddTypeResult,
  type SchemaListFieldsResult,
  type SchemaListResult,
  type SchemaResult,
  type SchemaShowFieldResult,
  type SchemaShowResult,
  type SchemaShowStatusResult,
  type StartTaskResult,
  type UpdateResult,
  type ValidateResult,
} from "../../../src/sdk/index.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("SDK context-management primitives", () => {
  it("routes every typed plan convenience method through the shared plan primitive", async () => {
    const client = new PmClient({ noExtensions: true });
    const result: PlanCommandResult = {
      action: "show",
      plan: {
        id: "pm-plan",
        title: "SDK plan",
        status: "active",
        mode: "default",
        steps_summary: {
          total: 0,
          pending: 0,
          in_progress: 0,
          blocked: 0,
          completed: 0,
          skipped: 0,
          superseded: 0,
          completion_pct: 0,
        },
      },
      warnings: [],
      generated_at: "2026-07-11T00:00:00.000Z",
    };
    const plan = vi.spyOn(client, "plan").mockResolvedValue(result);

    await client.planAddStep("pm-plan", {});
    await client.planCompleteStep("pm-plan", "step-1");
    await client.planBlockStep("pm-plan", "step-1", {});
    await client.planReorderStep("pm-plan", "step-1", 2);
    await client.planRemoveStep("pm-plan", "step-1");
    await client.planLink("pm-plan", "step-1", {});
    await client.planUnlink("pm-plan", "step-1", {});
    await client.planDecision("pm-plan", {});
    await client.planDiscovery("pm-plan", {});
    await client.planValidation("pm-plan", {});
    await client.planResume("pm-plan", {});
    await client.planApprove("pm-plan");

    expect(plan.mock.calls).toEqual([
      ["add-step", "pm-plan", {}],
      ["complete-step", "pm-plan", {}, "step-1"],
      ["block-step", "pm-plan", {}, "step-1"],
      ["reorder-step", "pm-plan", {}, "step-1", 2],
      ["remove-step", "pm-plan", {}, "step-1"],
      ["link", "pm-plan", {}, "step-1"],
      ["unlink", "pm-plan", {}, "step-1"],
      ["decision", "pm-plan", {}],
      ["discovery", "pm-plan", {}],
      ["validation", "pm-plan", {}],
      ["resume", "pm-plan", {}],
      ["approve", "pm-plan", {}],
    ]);
  });

  it("exposes typed plan primitives and materializes governed custom fields", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({
        pmRoot: context.pmPath,
        noExtensions: true,
        author: "sdk-plan-test",
      });
      await client.schemaAddField("acceptance_owner", {
        type: "string",
        requiredOnCreate: true,
        requiredTypes: ["Task"],
      });
      const created = await client.planCreate({
        title: "SDK plan",
        step: ["Implement primitive", "Verify primitive"],
      });
      const shown = await client.planShow(created.plan.id, {
        depth: "standard",
      });
      expect(shown.plan.steps).toHaveLength(2);

      const reordered = await client.planReorderStep(
        created.plan.id,
        "plan-step-002",
        1,
      );
      expect(reordered.plan.steps[0]?.id).toBe("plan-step-002");

      const updated = await client.planUpdateStep(
        created.plan.id,
        "plan-step-001",
        { stepStatus: "in_progress" },
      );
      expect(updated.step?.status).toBe("in_progress");

      const materialized = await client.planMaterialize(created.plan.id, {
        steps: "plan-step-001",
        materializeType: "Task",
        materializeTags: "sdk,plan",
        field: ["acceptance_owner=sdk-plan-test"],
      });
      expect(materialized.materialized?.[0]).toMatchObject({
        title: "Implement primitive",
        type: "Task",
        parent: created.plan.id,
        tags: expect.arrayContaining(["sdk", "plan"]),
      });
      const item = context.runCli(
        ["get", materialized.materialized?.[0]?.id ?? "", "--json"],
        { expectJson: true },
      );
      expect(
        (item.json as { item: { acceptance_owner?: string } }).item
          .acceptance_owner,
      ).toBe("sdk-plan-test");
    });
  });

  it("exposes annotation, link, customization, and governance helpers on PmClient and top-level exports", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        ["create", "SDK context primitive", "--type", "Task", "--json"],
        { expectJson: true },
      );
      const related = context.runCli(
        ["create", "SDK related primitive", "--type", "Task", "--json"],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      expect(related.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;
      const relatedId = (related.json as { item: { id: string } }).item.id;
      const client = new PmClient({
        pmRoot: context.pmPath,
        noExtensions: true,
        author: "sdk-test",
      });
      const sdkCreated = await client.create({
        title: "SDK typed mutation result",
        type: "Task",
      });
      expect(sdkCreated.changed_fields).toContain("title");

      const addedComment = await client.comments(id, {
        add: "SDK comment",
        author: "sdk-test",
      });
      expect(addedComment.comments.at(-1)?.text).toBe("SDK comment");
      const listedComments = await comments(
        id,
        { limit: "5" },
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(listedComments.count).toBe(1);

      expect(
        (
          await notes(
            id,
            { add: "SDK note" },
            { pmRoot: context.pmPath, noExtensions: true },
          )
        ).notes.at(-1)?.text,
      ).toBe("SDK note");
      expect(
        (
          await learnings(
            id,
            { add: "SDK learning" },
            { pmRoot: context.pmPath, noExtensions: true },
          )
        ).learnings.at(-1)?.text,
      ).toBe("SDK learning");

      expect(
        (
          await files(
            id,
            { add: ["src/sdk/runtime.ts"], note: "runtime SDK" },
            { pmRoot: context.pmPath, noExtensions: true },
          )
        ).files,
      ).toContainEqual(
        expect.objectContaining({
          path: "src/sdk/runtime.ts",
          note: "runtime SDK",
        }),
      );
      expect(
        (
          await docs(
            id,
            { add: ["docs/SDK.md"], note: "SDK docs" },
            { pmRoot: context.pmPath, noExtensions: true },
          )
        ).docs,
      ).toContainEqual(
        expect.objectContaining({ path: "docs/SDK.md", note: "SDK docs" }),
      );
      const appended = await append(
        id,
        "SDK body context",
        { author: "sdk-test", fullChangedFields: true },
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(appended.appended).toBe("SDK body context");
      expect(appended.changed_fields).toContain("body");
      const discoveredFiles = await filesDiscover(
        id,
        {},
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(discoveredFiles.id).toBe(id);

      await client.update(id, {
        dep: [`id=${relatedId},kind=related`],
        author: "sdk-test",
      });
      const relationshipGraph = await deps(
        id,
        { format: "graph" },
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(relationshipGraph.edge_count).toBe(1);

      const initialized = await init(
        "sdkinit",
        { defaults: true, author: "sdk-test" },
        {
          pmRoot: path.join(context.tempRoot, "nested", ".agents", "pm"),
          noExtensions: true,
        },
      );
      expect(initialized.ok).toBe(true);
      const initializedWithoutPrefix = await new PmClient({
        pmRoot: path.join(
          context.tempRoot,
          "nested-no-prefix",
          ".agents",
          "pm",
        ),
        noExtensions: true,
      }).init(undefined, { defaults: true, author: "sdk-test" });
      expect(initializedWithoutPrefix.ok).toBe(true);
      const configResult = await config(
        "project",
        "get",
        "item-format",
        undefined,
        {},
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(configResult).toMatchObject({
        scope: "project",
        key: "item_format",
        changed: false,
      });
      const configListResult = await client.config("project", "list");
      expect(configListResult.keys?.length).toBeGreaterThan(0);
      const configSetResult = await client.config(
        "project",
        "set",
        "governance-require-close-reason",
        "disabled",
      );
      expect(configSetResult.changed).toBe(true);

      const schemaViaGeneric = await schema(
        "list",
        {},
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(schemaViaGeneric.action).toBe("list");
      const schemaType = await schemaAddType(
        "SdkRisk",
        { description: "SDK registered type" },
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(schemaType.registered).toBe(true);
      const shownSchemaType = await schemaShow("SdkRisk", {
        pmRoot: context.pmPath,
        noExtensions: true,
      });
      expect(shownSchemaType.type?.name).toBe("SdkRisk");
      const schemaStatus = await schemaAddStatus(
        "sdk_review",
        { role: ["active"], description: "SDK review" },
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(schemaStatus.registered).toBe(true);
      const shownStatus = await schemaShowStatus("sdk_review", {
        pmRoot: context.pmPath,
        noExtensions: true,
      });
      expect(shownStatus.status?.id).toBe("sdk_review");
      const schemaField = await schemaAddField(
        "risk_score",
        {
          type: "number",
          commands: ["create", "update"],
          description: "risk score",
        },
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(schemaField.field.key).toBe("risk_score");
      const fields = await schemaListFields({
        pmRoot: context.pmPath,
        noExtensions: true,
      });
      expect(fields.fields).toContainEqual(
        expect.objectContaining({ key: "risk_score" }),
      );
      const shownField = await schemaShowField("risk_score", {
        pmRoot: context.pmPath,
        noExtensions: true,
      });
      expect(shownField.field?.key).toBe("risk_score");
      const preset = await schemaApplyPreset(
        "agile",
        { author: "sdk-test" },
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(preset.action).toBe("apply-preset");
      const inferred = await schemaInferTypes(
        { minCount: 1, apply: false },
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(inferred.action).toBe("infer-types");
      const schemaListResult = await schemaList({
        pmRoot: context.pmPath,
        noExtensions: true,
      });
      expect(schemaListResult.custom).toContainEqual(
        expect.objectContaining({ name: "SdkRisk" }),
      );
      expect(
        (
          await schemaRemoveField(
            "risk_score",
            { author: "sdk-test" },
            { pmRoot: context.pmPath, noExtensions: true },
          )
        ).removed,
      ).toBe(true);
      expect(
        (
          await schemaRemoveStatus(
            "sdk_review",
            { author: "sdk-test" },
            { pmRoot: context.pmPath, noExtensions: true },
          )
        ).removed,
      ).toBe(true);
      expect(
        (
          await schemaRemoveType(
            "SdkRisk",
            { author: "sdk-test" },
            { pmRoot: context.pmPath, noExtensions: true },
          )
        ).removed,
      ).toBe(true);

      const genericProfiles = await profile(
        "list",
        {},
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(genericProfiles.action).toBe("list");
      const profiles = await profileList({
        pmRoot: context.pmPath,
        noExtensions: true,
      });
      expect(profiles.profiles.length).toBeGreaterThan(0);
      const shownProfile = await profileShow("agile", {
        pmRoot: context.pmPath,
        noExtensions: true,
      });
      expect(shownProfile.name).toBe("agile");
      const profilePlan = await profileApply(
        "agile",
        { dryRun: true, author: "sdk-test" },
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(profilePlan.dry_run).toBe(true);
      const profileReport = await profileLint("agile", {
        pmRoot: context.pmPath,
        noExtensions: true,
      });
      expect(profileReport.ok).toBe(true);

      const checkedHealth = await health(
        { checkOnly: true, summary: true },
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(checkedHealth.ok).toBe(true);
      const checkedValidate = await validate(
        { checkResolution: true, checkHistoryDrift: true },
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(checkedValidate.ok).toBe(true);
      const checkedGc = await gc(
        { dryRun: true, scope: ["locks"] },
        { pmRoot: context.pmPath, noExtensions: true },
      );
      expect(checkedGc.ok).toBe(true);
    });
  });

  it("keeps new primitive result contracts available as public SDK types", () => {
    const appendResult: Pick<AppendResult, "appended" | "changed_fields"> = {
      appended: "body",
      changed_fields: ["body"],
    };
    const commentResult: Pick<CommentsResult, "id" | "count"> = {
      id: "pm-a",
      count: 1,
    };
    const schemaResult: Pick<SchemaResult, "action"> = { action: "list" };
    const schemaList: Pick<SchemaListResult, "action"> = { action: "list" };
    const schemaShow: Pick<SchemaShowResult, "action"> = { action: "show" };
    const schemaShowStatus: Pick<SchemaShowStatusResult, "action"> = {
      action: "show-status",
    };
    const schemaListFields: Pick<SchemaListFieldsResult, "action"> = {
      action: "list-fields",
    };
    const schemaShowField: Pick<SchemaShowFieldResult, "action"> = {
      action: "show-field",
    };
    const schemaType: Pick<SchemaAddTypeResult, "action" | "registered"> = {
      action: "add-type",
      registered: true,
    };
    const schemaField: Pick<SchemaAddFieldResult, "action" | "registered"> = {
      action: "add-field",
      registered: true,
    };
    const healthResult: Pick<HealthResult, "ok" | "warnings"> = {
      ok: true,
      warnings: [],
    };
    const validateResult: Pick<ValidateResult, "ok" | "checks"> = {
      ok: true,
      checks: [],
    };
    const gcResult: Pick<GcResult, "ok" | "dry_run"> = {
      ok: true,
      dry_run: true,
    };
    const createResult: Pick<CreateResult, "changed_fields" | "warnings"> = {
      changed_fields: ["title"],
      warnings: [],
    };
    const updateResult: Pick<UpdateResult, "changed_fields" | "warnings"> = {
      changed_fields: ["status"],
      warnings: [],
    };
    const closeResult: Pick<CloseResult, "changed_fields" | "warnings"> = {
      changed_fields: ["status"],
      warnings: [],
    };
    const claimResult: Pick<ClaimResult, "claimed_by" | "forced"> = {
      claimed_by: "agent",
      forced: false,
    };
    const releaseResult: Pick<ReleaseResult, "released_by" | "forced"> = {
      released_by: "agent",
      forced: false,
    };
    const copyResult: Pick<CopyResult, "source_id" | "changed_fields"> = {
      source_id: "pm-a",
      changed_fields: ["title"],
    };
    const deleteResult: Pick<DeleteResult, "changed_fields" | "dry_run"> = {
      changed_fields: ["deleted"],
      dry_run: false,
    };
    const restoreResult: Pick<
      RestoreResult,
      "changed_fields" | "restored_from"
    > = {
      changed_fields: ["title"],
      restored_from: {
        kind: "version",
        target: "1",
        history_index: 0,
        entry_ts: "2026-01-01T00:00:00.000Z",
        entry_op: "create",
      },
    };
    const focusResult: Pick<FocusResult, "action" | "focused_item"> = {
      action: "set",
      focused_item: "pm-a",
    };
    const startTaskResult: Pick<
      StartTaskResult,
      "action" | "claim" | "update"
    > = {
      action: "start_task",
      claim: {
        item: {},
        claimed_by: "agent",
        previous_assignee: null,
        forced: false,
      },
      update: { item: {}, changed_fields: ["status"], warnings: [] },
    };
    const pauseTaskResult: Pick<
      PauseTaskResult,
      "action" | "update" | "release"
    > = {
      action: "pause_task",
      update: { item: {}, changed_fields: ["status"], warnings: [] },
      release: {
        item: {},
        released_by: "agent",
        previous_assignee: null,
        audit_release: false,
        forced: false,
      },
    };
    const planResult: Pick<PlanCommandResult, "action" | "warnings"> = {
      action: "show",
      warnings: [],
    };
    const closeTaskResult: Pick<
      CloseTaskResult,
      "action" | "close" | "release"
    > = {
      action: "close_task",
      close: { item: {}, changed_fields: ["status"], warnings: [] },
      release: {
        item: {},
        released_by: "agent",
        previous_assignee: null,
        audit_release: false,
        forced: false,
      },
    };

    expect(appendResult.changed_fields).toEqual(["body"]);
    expect(commentResult.count).toBe(1);
    expect(schemaResult.action).toBe("list");
    expect(
      [
        schemaList,
        schemaShow,
        schemaShowStatus,
        schemaListFields,
        schemaShowField,
      ].map((result) => result.action),
    ).toEqual(["list", "show", "show-status", "list-fields", "show-field"]);
    expect(schemaType.registered).toBe(true);
    expect(schemaField.registered).toBe(true);
    expect(healthResult.ok).toBe(true);
    expect(validateResult.checks).toEqual([]);
    expect(gcResult.dry_run).toBe(true);
    expect(createResult.changed_fields).toEqual(["title"]);
    expect(updateResult.changed_fields).toEqual(["status"]);
    expect(closeResult.warnings).toEqual([]);
    expect(claimResult.claimed_by).toBe("agent");
    expect(releaseResult.released_by).toBe("agent");
    expect(copyResult.source_id).toBe("pm-a");
    expect(deleteResult.dry_run).toBe(false);
    expect(restoreResult.restored_from.kind).toBe("version");
    expect(focusResult.focused_item).toBe("pm-a");
    expect(startTaskResult.claim.claimed_by).toBe("agent");
    expect(pauseTaskResult.release.released_by).toBe("agent");
    expect(closeTaskResult.close.changed_fields).toEqual(["status"]);
    expect(planResult.action).toBe("show");
  });
});
