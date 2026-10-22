/**
 * @module sdk/workspace
 *
 * Maintains repository-scaffold contracts shared by the public SDK and CLI.
 */
import { isFileMissingError } from "../core/fs/fs-utils.js";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";

/** Opening marker for the init-owned ignore block. */
export const PM_GITIGNORE_START = "# pm-cli:runtime-cache:start";
/** Closing marker for the init-owned ignore block. */
export const PM_GITIGNORE_END = "# pm-cli:runtime-cache:end";

/** Default workspace-relative tracker root used when no custom root is resolved. */
export const PM_GITIGNORE_DEFAULT_TRACKER_ROOT = ".agents/pm";

/** Resolve existing physical ancestry while retaining an uncreated initialization suffix. */
async function physicalInitPath(input: string): Promise<string> {
  let ancestor = path.resolve(input);
  const missing: string[] = [];
  for (;;) {
    try {
      const physical = await realpath(ancestor);
      if (!(await stat(physical)).isDirectory()) {
        throw Object.assign(new Error("Initialization path ancestry must be a directory."), { code: "ENOTDIR" });
      }
      return path.join(physical, ...missing);
    } catch (error: unknown) {
      if (!isFileMissingError(error) || path.dirname(ancestor) === ancestor) throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}

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
  const root = trackerRelativeRoot.split(path.sep).join("/").replace(/^\.\/+/, "");
  let end = root.length;
  while (end > 0 && root[end - 1] === "/") end -= 1;
  return root.slice(0, end);
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
  if (/[\r\n]/u.test(root)) {
    throw new PmCliError("A tracker path containing a line break cannot be represented safely in .gitignore.", EXIT_CODE.USAGE, {
      code: "invalid_argument_value",
      required: "a tracker path without line breaks",
      nextSteps: ["Choose a tracker path without carriage returns or newlines and rerun pm init."],
    });
  }
  const literalRoot = root.replace(/[\\*?[\]#! \t]/gu, "\\$&");
  return [
    PM_GITIGNORE_START,
    ...PM_GITIGNORE_RUNTIME_DIRECTORIES.map((directory) =>
      directory === "search/"
        ? `${literalRoot}/${directory}*`
        : `${literalRoot}/${directory}`,
    ),
    ...PM_GITIGNORE_TRACKED_FILES.map((file) => `!${literalRoot}/${file}`),
    PM_GITIGNORE_END,
  ].join("\n");
}

/** Replace this tracker's rules in place while retaining every sibling scope, including legacy unescaped rules. */
function mergeTrackerIgnoreRules(lines: string[], trackerRoot: string, rules: string[]): string[] {
  const literalRoot = trackerRoot.replace(/[\\*?[\]#! \t]/gu, "\\$&");
  const prefixes = [...new Set([trackerRoot, literalRoot])].flatMap((root) =>
    PM_GITIGNORE_RUNTIME_DIRECTORIES.flatMap((directory) => [`${root}/${directory}`, `!${root}/${directory}`]),
  );
  const merged: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (prefixes.some((prefix) => line.startsWith(prefix))) {
      if (!replaced) merged.push(...rules);
      replaced = true;
    } else {
      merged.push(line);
    }
  }
  if (!replaced) merged.push(...rules);
  return merged;
}

/** Find complete line-delimited fences in one pass; a newer opener leaves unmatched prefixes outside the managed block. */
function managedGitignoreBlocks(current: string): Array<{ index: number; end: number; lines: string[] }> {
  const blocks: Array<{ index: number; end: number; lines: string[] }> = [];
  let start = -1;
  let bodyStart = 0;
  let offset = 0;
  for (const line of current.split("\n")) {
    const marker = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (marker === PM_GITIGNORE_START) {
      start = offset;
      bodyStart = offset + line.length + 1;
    } else if (marker === PM_GITIGNORE_END && start >= 0) {
      blocks.push({
        index: start,
        end: offset + marker.length,
        lines: current.slice(bodyStart, offset).split(/\r?\n/u).filter((entry) => entry.length > 0),
      });
      start = -1;
    }
    offset += line.length + 1;
  }
  return blocks;
}

/** Reconcile complete managed fences without moving or rewriting unrelated user content. */
function reconcileGitignoreContent(current: string, trackerRoot: string): string {
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const rules = getPmGitignoreBlock(trackerRoot).split("\n").slice(1, -1);
  const blocks = managedGitignoreBlocks(current);
  const existingRules = blocks.flatMap((entry) => entry.lines);
  const block = [PM_GITIGNORE_START, ...mergeTrackerIgnoreRules(existingRules, trackerRoot, rules), PM_GITIGNORE_END].join(newline);
  if (blocks.length === 0) {
    const separator = current.length === 0 ? "" : current.endsWith("\n") ? newline : `${newline}${newline}`;
    return `${current}${separator}${block}${newline}`;
  }
  let next = current;
  for (const [index, match] of [...blocks.entries()].reverse()) {
    next = `${next.slice(0, match.index)}${index === 0 ? block : ""}${next.slice(match.end)}`;
  }
  return next;
}

/**
 * Idempotently reconcile the fenced pm cache rules in a workspace
 * `.gitignore`. When `pmRoot` is provided the ignored runtime directories are
 * rendered under the resolved workspace-relative tracker root, so custom-root
 * workspaces (`--pm-path`/`PM_PATH`) stop committing runtime caches (GH-598).
 * Sibling tracker rules are retained, and an explicitly root-layout tracker
 * uses anchored repository-root rules rather than the default tracker path.
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
      path.relative(await physicalInitPath(workspaceRoot), await physicalInitPath(options.pmRoot)),
    );
    if (isPathOutsideRoot(relative)) {
      return { path: gitignorePath, changed: false };
    }
    trackerRelativeRoot = relative;
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
  const next = reconcileGitignoreContent(current, trackerRelativeRoot);
  if (next === current) {
    return { path: gitignorePath, changed: false };
  }
  await withGitignorePermissionRecovery(() =>
    writeFile(gitignorePath, next, "utf8"),
  );
  return { path: gitignorePath, changed: true };
}
