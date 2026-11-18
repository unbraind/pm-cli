/**
 * @module core/shared/process-tree
 *
 * Tears down a child process together with its descendants, so a deadline
 * leaves no grandchild running or holding the parent's pipes, and ties the
 * process groups of detached children to the host's own exit and interruption.
 */
import { spawn } from "node:child_process";

/* c8 ignore start -- process-tree teardown paths are highly platform-dependent. */
/** Kill `pid` itself, treating a process that is already gone as stopped. */
function killProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process can already be gone.
  }
}

/**
 * Kill the process tree rooted at `pid`. On Windows this runs
 * `taskkill /T /F`, which walks the tree from the live root, so a descendant
 * whose launcher already exited is not reached; when `taskkill` cannot start
 * or fails, the root itself is still killed. Elsewhere it signals the process
 * group led by `pid` (the child must have been spawned with `detached: true`),
 * which reaches such a descendant too, and falls back to the process itself.
 * A process that is already gone is not an error.
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    const treeKilled = await new Promise<boolean>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => resolve(false));
      killer.on("close", (code) => resolve(code === 0));
    });
    if (!treeKilled) killProcess(pid);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // Fall back to direct child kill when no process group is available.
  }
  killProcess(pid);
}
/* c8 ignore stop */

/** Signals that end the host by default and must take tracked groups with them. */
const TERMINATING_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const trackedGroups = new Set<number>();

/** Kill every tracked process group synchronously; the host's exit path runs nothing asynchronous. */
function killTrackedGroups(): void {
  for (const pid of trackedGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The group can already be gone.
    }
  }
}

function onTerminatingSignal(signal: NodeJS.Signals): void {
  // This listener is prepended, so it runs before the host's own listeners
  // and before Node removes a host's `once` listener: the count still sees
  // every handler the host registered for this signal.
  const hostHandlesSignal = process.listenerCount(signal) > 1;
  killTrackedGroups();
  trackedGroups.clear();
  uninstallGroupCleanup();
  // With this listener gone the signal's default action applies again, so
  // re-raising it ends the host exactly as it would have without tracking;
  // a host that handles the signal keeps its own handling.
  if (!hostHandlesSignal) process.kill(process.pid, signal);
}

function installGroupCleanup(): void {
  process.on("exit", killTrackedGroups);
  for (const signal of TERMINATING_SIGNALS) process.prependListener(signal, onTerminatingSignal);
}

function uninstallGroupCleanup(): void {
  process.off("exit", killTrackedGroups);
  for (const signal of TERMINATING_SIGNALS) process.off(signal, onTerminatingSignal);
}

/**
 * Tie the process group of a child spawned with `detached: true` to the host:
 * while it is tracked, the host's exit or a SIGINT, SIGTERM or SIGHUP kills
 * the group, which a detached group would otherwise survive because it no
 * longer shares the terminal's foreground process group. The returned function
 * stops tracking it; listeners exist only while some group is tracked. Windows
 * children are never detached, so nothing is tracked there.
 */
export function trackDetachedProcessGroup(pid: number | undefined): () => void {
  if (process.platform === "win32" || pid === undefined) return () => undefined;
  if (trackedGroups.size === 0) installGroupCleanup();
  trackedGroups.add(pid);
  return () => {
    if (!trackedGroups.delete(pid)) return;
    if (trackedGroups.size === 0) uninstallGroupCleanup();
  };
}
