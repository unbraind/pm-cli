/**
 * @module sdk/extension/update-check
 *
 * Provides bounded and annotated-tag-aware update checks for managed extensions.
 */
import { nowIso } from "../../core/shared/time.js";
import type { ManagedExtensionSource } from "./managed-state.js";
import { runGitCommand } from "./install-sources.js";

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
      error: String(error).replace(/^Error: /, ""),
    };
  }
};
