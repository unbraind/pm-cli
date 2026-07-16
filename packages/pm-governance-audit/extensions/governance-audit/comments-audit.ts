/**
 * @module packages/pm-governance-audit/comments-audit
 *
 * Implements the pm comments audit command surface and its agent-facing runtime behavior.
 */
import {
  EXIT_CODE,
  PmCliError,
  normalizeStatusInput,
  nowIso,
  readSettings,
  resolvePmRoot,
  resolveRuntimeStatusRegistry,
  runList,
  type GlobalOptions,
  type ItemMetadata,
  type ItemStatus,
  type ListedItem,
  type RuntimeStatusRegistry,
} from "./sdk.ts";

type Comment = NonNullable<ItemMetadata["comments"]>[number];

/** Documents the comments audit options payload exchanged by command, SDK, and package integrations. */
export interface CommentsAuditOptions {
  /** Lifecycle state reported for status. */
  status?: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type?: string;
  /** Value that configures or reports tag for this contract. */
  tag?: string;
  /** Value that configures or reports priority for this contract. */
  priority?: string;
  /** Value that configures or reports parent for this contract. */
  parent?: string;
  /** Value that configures or reports sprint for this contract. */
  sprint?: string;
  /** Value that configures or reports release for this contract. */
  release?: string;
  /** Value that configures or reports assignee for this contract. */
  assignee?: string;
  /** Value that configures or reports assignee filter for this contract. */
  assigneeFilter?: string;
  /** Value that configures or reports limit for this contract. */
  limit?: string;
  /** Value that configures or reports limit items for this contract. */
  limitItems?: string;
  /** Value that configures or reports latest for this contract. */
  latest?: string;
  /** Value that configures or reports full history for this contract. */
  fullHistory?: boolean;
}

/** Documents the comments audit entry payload exchanged by command, SDK, and package integrations. */
export interface CommentsAuditEntry {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports title for this contract. */
  title: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type: string;
  /** Lifecycle state reported for status. */
  status: ItemStatus;
  /** Value that configures or reports assignee for this contract. */
  assignee: string | null;
  /** ISO 8601 timestamp recording when updated occurred. */
  updated_at: string;
  /** Number of comment entries represented by this result. */
  comment_count: number;
  /** Value that configures or reports comments for this contract. */
  comments: Comment[];
}

/** Documents the comments audit result payload exchanged by command, SDK, and package integrations. */
export interface CommentsAuditResult {
  /** Value that configures or reports items for this contract. */
  items: CommentsAuditEntry[];
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Value that configures or reports summary for this contract. */
  summary: CommentsAuditSummary;
  /** Value that configures or reports filters for this contract. */
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
  /** Value that configures or reports export for this contract. */
  export: {
    mode: "latest" | "full_history";
    row_count: number;
  };
  /** Value that configures or reports rows for this contract. */
  rows?: CommentsAuditHistoryRow[];
  /** Value that configures or reports now for this contract. */
  now: string;
  /** Value that configures or reports warnings for this contract. */
  warnings?: string[];
}

/** Documents the comments audit summary payload exchanged by command, SDK, and package integrations. */
export interface CommentsAuditSummary {
  /** Value that configures or reports totals for this contract. */
  totals: {
    items_scanned: number;
    items_with_comments: number;
    zero_comment_items: number;
    comments_total: number;
    comments_exported: number;
  };
  /** Value that configures or reports coverage for this contract. */
  coverage: {
    items_with_comments_ratio: number;
    items_with_comments_percent: number;
  };
  /** Schema type that determines the shape and validation rules for this value. */
  by_type: CommentsAuditTypeSummary[];
}

/** Documents the comments audit type summary payload exchanged by command, SDK, and package integrations. */
export interface CommentsAuditTypeSummary {
  /** Schema type that determines the shape and validation rules for this value. */
  type: string;
  /** Value that configures or reports items scanned for this contract. */
  items_scanned: number;
  /** Value that configures or reports items with comments for this contract. */
  items_with_comments: number;
  /** Value that configures or reports zero comment items for this contract. */
  zero_comment_items: number;
  /** Value that configures or reports comments total for this contract. */
  comments_total: number;
  /** Value that configures or reports comments exported for this contract. */
  comments_exported: number;
  /** Value that configures or reports items with comments ratio for this contract. */
  items_with_comments_ratio: number;
  /** Value that configures or reports items with comments percent for this contract. */
  items_with_comments_percent: number;
}

