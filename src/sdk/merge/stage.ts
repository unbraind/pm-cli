/** Guarded staging of authenticated, lossless reconciliation artifacts before a merge commit. */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { findGitWorkspaceRoot } from "./install.js";
import { gitWorkspaceEnvironment } from "./worktree-config.js";
import { isPathOutsideRoot } from "../workspace.js";
import type { MergeReconcileResult } from "./reconcile.js";

const execFileAsync = promisify(execFile);

/** Refuse staging without changing the index; operators retain the explicit review path. */
function stagingRefusal(reason: string): PmCliError {
  return new PmCliError(`Automatic merge settlement refused: ${reason}`, EXIT_CODE.CONFLICT, {
    code: "merge_settlement_review_required",
    recovery: { suggested_retry: "pm merge reconcile --dry-run" },
    nextSteps: ["Inspect receipts, repair streams and Git changes. Resolve competing values or unrelated drift explicitly, then run pm merge reconcile and stage the reviewed artifacts manually."],
  });
}

/** Do not stage the ordinary workspace index on behalf of a commit using another index. */
async function assertNormalGitIndex(git: (args: string[]) => Promise<{ stdout: string }>): Promise<void> {
  const indexOverride = process.env.GIT_INDEX_FILE;
  if (indexOverride === undefined) return;
  const indexPath = (await git(["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim();
  if (path.resolve(indexOverride) !== path.resolve(indexPath)) throw stagingRefusal("an alternate Git index requires explicit manual settlement");
}

/** Accept only complete, receipt-backed previews without discarded values or unrelated repairs. */
function assertLosslessPreview(preview: MergeReconcileResult): void {
  if (preview.repair.totals.failed > 0 || preview.receipts.missing_history_references_after > 0 ||
    preview.receipts.summaries.some((receipt) => receipt.conflict_fields.length > 0) ||
    preview.repair.streams.some((stream) => stream.merge_receipt_proof?.trusted !== true) ||
    preview.validation.checks.some((check) => check.name !== "history_drift" && check.status !== "ok")) {
    throw stagingRefusal("only fully authenticated receipt-backed repairs without discarded values can be staged");
  }
}

/** Stage only the verified history and receipt paths, preserving all unrelated index entries. */
export async function stageLosslessMergeReconciliation(params: {
  preview: MergeReconcileResult;
  dryRun: boolean;
  global: GlobalOptions;
  apply: () => Promise<MergeReconcileResult>;
}): Promise<MergeReconcileResult> {
  const { preview } = params;
  assertLosslessPreview(preview);
  const pmRoot = resolvePmRoot(process.cwd(), params.global.path);
  const workspaceRoot = await findGitWorkspaceRoot(pmRoot);
  if (workspaceRoot === null) throw stagingRefusal("a Git workspace is required");
  const git = (args: string[]) => execFileAsync("git", args, { cwd: workspaceRoot, env: gitWorkspaceEnvironment(), timeout: 10_000 });
  await assertNormalGitIndex(git);
  const unmerged = await git(["ls-files", "--unmerged", "-z"]);
  if (unmerged.stdout.length > 0) throw stagingRefusal("Git still has unresolved paths");
  const paths = [...new Set([
    ...preview.repair.streams.map((stream) => path.join(pmRoot, "history", `${stream.id}.jsonl`)),
    ...preview.receipts.summaries.map((receipt) => path.join(pmRoot, "merge-receipts", `${receipt.receipt_id}.json`)),
  ])].map((target) => path.relative(workspaceRoot, target).replaceAll("\\", "/"));
  if (paths.some(isPathOutsideRoot)) {
    throw stagingRefusal("reconciliation artifacts must belong to this Git workspace");
  }
  const pathspecs = paths.map((target) => `:(literal)${target}`);
  if (pathspecs.length > 0) {
    try {
      await git(["diff", "--quiet", "--", ...pathspecs]);
    } catch {
      throw stagingRefusal("reconciliation paths have unstaged edits or Git cannot verify their index state");
    }
  }
  if (params.dryRun) return { ...preview, staged_paths: [] };
  const result = await params.apply();
  if (!result.ok || JSON.stringify(result.receipts.summaries) !== JSON.stringify(preview.receipts.summaries) ||
    result.repair.streams.some((stream) => !preview.repair.streams.some((prior) => prior.id === stream.id))) {
    throw stagingRefusal("reconciliation changed or did not finish; inspect the audit artifacts before staging");
  }
  if (pathspecs.length > 0) await git(["add", "--", ...pathspecs]);
  return { ...result, staged_paths: paths, guidance: ["Lossless reconciliation artifacts are staged for the merge commit. Review git diff --cached before committing."] };
}
