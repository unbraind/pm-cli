/** @module sdk/extension/copy-scope Shares directory snapshot exclusions between planning and copying. */
import path from "node:path";
import { isPathWithinDirectory } from "../../core/fs/path-utils.js";

/** Decide whether a lexical source path belongs in an extension snapshot. Git metadata is always excluded; symlinks remain links. */
export function includesExtensionCopyPath(source: string, destination: string, candidate: string, nestedDestination: boolean): boolean {
  const relative = path.relative(source, candidate);
  if (relative !== "" && !isPathWithinDirectory(source, candidate)) return false;
  if (candidate === destination || isPathWithinDirectory(destination, candidate)) return false;
  const segments = relative.split(path.sep);
  if (segments.includes(".git")) return false;
  if (!nestedDestination) return true;
  return !segments.some(
    (segment) => segment === ".agents" || segment === "node_modules" || segment.startsWith(".pm-extension-install-backup-"),
  );
}
