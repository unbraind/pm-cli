/** Guarded staging of authenticated, lossless reconciliation artifacts before a merge commit. */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
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
type GitRunner = (args: string[]) => Promise<{ stdout: string }>;

/** Refuse staging without changing the index; operators retain the explicit review path. */
function stagingRefusal(reason: string): PmCliError {
  return new PmCliError(`Automatic merge settlement refused: ${reason}`, EXIT_CODE.CONFLICT, {
    code: "merge_settlement_review_required",
    recovery: { suggested_retry: "pm merge reconcile --dry-run" },
    nextSteps: ["Inspect receipts, repair streams and Git changes. Resolve competing values or unrelated drift explicitly, then run pm merge reconcile and stage the reviewed artifacts manually."],
  });
}

/** Do not stage the ordinary workspace index on behalf of a commit using another index. */
async function assertNormalGitIndex(git: GitRunner): Promise<void> {
  const indexOverride = process.env.GIT_INDEX_FILE;
  if (indexOverride === undefined) return;
  const indexPath = (await git(["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim();
  if (path.resolve(indexOverride) !== path.resolve(indexPath)) throw stagingRefusal("an alternate Git index requires explicit manual settlement");
}

/** Prepare only new receipt entries; an intentional indexed deletion remains operator policy. */
async function newReceiptPaths(git: GitRunner, receiptPaths: string[]): Promise<string[]> {
  if (receiptPaths.length === 0) return [];
  const pathspecs = receiptPaths.map((target) => `:(literal)${target}`);
  const indexed = new Set((await git(["ls-files", "--cached", "-z", "--", ...pathspecs])).stdout.split("\0"));
  const missing = receiptPaths.filter((target) => !indexed.has(target)).map((target) => `:(literal)${target}`);
  if (missing.length > 0 && (await git(["diff", "--cached", "--name-only", "--diff-filter=D", "-z", "--", ...missing])).stdout.length > 0) {
    throw stagingRefusal("a receipt has a staged deletion that requires explicit review");
  }
  return missing;
}

/** Make new sidecars portable before auditing, reverting only their new index entries if settlement fails. */
async function applyAndStage(params: {
  git: GitRunner; preview: MergeReconcileResult; paths: string[]; newReceiptPathspecs: string[];
  apply: () => Promise<MergeReconcileResult>;
}): Promise<MergeReconcileResult> {
  const { git, preview, paths, newReceiptPathspecs } = params;
  let preparedReceipts = false;
  try {
    if (newReceiptPathspecs.length > 0) {
      await git(["add", "--", ...newReceiptPathspecs]);
      preparedReceipts = true;
    }
    const result = await params.apply();
    if (!result.ok || JSON.stringify(result.receipts.summaries) !== JSON.stringify(preview.receipts.summaries) ||
      result.repair.streams.some((stream) => !preview.repair.streams.some((prior) => prior.id === stream.id))) {
      throw stagingRefusal("reconciliation changed or did not finish; inspect the audit artifacts before staging");
    }
    if (paths.length > 0) await git(["add", "--", ...paths.map((target) => `:(literal)${target}`)]);
    return { ...result, staged_paths: paths, guidance: ["Lossless reconciliation artifacts are staged for the merge commit. Review git diff --cached before committing."] };
  } catch (error: unknown) {
    // Only these originally untracked entries were prepared by this call.
    // A path-scoped reset preserves their files and every unrelated index entry.
    if (preparedReceipts) await git(["reset", "--quiet", "--", ...newReceiptPathspecs]);
    throw error;
  }
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

/** Bind preview, proof verification and staging to one physical tracker location. */
export async function resolveMergeSettlementGlobal(global: GlobalOptions): Promise<GlobalOptions & { path: string }> {
  try { return { ...global, path: await realpath(resolvePmRoot(process.cwd(), global.path)) }; }
  catch { throw stagingRefusal("the tracker root cannot be resolved"); }
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
  const { path: pmRoot } = await resolveMergeSettlementGlobal(params.global);
  const workspaceRoot = await findGitWorkspaceRoot(pmRoot);
  if (workspaceRoot === null) throw stagingRefusal("a Git workspace is required");
  const git = (args: string[]) => execFileAsync("git", args, { cwd: workspaceRoot, env: gitWorkspaceEnvironment(), timeout: 10_000 });
  await assertNormalGitIndex(git);
  const unmerged = await git(["ls-files", "--unmerged", "-z"]);
  if (unmerged.stdout.length > 0) throw stagingRefusal("Git still has unresolved paths");
  const paths = [...new Set([
    ...[...new Set([...preview.repair.streams.map((stream) => stream.id), ...preview.receipts.summaries.map((receipt) => receipt.item_id)])].map((id) => path.join(pmRoot, "history", `${id}.jsonl`)),
    ...preview.receipts.summaries.map((receipt) => path.join(pmRoot, "merge-receipts", `${receipt.receipt_id}.json`)),
  ])].map((target) => path.relative(workspaceRoot, target).replaceAll("\\", "/"));
  if (paths.some(isPathOutsideRoot)) {
    throw stagingRefusal("reconciliation artifacts must belong to this Git workspace");
  }
  const pathspecs = paths.map((target) => `:(literal)${target}`);
  const receiptPaths = preview.receipts.summaries.map((receipt) => path.relative(workspaceRoot, path.join(pmRoot, "merge-receipts", `${receipt.receipt_id}.json`)).replaceAll("\\", "/"));
  if (pathspecs.length > 0) {
    try {
      await git(["diff", "--quiet", "--", ...pathspecs]);
    } catch {
      throw stagingRefusal("reconciliation paths have unstaged edits or Git cannot verify their index state");
    }
  }
  const newReceiptPathspecs = await newReceiptPaths(git, receiptPaths);
  if (params.dryRun) return { ...preview, staged_paths: [] };
  return applyAndStage({ ...params, git, paths, newReceiptPathspecs });
}
