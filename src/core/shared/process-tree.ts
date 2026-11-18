/**
 * @module core/shared/process-tree
 *
 * Tears down a child process together with its live descendants, so a
 * deadline leaves no grandchild running or holding the parent's pipes.
 */
import { spawn } from "node:child_process";
import path from "node:path";

/** Longest a teardown helper (`ps`, `taskkill`) may run before it is abandoned. */
const TEARDOWN_HELPER_TIMEOUT_MS = 10_000;

/**
 * Read the live descendants of `root`, deepest first, from a process table in
 * `ps -A -o pid= -o ppid=` form (one `pid ppid` pair per line). Malformed
 * lines are skipped, and each process is listed once even if the table holds
 * a cycle. A process whose parent already exited has been re-parented, so it
 * is not a descendant.
 */
export function descendantsFromProcessTable(table: string, root: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 2) continue;
    const [child, parent] = fields.map(Number) as [number, number];
    if (!Number.isSafeInteger(child) || !Number.isSafeInteger(parent) || child <= 0) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const seen = new Set<number>([root]);
  const descendants: number[] = [];
  const pending = [...(children.get(root) ?? [])];
  while (pending.length > 0) {
    const next = pending.shift() as number;
    if (seen.has(next)) continue;
    seen.add(next);
    descendants.push(next);
    pending.push(...(children.get(next) ?? []));
  }
  return descendants.reverse();
}

/* c8 ignore start -- process-tree teardown paths are highly platform-dependent. */
/** Kill `pid` itself, treating a process that is already gone as stopped. */
function killProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process can already be gone.
  }
}

/** Run a teardown helper with bounded time and collect its stdout; failures resolve to `undefined`. */
function runTeardownHelper(file: string, args: string[]): Promise<{ code: number | null; stdout: string } | undefined> {
  return new Promise((resolve) => {
    let stdout = "";
    let helper;
    try {
      helper = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: TEARDOWN_HELPER_TIMEOUT_MS });
    } catch {
      resolve(undefined);
      return;
    }
    helper.stdout.setEncoding("utf8");
    helper.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    helper.on("error", () => resolve(undefined));
    helper.on("close", (code) => resolve({ code, stdout }));
  });
}

/**
 * Kill the process tree rooted at `pid`. On Windows this runs the system
 * `taskkill /T /F` from System32, never a `taskkill` found through the
 * working directory or `PATH`; when it cannot run or fails, the root itself is
 * still killed. Elsewhere it signals the process group led by `pid` when the
 * child was spawned with `detached: true`; otherwise it kills the live
 * descendants listed by an asynchronous, bounded `ps`, then the root. Either
 * way the tree is walked from the live root, so a descendant whose launcher
 * already exited is not reached. `killRoot` replaces the PID-based kill of the
 * root, so a caller that holds the child's handle can kill it through that
 * handle. A process that is already gone is not an error.
 */
export async function killProcessTree(pid: number, killRoot: () => void = () => killProcess(pid)): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    const result = await runTeardownHelper(taskkill, ["/pid", String(pid), "/T", "/F"]);
    if (result?.code !== 0) killRoot();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // Not a process-group leader: walk its live descendants instead.
  }
  const table = await runTeardownHelper("ps", ["-A", "-o", "pid=", "-o", "ppid="]);
  for (const descendant of descendantsFromProcessTable(table?.stdout ?? "", pid)) killProcess(descendant);
  killRoot();
}
/* c8 ignore stop */
