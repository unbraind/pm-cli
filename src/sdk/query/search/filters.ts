/**
 * @module sdk/query/search/filters
 * Applies runtime metadata predicates and exact phrase constraints to the query corpus.
 */
import {
  hasContentFieldFilter,
  itemMatchesContentFilters,
} from "../../../core/governance/content-fields.js";
import {
  hasMissingMetadataFilter,
  itemMatchesMissingMetadata,
  type LifecycleClassifier
} from "../../../core/governance/metadata-coverage.js";
import {
  type ItemTypeRegistry
} from "../../../core/item/type-registry.js";
import {
  matchesRuntimeFilters
} from "../../../core/schema/runtime-field-filters.js";
import {
  buildEventCorpus,
  buildPlanFlatCorpus,
  buildReminderCorpus
} from "../../../core/search/corpus.js";
import { EXIT_CODE } from "../../../core/shared/constants.js";
import { PmCliError } from "../../../core/shared/errors.js";
import {
  matchesTimestampFilters
} from "../../../core/shared/time.js";
import type {
  ItemDocument,
  ItemMetadata,
  ItemStatus,
  ItemType
} from "../../../types/index.js";
import {
  resolveContentFieldFilters,
  resolveMissingMetadataFilters,
} from "../list.js";
import {
  parsePriorityFilterSet,
  parseStringFilterSet,
  parseTypeFilterSet,
} from "../multi-value-filters.js";
import {
  normalizeSearchPhrase,
  parseSearchDeadline,
  parseTimestampWindow,
  type SearchOptions
} from "../search-contracts.js";

/** Normalize an unknown collection to its string entries for field filtering and scoring. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Extract annotation text entries used by exact-phrase matching and lexical scoring. */
function textEntries(value: unknown): Array<{ text: string }> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is { text: string } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { text?: unknown }).text === "string",
      )
    : [];
}

/** Extract dependency metadata entries used by filtering and lexical scoring. */
function dependencyEntries(
  value: unknown,
): Array<{ id: string; kind: string }> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is { id: string; kind: string } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { id?: unknown }).id === "string" &&
          typeof (entry as { kind?: unknown }).kind === "string",
      )
    : [];
}

/** Collect searchable text fields used by exact-phrase filtering. */
function collectExactPhraseFields(document: ItemDocument): string[] {
  const item = document.metadata;
  return [
    item.title,
    item.description,
    item.status,
    stringArray(item.tags).join(" "),
    document.body,
    textEntries(item.comments)
      .map((entry) => entry.text)
      .join(" "),
    textEntries(item.notes)
      .map((entry) => entry.text)
      .join(" "),
    textEntries(item.learnings)
      .map((entry) => entry.text)
      .join(" "),
    buildReminderCorpus(item).join(" "),
    buildEventCorpus(item).join(" "),
    dependencyEntries(item.dependencies)
      .map((entry) => `${entry.id} ${entry.kind}`)
      .join(" "),
    buildPlanFlatCorpus(item),
  ];
}

/** Check whether any searchable field contains the normalized exact phrase. */
function documentContainsExactPhrase(
  document: ItemDocument,
  normalizedQuery: string,
): boolean {
  return collectExactPhraseFields(document).some((fieldValue) =>
    normalizeSearchPhrase(fieldValue).includes(normalizedQuery),
  );
}

/** Apply exact-title and exact-phrase restrictions before search ranking. */
function applyExactQueryFilters(
  items: ItemDocument[],
  normalizedQuery: string,
  options: { titleExact: boolean; phraseExact: boolean },
): ItemDocument[] {
  if (!options.titleExact && !options.phraseExact) {
    return items;
  }
  return items.filter((document) => {
    if (
      options.titleExact &&
      normalizeSearchPhrase(document.metadata.title) !== normalizedQuery
    ) {
      return false;
    }
    if (
      options.phraseExact &&
      !documentContainsExactPhrase(document, normalizedQuery)
    ) {
      return false;
    }
    return true;
  });
}

type SearchMissingMetadataFilters = ReturnType<
  typeof resolveMissingMetadataFilters
>;

type SearchContentFieldFilters = ReturnType<typeof resolveContentFieldFilters>;

interface SearchMetadataFilterSet {
  typeFilter: Set<ItemType> | undefined;
  tagFilter: Set<string> | undefined;
  priorityFilter: Set<number> | undefined;
  deadlineBefore: string | undefined;
  deadlineAfter: string | undefined;
  updatedAfter: string | undefined;
  updatedBefore: string | undefined;
  createdAfter: string | undefined;
  createdBefore: string | undefined;
  assigneeFilter: Set<string> | undefined;
  sprintFilter: Set<string> | undefined;
  releaseFilter: Set<string> | undefined;
  parentFilter: string | undefined;
  statusSet: Set<ItemStatus> | undefined;
  missingMetadataFilters: SearchMissingMetadataFilters;
  missingMetadataActive: boolean;
  contentFieldFilters: SearchContentFieldFilters;
  contentFiltersActive: boolean;
}

function assertSearchAssigneeFilter(assigneeFilter: Set<string> | undefined): void {
  // Match pm list: --assignee no longer accepts none/null (unassigned filtering
  // belongs to a dedicated flag there; pm search has no presence flag so reject
  // the sentinel values explicitly rather than silently matching a literal).
  if (
    assigneeFilter &&
    [...assigneeFilter].some(
      (value) => value.toLowerCase() === "none" || value.toLowerCase() === "null",
    )
  ) {
    throw new PmCliError(
      '--assignee no longer accepts "none" or "null".',
      EXIT_CODE.USAGE,
    );
  }
}

