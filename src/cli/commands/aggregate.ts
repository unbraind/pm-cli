import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { splitCommaList } from "../../core/shared/split-comma-list.js";
import { nowIso } from "../../core/shared/time.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import { resolveRuntimeStatusRegistry, type RuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { type ItemStatus } from "../../types/index.js";
import { runList } from "./list.js";

type AggregateGroupField = "parent" | "type" | "priority" | "status" | "assignee" | "tags" | "sprint" | "release";
type AggregateGroupValue = string | number | null;
type AggregateGroupRecord = Partial<Record<AggregateGroupField, AggregateGroupValue>>;
type AggregateListedItem = {
  type: string;
  status: ItemStatus;
  priority: number;
  parent?: string;
  assignee?: string;
  tags: string[];
  sprint?: string;
  release?: string;
};

const AGGREGATE_GROUP_FIELDS: AggregateGroupField[] = [
  "parent",
  "type",
  "priority",
  "status",
  "assignee",
  "tags",
  "sprint",
  "release",
];

export interface AggregateOptions {
  groupBy?: string;
  count?: boolean;
  completion?: boolean;
  sum?: string;
  avg?: string;
  includeUnparented?: boolean;
  status?: string;
  type?: string;
  tag?: string;
  priority?: string;
  deadlineBefore?: string;
  deadlineAfter?: string;
  assignee?: string;
  assigneeFilter?: string;
  parent?: string;
  sprint?: string;
  release?: string;
}

export interface AggregateRow {
  group: AggregateGroupRecord;
  count: number;
  open?: number;
  in_progress?: number;
  closed?: number;
  completion_pct?: number;
  null_count?: number;
  sum?: number | null;
  avg?: number | null;
}

export interface AggregateResult {
  groups: AggregateRow[];
  count: number;
  totals: {
    items_considered: number;
    items_grouped: number;
    items_skipped_unparented: number;
  };
  filters: {
    group_by: AggregateGroupField[];
    count: boolean;
    completion: boolean;
    sum?: string | null;
    avg?: string | null;
    numeric_field?: string | null;
    include_unparented: boolean;
    status: ItemStatus | null;
    type: string | null;
    tag: string | null;
    priority: string | null;
    deadline_before: string | null;
    deadline_after: string | null;
    assignee: string | null;
    assignee_filter: string | null;
    parent: string | null;
    sprint: string | null;
    release: string | null;
  };
  now: string;
  warnings?: string[];
}

function parseStatus(raw: string | undefined, statusRegistry: RuntimeStatusRegistry): ItemStatus | undefined {
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

interface NumericAggregation {
  field: string;
  sum: boolean;
  avg: boolean;
}

function parseNumericAggregation(options: AggregateOptions): NumericAggregation | null {
  const sumField = options.sum?.trim();
  const avgField = options.avg?.trim();
  const normalizedSum = sumField && sumField.length > 0 ? sumField : undefined;
  const normalizedAvg = avgField && avgField.length > 0 ? avgField : undefined;
  if (!normalizedSum && !normalizedAvg) {
    return null;
  }
  if (normalizedSum && normalizedAvg && normalizedSum !== normalizedAvg) {
    throw new PmCliError("Aggregate --sum and --avg must target the same numeric field", EXIT_CODE.USAGE);
  }
  return {
    field: normalizedSum ?? normalizedAvg ?? "",
    sum: normalizedSum !== undefined,
    avg: normalizedAvg !== undefined,
  };
}

function parseGroupBy(raw: string | undefined): AggregateGroupField[] {
  const value = raw?.trim() ?? "status";
  if (value.length === 0) {
    throw new PmCliError("--group-by requires at least one field name", EXIT_CODE.USAGE);
  }
  const requested = splitCommaList(value);
  if (requested.length === 0) {
    throw new PmCliError("--group-by requires a comma-separated list of fields", EXIT_CODE.USAGE);
  }
  for (const field of requested) {
    if (!AGGREGATE_GROUP_FIELDS.includes(field as AggregateGroupField)) {
      throw new PmCliError(
        `Aggregate group fields must be one of ${AGGREGATE_GROUP_FIELDS.join("|")}; received "${field}"`,
        EXIT_CODE.USAGE,
      );
    }
  }
  return requested as AggregateGroupField[];
}

function normalizeTagGroupValue(tags: string[]): string | null {
  const normalized = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0))].sort((left, right) =>
    left.localeCompare(right),
  );
  if (normalized.length === 0) {
    return null;
  }
  return normalized.join(",");
}

function resolveGroupValue(field: AggregateGroupField, item: AggregateListedItem): AggregateGroupValue {
  switch (field) {
    case "parent":
      return item.parent ?? null;
    case "type":
      return item.type;
    case "priority":
      return item.priority;
    case "status":
      return item.status;
    case "assignee":
      return item.assignee ?? null;
    case "tags":
      return normalizeTagGroupValue(item.tags);
    case "sprint":
      return item.sprint ?? null;
    case "release":
      return item.release ?? null;
    default:
      return null;
  }
}

function compareNullableGroupValue(left: AggregateGroupValue | undefined, right: AggregateGroupValue | undefined): number {
  const leftValue = left ?? null;
  const rightValue = right ?? null;
  if (leftValue === rightValue) {
    return 0;
  }
  if (leftValue === null) {
    return 1;
  }
  if (rightValue === null) {
    return -1;
  }
  if (typeof leftValue === "number" && typeof rightValue === "number") {
    return leftValue - rightValue;
  }
  return String(leftValue).localeCompare(String(rightValue));
}

function buildGroupKey(groupBy: AggregateGroupField[], group: AggregateGroupRecord): string {
  return groupBy.map((field) => `${field}:${JSON.stringify(group[field] ?? null)}`).join("|");
}

