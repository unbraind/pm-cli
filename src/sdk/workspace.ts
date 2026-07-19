/**
 * @module sdk/workspace
 *
 * Maintains repository-scaffold contracts shared by the public SDK and CLI.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Opening marker for the init-owned ignore block. */
export const PM_GITIGNORE_START = "# pm-cli:runtime-cache:start";
/** Closing marker for the init-owned ignore block. */
export const PM_GITIGNORE_END = "# pm-cli:runtime-cache:end";

/** Default workspace-relative tracker root used when no custom root is resolved. */
export const PM_GITIGNORE_DEFAULT_TRACKER_ROOT = ".agents/pm";

/**
 * Tracker-relative directories that hold per-clone runtime state (caches,
 * search indexes, locks, crash-recovery receipts). They must never be
 * committed: they churn on every command and conflict on every concurrent
 * branch merge. `transactions/` (SDK workspace-transaction journals) and
 * `checkpoints/` (bulk-mutation rollback receipts) are per-branch recovery
 * state with their own GC (`pm gc --scope transactions|checkpoints`), so
 * keeping them untracked is the recorded merge-safety disposition.
 */
export const PM_GITIGNORE_RUNTIME_DIRECTORIES = [
  "runtime/",
  "search/",
  "locks/",
  "transactions/",
  "checkpoints/",
] as const;

/** Result of reconciling the init-owned repository ignore block. */
export interface EnsurePmGitignoreResult {
  /** Absolute path to the reconciled file. */
  path: string;
  /** Whether the file content changed. */
  changed: boolean;
}

function normalizeTrackerRelativeRoot(trackerRelativeRoot: string): string {
  return trackerRelativeRoot
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

/** Return whether a relative path escapes its owning root, without rejecting valid names such as `..pm`. */
export function isPathOutsideRoot(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return (
    path.isAbsolute(relativePath) ||
    normalized === ".." ||
    normalized.startsWith("../")
  );
}

/** Return the canonical pm ignore block rendered for the given workspace-relative tracker root (defaults to `.agents/pm`), primarily for documentation and tests. */
export function getPmGitignoreBlock(
  trackerRelativeRoot: string = PM_GITIGNORE_DEFAULT_TRACKER_ROOT,
): string {
  const root = normalizeTrackerRelativeRoot(trackerRelativeRoot);
  return [
    PM_GITIGNORE_START,
    ...PM_GITIGNORE_RUNTIME_DIRECTORIES.map(
      (directory) => `${root}/${directory}`,
    ),
    PM_GITIGNORE_END,
  ].join("\n");
}

/**
 * Idempotently create or replace the fenced pm cache block in a workspace
 * `.gitignore`. When `pmRoot` is provided the ignored runtime directories are
 * rendered under the resolved workspace-relative tracker root, so custom-root
 * workspaces (`--pm-path`/`PM_PATH`) stop committing runtime caches (GH-598).
 * A tracker root outside the workspace needs no ignore rules here, so the
 * file is left untouched.
 */
export async function ensurePmGitignore(
  workspaceRoot: string,
  options: {
    /** Absolute tracker root; rendered relative to the workspace root. */
    pmRoot?: string;
  } = {},
): Promise<EnsurePmGitignoreResult> {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  let trackerRelativeRoot = PM_GITIGNORE_DEFAULT_TRACKER_ROOT;
  if (options.pmRoot !== undefined) {
    const relative = normalizeTrackerRelativeRoot(
      path.relative(path.resolve(workspaceRoot), path.resolve(options.pmRoot)),
    );
    if (isPathOutsideRoot(relative)) {
      return { path: gitignorePath, changed: false };
    }
    if (relative.length > 0) {
      trackerRelativeRoot = relative;
    }
  }
  let current = "";
  try {
    current = await readFile(gitignorePath, "utf8");
  } catch (error: unknown) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  const start = current.indexOf(PM_GITIGNORE_START);
  const end = current.indexOf(PM_GITIGNORE_END);
  const withoutManagedBlock =
    start >= 0 && end >= start
      ? `${current.slice(0, start)}${current.slice(end + PM_GITIGNORE_END.length)}`
      : current;
  const prefix = withoutManagedBlock.trimEnd();
  const next = `${prefix.length > 0 ? `${prefix}\n\n` : ""}${getPmGitignoreBlock(trackerRelativeRoot)}\n`;
  if (next === current) {
    return { path: gitignorePath, changed: false };
  }
  await writeFile(gitignorePath, next, "utf8");
  return { path: gitignorePath, changed: true };
}
