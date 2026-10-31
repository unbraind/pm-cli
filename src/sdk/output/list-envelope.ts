/**
 * @module sdk/output/list-envelope
 *
 * Projects standard brief-list receipts for agent presentation while retaining
 * source uncertainty, pagination and producer-owned diagnostics.
 */
import { BRIEF_LIST_FIELDS } from "../query/projection-contracts.js";

/** Recognize metadata records without treating null or arrays as objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Recognize the default brief projection without dropping producer extensions. */
function hasStandardBriefProjection(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const fields = value.fields;
  return (
    value.mode === "brief" &&
    Object.keys(value).length === 2 &&
    Array.isArray(fields) &&
    (fields.length === BRIEF_LIST_FIELDS.length ||
      (fields.length === BRIEF_LIST_FIELDS.length + 1 && fields.at(-1) === "priority")) &&
    BRIEF_LIST_FIELDS.every((field, index) => fields[index] === field)
  );
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
 * Compact a standard brief-list envelope without mutating its typed SDK result.
 * Full, custom, partial and inconsistent receipts pass through unchanged.
 * Unchecked pages retain their explicit source status, including empty pages.
 * JSON hosts should retain the original result when full receipts are required.
 */
export function projectPmBriefListEnvelope(value: unknown): unknown {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    Object.hasOwn(value, "details") ||
    !hasStandardBriefProjection(value.projection) ||
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
    projection: _projection,
    now: _now,
    omission_receipt: _omissions,
    sorting,
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
    ...compactEchoedFilters(rest.filters, rest.applied_limit),
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
    typeof value[1] === "string"
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

/** Drop a filters.limit echo that applied_limit already states, and the filters block once nothing else remains. */
function compactEchoedFilters(
  filters: unknown,
  appliedLimit: unknown,
): { filters?: unknown } {
  if (!isRecord(filters)) return filters === undefined ? {} : { filters };
  const remaining = Object.fromEntries(
    Object.entries(filters).filter(
      ([key, value]) =>
        !(key === "limit" && String(value) === String(appliedLimit)) &&
        !(key === "runtime_filters" && isRecord(value) && Object.keys(value).length === 0),
    ),
  );
  return Object.keys(remaining).length === 0 ? {} : { filters: remaining };
}

/**
 * Compact a standard search page without mutating its typed SDK result:
 * drops `truncated` when it repeats `has_more`, a `filters.limit` echo of
 * `applied_limit`, and the single default `projection_metadata` omission
 * receipt in favour of `details: "--full"`. Custom, partial and inconsistent
 * receipts pass through unchanged; JSON hosts should keep the original result.
 */
export function projectPmBriefSearchEnvelope(value: unknown): unknown {
  if (
    !isRecord(value) ||
    typeof value.query !== "string" ||
    !Array.isArray(value.items) ||
    Object.hasOwn(value, "details") ||
    !hasStandardPagination(value, value.items.length) ||
    !hasDefaultOmissions(value.omission_receipt, "projection_metadata")
  )
    return value;
  const {
    truncated: _truncated,
    omission_receipt: _omissions,
    filters,
    ...rest
  } = value;
  return {
    ...rest,
    ...compactEchoedFilters(filters, rest.applied_limit),
    details: "--full",
  };
}
