/** Keeps explicit tracker reconciliation independent of the invocation repository. */
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { runMergeReconcile } from "../../../../src/sdk/merge/reconcile.js";
import { listMergeReceipts, writeMergeReceipt } from "../../../../src/sdk/merge/receipts.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

it("ignores unrelated clone-local receipts when the requested tracker is outside Git", async () => {
  await withTempPmPath(async ({ tempRoot, pmPath }) => {
    const foreignRoot = path.join(tempRoot, "foreign");
    await mkdir(foreignRoot);
    execFileSync("git", ["init", "-q"], { cwd: foreignRoot });
    const receipt = await writeMergeReceipt({
      cwd: foreignRoot, itemPath: ".agents/pm/tasks/pm-foreign.toon",
      preferred: "ours", fieldsFromTheirs: [], unionFields: [], decisions: [],
    });
    expect(receipt).not.toBeNull();
    const previousCwd = process.cwd();
    try {
      process.chdir(foreignRoot);
      for (const dryRun of [true, false]) {
        const result = await runMergeReconcile({ dryRun }, { path: pmPath });
        expect(result).toMatchObject({
          ok: true, receipts: { pending_before: 0, reconciled: 0 },
          repair: { streams: [], totals: { failed: 0 } },
        });
      }
      expect(await listMergeReceipts(foreignRoot)).toMatchObject([
        { id: receipt!.id, state: "pending" },
      ]);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
