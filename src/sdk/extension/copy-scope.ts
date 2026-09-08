/** @module sdk/extension/copy-scope Shares directory snapshot exclusions between planning and copying. */
import path from "node:path";
import { isPathWithinDirectory } from "../../core/fs/path-utils.js";

/** Decide whether a lexical source path belongs in a nested-destination snapshot. Symlinks remain links. */
export function includesExtensionCopyPath(source: string, destination: string, candidate: string): boolean {
  const relative = path.relative(source, candidate);
  if (relative !== "" && !isPathWithinDirectory(source, candidate)) return false;
  if (candidate === destination || isPathWithinDirectory(destination, candidate)) return false;
  const segments = relative.split(path.sep);
  return segments[0] !== ".agents" && !segments.some(
    (segment) => segment === "node_modules" || segment.startsWith(".pm-extension-install-backup-"),
  );
}
