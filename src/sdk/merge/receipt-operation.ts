/**
 * @module sdk/merge/receipt-operation
 * Records Git coordinates that let reconciliation prove a rebase restored its original state.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readBoundedRegularFile } from "./receipt-file-boundary.js";

const execFileAsync = promisify(execFile);
const GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

/** Immutable pre-rebase coordinates, without branch names or item contents. */
export interface MergeReceiptOperation {
  /** Git operation whose original state can be checked after it ends. */
  kind: "rebase";
  /** Commit from which the rebase began. */
  original_head: string;
  /** Original item blob at that commit. */
  original_blob: string;
}

/** Capture a rebase's original commit and item blob, or omit unprovable coordinates. */
export async function captureMergeReceiptOperation(
  cwd: string,
  itemPath: string,
): Promise<MergeReceiptOperation | undefined> {
  const trimmedItemPath = itemPath.trim();
  const normalizedItemPath =
    /^(['"])(.*)\1$/su.exec(trimmedItemPath)?.[2] ?? trimmedItemPath;
  for (const backend of ["rebase-merge", "rebase-apply"]) {
    try {
      const { stdout: marker } = await execFileAsync(
        "git",
        [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          `${backend}/orig-head`,
        ],
        { cwd, timeout: 10_000 },
      );
      const originalHead = (
        await readBoundedRegularFile(marker.trim(), 128)
      )?.trim();
      if (originalHead === undefined || !GIT_OBJECT_ID.test(originalHead))
        continue;
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", "--verify", `${originalHead}:${normalizedItemPath}`],
        { cwd, timeout: 10_000 },
      );
      const originalBlob = stdout.trim();
      return {
        kind: "rebase",
        original_head: originalHead,
        original_blob: originalBlob,
      };
    } catch {
      // No evidence is safer than inferring an abandoned operation from item drift.
    }
  }
  return undefined;
}

/** Validate only the bounded, privacy-safe operation schema accepted by receipt readers. */
export function isMergeReceiptOperation(
  value: unknown,
): value is MergeReceiptOperation {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    record.kind === "rebase" &&
    typeof record.original_head === "string" &&
    GIT_OBJECT_ID.test(record.original_head) &&
    typeof record.original_blob === "string" &&
    GIT_OBJECT_ID.test(record.original_blob)
  );
}

/** Prove HEAD, index, and working item all match the captured origin after Git leaves the operation. */
export async function isOriginalGitStateRestored(
  cwd: string,
  itemPath: string,
  operation: MergeReceiptOperation,
  expectedItemRaw?: string,
): Promise<boolean> {
  if (expectedItemRaw !== undefined) {
    const snapshotBlob = createHash(
      operation.original_blob.length === 40 ? "sha1" : "sha256",
    )
      .update(`blob ${Buffer.byteLength(expectedItemRaw)}\0`)
      .update(expectedItemRaw)
      .digest("hex");
    if (snapshotBlob !== operation.original_blob) return false;
  }
  try {
    const { stdout: gitDirectory } = await execFileAsync(
      "git",
      ["rev-parse", "--absolute-git-dir"],
      { cwd, timeout: 10_000 },
    );
    const activeMarkers = new Set([
      "rebase-merge",
      "rebase-apply",
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
    ]);
    if (
      (await readdir(gitDirectory.trim())).some((entry) =>
        activeMarkers.has(entry),
      )
    )
      return false;
    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd,
      timeout: 10_000,
    });
    if (head.trim() !== operation.original_head) return false;
    const { stdout: originalBlob } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", `HEAD:${itemPath}`],
      { cwd, timeout: 10_000 },
    );
    if (originalBlob.trim() !== operation.original_blob) return false;
    const { stdout: blob } = await execFileAsync(
      "git",
      ["hash-object", "--", path.resolve(cwd, itemPath)],
      { cwd, timeout: 10_000 },
    );
    if (blob.trim() !== operation.original_blob) return false;
    await execFileAsync(
      "git",
      ["diff", "--cached", "--quiet", "HEAD", "--", itemPath],
      { cwd, timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}
