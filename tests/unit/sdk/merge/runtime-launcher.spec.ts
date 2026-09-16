import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installMergeFence } from "../../../../src/sdk/merge/install.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("merge runtime launcher", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("retains the unresolved absolute launcher for the running runtime", async () => {
    await withTempPmPath(async ({ tempRoot, pmPath }) => {
      const bin = path.join(tempRoot, "stable bin");
      await mkdir(bin);
      const launcher = path.join(bin, path.basename(process.execPath));
      await symlink(process.execPath, launcher, "file");
      vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
      execFileSync("git", ["init", "-q"], { cwd: tempRoot });
      const result = await installMergeFence({
        pmRoot: pmPath,
        workspaceRoot: tempRoot,
        dryRun: true,
      });
      for (const entry of result.git_config.filter(({ key }) =>
        key.endsWith(".driver"),
      )) {
        expect(entry.value.startsWith(`'${launcher}' `)).toBe(true);
      }
    });
  });

  it("merges through a stable launcher after the old runtime is removed", async () => {
    const cli = path.resolve("dist/cli.js");
    await withTempPmPath(async ({ tempRoot, pmPath, env }) => {
      const bin = path.join(tempRoot, "bin");
      const oldBin = path.join(tempRoot, "runtime-v1");
      const newBin = path.join(tempRoot, "runtime-v2");
      for (const directory of [bin, oldBin, newBin]) await mkdir(directory);
      const oldRuntime = path.join(oldBin, path.basename(process.execPath));
      const newRuntime = path.join(newBin, path.basename(process.execPath));
      const launcher = path.join(bin, path.basename(process.execPath));
      await copyFile(process.execPath, oldRuntime);
      await copyFile(process.execPath, newRuntime);
      await symlink(oldRuntime, launcher, "file");
      const commandEnv = {
        ...env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      };
      /** Exercise real Git operations using the upgradeable runtime environment. */
      const git = (args: string[]) =>
        execFileSync("git", args, {
          cwd: tempRoot,
          env: commandEnv,
          encoding: "utf8",
          timeout: 30_000,
        });
      git(["init", "-q"]);
      git(["config", "user.name", "Merge Test"]);
      git(["config", "user.email", "merge@example.invalid"]);
      execFileSync(oldRuntime, [cli, "merge", "install", "--no-extensions"], {
        cwd: tempRoot,
        env: commandEnv,
        timeout: 30_000,
      });
      expect(git(["config", "--get", "merge.pm-json.driver"])).toContain(
        `'${launcher}'`,
      );
      const document = path.join(pmPath, "upgrade-proof.json");
      await writeFile(document, '{"base":true}\n');
      git(["add", ".gitattributes", ".agents/pm/upgrade-proof.json"]);
      git(["commit", "-qm", "Base"]);
      git(["branch", "other"]);
      await writeFile(document, '{"base":true,"ours":true}\n');
      git(["commit", "-qam", "Ours"]);
      git(["checkout", "-q", "other"]);
      await writeFile(document, '{"base":true,"theirs":true}\n');
      git(["commit", "-qam", "Theirs"]);
      await rm(launcher);
      await symlink(newRuntime, launcher, "file");
      await rm(oldBin, { recursive: true });
      git(["merge", "--no-edit", "@{-1}"]);
      expect(JSON.parse(await readFile(document, "utf8"))).toEqual({
        base: true,
        ours: true,
        theirs: true,
      });
      expect(git(["diff", "--name-only", "--diff-filter=U"]).trim()).toBe("");
    });
  }, 60_000);

  it("keeps the pinned runtime when PATH is absent, relative, missing, or already canonical", async () => {
    await withTempPmPath(async ({ tempRoot, pmPath }) => {
      for (const searchPath of [
        undefined,
        "",
        "relative-bin",
        path.join(tempRoot, "missing"),
        path.dirname(process.execPath),
      ]) {
        vi.stubEnv("PATH", searchPath);
        const result = await installMergeFence({
          pmRoot: pmPath,
          workspaceRoot: tempRoot,
          dryRun: true,
        });
        expect(
          result.git_config.find(({ key }) => key === "merge.pm-history.driver")
            ?.value,
        ).toContain(`'${process.execPath}'`);
      }
    });
  });
});
