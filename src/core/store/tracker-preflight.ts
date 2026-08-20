/**
 * @module core/store/tracker-preflight
 *
 * Owns the filesystem preflight shared by tracker-reading SDK primitives.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { EXIT_CODE } from "../shared/constants.js";
import {
  PmCliError,
  type PmCliErrorRecoveryPayload,
} from "../shared/errors.js";
import { pathExists } from "../fs/fs-utils.js";
import { getSettingsPath } from "./paths.js";

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

/** Build the non-interactive, tokenized retry that initializes a selected tracker root. */
export function buildTrackerInitializationRecovery(
  pmRoot: string,
): PmCliErrorRecoveryPayload {
  const suggestedRetryArguments = [
    "init",
    pmRoot,
    "--defaults",
    "--agent-guidance",
    "skip",
  ];
  return {
    suggested_retry: `pm ${suggestedRetryArguments
      .map((argument) => `'${argument.replaceAll("'", `'"'"'`)}'`)
      .join(" ")}`,
    suggested_retry_args: suggestedRetryArguments,
  };
}

function trackerRootNotDirectoryError(pmRoot: string): PmCliError {
  return new PmCliError(
    `Tracker root is not a directory at ${pmRoot}.`,
    EXIT_CODE.USAGE,
    {
      code: "tracker_root_not_directory",
      reason: "not_a_directory",
      resolved_path: pmRoot,
      nextSteps: [
        "Pass a tracker directory, usually <workspace>/.agents/pm, rather than a file path.",
      ],
    },
  );
}

function trackerRootUnreadableError(pmRoot: string): PmCliError {
  return new PmCliError(
    `Tracker root is not readable at ${pmRoot}.`,
    EXIT_CODE.GENERIC_FAILURE,
    {
      code: "tracker_root_unreadable",
      reason: "unreadable",
      resolved_path: pmRoot,
      nextSteps: [
        "Grant read and directory-search permission to the tracker root, then retry.",
      ],
    },
  );
}

async function assertMissingRootAncestors(pmRoot: string): Promise<void> {
  const resolvedRoot = path.resolve(pmRoot);
  const filesystemRoot = path.parse(resolvedRoot).root;
  let ancestor = path.dirname(resolvedRoot);
  while (ancestor !== filesystemRoot) {
    let ancestorStats;
    try {
      ancestorStats = await fs.stat(ancestor);
    } catch (error: unknown) {
      if (isErrno(error, "ENOTDIR")) {
        throw trackerRootNotDirectoryError(pmRoot);
      }
      if (!isErrno(error, "ENOENT")) {
        throw error;
      }
      ancestor = path.dirname(ancestor);
      continue;
    }
    if (!ancestorStats.isDirectory()) {
      throw trackerRootNotDirectoryError(pmRoot);
    }
    return;
  }
}

/** Require a tracker root to be a readable directory without requiring initialized settings. */
export async function assertReadableTrackerRoot(pmRoot: string): Promise<void> {
  let stats;
  try {
    stats = await fs.stat(pmRoot);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      await assertMissingRootAncestors(pmRoot);
      throw new PmCliError(
        `Tracker is not initialized at ${pmRoot}. Tracker root does not exist. Run pm init first.`,
        EXIT_CODE.NOT_FOUND,
        {
          code: "tracker_root_missing",
          reason: "missing",
          resolved_path: pmRoot,
          nextSteps: [
            "Confirm the tracker root path or initialize it with the emitted retry.",
          ],
          recovery: buildTrackerInitializationRecovery(pmRoot),
        },
      );
    }
    if (isErrno(error, "ENOTDIR")) {
      throw trackerRootNotDirectoryError(pmRoot);
    }
    if (isErrno(error, "EACCES") || isErrno(error, "EPERM")) {
      throw trackerRootUnreadableError(pmRoot);
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw trackerRootNotDirectoryError(pmRoot);
  }
  if (
    process.platform !== "win32" &&
    ((stats.mode & 0o444) === 0 || (stats.mode & 0o111) === 0)
  ) {
    throw trackerRootUnreadableError(pmRoot);
  }
  try {
    const directory = await fs.opendir(pmRoot);
    await directory.close();
  } catch (error: unknown) {
    if (isErrno(error, "EACCES") || isErrno(error, "EPERM")) {
      throw trackerRootUnreadableError(pmRoot);
    }
    throw error;
  }
}

/** Require the selected tracker root and its settings marker before an SDK command reads or mutates project state. */
export async function assertInitializedTracker(pmRoot: string): Promise<void> {
  if (await pathExists(getSettingsPath(pmRoot))) {
    return;
  }
  await assertReadableTrackerRoot(pmRoot);
  throw new PmCliError(
    `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
    EXIT_CODE.NOT_FOUND,
    {
      code: "tracker_not_initialized",
      reason: "settings_missing",
      resolved_path: pmRoot,
      nextSteps: ["Initialize the selected tracker root with the emitted retry."],
      recovery: buildTrackerInitializationRecovery(pmRoot),
    },
  );
}
