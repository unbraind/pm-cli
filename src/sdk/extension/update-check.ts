/**
 * @module sdk/extension/update-check
 *
 * Provides bounded and annotated-tag-aware update checks for managed extensions.
 */
import { nowIso } from "../../core/shared/time.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import npa from "npm-package-arg";
import type { ManagedExtensionSource } from "./managed-state.js";
import { resolveNpmCommandName, runGitCommand, shouldRunNpmCommandInShell } from "./install-sources.js";

const execFileAsync = promisify(execFile);

const GITHUB_UPDATE_CHECK_TIMEOUT_MS = 10_000;

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
}

/** Result of comparing the installed npm identity with its registry latest dist-tag. */
export interface NpmUpdateStatus extends Omit<GithubUpdateStatus, "remote_commit"> {
  /** Registry version selected by the latest dist-tag, when valid. */
  remote_version?: string;
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

/** Query npm's configured registry with bounded execution and no lifecycle scripts. */
async function runNpmUpdateQuery(args: string[], timeout: number): Promise<string> {
  try {
    const result = await execFileAsync(resolveNpmCommandName(), args, {
      encoding: "utf8", timeout, maxBuffer: 64 * 1024,
      shell: shouldRunNpmCommandInShell(),
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    });
    return result.stdout.trim();
  } catch {
    // Registry configuration can contain credentials; public diagnostics carry
    // a stable failure code rather than npm's command, stderr, or environment.
    throw new Error("npm_registry_lookup_failed");
  }
}

/** Compare recorded npm provenance without persisting diagnostic results or guessing missing versions. */
export async function checkNpmUpdate(
  source: ManagedExtensionSource,
  npmRunner: typeof runNpmUpdateQuery = runNpmUpdateQuery,
): Promise<NpmUpdateStatus> {
  const checkedAt = nowIso();
  try {
    if (source.kind !== "npm" || !source.package || !/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/u.test(source.package)) {
      throw new Error("missing_or_invalid_npm_package_identity");
    }
    const installedVersion = resolveExactNpmVersion(source.package, source.version, "missing_or_invalid_installed_npm_version");
    const registryOutput = await npmRunner(["view", source.package, "dist-tags.latest", "--json", "--ignore-scripts"], GITHUB_UPDATE_CHECK_TIMEOUT_MS);
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
    return { checked_at: checkedAt, available: null, error: error instanceof Error ? error.message : String(error) };
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
  gitCommandRunner: typeof runGitCommand = runGitCommand,
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
      undefined,
      GITHUB_UPDATE_CHECK_TIMEOUT_MS,
    );
    return resolveGithubUpdateOutput(output, source.commit, checkedAt);
  } catch (error: unknown) {
    return {
      checked_at: checkedAt,
      available: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
