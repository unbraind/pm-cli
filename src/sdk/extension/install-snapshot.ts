/**
 * @module sdk/extension/install-snapshot
 *
 * Captures and restores extension files and metadata around install persistence.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getSettingsPath } from "../../core/store/paths.js";
import { isErrnoCode } from "./install-runtime.js";
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
): Promise<ExtensionInstallSnapshot> => {
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
};

/** Restore directory and metadata snapshots after a partially persisted install. */
export const restoreExtensionInstallSnapshot = async (
  snapshot: ExtensionInstallSnapshot,
): Promise<void> => {
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
    } else {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents);
    }
  }
};
