/**
 * @module sdk/test/workspace-snapshot
 * Copies linked-test source files while retaining each installed dependency root.
 */
import { cp, lstat, mkdir, readlink, realpath, stat, symlink } from "node:fs/promises";
import path from "node:path";

const EXCLUDED_SEGMENTS = new Set([
  ".agents", ".git", ".nyc_output", ".turbo", "coverage",
]);

/**
 * Copy source files into a disposable workspace and link root and nested
 * dependency directories at their original relative paths. Dependency trees
 * are shared by convention, not protected against writes; callers must trust
 * the linked command and use an independent install for dependency mutations.
 * Source aliases are rebased into the snapshot; aliases outside the workspace
 * or into excluded tracker/build trees are refused without following them.
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
      if (relative.split(path.sep).some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
      if (path.basename(source) === "node_modules") {
        if ((await stat(source, { throwIfNoEntry: false }))?.isDirectory()) dependencyRoots.push(relative);
        return false;
      }
      if (!(await lstat(source)).isSymbolicLink()) return true;
      const target = path.resolve(path.dirname(source), await readlink(source));
      const targetRelative = path.relative(resolvedSourceRoot, target);
      if (targetRelative === ".." || targetRelative.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelative)
        || targetRelative.split(path.sep).some((segment) => EXCLUDED_SEGMENTS.has(segment))) {
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
