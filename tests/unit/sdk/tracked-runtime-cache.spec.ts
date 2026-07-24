import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runHealth } from "../../../src/cli/commands/health.js";
import { runValidate } from "../../../src/cli/commands/validate.js";
import { scanTrackedRuntimeCache } from "../../../src/sdk/governance/tracked-runtime-cache.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

describe("tracked runtime cache governance", () => {
  it("reports every tracked clone-local directory through health and validate", async () => {
    await withTempPmPath(async (context) => {
      runGit(context.tempRoot, ["init"]);
      const relativePaths = [
        ".agents/pm/checkpoints/update-many/receipt.json",
        ".agents/pm/locks/item.lock",
        ".agents/pm/runtime/state.json",
        ".agents/pm/search/index.json",
        ".agents/pm/transactions/sdk/journal.json",
      ];
      for (const relativePath of relativePaths) {
        const absolutePath = path.join(context.tempRoot, relativePath);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, "{}\n", "utf8");
      }
      const authoritativeSearchCorpus = ".agents/pm/search/eval-queries.json";
      await writeFile(
        path.join(context.tempRoot, authoritativeSearchCorpus),
        "[]\n",
        "utf8",
      );
      runGit(context.tempRoot, [
        "add",
        "-f",
        "--",
        ...relativePaths,
        authoritativeSearchCorpus,
      ]);

      const scan = await scanTrackedRuntimeCache(context.pmPath);
      expect(scan).toMatchObject({
        tracker_relative_root: ".agents/pm",
        tracked_path_count: 5,
        tracked_paths: [...relativePaths].sort((left, right) =>
          left.localeCompare(right),
        ),
      });
      expect(scan.git_workspace_root).toBe(context.tempRoot);
      expect(scan.remediation_command).toBe(
        "git rm --cached -r -- '.agents/pm/runtime' '.agents/pm/search' '.agents/pm/locks' '.agents/pm/transactions' '.agents/pm/checkpoints'",
      );

      const health = await runHealth(
        { path: context.pmPath },
        { noRefresh: true, skipDrift: true, skipVectors: true },
      );
      expect(health.warnings).toContain("tracked_runtime_cache_files:5");
      const integrity = health.checks.find(
        (check) => check.name === "integrity",
      );
      expect(integrity).toMatchObject({
        status: "warn",
        details: {
          counts: { tracked_runtime_cache_files: 5 },
          tracked_runtime_cache: {
            tracked_path_count: 5,
            tracked_paths: expect.arrayContaining(relativePaths),
            remediation_command: scan.remediation_command,
          },
          remediation_map: {
            tracked_runtime_cache_files:
              "git rm --cached -r -- <tracked-runtime-directories>",
          },
        },
      });

      const validation = await runValidate(
        { checkStorageIntegrity: true, fixHints: true },
        { path: context.pmPath },
      );
      expect(validation.warnings).toContain(
        "validate_storage_tracked_runtime_cache_files:5",
      );
      expect(validation.checks[0]).toMatchObject({
        name: "storage_integrity",
        status: "warn",
        details: {
          tracked_runtime_cache: {
            tracked_path_count: 5,
            tracked_paths: expect.arrayContaining(relativePaths),
            remediation_command: scan.remediation_command,
          },
          fix_hints: ["git rm --cached -r -- <tracked-runtime-directories>"],
        },
      });
    });
  });

  it("returns empty scans outside Git, at a Git root, and with no indexed caches", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-cache-scan-"));
    try {
      expect(await scanTrackedRuntimeCache(tempRoot)).toMatchObject({
        git_workspace_root: null,
        tracker_relative_root: null,
        tracked_path_count: 0,
        remediation_command: null,
      });
      runGit(tempRoot, ["init"]);
      expect(await scanTrackedRuntimeCache(tempRoot)).toMatchObject({
        git_workspace_root: tempRoot,
        tracker_relative_root: null,
        tracked_path_count: 0,
        remediation_command: null,
      });
      const customRoot = path.join(tempRoot, "tracker's pm");
      await mkdir(customRoot, { recursive: true });
      expect(await scanTrackedRuntimeCache(customRoot)).toMatchObject({
        tracker_relative_root: "tracker's pm",
        tracked_paths: [],
        tracked_path_count: 0,
        remediation_command: null,
      });
      const trackedPath = path.join(customRoot, "runtime", "state.json");
      await mkdir(path.dirname(trackedPath), { recursive: true });
      await writeFile(trackedPath, "{}\n", "utf8");
      runGit(tempRoot, ["add", "-f", "--", trackedPath]);
      expect(
        (await scanTrackedRuntimeCache(customRoot)).remediation_command,
      ).toContain("'tracker'\\''s pm/runtime'");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
