/** @module sdk/extension/install-plan Bounded read-only estimates of the directory snapshot an install will copy. */
import fs from "node:fs/promises";
import path from "node:path";
import { isPathWithinDirectory } from "../../core/fs/path-utils.js";
import { PmCliError } from "../../core/shared/errors.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { includesExtensionCopyPath } from "./copy-scope.js";
import { resolveCanonicalExtensionInstallDestination } from "./install-runtime.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { areDirectoriesEquivalent, type ResolvedInstallSource } from "./install-sources.js";

/** Limits filesystem enumeration independently of the size of the source tree. */
export interface ExtensionCopyPlanOptions {
  /** Maximum directory entries inspected; defaults to 10,000. */
  maxEntries?: number;
  /** Maximum directory nesting inspected; defaults to 64. */
  maxDepth?: number;
  /** Cancels between filesystem operations and closes every open directory handle. */
  signal?: AbortSignal;
}

/** Observed logical file bytes, excluding dependency installation, metadata writes, and symlink targets. */
export interface ExtensionCopyPlan {
  /** Snapshot policy shared with the actual copy operation. */
  copy_scope: "directory_snapshot" | "nested_filtered_snapshot" | "in_place";
  /** Absolute source directory used by the copy. */
  source_directory: string;
  /** Absolute destination, resolved through existing parent symlinks. */
  destination_directory: string;
  /** Regular files included in the observed snapshot. */
  files: number;
  /** Sum of observed regular-file logical sizes; a lower bound when incomplete. */
  bytes: number;
  /** Included directories, excluding the source root. */
  directories: number;
  /** Included symlinks; targets are never traversed. */
  symlinks: number;
  /** Included special filesystem entries, whose copy support is platform dependent. */
  other_entries: number;
  /** Entries inspected, including exclusions. */
  scanned_entries: number;
  /** Entries excluded by the nested-destination policy. */
  excluded_entries: number;
  /** Included entries under conventional dependency, VCS, build, or coverage directories. */
  development_entries: number;
  /** True only when enumeration finished within both limits. */
  complete: boolean;
  /** Why enumeration ended; incomplete counts are never presented as totals. */
  stop_reason: "complete" | "entry_limit" | "depth_limit";
  /** Effective maximum directory entries inspected. */
  max_entries: number;
  /** Effective maximum directory nesting inspected. */
  max_depth: number;
}

const DEVELOPMENT_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

/** Source identity, copy cost, and a script-free packed alternative for one resolved install. */
export interface ExtensionInstallPlan {
  /** Distinguishes an explicit directory snapshot from an unpacked archive or remote source. */
  source_mode: "directory" | "archive" | "npm" | "github";
  /** Original archive size before unpacking, when supplied as a local file. */
  archive_bytes?: number;
  /** Bounded enumeration of the exact selected extension directory. */
  copy: ExtensionCopyPlan;
  /** Suggested argument-vector workflow; substitute the pack result filename before installation. */
  packed_alternative?: {
    cwd: string;
    pack: { command: "npm"; args: string[] };
    install: { command: "pm"; args: string[] };
    archive_argument: "pack_result[0].filename";
  };
}

/** Estimate a resolved install before destination writes. Source resolution may have prepared a temporary archive or remote tree. */
export async function buildExtensionInstallPlan(
  resolved: ResolvedInstallSource,
  destination: string,
  scope: "project" | "global",
  options?: ExtensionCopyPlanOptions,
): Promise<ExtensionInstallPlan> {
  const localStat = resolved.source.kind === "local" ? await fs.stat(resolved.source.absolute_path) : undefined;
  const sourceMode = resolved.source.kind === "local" ? localStat!.isDirectory() ? "directory" : "archive" : resolved.source.kind;
  const copy = await planExtensionDirectoryCopy(resolved.directory, destination, options);
  const plan: ExtensionInstallPlan = {
    source_mode: sourceMode,
    ...(sourceMode === "archive" ? { archive_bytes: localStat!.size } : {}),
    copy,
  };
  const packageRoot = resolved.source_root ?? resolved.directory;
  if (sourceMode === "directory" && (!copy.complete || copy.development_entries > 0 || copy.bytes >= 16 * 1024 * 1024) && await pathExists(path.join(packageRoot, "package.json"))) {
    plan.packed_alternative = {
      cwd: packageRoot,
      pack: { command: "npm", args: ["pack", "--ignore-scripts", "--json"] },
      install: { command: "pm", args: ["package", "install", "<archive-filename>", `--${scope}`] },
      archive_argument: "pack_result[0].filename",
    };
  }
  return plan;
}

