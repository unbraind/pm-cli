/**
 * @module cli/commands/list-filter-shared
 *
 * Implements the pm list filter shared command surface and its agent-facing runtime behavior.
 */
import type { ListOptions } from "./list.js";

interface HasListFilterOptions {
  includePagination?: boolean;
}

function isActiveListFilterValue(value: unknown): boolean {
  return value != null && (typeof value !== "string" || value.split(",").some((entry) => entry.trim().length > 0));
}

/**
 * Implements check whether list filters for the public runtime surface of this module.
 */
export function hasListFilters(
  list: ListOptions | undefined,
  status: string | undefined,
  options: HasListFilterOptions = {},
): boolean {
  const includePagination = options.includePagination !== false;
  return (
    isActiveListFilterValue(status) ||
    isActiveListFilterValue(list?.status) ||
    isActiveListFilterValue(list?.type) ||
    isActiveListFilterValue(list?.tag) ||
    isActiveListFilterValue(list?.priority) ||
    isActiveListFilterValue(list?.deadlineBefore) ||
    isActiveListFilterValue(list?.deadlineAfter) ||
    isActiveListFilterValue(list?.updatedAfter) ||
    isActiveListFilterValue(list?.updatedBefore) ||
    isActiveListFilterValue(list?.createdAfter) ||
    isActiveListFilterValue(list?.createdBefore) ||
    isActiveListFilterValue(list?.ids) ||
    isActiveListFilterValue(list?.assignee) ||
    isActiveListFilterValue(list?.assigneeFilter) ||
    isActiveListFilterValue(list?.parent) ||
    isActiveListFilterValue(list?.sprint) ||
    isActiveListFilterValue(list?.release) ||
    list?.filterAcMissing === true ||
    list?.filterEstimatesMissing === true ||
    list?.filterResolutionMissing === true ||
    list?.filterMetadataMissing === true ||
    list?.filterReviewerMissing === true ||
    list?.filterRiskMissing === true ||
    list?.filterConfidenceMissing === true ||
    list?.filterSprintMissing === true ||
    list?.filterReleaseMissing === true ||
    list?.hasNotes === true ||
    list?.hasLearnings === true ||
    list?.hasFiles === true ||
    list?.hasDocs === true ||
    list?.hasTests === true ||
    list?.hasComments === true ||
    list?.hasDeps === true ||
    list?.hasBody === true ||
    list?.hasLinkedCommand === true ||
    list?.noNotes === true ||
    list?.noLearnings === true ||
    list?.noFiles === true ||
    list?.noDocs === true ||
    list?.noTests === true ||
    list?.noComments === true ||
    list?.noDeps === true ||
    list?.emptyBody === true ||
    list?.noLinkedCommand === true ||
    (includePagination && isActiveListFilterValue(list?.limit)) ||
    (includePagination && isActiveListFilterValue(list?.offset))
  );
}

/**
 * Restricts list query filters values accepted by command, SDK, and storage contracts.
 */
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

/**
 * Implements build list query filters for the public runtime surface of this module.
 */
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
