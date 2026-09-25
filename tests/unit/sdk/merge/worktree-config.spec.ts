import { execFileSync } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolveMergeDriverConfigScope } from "../../../../src/sdk/merge/worktree-config.js";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installMergeFence, auditMergeDriverConfiguration } from "../../../../src/sdk/merge/install.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("worktree-local merge drivers", () => {
  it("preserves main drivers while installing and removing a linked worktree", async () => {
    await withTempPmPath(async ({ tempRoot, pmPath }) => {
      /** Run Git against an explicitly selected temporary worktree. */
      const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      git(tempRoot, ["init", "-q"]);
      git(tempRoot, ["config", "user.name", "Test"]);
      git(tempRoot, ["config", "user.email", "test@example.invalid"]);
      await installMergeFence({ workspaceRoot: tempRoot, pmRoot: pmPath });
      git(tempRoot, ["add", ".gitattributes", ".agents/pm/settings.json"]);
      git(tempRoot, ["commit", "-qm", "base"]);
      const linked = path.join(tempRoot, "linked");
      git(tempRoot, ["worktree", "add", "-qb", "linked", linked]);
      const linkedPm = path.join(linked, ".agents", "pm");
      // A distinguishable main-tree driver proves another installation cannot
      // silently rewrite the executable selected by that worktree.
      git(tempRoot, ["config", "merge.pm-history.driver", "main-tree-runtime"]);
      await installMergeFence({ workspaceRoot: linked, pmRoot: linkedPm });
      expect(git(tempRoot, ["config", "--get", "merge.pm-history.driver"])).toBe("main-tree-runtime");
      expect(git(linked, ["config", "--get", "merge.pm-history.driver"])).toContain("merge driver history");
      expect(await auditMergeDriverConfiguration(linked)).toMatchObject({ status: "ok" });
      await installMergeFence({ workspaceRoot: tempRoot, pmRoot: pmPath });
      git(tempRoot, ["config", "extensions.worktreeConfig", "yes"]);
      expect(await resolveMergeDriverConfigScope(tempRoot)).toBe("--worktree");
      git(linked, ["config", "--worktree", "merge.pm-history.driver", "linked-runtime"]);
      expect(await auditMergeDriverConfiguration(linked)).toMatchObject({ status: "drift" });
      expect(await auditMergeDriverConfiguration(tempRoot)).toMatchObject({ status: "ok" });
      git(tempRoot, ["worktree", "remove", "--force", linked]);
      expect(await auditMergeDriverConfiguration(tempRoot)).toMatchObject({ status: "ok" });
    });
  });
});

// Real Git configuration and package manifests cover drift without executing
// fixture binaries or substituting SDK internals.
describe("worktree migration and runtime identity", () => {
  it("rejects foreign sibling drivers and incompatible project version pins", async () => {
    await withTempPmPath(async ({ tempRoot, pmPath }) => {
      /** Run isolated Git commands with bounded child lifetimes. */
      const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 }).trim();
      git(tempRoot, ["init", "-q"]);
      git(tempRoot, ["config", "user.name", "Test"]);
      git(tempRoot, ["config", "user.email", "test@example.invalid"]);
      const installed = await installMergeFence({ workspaceRoot: tempRoot, pmRoot: pmPath });
      git(tempRoot, ["add", ".gitattributes"]);
      git(tempRoot, ["commit", "-qm", "base"]);
      const sibling = path.join(tempRoot, "sibling");
      git(tempRoot, ["worktree", "add", "-qb", "sibling", sibling]);
      await mkdir(path.join(sibling, "dist"));
      await writeFile(path.join(sibling, "dist/cli.js"), "// fixture runtime\n");
      const manifest = { name: "@unbrained/pm-cli", version: "2026.9.24", bin: { pm: "dist/cli.js" } };
      await writeFile(path.join(sibling, "package.json"), JSON.stringify(manifest));
      const driver = `'${process.execPath}' '${path.join(sibling, "dist/cli.js")}' merge driver history "%O" "%A" "%B"`;
      git(tempRoot, ["config", "merge.pm-history.driver", driver]);
      expect((await auditMergeDriverConfiguration(tempRoot)).drifted_keys).toEqual(["merge.pm-history.driver"]);
      git(tempRoot, ["config", "merge.pm-history.driver", installed.git_config.find((entry) => entry.key === "merge.pm-history.driver")!.value]);
      await writeFile(path.join(tempRoot, "package.json"), JSON.stringify({ dependencies: { "@unbrained/pm-cli": "2099.1.1" } }));
      expect((await auditMergeDriverConfiguration(tempRoot)).drifted_keys).toHaveLength(5);
      await rm(path.join(tempRoot, "package.json"));
      expect((await auditMergeDriverConfiguration(tempRoot)).status).toBe("ok");
    });
  });

  it("preserves main-only settings when enabling worktree config and reports unreadable config", async () => {
    await withTempPmPath(async ({ tempRoot }) => {
      /** Run Git in the temporary migration repository. */
      const git = (args: string[]) => execFileSync("git", args, { cwd: tempRoot, encoding: "utf8", timeout: 10_000 }).trim();
      git(["init", "-q"]);
      git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base"]);
      const linked = path.join(tempRoot, "linked");
      git(["worktree", "add", "-qb", "linked", linked]);
      git(["config", "core.worktree", tempRoot]);
      git(["config", "core.bare", "on"]);
      expect(await resolveMergeDriverConfigScope(linked)).toBe("--worktree");
      expect(git(["config", "--worktree", "--get", "core.worktree"])).toBe(tempRoot);
      expect(git(["config", "--worktree", "--get", "core.bare"])).toBe("true");
      expect(git(["config", "--local", "--get", "extensions.worktreeConfig"])).toBe("true");
      await writeFile(path.join(tempRoot, ".git/config"), "[invalid\n");
      await expect(resolveMergeDriverConfigScope(linked)).rejects.toThrow();
      await expect(resolveMergeDriverConfigScope(path.join(tempRoot, "missing"))).rejects.toThrow();
    });
  });
});
