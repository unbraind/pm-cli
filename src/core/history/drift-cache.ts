/**
 * @module core/history/drift-cache
 *
 * Invalidates derived history-chain verification state after committed writes.
 */
import fs from "node:fs/promises";
import path from "node:path";

const DRIFT_CACHE_RELATIVE_PATH = path.join(
  "runtime",
  "history-drift-cache.json",
);

/** Remove the derived drift cache after a history mutation; a missing or concurrently removed cache is already invalidated. */
export async function invalidateHistoryDriftCache(
  pmRoot: string,
): Promise<void> {
  try {
    await fs.rm(path.join(pmRoot, DRIFT_CACHE_RELATIVE_PATH), { force: true });
  } catch {
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
