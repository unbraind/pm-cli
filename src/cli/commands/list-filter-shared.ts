import type { ListOptions } from "./list.js";

interface HasListFilterOptions {
  includePagination?: boolean;
}

function isActiveListFilterValue(value: unknown): boolean {
  return value != null && (typeof value !== "string" || value.split(",").some((entry) => entry.trim().length > 0));
}

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
    (includePagination && isActiveListFilterValue(list?.limit)) ||
    (includePagination && isActiveListFilterValue(list?.offset))
  );
}

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
