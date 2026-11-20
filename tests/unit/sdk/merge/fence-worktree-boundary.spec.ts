import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runHealth } from "../../../../src/sdk/governance/health.js";
import { readSettings } from "../../../../src/core/store/settings.js";
import {
  auditMergeAttributeFence,
  installMergeFence,
  resolveProjectMergeTypeFolders,
} from "../../../../src/sdk/merge/install.js";
import { gitWorkspaceEnvironment } from "../../../../src/sdk/merge/worktree-config.js";
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

      // A symlinked logical path reaches the same fence with the same tracker-relative patterns.
      const alias = path.join(tempRoot, "alias");
      await symlink(nested, alias, "dir");
      const throughAlias = await auditMergeAttributeFence(path.join(alias, ".agents", "pm"), typeFolders, {
        gitWorkspaceRoot: repository,
      });
      expect(throughAlias).toEqual({ ...inRepository, path: path.join(alias, ".gitattributes") });

      // A boundary that does not hold the tracker leaves no directory Git would read for it.
      const unrelated = path.join(tempRoot, "unrelated");
      await mkdir(unrelated);
      expect(await auditMergeAttributeFence(pmRoot, typeFolders, { gitWorkspaceRoot: unrelated })).toMatchObject({
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
});