/** Inspect one directory tree without copying files, executing code, following symlinks, or collecting an unbounded path list. */
export async function planExtensionDirectoryCopy(
  sourceDirectory: string,
  destinationDirectory: string,
  options: ExtensionCopyPlanOptions = {},
): Promise<ExtensionCopyPlan> {
  const { maxEntries = 10_000, maxDepth = 64, signal } = options;
  if (![maxEntries, maxDepth].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new PmCliError("maxEntries and maxDepth must be positive safe integers.", EXIT_CODE.USAGE);
  }
  signal?.throwIfAborted();
  const source = await fs.realpath(sourceDirectory);
  const destination = await resolveCanonicalExtensionInstallDestination(destinationDirectory);
  const installInPlace = await areDirectoriesEquivalent(source, destination);
  signal?.throwIfAborted();
  const scope = installInPlace ? "in_place"
    : isPathWithinDirectory(source, destination) ? "nested_filtered_snapshot" : "directory_snapshot";
  const plan: ExtensionCopyPlan = {
    copy_scope: scope, source_directory: source, destination_directory: destination,
    files: 0, bytes: 0, directories: 0, symlinks: 0, other_entries: 0,
    scanned_entries: 0, excluded_entries: 0, development_entries: 0,
    complete: true, stop_reason: "complete", max_entries: maxEntries, max_depth: maxDepth,
  };
  if (scope === "in_place") return plan;
  await scanExtensionCopyDirectory(source, 0, plan, signal);
  return plan;
}

/** Fold entries into a bounded receipt, releasing iterator handles on early completion or failure. */
async function scanExtensionCopyDirectory(directory: string, depth: number, plan: ExtensionCopyPlan, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted();
  const handle = await fs.opendir(directory);
  for await (const entry of handle) {
    signal?.throwIfAborted();
    if (plan.scanned_entries >= plan.max_entries) {
      plan.complete = false;
      plan.stop_reason = "entry_limit";
      return;
    }
    plan.scanned_entries += 1;
    const candidate = path.join(directory, entry.name);
    if (plan.copy_scope === "nested_filtered_snapshot" && !includesExtensionCopyPath(plan.source_directory, plan.destination_directory, candidate)) {
      plan.excluded_entries += 1;
      continue;
    }
    if (path.relative(plan.source_directory, candidate).split(path.sep).some((segment) => DEVELOPMENT_DIRECTORIES.has(segment))) plan.development_entries += 1;
    await countExtensionCopyEntry(candidate, depth, plan, signal);
    if (!plan.complete) return;
  }
}

/** Count one included filesystem entry and recurse only into real directories. */
async function countExtensionCopyEntry(candidate: string, depth: number, plan: ExtensionCopyPlan, signal: AbortSignal | undefined): Promise<void> {
  const stat = await fs.lstat(candidate);
  signal?.throwIfAborted();
  if (stat.isDirectory()) {
    plan.directories += 1;
    if (depth + 1 >= plan.max_depth) {
      plan.complete = false;
      plan.stop_reason = "depth_limit";
      return;
    }
    await scanExtensionCopyDirectory(candidate, depth + 1, plan, signal);
  } else if (stat.isFile()) {
    plan.files += 1;
    plan.bytes += stat.size;
  } else if (stat.isSymbolicLink()) {
    plan.symlinks += 1;
  } else {
    plan.other_entries += 1;
  }
}
