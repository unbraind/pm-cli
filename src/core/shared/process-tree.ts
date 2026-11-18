/**
 * @module core/shared/process-tree
 *
 * Tears down a child process together with its descendants, so a deadline
 * leaves no grandchild running or holding the parent's pipes.
 */
import { spawn } from "node:child_process";

/* c8 ignore start -- process-tree teardown paths are highly platform-dependent. */
/**
 * Kill the process tree rooted at `pid`. On Windows this runs
 * `taskkill /T /F`, which walks the tree from the live root, so a descendant
 * whose launcher already exited is not reached. Elsewhere it signals the
 * process group led by `pid` (the child must have been spawned with
 * `detached: true`), which reaches such a descendant too, and falls back to
 * the process itself. A process that is already gone is not an error.
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // Fall back to direct child kill when no process group is available.
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process can already be gone.
  }
}
/* c8 ignore stop */
