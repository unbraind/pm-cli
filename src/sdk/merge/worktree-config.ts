/**
 * @module sdk/merge/worktree-config
 * Selects Git's worktree-local configuration without changing the meaning of
 * main-worktree-only settings when upgrading a linked-worktree repository.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);

/** Write clone-local configuration after a bounded wait for Git's own exclusive lock. Retry only the native lock-exists diagnostic; never remove another writer's lock or retry malformed and unwritable configuration. */
export async function writeMergeDriverGitConfig(cwd: string, args: string[]): Promise<void> {
  const deadline = performance.now() + 5_000;
  let backoff = 25;
  for (;;) {
    try {
      await execFileAsync("git", ["config", ...args], {
        cwd, env: { ...gitWorkspaceEnvironment(), LC_ALL: "C" }, timeout: 10_000,
      });
      return;
    } catch (error: unknown) {
      const remaining = deadline - performance.now();
      if (typeof error !== "object" || error === null || !("stderr" in error) ||
        typeof error.stderr !== "string" ||
        !/could not lock config file [^\r\n]+: File exists/u.test(error.stderr) || remaining <= 0) throw error;
      await delay(Math.min(backoff, remaining));
      backoff = Math.min(backoff * 2, 200);
    }
  }
}

/** Preserve caller tools and preferences while binding Git repository discovery and writes to the explicit cwd. */
export function gitWorkspaceEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM"]) {
    delete env[key];
  }
  return env;
}

/** Read an optional local key; configuration errors other than absence propagate. */
async function readLocalGitConfig(cwd: string, key: string): Promise<string | undefined> {
  try {
    const type = key === "core.bare" || key === "extensions.worktreeConfig" ? ["--type=bool"] : [];
    return (await execFileAsync("git", ["config", "--local", ...type, "--get", key], { cwd, env: gitWorkspaceEnvironment(), timeout: 10_000 })).stdout.trim();
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 1) return undefined;
    throw error;
  }
}

/**
 * Keep simple clones on local config. Linked worktrees opt into Git's native
 * per-worktree layer, first preserving the main worktree's special core keys.
 * Drivers already installed in the main tree are copied into its layer so
 * later installations cannot replace the main tree's runtime selection.
 */
export async function resolveMergeDriverConfigScope(workspaceRoot: string): Promise<"--local" | "--worktree"> {
  if ((await readLocalGitConfig(workspaceRoot, "extensions.worktreeConfig")) === "true") return "--worktree";
  const { stdout } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd: workspaceRoot, env: gitWorkspaceEnvironment(), timeout: 10_000 });
  const [gitDir, commonDir] = stdout.trim().split(/\r?\n/);
  if (gitDir === commonDir) return "--local";
  const mainConfig = path.join(commonDir, "config.worktree");
  for (const key of ["core.bare", "core.worktree"]) {
    const value = await readLocalGitConfig(workspaceRoot, key);
    if (value === undefined || (key === "core.bare" && value !== "true")) continue;
    await writeMergeDriverGitConfig(workspaceRoot, ["--file", mainConfig, key, value]);
    await writeMergeDriverGitConfig(workspaceRoot, ["--local", "--unset-all", key]);
  }
  // The shared driver defaults remain as a migration fallback for worktrees
  // that have not run install yet; the main tree receives an explicit pin.
  for (const driver of ["pm-item-toon", "pm-item-markdown", "pm-history", "pm-relationship", "pm-json"]) {
    for (const field of ["name", "driver"]) {
      const key = `merge.${driver}.${field}`;
      const value = await readLocalGitConfig(workspaceRoot, key);
      if (value !== undefined) await writeMergeDriverGitConfig(workspaceRoot, ["--file", mainConfig, key, value]);
    }
  }
  await writeMergeDriverGitConfig(workspaceRoot, ["--local", "extensions.worktreeConfig", "true"]);
  return "--worktree";
}
