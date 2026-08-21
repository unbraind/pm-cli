import { describe, expect, it } from "vitest";
import { runCreate } from "../../../src/cli/commands/create.js";
import { runGet } from "../../../src/cli/commands/get.js";
import { runUpdate } from "../../../src/cli/commands/update.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { BUILTIN_RELATIONSHIP_KINDS } from "../../../src/sdk/relationship-kinds/contract.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("hierarchy mutation contract", () => {
  it("rejects a cycle completed by an explicitly identified create before persistence", async () => {
    await withTempPmPath(async (context) => {
      await runCreate(
        {
          id: "pm-forward-a",
          title: "Forward A",
          description: "Forward hierarchy seed",
          type: "Task",
          createMode: "progressive",
          parent: "pm-forward-b",
          allowMissingParent: true,
        },
        { path: context.pmPath },
      );

      await expect(
        runCreate(
          {
            id: "pm-forward-b",
            title: "Forward B",
            description: "Would complete a hierarchy cycle",
            type: "Task",
            createMode: "progressive",
            parent: "pm-forward-a",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
        code: "hierarchy_cycle_created",
        context: expect.objectContaining({
          source_id: "pm-forward-b",
          verification_errors: ["pm-forward-a", "pm-forward-b"],
        }),
      });
      await expect(
        runGet("pm-forward-b", { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.NOT_FOUND });
    });
  });

  it("rejects cycle closure for every accepted hierarchy kind spelling", async () => {
    await withTempPmPath(async (context) => {
      const spellings = BUILTIN_RELATIONSHIP_KINDS.filter(
        (definition) => definition.hierarchy,
      ).flatMap((definition) => [
        definition.kind,
        ...(definition.aliases ?? []),
      ]);
      for (const [index, kind] of spellings.entries()) {
        const first = `pm-kind-a-${index}`;
        const second = `pm-kind-b-${index}`;
        for (const id of [first, second]) {
          await runCreate(
            {
              id,
              title: id,
              description: `Hierarchy spelling fixture ${kind}`,
              type: "Task",
              createMode: "progressive",
            },
            { path: context.pmPath },
          );
        }
        await runUpdate(
          first,
          { dep: [`id=${second},kind=${kind}`] },
          { path: context.pmPath },
        );
        await expect(
          runUpdate(
            second,
            { dep: [`id=${first},kind=${kind}`] },
            { path: context.pmPath },
          ),
        ).rejects.toMatchObject<PmCliError>({
          code: "hierarchy_cycle_created",
          context: expect.objectContaining({
            source_id: second,
            verification_errors: [first, second],
          }),
        });
        const persisted = await runGet(second, { path: context.pmPath });
        expect(persisted.item.dependencies).toBeUndefined();
      }
    });
  });

  it("serializes concurrent hierarchy writers across different item locks", async () => {
    await withTempPmPath(async (context) => {
      for (const id of ["pm-parent-a", "pm-parent-b", "pm-shared-child"]) {
        await runCreate(
          {
            id,
            title: id,
            description: "Concurrent hierarchy writer fixture",
            type: "Task",
            createMode: "progressive",
          },
          { path: context.pmPath },
        );
      }

      const inheritedLockWait = process.env.PM_LOCK_WAIT_MS;
      delete process.env.PM_LOCK_WAIT_MS;
      process.env.PM_LOCK_WAIT_MS = "3000";
      let outcomes: PromiseSettledResult<unknown>[];
      try {
        outcomes = await Promise.allSettled([
          runUpdate(
            "pm-parent-a",
            { dep: ["id=pm-shared-child,kind=child"] },
            { path: context.pmPath },
          ),
          runUpdate(
            "pm-parent-b",
            { dep: ["id=pm-shared-child,kind=child"] },
            { path: context.pmPath },
          ),
        ]);
      } finally {
        if (inheritedLockWait === undefined) delete process.env.PM_LOCK_WAIT_MS;
        else process.env.PM_LOCK_WAIT_MS = inheritedLockWait;
      }
      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = outcomes.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      expect(rejected?.reason).toMatchObject<PmCliError>({
        code: "hierarchy_cardinality_created",
        context: expect.objectContaining({ target_id: "pm-shared-child" }),
      });
    });
  });

  it("enforces registry cardinality and scalar/dependency direction before persistence", async () => {
    await withTempPmPath(async (context) => {
      for (const id of [
        "pm-parent-a",
        "pm-parent-b",
        "pm-child-a",
        "pm-child-b",
      ]) {
        await runCreate(
          {
            id,
            title: id,
            description: "Hierarchy cardinality fixture",
            type: "Task",
            createMode: "progressive",
          },
          { path: context.pmPath },
        );
      }
      await runUpdate(
        "pm-child-a",
        { dep: ["id=pm-parent-a,kind=parent"] },
        { path: context.pmPath },
      );
      await expect(
        runUpdate(
          "pm-child-a",
          { dep: ["id=pm-parent-b,kind=parent"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        code: "hierarchy_cardinality_created",
        context: expect.objectContaining({
          source_id: "pm-child-a",
          target_id: "pm-child-a",
          verification_errors: ["pm-parent-a", "pm-parent-b"],
        }),
      });

      await runUpdate(
        "pm-parent-a",
        { dep: ["id=pm-child-b,kind=child"] },
        { path: context.pmPath },
      );
      await expect(
        runUpdate(
          "pm-parent-b",
          { dep: ["id=pm-child-b,kind=child"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        code: "hierarchy_cardinality_created",
        context: expect.objectContaining({
          source_id: "pm-parent-b",
          target_id: "pm-child-b",
          verification_errors: ["pm-parent-a", "pm-parent-b"],
        }),
      });

      await runUpdate(
        "pm-child-b",
        { parent: "pm-parent-a" },
        { path: context.pmPath },
      );
      await expect(
        runUpdate(
          "pm-child-b",
          { dep: ["id=pm-parent-b,kind=parent"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        code: "hierarchy_parent_divergence_created",
        context: expect.objectContaining({
          source_id: "pm-child-b",
          target_id: "pm-child-b",
          verification_errors: ["pm-parent-a", "pm-parent-b"],
        }),
      });

      await runUpdate(
        "pm-child-a",
        { parent: "pm-parent-a" },
        { path: context.pmPath },
      );
      await expect(
        runUpdate(
          "pm-parent-b",
          { dep: ["id=pm-child-a,kind=child"] },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        code: "hierarchy_parent_divergence_created",
        context: expect.objectContaining({
          source_id: "pm-parent-b",
          target_id: "pm-child-a",
          verification_errors: ["pm-parent-a", "pm-parent-b"],
        }),
      });
    });
  });
});
