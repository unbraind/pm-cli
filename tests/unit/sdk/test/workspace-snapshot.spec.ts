import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { seedLinkedTestWorkspaceSnapshot } from "../../../../src/sdk/test/workspace-snapshot.js";

describe("linked workspace snapshot filesystem policy", () => {
  it("retains Git commit and tag identity without sharing objects, remotes, configuration or hooks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-snapshot-git-"));
    const source = path.join(root, "source");
    const snapshot = path.join(root, "snapshot");
    try {
      await mkdir(path.join(source, ".agents/pm"), { recursive: true });
      await writeFile(path.join(source, "package.json"), '{"name":"snapshot-fixture"}');
      await writeFile(path.join(source, ".agents/pm/private"), "source tracker");
      const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
      git(source, ["init", "--initial-branch=fixture"]);
      git(source, ["add", "package.json"]);
      git(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Package identity"]);
      git(source, ["tag", "v1.0.0"]);
      git(source, ["config", "snapshot.private", "must-not-copy"]);
      await writeFile(path.join(source, ".git/hooks/pre-commit"), "private hook");
      const head = git(source, ["rev-parse", "HEAD"]);
      const previousGitDir = process.env.GIT_DIR;
      process.env.GIT_DIR = path.join(root, "unrelated-git-directory");
      try {
        await seedLinkedTestWorkspaceSnapshot(source, snapshot);
      } finally {
        if (previousGitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = previousGitDir;
      }
      expect(git(snapshot, ["rev-parse", "HEAD"])).toBe(head);
      expect(git(snapshot, ["describe", "--tags", "--exact-match"])).toBe("v1.0.0");
      expect(git(snapshot, ["remote"])).toBe("");
      expect(git(snapshot, ["config", "--get-regexp", "^core\\."])).not.toContain(source);
      expect(git(snapshot, ["config", "--list"])).not.toContain("snapshot.private");
      await expect(lstat(path.join(snapshot, ".git/hooks/pre-commit"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(path.join(snapshot, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
      git(snapshot, ["tag", "snapshot-only"]);
      expect(git(source, ["tag", "--list"])).toBe("v1.0.0");
      expect(await readFile(path.join(source, ".agents/pm/private"), "utf8")).toBe("source tracker");
      expect(git(source, ["rev-parse", "HEAD"])).toBe(head);
      const worktree = path.join(root, "worktree");
      git(source, ["worktree", "add", "--detach", worktree]);
      const worktreeSnapshot = path.join(root, "worktree-snapshot");
      await seedLinkedTestWorkspaceSnapshot(worktree, worktreeSnapshot);
      expect(git(worktreeSnapshot, ["rev-parse", "HEAD"])).toBe(head);
      expect(git(worktreeSnapshot, ["describe", "--tags", "--exact-match"])).toBe("v1.0.0");
      await rm(source, { recursive: true });
      expect(git(snapshot, ["show", "HEAD:package.json"])).toBe('{"name":"snapshot-fixture"}');
      expect(git(worktreeSnapshot, ["show", "HEAD:package.json"])).toBe('{"name":"snapshot-fixture"}');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
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
        await expect(lstat(path.join(snapshot, directory))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await realpath(path.join(snapshot, "directory-alias"))).toBe(await realpath(path.join(snapshot, "packages/lib")));
      await writeFile(path.join(snapshot, "packages/lib/file-alias"), "changed in snapshot");
      expect(await readFile(path.join(snapshot, "directory-alias/identity"), "utf8")).toBe("changed in snapshot");
      expect(await readFile(path.join(source, "packages/lib/identity"), "utf8")).toBe("packages/lib");
      await writeFile(path.join(snapshot, "packages/lib/dangling-alias"), "created in snapshot");
      expect(await readFile(path.join(snapshot, "packages/lib/missing"), "utf8")).toBe("created in snapshot");
      await expect(lstat(path.join(source, "packages/lib/missing"))).rejects.toMatchObject({ code: "ENOENT" });
      await mkdir(path.join(snapshot, "missing-parent"));
      await writeFile(path.join(snapshot, "absolute-dangling-alias"), "created through copied absolute alias");
      expect(await readFile(path.join(snapshot, "missing-parent/child"), "utf8")).toBe("created through copied absolute alias");
      await expect(lstat(path.join(source, "missing-parent"))).rejects.toMatchObject({ code: "ENOENT" });
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
      const linkedPackage = path.join(root, "linked-package");
      await mkdir(linkedPackage);
      await writeFile(path.join(linkedPackage, "identity"), "linked package");
      await symlink(linkedPackage, path.join(dependencies, "package"), "junction");
      await symlink(dependencies, path.join(source, "apps/site/node_modules"), process.platform === "win32" ? "junction" : "dir");
      await symlink(path.join(root, "missing"), path.join(source, "packages/dangling/node_modules"), process.platform === "win32" ? "junction" : "dir");
      await symlink("apps/site/node_modules/identity", path.join(source, "dependency-file-alias"), "file");
      await symlink(path.join(source, "apps/site/node_modules"), path.join(source, "dependency-directory-alias"), "junction");
      await symlink(path.join(dependencies, "missing"), path.join(source, "dependency-dangling-alias"), "file");
      await symlink("apps/site/node_modules/package/identity", path.join(source, "linked-package-alias"), "file");
      await seedLinkedTestWorkspaceSnapshot(source, snapshot);
      expect(await realpath(path.join(snapshot, "apps/site/node_modules"))).toBe(await realpath(dependencies));
      expect(await readFile(path.join(snapshot, "dependency-file-alias"), "utf8")).toBe("external installation");
      expect(await realpath(path.join(snapshot, "dependency-directory-alias"))).toBe(await realpath(dependencies));
      expect(await readFile(path.join(snapshot, "linked-package-alias"), "utf8")).toBe("linked package");
      expect((await lstat(path.join(snapshot, "dependency-dangling-alias"))).isSymbolicLink()).toBe(true);
      await expect(readFile(path.join(snapshot, "dependency-dangling-alias"))).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(path.join(snapshot, "dependency-dangling-alias"), "dependency writes remain shared");
      expect(await readFile(path.join(dependencies, "missing"), "utf8")).toBe("dependency writes remain shared");
      await expect(lstat(path.join(snapshot, "packages/dangling/node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses overlapping physical destinations before copying source bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-snapshot-destination-"));
    const source = path.join(root, "source");
    const sourceAlias = path.join(root, "source-alias");
    try {
      await mkdir(source);
      await writeFile(path.join(source, "identity"), "original source");
      await symlink(source, sourceAlias, "junction");
      for (const destination of [source, path.join(source, "nested/snapshot"), root, path.join(sourceAlias, "missing/snapshot")]) {
        await expect(seedLinkedTestWorkspaceSnapshot(source, destination))
          .rejects.toThrow("Snapshot destination must be disjoint from the source workspace; choose a temporary root outside the checkout.");
      }
      expect(await readFile(path.join(source, "identity"), "utf8")).toBe("original source");
      await expect(lstat(path.join(source, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(path.join(source, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(path.join(root, "identity"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses source aliases into external or excluded trees without changing their targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-snapshot-escape-"));
    const source = path.join(root, "source");
    try {
      await mkdir(path.join(source, ".agents"), { recursive: true });
      const dependencies = path.join(root, "installed");
      await mkdir(path.join(dependencies, ".agents"), { recursive: true });
      await writeFile(path.join(dependencies, ".agents/identity"), "excluded installed bytes");
      await symlink(dependencies, path.join(source, "node_modules"), "junction");
      await mkdir(path.join(root, "source-sibling"));
      await writeFile(path.join(source, ".agents/identity"), "tracker remains private");
      await writeFile(path.join(root, "identity"), "parent remains private");
      await writeFile(path.join(root, "source-sibling/identity"), "sibling remains private");
      for (const [index, target] of ["..", "../source-sibling", ".agents", "node_modules/.agents"].entries()) {
        const alias = path.join(source, "alias");
        await symlink(path.resolve(source, target), alias, "junction");
        await expect(seedLinkedTestWorkspaceSnapshot(source, path.join(root, `snapshot-${index}`)))
          .rejects.toThrow("Source symlink must target included workspace source: alias");
        await rm(alias);
      }
      expect(await readFile(path.join(source, ".agents/identity"), "utf8")).toBe("tracker remains private");
      expect(await readFile(path.join(root, "identity"), "utf8")).toBe("parent remains private");
      expect(await readFile(path.join(root, "source-sibling/identity"), "utf8")).toBe("sibling remains private");
      expect(await readFile(path.join(dependencies, ".agents/identity"), "utf8")).toBe("excluded installed bytes");
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

  it("refuses missing external targets and propagates cyclic source and destination errors", async () => {
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
      await rm(alias);
      const destination = path.join(root, "cyclic-destination");
      await symlink(destination, destination, "file");
      await expect(seedLinkedTestWorkspaceSnapshot(source, destination)).rejects.toMatchObject({ code: "ELOOP" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
