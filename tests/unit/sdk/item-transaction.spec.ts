import { describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import {
  _testOnlyItemTransaction,
  WorkspaceTransactionInterruptedError,
  buildItemCompletionMutations,
  commitItemCompletion,
  commitItemMutations,
  previewItemMutations,
  close,
  get,
  reopen,
  update,
  type BulkItemMutation,
  type BulkItemUniqueKey,
  type WorkspaceTransactionTransitionContext,
} from "../../../src/sdk/index.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import {
  withTempPmPath,
  type TempPmContext,
} from "../../helpers/withTempPmPath.js";

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
  it.each<{
    name: string; key: string; first: unknown; middle?: unknown; last: unknown;
    middleUnique?: BulkItemUniqueKey; seed?: boolean; commits?: boolean;
  }>([
    { name: "unguarded", key: "description", first: "A", middle: "B", last: "B" },
    { name: "different guard key", key: "description", first: "A", middle: "B", last: "B", middleUnique: { key: "title", value: "Middle" } },
    { name: "different guard value", key: "description", first: "A", middle: "B", last: "B", middleUnique: { key: "description", value: "C" } },
    { name: "normalized array values", key: "tags", first: ["a"], middle: ["B"], last: ["b"] },
    { name: "missing metadata", key: "external_id", first: "A", last: "B", commits: true },
    { name: "all matching ids", key: "description", first: "A", middle: "C", last: "C", seed: true },
  ])("keeps cached key values current after creates: $name", async (scenario) => {
    await withTempPmPath(async (context) => {
      if (scenario.key === "external_id") expect(context.runCli(["schema", "add-field", "external_id", "--type", "string", "--json"]).code).toBe(0);
      if (scenario.seed) expect(context.runCli(["create", "--id", "pm-scan-existing", "--title", "Existing", "--type", "Task", "--description", "C", "--json"]).code).toBe(0);
      const optionsFor = (title: string, value: unknown) => ({ title, type: "Task", ...(value === undefined ? {} : { [scenario.key === "external_id" ? "externalId" : scenario.key]: Array.isArray(value) ? value.join(",") : value }) });
      const options = { pmRoot: context.pmPath, transactionId: `created-key-${scenario.name.replaceAll(" ", "-")}`, author: "bulk-agent", createCompensation: "delete" as const, mutations: [
        { op: "create", id: "pm-scan-first", options: optionsFor("First", scenario.first), unique: { key: scenario.key, value: scenario.first } },
        { op: "create", id: "pm-scan-middle", options: optionsFor("Middle", scenario.middle), ...(scenario.middleUnique ? { unique: scenario.middleUnique } : {}) },
        { op: "create", id: "pm-scan-last", options: optionsFor("Last", scenario.last), unique: { key: scenario.key, value: scenario.last } },
      ] satisfies BulkItemMutation[] };
      for (const execute of [previewItemMutations, commitItemMutations]) {
        if (scenario.commits) await expect(execute(options)).resolves.toBeDefined();
        else if (scenario.seed) await expect(execute(options)).rejects.toThrow(/pm-scan-existing, pm-scan-middle/u);
        else await expect(execute(options)).rejects.toMatchObject({ context: { code: "upsert_key_conflict" } });
      }
      if (scenario.commits) {
        expect((await readItem(context.pmPath, "pm-scan-last")).external_id).toBe("B");
        expect((await readItem(context.pmPath, "pm-scan-middle")).external_id).toBeUndefined();
      } else {
        for (const id of ["pm-scan-first", "pm-scan-middle", "pm-scan-last"]) await expect(readItem(context.pmPath, id)).rejects.toThrow();
      }
    });
  });

  it.each(["close", "release"] as const)("refreshes unique-key scans after an intervening %s", async (op) => {
    await withTempPmPath(async (context) => {
      const target = createSeedItem(context, "Lifecycle scan target");
      const closing = op === "close";
      expect(context.runCli(closing ? ["update", target, "--status", "in_progress", "--json"] : ["claim", target, "--author", "bulk-agent", "--json"]).code).toBe(0);
      const key = closing ? "status" : "assignee";
      const first = closing ? "open" : "first-owner";
      const last = closing ? "closed" : "bulk-agent";
      const options = { pmRoot: context.pmPath, transactionId: `unique-scan-${op}`, author: "bulk-agent", createCompensation: "delete" as const, mutations: [
        { op: "create", id: "pm-lifecycle-first", options: { title: "First", type: "Task", [key]: first }, unique: { key, value: first } },
        closing ? { op: "close", id: target, reason: "Scan closure" } : { op: "release", id: target },
        { op: "create", id: "pm-lifecycle-last", options: { title: "Last", type: "Task", [key]: last, ...(closing ? { closeReason: "Created terminal item" } : {}) }, unique: { key, value: last } },
      ] satisfies BulkItemMutation[] };
      for (const execute of [previewItemMutations, commitItemMutations]) {
        if (closing) await expect(execute(options)).rejects.toMatchObject({ context: { code: "upsert_key_conflict" } });
        else await expect(execute(options)).resolves.toBeDefined();
      }
      if (closing) {
        expect((await readItem(context.pmPath, target)).status).toBe("in_progress");
        await expect(readItem(context.pmPath, "pm-lifecycle-first")).rejects.toThrow();
      } else {
        expect((await readItem(context.pmPath, target)).assignee).toBeUndefined();
        expect((await readItem(context.pmPath, "pm-lifecycle-last")).assignee).toBe("bulk-agent");
      }
    });
  });

  it.each(["into", "away", "created"] as const)("refreshes unique-key scans after an intervening update: %s", async (mode) => {
    await withTempPmPath(async (context) => {
      const target = mode === "created" ? "pm-scan-first" : createSeedItem(context, "Existing scan target");
      const original = mode === "away" ? "B" : "original";
      if (mode !== "created") expect(context.runCli(["update", target, "--description", original, "--json"]).code).toBe(0);
      const options = { pmRoot: context.pmPath, transactionId: `unique-scan-${mode}`, author: "bulk-agent", createCompensation: "delete" as const, mutations: [
        { op: "create", id: "pm-scan-first", options: { title: "First", type: "Task", description: "A" }, unique: { key: "description", value: "A" } },
        { op: "update", id: target, options: { description: mode === "away" ? "C" : "B" } },
        { op: "create", id: "pm-scan-last", options: { title: "Last", type: "Task", description: "B" }, unique: { key: "description", value: "B" } },
      ] satisfies BulkItemMutation[] };
      for (const execute of [previewItemMutations, commitItemMutations]) {
        if (mode === "away") await expect(execute(options)).resolves.toBeDefined();
        else await expect(execute(options)).rejects.toMatchObject({ context: { code: "upsert_key_conflict" } });
      }
      if (mode === "away") {
        expect((await readItem(context.pmPath, target)).description).toBe("C");
        expect((await readItem(context.pmPath, "pm-scan-last")).description).toBe("B");
      } else {
        await expect(readItem(context.pmPath, "pm-scan-first")).rejects.toThrow();
        await expect(readItem(context.pmPath, "pm-scan-last")).rejects.toThrow();
        if (mode !== "created") expect((await readItem(context.pmPath, target)).description).toBe(original);
      }
    });
  });

  it.each([
    { key: "description", value: "shared", other: " shared ", options: { description: "shared" } },
    { key: "tags", value: ["shared"], other: ["shared"], options: { tags: '["shared"]' } },
  ])("refuses duplicate direct SDK unique guards before journals or item writes: $key", async (guard) => {
    await withTempPmPath(async (context) => {
      const before = await readdir(context.pmPath, { recursive: true });
      for (const execute of [previewItemMutations, commitItemMutations]) {
        await expect(execute({ pmRoot: context.pmPath, transactionId: "direct-unique-duplicates", author: "bulk-agent", mutations: [
          { op: "create", id: "pm-guard-a", options: { title: "First", type: "Task", ...guard.options }, unique: { key: guard.key, value: guard.value } },
          { op: "create", id: "pm-guard-b", options: { title: "Second", type: "Task", ...guard.options }, unique: { key: guard.key, value: guard.other } },
        ] })).rejects.toMatchObject({ exitCode: 2, context: { code: "upsert_key_duplicate" } });
        expect(await readdir(context.pmPath, { recursive: true })).toEqual(before);
      }
    });
  });

  it("keeps identical unique values independent across metadata keys", async () => {
    await withTempPmPath(async (context) => {
      const result = await commitItemMutations({ pmRoot: context.pmPath, transactionId: "independent-unique-keys", author: "bulk-agent", mutations: [
        { op: "create", id: "pm-title-guard", options: { title: "Shared", type: "Task", description: "Different" }, unique: { key: "title", value: "Shared" } },
        { op: "create", id: "pm-description-guard", options: { title: "Other", type: "Task", description: "Shared" }, unique: { key: "description", value: "Shared" } },
      ] });
      expect(result.status).toBe("committed");
      expect((await readItem(context.pmPath, "pm-description-guard")).description).toBe("Shared");
    });
  });

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
      expect(
        committed.results[
          "2-update-" + updateTarget.replaceAll(/[^a-zA-Z0-9._-]/gu, "_")
        ],
      ).toMatchObject({
        op: "update",
        id: updateTarget,
      });
      expect(
        Object.values(committed.results)
          .map((row) => row.op)
          .sort(),
      ).toEqual(["close", "create", "update"]);

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
      await expect(
        commitItemMutations({
          ...options,
          mutations: options.mutations.map((mutation, index) =>
            index === 1 && mutation.op === "update"
              ? {
                  ...mutation,
                  options: { description: "replay payload mismatch" },
                }
              : mutation,
          ),
        }),
      ).rejects.toThrow("journal does not match the supplied plan");
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
          _testOnlyItemTransaction.deriveStepId(
            {
              op: "update",
              id: updateTarget,
              options: { description: "mutated before failure" },
            },
            1,
          ),
        ),
      ).resolves.toBe(false);
      const reopened = await readItem(context.pmPath, closeTarget);
      expect(reopened.status).toBe("open");
    });
  });

  it.each([false, true])("refuses a compensated create retry until explicitly reopened (changed close prose: %s)", async (changedReason) => {
    await withTempPmPath(async (context) => {
      const options = { pmRoot: context.pmPath, transactionId: "closed-create-retry", author: "bulk-agent", mutations: [
        { op: "create", id: "pm-retry-created", options: { title: "Retry created", type: "Task", assignee: "bulk-agent" } },
        { op: "close", id: "pm-retry-later", reason: "Later row" },
      ] satisfies BulkItemMutation[] };
      await expect(commitItemMutations(options)).rejects.toMatchObject({ exitCode: EXIT_CODE.NOT_FOUND });
      expect((await readItem(context.pmPath, "pm-retry-created")).status).toBe("closed");
      expect(context.runCli(["create", "--id", "pm-retry-later", "--title", "Later target", "--type", "Task", "--json"]).code).toBe(0);
      if (changedReason) await update("pm-retry-created", { closeReason: "Reviewed rollback" }, { pmRoot: context.pmPath });
      const before = await readItem(context.pmPath, "pm-retry-created");
      await expect(commitItemMutations(options)).rejects.toMatchObject({ exitCode: EXIT_CODE.CONFLICT, context: { code: "transaction_create_compensated", item_id: "pm-retry-created" } });
      expect(await readItem(context.pmPath, "pm-retry-created")).toEqual(before);
      expect((await readItem(context.pmPath, "pm-retry-later")).status).toBe("open");
      await reopen("pm-retry-created", "Explicitly retry compensated creation", {}, { pmRoot: context.pmPath });
      await expect(commitItemMutations(options)).resolves.toMatchObject({ status: "committed", recovered: true });
      expect((await readItem(context.pmPath, "pm-retry-created")).status).toBe("open");
      await expect(commitItemMutations(options)).resolves.toMatchObject({ status: "committed", recovered: true });
      expect((await readItem(context.pmPath, "pm-retry-created")).status).toBe("open");
    });
  });

  it.each(["close", "update"])("preserves a later user closure when retrying a compensated creation (%s)", async (operation) => {
    await withTempPmPath(async (context) => {
      const options = { pmRoot: context.pmPath, transactionId: "later-user-close", author: "bulk-agent", mutations: [
        { op: "create", id: "pm-user-closed", options: { title: "User closed", type: "Task" } },
        { op: "close", id: "pm-user-later", reason: "Later row" },
      ] satisfies BulkItemMutation[] };
      await expect(commitItemMutations(options)).rejects.toMatchObject({ exitCode: EXIT_CODE.NOT_FOUND });
      expect(context.runCli(["create", "--id", "pm-user-later", "--title", "Later target", "--type", "Task", "--json"]).code).toBe(0);
      await reopen("pm-user-closed", "Review compensated creation", {}, { pmRoot: context.pmPath });
      if (operation === "close") await close("pm-user-closed", "User completion", { author: "later-user" }, { pmRoot: context.pmPath });
      else await update("pm-user-closed", { status: "closed", closeReason: "User completion", author: "later-user" }, { pmRoot: context.pmPath });
      const before = await readItem(context.pmPath, "pm-user-closed");
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(commitItemMutations(options)).resolves.toMatchObject({ status: "committed", recovered: true });
        expect(await readItem(context.pmPath, "pm-user-closed")).toEqual(before);
        expect((await readItem(context.pmPath, "pm-user-later")).status).toBe("closed");
      }
    });
  });

  it("recovers an intentionally terminal creation interrupted before journal recording", async () => {
    await withTempPmPath(async (context) => {
      const options = { pmRoot: context.pmPath, transactionId: "terminal-create-recovery", author: "bulk-agent", mutations: [
        { op: "create", id: "pm-terminal-created", options: { title: "Terminal create", type: "Task", status: "closed", closeReason: "Created as terminal", createMode: "progressive" } },
      ] satisfies BulkItemMutation[] };
      await expect(commitItemMutations({ ...options, onTransition(transition) {
        if (transition.transition === "step_applied") throw new WorkspaceTransactionInterruptedError("crash after terminal create before journal recording");
      } })).rejects.toBeInstanceOf(WorkspaceTransactionInterruptedError);
      const before = await readItem(context.pmPath, "pm-terminal-created");
      expect(before.status).toBe("closed");
      await expect(commitItemMutations(options)).resolves.toMatchObject({ status: "committed", recovered: true });
      expect(await readItem(context.pmPath, "pm-terminal-created")).toEqual(before);
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

      await expect(readItem(context.pmPath, "bulkitem3")).rejects.toMatchObject(
        {
          exitCode: EXIT_CODE.NOT_FOUND,
        },
      );
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
        [
          "close",
          closedTarget,
          "Closed before the batch",
          "--author",
          "bulk-seed",
          "--json",
        ],
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

  it("retries an identical closed update in a mixed batch without touching its closure clocks (GH-1628)", async () => {
    await withTempPmPath(async (context) => {
      const closedTarget = createSeedItem(context, "bulk-identical-closed");
      const preClose = context.runCli(
        ["close", closedTarget, "Closed before the batch", "--author", "bulk-seed", "--json"],
        { expectJson: true },
      );
      expect(preClose.code).toBe(0);
      const openTarget = createSeedItem(context, "bulk-identical-open");
      const before = await readItem(context.pmPath, closedTarget);
      await new Promise((resolve) => setTimeout(resolve, 5));

      const mutations = [
        {
          op: "update" as const,
          id: closedTarget,
          options: {
            title: before.title,
            status: "closed",
            closeReason: before.close_reason,
            force: true,
          },
        },
        { op: "update" as const, id: openTarget, options: { title: "Renamed in the batch" } },
      ];
      const first = await commitItemMutations({
        pmRoot: context.pmPath,
        transactionId: "bulk-batch-identical-closed",
        author: "bulk-agent",
        mutations,
      });
      expect(first.status).toBe("committed");
      const retried = await commitItemMutations({
        pmRoot: context.pmPath,
        transactionId: "bulk-batch-identical-closed-retry",
        author: "bulk-agent",
        mutations,
      });
      expect(retried.status).toBe("committed");

      const after = await readItem(context.pmPath, closedTarget);
      expect(after.closed_at).toBe(before.closed_at);
      expect(after.updated_at).toBe(before.updated_at);
      expect(after.close_reason).toBe("Closed before the batch");
      expect((await readItem(context.pmPath, openTarget)).title).toBe("Renamed in the batch");
    });
  });

  it("records evidence, closes, and releases one claimed item atomically", async () => {
    await withTempPmPath(async (context) => {
      const target = createSeedItem(context, "atomic-completion");
      expect(
        context.runCli(["claim", target, "--author", "bulk-agent", "--json"])
          .code,
      ).toBe(0);

      const committed = await commitItemCompletion({
        pmRoot: context.pmPath,
        transactionId: "complete-item-42",
        author: "bulk-agent",
        id: target,
        reason: "Acceptance evidence passed",
        evidence: {
          comment: ["text=Verified in an isolated consumer"],
          learning: ["text=Completion is one governed transaction"],
        },
        closeOptions: {
          resolution: "Delivered atomically",
          expectedResult: "All evidence and closure land together",
          actualResult: "All evidence and closure landed together",
        },
        lockTtlSeconds: 30,
        lockWaitMs: 1_000,
        onTransition: async () => undefined,
      });

      expect(Object.values(committed.results).map((row) => row.op)).toEqual([
        "update",
        "close",
        "release",
      ]);
      const completed = await readItem(context.pmPath, target);
      expect(completed.status).toBe("closed");
      expect(completed.close_reason).toBe("Acceptance evidence passed");
      expect(completed.resolution).toBe("Delivered atomically");
      expect(completed).not.toHaveProperty("assignee");
      expect(completed).not.toHaveProperty("claim_principal");
      const fullCompleted = context.runCli(
        ["get", target, "--json", "--full"],
        { expectJson: true },
      ).json as { item: Record<string, unknown> };
      expect(fullCompleted.item.comments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "Verified in an isolated consumer" }),
        ]),
      );
    });
  });

  it("builds minimal and force-release completion plans without empty evidence", () => {
    expect(
      buildItemCompletionMutations({ id: "pm-minimal", reason: "Done" }),
    ).toEqual([
      { op: "close", id: "pm-minimal", reason: "Done" },
      { op: "release", id: "pm-minimal" },
    ]);
    expect(
      buildItemCompletionMutations({
        id: "pm-minimal",
        reason: "Done",
        evidence: {},
        releaseOptions: { force: true },
      }),
    ).toEqual([
      { op: "close", id: "pm-minimal", reason: "Done" },
      { op: "release", id: "pm-minimal", options: { force: true } },
    ]);
  });

  it("commits a minimal unclaimed completion with default transaction controls", async () => {
    await withTempPmPath(async (context) => {
      const target = createSeedItem(context, "minimal-completion");
      const committed = await commitItemCompletion({
        pmRoot: context.pmPath,
        transactionId: "minimal-completion-defaults",
        author: "bulk-agent",
        id: target,
        reason: "Minimal completion passed",
      });
      expect(Object.values(committed.results).map((row) => row.op)).toEqual([
        "close",
        "release",
      ]);
    });
  });

  it("rejects a release mutation whose target does not exist", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        commitItemMutations({
          pmRoot: context.pmPath,
          transactionId: "release-missing-target",
          author: "bulk-agent",
          mutations: [{ op: "release", id: "pm-missing-release" }],
        }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.NOT_FOUND });
    });
  });

  it("does not reclose a later reopen when recovering an already-applied close", async () => {
    await withTempPmPath(async (context) => {
      const target = createSeedItem(context, "close-recovery-marker");
      const options = {
        pmRoot: context.pmPath,
        transactionId: "close-recovery-marker",
        author: "bulk-agent",
        mutations: [
          {
            op: "close" as const,
            id: target,
            reason: "Close before interrupted journal write",
          },
        ],
      };

      await expect(
        commitItemMutations({
          ...options,
          onTransition(transition: WorkspaceTransactionTransitionContext) {
            if (transition.transition === "step_applied") {
              throw new WorkspaceTransactionInterruptedError(
                "crash after close before journal recording",
              );
            }
          },
        }),
      ).rejects.toBeInstanceOf(WorkspaceTransactionInterruptedError);

      expect(
        context.runCli([
          "update",
          target,
          "--status",
          "open",
          "--author",
          "later-agent",
          "--json",
        ]).code,
      ).toBe(0);
      await expect(commitItemMutations(options)).resolves.toMatchObject({
        recovered: true,
        status: "committed",
      });
      expect((await readItem(context.pmPath, target)).status).toBe("open");
    });
  });

  it("does not release a later claim when recovering an already-applied release", async () => {
    await withTempPmPath(async (context) => {
      const target = createSeedItem(context, "release-recovery-marker");
      expect(
        context.runCli(["claim", target, "--author", "bulk-agent", "--json"])
          .code,
      ).toBe(0);
      const options = {
        pmRoot: context.pmPath,
        transactionId: "release-recovery-marker",
        author: "bulk-agent",
        mutations: [{ op: "release" as const, id: target }],
      };

      await expect(
        commitItemMutations({
          ...options,
          onTransition(transition: WorkspaceTransactionTransitionContext) {
            if (transition.transition === "step_applied") {
              throw new WorkspaceTransactionInterruptedError(
                "crash after release before journal recording",
              );
            }
          },
        }),
      ).rejects.toBeInstanceOf(WorkspaceTransactionInterruptedError);

      expect(
        context.runCli(["claim", target, "--author", "later-agent", "--json"])
          .code,
      ).toBe(0);
      await expect(commitItemMutations(options)).resolves.toMatchObject({
        recovered: true,
        status: "committed",
      });
      expect((await readItem(context.pmPath, target)).assignee).toBe(
        "later-agent",
      );
    });
  });

  it("restores evidence, lifecycle, and claim when a post-release step fails", async () => {
    await withTempPmPath(async (context) => {
      const target = createSeedItem(context, "compensated-completion");
      expect(
        context.runCli(["claim", target, "--author", "bulk-agent", "--json"])
          .code,
      ).toBe(0);
      const before = await readItem(context.pmPath, target);

      await expect(
        commitItemMutations({
          pmRoot: context.pmPath,
          transactionId: "complete-item-compensate",
          author: "bulk-agent",
          mutations: [
            {
              op: "update",
              id: target,
              options: { comment: ["text=Must roll back"] },
            },
            { op: "close", id: target, reason: "Must roll back" },
            { op: "release", id: target },
            {
              op: "update",
              id: "pm-missing-after-release",
              options: { title: "failure" },
            },
          ],
        }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.NOT_FOUND });

      const restored = await readItem(context.pmPath, target);
      expect(restored.status).toBe("open");
      expect(restored.assignee).toBe(before.assignee);
      expect(restored.claim_principal).toBe(before.claim_principal);
      expect(restored.comments).toEqual(before.comments);
    });
  });

  it("restores a released claim when a later step fails without an intervening close", async () => {
    // Closure now clears the claim itself (pm-8xgg7i), so only a release that is not
    // preceded by a close has ownership effects of its own to compensate.
    await withTempPmPath(async (context) => {
      const target = createSeedItem(context, "compensated-release");
      expect(
        context.runCli(["claim", target, "--author", "bulk-agent", "--json"]).code,
      ).toBe(0);
      const before = await readItem(context.pmPath, target);
      expect(before.claim_principal).toEqual(expect.any(String));

      await expect(
        commitItemMutations({
          pmRoot: context.pmPath,
          transactionId: "release-compensate",
          author: "bulk-agent",
          mutations: [
            { op: "release", id: target },
            { op: "update", id: "pm-missing-after-release", options: { title: "failure" } },
          ],
        }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.NOT_FOUND });

      const restored = await readItem(context.pmPath, target);
      expect(restored.assignee).toBe(before.assignee);
      expect(restored.claim_principal).toBe(before.claim_principal);
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
      ).toMatch(
        new RegExp(
          `^bulk-item-transaction bulk-batch-author 1-update-${updateTarget}-[a-f0-9]{12} apply$`,
          "u",
        ),
      );
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
      await expect(terminalStep.inspect()).resolves.toMatchObject({ state: "applied" });

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
          mutations: [null as unknown as BulkItemMutation],
        }),
      ).rejects.toThrow("must be an object");
      await expect(
        commitItemMutations({
          ...base,
          mutations: [[] as unknown as BulkItemMutation],
        }),
      ).rejects.toThrow("must be an object");
      await expect(
        commitItemMutations({
          ...base,
          mutations: ["update" as unknown as BulkItemMutation],
        }),
      ).rejects.toThrow("must be an object");
      await expect(
        commitItemMutations({
          ...base,
          mutations: [
            { op: "destroy", id: "pm-x" } as unknown as BulkItemMutation,
          ],
        }),
      ).rejects.toThrow("op must be create, update, close, or release");
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
      for (const unique of [null, "k", ["k"], { key: " ", value: 1 }, { key: "k" }, { key: "k", value: null }]) {
        await expect(
          commitItemMutations({
            ...base,
            mutations: [{ op: "create", id: "pm-x", options: { title: "x", type: "Task" }, unique: unique as unknown as BulkItemUniqueKey }],
          }),
        ).rejects.toThrow("unique must be an object with a non-empty key and a value");
      }
      await expect(
        commitItemMutations({
          ...base,
          mutations: [{ op: "update", id: "pm-x", options: { title: "x" }, match: { key: "k" } as unknown as BulkItemUniqueKey }],
        }),
      ).rejects.toThrow("match must be an object with a non-empty key and a value");
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
