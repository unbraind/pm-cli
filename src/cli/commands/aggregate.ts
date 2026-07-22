/**
 * @module cli/commands/aggregate
 *
 * Implements the pm aggregate command surface and its agent-facing runtime behavior.
 */
import {
  EXIT_CODE,
  type GlobalOptions,
  PmCliError,
  splitCommaList,
  nowIso,
  normalizeStatusInput,
  parseStatusFilterCsv,
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeStatusRegistry,
  resolvePmRoot,
  readSettings,
} from "../../sdk/runtime-primitives.js";
import { type ItemStatus } from "../../types/index.js";
import { buildListQueryFilters } from "./list-filter-shared.js";
import { runList } from "./list.js";

type AggregateGroupField =
  | "parent"
  | "type"
  | "priority"
  | "status"
  | "assignee"
  | "tags"
  | "sprint"
  | "release";
type AggregateGroupValue = string | number | null;
type AggregateGroupRecord = Partial<
  Record<AggregateGroupField, AggregateGroupValue>
>;
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

/** Documents the aggregate options payload exchanged by command, SDK, and package integrations. */
export interface AggregateOptions {
  /** Value that configures or reports group by for this contract. */
  groupBy?: string;
  /** Value that configures or reports count for this contract. */
  count?: boolean;
  /** Value that configures or reports completion for this contract. */
  completion?: boolean;
  /** Value that configures or reports sum for this contract. */
  sum?: string;
  /** Value that configures or reports avg for this contract. */
  avg?: string;
  /** Value that configures or reports include unparented for this contract. */
  includeUnparented?: boolean;
  /** Lifecycle state reported for status. */
  status?: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type?: string;
  /** Value that configures or reports tag for this contract. */
  tag?: string;
  /** Value that configures or reports priority for this contract. */
  priority?: string;
  /** Value that configures or reports deadline before for this contract. */
  deadlineBefore?: string;
  /** Value that configures or reports deadline after for this contract. */
  deadlineAfter?: string;
  /** Value that configures or reports assignee for this contract. */
  assignee?: string;
  /** Value that configures or reports assignee filter for this contract. */
  assigneeFilter?: string;
  /** Value that configures or reports parent for this contract. */
  parent?: string;
  /** Value that configures or reports sprint for this contract. */
  sprint?: string;
  /** Value that configures or reports release for this contract. */
  release?: string;
}

/** Documents the aggregate row payload exchanged by command, SDK, and package integrations. */
export interface AggregateRow {
  /** Value that configures or reports group for this contract. */
  group: AggregateGroupRecord;
  /** Human-readable display label for this group. Blank/null group values render with an explicit "(unassigned)"-style label (per dimension) so terminal and grep-based consumers are never faced with an ambiguous empty key. The structured `group` record keeps the raw null for machine consumers. */
  group_label: string;
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Value that configures or reports open for this contract. */
  open?: number;
  /** Value that configures or reports in progress for this contract. */
  in_progress?: number;
  /** Value that configures or reports closed for this contract. */
  closed?: number;
  /** Value that configures or reports other for this contract. */
  other?: number;
  /** Value that configures or reports completion pct for this contract. */
  completion_pct?: number;
  /** Number of null entries represented by this result. */
  null_count?: number;
  /** Value that configures or reports sum for this contract. */
  sum?: number | null;
  /** Value that configures or reports avg for this contract. */
  avg?: number | null;
}

/** Documents the aggregate result payload exchanged by command, SDK, and package integrations. */
export interface AggregateResult {
  /** Value that configures or reports groups for this contract. */
  groups: AggregateRow[];
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Value that configures or reports totals for this contract. */
  totals: {
    items_considered: number;
    items_grouped: number;
    items_skipped_unparented: number;
  };
  /** Value that configures or reports filters for this contract. */
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
  /** Value that configures or reports now for this contract. */
  now: string;
  /** Value that configures or reports warnings for this contract. */
  warnings?: string[];
}

