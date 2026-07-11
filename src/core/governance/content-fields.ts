/**
 * Content-field governance & utilization primitives.
 *
 * "Project management = context management": these primitives let agents query
 * which items carry context (notes/learnings/files/docs/tests/comments/deps/
 * body, plus whether a linked test carries a runnable command) and which do
 * not. The surface powers content-field selection (pm list / pm update-many)
 * and field-utilization reporting (pm stats --field-utilization).
 *
 * The module is pure: it performs no IO and imports no heavy runtime
 * dependencies. Callers pass plain structural item shapes so the logic stays
 * trivially testable.
 */

/** The content fields an item can carry context in. */
export type ContentField =
  | "notes"
  | "learnings"
  | "files"
  | "docs"
  | "tests"
  | "comments"
  | "deps"
  | "body"
  | "linked_command";

/** Stable rendering / iteration order for content fields. */
export const CONTENT_FIELD_ORDER: readonly ContentField[] = [
  "notes",
  "learnings",
  "files",
  "docs",
  "tests",
  "comments",
  "deps",
  "body",
  "linked_command",
] as const;

/** Minimal structural shape needed: the collection arrays + optional body. */
export interface ContentFieldItem {
  /** Value that configures or reports notes for this contract. */
  notes?: unknown[];
  /** Value that configures or reports learnings for this contract. */
  learnings?: unknown[];
  /** Value that configures or reports files for this contract. */
  files?: unknown[];
  /** Value that configures or reports docs for this contract. */
  docs?: unknown[];
  /** Value that configures or reports tests for this contract. */
  tests?: unknown[];
  /** Value that configures or reports comments for this contract. */
  comments?: unknown[];
  /** Value that configures or reports dependencies for this contract. */
  dependencies?: unknown[];
  /** Value that configures or reports body for this contract. */
  body?: string;
  [key: string]: unknown;
}

/** True when `value` is a non-empty array. */
function hasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** True when the body string carries non-whitespace content. */
function hasBody(body: unknown): boolean {
  return typeof body === "string" && body.trim().length > 0;
}

/** True when at least one entry in the `tests` array carries a non-empty string `command`. Tolerant of non-object / non-string entries. */
function hasLinkedCommand(tests: unknown): boolean {
  if (!Array.isArray(tests)) {
    return false;
  }
  return tests.some((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const command = (entry as { command?: unknown }).command;
    return typeof command === "string" && command.trim().length > 0;
  });
}

/** True when the given content field carries context on this item. - collection fields: `Array.isArray && length > 0` - "deps": maps to the `dependencies` array - "body": `typeof body === "string" && body.trim().length > 0` - "linked_command": `tests` array has at least one entry with a non-empty string `command` */
export function isContentFieldPresent(
  item: ContentFieldItem,
  field: ContentField,
): boolean {
  switch (field) {
    case "notes":
      return hasEntries(item.notes);
    case "learnings":
      return hasEntries(item.learnings);
    case "files":
      return hasEntries(item.files);
    case "docs":
      return hasEntries(item.docs);
    case "tests":
      return hasEntries(item.tests);
    case "comments":
      return hasEntries(item.comments);
    case "deps":
      return hasEntries(item.dependencies);
    case "body":
      return hasBody(item.body);
    case "linked_command":
      return hasLinkedCommand(item.tests);
  }
  // No default: every ContentField has an explicit case above, so TypeScript
  // enforces exhaustiveness here — adding a new field without a case is a
  // compile error rather than a silent fall-through (and no unreachable branch
  // to dent the literal-100% coverage gate).
}

/** Per-field selection: 'present' requires the field populated, 'absent' requires it empty. */
export type ContentFieldSelection = "present" | "absent";

/** Map of content fields to a present/absent requirement. */
export type ContentFieldFilters = Partial<
  Record<ContentField, ContentFieldSelection>
>;

/** True when at least one content-field selection is requested. */
export function hasContentFieldFilter(filters: ContentFieldFilters): boolean {
  return CONTENT_FIELD_ORDER.some((field) => filters[field] !== undefined);
}

