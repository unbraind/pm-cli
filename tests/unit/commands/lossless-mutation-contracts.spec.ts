import { describe, expect, it, vi } from "vitest";
import { runCreate } from "../../../src/cli/commands/create.js";
import { runGet } from "../../../src/cli/commands/get.js";
import { runUpdate } from "../../../src/cli/commands/update.js";
import { runUpdateMany } from "../../../src/cli/commands/update-many.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const createTask = (
  title: string,
  overrides: Parameters<typeof runCreate>[0] = {},
): Parameters<typeof runCreate>[0] => ({
  title,
  description: `${title} description`,
  type: "Task",
  status: "open",
  author: "contract-test",
  ...overrides,
});

describe("lossless mutation contracts", () => {
  it("rejects unresolved local dependency targets by default across create and update", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await expect(
        runCreate(
          createTask("dangling create", {
            dep: [
              "id=missing-create-m,kind=related",
              "id=missing-create-z,kind=related",
              "id=missing-create-a,kind=related",
            ],
          }),
          { path: pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
        context: {
          code: "dependency_target_not_found",
          unresolved_targets: [
            "pm-missing-create-a",
            "pm-missing-create-m",
            "pm-missing-create-z",
          ],
        },
      });

      const holder = await runCreate(createTask("update holder"), {
        path: pmPath,
      });
      await expect(
        runUpdate(
          holder.item.id,
          { dep: ["id=missing-update,kind=blocks"] },
          { path: pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
        context: {
          code: "dependency_target_not_found",
          unresolved_targets: ["pm-missing-update"],
        },
      });
    });
  });

  it("keeps explicit unresolved and external dependency modes truthful", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const unresolved = await runCreate(
        createTask("intentional unresolved", {
          dep: ["id=future-item,kind=related"],
          allowUnresolvedDeps: true,
        }),
        { path: pmPath },
      );
      expect(unresolved.warnings).toContain(
        "dependency_target_unresolved:pm-future-item",
      );

      const external = await runCreate(
        createTask("external reference", {
          dep: ["id=other-workspace:item-1,kind=related,source_kind=external"],
        }),
        { path: pmPath },
      );
      expect(external.item.dependencies?.[0]).toMatchObject({
        id: "other-workspace:item-1",
        source_kind: "global",
      });
      expect(external.warnings).not.toContainEqual(
        expect.stringContaining("dependency_target_unresolved"),
      );
    });
  });

  it("accepts local dependency targets that already exist", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const target = await runCreate(createTask("dependency target"), {
        path: pmPath,
      });
      const holder = await runCreate(
        createTask("dependency holder", {
          dep: [`id=${target.item.id},kind=related`],
        }),
        { path: pmPath },
      );
      expect(holder.item.dependencies?.[0]?.id).toBe(target.item.id);
    });
  });

  it("enforces source-after-target chronology for recurrence mutations", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await withTempPmPath(async ({ pmPath }) => {
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const original = await runCreate(createTask("original occurrence"), {
          path: pmPath,
        });

        vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
        const recurrence = await runCreate(
          createTask("valid later recurrence", {
            dep: [
              `id=${original.item.id},kind=recurs_from`,
              "id=future-related,kind=related",
            ],
            allowUnresolvedDeps: true,
          }),
          { path: pmPath },
        );
        const olderHolder = await runCreate(createTask("older holder"), {
          path: pmPath,
        });
        expect(recurrence.item.dependencies).toContainEqual(
          expect.objectContaining({
            id: original.item.id,
            kind: "recurs_from",
          }),
        );
        expect(recurrence.warnings).toContain(
          "dependency_target_unresolved:pm-future-related",
        );
        await expect(
          runUpdate(
            "missing-recurrence-holder",
            { dep: [`id=${original.item.id},kind=recurs_from`] },
            { path: pmPath },
          ),
        ).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.NOT_FOUND,
        });

        vi.setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
        const newerTarget = await runCreate(createTask("newer target"), {
          path: pmPath,
        });
        await expect(
          runUpdate(
            olderHolder.item.id,
            { dep: [`id=${newerTarget.item.id},kind=recurs_from`] },
            { path: pmPath },
          ),
        ).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.USAGE,
          context: {
            code: "dependency_temporal_order_invalid",
            reason: "source_not_after_target",
            source_id: olderHolder.item.id,
            target_id: newerTarget.item.id,
            temporal_order: "source_after_target",
          },
        });
        await expect(
          runUpdateMany(
            {
              list: { ids: olderHolder.item.id },
              update: {
                dep: [`id=${newerTarget.item.id},kind=recurs_from`],
              },
              dryRun: true,
            },
            { path: pmPath },
          ),
        ).rejects.toMatchObject<PmCliError>({
          context: { code: "dependency_temporal_order_invalid" },
        });
        expect(
          (await runGet(olderHolder.item.id, { path: pmPath })).item
            .dependencies,
        ).toBeUndefined();

        const equalTarget = await runCreate(createTask("equal-time target"), {
          path: pmPath,
        });
        await expect(
          runCreate(
            createTask("equal-time source", {
              dep: [`id=${equalTarget.item.id},kind=recurs_from`],
            }),
            { path: pmPath },
          ),
        ).rejects.toMatchObject<PmCliError>({
          context: { code: "dependency_temporal_order_invalid" },
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps bulk dry-run dependency validation aligned with apply", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const holder = await runCreate(createTask("bulk dependency holder"), {
        path: pmPath,
      });
      const dependency =
        "id=missing-bulk,kind=related,author=contract-test,created_at=2026-01-01T00:00:00.000Z";
      await expect(
        runUpdateMany(
          {
            list: { ids: holder.item.id },
            update: { dep: [dependency] },
            dryRun: true,
          },
          { path: pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
        context: { code: "dependency_target_not_found" },
      });

      const preview = await runUpdateMany(
        {
          list: { ids: holder.item.id },
          update: {
            dep: [dependency],
            allowUnresolvedDeps: true,
          },
          dryRun: true,
        },
        { path: pmPath },
      );
      expect(preview.item_plans?.[0]?.warnings).toContain(
        "dependency_target_unresolved:pm-missing-bulk",
      );

      const applied = await runUpdateMany(
        {
          list: { ids: holder.item.id },
          update: {
            dep: [dependency],
            allowUnresolvedDeps: true,
          },
          checkpoint: false,
        },
        { path: pmPath },
      );
      expect(applied.updated_count).toBe(1);
    });
  });

  it("fails unmatched criterion removal atomically and reports explicit replacement", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const created = await runCreate(
        createTask("criteria holder", {
          acceptanceCriteria: "first criterion; second criterion",
        }),
        { path: pmPath },
      );
      await expect(
        runUpdate(
          created.item.id,
          {
            addAc: ["third criterion"],
            removeAc: ["missing criterion"],
          },
          { path: pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
        context: {
          code: "acceptance_criteria_remove_unmatched",
          unmatched: ["missing criterion"],
        },
      });
      expect(
        (await runGet(created.item.id, {}, { path: pmPath })).item
          .acceptance_criteria,
      ).toBe("first criterion; second criterion");

      const repaired = await runUpdate(
        created.item.id,
        {
          addAc: ["repaired criterion"],
          removeAc: ["second criterion"],
        },
        { path: pmPath },
      );
      expect(repaired.item.acceptance_criteria).toBe(
        "first criterion; repaired criterion",
      );

      await expect(
        runUpdate(
          created.item.id,
          {
            acceptanceCriteria: "replacement",
            addAc: ["ambiguous addition"],
          },
          { path: pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        context: { code: "acceptance_criteria_mutation_conflict" },
      });

      const replaced = await runUpdate(
        created.item.id,
        { acceptanceCriteria: "replacement" },
        { path: pmPath },
      );
      expect(replaced.warnings).toContain("acceptance_criteria_replaced:2:1");

      const empty = await runCreate(createTask("criteria-free holder"), {
        path: pmPath,
      });
      const additivePreview = await runUpdateMany(
        {
          list: { ids: empty.item.id },
          update: { addAc: ["new criterion"] },
          dryRun: true,
        },
        { path: pmPath },
      );
      expect(additivePreview.item_plans?.[0]?.changes).toContainEqual({
        field: "acceptance_criteria",
        before: undefined,
        after: "new criterion",
      });
    });
  });

  it("returns type coercion as structured result data without stderr pollution", async () => {
    await withTempPmPath(async (context) => {
      const result = context.runCli(
        [
          "create",
          "structured synonym",
          "--description",
          "structured synonym description",
          "--type",
          "Bug",
          "--json",
        ],
        { expectJson: true },
      );
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect((result.json as { warnings: string[] }).warnings).toContain(
        "type_coercion:Bug:Issue",
      );

      const failed = context.runCli([
        "create",
        "--create-mode",
        "strict",
        "--type",
        "Bug",
        "--json",
      ]);
      expect(failed.code).not.toBe(0);
      expect(failed.stdout).toBe("");
      expect(() => JSON.parse(failed.stderr)).not.toThrow();
      expect(failed.stderr).not.toContain("[pm] note");
    });
  });
});
