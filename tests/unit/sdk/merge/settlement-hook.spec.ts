/** Real filesystem coverage for preserving existing Git hook policy. */
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareMergeSettlementHook, writeMergeSettlementHook } from "../../../../src/sdk/merge/settlement-hook.js";
import { runMergeInstall } from "../../../../src/sdk/merge/install.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("explicit merge settlement hook", () => {
  it.each([false, true])("previews and installs the optional hook with an explicit tracker (tracker at Git root: %s)", async (trackerAtGitRoot) => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "-q"], { cwd: trackerAtGitRoot ? context.pmPath : context.tempRoot, env: context.env });
      const global = { path: context.pmPath };
      const preview = await runMergeInstall({ dryRun: true, preCommitHook: true }, global);
      expect(preview.settlement_hook).toMatchObject({ changed: true });
      await expect(readFile(preview.settlement_hook!.path)).rejects.toMatchObject({ code: "ENOENT" });
      const installed = await runMergeInstall({ preCommitHook: true }, global);
      expect(installed.settlement_hook).toEqual(preview.settlement_hook);
      expect(await readFile(installed.settlement_hook!.path, "utf8")).toContain("merge reconcile --stage");
      if (trackerAtGitRoot) {
        expect(installed.workspace_root).toBe(installed.pm_root);
        expect(await readFile(installed.settlement_hook!.path, "utf8")).toContain("--pm-path '.' merge reconcile --stage");
      }
      expect((await runMergeInstall({ preCommitHook: true }, global)).settlement_hook?.changed).toBe(false);
    });
  });
  it("is idempotent, repairs executable mode and never replaces unrelated policy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-settlement-hook-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      const hook = await prepareMergeSettlementHook(root, "'node' 'cli.js'");
      expect(hook.changed).toBe(true);
      await writeMergeSettlementHook(hook);
      expect(await prepareMergeSettlementHook(root, "'node' 'cli.js'")).toMatchObject({ changed: false });
      await writeMergeSettlementHook({ ...hook, changed: false });
      await chmod(hook.path, 0o644);
      if (process.platform !== "win32") expect((await prepareMergeSettlementHook(root, "'node' 'cli.js'")).changed).toBe(true);
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      try {
        Object.defineProperty(process, "platform", { value: "win32" });
        expect((await prepareMergeSettlementHook(root, "'node' 'cli.js'")).changed).toBe(false);
      } finally { Object.defineProperty(process, "platform", platform); }
      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        await chmod(hook.path, 0o000);
        try {
          await expect(prepareMergeSettlementHook(root, "ignored")).rejects.toMatchObject({ code: "EACCES" });
        } finally { await chmod(hook.path, 0o755); }
      }
      await writeFile(hook.path, "#!/bin/sh\nexit 7\n");
      await expect(prepareMergeSettlementHook(root, "ignored")).rejects.toMatchObject({ context: { code: "merge_settlement_hook_conflict" } });
      expect(await readFile(hook.path, "utf8")).toContain("exit 7");
      await rm(hook.path); await mkdir(hook.path);
      await expect(prepareMergeSettlementHook(root, "ignored")).rejects.toMatchObject({ context: { code: "merge_settlement_hook_conflict" } });
      await rm(hook.path, { recursive: true });
      await rm(path.dirname(hook.path), { recursive: true });
      await writeFile(path.dirname(hook.path), "not a directory");
      await expect(prepareMergeSettlementHook(root, "ignored")).rejects.toMatchObject({ code: 128 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
