import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runHealth } from "../../../../src/sdk/governance/health.js";
import { readSettings } from "../../../../src/core/store/settings.js";
import {
  auditMergeAttributeFence,
  installMergeFence,
  resolveProjectMergeTypeFolders,
} from "../../../../src/sdk/merge/install.js";
import { gitWorkspaceEnvironment, stripGitPathTerminator } from "../../../../src/sdk/merge/worktree-config.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const FIXTURE_IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitWorkspaceEnvironment() }).trim();
}

function seedRepository(directory: string): void {
  git(directory, "init", "-q");
  git(directory, ...FIXTURE_IDENTITY, "commit", "--allow-empty", "-qm", "seed");
}

/** The merge attribute Git itself selects for a tracker item path. */
function gitMergeAttribute(worktree: string): string {
  return git(worktree, "check-attr", "merge", "--", ".agents/pm/tasks/fixture.toon");
}

/**
 * GH-1759 layout: `outer` is one repository, and `outer/linked` is a linked
 * worktree of a different repository (`seed`). The tracker lives in the linked
 * worktree, whose own fence was installed and then removed, while `outer`
 * carries a stale fence whose patterns match the tracker's path.
 */
async function buildEnclosedLinkedWorktree(tempRoot: string, templateTracker: string) {
  const outer = path.join(tempRoot, "outer");
  const seed = path.join(tempRoot, "seed");
  await mkdir(outer);
  await mkdir(seed);
  seedRepository(outer);
  seedRepository(seed);
  const linked = path.join(outer, "linked");
  git(seed, "worktree", "add", "-qb", "fixture", linked);
  const pmRoot = path.join(linked, ".agents", "pm");
  await cp(templateTracker, pmRoot, { recursive: true });
  const installed = await installMergeFence({ workspaceRoot: linked, pmRoot });
  expect(installed.ok).toBe(true);
  const innerFence = path.join(linked, ".gitattributes");
  const fence = await readFile(innerFence, "utf8");
  await writeFile(path.join(outer, ".gitattributes"), fence.replaceAll(".agents/pm", "linked/.agents/pm"));
  const parkedFence = path.join(tempRoot, "inner-fence");
  await rename(innerFence, parkedFence);
  return { outer, linked, pmRoot, innerFence, parkedFence };
}

