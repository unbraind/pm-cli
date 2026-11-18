/**
 * @module sdk/extension/update-check
 *
 * Provides bounded and annotated-tag-aware update checks for managed extensions.
 */
import { nowIso } from "../../core/shared/time.js";
import { spawn } from "node:child_process";
import npa from "npm-package-arg";
import { killProcessTree } from "../../core/shared/process-tree.js";
import type { ManagedExtensionSource } from "./managed-state.js";
import { resolveNpmCommandName, shouldRunNpmCommandInShell } from "./install-sources.js";

/** Environment variable that overrides the per-lookup update-check budget. */
export const PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS_ENV = "PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS";
/** Default budget of one managed-extension update lookup. */
export const EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS = 10_000;
const EXTENSION_UPDATE_CHECK_TIMEOUT_MIN_MS = 1_000;
const EXTENSION_UPDATE_CHECK_TIMEOUT_MAX_MS = 120_000;

/** Stable reason for an npm lookup that failed for any reason other than its budget. */
export const NPM_REGISTRY_LOOKUP_FAILED = "npm_registry_lookup_failed";
/** Stable reason for an npm lookup killed when its budget ran out (pm-5kfzjh). */
export const NPM_REGISTRY_LOOKUP_TIMED_OUT = "npm_registry_lookup_timed_out";
/** Stable reason for a `git ls-remote` lookup that failed for any reason other than its budget. */
export const GITHUB_REMOTE_LOOKUP_FAILED = "github_remote_lookup_failed";
/** Stable reason for a `git ls-remote` lookup killed when its budget ran out (pm-43p2c3). */
export const GITHUB_REMOTE_LOOKUP_TIMED_OUT = "github_remote_lookup_timed_out";

/**
 * Resolve the budget of one update lookup: `PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS`
 * as integer milliseconds, clamped to 1000–120000, or the 10000 ms default when
 * it is unset or not a finite number.
 */
export function resolveExtensionUpdateCheckTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS_ENV]?.trim();
  const configured = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(configured)) return EXTENSION_UPDATE_CHECK_TIMEOUT_DEFAULT_MS;
  return Math.min(EXTENSION_UPDATE_CHECK_TIMEOUT_MAX_MS, Math.max(EXTENSION_UPDATE_CHECK_TIMEOUT_MIN_MS, Math.trunc(configured)));
}

/** Describes the remote revision health of one managed GitHub extension. */
export interface GithubUpdateStatus {
  /** Time at which the remote comparison completed. */
  checked_at: string;
  /** Whether the remote commit differs, or null when no comparison is possible. */
  available: boolean | null;
  /** Peeled remote commit when the selected reference resolves. */
  remote_commit?: string;
  /** Stable failure reason when the comparison is incomplete. */
  error?: string;
  /** Budget in milliseconds that ran out, present only with a `*_timed_out` reason. */
  timeout_ms?: number;
}

/** Result of comparing the installed npm identity with its registry latest dist-tag. */
export interface NpmUpdateStatus extends Omit<GithubUpdateStatus, "remote_commit"> {
  /** Registry version selected by the latest dist-tag, when valid. */
  remote_version?: string;
}

/** One bounded update lookup: run the provider command and return its trimmed stdout. */
type UpdateQueryRunner = (args: string[], timeoutMs: number) => Promise<string>;

/** Bounded lookup failure whose message is a stable reason, never the provider's own output. */
class UpdateQueryError extends Error {
  readonly timeout_ms: number | undefined;

  constructor(reason: string, timeoutMs?: number) {
    super(reason);
    this.name = "UpdateQueryError";
    this.timeout_ms = timeoutMs;
  }
}

/** Project a lookup failure onto a status: its message, and the budget when one ran out. */
function failedUpdateStatus(checkedAt: string, error: unknown): GithubUpdateStatus {
  const status: GithubUpdateStatus = { checked_at: checkedAt, available: null, error: error instanceof Error ? error.message : String(error) };
  if (error instanceof UpdateQueryError && error.timeout_ms !== undefined) status.timeout_ms = error.timeout_ms;
  return status;
}

