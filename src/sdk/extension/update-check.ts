/**
 * @module sdk/extension/update-check
 *
 * Provides bounded and annotated-tag-aware update checks for managed extensions.
 */
import { nowIso } from "../../core/shared/time.js";
import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import npa from "npm-package-arg";
import type { ManagedExtensionSource } from "./managed-state.js";
import { resolveNpmCommandName, shouldRunNpmCommandInShell } from "./install-sources.js";

const execFileAsync = promisify(execFile);

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

/** Stable reasons one provider reports for a lookup that ran out of its budget or failed otherwise. */
interface UpdateQueryReasons {
  timedOut: string;
  failed: string;
}

/**
 * Run one provider lookup under an explicit deadline that aborts the child.
 * A lookup still running when the deadline passes is reported as timed out
 * even if the child then exits cleanly, so a provider that handles the
 * signal cannot pass partial output off as a result. Any other failure,
 * including an overflowing output buffer, reports the failed reason. The
 * provider's command line, stderr and environment never reach the reason.
 */
async function runBoundedUpdateQuery(
  file: string,
  args: string[],
  options: Omit<ExecFileOptions, "encoding" | "signal" | "timeout">,
  timeout: number,
  reasons: UpdateQueryReasons,
): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(file, args, { ...options, encoding: "utf8", signal: controller.signal }));
  } catch {
    throw timedOut ? new UpdateQueryError(reasons.timedOut, timeout) : new UpdateQueryError(reasons.failed);
  } finally {
    clearTimeout(deadline);
  }
  if (timedOut) throw new UpdateQueryError(reasons.timedOut, timeout);
  return stdout.trim();
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
  runBoundedUpdateQuery(resolveNpmCommandName(), args, {
    maxBuffer: 64 * 1024,
    shell: shouldRunNpmCommandInShell(),
    env: { ...process.env, npm_config_ignore_scripts: "true" },
  }, timeout, { timedOut: NPM_REGISTRY_LOOKUP_TIMED_OUT, failed: NPM_REGISTRY_LOOKUP_FAILED });

/**
 * Query a GitHub remote with bounded execution. Git's terminal prompt and Git
 * Credential Manager's interactive prompts are disabled, so a remote that asks
 * for credentials through them fails at once; git's command line and stderr can
 * name the remote, a proxy or a local path, so only the stable reasons are
 * reported.
 */
const runGitUpdateQuery: UpdateQueryRunner = (args, timeout) =>
  runBoundedUpdateQuery("git", args, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  }, timeout, { timedOut: GITHUB_REMOTE_LOOKUP_TIMED_OUT, failed: GITHUB_REMOTE_LOOKUP_FAILED });

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
