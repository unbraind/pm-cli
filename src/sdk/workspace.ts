/**
 * @module sdk/workspace
 *
 * Maintains repository-scaffold contracts shared by the public SDK and CLI.
 */
import { isFileMissingError } from "../core/fs/fs-utils.js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";

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

/** Tracker-relative curated search evidence that remains version controlled. */
export const PM_GITIGNORE_TRACKED_FILES = ["search/eval-queries.json"] as const;

/** Result of reconciling the init-owned repository ignore block. */
export interface EnsurePmGitignoreResult {
  /** Absolute path to the reconciled file. */
  path: string;
  /** Whether the file content changed. */
  changed: boolean;
}

/** Convert expected workspace permission failures into stable, path-safe recovery. */
async function withGitignorePermissionRecovery<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      ["EACCES", "EPERM", "EROFS"].includes(error.code)
    ) {
      throw new PmCliError(
        "The workspace .gitignore is not writable.",
        EXIT_CODE.GENERIC_FAILURE,
        {
          code: "init_gitignore_unwritable",
          reason: error.code.toLowerCase(),
          required:
            "Grant the current user read and write access to the workspace .gitignore before initialization.",
          why: "pm init must publish its managed runtime-cache ignore fence without replacing unrelated entries.",
          nextSteps: [
            "Grant read and write access to the workspace .gitignore and rerun pm init.",
            "If the workspace is intentionally read-only, initialize pm in a writable workspace or clone.",
          ],
        },
      );
    }
    throw error;
  }
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
    ...PM_GITIGNORE_RUNTIME_DIRECTORIES.map((directory) =>
      directory === "search/"
        ? `${root}/${directory}*`
        : `${root}/${directory}`,
    ),
    ...PM_GITIGNORE_TRACKED_FILES.map((file) => `!${root}/${file}`),
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
    current = await withGitignorePermissionRecovery(() =>
      readFile(gitignorePath, "utf8"),
    );
  } catch (error: unknown) {
    if (
      !(error instanceof Error && "code" in error && isFileMissingError(error))
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
  await withGitignorePermissionRecovery(() =>
    writeFile(gitignorePath, next, "utf8"),
  );
  return { path: gitignorePath, changed: true };
}