/** Documents the comments audit history row payload exchanged by command, SDK, and package integrations. */
export interface CommentsAuditHistoryRow {
  /** Value that configures or reports item id for this contract. */
  item_id: string;
  /** Value that configures or reports item title for this contract. */
  item_title: string;
  /** Schema type that determines the shape and validation rules for this value. */
  item_type: string;
  /** Lifecycle state reported for itemthe record. */
  item_status: ItemStatus;
  /** Value that configures or reports item assignee for this contract. */
  item_assignee: string | null;
  /** ISO 8601 timestamp recording when item updated occurred. */
  item_updated_at: string;
  /** Value that configures or reports comment index for this contract. */
  comment_index: number;
  /** Number of comment entries represented by this result. */
  comment_count: number;
  /** ISO 8601 timestamp recording when created occurred. */
  created_at: string;
  /** Value that configures or reports author for this contract. */
  author: string;
  /** Value that configures or reports text for this contract. */
  text: string;
}

function parseStatus(
  raw: string | undefined,
  statusRegistry: RuntimeStatusRegistry,
): ItemStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = normalizeStatusInput(raw, statusRegistry);
  if (!normalized) {
    throw new PmCliError(
      `Status filter must be one of ${statusRegistry.definitions.map((definition) => definition.id).join("|")}`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized;
}

function parseNonNegativeInteger(
  raw: string | undefined,
  flag: string,
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PmCliError(
      `${flag} must be a non-negative integer`,
      EXIT_CODE.USAGE,
    );
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

function ratioPercent(
  numerator: number,
  denominator: number,
): { ratio: number; percent: number } {
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

function buildCommentsAuditSummary(
  items: CommentsAuditEntry[],
): CommentsAuditSummary {
  const itemsScanned = items.length;
  const itemsWithComments = items.filter(
    (entry) => entry.comment_count > 0,
  ).length;
  const zeroCommentItems = itemsScanned - itemsWithComments;
  const commentsTotal = items.reduce(
    (sum, entry) => sum + entry.comment_count,
    0,
  );
  const commentsExported = items.reduce(
    (sum, entry) => sum + entry.comments.length,
    0,
  );
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
      const coverage = ratioPercent(
        stats.items_with_comments,
        stats.items_scanned,
      );
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

function resolveCommentsAuditLimits(options: CommentsAuditOptions): {
  fullHistory: boolean;
  latest: number | undefined;
  limitItems: number | undefined;
} {
  const fullHistory = options.fullHistory === true;
  const latestParsed = parseNonNegativeInteger(options.latest, "--latest");
  if (fullHistory && latestParsed !== undefined) {
    throw new PmCliError(
      "--full-history cannot be combined with --latest",
      EXIT_CODE.USAGE,
    );
  }
  const limitItemsPrimary = parseNonNegativeInteger(
    options.limitItems,
    "--limit-items",
  );
  const limitItemsAlias = parseNonNegativeInteger(options.limit, "--limit");
  if (
    limitItemsPrimary !== undefined &&
    limitItemsAlias !== undefined &&
    limitItemsPrimary !== limitItemsAlias
  ) {
    throw new PmCliError(
      "--limit and --limit-items must match when both are provided",
      EXIT_CODE.USAGE,
    );
  }
  return {
    fullHistory,
    latest: fullHistory ? undefined : (latestParsed ?? 1),
    limitItems: limitItemsPrimary ?? limitItemsAlias,
  };
}

/**
 * Project one complete list record into the bounded comments-audit shape.
 */
function toCommentsAuditEntry(
  item: ListedItem,
  latest: number | undefined,
): CommentsAuditEntry {
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
}

function buildCommentsAuditFilters(
  options: CommentsAuditOptions,
  status: ItemStatus | undefined,
  limitItems: number | undefined,
  latest: number | undefined,
  fullHistory: boolean,
): CommentsAuditResult["filters"] {
  return {
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
  };
}

/** Implements run comments audit for the public runtime surface of this module. */
export async function runCommentsAudit(
  options: CommentsAuditOptions,
  global: GlobalOptions,
): Promise<CommentsAuditResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const status = parseStatus(options.status, statusRegistry);
  const { fullHistory, latest, limitItems } =
    resolveCommentsAuditLimits(options);

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
      full: true as const,
    },
    global,
  );

  const items = listed.items.map((item) => toCommentsAuditEntry(item, latest));
  const rows = fullHistory ? toHistoryRows(items) : undefined;
  const latestRowCount = items.reduce(
    (sum, entry) => sum + entry.comments.length,
    0,
  );

  return {
    items,
    count: items.length,
    summary: buildCommentsAuditSummary(items),
    filters: buildCommentsAuditFilters(
      options,
      status,
      limitItems,
      latest,
      fullHistory,
    ),
    export: {
      mode: fullHistory ? "full_history" : "latest",
      /* c8 ignore next -- rows is always materialized from toHistoryRows() when fullHistory=true. */
      row_count: fullHistory ? (rows?.length ?? 0) : latestRowCount,
    },
    ...(rows ? { rows } : {}),
    now: listed.now ?? nowIso(),
    ...(listed.warnings && listed.warnings.length > 0
      ? { warnings: listed.warnings }
      : {}),
  };
}
