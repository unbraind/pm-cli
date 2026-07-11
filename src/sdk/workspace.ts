/**
 * @module sdk/workspace
 *
 * Maintains repository-scaffold contracts shared by the public SDK and CLI.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
  let current = "";
  try {
    current = await readFile(gitignorePath, "utf8");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
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
  await writeFile(gitignorePath, next, "utf8");
  return { path: gitignorePath, changed: true };
}
