import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalOptions } from "../../../src/core/shared/command-types.js";

const mocks = vi.hoisted(() => ({
  runHistoryRepairAll: vi.fn(),
  runValidate: vi.fn(),
}));

vi.mock("../../../src/sdk/history-repair.js", () => ({
  runHistoryRepairAll: mocks.runHistoryRepairAll,
}));
vi.mock("../../../src/sdk/governance/validate.js", () => ({
  runValidate: mocks.runValidate,
}));

import { runMergeReconcile } from "../../../src/sdk/merge/reconcile.js";

const globalOptions = { author: "global-author" } as GlobalOptions;

describe("merge reconciliation SDK", () => {
  beforeEach(() => {
    mocks.runHistoryRepairAll.mockReset();
    mocks.runValidate.mockReset();
  });

  it("previews with default attribution and tolerates validation warnings", async () => {
    mocks.runHistoryRepairAll.mockResolvedValue({ totals: { failed: 0 } });
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
    mocks.runHistoryRepairAll.mockResolvedValue({ totals: { failed: 0 } });
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
      },
      globalOptions,
    );
    expect(result.ok).toBe(true);
    expect(result.guidance[0]).toContain("Reconciliation is complete");

    mocks.runHistoryRepairAll.mockResolvedValueOnce({ totals: { failed: 1 } });
    mocks.runValidate.mockResolvedValueOnce({
      checks: [{ status: "warn" }],
      generated_at: "2026-07-21T00:02:00.000Z",
    });
    expect((await runMergeReconcile({}, globalOptions)).ok).toBe(false);
  });
});