/** How one provider lookup runs and which stable reasons it reports. */
interface UpdateQuerySpec {
  /** Environment of the provider process. */
  env: NodeJS.ProcessEnv;
  /** Run through the platform shell (the Windows npm shim needs it). */
  shell?: boolean;
  /** Largest stdout accepted, in bytes; more is a failed lookup. */
  maxBuffer: number;
  /** Reason for a lookup still running at its deadline. */
  timedOut: string;
  /** Reason for any other failure. */
  failed: string;
}

/**
 * Run one provider lookup under an explicit deadline. The deadline settles the
 * lookup as timed out on its own, without waiting for the child's pipes,
 * because a launcher (`cmd.exe`, an npm shim, `git`) can exit while a
 * descendant still holds them. It then kills the provider and its live
 * descendants (`taskkill /T` on Windows, a `ps` tree walk elsewhere), which
 * reaches the helpers of a launcher that is still running, as `cmd.exe` and
 * `git` are while they wait for npm and the remote helper; when that teardown
 * cannot run, the direct child is still killed through its handle. A launcher
 * that already exited is never torn down by its possibly reused PID. A child
 * that exits after the deadline, cleanly or not, cannot replace the timed-out
 * result with partial output, and a failed exit settles at once even while a
 * descendant holds stdout. The child is neither detached nor hidden from the
 * console, so a terminal Ctrl-C reaches it as it reaches the host. Any other
 * failure, including stdout beyond `maxBuffer`, reports the failed reason.
 * stdin and stderr are ignored, so the provider's command line, stderr and
 * environment never reach the reason.
 */
function runBoundedUpdateQuery(file: string, args: string[], timeout: number, spec: UpdateQuerySpec): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let child;
    try {
      // stderr is ignored rather than piped, so a descendant that inherits
      // only stderr cannot hold the lookup open.
      child = spawn(file, args, { env: spec.env, shell: spec.shell, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      reject(new UpdateQueryError(spec.failed));
      return;
    }
    const lookup = child;
    let settled = false;
    let stdout = "";
    let stdoutBytes = 0;
    const exited = (): boolean => lookup.exitCode !== null || lookup.signalCode !== null;
    const killDirectChild = (): void => {
      if (!exited()) lookup.kill("SIGKILL");
    };
    const stop = (): void => {
      lookup.stdout.destroy();
      // Once the launcher has exited its PID may already belong to another
      // process, so only a live launcher's tree is torn down by PID; its root
      // is killed through Node's handle.
      if (exited() || lookup.pid === undefined) killDirectChild();
      else void killProcessTree(lookup.pid, killDirectChild).then(killDirectChild, killDirectChild);
    };
    const deadline = setTimeout(() => {
      settle(new UpdateQueryError(spec.timedOut, timeout));
      stop();
    }, timeout);
    function settle(error?: UpdateQueryError): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(stdout.trim());
    }
    lookup.stdout.setEncoding("utf8");
    lookup.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > spec.maxBuffer) {
        settle(new UpdateQueryError(spec.failed));
        stop();
        return;
      }
      stdout += chunk;
    });
    lookup.on("error", () => settle(new UpdateQueryError(spec.failed)));
    // A provider that fails has nothing more to say: settle at its exit even
    // if a descendant still holds stdout. A successful exit waits for close,
    // so the result is the complete output.
    lookup.on("exit", (code, signal) => {
      if (code === 0 && signal === null) return;
      settle(new UpdateQueryError(spec.failed));
      lookup.stdout.destroy();
    });
    lookup.on("close", (code, signal) => settle(code === 0 && signal === null ? undefined : new UpdateQueryError(spec.failed)));
  });
}

/** Resolve an exact registry version without reflecting untrusted provenance or metadata in diagnostics. */
function resolveExactNpmVersion(packageName: string, version: unknown, errorCode: string): string {
  if (typeof version === "string") {
    try {
      const parsed = npa.resolve(packageName, version);
      if (parsed.type === "version") return parsed.fetchSpec;
    } catch {
      // npm-package-arg errors contain raw input; report only the caller's stable reason.
    }
  }
  throw new Error(errorCode);
}

/**
 * Query npm's configured registry with bounded execution and no lifecycle
 * scripts. Registry configuration can contain credentials, so only the stable
 * reasons are reported.
 */
