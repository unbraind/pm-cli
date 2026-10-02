import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { seedLinkedTestWorkspaceSnapshot } from "../../../../src/sdk/test/workspace-snapshot.js";

describe("linked workspace snapshot filesystem policy", () => {
  it("copies sources, excludes tracker/build trees, and retains each real dependency directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-snapshot-"));
    const source = path.join(root, "source");
    const snapshot = path.join(root, "disposable", "snapshot");
    try {
      for (const directory of ["node_modules", "apps/site/node_modules", "packages/lib", ".agents", ".git", ".nyc_output", ".turbo", "coverage"]) {
        await mkdir(path.join(source, directory), { recursive: true });
        await writeFile(path.join(source, directory, "identity"), directory);
      }
      await writeFile(path.join(source, "packages/lib/node_modules"), "not a directory");
      await symlink("identity", path.join(source, "packages/lib/file-alias"), "file");
      await symlink(path.join(source, "packages/lib"), path.join(source, "directory-alias"), "junction");
      await symlink("missing", path.join(source, "packages/lib/dangling-alias"), "file");
      const rootAlias = path.join(root, "source-alias");
      await symlink(source, rootAlias, "junction");
      await seedLinkedTestWorkspaceSnapshot(path.relative(process.cwd(), rootAlias), snapshot);
      for (const directory of ["node_modules", "apps/site/node_modules"]) {
        expect(await realpath(path.join(snapshot, directory))).toBe(await realpath(path.join(source, directory)));
        expect(await readFile(path.join(snapshot, directory, "identity"), "utf8")).toBe(directory);
      }
      for (const directory of [".agents", ".git", ".nyc_output", ".turbo", "coverage", "packages/lib/node_modules"]) {
        await expect(access(path.join(snapshot, directory))).rejects.toThrow("ENOENT");
      }
      expect(await realpath(path.join(snapshot, "directory-alias"))).toBe(await realpath(path.join(snapshot, "packages/lib")));
      await writeFile(path.join(snapshot, "packages/lib/file-alias"), "changed in snapshot");
      expect(await readFile(path.join(snapshot, "directory-alias/identity"), "utf8")).toBe("changed in snapshot");
      expect(await readFile(path.join(source, "packages/lib/identity"), "utf8")).toBe("packages/lib");
      await writeFile(path.join(snapshot, "packages/lib/dangling-alias"), "created in snapshot");
      expect(await readFile(path.join(snapshot, "packages/lib/missing"), "utf8")).toBe("created in snapshot");
      await expect(access(path.join(source, "packages/lib/missing"))).rejects.toThrow("ENOENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a source named node_modules, preserves external installation links, and omits dangling links", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-snapshot-links-"));
    const source = path.join(root, "node_modules");
    const dependencies = path.join(root, "installed");
    const snapshot = path.join(root, "snapshot");
    try {
      await mkdir(path.join(source, "apps/site"), { recursive: true });
      await mkdir(path.join(source, "packages/dangling"), { recursive: true });
      await mkdir(dependencies);
      await writeFile(path.join(dependencies, "identity"), "external installation");
      await symlink(dependencies, path.join(source, "apps/site/node_modules"), process.platform === "win32" ? "junction" : "dir");
      await symlink(path.join(root, "missing"), path.join(source, "packages/dangling/node_modules"), process.platform === "win32" ? "junction" : "dir");
      await seedLinkedTestWorkspaceSnapshot(source, snapshot);
      expect(await realpath(path.join(snapshot, "apps/site/node_modules"))).toBe(await realpath(dependencies));
      await expect(access(path.join(snapshot, "packages/dangling/node_modules"))).rejects.toThrow("ENOENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses source aliases into external or excluded trees without changing their targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-snapshot-escape-"));
    const source = path.join(root, "source");
    try {
      await mkdir(path.join(source, ".agents"), { recursive: true });
      await mkdir(path.join(root, "source-sibling"));
      await writeFile(path.join(source, ".agents/identity"), "tracker remains private");
      await writeFile(path.join(root, "identity"), "parent remains private");
      await writeFile(path.join(root, "source-sibling/identity"), "sibling remains private");
      for (const [index, target] of ["..", "../source-sibling", ".agents"].entries()) {
        const alias = path.join(source, "alias");
        await symlink(path.resolve(source, target), alias, "junction");
        await expect(seedLinkedTestWorkspaceSnapshot(source, path.join(root, `snapshot-${index}`)))
          .rejects.toThrow("Source symlink must target included workspace source: alias");
        await rm(alias);
      }
      expect(await readFile(path.join(source, ".agents/identity"), "utf8")).toBe("tracker remains private");
      expect(await readFile(path.join(root, "identity"), "utf8")).toBe("parent remains private");
      expect(await readFile(path.join(root, "source-sibling/identity"), "utf8")).toBe("sibling remains private");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
