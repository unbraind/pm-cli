import { execFileSync, spawnSync } from "node:child_process";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runMergeReconcile } from "../../src/sdk/merge/reconcile.js";
import { settleAbandonedMergeReceipts } from "../../src/sdk/merge/abandoned-receipts.js";
import { inspectMergeReceiptEvidence } from "../../src/sdk/merge/receipts.js";
import {
  captureMergeReceiptOperation,
  isOriginalGitStateRestored,
} from "../../src/sdk/merge/receipt-operation.js";
import { runHistoryRepair } from "../../src/sdk/history-repair.js";
import {
  runWithIsolatedExtensionRuntime,
  setActiveExtensionHooks,
} from "../../src/core/extensions/index.js";
import { createTestItemId } from "../helpers/itemFactory.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("aborted rebase receipt recovery", () => {
  it("retains provenance and settles only an operation whose exact original Git state was restored", async () => {
    await withTempPmPath(async (context) => {
      const git = (...args: string[]): string =>
        execFileSync("git", args, {
          cwd: context.tempRoot,
          env: context.env,
          encoding: "utf8",
        });
      git("init", "-q");
      // Exact-byte restoration requires a fixture policy independent of host defaults.
      git("config", "core.autocrlf", "false");
      git("config", "core.eol", "lf");
      git("config", "user.name", "Merge Test");
      git("config", "user.email", "merge@example.invalid");
      expect(
        context.runCli(["merge", "install"], { cwd: context.tempRoot }).code,
      ).toBe(0);
      const id = createTestItemId(context, {
        title: "Rebase origin recovery",
        description: "Common ancestor",
      });
      git("add", ".");
      git("commit", "-qm", "Seed tracker");
      git("checkout", "-qb", "upstream");
      expect(
        context.runCli([
          "update",
          id,
          "--description",
          "Private upstream description",
        ]).code,
      ).toBe(0);
      git("add", ".");
      git("commit", "-qm", "Upstream change");
      git("checkout", "-qb", "topic", "HEAD~1");
      expect(
        context.runCli([
          "update",
          id,
          "--description",
          "Private topic description",
        ]).code,
      ).toBe(0);
      git("add", ".");
      git("commit", "-qm", "Topic change");
      const originalItem = await readFile(
        path.join(context.pmPath, "tasks", `${id}.toon`),
        "utf8",
      );
      const rebase = spawnSync("git", ["rebase", "upstream"], {
        cwd: context.tempRoot,
        env: context.env,
        encoding: "utf8",
      });
      expect(rebase.status, rebase.stderr).not.toBe(0);
      const during = await inspectMergeReceiptEvidence(context.tempRoot);
      expect(during.receipts).toHaveLength(1);
      expect(during.receipts[0]).toHaveProperty("operation.kind", "rebase");
      const active = await runMergeReconcile(
        { dryRun: true },
        { path: context.pmPath },
      );
      expect(active.receipts).toHaveProperty("abandoned", 0);
      git("rebase", "--abort");
      expect(
        await readFile(
          path.join(context.pmPath, "tasks", `${id}.toon`),
          "utf8",
        ),
      ).toBe(originalItem);
      const receipt = during.receipts[0]!;
      const operation = receipt.operation!;
      expect(
        await captureMergeReceiptOperation(context.tempRoot, receipt.item_path),
      ).toBeUndefined();
      expect(
        await isOriginalGitStateRestored(context.tempRoot, receipt.item_path, {
          ...operation,
          original_head: "0".repeat(40),
        }),
      ).toBe(false);
      expect(
        await isOriginalGitStateRestored(context.tempRoot, receipt.item_path, {
          ...operation,
          original_blob: "0".repeat(40),
        }),
      ).toBe(false);
      expect(
        await isOriginalGitStateRestored(
          context.tempRoot,
          receipt.item_path,
          operation,
          "stale snapshot",
        ),
      ).toBe(false);
      const itemPath = path.join(context.tempRoot, receipt.item_path);
      await writeFile(itemPath, `${originalItem}\n`);
      expect(
        await isOriginalGitStateRestored(
          context.tempRoot,
          receipt.item_path,
          operation,
        ),
      ).toBe(false);
      git("add", "--", receipt.item_path);
      await writeFile(itemPath, originalItem);
      expect(
        await isOriginalGitStateRestored(
          context.tempRoot,
          receipt.item_path,
          operation,
        ),
      ).toBe(false);
      git("restore", "--staged", "--", receipt.item_path);
      await runHistoryRepair(
        id,
        {
          forceAuditEntry: true,
          auditOperation: "merge_reconcile",
          auditContext: { merge: { abandoned_receipts: [] } },
        },
        { path: context.pmPath },
      );
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const before = await readFile(historyPath, "utf8");
      const preview = await runMergeReconcile(
        { dryRun: true },
        { path: context.pmPath },
      );
      expect(preview.receipts).toHaveProperty("abandoned", 1);
      expect(await readFile(historyPath, "utf8")).toBe(before);
      for (const change of ["head", "operation"] as const) {
        await runWithIsolatedExtensionRuntime(async () => {
          let changed = false;
          const marker = path.join(context.tempRoot, ".git", "MERGE_HEAD");
          setActiveExtensionHooks({
            beforeCommand: [],
            afterCommand: [],
            onRead: [],
            onIndex: [],
            onWrite: [{
              layer: "project",
              name: "concurrent-git-operation",
              run: async (event) => {
                if (event.op !== "lock:create" || changed) return;
                changed = true;
                if (change === "head") git("commit", "--allow-empty", "-qm", "Concurrent Git change");
                else await writeFile(marker, `${operation.original_head}\n`);
              },
            }],
          });
          try {
            await expect(runMergeReconcile({}, { path: context.pmPath }))
              .rejects.toMatchObject({ context: { code: "merge_reconcile_receipt_evidence_untrusted" } });
            expect(changed).toBe(true);
            expect(await readFile(historyPath, "utf8")).toBe(before);
            expect(await readFile(itemPath, "utf8")).toBe(originalItem);
            const pending = await inspectMergeReceiptEvidence(context.tempRoot);
            expect(pending.receipts).toHaveLength(1);
            expect(pending.receipts[0]!.state).toBe(receipt.state);
          } finally {
            setActiveExtensionHooks(null);
            git("update-ref", "HEAD", operation.original_head);
            await rm(marker, { force: true });
          }
        });
      }
      let interruptedHistory: string | undefined;
      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        const durableDirectory = path.join(context.pmPath, "merge-receipts");
        await chmod(durableDirectory, 0o500);
        try {
          await expect(
            runMergeReconcile({}, { path: context.pmPath }),
          ).rejects.toMatchObject({ code: "EACCES" });
          interruptedHistory = await readFile(historyPath, "utf8");
          expect(interruptedHistory.startsWith(before)).toBe(true);
          expect(interruptedHistory).toContain("original_git_state_restored");
        } finally {
          await chmod(durableDirectory, 0o700);
        }
      }
      const applied = await runMergeReconcile({}, { path: context.pmPath });
      expect(applied.receipts).toMatchObject({ abandoned: 1, reconciled: 0 });
      expect(applied.ok).toBe(true);
      const after = await readFile(historyPath, "utf8");
      if (interruptedHistory !== undefined)
        expect(after).toBe(interruptedHistory);
      expect(after.startsWith(before)).toBe(true);
      expect(after).toContain("original_git_state_restored");
      expect(
        await settleAbandonedMergeReceipts({
          cwd: context.tempRoot,
          receipts: [receipt],
          dryRun: false,
          global: { path: context.pmPath },
        }),
      ).toEqual([receipt.id]);
      expect(await readFile(historyPath, "utf8")).toBe(after);
      const settled = await inspectMergeReceiptEvidence(context.tempRoot, {
        includeReconciled: true,
      });
      expect(settled.receipts[0]).toMatchObject({
        state: "reconciled",
        settlement: "original_git_state_restored",
      });
      const durable = await readFile(
        path.join(
          context.pmPath,
          "merge-receipts",
          `${settled.receipts[0]!.id}.json`,
        ),
        "utf8",
      );
      expect(durable).not.toContain("Private upstream description");
      expect(durable).not.toContain("Private topic description");
      expect(
        context.runCli([
          "comments",
          id,
          "Concurrent legitimate update after preview",
        ]).code,
      ).toBe(0);
      const concurrentHistory = await readFile(historyPath, "utf8");
      await expect(
        runHistoryRepair(
          id,
          {
            forceAuditEntry: true,
            mergeAbandonmentProof: {
              gitWorkspaceRoot: context.tempRoot,
              receipt,
            },
          },
          { path: context.pmPath },
        ),
      ).rejects.toThrow("no longer proves");
      expect(await readFile(historyPath, "utf8")).toBe(concurrentHistory);
      await rm(itemPath);
      await expect(
        runHistoryRepair(
          id,
          {
            dryRun: true,
            mergeAbandonmentProof: {
              gitWorkspaceRoot: context.tempRoot,
              receipt,
            },
          },
          { path: context.pmPath },
        ),
      ).rejects.toThrow("no longer proves");
      expect(await readFile(historyPath, "utf8")).toBe(concurrentHistory);
    });
  });
});
