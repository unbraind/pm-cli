/**
 * @module core/shared/process-tree
 *
 * Tears down a child process together with its live descendants, so a
 * deadline leaves no grandchild running or holding the parent's pipes.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Longest a teardown helper (`ps`, `taskkill`) may run before it is abandoned.
 * Both normally finish in milliseconds; the bound keeps a lookup's permit, and
 * any lock its caller holds, from waiting long on a stalled helper.
 */
const TEARDOWN_HELPER_TIMEOUT_MS = 2_000;

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

/** One descendant from a process table, with the parent it had in that snapshot. */
export interface ProcessTableDescendant {
  /** Process id the snapshot listed for the descendant. */
  pid: number;
  /** Process id of the descendant's parent in that snapshot. */
  parent: number;
}

/**
 * Read the live descendants of `root`, deepest first, from a process table in
 * `ps -A -o pid= -o ppid=` form (one `pid ppid` pair per line), each with its
 * parent in that snapshot. Malformed lines are skipped, and each process is
 * listed once even if the table holds a cycle. A process whose parent already
 * exited has been re-parented, so it is not a descendant.
 */
export function descendantEntriesFromProcessTable(table: string, root: number): ProcessTableDescendant[] {
  // Linear in the table: children are appended in place and the queue is
  // walked by index, so a host with many processes never stalls teardown.
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 2) continue;
    const [child, parent] = fields.map(Number) as [number, number];
    if (!Number.isSafeInteger(child) || !Number.isSafeInteger(parent) || child <= 0) continue;
    const siblings = children.get(parent);
    if (siblings) siblings.push(child);
    else children.set(parent, [child]);
  }
  const seen = new Set<number>([root]);
  const descendants: ProcessTableDescendant[] = [];
  const pending: ProcessTableDescendant[] = (children.get(root) ?? []).map((pid) => ({ pid, parent: root }));
  for (let index = 0; index < pending.length; index += 1) {
    const next = pending[index] as ProcessTableDescendant;
    if (seen.has(next.pid)) continue;
    seen.add(next.pid);
    descendants.push(next);
    for (const grandchild of children.get(next.pid) ?? []) pending.push({ pid: grandchild, parent: next.pid });
  }
  return descendants.reverse();
}

/** The live descendants of `root`, deepest first, as PIDs; see {@link descendantEntriesFromProcessTable}. */
export function descendantsFromProcessTable(table: string, root: number): number[] {
  return descendantEntriesFromProcessTable(table, root).map((entry) => entry.pid);
}

/**
 * Whether `pid` still has the parent the snapshot recorded, read from
 * `/proc/<pid>/stat` right before it is signalled. A PID that exited and was
 * reused after the snapshot almost always has another parent, so it is
 * skipped. Without procfs (macOS, BSD) the snapshot is trusted as it stands.
 */
export function parentStillMatches(
  entry: ProcessTableDescendant,
  readStat: (file: string) => string | undefined = readProcStat,
): boolean {
  const stat = readStat(`/proc/${entry.pid}/stat`);
  if (stat === undefined) return !existsSync("/proc/self/stat");
  // The command name is parenthesised and may hold spaces or parentheses, so
  // the fields are read after its last closing parenthesis: state, then ppid.
  const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u);
  return Number(fields[1]) === entry.parent;
}

/**
 * Whether the process table describes this process's own PID namespace. With
 * procfs, the `NSpid` line of `/proc/self/status` must hold a single entry
 * equal to this process's PID: more entries mean this `/proc` belongs to an
 * outer namespace, whose PIDs `process.kill` would read differently, and a
 * kernel without `NSpid` gives no evidence either way, so neither is walked.
 * On Linux an unreadable `/proc/self/status` is unverified too; only a system
 * without procfs, which has no PID namespaces to confuse, needs no evidence.
 */
export function processTableSharesNamespace(
  readStatus: (file: string) => string | undefined = readProcStat,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const status = readStatus("/proc/self/status");
  if (status === undefined) return platform !== "linux" && !existsSync("/proc/self/status");
  const nspid = /^NSpid:\s*(.*)$/mu.exec(status)?.[1]?.trim().split(/\s+/u);
  return nspid?.length === 1 && Number(nspid[0]) === process.pid;
}

/**
 * Whether every link from `pid` up to `root` still has the parent the
 * snapshot recorded, so a reused intermediate PID cannot make an unrelated
 * process look like a descendant. Links are read right before the signal.
 */
export function ancestryStillMatches(
  pid: number,
  root: number,
  parentOf: ReadonlyMap<number, number>,
  matches: (entry: ProcessTableDescendant) => boolean = parentStillMatches,
  verified: Map<number, boolean> = new Map(),
): boolean {
  // Each link is read once per teardown, so a deep tree stays linear.
  const chain: number[] = [];
  let outcome = true;
  for (let current = pid; current !== root; ) {
    const known = verified.get(current);
    if (known !== undefined) {
      outcome = known;
      break;
    }
    chain.push(current);
    const parent = parentOf.get(current);
    if (parent === undefined || !matches({ pid: current, parent })) {
      outcome = false;
      break;
    }
    current = parent;
  }
  for (const link of chain) verified.set(link, outcome);
  return outcome;
}

