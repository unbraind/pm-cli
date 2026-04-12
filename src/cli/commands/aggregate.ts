import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import { resolveRuntimeStatusRegistry, type RuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { type ItemStatus } from "../../types/index.js";
import { runList } from "./list.js";

type AggregateGroupField = "parent" | "type";

const AGGREGATE_GROUP_FIELDS: AggregateGroupField[] = ["parent", "type"];

export interface AggregateOptions {
  groupBy?: string;
  count?: boolean;
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
  group: Partial<Record<AggregateGroupField, string | null>>;
  count: number;
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

function parseGroupBy(raw: string | undefined): AggregateGroupField[] {
  const value = raw?.trim() ?? "parent,type";
  if (value.length === 0) {
    throw new PmCliError("--group-by requires at least one field name", EXIT_CODE.USAGE);
  }
  const requested = [...new Set(value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
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

function compareNullableString(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left.localeCompare(right);
}

function buildGroupKey(groupBy: AggregateGroupField[], group: Partial<Record<AggregateGroupField, string | null>>): string {
  return groupBy.map((field) => `${field}:${group[field] ?? "__null__"}`).join("|");
}

function compareAggregateRows(
  left: AggregateRow,
  right: AggregateRow,
  groupBy: AggregateGroupField[],
): number {
  for (const field of groupBy) {
    const byField = compareNullableString(left.group[field] ?? null, right.group[field] ?? null);
    if (byField !== 0) {
      return byField;
    }
  }
  return 0;
}

export async function runAggregate(options: AggregateOptions, global: GlobalOptions): Promise<AggregateResult> {
  if (options.count === false) {
    throw new PmCliError("Aggregate currently supports grouped counts only. Pass --count.", EXIT_CODE.USAGE);
  }

  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const groupBy = parseGroupBy(options.groupBy);
  const status = parseStatus(options.status, statusRegistry);
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

  const grouped = new Map<string, AggregateRow>();
  let skippedUnparented = 0;
  let groupedItemCount = 0;

  for (const item of listed.items) {
    const group: Partial<Record<AggregateGroupField, string | null>> = {};
    for (const field of groupBy) {
      if (field === "parent") {
        group.parent = item.parent ?? null;
      } else if (field === "type") {
        group.type = item.type;
      }
    }
    if (groupBy.includes("parent") && group.parent === null && !includeUnparented) {
      skippedUnparented += 1;
      continue;
    }
    const key = buildGroupKey(groupBy, group);
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(key, {
        group,
        count: 1,
      });
    }
    groupedItemCount += 1;
  }

  const groups = [...grouped.values()].sort((left, right) => compareAggregateRows(left, right, groupBy));
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
    },
    now: nowIso(),
    ...(warnings ? { warnings } : {}),
  };
}
