/**
 * @module sdk/output/list-envelope
 *
 * Projects standard list and search read receipts for agent presentation while
 * retaining source uncertainty, pagination and producer-owned diagnostics. The
 * brief default, `--compact` and `--fields` row projections share one lean
 * envelope (GH-1642, GH-1674); `--full` and JSON keep the typed result.
 */

/** Recognize metadata records without treating null or arrays as objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Row projection modes whose echo the rendered rows already disclose. */
const ROW_PROJECTION_MODES: ReadonlySet<unknown> = new Set(["brief", "compact", "fields"]);

/** A standard row projection: a known mode and its field list, with no producer extensions. */
interface RowProjection {
  mode: "brief" | "compact" | "fields";
  fields: string[];
}

/** Recognize a standard row projection without dropping producer extensions. */
function isRowProjection(value: unknown): value is RowProjection {
  if (!isRecord(value)) return false;
  const fields = value.fields;
  return (
    ROW_PROJECTION_MODES.has(value.mode) &&
    Object.keys(value).length === 2 &&
    Array.isArray(fields) &&
    fields.length > 0 &&
    fields.every((field) => typeof field === "string" && field.length > 0)
  );
}

/**
 * Require every row to carry exactly the projected fields, so dropping the
 * projection echo never hides a producer mismatch between echo and rows.
 */
function rowsMatchProjection(items: readonly unknown[], projection: RowProjection): boolean {
  return items.every(
    (row) =>
      isRecord(row) &&
      Object.keys(row).length === projection.fields.length &&
      projection.fields.every((field) => Object.hasOwn(row, field)),
  );
}

/**
 * Keep a custom field list only on an empty page, where no row header shows it.
 * Brief and compact field lists are documented defaults, so they never need it.
 */
function retainedProjection(
  projection: RowProjection,
  rowCount: number,
): { projection?: RowProjection } {
  return projection.mode === "fields" && rowCount === 0 ? { projection } : {};
}

/** Require truthful standard pagination before removing redundant aliases. */
function hasStandardPagination(
  value: Record<string, unknown>,
  count: number,
): boolean {
  return (
    typeof value.has_more === "boolean" &&
    value.truncated === value.has_more &&
    value.count === count &&
    typeof value.total === "number" &&
    Number.isSafeInteger(value.total) &&
    (value.has_more
      ? value.total > count &&
        typeof value.next_cursor === "string" &&
        value.next_cursor.length > 0
      : value.total === count && value.next_cursor == null)
  );
}

/** Keep uncertain or unreadable sources out of successful-source compaction. */
function hasCompactibleSource(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (value.status === "complete" || value.status === "unchecked") &&
    value.unreadable_item_count === 0 &&
    value.unreadable_directory_count === 0
  );
}

/** Only a single default omission group has a shorter equivalent restoration pointer. */
function hasDefaultOmissions(
  value: unknown,
  groupName = "full_item_fields",
): boolean {
  if (!isRecord(value) || !Array.isArray(value.omitted_field_groups))
    return false;
  const groups = value.omitted_field_groups;
  const group: unknown = groups[0];
  return (
    value.has_omissions === true &&
    value.omitted_field_group_count === 1 &&
    Object.keys(value).length === 3 &&
    groups.length === 1 &&
    isRecord(group) &&
    Object.keys(group).length === 2 &&
    group.name === groupName &&
    group.restore_with === "--full"
  );
}

/**
 * Compact a standard brief, compact or fields list envelope without mutating
 * its typed SDK result. Full, custom, partial and inconsistent receipts pass
 * through unchanged. Unchecked pages retain their explicit source status,
 * including empty pages. JSON hosts should retain the original result when full
 * receipts are required.
 */
export function projectPmBriefListEnvelope(value: unknown): unknown {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    Object.hasOwn(value, "details") ||
    !isRowProjection(value.projection) ||
    !rowsMatchProjection(value.items, value.projection) ||
    !hasCompactibleSource(value.completeness) ||
    !hasStandardPagination(value, value.items.length) ||
    !hasDefaultOmissions(value.omission_receipt)
  )
    return value;
  const {
    total,
    has_more: hasMore,
    truncated: _truncated,
    next_cursor: nextCursor,
    completeness,
    projection,
    now: _now,
    omission_receipt: _omissions,
    sorting,
    filters,
    ...rest
  } = value;
  const completed =
    completeness.status === "complete" &&
    !hasMore &&
    Object.keys(completeness).length === 3;
  const {
    unreadable_item_count: _items,
    unreadable_directory_count: _directories,
    ...source
  } = completeness;
  return {
    ...rest,
    ...(!completed ? { total, has_more: hasMore, completeness: source } : {}),
    ...(hasMore ? { next_cursor: nextCursor } : {}),
    ...projectDefaultSorting(sorting),
    ...compactEchoedFilters(filters, rest.applied_limit, projection),
    ...retainedProjection(projection, value.items.length),
    details: "--full",
  };
}

