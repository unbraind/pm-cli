import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import { gitWorkspaceEnvironment, resolveMergeDriverConfigScope } from "../../../../src/sdk/merge/worktree-config.js";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installMergeFence, auditMergeDriverConfiguration, findGitWorkspaceRoot } from "../../../../src/sdk/merge/install.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("worktree-local merge drivers", () => {
  // This executable proxy delegates every command to native Git and changes
  // only its owned fixture between scope discovery and the selected-layer read.
  it.skipIf(process.platform === "win32")("refuses a racing unreadable config before attempting any driver writes", async () => {
    await withTempPmPath(async ({ tempRoot, pmPath }) => {
      const nativeGit = path.join(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "git");
      execFileSync(nativeGit, ["init", "-q"], { cwd: tempRoot, env: gitWorkspaceEnvironment() });
      execFileSync(nativeGit, ["config", "extensions.worktreeConfig", "true"], { cwd: tempRoot });
      const attributes = path.join(tempRoot, ".gitattributes");
      await writeFile(attributes, "# unrelated attributes must survive\n*.private -diff\n");
      const before = await readFile(attributes);
      const proxyRoot = path.join(tempRoot, "git-proxy");
      await mkdir(proxyRoot);
      const calls = path.join(tempRoot, "git-calls.jsonl");
      const worktreeConfig = path.join(tempRoot, ".git", "config.worktree");
      const proxy = path.join(proxyRoot, "git");
      await writeFile(proxy, [
        "#!/usr/bin/env node",
        "const { spawnSync } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "const args = process.argv.slice(2);",
        "writeFileSync(" + JSON.stringify(calls) + ", JSON.stringify(args) + '\\n', { flag: 'a' });",
        "const result = spawnSync(" + JSON.stringify(nativeGit) + ", args, { stdio: ['ignore', 'pipe', 'pipe'] });",
        "process.stdout.write(result.stdout); process.stderr.write(result.stderr);",
        "if (args.includes('--get') && args.includes('extensions.worktreeConfig')) writeFileSync(" + JSON.stringify(worktreeConfig) + ", '[invalid\\n');",
        "process.exit(result.status ?? 1);",
      ].join("\n"));
      await chmod(proxy, 0o755);
      const originalPath = process.env.PATH;
      try {
        process.env.PATH = proxyRoot + path.delimiter + originalPath;
        await expect(installMergeFence({ workspaceRoot: tempRoot, pmRoot: pmPath }))
          .rejects.toThrow("Cannot install repository-local merge drivers");
        expect(await readFile(attributes)).toEqual(before);
        const commands = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
        expect(commands.at(-1)).toEqual(["config", "--worktree", "--null", "--get-regexp", "."]);
        expect(commands.filter((args) => args.includes("--get-regexp"))).toHaveLength(1);
      } finally {
        process.env.PATH = originalPath;
      }
    });
  });

  it("waits for a released Git config lock and leaves matching configuration untouched", async () => {
    await withTempPmPath(async ({ tempRoot, pmPath }) => {
      execFileSync("git", ["init", "-q"], { cwd: tempRoot, env: gitWorkspaceEnvironment() });
      const config = path.join(tempRoot, ".git", "config");
      const lock = `${config}.lock`;
      await writeFile(lock, "another Git writer");
      const release = setTimeout(() => { void rm(lock); }, 200);
      try {
        const installations = await Promise.all(Array.from({ length: 3 }, () =>
          installMergeFence({ workspaceRoot: tempRoot, pmRoot: pmPath })));
        expect(installations.every((result) => result.ok)).toBe(true);
        expect(await auditMergeDriverConfiguration(tempRoot)).toMatchObject({ status: "ok" });
        const before = await readFile(config);
        const beforeStat = await stat(config);
        await writeFile(lock, "unrelated Git writer still holds the lock");
        expect((await installMergeFence({ workspaceRoot: tempRoot, pmRoot: pmPath })).gitattributes.changed).toBe(false);
        expect(await readFile(config)).toEqual(before);
        expect((await stat(config)).mtimeMs).toBe(beforeStat.mtimeMs);
        expect(await readFile(lock, "utf8")).toBe("unrelated Git writer still holds the lock");
      } finally {
        clearTimeout(release);
        await rm(lock, { force: true });
      }
    });
  });

  it("selects a stable Bun launcher and accepts its installed driver commands", async () => {
    await withTempPmPath(async ({ tempRoot, pmPath }) => {
      execFileSync("git", ["init", "-q"], { cwd: tempRoot, env: gitWorkspaceEnvironment() });
      const staleDir = path.join(tempRoot, "stale-runtime");
      const stableDir = path.join(tempRoot, "stable-runtime");
      const executableName = process.platform === "win32" ? "bun.exe" : "bun";
      const staleBinary = path.join(staleDir, executableName);
      const stableBinary = path.join(stableDir, executableName);
      const disposableBinary = path.join(tempRoot, "bun-node-disposable", executableName);
      const originalExecPath = process.execPath;
      const runtimeVersion = (process.versions as Record<string, string | undefined>).bun ?? process.version;
      await mkdir(staleDir);
      await mkdir(stableDir);
      await writeFile(staleBinary, "#!/bin/sh\nprintf 'old\\n'\n");
      await copyFile(originalExecPath, stableBinary);
      await chmod(staleBinary, 0o755);
      await chmod(stableBinary, 0o755);
      const originalPath = process.env.PATH;
      const originalNpmExecpath = process.env.npm_execpath;
      const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
      const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      try {
        process.env.PATH = [staleDir, stableDir, originalPath].join(path.delimiter);
        Object.defineProperty(process.versions, "bun", { value: runtimeVersion, configurable: true });
        const installed = await installMergeFence({ workspaceRoot: tempRoot, pmRoot: pmPath });
        expect(installed.git_config.find((entry) => entry.key === "merge.pm-history.driver")?.value)
          .toContain(`'${stableBinary}'`);
        expect(await auditMergeDriverConfiguration(tempRoot)).toMatchObject({ status: "ok" });
        process.env.PATH = staleDir;
        process.env.npm_execpath = stableBinary;
        const bunxInstalled = await installMergeFence({
          workspaceRoot: tempRoot,
          pmRoot: pmPath,
          dryRun: true,
        });
        expect(bunxInstalled.git_config.find((entry) => entry.key === "merge.pm-history.driver")?.value)
          .toContain(`'${stableBinary}'`);
        delete process.env.npm_execpath;
        Object.defineProperty(process, "execPath", { value: stableBinary, configurable: true });
        const directlyInvoked = await installMergeFence({
          workspaceRoot: tempRoot,
          pmRoot: pmPath,
          dryRun: true,
        });
        expect(directlyInvoked.git_config.find((entry) => entry.key === "merge.pm-history.driver")?.value)
          .toContain(`'${stableBinary}'`);
        Object.defineProperty(process, "execPath", { value: disposableBinary, configurable: true });
        await mkdir(path.join(tempRoot, "bun-node-disposable"));
        await copyFile(originalExecPath, disposableBinary);
        await chmod(disposableBinary, 0o755);
        await expect(installMergeFence({
          workspaceRoot: tempRoot,
          pmRoot: pmPath,
          dryRun: true,
        })).rejects.toThrow("Cannot install Bun merge drivers without a durable executable");
        await rm(stableBinary);
        await copyFile(originalExecPath, path.join(stableDir, "bun.exe"));
        await chmod(path.join(stableDir, "bun.exe"), 0o755);
        process.env.PATH = stableDir;
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        const windowsPathLauncher = await installMergeFence({
          workspaceRoot: tempRoot,
          pmRoot: pmPath,
          dryRun: true,
        });
        expect(windowsPathLauncher.git_config.find((entry) => entry.key === "merge.pm-history.driver")?.value)
          .toContain(`'${path.join(stableDir, "bun.exe")}'`);
      } finally {
        process.env.PATH = originalPath;
        if (originalNpmExecpath === undefined) delete process.env.npm_execpath;
        else process.env.npm_execpath = originalNpmExecpath;
        if (bunDescriptor === undefined) delete (process.versions as Record<string, string | undefined>).bun;
        else Object.defineProperty(process.versions, "bun", bunDescriptor);
        if (execPathDescriptor) Object.defineProperty(process, "execPath", execPathDescriptor);
        if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
      }
    });
  });

  it("binds discovery, installation and auditing to the requested repository despite inherited Git locations", async () => {
    await withTempPmPath(async ({ tempRoot, pmPath }) => {
      const foreign = path.join(tempRoot, "foreign");
      await mkdir(foreign);
      execFileSync("git", ["init", "-q"], { cwd: tempRoot, env: gitWorkspaceEnvironment() });
      execFileSync("git", ["init", "-q"], { cwd: foreign, env: gitWorkspaceEnvironment() });
      const original = { ...process.env };
      try {
        process.env.GIT_DIR = path.join(foreign, ".git");
        process.env.GIT_WORK_TREE = foreign;
        process.env.GIT_COMMON_DIR = path.join(foreign, ".git");
        expect(gitWorkspaceEnvironment().PATH).toBe(original.PATH);
        expect(await findGitWorkspaceRoot(tempRoot)).toBe(tempRoot);
        await installMergeFence({ workspaceRoot: tempRoot, pmRoot: pmPath });
        expect(await auditMergeDriverConfiguration(tempRoot)).toMatchObject({ status: "ok" });
        expect(await auditMergeDriverConfiguration(foreign)).toMatchObject({ status: "missing" });
      } finally {
        process.env = original;
      }
    });
  });
  it("preserves main drivers while installing and removing a linked worktree", async () => {
    await withTempPmPath(async ({ tempRoot, pmPath }) => {
      /** Run Git against an explicitly selected temporary worktree. */
      const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: gitWorkspaceEnvironment(), encoding: "utf8" }).trim();
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
      const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: gitWorkspaceEnvironment(), encoding: "utf8", timeout: 10_000 }).trim();
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
      const git = (args: string[]) => execFileSync("git", args, { cwd: tempRoot, env: gitWorkspaceEnvironment(), encoding: "utf8", timeout: 10_000 }).trim();
      git(["init", "-q"]);
      git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base"]);
      const linked = path.join(tempRoot, "linked");
      git(["worktree", "add", "-qb", "linked", linked]);
      git(["config", "core.worktree", tempRoot]);
      git(["config", "core.bare", "on"]);
      await writeFile(path.join(tempRoot, ".git/config.lock"), "held by another Git writer");
      await expect(resolveMergeDriverConfigScope(linked)).rejects.toThrow();
      expect(git(["config", "--local", "--get", "core.bare"])).toBe("on");
      expect(git(["config", "--local", "--get", "core.worktree"])).toBe(tempRoot);
      await rm(path.join(tempRoot, ".git/config.lock"));
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
