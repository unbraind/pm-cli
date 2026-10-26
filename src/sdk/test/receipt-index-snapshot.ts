/** @module sdk/test/receipt-index-snapshot
 * Preserve source-index receipt authority in an independent snapshot namespace.
 */
import { execFile } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isFileMissingError } from "../../core/fs/fs-utils.js";
import { MERGE_RECEIPT_FILE_MAX_BYTES } from "../merge/receipt-file-boundary.js";
import { gitWorkspaceEnvironment } from "../merge/worktree-config.js";

const execFileAsync = promisify(execFile);
const RECEIPT_NAMESPACE = ".agents/pm/merge-receipts";

/** Copy only stage-zero source receipt blobs; never stage a copied working-tree value. */
export async function seedSnapshotReceiptIndex(sourceRoot: string, snapshotRoot: string, sourcePmRoot: string): Promise<void> {
  const directory = path.join(sourcePmRoot, "merge-receipts");
  const names = await readdir(directory).catch((error: unknown) => {
    if (isFileMissingError(error)) return [];
    throw error;
  });
  const { readIndexedReceiptBlobs } = await import("../merge/indexed-receipt-blobs.js");
  const blobs = names.length === 0 ? new Map<string, string>() : await readIndexedReceiptBlobs(sourceRoot, directory, names.filter((name) => name.endsWith(".json")), MERGE_RECEIPT_FILE_MAX_BYTES, await realpath(directory));
  const options = { cwd: snapshotRoot, env: gitWorkspaceEnvironment(), timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true };
  // The selected tracker can differ from the source's default tracker. Clear
  // inherited authority before rebasing the selected source index into it.
  await execFileAsync("git", ["rm", "-r", "--cached", "--ignore-unmatch", "--", RECEIPT_NAMESPACE], options);
  for (const [name, raw] of blobs) {
    const pending = execFileAsync("git", ["hash-object", "-w", "--stdin"], options);
    const input = pending.child.stdin;
    if (input !== null) {
      input.on("error", () => { pending.child.kill(); });
      input.end(raw);
    }
    const objectId = (await pending).stdout.trim();
    if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/u.test(objectId)) throw new Error("Invalid snapshot receipt object identity.");
    await execFileAsync("git", ["update-index", "--add", "--cacheinfo", "100644", objectId, `${RECEIPT_NAMESPACE}/${name}`], options);
  }
}