function readProcStat(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The system `ps`, never one found through `PATH`: its output decides which
 * processes receive SIGKILL, so a workspace or toolchain must not shadow it.
 */
const TRUSTED_PS_PATHS = ["/bin/ps", "/usr/bin/ps"] as const;
/** The process-listing environment, independent of the caller's `ps` preferences. */
const PS_ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LC_ALL: "C" };

/** Return the first trusted `ps` that exists, or `undefined` when none does. */
export function resolveTrustedPs(exists: (file: string) => boolean = existsSync): string | undefined {
  return TRUSTED_PS_PATHS.find((file) => exists(file));
}

/**
 * The fully qualified Windows directory from `SystemRoot` or `windir`, or
 * `undefined` when neither names an absolute drive path: an empty, relative
 * or UNC value would let `taskkill.exe` resolve somewhere the host does not
 * control.
 */
export function resolveWindowsSystemRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // Keys are matched case-insensitively: a worker thread's env copy is case-sensitive.
  const valueOf = (name: string): string | undefined =>
    Object.entries(env).find(([key]) => key.toLowerCase() === name)?.[1];
  return [valueOf("systemroot"), valueOf("windir")].find(
    (candidate): candidate is string => typeof candidate === "string" && /^[A-Za-z]:[\\/]/u.test(candidate),
  );
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
export function runTeardownHelper(
  file: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string } | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let helper: ReturnType<typeof spawn>;
    try {
      helper = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, ...(env === undefined ? {} : { env }) });
    } catch {
      resolve(undefined);
      return;
    }
    const deadline = setTimeout(() => {
      settle(undefined);
      helper.stdout?.destroy();
      helper.kill("SIGKILL");
      // A helper that cannot die (a blocked kernel call) must not keep the host running.
      helper.unref();
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
 * `taskkill /T /F` from the System32 directory under a fully qualified
 * `SystemRoot` or `windir`, never a `taskkill` found through the working
 * directory or `PATH`; when no such directory is known, or taskkill cannot run
 * or fails, the root itself is still killed. `taskkill` names the root by PID, so a root that exits and has its
 * PID reused in the moment before `taskkill` opens it cannot be told apart;
 * only an OS containment mechanism (a job object) would close that window, and
 * Node exposes none. Elsewhere it signals the process group led by `pid` when the child
 * was spawned with `detached: true`; otherwise it kills the live descendants
 * listed by the system `ps` (`/bin/ps` or `/usr/bin/ps`, asynchronous and
 * bounded), then the root. The snapshot is used only when that `ps` exits
 * cleanly and `root.alive()` still holds after it is taken, so a PID reused
 * while `ps` ran is never walked; otherwise only the root is stopped. A
 * descendant is signalled only while `/proc` still names the parent the
 * snapshot recorded (on Linux), so a PID reused after the snapshot is skipped;
 * reuse in the microseconds between that check and the signal, or on a system
 * without procfs, is what PID-based signalling cannot rule out. Either way the tree is walked from the live root,
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
    await killWindowsTree(pid, root);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // Not a process-group leader: walk its live descendants instead.
  }
  await killPosixDescendants(pid, root);
  root.kill();
}

/** Run the System32 `taskkill /T /F`, killing the root itself when that cannot run or fails. */
async function killWindowsTree(pid: number, root: ProcessTreeRoot): Promise<void> {
  const systemRoot = resolveWindowsSystemRoot();
  if (systemRoot === undefined) {
    // No fully qualified system directory: never guess a taskkill path.
    if (root.alive()) root.kill();
    return;
  }
  const taskkill = path.win32.join(systemRoot, "System32", "taskkill.exe");
  const result = await runTeardownHelper(taskkill, ["/pid", String(pid), "/T", "/F"]);
  // A root that exited while taskkill ran may have a reused PID by now.
  if (result?.code !== 0 && root.alive()) root.kill();
}

/** Kill the live descendants of a root that is not a group leader, from one system `ps` snapshot. */
async function killPosixDescendants(pid: number, root: ProcessTreeRoot): Promise<void> {
  const ps = resolveTrustedPs();
  if (ps === undefined || !processTableSharesNamespace()) return;
  // A fixed environment: procps rejects -A under PS_PERSONALITY=bsd or CMD_ENV=bsd.
  const table = await runTeardownHelper(ps, ["-A", "-o", "pid=", "-o", "ppid="], PS_ENV);
  if (table?.code !== 0 || !root.alive()) return;
  const descendants = descendantEntriesFromProcessTable(table.stdout, pid);
  const parentOf = new Map(descendants.map((entry) => [entry.pid, entry.parent]));
  const verified = new Map<number, boolean>();
  for (const descendant of descendants) {
    if (ancestryStillMatches(descendant.pid, pid, parentOf, parentStillMatches, verified)) killProcess(descendant.pid);
  }
}
