/**
 * @module core/shared/process-tree
 *
 * Tears down a child process together with its live descendants, so a
 * deadline leaves no grandchild running or holding the parent's pipes.
 */
import { spawn, spawnSync } from "node:child_process";

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
 * List the live descendants of `pid`, deepest first, from one `ps` snapshot.
 * A process whose parent already exited has been re-parented and is not
 * listed. Returns an empty list when `ps` is unavailable.
 */
function listPosixDescendants(pid: number): number[] {
  const snapshot = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5_000 });
  if (snapshot.status !== 0 || typeof snapshot.stdout !== "string") return [];
  const children = new Map<number, number[]>();
  for (const line of snapshot.stdout.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/u).map(Number);
    if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
    children.set(parent!, [...(children.get(parent!) ?? []), child!]);
  }
  const descendants: number[] = [];
  const pending = [...(children.get(pid) ?? [])];
  while (pending.length > 0) {
    const next = pending.shift()!;
    if (descendants.includes(next) || next === pid) continue;
    descendants.push(next);
    pending.push(...(children.get(next) ?? []));
  }
  return descendants.reverse();
}

/**
 * Kill the process tree rooted at `pid`. On Windows this runs
 * `taskkill /T /F`; when `taskkill` cannot start or fails, the root itself is
 * still killed. Elsewhere it signals the process group led by `pid` when the
 * child was spawned with `detached: true`; otherwise it kills the live
 * descendants found by `ps`, then the process itself. Either way the tree is
 * walked from the live root, so a descendant whose launcher already exited is
 * not reached. A process that is already gone is not an error.
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
    // Not a process-group leader: walk its live descendants instead.
  }
  for (const descendant of listPosixDescendants(pid)) killProcess(descendant);
  killProcess(pid);
}
/* c8 ignore stop */
