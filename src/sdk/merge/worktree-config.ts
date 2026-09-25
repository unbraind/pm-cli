/**
 * @module sdk/merge/worktree-config
 * Selects Git's worktree-local configuration without changing the meaning of
 * main-worktree-only settings when upgrading a linked-worktree repository.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Read an optional local key; configuration errors other than absence propagate. */
async function readLocalGitConfig(cwd: string, key: string): Promise<string | undefined> {
  try {
    const type = key === "core.bare" || key === "extensions.worktreeConfig" ? ["--type=bool"] : [];
    return (await execFileAsync("git", ["config", "--local", ...type, "--get", key], { cwd })).stdout.trim();
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
  const { stdout } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd: workspaceRoot });
  const [gitDir, commonDir] = stdout.trim().split(/\r?\n/);
  if (gitDir === commonDir) return "--local";
  const mainConfig = path.join(commonDir, "config.worktree");
  for (const key of ["core.bare", "core.worktree"]) {
    const value = await readLocalGitConfig(workspaceRoot, key);
    if (value === undefined || (key === "core.bare" && value !== "true")) continue;
    await execFileAsync("git", ["config", "--file", mainConfig, key, value], { cwd: workspaceRoot });
    await execFileAsync("git", ["config", "--local", "--unset-all", key], { cwd: workspaceRoot });
  }
  // The shared driver defaults remain as a migration fallback for worktrees
  // that have not run install yet; the main tree receives an explicit pin.
  for (const driver of ["pm-item-toon", "pm-item-markdown", "pm-history", "pm-relationship", "pm-json"]) {
    for (const field of ["name", "driver"]) {
      const key = `merge.${driver}.${field}`;
      const value = await readLocalGitConfig(workspaceRoot, key);
      if (value !== undefined) await execFileAsync("git", ["config", "--file", mainConfig, key, value], { cwd: workspaceRoot });
    }
  }
  await execFileAsync("git", ["config", "--local", "extensions.worktreeConfig", "true"], { cwd: workspaceRoot });
  return "--worktree";
}
