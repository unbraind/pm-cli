import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { STATUS_VALUES, type Comment, type ItemStatus } from "../../types/index.js";
import { runList } from "./list.js";

export interface CommentsAuditOptions {
  status?: string;
  type?: string;
  tag?: string;
  priority?: string;
  parent?: string;
  sprint?: string;
  release?: string;
  assignee?: string;
  assigneeFilter?: string;
  limit?: string;
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
  summary: CommentsAuditSummary;
  filters: {
    status: ItemStatus | null;
    type: string | null;
    tag: string | null;
    priority: number | null;
    parent: string | null;
    sprint: string | null;
    release: string | null;
    assignee: string | null;
    assignee_filter: string | null;
    limit_items: number | null;
    latest: number | null;
    full_history: boolean;
  };
  export: {
    mode: "latest" | "full_history";
    row_count: number;
  };
  rows?: CommentsAuditHistoryRow[];
  now: string;
  warnings?: string[];
}

export interface CommentsAuditSummary {
  totals: {
    items_scanned: number;
    items_with_comments: number;
    zero_comment_items: number;
    comments_total: number;
    comments_exported: number;
  };
  coverage: {
    items_with_comments_ratio: number;
    items_with_comments_percent: number;
  };
  by_type: CommentsAuditTypeSummary[];
}

export interface CommentsAuditTypeSummary {
  type: string;
  items_scanned: number;
  items_with_comments: number;
  zero_comment_items: number;
  comments_total: number;
  comments_exported: number;
  items_with_comments_ratio: number;
  items_with_comments_percent: number;
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

function ratioPercent(numerator: number, denominator: number): { ratio: number; percent: number } {
  if (denominator <= 0) {
    return {
      ratio: 0,
      percent: 0,
    };
  }
  const ratio = numerator / denominator;
  return {
    ratio: Number(ratio.toFixed(4)),
    percent: Number((ratio * 100).toFixed(2)),
  };
}

function buildCommentsAuditSummary(items: CommentsAuditEntry[]): CommentsAuditSummary {
  const itemsScanned = items.length;
  const itemsWithComments = items.filter((entry) => entry.comment_count > 0).length;
  const zeroCommentItems = itemsScanned - itemsWithComments;
  const commentsTotal = items.reduce((sum, entry) => sum + entry.comment_count, 0);
  const commentsExported = items.reduce((sum, entry) => sum + entry.comments.length, 0);
  const overallCoverage = ratioPercent(itemsWithComments, itemsScanned);
  const byTypeAccumulator = new Map<
    string,
    {
      items_scanned: number;
      items_with_comments: number;
      comments_total: number;
      comments_exported: number;
    }
  >();
  for (const item of items) {
    const entry = byTypeAccumulator.get(item.type) ?? {
      items_scanned: 0,
      items_with_comments: 0,
      comments_total: 0,
      comments_exported: 0,
    };
    entry.items_scanned += 1;
    if (item.comment_count > 0) {
      entry.items_with_comments += 1;
    }
    entry.comments_total += item.comment_count;
    entry.comments_exported += item.comments.length;
    byTypeAccumulator.set(item.type, entry);
  }
  const byType: CommentsAuditTypeSummary[] = [...byTypeAccumulator.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, stats]) => {
      const zeroCount = stats.items_scanned - stats.items_with_comments;
      const coverage = ratioPercent(stats.items_with_comments, stats.items_scanned);
      return {
        type,
        items_scanned: stats.items_scanned,
        items_with_comments: stats.items_with_comments,
        zero_comment_items: zeroCount,
        comments_total: stats.comments_total,
        comments_exported: stats.comments_exported,
        items_with_comments_ratio: coverage.ratio,
        items_with_comments_percent: coverage.percent,
      };
    });
  return {
    totals: {
      items_scanned: itemsScanned,
      items_with_comments: itemsWithComments,
      zero_comment_items: zeroCommentItems,
      comments_total: commentsTotal,
      comments_exported: commentsExported,
    },
    coverage: {
      items_with_comments_ratio: overallCoverage.ratio,
      items_with_comments_percent: overallCoverage.percent,
    },
    by_type: byType,
  };
}

export async function runCommentsAudit(options: CommentsAuditOptions, global: GlobalOptions): Promise<CommentsAuditResult> {
  const status = parseStatus(options.status);
  const fullHistory = options.fullHistory === true;
  const latestParsed = parseNonNegativeInteger(options.latest, "--latest");
  if (fullHistory && latestParsed !== undefined) {
    throw new PmCliError("--full-history cannot be combined with --latest", EXIT_CODE.USAGE);
  }
  const latest = fullHistory ? undefined : latestParsed ?? 1;
  const limitItemsPrimary = parseNonNegativeInteger(options.limitItems, "--limit-items");
  const limitItemsAlias = parseNonNegativeInteger(options.limit, "--limit");
  if (
    limitItemsPrimary !== undefined &&
    limitItemsAlias !== undefined &&
    limitItemsPrimary !== limitItemsAlias
  ) {
    throw new PmCliError("--limit and --limit-items must match when both are provided", EXIT_CODE.USAGE);
  }
  const limitItems = limitItemsPrimary ?? limitItemsAlias;

  const listed = await runList(
    status,
    {
      type: options.type,
      tag: options.tag,
      priority: options.priority,
      parent: options.parent,
      sprint: options.sprint,
      release: options.release,
      assignee: options.assignee,
      assigneeFilter: options.assigneeFilter,
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
  const latestRowCount = items.reduce((sum, entry) => sum + entry.comments.length, 0);

  return {
    items,
    count: items.length,
    summary: buildCommentsAuditSummary(items),
    filters: {
      status: status ?? null,
      type: options.type ?? null,
      tag: options.tag ?? null,
      priority: options.priority === undefined ? null : Number(options.priority),
      parent: options.parent ?? null,
      sprint: options.sprint ?? null,
      release: options.release ?? null,
      assignee: options.assignee ?? null,
      assignee_filter: options.assigneeFilter ?? null,
      limit_items: limitItems ?? null,
      latest: latest ?? null,
      full_history: fullHistory,
    },
    export: {
      mode: fullHistory ? "full_history" : "latest",
      row_count: fullHistory ? rows?.length ?? 0 : latestRowCount,
    },
    ...(rows ? { rows } : {}),
    now: listed.now,
    ...(listed.warnings && listed.warnings.length > 0 ? { warnings: listed.warnings } : {}),
  };
}
