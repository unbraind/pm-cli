import { pathExists } from "../../core/fs/fs-utils.js";
import { parseOptionalNumber, parseTags } from "../../core/item/parse.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { isNoneToken, resolveIsoOrRelative } from "../../core/shared/time.js";
import { mutateItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { ITEM_TYPE_VALUES, RISK_VALUES, STATUS_VALUES } from "../../types/index.js";

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
  definitionOfReady?: string;
  order?: string;
  rank?: string;
  goal?: string;
  objective?: string;
  value?: string;
  impact?: string;
  outcome?: string;
  whyNow?: string;
  author?: string;
  message?: string;
  force?: boolean;
  assignee?: string;
  parent?: string;
  reviewer?: string;
  risk?: string;
  sprint?: string;
  release?: string;
  blockedBy?: string;
  blockedReason?: string;
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

function normalizeRiskInput(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase() === "med" ? "medium" : trimmed;
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
    options.definitionOfReady !== undefined,
    options.order !== undefined,
    options.rank !== undefined,
    options.goal !== undefined,
    options.objective !== undefined,
    options.value !== undefined,
    options.impact !== undefined,
    options.outcome !== undefined,
    options.whyNow !== undefined,
    options.assignee !== undefined,
    options.parent !== undefined,
    options.reviewer !== undefined,
    options.risk !== undefined,
    options.sprint !== undefined,
    options.release !== undefined,
    options.blockedBy !== undefined,
    options.blockedReason !== undefined,
  ].some(Boolean);

  if (!changedFlags) {
    throw new PmCliError("No update flags provided", EXIT_CODE.USAGE);
  }
  if (options.order !== undefined && options.rank !== undefined && options.order !== options.rank) {
    throw new PmCliError("--order and --rank must match when both are provided", EXIT_CODE.USAGE);
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
      if (options.definitionOfReady !== undefined) {
        if (isNoneToken(options.definitionOfReady)) {
          delete document.front_matter.definition_of_ready;
        } else {
          document.front_matter.definition_of_ready = options.definitionOfReady.trim();
        }
        changedFields.push("definition_of_ready");
      }
      const orderRaw = options.order ?? options.rank;
      if (orderRaw !== undefined) {
        if (isNoneToken(orderRaw)) {
          delete document.front_matter.order;
        } else {
          const parsedOrder = parseOptionalNumber(orderRaw, "order");
          if (!Number.isInteger(parsedOrder)) {
            throw new PmCliError("Order must be an integer", EXIT_CODE.USAGE);
          }
          document.front_matter.order = parsedOrder;
        }
        changedFields.push("order");
      }
      if (options.goal !== undefined) {
        if (isNoneToken(options.goal)) {
          delete document.front_matter.goal;
        } else {
          document.front_matter.goal = options.goal.trim();
        }
        changedFields.push("goal");
      }
      if (options.objective !== undefined) {
        if (isNoneToken(options.objective)) {
          delete document.front_matter.objective;
        } else {
          document.front_matter.objective = options.objective.trim();
        }
        changedFields.push("objective");
      }
      if (options.value !== undefined) {
        if (isNoneToken(options.value)) {
          delete document.front_matter.value;
        } else {
          document.front_matter.value = options.value.trim();
        }
        changedFields.push("value");
      }
      if (options.impact !== undefined) {
        if (isNoneToken(options.impact)) {
          delete document.front_matter.impact;
        } else {
          document.front_matter.impact = options.impact.trim();
        }
        changedFields.push("impact");
      }
      if (options.outcome !== undefined) {
        if (isNoneToken(options.outcome)) {
          delete document.front_matter.outcome;
        } else {
          document.front_matter.outcome = options.outcome.trim();
        }
        changedFields.push("outcome");
      }
      if (options.whyNow !== undefined) {
        if (isNoneToken(options.whyNow)) {
          delete document.front_matter.why_now;
        } else {
          document.front_matter.why_now = options.whyNow.trim();
        }
        changedFields.push("why_now");
      }
      if (options.assignee !== undefined) {
        if (isNoneToken(options.assignee) || options.assignee.trim() === "") {
          delete document.front_matter.assignee;
        } else {
          document.front_matter.assignee = options.assignee.trim();
        }
        changedFields.push("assignee");
      }
      if (options.parent !== undefined) {
        if (isNoneToken(options.parent)) {
          delete document.front_matter.parent;
        } else {
          document.front_matter.parent = options.parent.trim();
        }
        changedFields.push("parent");
      }
      if (options.reviewer !== undefined) {
        if (isNoneToken(options.reviewer)) {
          delete document.front_matter.reviewer;
        } else {
          document.front_matter.reviewer = options.reviewer.trim();
        }
        changedFields.push("reviewer");
      }
      if (options.risk !== undefined) {
        if (isNoneToken(options.risk)) {
          delete document.front_matter.risk;
        } else {
          document.front_matter.risk = ensureEnum(normalizeRiskInput(options.risk), RISK_VALUES, "risk");
        }
        changedFields.push("risk");
      }
      if (options.sprint !== undefined) {
        if (isNoneToken(options.sprint)) {
          delete document.front_matter.sprint;
        } else {
          document.front_matter.sprint = options.sprint.trim();
        }
        changedFields.push("sprint");
      }
      if (options.release !== undefined) {
        if (isNoneToken(options.release)) {
          delete document.front_matter.release;
        } else {
          document.front_matter.release = options.release.trim();
        }
        changedFields.push("release");
      }
      if (options.blockedBy !== undefined) {
        if (isNoneToken(options.blockedBy)) {
          delete document.front_matter.blocked_by;
        } else {
          document.front_matter.blocked_by = options.blockedBy.trim();
        }
        changedFields.push("blocked_by");
      }
      if (options.blockedReason !== undefined) {
        if (isNoneToken(options.blockedReason)) {
          delete document.front_matter.blocked_reason;
        } else {
          document.front_matter.blocked_reason = options.blockedReason.trim();
        }
        changedFields.push("blocked_reason");
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
