/** Verify the guarded index boundary without simulating reconciliation itself. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MergeReconcileResult } from "../../../../src/sdk/merge/reconcile.js";

const mocks = vi.hoisted(() => ({ git: vi.fn(), workspace: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original()),
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mocks.git }),
}));
vi.mock("../../../../src/sdk/merge/install.js", () => ({ findGitWorkspaceRoot: mocks.workspace }));
import { stageLosslessMergeReconciliation } from "../../../../src/sdk/merge/stage.js";

/** Valid receipt-backed preview at the staging adapter boundary. */
function preview(): MergeReconcileResult {
  return {
    ok: false, dry_run: true,
    repair: { streams: [{ id: "pm-task", outcome: "repaired", merge_receipt_proof: { trusted: true, reason: "trusted_merge_driver_hash_evidence", receipt_ids: ["receipt"] } }], totals: { failed: 0 } },
    receipts: { summaries: [{ receipt_id: "receipt", item_id: "pm-task", conflict_fields: [] }], missing_history_references_after: 0 },
    validation: { checks: [{ name: "history_drift", status: "warn" }, { name: "storage_integrity", status: "ok" }] },
  } as MergeReconcileResult;
}

describe("lossless reconciliation staging", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    mocks.git.mockReset().mockImplementation(async (_command, args) => ({ stdout: args.includes("--cached") && args[0] === "ls-files" ? ".agents/pm/merge-receipts/receipt.json\0" : "" }));
    mocks.workspace.mockReset().mockResolvedValue("/workspace");
  });
  const invoke = (value = preview(), dryRun = false, apply = vi.fn().mockResolvedValue({ ...value, ok: true, dry_run: false })) => ({
    apply,
    run: () => stageLosslessMergeReconciliation({ preview: value, dryRun, global: { path: "/workspace/.agents/pm" }, apply }),
  });

  it("previews without applying and stages only literal receipt and history paths after verification", async () => {
    const dry = invoke(preview(), true);
    expect((await dry.run()).staged_paths).toEqual([]);
    expect(dry.apply).not.toHaveBeenCalled();
    const applied = invoke();
    expect((await applied.run()).staged_paths).toEqual([".agents/pm/history/pm-task.jsonl", ".agents/pm/merge-receipts/receipt.json"]);
    expect(mocks.git).toHaveBeenLastCalledWith("git", ["add", "--", ":(literal).agents/pm/history/pm-task.jsonl", ":(literal).agents/pm/merge-receipts/receipt.json"], expect.any(Object));
  });

  it("leaves a clean no-op index alone", async () => {
    const value = preview(); value.repair.streams = []; value.receipts.summaries = [];
    expect((await invoke(value).run()).staged_paths).toEqual([]);
    expect(mocks.git.mock.calls.every((call) => call[1][0] === "ls-files")).toBe(true);
  });

  it("includes receipt-only audit histories even when bulk repair reports no changed stream", async () => {
    const value = preview(); value.repair.streams = []; value.receipts.abandoned = 1;
    expect((await invoke(value).run()).staged_paths).toEqual([".agents/pm/history/pm-task.jsonl", ".agents/pm/merge-receipts/receipt.json"]);
  });

  it.each([true, false])("accepts the normal hook index and refuses an alternate index (normal: %s)", async (normal) => {
    vi.stubEnv("GIT_INDEX_FILE", normal ? "/workspace/.git/index" : "/foreign/index");
    mocks.git.mockResolvedValueOnce({ stdout: "/workspace/.git/index\n" });
    const request = invoke();
    if (normal) expect((await request.run()).staged_paths).toHaveLength(2);
    else {
      await expect(request.run()).rejects.toMatchObject({ context: { code: "merge_settlement_review_required" } });
      expect(request.apply).not.toHaveBeenCalled();
    }
  });

  it.each(["repair failure", "missing durable references", "discarded values", "untrusted repair", "unrelated normalization", "storage failure"])("refuses %s before touching the index", async (condition) => {
    const value = preview();
    if (condition === "repair failure") value.repair.totals.failed = 1;
    if (condition === "missing durable references") value.receipts.missing_history_references_after = 1;
    if (condition === "discarded values") value.receipts.summaries[0].conflict_fields = ["title"];
    if (condition === "untrusted repair") value.repair.streams[0].merge_receipt_proof!.trusted = false;
    if (condition === "unrelated normalization") delete value.repair.streams[0].merge_receipt_proof;
    if (condition === "storage failure") value.validation.checks[1].status = "error";
    const request = invoke(value);
    await expect(request.run()).rejects.toMatchObject({ context: { code: "merge_settlement_review_required" } });
    expect(request.apply).not.toHaveBeenCalled(); expect(mocks.git).not.toHaveBeenCalled();
  });

  it.each(["missing workspace", "unresolved index", "outside workspace", "unstaged edits"])("preserves the index on %s", async (condition) => {
    if (condition === "missing workspace") mocks.workspace.mockResolvedValue(null);
    if (condition === "unresolved index") mocks.git.mockResolvedValue({ stdout: "unmerged\0" });
    if (condition === "outside workspace") mocks.workspace.mockResolvedValue("/other-workspace");
    if (condition === "unstaged edits") mocks.git.mockResolvedValueOnce({ stdout: "" }).mockRejectedValueOnce(new Error("dirty index boundary"));
    const request = invoke();
    await expect(request.run()).rejects.toMatchObject({ context: { code: "merge_settlement_review_required" } });
    expect(request.apply).not.toHaveBeenCalled();
  });

  it.each(["failed apply", "changed receipts", "new repair target"])("does not stage %s", async (condition) => {
    const value = preview(); const changed = structuredClone(value); changed.ok = true;
    if (condition === "failed apply") changed.ok = false;
    if (condition === "changed receipts") changed.receipts.summaries[0].receipt_id = "new-receipt";
    if (condition === "new repair target") changed.repair.streams[0].id = "pm-unrelated";
    const request = invoke(value, false, vi.fn().mockResolvedValue(changed));
    await expect(request.run()).rejects.toMatchObject({ context: { code: "merge_settlement_review_required" } });
    expect(mocks.git.mock.calls.some((call) => call[1][0] === "add")).toBe(false);
  });

  it("prepares a new receipt before applying and restores only that new index entry on failure", async () => {
    mocks.git.mockResolvedValue({ stdout: "" });
    const failed = invoke(preview(), false, vi.fn().mockRejectedValue(new Error("audit failed")));
    await expect(failed.run()).rejects.toThrow("audit failed");
    expect(mocks.git).toHaveBeenLastCalledWith("git", ["reset", "--quiet", "--", ":(literal).agents/pm/merge-receipts/receipt.json"], expect.any(Object));
    const success = invoke();
    expect((await success.run()).ok).toBe(true);
  });

  it("preserves an intentional staged receipt deletion", async () => {
    mocks.git.mockResolvedValue({ stdout: "" }).mockImplementation(async (_command, args) => ({ stdout: args.includes("--diff-filter=D") ? "deleted\0" : "" }));
    const request = invoke();
    await expect(request.run()).rejects.toMatchObject({ context: { code: "merge_settlement_review_required" } });
    expect(request.apply).not.toHaveBeenCalled();
  });
});
