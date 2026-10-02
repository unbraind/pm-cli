/**
 * @module sdk/test/workspace-snapshot
 * Copies linked-test source files while retaining each installed dependency root.
 */
import { cp, mkdir, stat, symlink } from "node:fs/promises";
import path from "node:path";

const EXCLUDED_SEGMENTS = new Set([
  ".agents", ".git", ".nyc_output", ".turbo", "coverage",
]);

/**
 * Copy source files into a disposable workspace and link root and nested
 * dependency directories at their original relative paths. Dependency trees
 * are shared by convention, not protected against writes; callers must trust
 * the linked command and use an independent install for dependency mutations.
 */
export async function seedLinkedTestWorkspaceSnapshot(
  sourceRoot: string,
  snapshotRoot: string,
): Promise<void> {
  const dependencyRoots: string[] = [];
  await mkdir(path.dirname(snapshotRoot), { recursive: true });
  await cp(sourceRoot, snapshotRoot, {
    recursive: true,
    force: true,
    async filter(source) {
      const relative = path.relative(sourceRoot, source);
      if (!relative) return true;
      if (relative.split(path.sep).some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
      if (path.basename(source) !== "node_modules") return true;
      if ((await stat(source, { throwIfNoEntry: false }))?.isDirectory()) dependencyRoots.push(relative);
      return false;
    },
  });
  for (const relative of dependencyRoots) {
    await symlink(
      path.resolve(sourceRoot, relative),
      path.join(snapshotRoot, relative),
      "junction",
    );
  }
}
