/**
 * @module cli/commands/list-filter-shared
 *
 * Implements the pm list filter shared command surface and its agent-facing runtime behavior.
 */
import type { ListOptions } from "./list.js";

interface HasListFilterOptions {
  includePagination?: boolean;
}

const LIST_VALUE_FILTER_KEYS = [
  "status",
  "type",
  "tag",
  "priority",
  "deadlineBefore",
  "deadlineAfter",
  "updatedAfter",
  "updatedBefore",
  "createdAfter",
  "createdBefore",
  "ids",
  "assignee",
  "assigneeFilter",
  "parent",
  "sprint",
  "release",
] as const satisfies readonly (keyof ListOptions)[];

const LIST_BOOLEAN_FILTER_KEYS = [
  "filterAcMissing",
  "filterEstimatesMissing",
  "filterResolutionMissing",
  "filterMetadataMissing",
  "filterReviewerMissing",
  "filterRiskMissing",
  "filterConfidenceMissing",
  "filterSprintMissing",
  "filterReleaseMissing",
  "hasNotes",
  "hasLearnings",
  "hasFiles",
  "hasDocs",
  "hasTests",
  "hasComments",
  "hasDeps",
  "hasBody",
  "hasLinkedCommand",
  "noNotes",
  "noLearnings",
  "noFiles",
  "noDocs",
  "noTests",
  "noComments",
  "noDeps",
  "emptyBody",
  "noLinkedCommand",
] as const satisfies readonly (keyof ListOptions)[];

function isActiveListFilterValue(value: unknown): boolean {
  return (
    value != null &&
    (typeof value !== "string" ||
      value.split(",").some((entry) => entry.trim().length > 0))
  );
}

/** Implements check whether list filters for the public runtime surface of this module. */
export function hasListFilters(
  list: ListOptions | undefined,
  status: string | undefined,
  options: HasListFilterOptions = {},
): boolean {
  const includePagination = options.includePagination !== false;
  const valueCandidates = [
    status,
    ...LIST_VALUE_FILTER_KEYS.map((key) => list?.[key]),
    ...(includePagination ? [list?.limit, list?.offset] : []),
  ];
  return (
    valueCandidates.some(isActiveListFilterValue) ||
    LIST_BOOLEAN_FILTER_KEYS.some((key) => list?.[key] === true)
  );
}

/** Restricts list query filters values accepted by command, SDK, and storage contracts. */
export type ListQueryFilters = Pick<
  ListOptions,
  | "type"
  | "tag"
  | "priority"
  | "deadlineBefore"
  | "deadlineAfter"
  | "assignee"
  | "assigneeFilter"
  | "parent"
  | "sprint"
  | "release"
>;

/** Implements build list query filters for the public runtime surface of this module. */
export function buildListQueryFilters(filters: ListQueryFilters): ListOptions {
  return {
    type: filters.type,
    tag: filters.tag,
    priority: filters.priority,
    deadlineBefore: filters.deadlineBefore,
    deadlineAfter: filters.deadlineAfter,
    assignee: filters.assignee,
    assigneeFilter: filters.assigneeFilter,
    parent: filters.parent,
    sprint: filters.sprint,
    release: filters.release,
  };
}
