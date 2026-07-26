import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalOptions } from "../../../src/core/shared/command-types.js";

const mocks = vi.hoisted(() => ({
  listMergeReceipts: vi.fn(),
  markMergeReceiptReconciled: vi.fn(),
  runHistoryRepair: vi.fn(),
  runHistoryRepairAll: vi.fn(),
  runValidate: vi.fn(),
}));

vi.mock("../../../src/sdk/history-repair.js", () => ({
  runHistoryRepair: mocks.runHistoryRepair,
  runHistoryRepairAll: mocks.runHistoryRepairAll,
}));
vi.mock("../../../src/sdk/governance/validate.js", () => ({
  runValidate: mocks.runValidate,
}));
vi.mock("../../../src/sdk/merge/receipts.js", () => ({
  listMergeReceipts: mocks.listMergeReceipts,
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
    mocks.markMergeReceiptReconciled.mockReset();
    mocks.runHistoryRepair.mockReset();
  });

  it("previews with default attribution and tolerates validation warnings", async () => {
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
      ok: true,
      dry_run: true,
      generated_at: "2026-07-21T00:00:00.000Z",
    });
    expect(result.guidance[0]).toContain("Review repair.streams");
  });

  it("applies explicit repair metadata and requires green verification", async () => {
    mocks.runHistoryRepairAll.mockResolvedValue({
      streams: [],
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
      history: {
        entries_rehashed: 0,
        entries_patch_repaired: 0,
        reconciled_with_item: false,
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
      process.cwd(),
      receipt,
    );
    expect(result.receipts).toMatchObject({
      pending_before: 1,
      reconciled: 1,
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
    expect(mocks.markMergeReceiptReconciled).not.toHaveBeenCalled();
  });
});
