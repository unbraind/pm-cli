import { pathExists } from "../../core/fs/fs-utils.js";
import { parseOptionalNumber, parseTags } from "../../core/item/parse.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { isNoneToken, resolveIsoOrRelative } from "../../core/shared/time.js";
import { mutateItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { ITEM_TYPE_VALUES, STATUS_VALUES } from "../../types/index.js";

export interface UpdateCommandOptions {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  type?: string;
  tags?: string;
  deadline?: string;
  estimatedMinutes?: string;
  acceptanceCriteria?: string;
  author?: string;
  message?: string;
  force?: boolean;
  assignee?: string;
}

export interface UpdateResult {
  item: Record<string, unknown>;
  changed_fields: string[];
  warnings: string[];
}

function toAuthor(candidate: string | undefined, defaultAuthor: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? defaultAuthor;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

function ensureEnum<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) {
    throw new PmCliError(`Invalid ${label} value "${value}"`, EXIT_CODE.USAGE);
  }
  return value as T;
}

function ensurePriority(raw: string): 0 | 1 | 2 | 3 | 4 {
  const parsed = parseOptionalNumber(raw, "priority");
  if (![0, 1, 2, 3, 4].includes(parsed)) {
    throw new PmCliError("Priority must be 0..4", EXIT_CODE.USAGE);
  }
  return parsed as 0 | 1 | 2 | 3 | 4;
}

export async function runUpdate(id: string, options: UpdateCommandOptions, global: GlobalOptions): Promise<UpdateResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const author = toAuthor(options.author, settings.author_default);

  const changedFlags = [
    options.title !== undefined,
    options.description !== undefined,
    options.status !== undefined,
    options.priority !== undefined,
    options.type !== undefined,
    options.tags !== undefined,
    options.deadline !== undefined,
    options.estimatedMinutes !== undefined,
    options.acceptanceCriteria !== undefined,
    options.assignee !== undefined,
  ].some(Boolean);

  if (!changedFlags) {
    throw new PmCliError("No update flags provided", EXIT_CODE.USAGE);
  }

  const result = await mutateItem({
    pmRoot,
    settings,
    id,
    op: "update",
    author,
    message: options.message,
    force: options.force,
    mutate(document) {
      const changedFields: string[] = [];

      if (options.title !== undefined) {
        document.front_matter.title = options.title;
        changedFields.push("title");
      }
      if (options.description !== undefined) {
        document.front_matter.description = options.description;
        changedFields.push("description");
      }
      if (options.status !== undefined) {
        const status = ensureEnum(options.status, STATUS_VALUES, "status");
        if (status === "closed") {
          throw new PmCliError(
            'Invalid --status value "closed". Use "pm close <ID> <TEXT>" to close an item.',
            EXIT_CODE.USAGE,
          );
        }
        document.front_matter.status = status;
        if (status === "canceled") {
          delete document.front_matter.assignee;
        }
        changedFields.push("status");
      }
      if (options.priority !== undefined) {
        document.front_matter.priority = ensurePriority(options.priority);
        changedFields.push("priority");
      }
      if (options.type !== undefined) {
        document.front_matter.type = ensureEnum(options.type, ITEM_TYPE_VALUES, "type");
        changedFields.push("type");
      }
      if (options.tags !== undefined) {
        document.front_matter.tags = parseTags(options.tags);
        changedFields.push("tags");
      }
      if (options.deadline !== undefined) {
        if (isNoneToken(options.deadline)) {
          delete document.front_matter.deadline;
        } else {
          document.front_matter.deadline = resolveIsoOrRelative(options.deadline);
        }
        changedFields.push("deadline");
      }
      if (options.estimatedMinutes !== undefined) {
        if (isNoneToken(options.estimatedMinutes)) {
          delete document.front_matter.estimated_minutes;
        } else {
          document.front_matter.estimated_minutes = parseOptionalNumber(
            options.estimatedMinutes,
            "estimated-minutes",
          );
        }
        changedFields.push("estimated_minutes");
      }
      if (options.acceptanceCriteria !== undefined) {
        if (isNoneToken(options.acceptanceCriteria)) {
          delete document.front_matter.acceptance_criteria;
        } else {
          document.front_matter.acceptance_criteria = options.acceptanceCriteria;
        }
        changedFields.push("acceptance_criteria");
      }
      if (options.assignee !== undefined) {
        if (isNoneToken(options.assignee) || options.assignee.trim() === "") {
          delete document.front_matter.assignee;
        } else {
          document.front_matter.assignee = options.assignee.trim();
        }
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