function resolveSearchMetadataFilterSet(
  options: SearchOptions,
  typeRegistry: ItemTypeRegistry,
  statusFilter: ItemStatus[] | undefined,
): SearchMetadataFilterSet {
  const assigneeFilter = parseStringFilterSet(options.assignee, {
    label: "--assignee",
  });
  assertSearchAssigneeFilter(assigneeFilter);
  const missingMetadataFilters = resolveMissingMetadataFilters(options);
  const contentFieldFilters = resolveContentFieldFilters(
    options as Record<string, unknown>,
  );
  return {
    typeFilter: parseTypeFilterSet(options.type, typeRegistry),
    tagFilter: parseStringFilterSet(options.tag, {
      label: "--tag",
      normalize: (tag) => tag.toLowerCase(),
    }),
    priorityFilter: parsePriorityFilterSet(options.priority),
    deadlineBefore: parseSearchDeadline(
      options.deadlineBefore,
      "deadline-before",
    ),
    deadlineAfter: parseSearchDeadline(options.deadlineAfter, "deadline-after"),
    updatedAfter: parseTimestampWindow(options.updatedAfter, "updated-after"),
    updatedBefore: parseTimestampWindow(
      options.updatedBefore,
      "updated-before",
    ),
    createdAfter: parseTimestampWindow(options.createdAfter, "created-after"),
    createdBefore: parseTimestampWindow(
      options.createdBefore,
      "created-before",
    ),
    assigneeFilter,
    sprintFilter: parseStringFilterSet(options.sprint, { label: "--sprint" }),
    releaseFilter: parseStringFilterSet(options.release, { label: "--release" }),
    parentFilter: options.parent?.trim(),
    statusSet:
      statusFilter && statusFilter.length > 0
        ? new Set<ItemStatus>(statusFilter)
        : undefined,
    missingMetadataFilters,
    missingMetadataActive: hasMissingMetadataFilter(missingMetadataFilters),
    contentFieldFilters,
    contentFiltersActive: hasContentFieldFilter(contentFieldFilters),
  };
}

function matchesScalarSearchFilters(
  item: ItemMetadata,
  filters: SearchMetadataFilterSet,
): boolean {
  return (
    matchesIdentitySearchFilters(item, filters) &&
    matchesTimestampFilters(item, filters) &&
    matchesOwnerSearchFilters(item, filters)
  );
}

function matchesIdentitySearchFilters(
  item: ItemMetadata,
  filters: SearchMetadataFilterSet,
): boolean {
  if (filters.statusSet && !filters.statusSet.has(item.status)) return false;
  if (filters.typeFilter && !filters.typeFilter.has(item.type)) return false;
  const tagFilter = filters.tagFilter;
  if (tagFilter && !stringArray(item.tags).some((tag) => tagFilter.has(tag)))
    return false;
  if (
    filters.priorityFilter !== undefined &&
    !filters.priorityFilter.has(item.priority)
  )
    return false;
  return true;
}


function matchesOwnerSearchFilters(
  item: ItemMetadata,
  filters: SearchMetadataFilterSet,
): boolean {
  if (
    filters.assigneeFilter !== undefined &&
    (item.assignee === undefined || !filters.assigneeFilter.has(item.assignee))
  )
    return false;
  if (
    filters.sprintFilter !== undefined &&
    (item.sprint === undefined || !filters.sprintFilter.has(item.sprint))
  )
    return false;
  /* c8 ignore start -- release/parent metadata filter combinations are covered by integration search fixtures */
  if (
    filters.releaseFilter !== undefined &&
    (item.release === undefined || !filters.releaseFilter.has(item.release))
  )
    return false;
  if (
    filters.parentFilter !== undefined &&
    item.parent !== filters.parentFilter
  )
    return false;
  /* c8 ignore stop */
  return true;
}

function matchesSearchMetadataFilters(
  document: ItemDocument,
  filters: SearchMetadataFilterSet,
  runtimeFieldFilters: Record<string, unknown>,
  lifecycleClassifier: LifecycleClassifier,
): boolean {
  const item = document.metadata;
  if (!matchesScalarSearchFilters(item, filters)) {
    return false;
  }
  if (
    !matchesRuntimeFilters(item as Record<string, unknown>, runtimeFieldFilters)
  ) {
    return false;
  }
  if (
    filters.missingMetadataActive &&
    !itemMatchesMissingMetadata(
      item,
      filters.missingMetadataFilters,
      lifecycleClassifier,
    )
  ) {
    return false;
  }
  if (
    filters.contentFiltersActive &&
    !itemMatchesContentFilters(item, filters.contentFieldFilters)
  ) {
    return false;
  }
  return true;
}

/** Apply metadata and runtime field predicates to the loaded item corpus. */
function applyFilters(
  items: ItemDocument[],
  options: SearchOptions,
  typeRegistry: ItemTypeRegistry,
  runtimeFieldFilters: Record<string, unknown>,
  statusFilter: ItemStatus[] | undefined,
  lifecycleClassifier: LifecycleClassifier,
): ItemDocument[] {
  const filters = resolveSearchMetadataFilterSet(
    options,
    typeRegistry,
    statusFilter,
  );
  return items.filter((document) =>
    matchesSearchMetadataFilters(
      document,
      filters,
      runtimeFieldFilters,
      lifecycleClassifier,
    ),
  );
}

export { applyExactQueryFilters,applyFilters,collectExactPhraseFields,dependencyEntries,documentContainsExactPhrase,stringArray,textEntries };
