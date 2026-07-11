/**
 * @module core/workspace/gitignore
 *
 * Maintains the repository ignore contract for pm runtime and search caches.
 */
import path from "node:path";
import { readFileIfExists, writeFileAtomic } from "../fs/fs-utils.js";

/** Opening marker for the init-owned ignore block. */
export const PM_GITIGNORE_START = "# pm-cli:runtime-cache:start";
/** Closing marker for the init-owned ignore block. */
export const PM_GITIGNORE_END = "# pm-cli:runtime-cache:end";

const PM_GITIGNORE_BLOCK = [
  PM_GITIGNORE_START,
  ".agents/pm/runtime/",
  ".agents/pm/search/",
  PM_GITIGNORE_END,
].join("\n");

/** Result of reconciling the init-owned repository ignore block. */
export interface EnsurePmGitignoreResult {
  /** Absolute path to the reconciled file. */
  path: string;
  /** Whether the file content changed. */
  changed: boolean;
}

/** Return the canonical pm ignore block, primarily for documentation and tests. */
export function getPmGitignoreBlock(): string {
  return PM_GITIGNORE_BLOCK;
}

/** Idempotently create or replace the fenced pm cache block in a workspace `.gitignore`. */
export async function ensurePmGitignore(
  workspaceRoot: string,
): Promise<EnsurePmGitignoreResult> {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  const current = (await readFileIfExists(gitignorePath)) ?? "";
  const start = current.indexOf(PM_GITIGNORE_START);
  const end = current.indexOf(PM_GITIGNORE_END);
  const withoutManagedBlock =
    start >= 0 && end >= start
      ? `${current.slice(0, start)}${current.slice(end + PM_GITIGNORE_END.length)}`
      : current;
  const prefix = withoutManagedBlock.trimEnd();
  const next = `${prefix.length > 0 ? `${prefix}\n\n` : ""}${PM_GITIGNORE_BLOCK}\n`;
  if (next === current) {
    return { path: gitignorePath, changed: false };
  }
  await writeFileAtomic(gitignorePath, next);
  return { path: gitignorePath, changed: true };
}
