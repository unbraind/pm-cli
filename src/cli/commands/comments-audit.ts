import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { STATUS_VALUES, type Comment, type ItemStatus } from "../../types/index.js";
import { runList } from "./list.js";

export interface CommentsAuditOptions {
  status?: string;
  type?: string;
  assignee?: string;
  limitItems?: string;
  latest?: string;
}

export interface CommentsAuditEntry {
  id: string;
  title: string;
  type: string;
  status: ItemStatus;
  assignee: string | null;
  updated_at: string;
  comment_count: number;
  comments: Comment[];
}

export interface CommentsAuditResult {
  items: CommentsAuditEntry[];
  count: number;
  filters: {
    status: ItemStatus | null;
    type: string | null;
    assignee: string | null;
    limit_items: number | null;
    latest: number;
  };
  now: string;
  warnings?: string[];
}

function parseStatus(raw: string | undefined): ItemStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase().replaceAll("-", "_");
  if (!STATUS_VALUES.includes(normalized as ItemStatus)) {
    throw new PmCliError(`Status filter must be one of ${STATUS_VALUES.join("|")}`, EXIT_CODE.USAGE);
  }
  return normalized as ItemStatus;
}

function parseNonNegativeInteger(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PmCliError(`${flag} must be a non-negative integer`, EXIT_CODE.USAGE);
  }
  return parsed;
}

function limitComments(values: Comment[], latest: number): Comment[] {
  if (latest <= 0) {
    return [];
  }
  return values.slice(Math.max(0, values.length - latest));
}

export async function runCommentsAudit(options: CommentsAuditOptions, global: GlobalOptions): Promise<CommentsAuditResult> {
  const status = parseStatus(options.status);
  const latest = parseNonNegativeInteger(options.latest, "--latest") ?? 1;
  const limitItems = parseNonNegativeInteger(options.limitItems, "--limit-items");

  const listed = await runList(
    status,
    {
      type: options.type,
      assignee: options.assignee,
      limit: limitItems === undefined ? undefined : String(limitItems),
    },
    global,
  );

  const items = listed.items.map((item) => {
    const comments = item.comments ?? [];
    return {
      id: item.id,
      title: item.title,
      type: item.type,
      status: item.status,
      assignee: item.assignee ?? null,
      updated_at: item.updated_at,
      comment_count: comments.length,
      comments: limitComments(comments, latest),
    };
  });

  return {
    items,
    count: items.length,
    filters: {
      status: status ?? null,
      type: options.type ?? null,
      assignee: options.assignee ?? null,
      limit_items: limitItems ?? null,
      latest,
    },
    now: listed.now,
    ...(listed.warnings && listed.warnings.length > 0 ? { warnings: listed.warnings } : {}),
  };
}
