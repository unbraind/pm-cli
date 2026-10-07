/**
 * @module tests/integration/merge-receipt-worktree-settlement
 * Exercises receipt attribution and settlement across two real Git worktrees.
 */
import { execFileSync } from "node:child_process";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sealHistoryRecord } from "../../../src/core/history/history.js";
import { verifyHistoryChainWithVersion } from "../../../src/core/history/replay.js";
import { runHealth } from "../../../src/sdk/governance/health.js";
import { runMergeReconcile } from "../../../src/sdk/merge/reconcile.js";
import { inspectMergeReceiptEvidence } from "../../../src/sdk/merge/receipts.js";
import type { HistoryEntry } from "../../../src/types/index.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("merge receipt settlement across worktrees", () => {
  it("attributes durable proof and never reopens committed settlement from a stale local copy", async () => {
    await withTempPmPath(async (context) => {
      const git = (cwd: string, ...args: string[]): string =>
        execFileSync("git", args, {
          cwd,
          env: context.env,
          encoding: "utf8",
        });
      git(context.tempRoot, "init", "-q", "-b", "main");
      git(context.tempRoot, "config", "core.autocrlf", "false");
      git(context.tempRoot, "config", "core.eol", "lf");
      git(context.tempRoot, "config", "user.name", "Receipt Test");
      git(context.tempRoot, "config", "user.email", "receipt@example.invalid");
      expect(context.runCli(["merge", "install"], { cwd: context.tempRoot }).code).toBe(0);
      const id = createTestItemId(context, { title: "Shared receipt settlement" });
      git(context.tempRoot, "add", ".");
      git(context.tempRoot, "commit", "-qm", "Seed shared tracker");
      const observer = path.join(context.tempRoot, "observer");
      const observerPmRoot = path.join(observer, ".agents", "pm");
      git(context.tempRoot, "worktree", "add", "-q", "-b", "observer", observer);
      expect(context.runCli(["update", id, "--description", "Main change", "--tags", "main"]).code).toBe(0);
      git(context.tempRoot, "add", ".agents");
      git(context.tempRoot, "commit", "-qm", "Main item change");
      expect(context.runCli([
        "--pm-path", observerPmRoot, "update", id, "--tags", "observer",
      ], { cwd: observer }).code).toBe(0);
      git(observer, "add", ".agents");
      git(observer, "commit", "-qm", "Observer item change");
      git(context.tempRoot, "merge", "--no-edit", "observer");
      const pending = await inspectMergeReceiptEvidence(context.tempRoot);
      expect(pending.invalid_evidence_count).toBe(0);
      expect(pending.receipts).toHaveLength(1);
      const receipt = pending.receipts[0]!;
      git(context.tempRoot, "add", ".agents");
      git(context.tempRoot, "commit", "-qm", "Retain durable merge receipt");
      git(observer, "merge", "--ff-only", "main");

      const observerEvidence = await inspectMergeReceiptEvidence(observer, { pmRoot: observerPmRoot });
      expect(observerEvidence.receipts).toMatchObject([
        { id: receipt.id, evidence_source: "durable", state: "pending" },
      ]);
      const observerHistoryPath = path.join(observerPmRoot, "history", `${id}.jsonl`);
      const before = await readFile(observerHistoryPath, "utf8");
      const observerReceiptPath = path.join(observerPmRoot, "merge-receipts", `${receipt.id}.json`);
      const pendingDurable = await readFile(observerReceiptPath, "utf8");
      await writeFile(observerReceiptPath, `${JSON.stringify({
        ...JSON.parse(pendingDurable), state: "reconciled", reconciled_at: "2026-10-07T00:00:00.000Z",
      })}\n`);
      expect((await inspectMergeReceiptEvidence(observer, { pmRoot: observerPmRoot })).receipts).toMatchObject([
        { id: receipt.id, state: "pending" },
      ]);
      expect(await readFile(observerHistoryPath, "utf8")).toBe(before);
      const health = await runHealth({ path: observerPmRoot }, { full: true, checkOnly: true });
      expect(health.checks.find((check) => check.name === "history_drift")?.details).toMatchObject({
        merge_receipt_attributed_items: [id],
        remediation_map: { history_drift_merge_receipt: "pm merge reconcile" },
      });
      expect(await readFile(observerHistoryPath, "utf8")).toBe(before);
      await writeFile(observerReceiptPath, pendingDurable);
      const mainReceiptPath = path.join(context.pmPath, "merge-receipts", `${receipt.id}.json`);
      const mainPending = await readFile(mainReceiptPath, "utf8");
      await writeFile(mainReceiptPath, `${JSON.stringify({
        ...JSON.parse(mainPending), state: "reconciled", reconciled_at: "2026-10-07T00:00:00.000Z",
      })}\n`);
      expect((await inspectMergeReceiptEvidence(context.tempRoot)).receipts).toMatchObject([
        { id: receipt.id, state: "pending" },
      ]);
      await writeFile(mainReceiptPath, mainPending);
      let interruptedHistory: string | undefined;
      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        const durableDirectory = path.join(observerPmRoot, "merge-receipts");
        await chmod(durableDirectory, 0o500);
        try {
          await expect(runMergeReconcile({}, { path: observerPmRoot })).rejects.toMatchObject({ code: "EACCES" });
          interruptedHistory = await readFile(observerHistoryPath, "utf8");
          expect(interruptedHistory).not.toBe(before);
          expect(interruptedHistory).toContain('"op":"merge_reconcile"');
          expect((await inspectMergeReceiptEvidence(observer, { pmRoot: observerPmRoot })).receipts).toHaveLength(1);
        } finally {
          await chmod(durableDirectory, 0o700);
        }
      }
      const repaired = await runMergeReconcile({}, { path: observerPmRoot });
      expect(repaired.ok).toBe(true);
      expect(repaired.receipts).toMatchObject({ pending_before: 1, reconciled: 1, abandoned: 0 });
      if (interruptedHistory !== undefined) expect(await readFile(observerHistoryPath, "utf8")).toBe(interruptedHistory);
      git(observer, "add", ".agents");
      git(observer, "commit", "-qm", "Commit audited receipt settlement");
      git(context.tempRoot, "merge", "--ff-only", "observer");

      const localPath = git(context.tempRoot, "rev-parse", "--path-format=absolute", "--git-path", "pm-merge-receipts").trim();
      const staleLocal = await readFile(path.join(localPath, `${receipt.id}.json`), "utf8");
      expect(JSON.parse(staleLocal)).toHaveProperty("state", "pending");
      expect((await inspectMergeReceiptEvidence(context.tempRoot)).receipts).toEqual([]);
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const durablePath = path.join(context.pmPath, "merge-receipts", `${receipt.id}.json`);
      const settledHistory = await readFile(historyPath, "utf8");
      const settledReceipt = await readFile(durablePath, "utf8");
      const repeated = await runMergeReconcile({}, { path: context.pmPath });
      expect(repeated.ok).toBe(true);
      expect(repeated.receipts).toMatchObject({ pending_before: 0, reconciled: 0, abandoned: 0 });
      expect(await readFile(historyPath, "utf8")).toBe(settledHistory);
      expect(await readFile(durablePath, "utf8")).toBe(settledReceipt);
      expect(await readFile(path.join(localPath, `${receipt.id}.json`), "utf8")).toBe(staleLocal);
      const settledEntries = settledHistory.trim().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
      const audit = settledEntries.at(-1)!;
      expect(audit.op).toBe("merge_reconcile");
      for (const changedAudit of [
        { ...audit, op: "update" },
        { ...audit, context: undefined },
        { ...audit, context: {} },
        ...[null, [], "invalid", {}, { receipts: "invalid" }, { receipts: [null] }].map(
          (merge) => ({ ...audit, context: { merge } }),
        ),
        { ...audit, context: { merge: { receipts: [{ receipt_id: receipt.id }] } } },
      ]) {
        const altered = [...settledEntries.slice(0, -1), sealHistoryRecord(changedAudit)];
        expect(verifyHistoryChainWithVersion(altered).ok).toBe(true);
        await writeFile(historyPath, `${altered.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
        expect((await inspectMergeReceiptEvidence(context.tempRoot)).receipts).toMatchObject([
          { id: receipt.id, state: "pending" },
        ]);
      }
      const { record_hash: _recordHash, record_hash_version: _recordVersion, ...unsealedAudit } = audit;
      for (const invalidHistory of [
        "invalid JSON\n",
        "null\n",
        `${[...settledEntries.slice(0, -1), unsealedAudit].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        `${[...settledEntries.slice(0, -1), { ...audit, message: "Unauthenticated edit" }].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      ]) {
        await writeFile(historyPath, invalidHistory);
        expect((await inspectMergeReceiptEvidence(context.tempRoot)).receipts).toMatchObject([
          { id: receipt.id, state: "pending" },
        ]);
      }
      await rm(historyPath);
      expect((await inspectMergeReceiptEvidence(context.tempRoot)).receipts).toHaveLength(1);
      await writeFile(historyPath, settledHistory);
      await writeFile(durablePath, `${JSON.stringify({
        ...JSON.parse(settledReceipt), settlement: "original_git_state_restored",
      })}\n`);
      expect((await inspectMergeReceiptEvidence(context.tempRoot)).receipts).toMatchObject([
        { id: receipt.id, state: "pending" },
      ]);
      await writeFile(durablePath, settledReceipt);
      expect((await inspectMergeReceiptEvidence(context.tempRoot)).receipts).toEqual([]);
    });
  });
});
