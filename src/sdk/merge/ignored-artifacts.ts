/** Read Git's effective ignore rules before portable merge proof is staged. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { gitWorkspaceEnvironment } from "./worktree-config.js";

const execFileAsync = promisify(execFile);

/** Git's owning ignore rule for one untracked reconciliation artifact. */
export interface MergeArtifactIgnoreRule {
  /** Repository-relative artifact path, decoded without Git quoting. */
  path: string;
  /** Ignore file reported by Git, including global and clone-local sources. */
  source: string;
  /** One-based ignore file line. */
  line: number;
  /** Exact effective pattern, without interpretation by pm. */
  pattern: string;
}

/** Respect tracked files and negations while checking literal repository paths with Git's NUL protocol. */
export async function inspectIgnoredMergeArtifacts(workspaceRoot: string, paths: string[]): Promise<MergeArtifactIgnoreRule[]> {
  if (paths.length === 0) return [];
  let stdout: string;
  try {
    const pending = execFileAsync("git", ["check-ignore", "--verbose", "-z", "--stdin"], {
      cwd: workspaceRoot, env: gitWorkspaceEnvironment(), timeout: 10_000,
    });
    const input = pending.child.stdin;
    if (input !== null) {
      input.on("error", () => { pending.child.kill(); });
      input.end(`${paths.join("\0")}\0`);
    }
    ({ stdout } = await pending);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 1) return [];
    throw new PmCliError("Git could not verify ignore rules for merge artifacts; no automatic settlement is safe until that check succeeds.", EXIT_CODE.CONFLICT, {
      code: "merge_settlement_review_required", reason: "ignore_check_unavailable",
      nextSteps: ["Check Git configuration and ignore-file readability, then retry pm merge reconcile --stage --dry-run."],
    });
  }
  const fields = stdout.split("\0");
  const ignored: MergeArtifactIgnoreRule[] = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [source, line, pattern, target] = fields.slice(index, index + 4);
    if (!pattern.startsWith("!")) ignored.push({ path: target, source, line: Number(line), pattern });
  }
  return ignored;
}
