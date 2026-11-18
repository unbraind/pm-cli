/**
 * @module core/shared/process-tree
 *
 * Tears down a child process together with its live descendants, so a
 * deadline leaves no grandchild running or holding the parent's pipes.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Longest a teardown helper (`ps`, `taskkill`) may run before it is abandoned. */
const TEARDOWN_HELPER_TIMEOUT_MS = 10_000;

/** How the caller identifies and kills the root it spawned. */
export interface ProcessTreeRoot {
  /** Kill the root, for example through Node's `ChildProcess` handle. */
  kill(): void;
  /**
   * Whether the root is still the process this caller spawned. A `ChildProcess`
   * that has not reported its exit is still unreaped, so its PID cannot have
   * been reused.
   */
  alive(): boolean;
}

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

/**
 * The system `ps`, never one found through `PATH`: its output decides which
 * processes receive SIGKILL, so a workspace or toolchain must not shadow it.
 */
const TRUSTED_PS_PATHS = ["/bin/ps", "/usr/bin/ps"] as const;

/** Return the first trusted `ps` that exists, or `undefined` when none does. */
export function resolveTrustedPs(exists: (file: string) => boolean = existsSync): string | undefined {
  return TRUSTED_PS_PATHS.find((file) => exists(file));
}

/** Kill `pid` itself, treating a process that is already gone as stopped. */
function killProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process can already be gone.
  }
}

/**
 * Run a teardown helper and collect its stdout. It settles on the helper's
 * exit or after a hard deadline, never waiting for pipes, and resolves to
 * `undefined` when the helper cannot start, fails to start or stalls.
 */
export function runTeardownHelper(file: string, args: string[]): Promise<{ code: number | null; stdout: string } | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let helper: ReturnType<typeof spawn>;
    try {
      helper = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve(undefined);
      return;
    }
    const deadline = setTimeout(() => {
      settle(undefined);
      helper.stdout?.destroy();
      helper.kill("SIGKILL");
    }, TEARDOWN_HELPER_TIMEOUT_MS);
    function settle(result: { code: number | null; stdout: string } | undefined): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    }
    // The error listener comes first: a spawn that ran out of descriptors can
    // return a child without stdio and report the error on the next tick.
    helper.on("error", () => settle(undefined));
    if (!helper.stdout) {
      settle(undefined);
      return;
    }
    helper.stdout.setEncoding("utf8");
    helper.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    helper.on("close", (code: number | null) => settle({ code, stdout }));
  });
}

/**
 * Kill the process tree rooted at `pid`. On Windows this runs the system
 * `taskkill /T /F` from System32, never a `taskkill` found through the working
 * directory or `PATH`; when it cannot run or fails, the root itself is still
 * killed. Elsewhere it signals the process group led by `pid` when the child
 * was spawned with `detached: true`; otherwise it kills the live descendants
 * listed by the system `ps` (`/bin/ps` or `/usr/bin/ps`, asynchronous and
 * bounded), then the root. The snapshot is used only when that `ps` exits
 * cleanly and `root.alive()` still holds after it is taken, so a PID reused
 * while `ps` ran is never walked; otherwise only the root is stopped. A
 * descendant can still exit and have its PID reused in the microseconds
 * between the snapshot and the signal, which PID-based signalling cannot rule
 * out. Either way the tree is walked from the live root,
 * so a descendant whose launcher already exited is not reached. Without
 * `root`, the root is killed by PID and is assumed to stay alive. A process
 * that is already gone is not an error.
 */
export async function killProcessTree(
  pid: number,
  root: ProcessTreeRoot = { kill: () => killProcess(pid), alive: () => true },
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    const result = await runTeardownHelper(taskkill, ["/pid", String(pid), "/T", "/F"]);
    if (result?.code !== 0) root.kill();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // Not a process-group leader: walk its live descendants instead.
  }
  const ps = resolveTrustedPs();
  const table = ps === undefined ? undefined : await runTeardownHelper(ps, ["-A", "-o", "pid=", "-o", "ppid="]);
  if (table?.code === 0 && root.alive()) {
    for (const descendant of descendantsFromProcessTable(table.stdout, pid)) killProcess(descendant);
  }
  root.kill();
}
