/**
 * @module sdk/merge/abandoned-receipts
 * Settles verified restored-origin receipts through an explicit history event.
 */
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { runHistoryRepair } from "../history-repair.js";
import { isOriginalGitStateRestored } from "./receipt-operation.js";
import {
  markMergeReceiptReconciled,
  summarizeMergeReceipt,
  type MergeDecisionReceipt,
} from "./receipts.js";

/** Preview or record restored-origin dispositions without treating them as applied merges. */
export async function settleAbandonedMergeReceipts(params: {
  cwd: string | null;
  receipts: readonly MergeDecisionReceipt[];
  dryRun: boolean;
  author?: string;
  message?: string;
  global: GlobalOptions;
}): Promise<string[]> {
  if (params.cwd === null) return [];
  const settled: string[] = [];
  for (const receipt of params.receipts) {
    if (
      receipt.operation === undefined ||
      !(await isOriginalGitStateRestored(
        params.cwd,
        receipt.item_path,
        receipt.operation,
      ))
    )
      continue;
    const mergeAbandonmentProof = { gitWorkspaceRoot: params.cwd, receipt };
    await runHistoryRepair(
      receipt.item_id,
      { dryRun: true, mergeAbandonmentProof },
      params.global,
    );
    if (!params.dryRun) {
      await runHistoryRepair(
        receipt.item_id,
        {
          author: params.author ?? params.global.author,
          mergeAbandonmentProof,
          message:
            params.message ??
            "Settle rebase receipt after exact original Git state restoration",
          auditOperation: "merge_reconcile",
          forceAuditEntry: true,
          auditContext: {
            merge: {
              abandoned_receipts: [
                {
                  ...summarizeMergeReceipt(receipt),
                  reason: "original_git_state_restored",
                  operation: receipt.operation,
                },
              ],
            },
          },
        },
        params.global,
      );
      await markMergeReceiptReconciled(params.cwd, receipt, {
        requireExisting: true,
        settlement: "original_git_state_restored",
      });
    }
    settled.push(receipt.id);
  }
  return settled;
}
