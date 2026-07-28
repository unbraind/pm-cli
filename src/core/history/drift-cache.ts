/**
 * @module core/history/drift-cache
 *
 * Invalidates derived history-chain verification state after committed writes.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { writeStderr } from "../output/output.js";

const DRIFT_CACHE_RELATIVE_PATH = path.join(
  "runtime",
  "history-drift-cache.json",
);
const DRIFT_CACHE_ERROR_CODES: Readonly<Record<string, string>> = {
  EINVAL: "invalid_cache_path",
  EISDIR: "cache_path_is_directory",
  ENOENT: "invalid_cache_path",
  ENOTDIR: "invalid_cache_path",
  ERR_FS_EISDIR: "cache_path_is_directory",
};

/** Remove the derived drift cache after a history mutation; a missing or concurrently removed cache is already invalidated. */
export async function invalidateHistoryDriftCache(
  pmRoot: string,
): Promise<void> {
  const cachePath = path.join(pmRoot, DRIFT_CACHE_RELATIVE_PATH);
  let pmRootIsDirectory = false;
  try {
    pmRootIsDirectory = (
      await fs.stat(await fs.realpath(pmRoot))
    ).isDirectory();
  } catch {
    // The semantic classification below treats an invalid tracker root
    // independently from platform-specific filesystem error codes.
  }
  if (!pmRootIsDirectory) {
    writeStderr(
      "[pm] warning: history_drift_cache_invalidation_failed:invalid_cache_path\n",
    );
    return;
  }
  try {
    await fs.rm(cachePath, { force: true });
  } catch (error) {
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    if (errorCode === "ENOENT") {
      return;
    }
    const code =
      errorCode === undefined
        ? "unknown"
        : (DRIFT_CACHE_ERROR_CODES[errorCode] ?? "filesystem_error");
    writeStderr(
      `[pm] warning: history_drift_cache_invalidation_failed:${code}\n`,
    );
    // Derived cache invalidation is best effort and must never roll back a
    // successfully committed history mutation.
  }
}

/** Resolve a conventional tracker root from a history stream path and invalidate its derived verification cache. */
export async function invalidateHistoryDriftCacheForPath(
  historyPath: string,
): Promise<void> {
  const historyDirectory = path.dirname(path.resolve(historyPath));
  if (path.basename(historyDirectory) !== "history") {
    return;
  }
  await invalidateHistoryDriftCache(path.dirname(historyDirectory));
}
