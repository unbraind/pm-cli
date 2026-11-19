/**
 * @module sdk/extension/managed-update-status
 *
 * Projects bounded remote freshness without mutating durable installation records.
 */
import { mapWithFixedConcurrency } from "./concurrency.js";
import { sortManagedEntries, type ManagedExtensionState } from "./managed-state.js";
import { checkGithubUpdate, checkNpmUpdate, resolveExtensionUpdateCheckTimeoutMs, updateCheckTeardown } from "./update-check.js";
import type { ManagedExtensionRecord } from "./managed-state.js";

const MANAGED_UPDATE_CHECK_CONCURRENCY = 4;

/** A counting semaphore: `acquire` waits for a free permit, `release` hands it to the next waiter. */
function createPermits(limit: number): { acquire(): Promise<void>; release(): void } {
  let free = limit;
  const waiters: Array<() => void> = [];
  return {
    acquire: () => {
      if (free > 0) {
        free -= 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    release: () => {
      const next = waiters.shift();
      if (next) next();
      else free += 1;
    },
  };
}

/** Carry `update_check_timeout_ms` only when this check's lookup ran out of its budget. */
function withUpdateCheckTimeout(entry: ManagedExtensionRecord, timeoutMs: number | undefined): ManagedExtensionRecord {
  const { update_check_timeout_ms: _previous, ...rest } = entry;
  return timeoutMs === undefined ? rest : { ...rest, update_check_timeout_ms: timeoutMs };
}

/**
 * Return transient provider evidence while preserving the caller's recorded
 * installation state. `timeoutMs` is the budget of each lookup, by default the
 * one `PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS` configures. With
 * `holdPermitsThroughTeardown` (the default) a timed-out provider keeps its
 * permit until its teardown finishes, so no more than the limit are ever
 * alive; a caller holding a lock passes `false` so the next lookup never waits
 * for a teardown inside it, as before teardowns existed.
 */
export async function refreshManagedExtensionUpdates(
  state: ManagedExtensionState,
  offline = false,
  timeoutMs: number = resolveExtensionUpdateCheckTimeoutMs(),
  holdPermitsThroughTeardown = true,
): Promise<ManagedExtensionState> {
  // Results are reported as soon as each lookup settles, never after a
  // teardown.
  const providers = createPermits(MANAGED_UPDATE_CHECK_CONCURRENCY);
  const entries = await mapWithFixedConcurrency(state.entries, MANAGED_UPDATE_CHECK_CONCURRENCY, async (entry) => {
    if (!["github", "npm"].includes(entry.source.kind)) return entry;
    if (offline) return withUpdateCheckTimeout({
      ...entry, last_update_check_at: undefined, last_update_remote_commit: undefined,
      last_update_remote_version: undefined, update_available: null, update_error: undefined,
    }, undefined);
    await providers.acquire();
    const updateStatus = entry.source.kind === "github"
      ? await checkGithubUpdate(entry.source, undefined, timeoutMs)
      : await checkNpmUpdate(entry.source, undefined, timeoutMs);
    if (holdPermitsThroughTeardown) void updateCheckTeardown(updateStatus).then(providers.release);
    else providers.release();
    return withUpdateCheckTimeout({
      ...entry,
      last_update_check_at: updateStatus.checked_at,
      last_update_remote_commit: "remote_commit" in updateStatus ? updateStatus.remote_commit : undefined,
      last_update_remote_version: "remote_version" in updateStatus ? updateStatus.remote_version : undefined,
      update_available: updateStatus.available,
      update_error: updateStatus.error,
    }, updateStatus.timeout_ms);
  });
  return { ...state, entries: sortManagedEntries(entries) };
}
