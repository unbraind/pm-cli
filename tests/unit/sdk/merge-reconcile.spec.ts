import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalOptions } from "../../../src/core/shared/command-types.js";

const mocks = vi.hoisted(() => ({
  listMergeReceipts: vi.fn(),
  invalidReceiptEvidenceCount: vi.fn(),
  markMergeReceiptReconciled: vi.fn(),
  runHistoryRepair: vi.fn(),
  runHistoryRepairAll: vi.fn(),
  runValidate: vi.fn(),
  findGitWorkspaceRoot: vi.fn(),
}));

vi.mock("../../../src/sdk/history-repair.js", () => ({
  runHistoryRepair: mocks.runHistoryRepair,
  runHistoryRepairAll: mocks.runHistoryRepairAll,
}));
vi.mock("../../../src/sdk/governance/validate.js", () => ({
  runValidate: mocks.runValidate,
}));
vi.mock("../../../src/sdk/merge/install.js", () => ({
  findGitWorkspaceRoot: mocks.findGitWorkspaceRoot,
}));
vi.mock("../../../src/sdk/merge/receipts.js", async (importOriginal) => ({
  ...(await importOriginal()),
  inspectMergeReceiptEvidence: async (...args: unknown[]) => ({
    receipts: await mocks.listMergeReceipts(...args),
    invalid_evidence_count: mocks.invalidReceiptEvidenceCount(),
  }),
  markMergeReceiptReconciled: mocks.markMergeReceiptReconciled,
  summarizeMergeReceipt: (receipt: { id: string; item_id: string }) => ({
    receipt_id: receipt.id,
    item_id: receipt.item_id,
  }),
}));

import { runMergeReconcile } from "../../../src/sdk/merge/reconcile.js";

const globalOptions = { author: "global-author" } as GlobalOptions;

