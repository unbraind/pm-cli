import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { mutateItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemStatus } from "../../types/index.js";

export interface CloseCommandOptions {
  author?: string;
  message?: string;
  force?: boolean;
}

export interface CloseResult {
  item: Record<string, unknown>;
  changed_fields: string[];
  warnings: string[];
}

function toAuthor(candidate: string | undefined, defaultAuthor: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? defaultAuthor;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

function ensureCloseReason(reasonText: string): string {
  const reason = reasonText.trim();
  if (reason.length === 0) {
    throw new PmCliError("Close reason text must not be empty", EXIT_CODE.USAGE);
  }
  return reason;
}

function isTerminal(status: ItemStatus): boolean {
  return status === "closed" || status === "canceled";
}

export async function runClose(
  id: string,
  closeReasonText: string,
  options: CloseCommandOptions,
  global: GlobalOptions,
): Promise<CloseResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  const author = toAuthor(options.author, settings.author_default);
  const closeReason = ensureCloseReason(closeReasonText);

  const result = await mutateItem({
    pmRoot,
    settings,
    id,
    op: "close",
    author,
    message: options.message,
    force: options.force,
    mutate(document) {
      if (isTerminal(document.front_matter.status) && !options.force) {
        throw new PmCliError(`Item ${document.front_matter.id} is already terminal; use --force to close again.`, EXIT_CODE.CONFLICT);
      }

      document.front_matter.status = "closed";
      document.front_matter.close_reason = closeReason;

      const changedFields = ["status", "close_reason"];
      if (document.front_matter.assignee !== undefined) {
        delete document.front_matter.assignee;
        changedFields.push("assignee");
      }

      return { changedFields };
    },
  });

  return {
    item: result.item as unknown as Record<string, unknown>,
    changed_fields: result.changedFields,
    warnings: result.warnings,
  };
}
