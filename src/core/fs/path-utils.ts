/**
 * @module core/fs/path-utils
 *
 * Provides filesystem helpers for Path Utils.
 */
import path from "path";

/** Implements check whether path within directory for the public runtime surface of this module. */
export function isPathWithinDirectory(
  directory: string,
  targetPath: string,
): boolean {
  const relative = path.relative(directory, targetPath);
  if (relative.length === 0) {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}
