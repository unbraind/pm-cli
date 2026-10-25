import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PmClient, WorkspaceTransactionInterruptedError, _testOnlyItemTransaction, commitItemMutations } from "../../../../src/sdk/index.js";
import { readSettings, writeSettings } from "../../../../src/core/store/settings.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("guarded transaction lifecycle continuity (pm-pllp78)", () => {
  it("restores the exact captured version when completed writes share one timestamp", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const original = (await client.create({ title: "Original", type: "Task" })).item;
      await expect(commitItemMutations({ pmRoot: pmPath, author: "transaction-test", transactionId: "same-time-restore", mutations: [{ op: "update", id: original.id, options: { title: "Completed write" } }, { op: "close", id: "pm-absent", reason: "Fail later" }] })).rejects.toThrow("does not exist");
      expect((await client.get(original.id)).item).toMatchObject({ title: "Original", updated_at: original.updated_at });
      expect((await readFile(path.join(pmPath, "history", `${original.id}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line).op)).toEqual(["create", "update", "restore"]);
    });
  });

  it.each([false, true])("retains peer edits and recovery data when interleaved peer effects are net-zero: %s", async (netZero) => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      if (netZero) vi.useFakeTimers({ toFake: ["Date"] });
      const original = (await client.create({ title: "Original", type: "Task" })).item;
      const failure = await commitItemMutations({ pmRoot: pmPath, author: "transaction-test", transactionId: "peer-effects", mutations: [{ op: "update", id: original.id, options: { title: "Forward write" } }], onTransition: async ({ transition }) => {
        if (transition === "step_applied") { await client.comments(original.id, { add: "Peer evidence" }); if (netZero) await client.update(original.id, { clearComments: true }); throw new Error("Abort after peer edit"); }
      } }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([expect.objectContaining({ message: "Abort after peer edit" }), expect.objectContaining({ context: expect.objectContaining({ code: "transaction_partial_mutation" }) })]);
      expect((await client.get(original.id, { full: true })).item).toMatchObject({ title: "Forward write", comments: netZero ? [] : [expect.objectContaining({ text: "Peer evidence" })] });
      expect(JSON.parse(await readFile(path.join(pmPath, "transactions", "sdk", "peer-effects.json"), "utf8"))).toMatchObject({ status: "compensating", startedStepIds: [expect.any(String)] });
    });
  });

  it.each(["restore-entry", "item-lock"])("rechecks compensation before a late peer can be overwritten: %s", async (boundary) => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      const original = (await client.create({ title: "Original", type: "Task" })).item;
      const locks = await import("../../../../src/core/lock/lock.js");
      const acquire = locks.acquireLockLease;
      let acquisitions = 0;
      let peerWrote = false;
      const writePeer = () => { peerWrote = true; expect(context.runCli(["update", original.id, "--title", "Late peer", "--json"]).code).toBe(0); };
      if (boundary === "item-lock") {
        vi.spyOn(locks, "acquireLockLease").mockImplementation(async (...args) => {
          if (args[0] === context.pmPath && args[1] === original.id && ++acquisitions === 2) writePeer();
          return acquire(...args);
        });
      } else {
        const runtime = await import("../../../../src/sdk/runtime.js");
        const restore = runtime.restore;
        vi.spyOn(runtime, "restore").mockImplementation(async (...args) => { writePeer(); return restore(...args); });
      }
      await expect(commitItemMutations({ pmRoot: context.pmPath, author: "transaction-test", transactionId: "restore-race", mutations: [{ op: "update", id: original.id, options: { title: "Forward write" } }], onTransition: ({ transition }) => { if (transition === "committing") throw new Error("Abort"); } })).rejects.toThrow("compensation failed");
      expect((await client.get(original.id)).item.title).toBe("Late peer");
      expect(peerWrote).toBe(true);
      if (boundary === "item-lock") expect(acquisitions).toBe(2);
    });
  });

  it.each(["repeat", "prefix-rewrite", "missing-length", "wrong-version", "fractional-length", "zero-length"])("recovers interrupted compensation using immutable receipts: %s", async (mode) => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const original = (await client.create({ title: "Original", type: "Task" })).item;
      const transactionId = "receipt-recovery";
      await expect(commitItemMutations({ pmRoot: pmPath, author: "transaction-test", transactionId, mutations: [{ op: "update", id: original.id, options: { title: "Forward" } }], onTransition: ({ transition }) => { if (transition === "step_applied") throw new WorkspaceTransactionInterruptedError("Stop before journal completion"); } })).rejects.toThrow("Stop before journal completion");
      const journal = JSON.parse(await readFile(path.join(pmPath, "transactions", "sdk", `${transactionId}.json`), "utf8"));
      const stepId = journal.startedStepIds[0];
      const receipt = journal.compensationData[stepId];
      const historyPath = path.join(pmPath, "history", `${original.id}.jsonl`);
      if (mode === "prefix-rewrite") {
        const entries = (await readFile(historyPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        entries[0].message = "Rewritten captured prefix";
        await writeFile(historyPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      } else if (mode === "missing-length") delete receipt.target_history_length;
      else if (mode === "wrong-version") receipt.target_version = "2";
      else if (mode === "fractional-length") { receipt.target_history_length = 1.5; receipt.target_version = "1.5"; }
      else if (mode === "zero-length") receipt.target_history_length = 0;
      const compensate = () => _testOnlyItemTransaction.compensateByRestore({ pmRoot: pmPath, author: "transaction-test", transactionId }, original.id, stepId, receipt);
      if (mode !== "repeat") {
        await expect(compensate()).rejects.toMatchObject({ context: { code: "transaction_partial_mutation" } });
        expect((await client.get(original.id)).item.title).toBe("Forward");
      } else {
        await compensate();
        await client.comments(original.id, { add: "Peer after compensation" });
        const before = await readFile(historyPath, "utf8");
        await compensate();
        expect((await client.get(original.id, { full: true })).item).toMatchObject({ title: "Original", comments: [expect.objectContaining({ text: "Peer after compensation" })] });
        expect(await readFile(historyPath, "utf8")).toBe(before);
      }
    });
  });

  it("supports legacy timestamp receipts and refuses ambiguous legacy partial effects", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const original = (await client.create({ title: "Original", type: "Task" })).item;
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(original.updated_at) + 1000);
      const config = { pmRoot: pmPath, author: "transaction-test", transactionId: "legacy" };
      const receipt = { target_updated_at: original.updated_at };
      await client.update(original.id, { title: "Unknown write" });
      await expect(_testOnlyItemTransaction.compensateByRestore(config, original.id, "step", receipt)).rejects.toMatchObject({ context: { code: "transaction_partial_mutation" } });
      await client.update(original.id, { title: "Legacy write", message: _testOnlyItemTransaction.bulkHistoryMarker("legacy", "step", "apply") });
      await _testOnlyItemTransaction.compensateByRestore(config, original.id, "step", receipt);
      expect((await client.get(original.id)).item.title).toBe("Original");
      await _testOnlyItemTransaction.compensateByRestore(config, original.id, "step", receipt);
    });
  });

  it("refuses an update without restorable history before changing the item", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const original = (await client.create({ title: "Preserved", type: "Task" })).item;
      const historyPath = path.join(pmPath, "history", `${original.id}.jsonl`);
      await writeFile(historyPath, "");
      await expect(commitItemMutations({ pmRoot: pmPath, author: "transaction-test", transactionId: "no-history", mutations: [{ op: "update", id: original.id, options: { title: "Do not write" } }] })).rejects.toThrow("no restorable history");
      expect((await client.get(original.id)).item.title).toBe("Preserved");
      expect(await readFile(historyPath, "utf8")).toBe("");
    });
  });

  it.each(["updated_at", "title"])("accepts its own %s changes across scalar update and close", async (key) => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true, author: "transaction-test" });
      const original = (await client.create({ title: "Original", type: "Task" })).item;
      const plan = { pmRoot: pmPath, author: "transaction-test", transactionId: `terminal-${key}`, mutations: [{ op: "update" as const, id: original.id, options: { title: "Delivered", status: "closed", closeReason: "Verified" }, match: { key, value: original[key as "title" | "updated_at"] } }] };
      expect(await commitItemMutations(plan)).toMatchObject({ status: "committed" });
      expect((await client.get(original.id)).item).toMatchObject({ title: "Delivered", status: "closed", close_reason: "Verified" });
      const historyPath = path.join(pmPath, "history", `${original.id}.jsonl`);
      const history = await readFile(historyPath, "utf8");
      expect(history.trim().split("\n").map((line) => JSON.parse(line).op)).toEqual(["create", "update", "close"]);
      expect(await commitItemMutations(plan)).toMatchObject({ status: "committed", recovered: true });
      expect(await readFile(historyPath, "utf8")).toBe(history);
    });
  });

  it("refuses a stale starting guard without item or history writes", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const original = (await client.create({ title: "Observed", type: "Task" })).item;
      await client.update(original.id, { title: "Peer revision" });
      const before = (await client.get(original.id, { full: true })).item;
      const historyPath = path.join(pmPath, "history", `${original.id}.jsonl`);
      const history = await readFile(historyPath, "utf8");
      await expect(commitItemMutations({ pmRoot: pmPath, author: "transaction-test", transactionId: "stale-terminal", mutations: [{ op: "update", id: original.id, options: { title: "Stale decision", status: "closed", closeReason: "Wrong revision" }, match: { key: "title", value: original.title } }] })).rejects.toMatchObject({ context: { code: "upsert_match_changed" } });
      expect((await client.get(original.id, { full: true })).item).toEqual(before);
      expect(await readFile(historyPath, "utf8")).toBe(history);
    });
  });

  it.each([{ frozenClock: false, priorStep: false }, { frozenClock: true, priorStep: false }, { frozenClock: true, priorStep: true }])("compensates attributed partial scalar writes with clock=$frozenClock and sibling=$priorStep", async ({ frozenClock, priorStep }) => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      if (frozenClock) { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-25T12:00:00.000Z")); }
      const original = (await client.create({ title: "Original", type: "Task" })).item;
      const settings = await readSettings(pmPath);
      settings.governance.preset = "custom";
      settings.governance.close_validation_default = "strict";
      await writeSettings(pmPath, settings);
      const failure = await commitItemMutations({ pmRoot: pmPath, author: "transaction-test", transactionId: "partial-terminal", mutations: [...(priorStep ? [{ op: "update" as const, id: original.id, options: { title: "Earlier step" } }] : []), { op: "update", id: original.id, options: { title: "Partial write", status: "closed", closeReason: "Refused" } }] }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ context: { code: "close_validation_missing_fields" } });
      expect((await client.get(original.id)).item).toMatchObject({ title: "Original", status: "open" });
      const journal = JSON.parse(await readFile(path.join(pmPath, "transactions", "sdk", "partial-terminal.json"), "utf8"));
      expect(journal).toMatchObject({ status: "compensated", startedStepIds: [], completedStepIds: [], compensationData: {} });
      const entries = (await readFile(path.join(pmPath, "history", `${original.id}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(entries.map((entry) => entry.op)).toEqual(priorStep ? ["create", "update", "update", "restore", "restore"] : ["create", "update", "restore"]);
      expect(entries[1].context.item_transaction_step).toContain("partial-terminal");
    });
  });
});
