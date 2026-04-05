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
  fullHistory?: boolean;
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
    latest: number | null;
    full_history: boolean;
  };
  export: {
    mode: "latest" | "full_history";
    row_count: number | null;
  };
  rows?: CommentsAuditHistoryRow[];
  now: string;
  warnings?: string[];
}

export interface CommentsAuditHistoryRow {
  item_id: string;
  item_title: string;
  item_type: string;
  item_status: ItemStatus;
  item_assignee: string | null;
  item_updated_at: string;
  comment_index: number;
  comment_count: number;
  created_at: string;
  author: string;
  text: string;
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

function toHistoryRows(items: CommentsAuditEntry[]): CommentsAuditHistoryRow[] {
  const rows: CommentsAuditHistoryRow[] = [];
  for (const item of items) {
    for (let index = 0; index < item.comments.length; index += 1) {
      const comment = item.comments[index];
      rows.push({
        item_id: item.id,
        item_title: item.title,
        item_type: item.type,
        item_status: item.status,
        item_assignee: item.assignee,
        item_updated_at: item.updated_at,
        comment_index: index,
        comment_count: item.comment_count,
        created_at: comment.created_at,
        author: comment.author,
        text: comment.text,
      });
    }
  }
  return rows;
}

export async function runCommentsAudit(options: CommentsAuditOptions, global: GlobalOptions): Promise<CommentsAuditResult> {
  const status = parseStatus(options.status);
  const fullHistory = options.fullHistory === true;
  const latestParsed = parseNonNegativeInteger(options.latest, "--latest");
  if (fullHistory && latestParsed !== undefined) {
    throw new PmCliError("--full-history cannot be combined with --latest", EXIT_CODE.USAGE);
  }
  const latest = fullHistory ? undefined : latestParsed ?? 1;
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
      comments: latest === undefined ? comments : limitComments(comments, latest),
    };
  });
  const rows = fullHistory ? toHistoryRows(items) : undefined;

  return {
    items,
    count: items.length,
    filters: {
      status: status ?? null,
      type: options.type ?? null,
      assignee: options.assignee ?? null,
      limit_items: limitItems ?? null,
      latest: latest ?? null,
      full_history: fullHistory,
    },
    export: {
      mode: fullHistory ? "full_history" : "latest",
      row_count: rows?.length ?? null,
    },
    ...(rows ? { rows } : {}),
    now: listed.now,
    ...(listed.warnings && listed.warnings.length > 0 ? { warnings: listed.warnings } : {}),
  };
}
