/**
 * Write-path parity for the transactional guards and workflow policies:
 * - pm-wb6ktl: a guard or workflow policy that refuses close, delete or restore
 *   cannot wedge a refused batch half-applied; the journal-proven rollback is
 *   judged, recorded, and completed.
 * - pm-womkyw: pm copy is judged by the workflow policies exactly like create.
 * - pm-0m64xk: package imports (and create/copy) fence their write with the
 *   lock lease, and an import re-checks the id under the lock.
 */
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { PmClient } from "../../../../src/sdk/runtime.js";
import { _testOnlyItemTransaction } from "../../../../src/sdk/item-transaction.js";
import { commitImportedItem, runWithActiveExtensions } from "../../../../src/sdk/index.js";
import { activateExtensionForTest, createExtensionTestHarness, runRegisteredMutationGuardForTest } from "../../../../src/sdk/testing.js";
import { runWorkflowPolicyAction } from "../../../../src/sdk/governance/workflow-policy.js";
import { readHistoryEntries } from "../../../../src/core/history/read.js";
import { readSettings, writeSettings } from "../../../../src/core/store/settings.js";
import { getItemPath } from "../../../../src/core/store/paths.js";
import { runWithItemMutationPrecondition } from "../../../../src/core/store/item-mutation-precondition.js";
import { enforceWorkflowMutation } from "../../../../src/core/policy/workflow-policy-store.js";
import { createEmptyExtensionHookRegistry, runActiveBeforeMutationHooks, setActiveExtensionHooks } from "../../../../src/core/extensions/index.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import { writeTestExtension } from "../../../helpers/extensions.js";
import type { TempPmContext } from "../../../helpers/withTempPmPath.js";
import type { ExtensionApi } from "../../../../src/core/extensions/extension-types.js";

interface GuardLogEntry {
  operation: string;
  id: string | undefined;
  compensation: { transaction_id: string; step_id: string } | null;
  frozen: boolean | null;
}

const GUARD_LOG_KEY = "__pmWb6ktlGuardLog";
const SLOW_GATE_KEY = "__pmGuardParitySlowGate";
const SLOW_ENTERED_KEY = "__pmGuardParitySlowEntered";

function guardLog(): GuardLogEntry[] {
  const store = globalThis as unknown as Record<string, GuardLogEntry[] | undefined>;
  store[GUARD_LOG_KEY] ??= [];
  return store[GUARD_LOG_KEY];
}

/** Denies every close, delete and restore; crashes on items titled "Throw"; denies updates titled "Denied update". */
const ROLLBACK_DENYING_GUARD = `export default {
  activate(api) {
    api.hooks.beforeMutation(async (context) => {
      const document = context.after ?? context.before;
      (globalThis.${GUARD_LOG_KEY} ??= []).push({
        operation: context.operation,
        id: document?.metadata.id,
        compensation: context.compensation ?? null,
        frozen: context.compensation ? Object.isFrozen(context.compensation) : null,
      });
      const title = document?.metadata.title ?? "";
      if (context.operation === "update" && context.after?.metadata.title === "Denied update") {
        return { allow: false, code: "update_denied", remediation: "Use another title." };
      }
      if ((context.operation === "create" || context.operation === "import") && title.startsWith("Slow")) {
        // Guards run under the item lock, so entering here proves the slow writer holds it.
        globalThis.${SLOW_ENTERED_KEY}?.();
        await globalThis.${SLOW_GATE_KEY};
      }
      if (!["close", "delete", "restore"].includes(context.operation)) return { allow: true };
      if (title.startsWith("Throw")) throw new Error("guard crashed");
      return { allow: false, code: context.operation + "_denied", remediation: "Never " + context.operation + "." };
    });
  }
};
`;

async function installGuard(context: TempPmContext): Promise<void> {
  await writeTestExtension({
    root: path.join(context.pmPath, "extensions", "rollback-denier"),
    name: "rollback-denier",
    manifestOverrides: { capabilities: ["hooks"] },
    entrySource: ROLLBACK_DENYING_GUARD,
  });
  guardLog().length = 0;
}

/** Close the slow guard's gate, and resolve once a slow writer is inside its guard (holding the item lock). */
function armSlowGuard(): { entered: Promise<void>; open: () => void } {
  const store = globalThis as Record<string, unknown>;
  let open!: () => void;
  store[SLOW_GATE_KEY] = new Promise<void>((resolve) => { open = resolve; });
  const entered = new Promise<void>((resolve) => { store[SLOW_ENTERED_KEY] = resolve; });
  return { entered, open };
}

