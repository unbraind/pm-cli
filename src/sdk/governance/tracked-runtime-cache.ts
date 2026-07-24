/**
 * @module sdk/governance/tracked-runtime-cache
 *
 * Detects clone-local tracker runtime artifacts that were committed before the
 * managed `.gitignore` fence existed. The scan is read-only and returns only
 * repository-relative paths so health and validation output stays portable.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { PM_GITIGNORE_RUNTIME_DIRECTORIES } from "../workspace.js";
import { findGitWorkspaceRoot } from "../merge/install.js";

const execFileAsync = promisify(execFile);
const GIT_LS_FILES_MAX_BUFFER = 32 * 1024 * 1024;
const GIT_LS_FILES_TIMEOUT_MS = 10_000;
const TRACKED_RUNTIME_AUTHORITATIVE_PATHS = [
  "search/eval-queries.json",
] as const;

/** Read-only result describing clone-local tracker artifacts present in Git's index. */
export interface TrackedRuntimeCacheScan {
  /** Enclosing Git worktree root, omitted from serialized diagnostics. */
  git_workspace_root: string | null;
  /** Tracker root relative to the Git worktree, or null when it is outside Git. */
  tracker_relative_root: string | null;
  /** Tracked runtime artifact paths relative to the Git worktree. */
  tracked_paths: string[];
  /** Number of tracked runtime artifacts. */
  tracked_path_count: number;
  /** Exact index-only remediation command, or null when no artifacts are tracked. */
  remediation_command: string | null;
}

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Find tracked files below every clone-local tracker directory.
 *
 * A non-Git tracker, a tracker outside the enclosing repository, or an
 * unavailable Git executable yields an empty scan rather than turning project
 * health into an infrastructure failure.
 */
export async function scanTrackedRuntimeCache(
  pmRoot: string,
): Promise<TrackedRuntimeCacheScan> {
  const gitWorkspaceRoot = await findGitWorkspaceRoot(pmRoot);
  if (gitWorkspaceRoot === null) {
    return {
      git_workspace_root: null,
      tracker_relative_root: null,
      tracked_paths: [],
      tracked_path_count: 0,
      remediation_command: null,
    };
  }
  const trackerRelativeRoot = toPosixPath(
    path.relative(gitWorkspaceRoot, path.resolve(pmRoot)),
  );
  if (trackerRelativeRoot.length === 0) {
    return {
      git_workspace_root: gitWorkspaceRoot,
      tracker_relative_root: null,
      tracked_paths: [],
      tracked_path_count: 0,
      remediation_command: null,
    };
  }
  const runtimeDirectories = PM_GITIGNORE_RUNTIME_DIRECTORIES.map(
    (directory) => `${trackerRelativeRoot}/${toPosixPath(directory)}`,
  );
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "ls-files",
        "-z",
        "--",
        ...runtimeDirectories.map((directory) => `:(literal)${directory}`),
      ],
      {
        cwd: gitWorkspaceRoot,
        encoding: "utf8",
        maxBuffer: GIT_LS_FILES_MAX_BUFFER,
        windowsHide: true,
        timeout: GIT_LS_FILES_TIMEOUT_MS,
      },
    );
    const authoritativePaths = new Set(
      TRACKED_RUNTIME_AUTHORITATIVE_PATHS.map(
        (relativePath) => `${trackerRelativeRoot}/${relativePath}`,
      ),
    );
    const trackedPaths = [
      ...new Set(
        stdout
          .split("\0")
          .filter(
            (entry) =>
              entry.length > 0 && !authoritativePaths.has(toPosixPath(entry)),
          ),
      ),
    ].sort((left, right) => left.localeCompare(right));
    const trackedRuntimeDirectories = runtimeDirectories.filter((directory) =>
      trackedPaths.some(
        (trackedPath) =>
          trackedPath === directory || trackedPath.startsWith(`${directory}/`),
      ),
    );
    return {
      git_workspace_root: gitWorkspaceRoot,
      tracker_relative_root: trackerRelativeRoot,
      tracked_paths: trackedPaths,
      tracked_path_count: trackedPaths.length,
      remediation_command:
        trackedPaths.length === 0
          ? null
          : `git rm --cached -r -- ${trackedRuntimeDirectories
              .map((directory) =>
                quoteShellArgument(`:(literal)${directory}`),
              )
              .join(" ")}`,
    };
  } catch {
    /* c8 ignore start -- Git executable failures are environment-specific; the contract is an empty non-blocking scan. */
    return {
      git_workspace_root: gitWorkspaceRoot,
      tracker_relative_root: trackerRelativeRoot,
      tracked_paths: [],
      tracked_path_count: 0,
      remediation_command: null,
    };
    /* c8 ignore stop */
  }
}
