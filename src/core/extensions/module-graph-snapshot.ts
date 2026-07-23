/**
 * @module core/extensions/module-graph-snapshot
 *
 * Creates fresh, caller-owned extension directory snapshots for uncached ESM
 * verification.
 */
import fs from "node:fs/promises";
import path from "node:path";

/** Extension paths and identity required to create a complete graph snapshot. */
export interface ExtensionModuleGraphSnapshotSource {
  /** Extension precedence layer used to keep snapshot directories distinct. */
  layer: string;
  /** Extension directory identifier used to keep snapshot directories distinct. */
  directory: string;
  /** Absolute path to the extension manifest inside its source directory. */
  manifest_path: string;
  /** Absolute path to the extension entry module. */
  entry_path: string;
}

/**
 * Copy an extension directory into a fresh graph root and return its entry path.
 *
 * Copying the complete directory gives every relative transitive import a new
 * absolute URL, preventing a same-process install verification from reusing
 * stale ESM cache entries.
 */
export async function snapshotExtensionModuleGraph(
  snapshotRoot: string,
  extension: ExtensionModuleGraphSnapshotSource,
): Promise<string> {
  const sourceDirectory = path.dirname(extension.manifest_path);
  const relativeEntryPath = path.relative(
    sourceDirectory,
    extension.entry_path,
  );
  if (
    relativeEntryPath.startsWith("..") ||
    path.isAbsolute(relativeEntryPath)
  ) {
    throw new Error(
      `Cannot snapshot extension entry outside its package directory: ${extension.entry_path}`,
    );
  }
  const snapshotDirectory = path.join(
    snapshotRoot,
    `${extension.layer}-${extension.directory.replace(/[^a-zA-Z0-9._-]/gu, "_")}`,
  );
  await fs.cp(sourceDirectory, snapshotDirectory, {
    recursive: true,
    force: true,
  });
  return path.join(snapshotDirectory, relativeEntryPath);
}