describe("merge fence evidence is bounded to the active Git worktree (GH-1759)", () => {
  it("strips only the line terminator Git appends to a printed path", () => {
    expect(stripGitPathTerminator("/repo\n")).toBe("/repo");
    expect(stripGitPathTerminator("/repo \n", "linux")).toBe("/repo ");
    expect(stripGitPathTerminator("/repo\n\n", "linux")).toBe("/repo\n");
    // A POSIX name may end in a carriage return; a Windows name cannot, so CRLF is one terminator there.
    expect(stripGitPathTerminator("/repo\r\n", "linux")).toBe("/repo\r");
    expect(stripGitPathTerminator("C:\\repo\r\n", "win32")).toBe("C:\\repo");
    expect(stripGitPathTerminator("C:\\repo", "win32")).toBe("C:\\repo");
  });

  it.skipIf(process.platform === "win32")("repairs a symlinked fence and keeps an ordinary clone whose name ends in a line break local", async () => {
    await withTempPmPath(async ({ tempRoot, pmPath }) => {
      const repository = path.join(tempRoot, "line\n");
      await mkdir(repository);
      seedRepository(repository);
      const pmRoot = path.join(repository, ".agents", "pm");
      await cp(pmPath, pmRoot, { recursive: true });
      expect((await installMergeFence({ workspaceRoot: repository, pmRoot })).ok).toBe(true);
      // One query per Git path: the line break inside the name never makes the clone look linked.
      expect(() => git(repository, "config", "--local", "--get", "extensions.worktreeConfig")).toThrow();
      const typeFolders = resolveProjectMergeTypeFolders(await readSettings(pmRoot));
      const fence = path.join(repository, ".gitattributes");
      expect(await auditMergeAttributeFence(pmRoot, typeFolders)).toMatchObject({ status: "ok", path: fence });

      // A symlinked .gitattributes whose target already holds the block protects nothing in Git.
      const target = path.join(tempRoot, "linked-fence");
      await rename(fence, target);
      await symlink(target, fence);
      expect(await auditMergeAttributeFence(pmRoot, typeFolders)).toMatchObject({ status: "not_installed" });
      const preview = await installMergeFence({ workspaceRoot: repository, pmRoot, dryRun: true });
      expect(JSON.stringify(preview)).toContain('"changed":true');
      expect((await lstat(fence)).isSymbolicLink()).toBe(true);
      const targetBefore = await readFile(target, "utf8");
      expect((await installMergeFence({ workspaceRoot: repository, pmRoot })).ok).toBe(true);
      // The install replaced the link with a regular file and left the link target untouched.
      expect((await lstat(fence)).isFile()).toBe(true);
      expect(await readFile(fence, "utf8")).toBe(targetBefore);
      expect(await readFile(target, "utf8")).toBe(targetBefore);
      expect(gitMergeAttribute(repository)).toMatch(/: merge: pm-item-toon$/u);
      expect(await auditMergeAttributeFence(pmRoot, typeFolders)).toMatchObject({ status: "ok", path: fence });
    });
  });

  it.skipIf(process.platform === "win32")("never counts a matching fence above the linked worktree's top level", async () => {
    await withTempPmPath(async ({ tempRoot, pmPath }) => {
      const layout = await buildEnclosedLinkedWorktree(tempRoot, pmPath);
      // Git sees no PM merge attribute: the outer fence is above its top level.
      expect(git(layout.linked, "rev-parse", "--show-toplevel")).toBe(layout.linked);
      expect(gitMergeAttribute(layout.linked)).toMatch(/: merge: unspecified$/u);

      const typeFolders = resolveProjectMergeTypeFolders(await readSettings(layout.pmRoot));
      const audit = await auditMergeAttributeFence(layout.pmRoot, typeFolders);
      expect(audit).toMatchObject({ status: "not_installed" });
      // Negative control: the unbounded walk this fix replaces accepts the outer fence as a match.
      expect(await auditMergeAttributeFence(layout.pmRoot, typeFolders, { gitWorkspaceRoot: null })).toMatchObject({
        status: "ok",
        path: path.join(layout.outer, ".gitattributes"),
      });

      const strict = await runHealth({ path: layout.pmRoot }, { strictExit: true, skipVectors: true });
      expect(strict.ok).toBe(false);
      expect(strict.failed_because).toContain("merge_fence_missing:1");

      // Control: the linked worktree's own fence is what Git applies, and it passes.
      await rename(layout.parkedFence, layout.innerFence);
      expect(gitMergeAttribute(layout.linked)).toMatch(/: merge: pm-item-toon$/u);
      expect(await auditMergeAttributeFence(layout.pmRoot, typeFolders)).toMatchObject({
        status: "ok",
        path: layout.innerFence,
      });
      const restored = await runHealth({ path: layout.pmRoot }, { strictExit: true, skipVectors: true });
      expect(restored.failed_because ?? []).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^merge_fence_/u)]),
      );
      expect(restored.ok).toBe(true);
    });
  });

  it.skipIf(process.platform === "win32")("keeps a fence inside the same repository and judges a symlinked tracker path by its real location", async () => {
    await withTempPmPath(async ({ tempRoot, pmPath }) => {
      const repository = path.join(tempRoot, "repository");
      await mkdir(repository);
      seedRepository(repository);
      const nested = path.join(repository, "nested");
      const pmRoot = path.join(nested, ".agents", "pm");
      await cp(pmPath, pmRoot, { recursive: true });
      expect((await installMergeFence({ workspaceRoot: repository, pmRoot })).ok).toBe(true);
      const rootFence = path.join(repository, ".gitattributes");
      const typeFolders = resolveProjectMergeTypeFolders(await readSettings(pmRoot));
      const atRoot = await auditMergeAttributeFence(pmRoot, typeFolders);
      expect(atRoot).toMatchObject({ status: "ok", path: rootFence });

      // A fence in a directory between the repository root and the tracker is one Git applies.
      const nestedFence = path.join(nested, ".gitattributes");
      await writeFile(nestedFence, (await readFile(rootFence, "utf8")).replaceAll("nested/.agents/pm", ".agents/pm"));
      await rm(rootFence);
      expect(git(nested, "check-attr", "merge", "--", ".agents/pm/tasks/fixture.toon")).toMatch(/: merge: pm-item-toon$/u);
      const inRepository = await auditMergeAttributeFence(pmRoot, typeFolders);
      expect(inRepository).toMatchObject({ status: "ok", path: nestedFence });

      // A symlinked tracker path, and a symlinked caller-supplied root, are judged where Git sees them.
      const alias = path.join(tempRoot, "alias");
      await symlink(nested, alias, "dir");
      const rootAlias = path.join(tempRoot, "root-alias");
      await symlink(repository, rootAlias, "dir");
      for (const gitWorkspaceRoot of [undefined, repository, rootAlias]) {
        expect(
          await auditMergeAttributeFence(path.join(alias, ".agents", "pm"), typeFolders, { gitWorkspaceRoot }),
        ).toEqual(inRepository);
      }
      expect(await auditMergeAttributeFence(pmRoot, typeFolders, { gitWorkspaceRoot: rootAlias })).toEqual(inRepository);

      // A link inside the worktree back to its root never lets the walk climb into the link's own parents:
      // Git reads repository/sub/.gitattributes for files under sub, not for the tracker.
      const sub = path.join(repository, "sub");
      await mkdir(sub);
      await symlink(repository, path.join(sub, "loop"), "dir");
      await writeFile(path.join(sub, ".gitattributes"), (await readFile(nestedFence, "utf8")).replaceAll(".agents/pm", "loop/nested/.agents/pm"));
      await rm(nestedFence);
      expect(
        await auditMergeAttributeFence(path.join(sub, "loop", "nested", ".agents", "pm"), typeFolders),
      ).toMatchObject({ status: "not_installed" });

      // Git does not follow a symlinked .gitattributes in the working tree, so neither does the audit.
      const outsideFence = path.join(tempRoot, "outside-fence");
      await writeFile(outsideFence, (await readFile(path.join(sub, ".gitattributes"), "utf8")).replaceAll("loop/nested/.agents/pm", ".agents/pm"));
      await symlink(outsideFence, nestedFence);
      expect(git(nested, "check-attr", "merge", "--", ".agents/pm/tasks/fixture.toon")).toMatch(/: merge: unspecified$/u);
      expect(await auditMergeAttributeFence(pmRoot, typeFolders)).toMatchObject({ status: "not_installed" });
      await rm(nestedFence);

      // A boundary that does not hold the tracker leaves no directory Git would read for it.
      const unrelated = path.join(tempRoot, "unrelated");
      await mkdir(unrelated);
      expect(await auditMergeAttributeFence(pmRoot, typeFolders, { gitWorkspaceRoot: unrelated })).toMatchObject({
        status: "not_installed",
      });
      // A caller-supplied root that does not resolve bounds nothing Git would read either.
      expect(
        await auditMergeAttributeFence(pmRoot, typeFolders, { gitWorkspaceRoot: path.join(tempRoot, "absent") }),
      ).toMatchObject({ status: "not_installed" });
      // Outside Git the walk keeps its eight-level cap.
      const outsideGit = path.join(unrelated, "a", "b", "c", "d", "e", "f", "g", "h", ".agents", "pm");
      await mkdir(outsideGit, { recursive: true });
      await writeFile(path.join(unrelated, ".gitattributes"), await readFile(path.join(sub, ".gitattributes"), "utf8"));
      expect(await auditMergeAttributeFence(outsideGit, typeFolders, { gitWorkspaceRoot: null })).toMatchObject({
        status: "not_installed",
      });
      // An unresolvable tracker directory ends the walk instead of reading past it.
      expect(
        await auditMergeAttributeFence(path.join(nested, "missing", ".agents", "pm"), typeFolders, {
          gitWorkspaceRoot: repository,
        }),
      ).toMatchObject({ status: "not_installed" });
    });
  });

  it.skipIf(process.platform === "win32")("reaches the root fence of a deep tracker and of a worktree whose name ends in a space", async () => {
    await withTempPmPath(async ({ tempRoot, pmPath }) => {
      // The bound replaces the eight-level cap inside Git, so a tracker nine levels down still finds the root fence.
      const repository = path.join(tempRoot, "spaced ");
      await mkdir(repository);
      seedRepository(repository);
      const deep = path.join(repository, "a", "b", "c", "d", "e", "f", "g", ".agents", "pm");
      await cp(pmPath, deep, { recursive: true });
      expect((await installMergeFence({ workspaceRoot: repository, pmRoot: deep })).ok).toBe(true);
      const typeFolders = resolveProjectMergeTypeFolders(await readSettings(deep));
      expect(await auditMergeAttributeFence(deep, typeFolders)).toMatchObject({
        status: "ok",
        path: path.join(repository, ".gitattributes"),
      });
      // Git's reported top level keeps its trailing space, so the bound holds and no enclosing fence is read.
      await writeFile(path.join(tempRoot, ".gitattributes"), await readFile(path.join(repository, ".gitattributes"), "utf8"));
      await rm(path.join(repository, ".gitattributes"));
      expect(await auditMergeAttributeFence(deep, typeFolders)).toMatchObject({ status: "not_installed" });
    });
  });
});