const runNpmUpdateQuery: UpdateQueryRunner = (args, timeout) =>
  runBoundedUpdateQuery(resolveNpmCommandName(), args, timeout, {
    env: { ...process.env, npm_config_ignore_scripts: "true" },
    shell: shouldRunNpmCommandInShell(),
    maxBuffer: 64 * 1024,
    timedOut: NPM_REGISTRY_LOOKUP_TIMED_OUT,
    failed: NPM_REGISTRY_LOOKUP_FAILED,
  });

/**
 * Query a GitHub remote with bounded execution. Git's terminal prompt and Git
 * Credential Manager's interactive prompts are disabled, so a remote that asks
 * for credentials through them fails at once; git's command line and stderr can
 * name the remote, a proxy or a local path, so only the stable reasons are
 * reported.
 */
const runGitUpdateQuery: UpdateQueryRunner = (args, timeout) =>
  runBoundedUpdateQuery("git", args, timeout, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    maxBuffer: 1024 * 1024,
    timedOut: GITHUB_REMOTE_LOOKUP_TIMED_OUT,
    failed: GITHUB_REMOTE_LOOKUP_FAILED,
  });

/** Compare recorded npm provenance without persisting diagnostic results or guessing missing versions. */
export async function checkNpmUpdate(
  source: ManagedExtensionSource,
  npmRunner: UpdateQueryRunner = runNpmUpdateQuery,
): Promise<NpmUpdateStatus> {
  const checkedAt = nowIso();
  try {
    if (source.kind !== "npm" || !source.package || !/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/u.test(source.package)) {
      throw new Error("missing_or_invalid_npm_package_identity");
    }
    const installedVersion = resolveExactNpmVersion(source.package, source.version, "missing_or_invalid_installed_npm_version");
    const registryOutput = await npmRunner(["view", source.package, "dist-tags.latest", "--json", "--ignore-scripts"], resolveExtensionUpdateCheckTimeoutMs());
    let output: unknown;
    try {
      output = JSON.parse(registryOutput);
    } catch {
      throw new Error("invalid_npm_registry_metadata");
    }
    const version: unknown = Array.isArray(output) && output.length === 1 ? output[0] : output;
    const latestVersion = resolveExactNpmVersion(source.package, version, "invalid_npm_registry_version");
    return { checked_at: checkedAt, available: latestVersion !== installedVersion, remote_version: latestVersion };
  } catch (error: unknown) {
    return failedUpdateStatus(checkedAt, error);
  }
}

/** Compare ls-remote output with an optional installed revision baseline. */
const resolveGithubUpdateOutput = (
  output: string,
  installedCommitInput: string | undefined,
  checkedAt: string,
): GithubUpdateStatus => {
  const references = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [commit, ref = ""] = line.split(/\s+/) as [string, string?];
      return { commit, ref };
    });
  const remoteReference =
    references.find((reference) => reference.ref.endsWith("^{}")) ??
    references[0];
  if (!remoteReference) {
    return {
      checked_at: checkedAt,
      available: null,
      error: "no_remote_reference_found",
    };
  }
  const installedCommit = installedCommitInput?.trim();
  return installedCommit
    ? {
        checked_at: checkedAt,
        remote_commit: remoteReference.commit,
        available: remoteReference.commit !== installedCommit,
      }
    : {
        checked_at: checkedAt,
        remote_commit: remoteReference.commit,
        available: null,
        error: "missing_installed_commit",
      };
};

/** Compare one managed GitHub extension against its remote revision. */
export const checkGithubUpdate = async (
  source: ManagedExtensionSource,
  gitCommandRunner: UpdateQueryRunner = runGitUpdateQuery,
): Promise<GithubUpdateStatus> => {
  const checkedAt = nowIso();
  if (source.kind !== "github" || !source.repository) {
    return {
      checked_at: checkedAt,
      available: null,
      error: "not_a_github_managed_source",
    };
  }
  try {
    const ref = [source.ref?.trim(), "HEAD"].find(Boolean) as string;
    const output = await gitCommandRunner(
      ["ls-remote", source.repository, ref, `${ref}^{}`],
      resolveExtensionUpdateCheckTimeoutMs(),
    );
    return resolveGithubUpdateOutput(output, source.commit, checkedAt);
  } catch (error: unknown) {
    return failedUpdateStatus(checkedAt, error);
  }
};