async function lastEntry(pmPath: string, id: string) {
  return (await readHistoryEntries(path.join(pmPath, "history", `${id}.jsonl`), id)).at(-1)!;
}

describe("transaction rollbacks under refusing guards and policies (pm-wb6ktl)", () => {
  it("completes a close compensation a guard denies, reports the original refusal, and records the override", async () => {
    await withTempPmPath(async (context) => {
      await installGuard(context);
      const client = new PmClient({ pmRoot: context.pmPath, author: "agent-batch" });
      await expect(client.commitItemMutations({
        transactionId: "wb6ktl-close",
        mutations: [
          { op: "create", id: "pm-batch-a", options: { title: "Batch A", type: "Task" } },
          { op: "update", id: "pm-batch-a", options: { title: "Denied update" } },
        ],
      })).rejects.toMatchObject({ code: "update_denied" });

      await expect(client.get("pm-batch-a")).resolves.toMatchObject({ item: { status: "closed" } });
      const entry = await lastEntry(context.pmPath, "pm-batch-a");
      expect(entry.op).toBe("close");
      expect(entry.context).toMatchObject({
        transaction_compensation: {
          transaction_id: "wb6ktl-close",
          step_id: expect.any(String),
          overridden: [{ source: "mutation_guard", guard: expect.stringContaining("rollback-denier"), code: "close_denied" }],
        },
      });
      const judged = guardLog().filter((logged) => logged.operation === "close");
      expect(judged).toEqual([{ operation: "close", id: "pm-batch-a", compensation: { transaction_id: "wb6ktl-close", step_id: (entry.context as { transaction_compensation: { step_id: string } }).transaction_compensation.step_id }, frozen: true }]);
    });
  });

  it("completes delete and restore compensations, and records a crashing guard as an override", async () => {
    await withTempPmPath(async (context) => {
      await installGuard(context);
      const client = new PmClient({ pmRoot: context.pmPath, author: "agent-batch" });
      await expect(client.commitItemMutations({
        transactionId: "wb6ktl-delete",
        createCompensation: "delete",
        mutations: [
          { op: "create", id: "pm-batch-d", options: { title: "Batch D", type: "Task" } },
          { op: "update", id: "pm-batch-d", options: { title: "Denied update" } },
        ],
      })).rejects.toMatchObject({ code: "update_denied" });
      await expect(client.get("pm-batch-d")).rejects.toMatchObject({ exitCode: 3 });
      expect((await lastEntry(context.pmPath, "pm-batch-d")).context).toMatchObject({
        transaction_compensation: { overridden: [{ source: "mutation_guard", code: "delete_denied" }] },
      });

      await client.create({ id: "pm-existing", title: "Existing title", type: "Task" });
      await client.create({ id: "pm-other", title: "Other", type: "Task" });
      await expect(client.commitItemMutations({
        transactionId: "wb6ktl-restore",
        mutations: [
          { op: "update", id: "pm-existing", options: { title: "Batch title" } },
          { op: "update", id: "pm-other", options: { title: "Denied update" } },
        ],
      })).rejects.toMatchObject({ code: "update_denied" });
      await expect(client.get("pm-existing")).resolves.toMatchObject({ item: { title: "Existing title" } });
      const restored = await lastEntry(context.pmPath, "pm-existing");
      expect(restored.op).toBe("restore");
      expect(restored.context).toMatchObject({
        transaction_compensation: { transaction_id: "wb6ktl-restore", overridden: [{ source: "mutation_guard", code: "restore_denied" }] },
      });

      await expect(client.commitItemMutations({
        transactionId: "wb6ktl-throw",
        mutations: [
          { op: "create", id: "pm-batch-t", options: { title: "Throw T", type: "Task" } },
          { op: "update", id: "pm-batch-t", options: { title: "Denied update" } },
        ],
      })).rejects.toMatchObject({ code: "update_denied" });
      // The crashing guard judged the rollback against the proposed (pre-update) title, so it threw rather than denied.
      expect((await lastEntry(context.pmPath, "pm-batch-t")).context).toMatchObject({
        transaction_compensation: { overridden: [{ source: "mutation_guard", code: "extension_mutation_guard_failed" }] },
      });
    });
  });

  it("records a workflow policy that refuses closing instead of wedging the rollback", async () => {
    await withTempPmPath(async (context) => {
      const global = { path: context.pmPath };
      await runWorkflowPolicyAction("policy-put", "release-close", { definition: {
        id: "release-close", description: "Only the release manager closes work.", effect: "refuse",
        subject: { statuses: ["closed"] }, rule: { kind: "authors", authors: ["release-manager"] },
      } }, global);
      await runWorkflowPolicyAction("policy-mode", "refuse", {}, global);
      const client = new PmClient({ pmRoot: context.pmPath, author: "agent-batch", noExtensions: true });
      // The same policy refuses an ordinary close by the batch author.
      await client.create({ id: "pm-ordinary", title: "Ordinary", type: "Task" });
      await expect(client.close("pm-ordinary", "Done")).rejects.toMatchObject({ code: "workflow_policy_refused" });

      await expect(client.commitItemMutations({
        transactionId: "wb6ktl-policy",
        mutations: [
          { op: "create", id: "pm-batch-p", options: { title: "Batch P", type: "Task" } },
          { op: "update", id: "pm-missing", options: { title: "Never applied" } },
        ],
      })).rejects.toMatchObject({ exitCode: 3 });
      await expect(client.get("pm-batch-p")).resolves.toMatchObject({ item: { status: "closed" } });
      expect((await lastEntry(context.pmPath, "pm-batch-p")).context).toMatchObject({
        workflow_policies: [{ policy_id: "release-close", satisfied: false, effect: "refuse" }],
        transaction_compensation: { transaction_id: "wb6ktl-policy", overridden: [{ source: "workflow_policy", policy_id: "release-close", rule: "authors" }] },
      });
      // A dry-run evaluation inside a rollback scope is never exempted.
      const before = (await client.get("pm-ordinary")).item;
      const settings = await readSettings(context.pmPath);
      await expect(runWithItemMutationPrecondition({
        pmRoot: context.pmPath, id: "pm-ordinary", validate: () => {},
        compensation: { transaction_id: "scoped", step_id: "step", operations: ["close"], overrides: [] },
      }, () => enforceWorkflowMutation({
        pmRoot: context.pmPath, settings, operation: "close", author: "agent-batch",
        before: { metadata: before, body: "" }, after: { metadata: { ...before, status: "closed" }, body: "" }, dryRun: true,
      }))).rejects.toMatchObject({ code: "workflow_policy_refused" });
    });
  });

  it("judges an unowned write inside a rollback scope, and an ordinary close, as normal mutations", async () => {
    await withTempPmPath(async (context) => {
      await installGuard(context);
      const client = new PmClient({ pmRoot: context.pmPath, author: "agent-batch" });
      await client.create({ id: "pm-owned", title: "Owned", type: "Task" });
      await client.create({ id: "pm-unowned", title: "Unowned", type: "Task" });
      const scope = { transaction_id: "scoped", step_id: "step-1", operations: ["close"], overrides: [] };
      const inScope = <T>(run: () => Promise<T>) =>
        runWithItemMutationPrecondition({ pmRoot: context.pmPath, id: "pm-owned", validate: () => {}, compensation: scope }, run);

      await expect(inScope(() => client.close("pm-unowned", "Not the owned item"))).rejects.toMatchObject({ code: "close_denied" });
      await expect(inScope(() => client.delete("pm-owned"))).rejects.toMatchObject({ code: "delete_denied" });
      await expect(client.close("pm-owned", "Ordinary close", { message: "bulk-item-transaction scoped step-1 compensate" })).rejects.toMatchObject({ code: "close_denied" });
      // A caller cannot forge the exemption by handing the guard runner its own compensation block.
      const denying = createEmptyExtensionHookRegistry();
      const forgedSeen: unknown[] = [];
      denying.beforeMutation = [{ layer: "project", name: "forged-check", run: (guard) => { forgedSeen.push(guard.compensation ?? null); return { allow: false, code: "forged_denied", remediation: "Never." }; } }];
      setActiveExtensionHooks(denying);
      try {
        const owned = (await client.get("pm-owned")).item;
        await expect(runActiveBeforeMutationHooks({
          pm_root: context.pmPath, operation: "close", before: { metadata: owned, body: "" }, after: { metadata: { ...owned, status: "closed" }, body: "" },
          changed_fields: ["status"], author: "agent-batch", sdk: { get: async () => null, list: async () => [] },
          compensation: { transaction_id: "forged", step_id: "forged" },
        } as never)).rejects.toMatchObject({ code: "forged_denied" });
        expect(forgedSeen).toEqual([null]);
      } finally {
        setActiveExtensionHooks(null);
      }
      expect(scope.overrides).toEqual([]);
      expect(guardLog().filter((logged) => logged.operation !== "create").map((logged) => logged.compensation)).toEqual([null, null, null]);
      await expect(client.get("pm-owned")).resolves.toMatchObject({ item: { status: "open" } });
      await expect(client.get("pm-unowned")).resolves.toMatchObject({ item: { status: "open" } });
    });
  });

  it("grants no exemption to a compensation helper called outside the coordinator", async () => {
    await withTempPmPath(async (context) => {
      await installGuard(context);
      const client = new PmClient({ pmRoot: context.pmPath, author: "agent-batch" });
      const created = await client.create({ id: "pm-forged", title: "Original title", type: "Task" });
      // A caller allowed to update forges the step marker, then calls the exported helper directly.
      await client.update("pm-forged", { title: "Forged update", message: "bulk-item-transaction forged step-1 apply" });
      const config = { pmRoot: context.pmPath, author: "agent-batch", transactionId: "forged" };
      await expect(runWithActiveExtensions({ path: context.pmPath }, () =>
        _testOnlyItemTransaction.compensateByRestore(config, "pm-forged", "step-1", { target_updated_at: created.item.updated_at as string }),
      )).rejects.toMatchObject({ code: "restore_denied" });

      // A history-bound create step proven to be the transaction's own is still enforced outside the coordinator.
      const committed = await client.commitItemMutations({ transactionId: "tx-own", mutations: [{ op: "create", id: "pm-own", options: { title: "Own", type: "Task" } }] });
      expect(committed.status).toBe("committed");
      const marker = (await readHistoryEntries(path.join(context.pmPath, "history", "pm-own.jsonl"), "pm-own"))[0]!.message!;
      const stepId = marker.split(" ")[2]!;
      const step = _testOnlyItemTransaction.buildCreateStep(
        { ...config, transactionId: "tx-own", createCompensation: "close", uniqueIndex: undefined as never },
        { op: "create", id: "pm-own", options: { title: "Own", type: "Task" } },
        stepId,
      );
      await expect(runWithActiveExtensions({ path: context.pmPath }, () => step.compensate())).rejects.toMatchObject({ code: "close_denied" });
      await expect(client.get("pm-own")).resolves.toMatchObject({ item: { status: "open" } });
      await expect(client.get("pm-forged")).resolves.toMatchObject({ item: { title: "Forged update" } });
    });
  });

  it("binds the exemption to the validated storage identity, never to a proposed id", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath, author: "agent-batch", noExtensions: true });
      const owned = (await client.create({ id: "pm-scope-a", title: "Scoped A", type: "Task" })).item;
      const other = (await client.create({ id: "pm-scope-b", title: "Other B", type: "Task" })).item;
      const denying = createEmptyExtensionHookRegistry();
      denying.beforeMutation = [{ layer: "project", name: "identity-check", run: () => ({ allow: false, code: "identity_denied", remediation: "Never." }) }];
      const judge = (before: typeof owned, afterId: string) => runActiveBeforeMutationHooks({
        pm_root: context.pmPath, operation: "close", before: { metadata: before, body: "" }, after: { metadata: { ...before, id: afterId, status: "closed" }, body: "" },
        changed_fields: ["status"], author: "agent-batch", sdk: { get: async () => null, list: async () => [] },
      });
      const unvalidated = { transaction_id: "scoped", step_id: "step", operations: ["close"], overrides: [] };
      const validated = { ...unvalidated, overrides: [], validated_storage_id: "pm-scope-a" };
      setActiveExtensionHooks(denying);
      try {
        // Without a passed ownership proof for the locked item, the scope grants nothing.
        await expect(runWithItemMutationPrecondition({ pmRoot: context.pmPath, id: "pm-scope-a", validate: () => {}, compensation: unvalidated },
          () => judge(owned, "pm-scope-a"))).rejects.toMatchObject({ code: "identity_denied" });
        // A write to B that proposes A's id cannot borrow A's validated rollback.
        await expect(runWithItemMutationPrecondition({ pmRoot: context.pmPath, id: "pm-scope-a", validate: () => {}, compensation: validated },
          () => judge(other, "pm-scope-a"))).rejects.toMatchObject({ code: "identity_denied" });
        expect(validated.overrides).toEqual([]);
        // The validated write to A itself is the rollback, and its denial is recorded.
        await runWithItemMutationPrecondition({ pmRoot: context.pmPath, id: "pm-scope-a", validate: () => {}, compensation: validated }, () => judge(owned, "pm-scope-a"));
        expect(validated.overrides).toEqual([{ source: "mutation_guard", guard: "project:identity-check", code: "identity_denied" }]);
      } finally {
        setActiveExtensionHooks(null);
      }
    });
  });

  it("lets a package test observe a guard's rollback branch through runRegisteredMutationGuardForTest", async () => {
    const seen: unknown[] = [];
    const guardModule = {
      activate(api: ExtensionApi) {
        api.hooks.beforeMutation((guard) => {
          seen.push(guard.compensation ?? null);
          return { allow: false, code: "always_denied", remediation: "Never." };
        });
      },
    };
    const activation = await activateExtensionForTest(guardModule, { capabilities: ["hooks"] });
    const harness = await createExtensionTestHarness(guardModule, { capabilities: ["hooks"] });
    const base = {
      pm_root: "/tracker", operation: "close", before: null, after: null, changed_fields: [],
      sdk: { get: async () => null, list: async () => [] },
    };
    await expect(runRegisteredMutationGuardForTest(activation.hooks, { context: base })).rejects.toMatchObject({ code: "always_denied" });
    await expect(runRegisteredMutationGuardForTest(activation.hooks, { context: { ...base, compensation: { transaction_id: "t", step_id: "s" } } }))
      .resolves.toEqual([{ guard: expect.stringContaining(":"), code: "always_denied" }]);
    await expect(harness.runMutationGuard({ context: { ...base, compensation: { transaction_id: "t", step_id: "s" } } })).resolves.toHaveLength(1);
    const allowing = await createExtensionTestHarness({ activate(api: ExtensionApi) { api.hooks.beforeMutation(() => ({ allow: true })); } }, { capabilities: ["hooks"] });
    await expect(allowing.runMutationGuard({ context: base })).resolves.toBeUndefined();
    await expect(allowing.runMutationGuard({ context: { ...base, compensation: { transaction_id: "t", step_id: "s" } } })).resolves.toEqual([]);
    expect(seen).toEqual([null, { transaction_id: "t", step_id: "s" }, { transaction_id: "t", step_id: "s" }]);
    // As on a host, a dry run is never exempted: the guard sees no compensation and its denial refuses.
    await expect(runRegisteredMutationGuardForTest(activation.hooks, { context: { ...base, dry_run: true, compensation: { transaction_id: "t", step_id: "s" } } }))
      .rejects.toMatchObject({ code: "always_denied" });
    expect(seen.at(-1)).toBeNull();
    // A guard that throws its own code-less typed error during a rollback is recorded as a guard failure.
    const codeless = await createExtensionTestHarness({ activate(api: ExtensionApi) { api.hooks.beforeMutation(() => { throw new PmCliError("Guard storage unavailable", 4); }); } }, { capabilities: ["hooks"] });
    await expect(codeless.runMutationGuard({ context: base })).rejects.toThrow("Guard storage unavailable");
    await expect(codeless.runMutationGuard({ context: { ...base, compensation: { transaction_id: "t", step_id: "s" } } }))
      .resolves.toEqual([{ guard: expect.any(String), code: "extension_mutation_guard_failed" }]);
  });
});

