/**
 * @module sdk/extension/managed-update-status
 *
 * Projects bounded remote freshness without mutating durable installation records.
 */
import { mapWithFixedConcurrency } from "./concurrency.js";
import { sortManagedEntries, type ManagedExtensionState } from "./managed-state.js";
import { checkGithubUpdate, checkNpmUpdate } from "./update-check.js";

const MANAGED_UPDATE_CHECK_CONCURRENCY = 4;

/** Return transient provider evidence while preserving the caller's recorded installation state. */
export async function refreshManagedExtensionUpdates(
  state: ManagedExtensionState,
  offline = false,
): Promise<ManagedExtensionState> {
  const entries = await mapWithFixedConcurrency(state.entries, MANAGED_UPDATE_CHECK_CONCURRENCY, async (entry) => {
    if (!["github", "npm"].includes(entry.source.kind)) return entry;
    if (offline) return {
      ...entry, last_update_check_at: undefined, last_update_remote_commit: undefined,
      last_update_remote_version: undefined, update_available: null, update_error: undefined,
    };
    const updateStatus = entry.source.kind === "github"
      ? await checkGithubUpdate(entry.source)
      : await checkNpmUpdate(entry.source);
    return {
      ...entry,
      last_update_check_at: updateStatus.checked_at,
      last_update_remote_commit: "remote_commit" in updateStatus ? updateStatus.remote_commit : undefined,
      last_update_remote_version: "remote_version" in updateStatus ? updateStatus.remote_version : undefined,
      update_available: updateStatus.available,
      update_error: updateStatus.error,
    };
  });
  return { ...state, entries: sortManagedEntries(entries) };
}