function compareAggregateRows(
  left: AggregateRow,
  right: AggregateRow,
  groupBy: AggregateGroupField[],
): number {
  for (const field of groupBy) {
    const byField = compareNullableGroupValue(left.group[field], right.group[field]);
    if (byField !== 0) {
      return byField;
    }
  }
  return 0;
}

function readNumericAggregateValue(item: AggregateListedItem, field: string): number | null {
  const source = item as unknown as Record<string, unknown>;
  const raw = source[field];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

interface AggregateAccumulator {
  row: AggregateRow;
  numeric_count: number;
  numeric_sum: number;
  null_count: number;
  open_count: number;
  in_progress_count: number;
  closed_count: number;
}

function completionPct(closed: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.round((closed / total) * 10000) / 100;
}

function updateCompletionCounts(accumulator: AggregateAccumulator, status: ItemStatus): void {
  if (status === "open") {
    accumulator.open_count += 1;
    return;
  }
  if (status === "in_progress") {
    accumulator.in_progress_count += 1;
    return;
  }
  if (status === "closed") {
    accumulator.closed_count += 1;
  }
}

export async function runAggregate(options: AggregateOptions, global: GlobalOptions): Promise<AggregateResult> {
  if (options.count === false) {
    throw new PmCliError("Aggregate grouped counts are always enabled; omit count=false.", EXIT_CODE.USAGE);
  }

  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const groupBy = parseGroupBy(options.groupBy);
  const status = parseStatus(options.status, statusRegistry);
  const numericAggregation = parseNumericAggregation(options);
  const includeCompletion = options.completion === true;
  const includeUnparented = options.includeUnparented === true;

  const listed = await runList(
    status,
    {
      type: options.type,
      tag: options.tag,
      priority: options.priority,
      deadlineBefore: options.deadlineBefore,
      deadlineAfter: options.deadlineAfter,
      assignee: options.assignee,
      assigneeFilter: options.assigneeFilter,
      parent: options.parent,
      sprint: options.sprint,
      release: options.release,
    },
    global,
  );

  const grouped = new Map<string, AggregateAccumulator>();
  let skippedUnparented = 0;
  let groupedItemCount = 0;

  for (const listedItem of listed.items) {
    const item = listedItem as AggregateListedItem;
    const group: AggregateGroupRecord = {};
    for (const field of groupBy) {
      group[field] = resolveGroupValue(field, item);
    }
    if (groupBy.includes("parent") && group.parent === null && !includeUnparented) {
      skippedUnparented += 1;
      continue;
    }
    const key = buildGroupKey(groupBy, group);
    const existing = grouped.get(key);
    const numericValue =
      numericAggregation === null
        ? null
        : readNumericAggregateValue(item, numericAggregation.field);
    if (existing) {
      existing.row.count += 1;
      if (includeCompletion) {
        updateCompletionCounts(existing, item.status);
      }
      if (numericAggregation !== null) {
        if (numericValue === null) {
          existing.null_count += 1;
        } else {
          existing.numeric_count += 1;
          existing.numeric_sum += numericValue;
        }
      }
    } else {
      const accumulator: AggregateAccumulator = {
        row: {
          group,
          count: 1,
        },
        numeric_count: numericValue === null ? 0 : 1,
        numeric_sum: numericValue ?? 0,
        null_count: numericValue === null ? 1 : 0,
        open_count: 0,
        in_progress_count: 0,
        closed_count: 0,
      };
      if (includeCompletion) {
        updateCompletionCounts(accumulator, item.status);
      }
      grouped.set(key, accumulator);
    }
    groupedItemCount += 1;
  }

  const groups = [...grouped.values()]
    .map((entry) => {
      const withNumeric: AggregateRow = {
        ...entry.row,
      };
      if (includeCompletion) {
        withNumeric.open = entry.open_count;
        withNumeric.in_progress = entry.in_progress_count;
        withNumeric.closed = entry.closed_count;
        withNumeric.completion_pct = completionPct(entry.closed_count, entry.row.count);
      }
      if (numericAggregation !== null) {
        withNumeric.null_count = entry.null_count;
        if (numericAggregation.sum) {
          withNumeric.sum = entry.numeric_sum;
        }
        if (numericAggregation.avg) {
          withNumeric.avg = entry.numeric_count === 0 ? null : entry.numeric_sum / entry.numeric_count;
        }
      }
      return withNumeric;
    })
    .sort((left, right) => compareAggregateRows(left, right, groupBy));
  const warnings = listed.warnings && listed.warnings.length > 0 ? listed.warnings : undefined;

  return {
    groups,
    count: groups.length,
    totals: {
      items_considered: listed.items.length,
      items_grouped: groupedItemCount,
      items_skipped_unparented: skippedUnparented,
    },
    filters: {
      group_by: groupBy,
      count: true,
      completion: includeCompletion,
      include_unparented: includeUnparented,
      status: status ?? null,
      type: options.type ?? null,
      tag: options.tag ?? null,
      priority: options.priority ?? null,
      deadline_before: options.deadlineBefore ?? null,
      deadline_after: options.deadlineAfter ?? null,
      assignee: options.assignee ?? null,
      assignee_filter: options.assigneeFilter ?? null,
      parent: options.parent ?? null,
      sprint: options.sprint ?? null,
      release: options.release ?? null,
      ...(numericAggregation !== null
        ? {
            sum: options.sum ?? null,
            avg: options.avg ?? null,
            numeric_field: numericAggregation.field,
          }
        : {}),
    },
    now: nowIso(),
    ...(warnings ? { warnings } : {}),
  };
}