describe("pm copy under workflow policies (pm-womkyw)", () => {
  it("refuses a copy that create would refuse and records the decisions on an accepted copy", async () => {
    await withTempPmPath(async (context) => {
      const global = { path: context.pmPath };
      const allowed = new PmClient({ pmRoot: context.pmPath, author: "agent-allowed", noExtensions: true });
      const other = new PmClient({ pmRoot: context.pmPath, author: "agent-other", noExtensions: true });
      const source = await allowed.create({ title: "Copy source", type: "Task" });
      await runWorkflowPolicyAction("policy-put", "creators", { definition: {
        id: "creators", description: "Only allowed agents create work.", effect: "refuse",
        subject: { operations: ["create"] }, rule: { kind: "authors", authors: ["agent-allowed"] },
      } }, global);
      await runWorkflowPolicyAction("policy-mode", "refuse", {}, global);

      await expect(other.create({ title: "Direct create", type: "Task" })).rejects.toMatchObject({ code: "workflow_policy_refused" });
      await expect(other.copy(source.item.id, { title: "Copied by another agent" })).rejects.toMatchObject({
        code: "workflow_policy_refused",
        context: { policy_violations: [{ policy_id: "creators", rule: "authors" }] },
      });
      expect((await allowed.list({})).items.map((item) => item.title)).toEqual(["Copy source"]);

      const copied = await allowed.copy(source.item.id, { title: "Copied by the allowed agent" });
      const entry = await lastEntry(context.pmPath, copied.item.id);
      expect(entry).toMatchObject({ op: "create", context: { workflow_policies: [{ policy_id: "creators", satisfied: true }] } });
    });
  });
});