/** Recognize the default ascending sort, with or without its derived comparator list. */
function isDefaultSorting(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.sort === "default" &&
    value.order === "asc" &&
    Object.keys(value).every(
      (key) => key === "sort" || key === "order" || key === "effective_keys",
    )
  );
}

/** Recognize one `[key, order]` comparator stage. */
function isSortKeyPair(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    (value[1] === "asc" || value[1] === "desc")
  );
}

/**
 * Drop the legacy default sort/order echo; keep the effective default order
 * visible (GH-1507) as one comparator line. Other sorts pass through unchanged.
 */
function projectDefaultSorting(value: unknown): { sorting?: unknown } {
  if (!isDefaultSorting(value)) return { sorting: value };
  const keys = value.effective_keys;
  if (keys === undefined) return {};
  if (!Array.isArray(keys) || !keys.every(isSortKeyPair)) return { sorting: value };
  return {
    sorting: {
      effective_keys: keys.map(([key, order]) => `${key} ${order}`).join(", "),
    },
  };
}

/** Whether a `filters.fields` flag echo names exactly the projected field list. */
function echoesProjectionFields(value: unknown, projection: RowProjection | undefined): boolean {
  if (typeof value !== "string" || projection === undefined) return false;
  const requested = value.split(",").map((field) => field.trim()).filter(Boolean);
  return requested.length === projection.fields.length &&
    requested.every((field, index) => field === projection.fields[index]);
}

/**
 * Drop filter echoes the envelope already states: a `limit` equal to
 * `applied_limit`, a `fields` flag equal to the projection, and empty
 * `runtime_filters`. The filters block disappears once nothing else remains.
 */
function compactEchoedFilters(
  filters: unknown,
  appliedLimit: unknown,
  projection?: RowProjection,
): { filters?: unknown } {
  if (!isRecord(filters)) return filters === undefined ? {} : { filters };
  const remaining = Object.fromEntries(
    Object.entries(filters).filter(
      ([key, value]) =>
        !(key === "limit" && String(value) === String(appliedLimit)) &&
        !(key === "fields" && echoesProjectionFields(value, projection)) &&
        !(key === "runtime_filters" && isRecord(value) && Object.keys(value).length === 0),
    ),
  );
  return Object.keys(remaining).length === 0 ? {} : { filters: remaining };
}

/** A final search page omits the continuation fields entirely; accept it only when nothing suggests more rows. */
function hasTerminalSearchPagination(
  value: Record<string, unknown>,
  count: number,
): boolean {
  return (
    value.count === count &&
    !Object.hasOwn(value, "has_more") &&
    !Object.hasOwn(value, "truncated") &&
    value.next_cursor == null &&
    (value.total === undefined || value.total === count)
  );
}

/**
 * A compact search page carries no projection and restores it with the
 * `projection_metadata` group; a `--fields` page carries its row projection and
 * restores full rows with `full_item_fields`. Anything else is not standard.
 */
function standardSearchProjection(
  value: Record<string, unknown>,
): { projection?: RowProjection } | undefined {
  if (!Object.hasOwn(value, "projection")) {
    return hasDefaultOmissions(value.omission_receipt, "projection_metadata") ? {} : undefined;
  }
  const projection = value.projection;
  return isRowProjection(projection) && projection.mode === "fields" &&
    rowsMatchProjection(value.items as unknown[], projection) &&
    typeof value.now === "string" &&
    hasDefaultOmissions(value.omission_receipt)
    ? { projection }
    : undefined;
}

/**
 * Compact a standard search page without mutating its typed SDK result:
 * drops `truncated` when it repeats `has_more`, a `filters.limit` echo of
 * `applied_limit`, and the single default omission receipt in favour of
 * `details: "--full"`. A `--fields` page also drops its projection and `fields`
 * echo, `now`, and a `mode_source` the caller already knows (GH-1674). Custom,
 * partial and inconsistent receipts pass through unchanged; JSON hosts should
 * keep the original result.
 */
export function projectPmBriefSearchEnvelope(value: unknown): unknown {
  if (
    !isRecord(value) ||
    typeof value.query !== "string" ||
    !Array.isArray(value.items) ||
    Object.hasOwn(value, "details") ||
    !(
      hasStandardPagination(value, value.items.length) ||
      hasTerminalSearchPagination(value, value.items.length)
    )
  )
    return value;
  const standard = standardSearchProjection(value);
  if (standard === undefined) return value;
  const {
    truncated: _truncated,
    omission_receipt: _omissions,
    filters,
    projection: _projection,
    now: _now,
    mode_source: modeSource,
    ...rest
  } = value;
  return {
    ...rest,
    ...(modeSource === "settings" ||
    (standard.projection === undefined && modeSource !== undefined)
      ? { mode_source: modeSource }
      : {}),
    ...compactEchoedFilters(filters, rest.applied_limit, standard.projection),
    ...(standard.projection
      ? retainedProjection(standard.projection, value.items.length)
      : {}),
    details: "--full",
  };
}