function parseStatus(
  raw: string | undefined,
  statusRegistry: RuntimeStatusRegistry,
): ItemStatus | undefined {
  const statuses = parseStatusFilterCsv(raw, statusRegistry, {
    strict: true,
    flagLabel: "--status",
  });
  if (!statuses || statuses.length === 0) {
    return undefined;
  }
  if (statuses.length > 1) {
    throw new PmCliError(
      'Aggregate --status accepts one status, or the standalone "all" sentinel.',
      EXIT_CODE.USAGE,
    );
  }
  return statuses[0];
}

interface NumericAggregation {
  field: string;
  sum: boolean;
  avg: boolean;
}

function parseNumericAggregation(
  options: AggregateOptions,
  allowedFields: readonly string[] = ["estimate", "estimated_minutes", "priority"],
): NumericAggregation | null {
  const sumField = options.sum?.trim();
  const avgField = options.avg?.trim();
  const normalizedSum = sumField && sumField.length > 0 ? sumField : undefined;
  const normalizedAvg = avgField && avgField.length > 0 ? avgField : undefined;
  if (!normalizedSum && !normalizedAvg) {
    return null;
  }
  if (normalizedSum && normalizedAvg && normalizedSum !== normalizedAvg) {
    throw new PmCliError(
      "Aggregate --sum and --avg must target the same numeric field",
      EXIT_CODE.USAGE,
    );
  }
  const field = normalizedSum ?? normalizedAvg!;
  if (!allowedFields.includes(field)) {
    throw new PmCliError(
      `Aggregate numeric field "${field}" is not registered. Allowed: ${allowedFields.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  return {
    field,
    sum: normalizedSum !== undefined,
    avg: normalizedAvg !== undefined,
  };
}

function parseGroupBy(raw: string | undefined): AggregateGroupField[] {
  const value = raw?.trim() ?? "status";
  if (value.length === 0) {
    throw new PmCliError(
      "--group-by requires at least one field name",
      EXIT_CODE.USAGE,
    );
  }
  const requested = splitCommaList(value);
  if (requested.length === 0) {
    throw new PmCliError(
      "--group-by requires a comma-separated list of fields",
      EXIT_CODE.USAGE,
    );
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
  const normalized = [
    ...new Set(
      tags
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (normalized.length === 0) {
    return null;
  }
  return normalized.join(",");
}

function resolveGroupValue(
  field: AggregateGroupField,
  item: AggregateListedItem,
): AggregateGroupValue {
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

function compareNullableGroupValue(
  left: AggregateGroupValue | undefined,
  right: AggregateGroupValue | undefined,
): number {
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

function buildGroupKey(
  groupBy: AggregateGroupField[],
  group: AggregateGroupRecord,
): string {
  return groupBy
    .map((field) => `${field}:${JSON.stringify(group[field] ?? null)}`)
    .join("|");
}

/** Explicit display label for an empty/blank group value, keyed by dimension. */
const EMPTY_AGGREGATE_GROUP_LABELS: Record<AggregateGroupField, string> = {
  parent: "(unparented)",
  type: "(untyped)",
  priority: "(no priority)",
  status: "(no status)",
  assignee: "(unassigned)",
  tags: "(untagged)",
  sprint: "(no sprint)",
  release: "(no release)",
};

/** Render a single group field's value, substituting an explicit label for null. */
function formatGroupFieldLabel(
  field: AggregateGroupField,
  value: AggregateGroupValue | undefined,
): string {
  if (value === null || value === undefined || value === "") {
    return EMPTY_AGGREGATE_GROUP_LABELS[field];
  }
  return String(value);
}

/** Build the human-readable label for an aggregate row. Single-field grouping yields the bare (possibly substituted) value; multi-field grouping joins each "field=value" pair so composite groups stay unambiguous. */
function buildGroupLabel(
  groupBy: AggregateGroupField[],
  group: AggregateGroupRecord,
): string {
  if (groupBy.length === 1) {
    return formatGroupFieldLabel(groupBy[0], group[groupBy[0]]);
  }
  return groupBy
    .map((field) => `${field}=${formatGroupFieldLabel(field, group[field])}`)
    .join(" | ");
}

function compareAggregateRows(
  left: AggregateRow,
  right: AggregateRow,
  groupBy: AggregateGroupField[],
): number {
  for (const field of groupBy) {
    const byField = compareNullableGroupValue(
      left.group[field],
      right.group[field],
    );
    if (byField !== 0) {
      return byField;
    }
  }
  return 0;
}

function readNumericAggregateValue(
  item: AggregateListedItem,
  field: string,
): number | null {
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
  /** group_label is derived once at finalization, so the accumulator omits it. */
  row: Omit<AggregateRow, "group_label">;
  numeric_count: number;
  numeric_sum: number;
  null_count: number;
  open_count: number;
  in_progress_count: number;
  closed_count: number;
  other_count: number;
}

function completionPct(closed: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.round((closed / total) * 10000) / 100;
}

function updateCompletionCounts(
  accumulator: AggregateAccumulator,
  status: ItemStatus,
  statusRegistry: RuntimeStatusRegistry,
): void {
  const normalizedStatus =
    normalizeStatusInput(String(status), statusRegistry) ?? status;
  if (normalizedStatus === statusRegistry.open_status) {
    accumulator.open_count += 1;
    return;
  }
  if (
    normalizedStatus === "in_progress" ||
    (statusRegistry.active_statuses.has(normalizedStatus) &&
      normalizedStatus !== statusRegistry.open_status)
  ) {
    accumulator.in_progress_count += 1;
    return;
  }
  if (
    statusRegistry.terminal_done_statuses.has(normalizedStatus) ||
    normalizedStatus === statusRegistry.close_status
  ) {
    accumulator.closed_count += 1;
    return;
  }
  accumulator.other_count += 1;
}

function createAggregateAccumulator(
  group: AggregateGroupRecord,
  numericValue: number | null,
): AggregateAccumulator {
  return {
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
    other_count: 0,
  };
}

function updateNumericAggregation(
  accumulator: AggregateAccumulator,
  numericValue: number | null,
): void {
  if (numericValue === null) {
    accumulator.null_count += 1;
    return;
  }
  accumulator.numeric_count += 1;
  accumulator.numeric_sum += numericValue;
}

function updateAggregateAccumulator(params: {
  accumulator: AggregateAccumulator;
  item: AggregateListedItem;
  statusRegistry: RuntimeStatusRegistry;
  includeCompletion: boolean;
  numericAggregation: NumericAggregation | null;
  numericValue: number | null;
}): void {
  params.accumulator.row.count += 1;
  if (params.includeCompletion) {
    updateCompletionCounts(
      params.accumulator,
      params.item.status,
      params.statusRegistry,
    );
  }
  if (params.numericAggregation !== null) {
    updateNumericAggregation(params.accumulator, params.numericValue);
  }
}

function buildAggregateGroup(
  groupBy: AggregateGroupField[],
  item: AggregateListedItem,
): AggregateGroupRecord {
  const group: AggregateGroupRecord = {};
  for (const field of groupBy) {
    group[field] = resolveGroupValue(field, item);
  }
  return group;
}

function finalizeAggregateRow(
  entry: AggregateAccumulator,
  groupBy: AggregateGroupField[],
  includeCompletion: boolean,
  numericAggregation: NumericAggregation | null,
): AggregateRow {
  const row: AggregateRow = {
    ...entry.row,
    group_label: buildGroupLabel(groupBy, entry.row.group),
  };
  if (includeCompletion) {
    row.open = entry.open_count;
    row.in_progress = entry.in_progress_count;
    row.closed = entry.closed_count;
    row.other = entry.other_count;
    row.completion_pct = completionPct(entry.closed_count, entry.row.count);
  }
  if (numericAggregation !== null) {
    row.null_count = entry.null_count;
    if (numericAggregation.sum) {
      row.sum = entry.numeric_sum;
    }
    if (numericAggregation.avg) {
      row.avg =
        entry.numeric_count === 0
          ? null
          : entry.numeric_sum / entry.numeric_count;
    }
  }
  return row;
}

function buildAggregateFilters(params: {
  groupBy: AggregateGroupField[];
  includeCompletion: boolean;
  includeUnparented: boolean;
  status: ItemStatus | undefined;
  options: AggregateOptions;
  numericAggregation: NumericAggregation | null;
}): AggregateResult["filters"] {
  return {
    group_by: params.groupBy,
    count: true,
    completion: params.includeCompletion,
    include_unparented: params.includeUnparented,
    status: params.status ?? null,
    type: params.options.type ?? null,
    tag: params.options.tag ?? null,
    priority: params.options.priority ?? null,
    deadline_before: params.options.deadlineBefore ?? null,
    deadline_after: params.options.deadlineAfter ?? null,
    assignee: params.options.assignee ?? null,
    assignee_filter: params.options.assigneeFilter ?? null,
    parent: params.options.parent ?? null,
    sprint: params.options.sprint ?? null,
    release: params.options.release ?? null,
    ...(params.numericAggregation !== null
      ? {
          sum: params.options.sum ?? null,
          avg: params.options.avg ?? null,
          numeric_field: params.numericAggregation.field,
        }
      : {}),
  };
}

/** Implements run aggregate for the public runtime surface of this module. */
export async function runAggregate(
  options: AggregateOptions,
  global: GlobalOptions,
): Promise<AggregateResult> {
  if (options.count === false) {
    throw new PmCliError(
      "Aggregate grouped counts are always enabled; omit count=false.",
      EXIT_CODE.USAGE,
    );
  }

  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const numericFields = [
    "estimate",
    "estimated_minutes",
    "priority",
    ...resolveRuntimeFieldRegistry(settings.schema).definitions
      .filter((definition) => definition.type === "number")
      .map((definition) => definition.metadata_key),
  ];
  const groupBy = parseGroupBy(options.groupBy);
  const status = parseStatus(options.status, statusRegistry);
  const numericAggregation = parseNumericAggregation(
    options,
    [...new Set(numericFields)].sort((left, right) => left.localeCompare(right)),
  );
  const includeCompletion = options.completion === true;
  const includeUnparented = options.includeUnparented === true;

  const listed = await runList(status, buildListQueryFilters(options), global);

  const grouped = new Map<string, AggregateAccumulator>();
  let skippedUnparented = 0;
  let groupedItemCount = 0;

  for (const listedItem of listed.items) {
    const item = listedItem as AggregateListedItem;
    const group = buildAggregateGroup(groupBy, item);
    if (
      groupBy.includes("parent") &&
      group.parent === null &&
      !includeUnparented
    ) {
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
      updateAggregateAccumulator({
        accumulator: existing,
        item,
        statusRegistry,
        includeCompletion,
        numericAggregation,
        numericValue,
      });
    } else {
      const accumulator = createAggregateAccumulator(group, numericValue);
      if (includeCompletion) {
        updateCompletionCounts(accumulator, item.status, statusRegistry);
      }
      grouped.set(key, accumulator);
    }
    groupedItemCount += 1;
  }

  const groups = [...grouped.values()]
    .map((entry) =>
      finalizeAggregateRow(
        entry,
        groupBy,
        includeCompletion,
        numericAggregation,
      ),
    )
    .sort((left, right) => compareAggregateRows(left, right, groupBy));
  const warnings =
    listed.warnings && listed.warnings.length > 0 ? listed.warnings : undefined;

  return {
    groups,
    count: groups.length,
    totals: {
      items_considered: listed.items.length,
      items_grouped: groupedItemCount,
      items_skipped_unparented: skippedUnparented,
    },
    filters: buildAggregateFilters({
      groupBy,
      includeCompletion,
      includeUnparented,
      status,
      options,
      numericAggregation,
    }),
    now: nowIso(),
    ...(warnings ? { warnings } : {}),
  };
}

/** Public contract for test only aggregate command, shared by SDK and presentation-layer consumers. */
export const _testOnlyAggregateCommand = {
  buildGroupKey,
  compareAggregateRows,
  compareNullableGroupValue,
  completionPct,
  normalizeTagGroupValue,
  parseGroupBy,
  parseNumericAggregation,
  parseStatus,
  readNumericAggregateValue,
  resolveGroupValue,
  updateCompletionCounts,
};