describe("lease-fenced import, create and copy writes (pm-0m64xk)", () => {
  function importDocument(id: string, title: string) {
    return {
      metadata: { id, title, description: "", type: "Task", status: "open", priority: 2, tags: [], created_at: "2026-11-16T00:00:00.000Z", updated_at: "2026-11-16T00:00:00.000Z" },
      body: "",
    };
  }

  it("skips an id a concurrent importer committed after the caller's existence check", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      const importOne = (title: string) => commitImportedItem({
        pmRoot: context.pmPath, id: "pm-dup", itemPath: getItemPath(context.pmPath, "Task", "pm-dup", "toon"),
        document: importDocument("pm-dup", title) as never, author: "agent-importer", message: "Import", settings,
        conflictWarningPrefix: "parity_import_lock_conflict",
      });
      await expect(importOne("First import")).resolves.toMatchObject({ committed: true });
      await expect(importOne("Second import")).resolves.toEqual({ committed: false, conflictWarning: "parity_import_lock_conflict:pm-dup" });
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      await expect(client.get("pm-dup")).resolves.toMatchObject({ item: { title: "First import" } });
      expect((await readHistoryEntries(path.join(context.pmPath, "history", "pm-dup.jsonl"), "pm-dup")).map((entry) => entry.op)).toEqual(["import"]);
    });
  });

  it("refuses an import whose lease was taken over during a slow guard, keeping the other importer's write", async () => {
    await withTempPmPath(async (context) => {
      await installGuard(context);
      const settings = await readSettings(context.pmPath);
      settings.locks.ttl_seconds = 1;
      settings.governance.force_required_for_stale_lock = false;
      const gate = armSlowGuard();
      const importAs = (title: string, author: string) => runWithActiveExtensions({ path: context.pmPath }, () => commitImportedItem({
        pmRoot: context.pmPath, id: "pm-race", itemPath: getItemPath(context.pmPath, "Task", "pm-race", "toon"),
        document: importDocument("pm-race", title) as never, author, message: "Import", settings,
        conflictWarningPrefix: "parity_import_lock_conflict",
      }));
      const slow = importAs("Slow import", "agent-slow").catch((error: unknown) => error);
      // The TTL runs from lock creation, which precedes the guard: wait it out only once the lock is provably held.
      await gate.entered;
      await sleep(1_200);
      await expect(importAs("Fast import", "agent-fast")).resolves.toMatchObject({ committed: true });
      gate.open();
      await expect(slow).resolves.toMatchObject({ code: "lock_lost" });
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      await expect(client.get("pm-race")).resolves.toMatchObject({ item: { title: "Fast import" } });
      const history = await readHistoryEntries(path.join(context.pmPath, "history", "pm-race.jsonl"), "pm-race");
      expect(history.map((entry) => [entry.op, entry.author])).toEqual([["import", "agent-fast"]]);
    });
  });

  it("refuses a create whose lease was taken over during a slow guard instead of overwriting the newer item", async () => {
    await withTempPmPath(async (context) => {
      await installGuard(context);
      const settings = await readSettings(context.pmPath);
      settings.locks.ttl_seconds = 1;
      settings.governance.force_required_for_stale_lock = false;
      await writeSettings(context.pmPath, settings);
      const gate = armSlowGuard();
      const slowClient = new PmClient({ pmRoot: context.pmPath, author: "agent-slow" });
      const fastClient = new PmClient({ pmRoot: context.pmPath, author: "agent-fast" });
      const slow = slowClient.create({ id: "pm-race-create", title: "Slow create", type: "Task" }).catch((error: unknown) => error);
      await gate.entered;
      await sleep(1_200);
      await expect(fastClient.create({ id: "pm-race-create", title: "Fast create", type: "Task" })).resolves.toMatchObject({ item: { title: "Fast create" } });
      gate.open();
      await expect(slow).resolves.toMatchObject({ code: "lock_lost" });
      await expect(fastClient.get("pm-race-create")).resolves.toMatchObject({ item: { title: "Fast create" } });
      const history = await readHistoryEntries(path.join(context.pmPath, "history", "pm-race-create.jsonl"), "pm-race-create");
      expect(history.map((entry) => entry.author)).toEqual(["agent-fast"]);
    });
  });
});
