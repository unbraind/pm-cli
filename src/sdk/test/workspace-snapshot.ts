/**
 * @module sdk/test/workspace-snapshot
 * Copies linked-test source files while retaining each installed dependency root.
 */
import { cp, lstat, mkdir, readlink, realpath, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { isFileMissingError } from "../../core/fs/fs-utils.js";

const EXCLUDED_SEGMENTS = new Set([
  ".agents", ".git", ".nyc_output", ".turbo", "coverage",
]);

/** Recognize reserved tracker/build segments independently of filesystem casing. */
function hasExcludedSegment(relative: string): boolean {
  return relative.split(path.sep).some((segment) => EXCLUDED_SEGMENTS.has(segment.toLowerCase()));
}

/** Detect an ancestor, sibling or different-volume target relative to the workspace. */
function isOutsideWorkspace(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * Canonicalize a link target through its nearest existing ancestor. Preserve
 * missing suffixes so dangling aliases stay disposable after rebasing, while
 * errors other than missing entries retain their original filesystem failure.
 */
async function resolveLinkTarget(target: string): Promise<string> {
  const missing: string[] = [];
  let ancestor = target;
  while (path.dirname(ancestor) !== ancestor) {
    try {
      return path.join(await realpath(ancestor), ...missing);
    } catch (error) {
      if (!isFileMissingError(error)) throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  return path.join(await realpath(ancestor), ...missing);
}

/**
 * Copy source files into a disposable workspace and link root and nested
 * dependency directories at their original relative paths. Dependency trees
 * are shared by convention, not protected against writes; callers must trust
 * the linked command and use an independent install for dependency mutations.
 * Source aliases are canonicalized through their existing ancestors and rebased
 * into the snapshot. External or excluded source targets and dependency aliases
 * into excluded workspace trees are refused before the command can run.
 */
export async function seedLinkedTestWorkspaceSnapshot(
  sourceRoot: string,
  snapshotRoot: string,
): Promise<void> {
  const dependencyRoots: string[] = [];
  const sourceLinks: Array<[relative: string, target: string, type: "junction" | "file"]> = [];
  const resolvedSourceRoot = await realpath(sourceRoot);
  await mkdir(path.dirname(snapshotRoot), { recursive: true });
  await cp(resolvedSourceRoot, snapshotRoot, {
    recursive: true,
    force: true,
    async filter(source) {
      const relative = path.relative(resolvedSourceRoot, source);
      if (!relative) return true;
      if (hasExcludedSegment(relative)) return false;
      if (path.basename(source).toLowerCase() === "node_modules") {
        if ((await stat(source, { throwIfNoEntry: false }))?.isDirectory()) {
          const target = await resolveLinkTarget(source);
          const targetRelative = path.relative(resolvedSourceRoot, target);
          if (!isOutsideWorkspace(path.relative(target, resolvedSourceRoot))
            || (!isOutsideWorkspace(targetRelative) && (hasExcludedSegment(targetRelative)
              || !targetRelative.split(path.sep).some((segment) => segment.toLowerCase() === "node_modules")))) {
            throw new Error(`Dependency symlink must target an included dependency directory or external installation: ${relative}`);
          }
          dependencyRoots.push(relative);
        }
        return false;
      }
      if (!(await lstat(source)).isSymbolicLink()) return true;
      const target = await resolveLinkTarget(path.resolve(path.dirname(source), await readlink(source)));
      const targetRelative = path.relative(resolvedSourceRoot, target);
      if (isOutsideWorkspace(targetRelative) || hasExcludedSegment(targetRelative)) {
        throw new Error(`Source symlink must target included workspace source: ${relative}`);
      }
      sourceLinks.push([relative, targetRelative, (await stat(source, { throwIfNoEntry: false }))?.isDirectory() ? "junction" : "file"]);
      return false;
    },
  });
  for (const relative of dependencyRoots) {
    await symlink(
      path.resolve(resolvedSourceRoot, relative),
      path.join(snapshotRoot, relative),
      "junction",
    );
  }
  for (const [relative, target, type] of sourceLinks) {
    await symlink(path.resolve(snapshotRoot, target), path.join(snapshotRoot, relative), type);
  }
}
