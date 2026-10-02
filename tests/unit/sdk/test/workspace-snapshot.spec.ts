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
      for (const directory of ["node_modules", "apps/site/node_modules", "packages/lib", ".agents", ".AGENTS", ".git", ".GIT", ".nyc_output", ".turbo", "coverage"]) {
        await mkdir(path.join(source, directory), { recursive: true });
        await writeFile(path.join(source, directory, "identity"), directory);
      }
      await writeFile(path.join(source, "packages/lib/node_modules"), "not a directory");
      const rootAlias = path.join(root, "source-alias");
      await symlink(source, rootAlias, "junction");
      await symlink("identity", path.join(source, "packages/lib/file-alias"), "file");
      await symlink(path.join(rootAlias, "packages/lib"), path.join(source, "directory-alias"), "junction");
      await symlink("missing", path.join(source, "packages/lib/dangling-alias"), "file");
      await symlink(path.join(rootAlias, "missing-parent/child"), path.join(source, "absolute-dangling-alias"), "file");
      await seedLinkedTestWorkspaceSnapshot(path.relative(process.cwd(), rootAlias), snapshot);
      for (const directory of ["node_modules", "apps/site/node_modules"]) {
        expect(await realpath(path.join(snapshot, directory))).toBe(await realpath(path.join(source, directory)));
        expect(await readFile(path.join(snapshot, directory, "identity"), "utf8")).toBe(directory);
      }
      for (const directory of [".agents", ".AGENTS", ".git", ".GIT", ".nyc_output", ".turbo", "coverage", "packages/lib/node_modules"]) {
        await expect(access(path.join(snapshot, directory))).rejects.toThrow("ENOENT");
      }
      expect(await realpath(path.join(snapshot, "directory-alias"))).toBe(await realpath(path.join(snapshot, "packages/lib")));
      await writeFile(path.join(snapshot, "packages/lib/file-alias"), "changed in snapshot");
      expect(await readFile(path.join(snapshot, "directory-alias/identity"), "utf8")).toBe("changed in snapshot");
      expect(await readFile(path.join(source, "packages/lib/identity"), "utf8")).toBe("packages/lib");
      await writeFile(path.join(snapshot, "packages/lib/dangling-alias"), "created in snapshot");
      expect(await readFile(path.join(snapshot, "packages/lib/missing"), "utf8")).toBe("created in snapshot");
      await expect(access(path.join(source, "packages/lib/missing"))).rejects.toThrow("ENOENT");
      await mkdir(path.join(snapshot, "missing-parent"));
      await writeFile(path.join(snapshot, "absolute-dangling-alias"), "created through copied absolute alias");
      expect(await readFile(path.join(snapshot, "missing-parent/child"), "utf8")).toBe("created through copied absolute alias");
      await expect(access(path.join(source, "missing-parent"))).rejects.toThrow("ENOENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a source named node_modules, preserves external installation links, and omits dangling links", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-snapshot-links-"));
    const source = path.join(root, "node_modules");
    const dependencies = path.join(root, ".git", "installed");
    const snapshot = path.join(root, "snapshot");
    try {
      await mkdir(path.join(source, "apps/site"), { recursive: true });
      await mkdir(path.join(source, "packages/dangling"), { recursive: true });
      await mkdir(dependencies, { recursive: true });
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

  it("rejects dependency aliases into original source or reserved tracker/build trees", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-snapshot-dependency-escape-"));
    const source = path.join(root, "source");
    try {
      await mkdir(source);
      for (const [index, directory] of [".", "..", "included", ".agents", ".AGENTS", ".git", ".GIT", "coverage"].entries()) {
        const target = path.join(source, directory);
        await mkdir(target, { recursive: true });
        await writeFile(path.join(target, "identity"), "excluded original bytes");
        const alias = path.join(source, "node_modules");
        await symlink(target, alias, "junction");
        await expect(seedLinkedTestWorkspaceSnapshot(source, path.join(root, `snapshot-${index}`)))
          .rejects.toThrow("Dependency symlink must target an included dependency directory or external installation: node_modules");
        expect(await readFile(path.join(target, "identity"), "utf8")).toBe("excluded original bytes");
        await rm(alias);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses missing external targets and propagates a cyclic source-link error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-snapshot-target-error-"));
    const source = path.join(root, "source");
    const alias = path.join(source, "alias");
    try {
      await mkdir(source);
      await symlink(path.join(path.parse(root).root, `${path.basename(root)}-missing`, "child"), alias, "file");
      await expect(seedLinkedTestWorkspaceSnapshot(source, path.join(root, "external-snapshot")))
        .rejects.toThrow("Source symlink must target included workspace source: alias");
      await rm(alias);
      await symlink(alias, alias, "file");
      await expect(seedLinkedTestWorkspaceSnapshot(source, path.join(root, "cyclic-snapshot"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
