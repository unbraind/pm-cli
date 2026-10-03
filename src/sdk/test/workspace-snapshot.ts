/**
 * @module sdk/test/workspace-snapshot
 * Copies linked-test source files while retaining each installed dependency root.
 */
import { cp, lstat, mkdir, readlink, realpath, stat, symlink } from "node:fs/promises";
import type { Stats } from "node:fs";
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

/** Read target metadata across supported runtimes, treating only ENOENT as absence and propagating other filesystem failures. */
async function statSnapshotTarget(source: string): Promise<Stats | undefined> {
  try {
    return await stat(source);
  } catch (error) {
    if (!isFileMissingError(error)) throw error;
    return undefined;
  }
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
 * Rebase physical source targets into the copy or retain an admitted dependency
 * namespace. Walking lexical ancestors also preserves package links within a
 * shared installation without relying on directory-copy traversal order.
 */
async function resolveSnapshotTarget(
  target: string,
  sourceRoot: string,
  dependencyRoots: ReadonlyArray<readonly [relative: string, target: string]>,
): Promise<string> {
  const relative = path.relative(sourceRoot, await resolveLinkTarget(target));
  if (!isOutsideWorkspace(relative)) return relative;
  const suffix: string[] = [];
  let ancestor = target;
  while (path.dirname(ancestor) !== ancestor) {
    const physicalAncestor = await resolveLinkTarget(ancestor);
    const dependency = dependencyRoots.find(([, root]) => root === physicalAncestor);
    if (dependency) return path.join(dependency[0], ...suffix);
    suffix.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  return relative;
}

/**
 * Copy source files into a disposable workspace and link root and nested
 * dependency directories at their original relative paths. Dependency trees
 * are shared by convention, not protected against writes; callers must trust
 * the linked command and use an independent install for dependency mutations.
 * Source aliases are canonicalized through their existing ancestors and rebased
 * into the snapshot; aliases into admitted dependency namespaces stay shared.
 * Other external or excluded targets and overlapping physical source/destination
 * trees are refused before the command can run.
 */
export async function seedLinkedTestWorkspaceSnapshot(
  sourceRoot: string,
  snapshotRoot: string,
): Promise<void> {
  const dependencyRoots: Array<[relative: string, target: string]> = [];
  const sourceLinks: Array<[relative: string, target: string, type: "junction" | "file"]> = [];
  const resolvedSourceRoot = await realpath(sourceRoot);
  const resolvedSnapshotRoot = await resolveLinkTarget(path.resolve(snapshotRoot));
  if (![path.relative(resolvedSourceRoot, resolvedSnapshotRoot), path.relative(resolvedSnapshotRoot, resolvedSourceRoot)]
    .every(isOutsideWorkspace)) {
    throw new Error("Snapshot destination must be disjoint from the source workspace; choose a temporary root outside the checkout.");
  }
  await mkdir(path.dirname(snapshotRoot), { recursive: true });
  await cp(resolvedSourceRoot, snapshotRoot, {
    recursive: true,
    force: true,
    /** Admit dependency roots and defer source aliases until the complete namespace is known. */
    async filter(source) {
      const relative = path.relative(resolvedSourceRoot, source);
      if (!relative) return true;
      if (hasExcludedSegment(relative)) return false;
      if (path.basename(source).toLowerCase() === "node_modules") {
        if ((await statSnapshotTarget(source))?.isDirectory()) {
          const target = await resolveLinkTarget(source);
          const targetRelative = path.relative(resolvedSourceRoot, target);
          if (!isOutsideWorkspace(path.relative(target, resolvedSourceRoot))
            || (!isOutsideWorkspace(targetRelative) && (hasExcludedSegment(targetRelative)
              || !targetRelative.split(path.sep).some((segment) => segment.toLowerCase() === "node_modules")))) {
            throw new Error(`Dependency symlink must target an included dependency directory or external installation: ${relative}`);
          }
          dependencyRoots.push([relative, target]);
        }
        return false;
      }
      if (!(await lstat(source)).isSymbolicLink()) return true;
      sourceLinks.push([relative, path.resolve(path.dirname(source), await readlink(source)), (await statSnapshotTarget(source))?.isDirectory() ? "junction" : "file"]);
      return false;
    },
  });
  for (const [relative] of dependencyRoots) {
    await symlink(
      path.resolve(resolvedSourceRoot, relative),
      path.join(snapshotRoot, relative),
      "junction",
    );
  }
  for (const [relative, target, type] of sourceLinks) {
    const targetRelative = await resolveSnapshotTarget(target, resolvedSourceRoot, dependencyRoots);
    if (isOutsideWorkspace(targetRelative) || hasExcludedSegment(targetRelative)) {
      throw new Error(`Source symlink must target included workspace source: ${relative}`);
    }
    await symlink(path.resolve(snapshotRoot, targetRelative), path.join(snapshotRoot, relative), type);
  }
}