/**
 * Does a single item satisfy the requested content-field filters?
 *
 * AND semantics across all requested fields: each requested field must match
 * its present/absent requirement. When no filter is requested the item passes.
 */
export function itemMatchesContentFilters(
  item: ContentFieldItem,
  filters: ContentFieldFilters,
): boolean {
  for (const field of CONTENT_FIELD_ORDER) {
    const selection = filters[field];
    if (selection === undefined) {
      continue;
    }
    const present = isContentFieldPresent(item, field);
    if (selection === "present" && !present) {
      return false;
    }
    if (selection === "absent" && present) {
      return false;
    }
  }
  return true;
}

/** Filter a list of items by the requested content-field selections. */
export function filterByContentFields<T extends ContentFieldItem>(
  items: readonly T[],
  filters: ContentFieldFilters,
): T[] {
  if (!hasContentFieldFilter(filters)) {
    return [...items];
  }
  return items.filter((item) => itemMatchesContentFilters(item, filters));
}

/** Whether a content-field filter set requires the heavy collections to be loaded. True when any non-body field is requested (collections + tests' linked command all live in the heavy front-matter arrays). */
export function contentFiltersNeedCollections(
  filters: ContentFieldFilters,
): boolean {
  return CONTENT_FIELD_ORDER.some(
    (field) => field !== "body" && filters[field] !== undefined,
  );
}

/** Whether a content-field filter set requires the item body to be loaded. */
export function contentFiltersNeedBody(filters: ContentFieldFilters): boolean {
  return filters.body !== undefined;
}

// ---------------------------------------------------------------------------
// Field utilization
// ---------------------------------------------------------------------------

/** Utilization of a single content field: present vs total, with a rounded percent. */
export interface ContentFieldUtilization {
  /** Value that configures or reports present for this contract. */
  present: number;
  /** Value that configures or reports total for this contract. */
  total: number;
  /** present/total * 100, rounded to one decimal; 100 when total is 0. */
  percent: number;
}

/** Per-field utilization report for pm stats --field-utilization. */
export interface ContentFieldUtilizationReport {
  /** Value that configures or reports total items for this contract. */
  total_items: number;
  /** Utilization keyed by content field (includes body and linked_command). */
  fields: Record<ContentField, ContentFieldUtilization>;
  /** Convenience alias mirroring GH-241: identical to `fields.body`. */
  body_populated: ContentFieldUtilization;
  /** Items with an empty body; `present` counts the empty-bodied items. */
  empty_body: ContentFieldUtilization;
}

/** Round present/total into a one-decimal percentage. Matches the convention in metadata-coverage.ts: a zero population reports 100 (nothing missing). */
function roundPercent(present: number, total: number): number {
  if (total === 0) {
    return 100;
  }
  return Math.round((present / total) * 1000) / 10;
}

function emptyUtilizationFields(): Record<
  ContentField,
  ContentFieldUtilization
> {
  const record = {} as Record<ContentField, ContentFieldUtilization>;
  for (const field of CONTENT_FIELD_ORDER) {
    record[field] = { present: 0, total: 0, percent: 100 };
  }
  return record;
}

/** Compute content-field utilization across a list of items. For each field we report how many items populate it out of the total, plus a rounded percentage. Convenience `body_populated`/`empty_body` aliases mirror GH-241. */
export function computeContentFieldUtilization(
  items: readonly ContentFieldItem[],
): ContentFieldUtilizationReport {
  const fields = emptyUtilizationFields();
  const total = items.length;
  for (const item of items) {
    for (const field of CONTENT_FIELD_ORDER) {
      if (isContentFieldPresent(item, field)) {
        fields[field].present += 1;
      }
    }
  }
  for (const field of CONTENT_FIELD_ORDER) {
    fields[field].total = total;
    fields[field].percent = roundPercent(fields[field].present, total);
  }
  const bodyPopulated = fields.body;
  const emptyBodyCount = total - bodyPopulated.present;
  const emptyBody: ContentFieldUtilization = {
    present: emptyBodyCount,
    total,
    percent: roundPercent(emptyBodyCount, total),
  };
  return {
    total_items: total,
    fields,
    body_populated: bodyPopulated,
    empty_body: emptyBody,
  };
}
