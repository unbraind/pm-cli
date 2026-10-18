/** Explicit installation of a clone-local hook for lossless merge settlement. */
import { execFile } from "node:child_process";
import { chmod, lstat } from "node:fs/promises";
import { promisify } from "node:util";
import { isFileMissingError, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { readBoundedRegularFile } from "./receipt-file-boundary.js";
import { gitWorkspaceEnvironment } from "./worktree-config.js";

const execFileAsync = promisify(execFile);
const HOOK_HEADER = "#!/bin/sh\n# pm-cli:lossless-merge-settlement:v1\n";

/** Preview an owned hook without replacing existing user policy or following file links. */
export async function prepareMergeSettlementHook(workspaceRoot: string, command: string): Promise<{
  path: string; changed: boolean; content: string;
}> {
  const hookPath = (await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"], {
    cwd: workspaceRoot, env: gitWorkspaceEnvironment(), timeout: 10_000,
  })).stdout.trim();
  let content: string | undefined;
  let executable = false;
  try {
    content = (await readBoundedRegularFile(hookPath, 65_536)) ?? "";
    executable = process.platform === "win32" || ((await lstat(hookPath)).mode & 0o111) !== 0;
  } catch (error: unknown) {
    if (!isFileMissingError(error)) throw error;
  }
  if (content !== undefined && !content.startsWith(HOOK_HEADER)) {
    throw new PmCliError("The pre-commit hook already exists and is not owned by pm; it was preserved.", EXIT_CODE.CONFLICT, {
      code: "merge_settlement_hook_conflict",
      recovery: { suggested_retry: "pm merge install --dry-run" },
      nextSteps: ["Integrate pm merge reconcile --stage into your existing hook after reviewing its policy, or keep manual settlement. pm never replaces an existing unowned hook."],
    });
  }
  const expected = `${HOOK_HEADER}merge_head=$(git rev-parse --git-path MERGE_HEAD) || exit 1\n[ -f "$merge_head" ] || exit 0\nexec ${command} merge reconcile --stage\n`;
  return { path: hookPath, changed: content !== expected || !executable, content: expected };
}

/** Publish an explicitly requested hook after its command and merge fence are installed. */
export async function writeMergeSettlementHook(hook: { path: string; changed: boolean; content: string }): Promise<void> {
  if (!hook.changed) return;
  await writeFileAtomic(hook.path, hook.content);
  await chmod(hook.path, 0o755);
}
