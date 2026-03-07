import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { mutateItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemStatus } from "../../types/index.js";

export interface ClaimResult {
  item: Record<string, unknown>;
  claimed_by: string;
  previous_assignee: string | null;
  forced: boolean;
}

export interface ReleaseResult {
  item: Record<string, unknown>;
  released_by: string;
  previous_assignee: string | null;
  forced: boolean;
}

export interface ClaimMutationOptions {
  author?: string;
  message?: string;
}

function isTerminal(status: ItemStatus): boolean {
  return status === "closed" || status === "canceled";
}

function resolveAuthor(candidate: string | undefined, fallback: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? fallback;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

export async function runClaim(
  id: string,
  force: boolean,
  global: GlobalOptions,
  options: ClaimMutationOptions = {},
): Promise<ClaimResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const author = resolveAuthor(options.author, settings.author_default);
  let previousAssignee: string | null = null;

  const result = await mutateItem({
    pmRoot,
    settings,
    id,
    op: "claim",
    author,
    message: options.message,
    force,
    mutate(document) {
      previousAssignee = document.front_matter.assignee ?? null;
      if (isTerminal(document.front_matter.status) && !force) {
        throw new PmCliError(`Cannot claim terminal item ${document.front_matter.id} without --force`, EXIT_CODE.CONFLICT);
      }
      document.front_matter.assignee = author;
      return { changedFields: ["assignee"] };
    },
  });

  return {
    item: result.item as unknown as Record<string, unknown>,
    claimed_by: author,
    previous_assignee: previousAssignee,
    forced: force,
  };
}

export async function runRelease(
  id: string,
  force: boolean,
  global: GlobalOptions,
  options: ClaimMutationOptions = {},
): Promise<ReleaseResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const author = resolveAuthor(options.author, settings.author_default);
  let previousAssignee: string | null = null;

  const result = await mutateItem({
    pmRoot,
    settings,
    id,
    op: "release",
    author,
    message: options.message,
    force,
    mutate(document) {
      previousAssignee = document.front_matter.assignee ?? null;
      if (!previousAssignee) {
        return { changedFields: [] };
      }
      delete document.front_matter.assignee;
      return { changedFields: ["assignee"] };
    },
  });

  return {
    item: result.item as unknown as Record<string, unknown>,
    released_by: author,
    previous_assignee: previousAssignee,
    forced: force,
  };
}
