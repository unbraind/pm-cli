import { describe, expect, it } from "vitest";
import {
  _testOnlyItemTransaction,
  WorkspaceTransactionInterruptedError,
  commitItemMutations,
  get,
  type BulkItemMutation,
  type WorkspaceTransactionTransitionContext,
} from "../../../src/sdk/index.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

function createSeedItem(context: TempPmContext, title: string): string {
  const created = context.runCli(
    [
      "create",
      "--json",
      "--title",
      title,
      "--description",
      `${title} description`,
      "--type",
      "Task",
      "--create-mode",
      "progressive",
      "--status",
      "open",
      "--priority",
      "1",
      "--author",
      "bulk-seed",
    ],
    { expectJson: true },
  );
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

async function readItem(
  pmRoot: string,
  id: string,
): Promise<Record<string, unknown>> {
  const located = await get(id, {}, { pmRoot });
  return located.item as Record<string, unknown>;
}

describe("SDK bulk item-mutation transactions (GH-613)", () => {
  it("commits a create/update/close batch atomically and replays the committed result", async () => {
    await withTempPmPath(async (context) => {
      const updateTarget = createSeedItem(context, "bulk-update-target");
      const closeTarget = createSeedItem(context, "bulk-close-target");
      const options = {
        pmRoot: context.pmPath,
        transactionId: "bulk-batch-commit",
        author: "bulk-agent",
        lockTtlSeconds: 60,
        lockWaitMs: 5_000,
        mutations: [
          {
            op: "create" as const,
            id: "bulkitem1",
            options: {
              title: "Bulk created item",
              type: "Task",
              createMode: "progressive",
              priority: "2",
            },
          },
          {
            op: "update" as const,
            id: updateTarget,
            options: { description: "bulk updated description" },
          },
          {
            op: "close" as const,
            id: closeTarget,
            reason: "Bulk batch closure",
          },
        ],
      };

      const committed = await commitItemMutations(options);
      expect(committed.status).toBe("committed");
      expect(committed.recovered).toBe(false);
      expect(committed.results["2-update-" + updateTarget.replaceAll(/[^a-zA-Z0-9._-]/gu, "_")]).toMatchObject({
        op: "update",
        id: updateTarget,
      });
      expect(Object.values(committed.results).map((row) => row.op).sort()).toEqual([
        "close",
        "create",
        "update",
      ]);

      const created = await readItem(context.pmPath, "bulkitem1");
      expect(created.title).toBe("Bulk created item");
      expect((await readItem(context.pmPath, updateTarget)).description).toBe(
        "bulk updated description",
      );
      const closed = await readItem(context.pmPath, closeTarget);
      expect(closed.close_reason).toBe("Bulk batch closure");
      expect(typeof closed.closed_at).toBe("string");

      const replay = await commitItemMutations(options);
      expect(replay.recovered).toBe(true);
      expect(replay.status).toBe("committed");
    });
  });

  it("compensates the whole batch when a later mutation fails (create closed, update restored)", async () => {
    await withTempPmPath(async (context) => {
      const updateTarget = createSeedItem(context, "bulk-restore-target");
      const closeTarget = createSeedItem(context, "bulk-reopen-target");
      const before = await readItem(context.pmPath, updateTarget);

      await expect(
        commitItemMutations({
          pmRoot: context.pmPath,
          transactionId: "bulk-batch-compensate",
          author: "bulk-agent",
          mutations: [
            {
              op: "create" as const,
              id: "bulkitem2",
              options: {
                title: "Bulk compensated item",
                type: "Task",
                createMode: "progressive",
              },
            },
            {
              op: "update" as const,
              id: updateTarget,
              options: { description: "mutated before failure" },
            },
            {
              op: "close" as const,
              id: closeTarget,
              reason: "Closed before failure",
            },
            {
              op: "update" as const,
              id: "pm-does-not-exist",
              options: { description: "never applies" },
            },
          ],
        }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.NOT_FOUND });

      const compensatedCreate = await readItem(context.pmPath, "bulkitem2");
      expect(String(compensatedCreate.close_reason)).toContain(
        "interrupted bulk transaction bulk-batch-compensate",
      );
      const restored = await readItem(context.pmPath, updateTarget);
      expect(restored.description).toBe(before.description);
      await expect(
        _testOnlyItemTransaction.isUpdateMarkerApplied(
          context.pmPath,
          updateTarget,
          "bulk-batch-compensate",
          `2-update-${updateTarget}`,
        ),
      ).resolves.toBe(false);
      const reopened = await readItem(context.pmPath, closeTarget);
      expect(reopened.status).toBe("open");
    });
  });

  it("deletes compensated creations when createCompensation is delete", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        commitItemMutations({
          pmRoot: context.pmPath,
          transactionId: "bulk-batch-delete-compensation",
          author: "bulk-agent",
          createCompensation: "delete",
          mutations: [
            {
              op: "create" as const,
              id: "bulkitem3",
              options: {
                title: "Bulk deleted item",
                type: "Task",
                createMode: "progressive",
              },
            },
            {
              op: "close" as const,
              id: "pm-does-not-exist",
              reason: "never applies",
            },
          ],
        }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.NOT_FOUND });

      await expect(readItem(context.pmPath, "bulkitem3")).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("resumes an interrupted batch without duplicating applied work", async () => {
    await withTempPmPath(async (context) => {
      const closeTarget = createSeedItem(context, "bulk-resume-close");
      const mutations: BulkItemMutation[] = [
        {
          op: "create",
          id: "bulkitem4",
          options: {
            title: "Bulk resumed item",
            type: "Task",
            createMode: "progressive",
          },
        },
        { op: "close", id: closeTarget, reason: "Bulk resumed closure" },
      ];

      await expect(
        commitItemMutations({
          pmRoot: context.pmPath,
          transactionId: "bulk-batch-resume",
          author: "bulk-agent",
          mutations,
          onTransition(transition: WorkspaceTransactionTransitionContext) {
            if (transition.transition === "step_recorded") {
              throw new WorkspaceTransactionInterruptedError(
                "crash after first bulk step",
              );
            }
          },
        }),
      ).rejects.toBeInstanceOf(WorkspaceTransactionInterruptedError);

      expect((await readItem(context.pmPath, "bulkitem4")).title).toBe(
        "Bulk resumed item",
      );
      expect((await readItem(context.pmPath, closeTarget)).status).toBe("open");

      const resumed = await commitItemMutations({
        pmRoot: context.pmPath,
        transactionId: "bulk-batch-resume",
        author: "bulk-agent",
        mutations,
      });
      expect(resumed.recovered).toBe(true);
      const created = await readItem(context.pmPath, "bulkitem4");
      expect(created.title).toBe("Bulk resumed item");
      expect((await readItem(context.pmPath, closeTarget)).close_reason).toBe(
        "Bulk resumed closure",
      );
    });
  });

  it("treats an already-terminal close target as applied instead of re-closing it", async () => {
    await withTempPmPath(async (context) => {
      const closedTarget = createSeedItem(context, "bulk-preclosed");
      const preClose = context.runCli(
        ["close", closedTarget, "Closed before the batch", "--author", "bulk-seed", "--json"],
        { expectJson: true },
      );
      expect(preClose.code).toBe(0);

      const committed = await commitItemMutations({
        pmRoot: context.pmPath,
        transactionId: "bulk-batch-adopt-close",
        author: "bulk-agent",
        mutations: [
          { op: "close", id: closedTarget, reason: "Should not overwrite" },
        ],
      });
      expect(committed.status).toBe("committed");
      expect((await readItem(context.pmPath, closedTarget)).close_reason).toBe(
        "Closed before the batch",
      );
    });
  });

  it("keeps the transaction author authoritative over untyped mutation option bags", async () => {
    await withTempPmPath(async (context) => {
      const updateTarget = createSeedItem(context, "bulk-author-target");
      await commitItemMutations({
        pmRoot: context.pmPath,
        transactionId: "bulk-batch-author",
        author: "bulk-author",
        mutations: [
          {
            op: "update",
            id: updateTarget,
            options: {
              author: "spoofed-author",
              message: "spoofed-message",
              description: "author invariant",
            },
          },
          {
            op: "create",
            id: "bulkitem-author",
            options: {
              author: "spoofed-author",
              title: "Author-owned create",
              type: "Task",
              createMode: "progressive",
            },
          },
        ],
      });

      for (const id of [updateTarget, "bulkitem-author"]) {
        const history = context.runCli(["history", id, "--json", "--full"], {
          expectJson: true,
        });
        const entries = (
          history.json as {
            history: Array<{ author: string; message?: string }>;
          }
        ).history;
        expect(entries.at(-1)?.author).toBe("bulk-author");
      }
      const updateHistory = context.runCli(
        ["history", updateTarget, "--json", "--full"],
        { expectJson: true },
      );
      expect(
        (
          updateHistory.json as {
            history: Array<{ message?: string }>;
          }
        ).history.at(-1)?.message,
      ).toBe("bulk-item-transaction bulk-batch-author 1-update-" + updateTarget + " apply");
    });
  });

  it("keeps compensation idempotent for missing, terminal, and malformed restore targets", async () => {
    await withTempPmPath(async (context) => {
      const closedTarget = createSeedItem(context, "bulk-idempotent-closed");
      expect(
        context.runCli([
          "close",
          closedTarget,
          "Already terminal",
          "--author",
          "bulk-seed",
          "--json",
        ]).code,
      ).toBe(0);
      const config = {
        pmRoot: context.pmPath,
        author: "bulk-agent",
        transactionId: "bulk-idempotent-compensation",
        createCompensation: "close" as const,
      };
      const missingStep = _testOnlyItemTransaction.buildCreateStep(
        config,
        {
          op: "create",
          id: "pm-missing-compensation",
          options: { title: "missing", type: "Task" },
        },
        "1-create-missing",
      );
      await expect(missingStep.compensate()).resolves.toBeUndefined();
      const terminalStep = _testOnlyItemTransaction.buildCreateStep(
        config,
        {
          op: "create",
          id: closedTarget,
          options: { title: "closed", type: "Task" },
        },
        "2-create-terminal",
      );
      await expect(terminalStep.compensate()).resolves.toBeUndefined();

      for (const data of [undefined, null, [], {}]) {
        await expect(
          _testOnlyItemTransaction.compensateByRestore(
            config,
            closedTarget,
            "3-update-malformed",
            data,
          ),
        ).resolves.toBeUndefined();
      }
      await expect(
        _testOnlyItemTransaction.compensateByRestore(
          config,
          "pm-missing-restore",
          "4-update-missing",
          { target_updated_at: new Date().toISOString() },
        ),
      ).resolves.toBeUndefined();
      await expect(
        _testOnlyItemTransaction.readItemSnapshot(context.pmPath, ""),
      ).rejects.toBeInstanceOf(PmCliError);
    });
  });

  it("rejects malformed batches before touching the journal", async () => {
    await withTempPmPath(async (context) => {
      const base = {
        pmRoot: context.pmPath,
        transactionId: "bulk-batch-validation",
        author: "bulk-agent",
      };
      await expect(
        commitItemMutations({ ...base, mutations: [] }),
      ).rejects.toThrow("at least one mutation");
      await expect(
        commitItemMutations({
          ...base,
          mutations: [
            { op: "destroy", id: "pm-x" } as unknown as BulkItemMutation,
          ],
        }),
      ).rejects.toThrow("op must be create, update, or close");
      await expect(
        commitItemMutations({
          ...base,
          mutations: [{ op: "update", id: "   ", options: {} }],
        }),
      ).rejects.toThrow("requires a non-empty id");
      await expect(
        commitItemMutations({
          ...base,
          mutations: [{ op: "close", id: "pm-x", reason: "  " }],
        }),
      ).rejects.toThrow("requires a non-empty reason");
      await expect(
        commitItemMutations({
          ...base,
          createCompensation: "explode" as unknown as "close",
          mutations: [
            {
              op: "create",
              id: "bulkitem5",
              options: { title: "x", type: "Task", createMode: "progressive" },
            },
          ],
        }),
      ).rejects.toThrow("createCompensation must be close or delete");
    });
  });
});