describe("merge reconciliation SDK", () => {
  beforeEach(() => {
    mocks.runHistoryRepairAll.mockReset();
    mocks.runValidate.mockReset();
    mocks.listMergeReceipts.mockReset().mockResolvedValue([]);
    mocks.invalidReceiptEvidenceCount.mockReset().mockReturnValue(0);
    mocks.markMergeReceiptReconciled.mockReset();
    mocks.runHistoryRepair.mockReset();
    mocks.findGitWorkspaceRoot.mockReset().mockResolvedValue("/workspace");
  });

  it("previews with default attribution and fails closed on validation warnings", async () => {
    mocks.runHistoryRepairAll.mockResolvedValue({
      streams: [{ id: "already-represented" }],
      totals: { repaired: 0, skipped_clean: 0, failed: 0 },
    });
    mocks.runValidate.mockResolvedValue({
      checks: [{ status: "warn" }],
      generated_at: "2026-07-21T00:00:00.000Z",
    });

    const result = await runMergeReconcile({ dryRun: true }, globalOptions);

    expect(mocks.runHistoryRepairAll).toHaveBeenCalledWith(
      {
        dryRun: true,
        author: "global-author",
        message: "post-merge reconciliation of field-aware tracker history",
        force: undefined,
        auditOperation: "merge_reconcile",
        auditContextById: {},
      },
      globalOptions,
    );
    expect(mocks.runValidate).toHaveBeenCalledWith(
      { checkHistoryDrift: true, checkStorageIntegrity: true },
      globalOptions,
    );
    expect(result).toMatchObject({
      ok: false,
      dry_run: true,
      generated_at: "2026-07-21T00:00:00.000Z",
    });
    expect(result.guidance[0]).toContain("Review repair.streams");
  });

  it("refuses malformed receipt evidence before repair or validation", async () => {
    mocks.invalidReceiptEvidenceCount.mockReturnValue(2);

    await expect(
      runMergeReconcile({ dryRun: true }, globalOptions),
    ).rejects.toMatchObject({
      exitCode: 4,
      context: {
        code: "merge_receipt_evidence_invalid",
        recovery: { suggested_retry: "pm health --check-only --full" },
      },
    });
    expect(mocks.runHistoryRepairAll).not.toHaveBeenCalled();
    expect(mocks.runValidate).not.toHaveBeenCalled();
  });

  it("applies explicit repair metadata and requires green verification", async () => {
    mocks.runHistoryRepairAll.mockResolvedValue({
      streams: [{ id: "unproven" }],
      totals: { repaired: 0, skipped_clean: 0, failed: 0 },
    });
    mocks.runValidate.mockResolvedValue({
      checks: [{ status: "ok" }, { status: "ok" }],
      generated_at: "2026-07-21T00:01:00.000Z",
    });

    const result = await runMergeReconcile(
      { author: "merge-agent", message: "merged branches", force: true },
      globalOptions,
    );

    expect(mocks.runHistoryRepairAll).toHaveBeenCalledWith(
      {
        dryRun: false,
        author: "merge-agent",
        message: "merged branches",
        force: true,
        auditOperation: "merge_reconcile",
        auditContextById: {},
      },
      globalOptions,
    );
    expect(result.ok).toBe(true);
    expect(result.guidance[0]).toContain("Reconciliation is complete");

    mocks.runHistoryRepairAll.mockResolvedValueOnce({
      streams: [],
      totals: { repaired: 0, skipped_clean: 0, failed: 1 },
    });
    mocks.runValidate.mockResolvedValueOnce({
      checks: [{ status: "warn" }],
      generated_at: "2026-07-21T00:02:00.000Z",
    });
    const failed = await runMergeReconcile({}, globalOptions);
    expect(failed.ok).toBe(false);
    expect(failed.guidance).toEqual([
      expect.stringContaining("remains incomplete"),
      expect.stringContaining("Do not commit"),
    ]);
  });

  it("uses the process workspace fallback only when Git discovery is unavailable", async () => {
    const receipt = { id: "receipt-fallback", item_id: "pm-fallback" };
    mocks.findGitWorkspaceRoot.mockResolvedValue(null);
    mocks.listMergeReceipts.mockResolvedValue([receipt]);
    mocks.runHistoryRepairAll.mockResolvedValue({
      streams: [],
      totals: { repaired: 0, skipped_clean: 0, failed: 0 },
    });
    mocks.runHistoryRepair.mockResolvedValue({
      changed: false,
      history: {
        entries_rehashed: 0,
        entries_patch_repaired: 0,
        reconciled_with_item: false,
      },
      merge_receipt_proof: {
        trusted: true,
        reason: "trusted_merge_driver_hash_evidence",
        receipt_ids: [receipt.id],
      },
      warnings: [],
    });
    mocks.runValidate.mockResolvedValue({
      checks: [{ status: "ok" }],
      generated_at: "2026-07-21T00:02:30.000Z",
    });

    await runMergeReconcile({}, globalOptions);

    expect(mocks.listMergeReceipts).toHaveBeenCalledWith(process.cwd(), {
      includeLossless: true,
      pmRoot: expect.any(String),
    });
    expect(mocks.markMergeReceiptReconciled).toHaveBeenCalledWith(
      process.cwd(),
      receipt,
      { requireExisting: true },
    );
  });

  it("records clean receipt-bearing merges and marks receipts reconciled", async () => {
    const receipt = {
      id: "receipt-1",
      item_id: "pm-merge",
      state: "pending",
    };
    mocks.listMergeReceipts.mockResolvedValue([receipt]);
    mocks.runHistoryRepairAll.mockResolvedValue({
      streams: [],
      totals: { repaired: 0, skipped_clean: 0, failed: 0 },
    });
    mocks.runHistoryRepair.mockResolvedValue({
      changed: true,
      history: {
        entries_rehashed: 0,
        entries_patch_repaired: 0,
        reconciled_with_item: false,
      },
      merge_receipt_proof: {
        trusted: true,
        reason: "trusted_merge_driver_hash_evidence",
        receipt_ids: ["receipt-1"],
      },
      warnings: [],
    });
    mocks.runValidate.mockResolvedValue({
      checks: [{ status: "ok" }],
      generated_at: "2026-07-21T00:03:00.000Z",
    });

    const result = await runMergeReconcile({}, globalOptions);

    expect(mocks.runHistoryRepair).toHaveBeenCalledWith(
      "pm-merge",
      expect.objectContaining({
        auditOperation: "merge_reconcile",
        forceAuditEntry: true,
      }),
      globalOptions,
    );
    expect(mocks.markMergeReceiptReconciled).toHaveBeenCalledWith(
      "/workspace",
      receipt,
      { requireExisting: true },
    );
    expect(result.receipts).toMatchObject({
      pending_before: 1,
      reconciled: 1,
    });
  });

  it("settles only the individually proven receipt for a shared item", async () => {
    const trustedReceipt = {
      id: "receipt-trusted",
      item_id: "pm-shared",
      state: "pending",
    };
    const untrustedSibling = {
      id: "receipt-untrusted",
      item_id: "pm-shared",
      state: "pending",
    };
    mocks.listMergeReceipts.mockResolvedValue([
      trustedReceipt,
      untrustedSibling,
    ]);
    mocks.runHistoryRepairAll.mockResolvedValue({
      streams: [
        {
          id: "pm-shared",
          outcome: "repaired",
          merge_receipt_proof: {
            trusted: true,
            reason: "trusted_merge_driver_hash_evidence",
            receipt_ids: ["receipt-trusted"],
          },
        },
      ],
      totals: { repaired: 1, skipped_clean: 0, failed: 0 },
    });
    mocks.runValidate.mockResolvedValue({
      checks: [{ status: "warn" }],
      generated_at: "2026-07-21T00:03:30.000Z",
    });

    const result = await runMergeReconcile({}, globalOptions);

    expect(mocks.markMergeReceiptReconciled).toHaveBeenCalledTimes(1);
    expect(mocks.markMergeReceiptReconciled).toHaveBeenCalledWith(
      "/workspace",
      trustedReceipt,
      { requireExisting: true },
    );
    expect(mocks.markMergeReceiptReconciled).not.toHaveBeenCalledWith(
      "/workspace",
      untrustedSibling,
      { requireExisting: true },
    );
    expect(result).toMatchObject({
      ok: false,
      receipts: { pending_before: 2, reconciled: 1 },
    });
  });

  it("isolates receipt-only history failures without consuming receipts", async () => {
    mocks.listMergeReceipts.mockResolvedValue([
      { id: "receipt-error", item_id: "pm-error" },
      { id: "receipt-string", item_id: "pm-string" },
    ]);
    mocks.runHistoryRepairAll.mockResolvedValue({
      streams: [],
      totals: { repaired: 0, skipped_clean: 0, failed: 0 },
    });
    mocks.runHistoryRepair
      .mockRejectedValueOnce(new Error("history unavailable"))
      .mockRejectedValueOnce("lock unavailable");
    mocks.runValidate.mockResolvedValue({
      checks: [{ status: "ok" }],
      generated_at: "2026-07-21T00:04:00.000Z",
    });

    const result = await runMergeReconcile({}, globalOptions);

    expect(result.ok).toBe(false);
    expect(result.repair.streams).toEqual([
      {
        id: "pm-error",
        outcome: "failed",
        error: "history unavailable",
      },
      {
        id: "pm-string",
        outcome: "failed",
        error: "lock unavailable",
      },
    ]);
    expect(result.repair.totals.failed).toBe(2);
    expect(mocks.markMergeReceiptReconciled).not.toHaveBeenCalled();
  });

  it("previews clean receipt-only streams without consuming their receipts", async () => {
    const receipt = { id: "receipt-preview", item_id: "pm-preview" };
    mocks.listMergeReceipts.mockResolvedValue([receipt]);
    mocks.runHistoryRepairAll.mockResolvedValue({
      streams: [],
      totals: { repaired: 0, skipped_clean: 0, failed: 0 },
    });
    mocks.runHistoryRepair.mockResolvedValue({
      changed: false,
      history: {
        entries_rehashed: 0,
        entries_patch_repaired: 0,
        reconciled_with_item: false,
      },
      warnings: ["preview"],
    });
    mocks.runValidate.mockResolvedValue({
      checks: [{ status: "warn" }],
      generated_at: "2026-07-21T00:05:00.000Z",
    });

    const result = await runMergeReconcile(
      { dryRun: true, message: "preview receipt" },
      globalOptions,
    );

    expect(result.repair.streams).toEqual([
      {
        id: "pm-preview",
        outcome: "skipped_clean",
        entries_rehashed: 0,
        entries_patch_repaired: 0,
        reconciled_with_item: false,
        warnings: ["preview"],
      },
    ]);
    expect(result.repair.totals.skipped_clean).toBe(1);
    expect(result.ok).toBe(false);
    expect(mocks.markMergeReceiptReconciled).not.toHaveBeenCalled();
  });

  it("routes discarded-value receipts through exact hash proof instead of requiring force up front", async () => {
    const receipt = {
      id: "durable-hash-proof",
      item_id: "pm-durable",
      state: "pending",
      decisions: [{ field: "status" }],
      value_availability: "hash_only",
      evidence_source: "durable",
    };
    mocks.listMergeReceipts.mockResolvedValue([receipt]);
    mocks.runHistoryRepairAll.mockResolvedValue({
      streams: [
        {
          id: receipt.item_id,
          outcome: "repaired",
          merge_receipt_proof: {
            trusted: true,
            reason: "trusted_merge_driver_hash_evidence",
            receipt_ids: [receipt.id],
          },
        },
      ],
      totals: { repaired: 1, skipped_clean: 0, failed: 0 },
    });
    mocks.runValidate.mockResolvedValue({
      checks: [{ status: "ok" }],
      generated_at: "2026-07-21T00:06:00.000Z",
    });

    const result = await runMergeReconcile({}, globalOptions);

    expect(mocks.runHistoryRepairAll).toHaveBeenCalledWith(
      expect.objectContaining({ force: undefined }),
      globalOptions,
    );
    expect(mocks.markMergeReceiptReconciled).toHaveBeenCalledWith(
      "/workspace",
      receipt,
      { requireExisting: true },
    );
    expect(result.ok).toBe(true);
  });
});
