/**
 * @module sdk/extension/install-snapshot
 *
 * Captures and restores extension files and metadata around install persistence.
 */
import { withHostEnvironmentBoundary } from "../../core/fs/host-environment-errors.js";
import fs from "node:fs/promises";
import path from "node:path";
import { getSettingsPath } from "../../core/store/paths.js";
import { isErrnoCode } from "./install-runtime.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { PmCliError } from "../../core/shared/errors.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { renderPmCommand } from "../command-line.js";
import { areDirectoriesEquivalent } from "./install-sources.js";
import { writeWorkspaceJsonWithHistory } from "../../core/history/workspace-history.js";
import { readSettings } from "../../core/store/settings.js";
import { clearSettingsReadCache } from "../../core/store/settings-read-cache.js";
import { resolveAuthor } from "../../core/shared/author.js";
import { resolveManagedExtensionStatePath } from "./managed-state.js";

/** Exact filesystem and metadata state captured before an extension install. */
export interface ExtensionInstallSnapshot {
  /** Temporary copy of the prior destination directory. */
  backupDirectory: string;
  /** Extension destination being installed. */
  destinationDirectory: string;
  /** Whether the destination existed before installation. */
  destinationExists: boolean;
  /** Managed-extension state file path. */
  managedStatePath: string;
  /** Exact prior managed-extension state contents. */
  managedStateContents: Buffer | null;
  /** Project settings file path. */
  settingsPath: string;
  /** Exact prior project settings contents. */
  settingsContents: Buffer | null;
}

/** Capture one optional metadata file without weakening non-ENOENT failures. */
export const readOptionalMetadataFile = async (
  filePath: string,
): Promise<Buffer | null> =>
  fs.readFile(filePath).catch((error: unknown) => {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw error;
  });

/** Capture extension files and metadata before applying an install mutation. */
export const captureExtensionInstallSnapshot = async (
  selectedRoot: string,
  settingsRoot: string,
  destinationDirectory: string,
  destinationExists: boolean,
  backupDirectory: string,
): Promise<ExtensionInstallSnapshot> => withHostEnvironmentBoundary("extension_install_backup", async () => {
  const managedStatePath = resolveManagedExtensionStatePath(selectedRoot);
  const settingsPath = getSettingsPath(settingsRoot);
  const [managedStateContents, settingsContents] = await Promise.all([
    readOptionalMetadataFile(managedStatePath),
    readOptionalMetadataFile(settingsPath),
  ]);
  if (destinationExists) {
    await fs.cp(destinationDirectory, backupDirectory, {
      recursive: true,
      force: true,
    });
  }
  return {
    backupDirectory,
    destinationDirectory,
    destinationExists,
    managedStatePath,
    managedStateContents,
    settingsPath,
    settingsContents,
  };
});

/** Restore directory and metadata snapshots after a partially persisted install. */
export const restoreExtensionInstallSnapshot = async (
  snapshot: ExtensionInstallSnapshot,
): Promise<void> => withHostEnvironmentBoundary("extension_install_rollback", async () => {
  await fs.rm(snapshot.destinationDirectory, { recursive: true, force: true });
  if (snapshot.destinationExists) {
    await fs.cp(snapshot.backupDirectory, snapshot.destinationDirectory, {
      recursive: true,
      force: true,
    });
  }
  for (const [filePath, contents] of [
    [snapshot.managedStatePath, snapshot.managedStateContents],
    [snapshot.settingsPath, snapshot.settingsContents],
  ] as const) {
    if (contents === null) {
      await fs.rm(filePath, { force: true });
    } else if (filePath === snapshot.settingsPath) {
      const settingsRoot = path.dirname(snapshot.settingsPath);
      const settings = await readSettings(settingsRoot);
      try {
        await writeWorkspaceJsonWithHistory({
          pmRoot: settingsRoot,
          filePath,
          raw: contents.toString("utf8"),
          op: "extension:install:rollback",
          author: resolveAuthor(undefined, settings.author_default),
          lockTtlSeconds: settings.locks.ttl_seconds,
          lockWaitMs: settings.locks.wait_ms,
        });
      } finally {
        clearSettingsReadCache(settingsRoot);
      }
    } else {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents);
    }
  }
});

/** Retain the previous installation until both persistence and runtime verification settle. */
export async function withVerifiedExtensionInstall<T extends { ok: boolean; details: Record<string, unknown> }>(
  options: { selectedRoot: string; settingsRoot: string; destinationDirectory: string; sourceDirectory: string; scope: "project" | "global" },
  install: () => Promise<T>,
): Promise<T> {
  const destinationExists = await pathExists(options.destinationDirectory);
  const inPlace = await areDirectoriesEquivalent(options.sourceDirectory, options.destinationDirectory);
  await fs.mkdir(options.selectedRoot, { recursive: true });
  const backupParent = path.join(path.dirname(options.selectedRoot), "runtime", "extension-installs");
  await fs.mkdir(backupParent, { recursive: true });
  const backupRoot = await fs.mkdtemp(path.join(backupParent, ".pm-extension-install-backup-"));
  const backupDirectory = path.join(backupRoot, "destination");
  const recoveryArgs = ["package", "install", backupDirectory, `--${options.scope}`];
  const recoveryCommand = renderPmCommand(recoveryArgs);
  let retainBackup = false;
  try {
    const snapshot = await captureExtensionInstallSnapshot(options.selectedRoot, options.settingsRoot, options.destinationDirectory, destinationExists, backupDirectory);
    let result: T;
    try {
      result = await install();
    } catch (error: unknown) {
      try {
        await restoreExtensionInstallSnapshot(snapshot);
      } catch (rollbackError: unknown) {
        retainBackup = true;
        throw new PmCliError(`Extension install failed: ${String(error)}; rollback failed: ${String(rollbackError)}`, EXIT_CODE.GENERIC_FAILURE, {
          code: "extension_install_rollback_failed",
          required: "Restore the previous package before retrying the replacement. Previous state was not preserved.",
          nextSteps: [destinationExists ? recoveryCommand : "Repair the reported metadata write failure, then retry the original install."],
          ...(destinationExists ? { recovery: { suggested_retry: recoveryCommand, suggested_retry_args: recoveryArgs } } : {}),
        });
      }
      throw error;
    }
    if (result.ok) return result;
    // Fresh and in-place failures retain their diagnostic installation. There
    // is no earlier working source to restore in either case.
    if (!destinationExists || inPlace) return { ...result, details: { ...result.details, previous_state_preserved: false } };
    try {
      await restoreExtensionInstallSnapshot(snapshot);
    } catch (error: unknown) {
      retainBackup = true;
      return { ...result, details: { ...result.details, previous_state_preserved: false, rollback: { status: "failed", error: String(error), backup_directory: backupDirectory, recovery_command: recoveryCommand, recovery_args: recoveryArgs } } };
    }
    return { ...result, details: { ...result.details, overwritten: false, settings_changed: false, previous_state_preserved: true, rollback: { status: "restored" } } };
  } finally {
    if (!retainBackup) await fs.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
