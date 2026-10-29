import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PmClient, WorkspaceTransactionInterruptedError, runWithActiveExtensions, runWorkspaceTransactionGc, type BulkItemMutation } from "../../../../src/sdk/index.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const stopAfterApply = ({ transition }: { transition: string }) => {
  if (transition === "step_applied") throw new WorkspaceTransactionInterruptedError("Interrupted after durable apply");
};

describe("host-bound item batches and recovery (pm-gh1597, pm-gh1598)", () => {
  it("returns canonical final staged records and honors root and author over untyped overrides", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const client = new PmClient({ pmRoot: pmPath, author: "bound-actor", noExtensions: true });
      const mutations: BulkItemMutation[] = [
        { op: "create", id: "staged", options: { title: "Staged", type: "Task", body: "# Body", tags: "B,a", author: "wrong" } },
        { op: "update", id: "staged", options: { description: "Canonical update", comment: ["text=Evidence"] } },
      ];
      const input = { transactionId: "canonical", mutations, pmRoot: "/not-the-host", author: "wrong" };
      const preview = await client.previewItemMutations(input);
      expect(preview).toMatchObject({ validated: true, state: "staged_snapshot" });
      expect(preview.records).toHaveLength(2);
      expect(preview.records[0]).toMatchObject({ index: 0, id: "pm-staged", op: "create", execution: "applied", item: { body: "# Body", tags: ["a", "b"], author: "bound-actor" } });
      expect(preview.records[0].commit_time_fields).toContain("/created_at");
      await expect(client.get("staged")).rejects.toThrow();
      expect(await client.itemTransactions.status("canonical")).toBeUndefined();
      await client.commitItemMutations(input);
      expect((await client.get("staged", { full: true })).item).toEqual(preview.records[1].item);
      const historyPath = path.join(pmPath, "history", "pm-staged.jsonl");
      const history = await readFile(historyPath, "utf8");
      expect((await client.commitItemMutations(input)).recovered).toBe(true);
      expect(await readFile(historyPath, "utf8")).toBe(history);
      expect(await client.previewItemMutations(input)).toMatchObject({ validated: false, state: "replayed_committed_plan", records: [] });
      await expect(client.commitItemMutations({ ...input, mutations: [{ op: "update", id: "staged", options: { title: "Changed intent" } }] })).rejects.toMatchObject({ context: { code: "transaction_plan_mismatch", nextSteps: expect.arrayContaining([expect.stringContaining("client.itemTransactions.abandon")]) } });
      await expect(client.itemTransactions.abandon("canonical", { reason: "Cannot undo completed work" })).rejects.toMatchObject({ context: { code: "transaction_committed" } });
    });
  });

  it.each(["prepared", "step_applied", "step_recorded"])("retires interrupted updates from %s, audits once and permits a separately planned replacement", async transition => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, author: "recovery-actor", noExtensions: true });
      const original = (await client.create({ title: "Original", type: "Task" })).item;
      const options = { transactionId: " retired ", mutations: [{ op: "update", id: original.id, options: { title: "Forward" } }] satisfies BulkItemMutation[] };
      await expect(client.commitItemMutations({ ...options, onTransition: event => { if (event.transition === transition) throw new WorkspaceTransactionInterruptedError("Crash"); } })).rejects.toThrow("Crash");
      const before = await client.itemTransactions.status("retired");
      expect(before?.journal.status).toBe("applying");
      expect(before?.planDigest).toMatch(/^[a-f0-9]{64}$/u);
      const retired = await client.itemTransactions.supersede("retired", "replacement", { reason: "Re-plan against current state" });
      expect(retired.journal).toMatchObject({ schemaVersion: 2, status: "abandoned", startedStepIds: [], completedStepIds: [], abandonment: { author: "recovery-actor", supersededBy: "replacement" } });
      expect((await client.get(original.id)).item.title).toBe("Original");
      const journalBytes = await readFile(path.join(pmPath, "transactions", "sdk", "retired.json"), "utf8");
      await client.itemTransactions.supersede("retired", "replacement", { reason: "Retry request" });
      expect(await readFile(path.join(pmPath, "transactions", "sdk", "retired.json"), "utf8")).toBe(journalBytes);
      await expect(client.commitItemMutations(options)).rejects.toMatchObject({ message: "Transaction retired has been abandoned", context: { code: "transaction_abandoned", required: "Use a new transactionId for the replacement plan." } });
      await expect(client.commitItemMutations({ ...options, mutations: [{ op: "update", id: original.id, options: { title: "Forbidden replan" } }] })).rejects.toMatchObject({ context: { code: "transaction_abandoned" } });
      expect((await client.get(original.id)).item.title).toBe("Original");
      await expect(client.itemTransactions.abandon("retired", { reason: "Different replacement" })).rejects.toMatchObject({ context: { code: "transaction_abandoned" } });
      await client.commitItemMutations({ ...options, transactionId: "replacement", mutations: [{ op: "update", id: original.id, options: { title: "Replanned" } }] });
      expect((await client.get(original.id)).item.title).toBe("Replanned");
    });
  });

  it.each(["update", "create"] as const)("retains peer edits and recovery receipts for interrupted %s", async op => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      if (op === "update") await client.create({ id: "peer", title: "Original", type: "Task" });
      await expect(client.commitItemMutations({ transactionId: "peer", createCompensation: "delete", mutations: [{ op, id: "peer", options: { title: "Forward", type: "Task" } }], onTransition: stopAfterApply })).rejects.toThrow("Interrupted");
      await client.comments("peer", { add: "Peer evidence must survive" });
      await expect(client.itemTransactions.abandon("peer", { reason: "Recover" })).rejects.toMatchObject({ context: { code: "transaction_partial_mutation" } });
      expect((await client.get("peer", { full: true })).item).toMatchObject({ title: "Forward", comments: [expect.objectContaining({ text: "Peer evidence must survive" })] });
      expect((await client.itemTransactions.status("peer"))?.journal.status).toBe("compensating");
    });
  });

  it.each(["close", "delete"] as const)("compensates owned creations using the recorded %s policy", async createCompensation => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      await expect(client.commitItemMutations({ transactionId: "create", createCompensation, mutations: [{ op: "create", id: "created", options: { title: "Owned", type: "Task" } }], onTransition: stopAfterApply })).rejects.toThrow("Interrupted");
      expect((await client.itemTransactions.abandon("create", { reason: "Retire" })).journal.status).toBe("abandoned");
      if (createCompensation === "close") expect((await client.get("created")).item.status).toBe("closed");
      else await expect(client.get("created")).rejects.toThrow();
    });
  });

  it("refuses missing, malformed and legacy plans without retiring recovery state", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      await expect(client.itemTransactions.abandon("missing", { reason: "Absent" })).rejects.toThrow("not found");
      await expect(client.itemTransactions.supersede("same", "same", { reason: "Bad replacement" })).rejects.toThrow("must differ");
      await expect(client.itemTransactions.abandon("id", { reason: " " })).rejects.toThrow("non-empty");
      await client.create({ id: "original", title: "Original", type: "Task" });
      await expect(client.commitItemMutations({ transactionId: "legacy", mutations: [{ op: "update", id: "original", options: { title: "Forward" } }], onTransition: stopAfterApply })).rejects.toThrow("Interrupted");
      const journalPath = path.join(pmPath, "transactions", "sdk", "legacy.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      delete journal.recoveryData;
      await writeFile(journalPath, JSON.stringify(journal));
      await expect(client.itemTransactions.abandon("legacy", { reason: "No plan" })).rejects.toMatchObject({ context: { code: "transaction_recovery_plan_missing" } });
      expect((await client.itemTransactions.status("legacy"))?.journal.status).toBe("applying");
      await writeFile(journalPath, "{");
      await expect(client.itemTransactions.status("legacy")).rejects.toMatchObject({ context: { code: "transaction_journal_invalid" } });
    });
  });
  it("inherits active extension hosts and resolves cwd-bound clients", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot }) => {
      await runWithActiveExtensions({ path: pmPath, noExtensions: true }, async () => {
        const client = PmClient.forActiveExtensionHost({ pmRoot: pmPath, author: "extension-host" });
        await client.commitItemMutations({ transactionId: "host", mutations: [{ op: "create", id: "host", options: { title: "Host", type: "Task" } }] });
        expect((await client.itemTransactions.status("host"))?.journal.author).toBe("extension-host");
      });
      const client = new PmClient({ cwd: tempRoot, pmRoot: pmPath, noExtensions: true });
      expect((await client.itemTransactions.status("host"))?.journal.status).toBe("committed");
    });
  });

  it.each(["close", "delete"] as const)("resumes an interrupted %s compensation and refuses an already-used replacement id", async createCompensation => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const options = { transactionId: "compensation", createCompensation, mutations: [{ op: "create", id: "compensated", options: { title: "Owned", type: "Task" } }] satisfies BulkItemMutation[], onTransition: stopAfterApply };
      await expect(client.commitItemMutations(options)).rejects.toThrow("Interrupted");
      const fsUtils = await import("../../../../src/core/fs/fs-utils.js");
      const write = fsUtils.writeFileAtomic;
      vi.spyOn(fsUtils, "writeFileAtomic").mockImplementation(async (...args) => {
        if (args[0] === path.join(pmPath, "transactions", "sdk", "compensation.json")) {
          const receipt = JSON.parse(String(args[1]));
          if (receipt.status === "compensating" && receipt.startedStepIds.length === 0) throw new Error("Stop compensation");
        }
        return write(...args);
      });
      await expect(client.itemTransactions.abandon("compensation", { reason: "Retire" })).rejects.toThrow("Stop compensation");
      vi.restoreAllMocks();
      expect((await client.itemTransactions.status("compensation"))?.journal.schemaVersion).toBe(2);
      await expect(client.itemTransactions.supersede("compensation", "wrong-replacement", { reason: "Wrong retry" })).rejects.toMatchObject({ message: "Transaction compensation retirement is incomplete", context: { code: "transaction_abandoned", required: expect.stringContaining("without supersededBy"), retirement: { state: "pending", superseded_by: null } } });
      if (createCompensation === "close") await client.reopen("compensated", "Peer reopens after completed compensation");
      await expect(client.commitItemMutations({ ...options, mutations: [{ op: "create", id: "compensated", options: { title: "Forbidden replan", type: "Task" } }] })).rejects.toMatchObject({ context: { code: "transaction_abandoned", retirement: { state: "pending", superseded_by: null } } });
      expect((await client.itemTransactions.abandon("compensation", { reason: "Resume retirement" })).journal.status).toBe("abandoned");
      if (createCompensation === "close") expect((await client.get("compensated")).item.status).toBe("open");
      await client.create({ id: "later", title: "Later", type: "Task" });
      await expect(client.commitItemMutations({ transactionId: "later", mutations: [{ op: "update", id: "later", options: { title: "Forward" } }], onTransition: stopAfterApply })).rejects.toThrow("Interrupted");
      await expect(client.itemTransactions.supersede("later", "compensation", { reason: "Already used" })).rejects.toThrow("already exists");
    });
  });

  it("retains the original plan on mismatch and deduplicates audit after a final journal write fails", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      await client.create({ id: "audit", title: "Original", type: "Task" });
      await expect(client.commitItemMutations({ transactionId: "audit", mutations: [{ op: "update", id: "audit", options: { title: "Forward" } }], onTransition: stopAfterApply })).rejects.toThrow("Interrupted");
      const file = path.join(pmPath, "transactions", "sdk", "audit.json");
      const original = await readFile(file, "utf8");
      const corrupt = JSON.parse(original);
      corrupt.recoveryData.mutations[0].options.title = "Wrong plan";
      await writeFile(file, JSON.stringify(corrupt));
      await expect(client.itemTransactions.abandon("audit", { reason: "Mismatch" })).rejects.toMatchObject({ context: { code: "transaction_plan_mismatch" } });
      await writeFile(file, original);
      const fsUtils = await import("../../../../src/core/fs/fs-utils.js");
      const write = fsUtils.writeFileAtomic;
      vi.spyOn(fsUtils, "writeFileAtomic").mockImplementation(async (...args) => {
        if (args[0] === file && String(args[1]).includes('"status": "abandoned"')) throw new Error("Final journal write failed");
        return write(...args);
      });
      await expect(client.itemTransactions.supersede("audit", "audit-replacement", { reason: "Retire" })).rejects.toThrow("Final journal write failed");
      vi.restoreAllMocks();
      const auditPath = path.join(pmPath, "history", "_workspace.jsonl");
      const audit = await readFile(auditPath, "utf8");
      const pendingJournal = await readFile(file, "utf8");
      await expect(client.itemTransactions.abandon("audit", { reason: "Wrong retry" })).rejects.toMatchObject({ message: "Transaction audit retirement is incomplete", context: { code: "transaction_abandoned", required: expect.stringContaining('supersededBy "audit-replacement"'), retirement: { state: "pending", superseded_by: "audit-replacement" } } });
      expect(await readFile(file, "utf8")).toBe(pendingJournal);
      await expect(client.commitItemMutations({ transactionId: "audit", mutations: [{ op: "update", id: "audit", options: { title: "Forward" } }] })).rejects.toMatchObject({ context: { code: "transaction_abandoned" } });
      const collected = await runWorkspaceTransactionGc(pmPath, { dryRun: true, retentionDays: 0, now: Date.now() + 86400000 });
      expect(collected.retained).toContain("transactions/sdk/audit.json");
      await client.commitItemMutations({ transactionId: "audit-replacement", mutations: [{ op: "update", id: "audit", options: { title: "Replacement" } }] });
      expect((await client.itemTransactions.supersede("audit", "audit-replacement", { reason: "Retry with another explanation" })).journal.abandonment?.reason).toBe("Retire");
      expect(await readFile(auditPath, "utf8")).toBe(audit);
      expect((await client.get("audit")).item.title).toBe("Replacement");
    });
  });

  it("identifies adopted values and returns final staged state for repeated targets", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      await client.create({ id: "existing", title: "Existing", type: "Task" });
      const input = { transactionId: "adopt", mutations: [
        { op: "create", id: "existing", options: { title: "Unused create input", type: "Task" } },
        { op: "update", id: "existing", options: { title: "Final value" } },
      ] satisfies BulkItemMutation[] };
      const preview = await client.previewItemMutations(input);
      expect(preview.records.map(row => [row.execution, row.item.title])).toEqual([["adopted", "Final value"], ["applied", "Final value"]]);
      expect((await client.get("existing")).item.title).toBe("Existing");
    });
  });

  it.each(["close", "delete"] as const)("refuses a peer edit at the item-lock boundary of create %s compensation", async createCompensation => {
    await withTempPmPath(async context => {
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      await expect(client.commitItemMutations({ transactionId: "late-peer", createCompensation, mutations: [{ op: "create", id: "created", options: { title: "Created", type: "Task" } }], onTransition: stopAfterApply })).rejects.toThrow("Interrupted");
      const locks = await import("../../../../src/core/lock/lock.js");
      const acquire = locks.acquireLockLease;
      let peerWrote = false;
      vi.spyOn(locks, "acquireLockLease").mockImplementation(async (...args) => {
        if (args[0] === context.pmPath && args[1] === "pm-created" && !peerWrote) {
          peerWrote = true;
          expect(context.runCli(["update", "pm-created", "--description", "Late peer", "--json"]).code).toBe(0);
        }
        return acquire(...args);
      });
      await expect(client.itemTransactions.abandon("late-peer", { reason: "Retire" })).rejects.toMatchObject({ context: { code: "transaction_partial_mutation" } });
      expect(peerWrote).toBe(true);
      expect((await client.get("created")).item).toMatchObject({ status: "open", description: "Late peer" });
    });
  });

  it("rejects malformed retirement receipts instead of certifying an abandoned identity", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      await expect(client.commitItemMutations({ transactionId: "invalid-retirement", mutations: [{ op: "create", id: "created", options: { title: "Created", type: "Task" } }], onTransition: stopAfterApply })).rejects.toThrow("Interrupted");
      const file = path.join(pmPath, "transactions", "sdk", "invalid-retirement.json");
      const journal = JSON.parse(await readFile(file, "utf8"));
      for (const abandonment of [null, {}, { reason: "", author: "actor" }, { reason: "Reason", author: "" }, { reason: "Reason", author: "actor", supersededBy: "../bad" }, { reason: "Reason", author: "actor", supersededBy: "invalid-retirement" }]) {
        await writeFile(file, JSON.stringify({ ...journal, schemaVersion: 2, abandonment }));
        await expect(client.itemTransactions.status("invalid-retirement")).rejects.toMatchObject({ context: { code: "transaction_journal_invalid" } });
      }
      await writeFile(file, JSON.stringify({ ...journal, schemaVersion: 2, status: "committed", completedStepIds: journal.stepIds, abandonment: { reason: "Invalid retirement", author: "actor" } }));
      await expect(client.itemTransactions.status("invalid-retirement")).rejects.toMatchObject({ context: { code: "transaction_journal_invalid" } });
      await writeFile(file, JSON.stringify({ ...journal, schemaVersion: 1, abandonment: { reason: "Downgraded retirement", author: "actor" } }));
      await expect(client.itemTransactions.status("invalid-retirement")).rejects.toMatchObject({ context: { code: "transaction_journal_invalid" } });
      await writeFile(file, JSON.stringify({ ...journal, status: "abandoned", startedStepIds: [], completedStepIds: [], compensationData: {} }));
      await expect(client.itemTransactions.status("invalid-retirement")).rejects.toMatchObject({ context: { code: "transaction_journal_invalid" } });
    });
  });

  it("retains admitted intent when caller-owned option objects change after journal preparation", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const options = { title: "Admitted intent", type: "Task" };
      await client.commitItemMutations({ transactionId: "stable-intent", mutations: [{ op: "create", id: "stable", options }], onTransition: event => { if (event.transition === "prepared") options.title = "Changed after admission"; } });
      expect((await client.get("stable")).item.title).toBe("Admitted intent");
      expect((await client.itemTransactions.status("stable-intent"))?.journal.recoveryData).toMatchObject({ mutations: [{ options: { title: "Admitted intent" } }] });
    });
  });

});
