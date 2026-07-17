/**
 * @module sdk/query/list
 *
 * Implements the pm list command surface and its agent-facing runtime behavior.
 */
import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { toItemRecord } from "../../core/item/item-record.js";
import { isTerminalStatus } from "../../core/item/status.js";
import { collectDependencyBlockedIds } from "../actionability.js";
import {
  isStatusAllFilterInput,
  parseStatusFilterCsv,
} from "../../core/item/status-filter.js";
import {
  resolveItemTypeRegistry,
  type ItemTypeRegistry,
} from "../../core/item/type-registry.js";
import { parseIntegerLimit, parsePriority, parseType } from "./parsers.js";
import {
  collectRuntimeFilterValues,
  matchesRuntimeFilters,
} from "../../core/schema/runtime-field-filters.js";
import {
  hasMissingMetadataFilter,
  itemMatchesMissingMetadata,
  lifecycleClassifierFromStatusRegistry,
  type MissingMetadataFilters,
} from "../../core/governance/metadata-coverage.js";
import {
  contentFiltersNeedBody,
  contentFiltersNeedCollections,
  hasContentFieldFilter,
  itemMatchesContentFilters,
  type ContentField,
  type ContentFieldFilters,
} from "../../core/governance/content-fields.js";
import {
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import {
  EXIT_CODE,
  ITEM_METADATA_KEY_ORDER,
} from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  compareTimestampStrings,
  matchesTimestampFilters,
  nowIso,
  resolveIsoOrRelative,
} from "../../core/shared/time.js";
import {
  listAllItemMetadata,
  listAllItemMetadataLight,
  listAllItemMetadataWithBody,
} from "../../core/store/item-store.js";
import { HEAVY_METADATA_KEYS } from "../../core/store/item-metadata-cache.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemMetadata, ItemStatus, ItemType } from "../../types/index.js";
import type { SharedItemFilterOptions } from "./item-filter-options.js";
import {
  createQueryFingerprint,
  encodeQueryCursor,
  resolveQueryCursorStart,
} from "../pagination.js";

/** Documents the list options payload exchanged by command, SDK, and package integrations. */
export interface ListOptions extends SharedItemFilterOptions {
  /** Value that configures or reports ids for this contract. */
  ids?: string;
  /** Value that configures or reports assignee filter for this contract. */
  assigneeFilter?: string;
  /** Value that configures or reports today for this contract. */
  today?: boolean;
  /** Value that configures or reports recent for this contract. */
  recent?: boolean;
  /** Value that configures or reports limit for this contract. */
  limit?: string;
  /** Value that configures or reports offset for this contract. */
  offset?: string;
  /** Opaque cursor returned by a previous list page. */
  after?: string;
  /** Force the complete matched set and deliberately override `limit`; use plain `limit` for bounded pagination. */
  noTruncate?: boolean;
  /** Value that configures or reports include body for this contract. */
  includeBody?: boolean;
  /** Value that configures or reports compact for this contract. */
  compact?: boolean;
  /** Value that configures or reports brief for this contract. */
  brief?: boolean;
  /** Value that configures or reports full for this contract. */
  full?: boolean;
  /** Value that configures or reports fields for this contract. */
  fields?: string;
  /** Value that configures or reports sort for this contract. */
  sort?: string;
  /** Value that configures or reports order for this contract. */
  order?: string;
  /** Value that configures or reports tree for this contract. */
  tree?: boolean;
  /** Value that configures or reports tree depth for this contract. */
  treeDepth?: string;
  /** Value that configures or reports exclude terminal for this contract. */
  excludeTerminal?: boolean;
  /**
   * Select items that are blocked under the shared edge-aware definition
   * (blocked lifecycle status OR at least one open `blocked_by` edge), the
   * same classification `pm next` and `pm context` use (GH-578). Set by the
   * `list-blocked` command variant; plain `--status blocked` stays a raw
   * lifecycle-status filter.
   */
  dependencyBlocked?: boolean;
  /** Value that configures or reports filter ac missing for this contract. */
  filterAcMissing?: boolean;
  /** Value that configures or reports filter estimates missing for this contract. */
  filterEstimatesMissing?: boolean;
  /** Value that configures or reports filter resolution missing for this contract. */
  filterResolutionMissing?: boolean;
  /** Value that configures or reports filter metadata missing for this contract. */
  filterMetadataMissing?: boolean;
}

/** Extract the missing-metadata selection filters from list/update-many options. */
export const resolveMissingMetadataFilters = (options: {
  filterAcMissing?: boolean;
  filterEstimatesMissing?: boolean;
  filterResolutionMissing?: boolean;
  filterMetadataMissing?: boolean;
  filterReviewerMissing?: boolean;
  filterRiskMissing?: boolean;
  filterConfidenceMissing?: boolean;
  filterSprintMissing?: boolean;
  filterReleaseMissing?: boolean;
}): MissingMetadataFilters => {
  return {
    acMissing: options.filterAcMissing === true,
    estimatesMissing: options.filterEstimatesMissing === true,
    resolutionMissing: options.filterResolutionMissing === true,
    metadataMissing: options.filterMetadataMissing === true,
    reviewerMissing: options.filterReviewerMissing === true,
    riskMissing: options.filterRiskMissing === true,
    confidenceMissing: options.filterConfidenceMissing === true,
    sprintMissing: options.filterSprintMissing === true,
    releaseMissing: options.filterReleaseMissing === true,
  };
};

/** Per content field: the present flag and the absence flag on the options shape. */
interface ContentFieldFlagMapping {
  field: ContentField;
  presentKey: string;
  absentKey: string;
  /** Human flag names used in the conflict error message. */
  presentFlag: string;
  absentFlag: string;
}

const CONTENT_FIELD_FLAG_MAPPINGS: readonly ContentFieldFlagMapping[] = [
  {
    field: "notes",
    presentKey: "hasNotes",
    absentKey: "noNotes",
    presentFlag: "--has-notes",
    absentFlag: "--no-notes",
  },
  {
    field: "learnings",
    presentKey: "hasLearnings",
    absentKey: "noLearnings",
    presentFlag: "--has-learnings",
    absentFlag: "--no-learnings",
  },
  {
    field: "files",
    presentKey: "hasFiles",
    absentKey: "noFiles",
    presentFlag: "--has-files",
    absentFlag: "--no-files",
  },
  {
    field: "docs",
    presentKey: "hasDocs",
    absentKey: "noDocs",
    presentFlag: "--has-docs",
    absentFlag: "--no-docs",
  },
  {
    field: "tests",
    presentKey: "hasTests",
    absentKey: "noTests",
    presentFlag: "--has-tests",
    absentFlag: "--no-tests",
  },
  {
    field: "comments",
    presentKey: "hasComments",
    absentKey: "noComments",
    presentFlag: "--has-comments",
    absentFlag: "--no-comments",
  },
  {
    field: "deps",
    presentKey: "hasDeps",
    absentKey: "noDeps",
    presentFlag: "--has-deps",
    absentFlag: "--no-deps",
  },
  {
    field: "body",
    presentKey: "hasBody",
    absentKey: "emptyBody",
    presentFlag: "--has-body",
    absentFlag: "--empty-body",
  },
  {
    field: "linked_command",
    presentKey: "hasLinkedCommand",
    absentKey: "noLinkedCommand",
    presentFlag: "--has-linked-command",
    absentFlag: "--no-linked-command",
  },
] as const;

/** Resolve the content-field presence/absence selections from list/search options. A field requested both present AND absent is a usage error (the two selections are mutually exclusive). Returns an empty object when no content-field filter is active. */
export const resolveContentFieldFilters = (
  options: Record<string, unknown>,
): ContentFieldFilters => {
  const conflict = CONTENT_FIELD_FLAG_MAPPINGS.find(
    (mapping) =>
      options[mapping.presentKey] === true &&
      options[mapping.absentKey] === true,
  );
  if (conflict) {
    throw new PmCliError(
      `Cannot combine ${conflict.presentFlag} with ${conflict.absentFlag} for the same field.`,
      EXIT_CODE.USAGE,
    );
  }
  return Object.fromEntries(
    CONTENT_FIELD_FLAG_MAPPINGS.flatMap<[
      ContentField,
      "present" | "absent",
    ]>((mapping) => {
      if (options[mapping.presentKey] === true) {
        return [[mapping.field, "present"]];
      }
      return options[mapping.absentKey] === true
        ? [[mapping.field, "absent"]]
        : [];
    }),
  ) as ContentFieldFilters;
};

/** Restricts listed item values accepted by command, SDK, and storage contracts. */
export type ListedItem = ItemMetadata | (ItemMetadata & { body: string });

/** Tree-only metadata added when list results are ordered hierarchically. */
export interface ListTreeMetadata {
  /** Zero-based depth relative to the selected tree root. */
  tree_depth: number;
  /** Parent item ID, or null for a root row. */
  tree_parent: string | null;
  /** Number of direct children represented by the row. */
  tree_children: number;
  /** Indented display title for token-efficient tree rendering. */
  tree_title: string;
}

/** Full metadata enriched with tree-only fields. */
export type ListTreeItem = ListedItem & ListTreeMetadata;

/** A compact or explicitly selected field projection. */
export type ListProjectedItem = Record<string, unknown>;

/** Honest union of item shapes returned by the list engine. */
export type ListResultItem = ListedItem | ListTreeItem | ListProjectedItem;

type ListProjectionMode = "full" | "compact" | "fields";

interface ListProjectionConfig {
  mode: ListProjectionMode;
  fields: string[];
}

/** Public contract for list sort fields, shared by SDK and presentation-layer consumers. */
export const LIST_SORT_FIELDS = [
  "priority",
  "deadline",
  "updated_at",
  "created_at",
  "title",
  "parent",
] as const;
/** Restricts list sort field values accepted by command, SDK, and storage contracts. */
export type ListSortField = (typeof LIST_SORT_FIELDS)[number];

/** Supported values accepted by the list sort order contract. */
export const LIST_SORT_ORDER_VALUES = ["asc", "desc"] as const;
/** Restricts list sort order values accepted by command, SDK, and storage contracts. */
export type ListSortOrder = (typeof LIST_SORT_ORDER_VALUES)[number];

const DEFAULT_COMPACT_LIST_FIELDS = [
  "id",
  "title",
  "status",
  "type",
  "priority",
  "parent",
  "updated_at",
] as const;
const BRIEF_LIST_FIELDS = ["id", "status", "type", "title"] as const;
const TREE_METADATA_FIELDS = [
  "tree_depth",
  "tree_parent",
  "tree_children",
  "tree_title",
] as const;

// A projection that selects any heavy collection field (or `--full`, which returns
// items verbatim) must load the full metadata; everything else takes the light path.
// Sourced from the single HEAVY_METADATA_KEYS definition in the cache layer so the
// light/heavy split can never drift between the cache and the projection routing.
const HEAVY_PROJECTION_FIELDS: ReadonlySet<string> = new Set<string>(
  HEAVY_METADATA_KEYS,
);

interface ListResultBase {
  items: ListResultItem[];
  count: number;
  // Total rows matched before pagination; only emitted when --limit/--offset
  // omitted rows, so agents know how many remain (GH-154).
  total?: number;
  /** Whether additional rows remain after this page. */
  has_more?: boolean;
  /** Opaque continuation cursor when additional rows remain. */
  next_cursor?: string;
  /** Effective page size, including an automatic at-scale bound. */
  applied_limit?: number;
  /** Explicit marker that the response is a bounded page. */
  truncated?: true;
  warnings?: string[];
}

/** Documents the list compact result payload exchanged by command, SDK, and package integrations. */
export interface ListCompactResult extends ListResultBase {
  /** Value that configures or reports filters for this contract. */
  filters: Record<string, unknown>;
  /** Value that configures or reports projection for this contract. */
  projection?: undefined;
  /** Value that configures or reports sorting for this contract. */
  sorting?: undefined;
  /** Value that configures or reports now for this contract. */
  now?: undefined;
}

/** Documents the list verbose result payload exchanged by command, SDK, and package integrations. */
export interface ListVerboseResult extends ListResultBase {
  /** Value that configures or reports filters for this contract. */
  filters: Record<string, unknown>;
  /** Value that configures or reports projection for this contract. */
  projection: {
    mode: ListProjectionMode;
    fields: string[] | null;
  };
  /** Value that configures or reports sorting for this contract. */
  sorting: {
    sort: ListSortField | "default";
    order: ListSortOrder;
  };
  /** Value that configures or reports now for this contract. */
  now: string;
}

/** Verbose full-record result returned when `full: true` is requested. */
export interface ListFullResult extends ListVerboseResult {
  /** Full metadata rows, optionally enriched with tree metadata. */
  items: Array<ListedItem | ListTreeItem>;
  /** Discriminator proving that rows are complete metadata records. */
  projection: {
    mode: "full";
    fields: null;
  };
}

/** Restricts list result values accepted by command, SDK, and storage contracts. */
export type ListResult = ListCompactResult | ListVerboseResult;

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

// Active content-field filter flags, keyed by the options dest and the snake_case
// summary key emitted in the filters echo (GH-242). Presence and absence are
// distinct echo keys (has_notes vs no_notes; has_body vs empty_body).
const CONTENT_FILTER_ECHO_ENTRIES: ReadonlyArray<{
  key: string;
  summaryKey: string;
}> = [
  { key: "hasNotes", summaryKey: "has_notes" },
  { key: "hasLearnings", summaryKey: "has_learnings" },
  { key: "hasFiles", summaryKey: "has_files" },
  { key: "hasDocs", summaryKey: "has_docs" },
  { key: "hasTests", summaryKey: "has_tests" },
  { key: "hasComments", summaryKey: "has_comments" },
  { key: "hasDeps", summaryKey: "has_deps" },
  { key: "hasBody", summaryKey: "has_body" },
  { key: "hasLinkedCommand", summaryKey: "has_linked_command" },
  { key: "noNotes", summaryKey: "no_notes" },
  { key: "noLearnings", summaryKey: "no_learnings" },
  { key: "noFiles", summaryKey: "no_files" },
  { key: "noDocs", summaryKey: "no_docs" },
  { key: "noTests", summaryKey: "no_tests" },
  { key: "noComments", summaryKey: "no_comments" },
  { key: "noDeps", summaryKey: "no_deps" },
  { key: "emptyBody", summaryKey: "empty_body" },
  { key: "noLinkedCommand", summaryKey: "no_linked_command" },
] as const;

// Active governance-missing filter flags (GH-236), keyed by options dest and the
// snake_case summary key emitted in the filters echo.
const GOVERNANCE_MISSING_ECHO_ENTRIES: ReadonlyArray<{
  key: string;
  summaryKey: string;
}> = [
  { key: "filterReviewerMissing", summaryKey: "filter_reviewer_missing" },
  { key: "filterRiskMissing", summaryKey: "filter_risk_missing" },
  { key: "filterConfidenceMissing", summaryKey: "filter_confidence_missing" },
  { key: "filterSprintMissing", summaryKey: "filter_sprint_missing" },
  { key: "filterReleaseMissing", summaryKey: "filter_release_missing" },
] as const;

function applyContentFilterEcho(
  filters: Record<string, unknown>,
  options: Record<string, unknown>,
): void {
  for (const entry of CONTENT_FILTER_ECHO_ENTRIES) {
    if (options[entry.key] === true) {
      filters[entry.summaryKey] = true;
    }
  }
}

function applyGovernanceMissingFilterEcho(
  filters: Record<string, unknown>,
  options: Record<string, unknown>,
): void {
  for (const entry of GOVERNANCE_MISSING_ECHO_ENTRIES) {
    if (options[entry.key] === true) {
      filters[entry.summaryKey] = true;
    }
  }
}

interface FilterValueEchoEntry {
  optionKey: string;
  summaryKey: string;
  normalize?: (value: unknown) => unknown;
}

/**
 * Copies user-supplied option values into compact filter summaries.
 *
 * Compact list/search responses are optimized for agent context: they echo only
 * filters the caller actually supplied. Keeping this helper shared prevents the
 * list and search command summaries from drifting as new scalar filters are
 * added.
 */
export function applyFilterValueEcho(
  filters: Record<string, unknown>,
  options: Record<string, unknown>,
  entries: ReadonlyArray<FilterValueEchoEntry>,
): void {
  for (const entry of entries) {
    const value = options[entry.optionKey];
    if (value !== undefined) {
      filters[entry.summaryKey] = entry.normalize
        ? entry.normalize(value)
        : value;
    }
  }
}

/** Implements build content filter echo for the public runtime surface of this module. */
export function buildContentFilterEcho(
  options: Record<string, unknown>,
): Record<string, true> {
  const echo: Record<string, true> = {};
  applyContentFilterEcho(echo, options);
  return echo;
}

/** Implements build governance missing filter echo for the public runtime surface of this module. */
export function buildGovernanceMissingFilterEcho(
  options: Record<string, unknown>,
): Record<string, true> {
  const echo: Record<string, true> = {};
  applyGovernanceMissingFilterEcho(echo, options);
  return echo;
}

const COMPACT_LIST_VALUE_FILTER_ECHO_ENTRIES: ReadonlyArray<FilterValueEchoEntry> =
  [
    { optionKey: "type", summaryKey: "type" },
    { optionKey: "tag", summaryKey: "tag" },
    { optionKey: "priority", summaryKey: "priority" },
    { optionKey: "deadlineBefore", summaryKey: "deadline_before" },
    { optionKey: "deadlineAfter", summaryKey: "deadline_after" },
    { optionKey: "updatedAfter", summaryKey: "updated_after" },
    { optionKey: "updatedBefore", summaryKey: "updated_before" },
    { optionKey: "createdAfter", summaryKey: "created_after" },
    { optionKey: "createdBefore", summaryKey: "created_before" },
    { optionKey: "ids", summaryKey: "ids" },
    { optionKey: "assignee", summaryKey: "assignee" },
    { optionKey: "assigneeFilter", summaryKey: "assignee_filter" },
    { optionKey: "parent", summaryKey: "parent" },
    { optionKey: "sprint", summaryKey: "sprint" },
    { optionKey: "release", summaryKey: "release" },
  ] as const;

const VERBOSE_LIST_VALUE_FILTER_ECHO_ENTRIES: ReadonlyArray<FilterValueEchoEntry> =
  [
    { optionKey: "type", summaryKey: "type" },
    { optionKey: "tag", summaryKey: "tag" },
    { optionKey: "priority", summaryKey: "priority" },
    { optionKey: "deadlineBefore", summaryKey: "deadline_before" },
    { optionKey: "deadlineAfter", summaryKey: "deadline_after" },
    { optionKey: "updatedAfter", summaryKey: "updated_after" },
    { optionKey: "updatedBefore", summaryKey: "updated_before" },
    { optionKey: "createdAfter", summaryKey: "created_after" },
    { optionKey: "createdBefore", summaryKey: "created_before" },
    { optionKey: "ids", summaryKey: "ids" },
    { optionKey: "assignee", summaryKey: "assignee" },
    { optionKey: "assigneeFilter", summaryKey: "assignee_filter" },
    { optionKey: "parent", summaryKey: "parent" },
    { optionKey: "sprint", summaryKey: "sprint" },
    { optionKey: "release", summaryKey: "release" },
    { optionKey: "limit", summaryKey: "limit" },
    { optionKey: "offset", summaryKey: "offset" },
    { optionKey: "includeBody", summaryKey: "include_body" },
    { optionKey: "compact", summaryKey: "compact" },
    { optionKey: "fields", summaryKey: "fields" },
  ] as const;

const VERBOSE_LIST_BOOLEAN_FILTER_ECHO_ENTRIES: ReadonlyArray<{
  key: string;
  summaryKey: string;
}> = [
  { key: "filterAcMissing", summaryKey: "filter_ac_missing" },
  { key: "filterEstimatesMissing", summaryKey: "filter_estimates_missing" },
  { key: "filterResolutionMissing", summaryKey: "filter_resolution_missing" },
  { key: "filterMetadataMissing", summaryKey: "filter_metadata_missing" },
] as const;

const LIST_RECENT_WINDOW = "-7d";

function buildCompactListFilterSummary(params: {
  filtersStatus: string | string[] | null;
  options: ListOptions;
  treeEnabled: boolean;
  treeDepth: number | undefined;
  sortField: ListSortField | undefined;
  sortOrder: ListSortOrder;
  runtimeFieldFilters: Record<string, unknown>;
}): Record<string, unknown> {
  const {
    filtersStatus,
    options,
    treeEnabled,
    treeDepth,
    sortField,
    sortOrder,
    runtimeFieldFilters,
  } = params;
  const filters: Record<string, unknown> = {};
  if (filtersStatus !== null) {
    filters.status = filtersStatus;
  }
  if (options.dependencyBlocked === true) {
    filters.blocked_semantics = "status_or_dependency";
  }
  applyFilterValueEcho(
    filters,
    options,
    COMPACT_LIST_VALUE_FILTER_ECHO_ENTRIES,
  );
  applyListWindowFilterEcho(filters, options);
  if (options.filterAcMissing === true) {
    filters.filter_ac_missing = true;
  }
  if (options.filterEstimatesMissing === true) {
    filters.filter_estimates_missing = true;
  }
  if (options.filterResolutionMissing === true) {
    filters.filter_resolution_missing = true;
  }
  if (options.filterMetadataMissing === true) {
    filters.filter_metadata_missing = true;
  }
  applyGovernanceMissingFilterEcho(filters, options);
  applyContentFilterEcho(filters, options);
  if (options.limit !== undefined) {
    filters.limit = options.limit;
  }
  if (options.offset !== undefined) {
    filters.offset = options.offset;
  }
  if (options.includeBody === true) {
    filters.include_body = true;
  }
  if (options.fields !== undefined) {
    filters.fields = options.fields;
  }
  if (treeEnabled) {
    filters.tree = true;
    if (treeDepth !== undefined) {
      filters.tree_depth = treeDepth;
    }
  }
  if (sortField !== undefined) {
    filters.sort = sortField;
    filters.order = sortOrder;
  }
  if (isNonEmptyRecord(runtimeFieldFilters)) {
    filters.runtime_filters = runtimeFieldFilters;
  }
  return filters;
}

function compareDefaultSort(
  left: ListedItem,
  right: ListedItem,
  statusRegistry: RuntimeStatusRegistry,
): number {
  const leftTerminal = isTerminalStatus(left.status, statusRegistry);
  const rightTerminal = isTerminalStatus(right.status, statusRegistry);
  if (leftTerminal !== rightTerminal) {
    return leftTerminal ? 1 : -1;
  }
  const byPriority = left.priority - right.priority;
  if (byPriority !== 0) {
    return byPriority;
  }
  const byUpdated = compareTimestampStrings(right.updated_at, left.updated_at);
  if (byUpdated !== 0) {
    return byUpdated;
  }
  return (left.id ?? "").localeCompare(right.id ?? "");
}

function sortItemsDefault(
  items: ListedItem[],
  statusRegistry: RuntimeStatusRegistry,
): ListedItem[] {
  return [...items].sort((left, right) =>
    compareDefaultSort(left, right, statusRegistry),
  );
}

function parseDeadline(
  raw: string | undefined,
  fieldLabel: string,
): string | undefined {
  if (raw === undefined) return undefined;
  return resolveIsoOrRelative(raw, new Date(), fieldLabel);
}

// updated/created date-window filters share the deadline ISO+relative resolver
// so agents doing incremental "what changed since my last context window" syncs
// can pass either an ISO timestamp (the common case — feed back the previous
// run's `now`) or a SIGNED relative offset where "-2h"/"-7d" reach into the
// past and "+1d" into the future (units h/d/w/m, m = months — there is no
// minutes unit, matching the deadline resolver).
function parseTimestampWindow(
  raw: unknown,
  fieldLabel: string,
): string | undefined {
  if (raw == null) return undefined;
  const value = String(raw).trim();
  if (value.length === 0) return undefined;
  return resolveIsoOrRelative(value, new Date(), fieldLabel);
}

function resolveListUpdatedAfter(options: ListOptions): string | undefined {
  const hasUpdatedAfter =
    options.updatedAfter != null &&
    String(options.updatedAfter).trim().length > 0;
  const selectedWindows = [
    options.today === true,
    options.recent === true,
    hasUpdatedAfter,
  ].filter((selected) => selected).length;
  if (selectedWindows > 1) {
    throw new PmCliError(
      "Choose only one updated_at window: --today, --recent, or --updated-after.",
      EXIT_CODE.USAGE,
    );
  }
  if (options.today === true) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today.toISOString();
  }
  if (options.recent === true) {
    return parseTimestampWindow(LIST_RECENT_WINDOW, "recent");
  }
  return parseTimestampWindow(options.updatedAfter, "updated-after");
}

function applyListWindowFilterEcho(
  filters: Record<string, unknown>,
  options: ListOptions,
): void {
  if (options.today === true) {
    filters.today = true;
  }
  if (options.recent === true) {
    filters.recent = true;
  }
}

function parseIdsFilter(raw: unknown): Set<string> | undefined {
  if (raw == null) return undefined;
  const value = String(raw).trim();
  if (value.length === 0) {
    throw new PmCliError(
      "--ids requires at least one non-empty item ID",
      EXIT_CODE.USAGE,
    );
  }
  const ids = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (ids.length === 0) {
    throw new PmCliError(
      "--ids requires at least one non-empty item ID",
      EXIT_CODE.USAGE,
    );
  }
  return new Set(ids);
}

function parseOffset(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const normalized = String(raw).trim();
  const parsed = normalized.length === 0 ? Number.NaN : Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PmCliError(
      "Offset filter must be a non-negative integer",
      EXIT_CODE.USAGE,
    );
  }
  return parsed;
}

function parseFieldSelectors(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const selectors = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (selectors.length === 0) {
    throw new PmCliError(
      "List --fields requires a comma-separated list of field names",
      EXIT_CODE.USAGE,
    );
  }
  return [...new Set(selectors)];
}

function parseProjectionConfig(options: ListOptions): ListProjectionConfig {
  const compactRequested = options.compact === true;
  const briefRequested = options.brief === true;
  const fullRequested = options.full === true;
  const fieldSelectors = parseFieldSelectors(options.fields);
  const enabledModes =
    Number(compactRequested) +
    Number(briefRequested) +
    Number(fullRequested) +
    Number(fieldSelectors !== undefined);
  if (enabledModes > 1) {
    throw new PmCliError(
      "List projection options are mutually exclusive. Use one of --compact, --brief, --full, or --fields.",
      EXIT_CODE.USAGE,
    );
  }
  if (fullRequested) {
    return {
      mode: "full",
      fields: [],
    };
  }
  if (briefRequested) {
    return {
      mode: "compact",
      fields: [...BRIEF_LIST_FIELDS],
    };
  }
  if (compactRequested) {
    return {
      mode: "compact",
      fields: [...DEFAULT_COMPACT_LIST_FIELDS],
    };
  }
  if (fieldSelectors) {
    return {
      mode: "fields",
      fields: fieldSelectors,
    };
  }
  return {
    mode: "full",
    fields: [],
  };
}

function normalizeProjectionField(field: string): string {
  return field.startsWith("item.") ? field.slice("item.".length) : field;
}

function validateListProjectionFields(
  projection: ListProjectionConfig,
  runtimeMetadataKeys: Iterable<string>,
): void {
  if (projection.mode !== "fields") {
    return;
  }
  const allowed = new Set([
    ...ITEM_METADATA_KEY_ORDER,
    "body",
    ...TREE_METADATA_FIELDS,
    ...runtimeMetadataKeys,
  ]);
  const unknown = projection.fields.filter(
    (field) => !allowed.has(normalizeProjectionField(field)),
  );
  if (unknown.length > 0) {
    throw new PmCliError(
      `Unknown list --fields value(s): ${unknown.join(", ")}`,
      EXIT_CODE.USAGE,
      {
        code: "unknown_field_projection",
        examples: [
          "pm list-open --fields id,title,status,type,updated_at",
          "pm list --fields id,title,parent,priority --limit 10",
          "pm list-all --fields id,title,body --limit 5",
        ],
      },
    );
  }
}

// Convenience aliases so agents/humans who reach for the bare verb form
// (e.g. `--sort updated`) land on the canonical timestamp fields instead of an error.
// A Map (not a plain object) avoids prototype-chain lookups for keys like "__proto__".
const LIST_SORT_FIELD_ALIASES: ReadonlyMap<string, ListSortField> = new Map<
  string,
  ListSortField
>([
  ["updated", "updated_at"],
  ["update", "updated_at"],
  ["modified", "updated_at"],
  ["created", "created_at"],
  ["create", "created_at"],
]);

function parseSortField(raw: string | undefined): ListSortField | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  const aliased = LIST_SORT_FIELD_ALIASES.get(normalized);
  if (aliased) {
    return aliased;
  }
  if (!LIST_SORT_FIELDS.includes(normalized as ListSortField)) {
    throw new PmCliError(
      `Sort field must be one of ${LIST_SORT_FIELDS.join("|")} (aliases: updated->updated_at, created->created_at)`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized as ListSortField;
}

function parseSortOrder(raw: string | undefined): ListSortOrder | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (!LIST_SORT_ORDER_VALUES.includes(normalized as ListSortOrder)) {
    throw new PmCliError(
      `Sort order must be one of ${LIST_SORT_ORDER_VALUES.join("|")}`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized as ListSortOrder;
}

function parseTreeDepth(raw: string | undefined): number | undefined {
  return parseIntegerLimit(raw, "--tree-depth");
}

function parseAssigneeFilter(
  raw: string | undefined,
): "assigned" | "unassigned" | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    throw new PmCliError(
      "Assignee filter must be one of assigned|unassigned",
      EXIT_CODE.USAGE,
    );
  }
  if (normalized !== "assigned" && normalized !== "unassigned") {
    throw new PmCliError(
      `Invalid assignee filter "${raw}". Allowed: assigned|unassigned`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized;
}

// Resolve built-in, runtime, and workflow-group aliases through the shared
// registry, rejecting typos instead of returning a misleading empty result.
function resolveStatusFilter(
  status: ItemStatus | undefined,
  statusRegistry: RuntimeStatusRegistry,
): ItemStatus[] | undefined {
  return parseStatusFilterCsv(status, statusRegistry, { strict: true });
}

interface ListFilterSet {
  idsFilter: Set<string> | undefined;
  statusSet: Set<ItemStatus> | undefined;
  excludeTerminal: boolean;
  typeFilter: ItemType | undefined;
  tagFilter: string | undefined;
  priorityFilter: number | undefined;
  deadlineBefore: string | undefined;
  deadlineAfter: string | undefined;
  updatedAfter: string | undefined;
  updatedBefore: string | undefined;
  createdAfter: string | undefined;
  createdBefore: string | undefined;
  assigneeFilter: string | undefined;
  assigneeModeFilter: "assigned" | "unassigned" | undefined;
  parentFilter: string | undefined;
  treeEnabled: boolean;
  sprintFilter: string | undefined;
  releaseFilter: string | undefined;
  missingMetadataFilters: MissingMetadataFilters;
  missingMetadataActive: boolean;
  lifecycleClassifier: ReturnType<typeof lifecycleClassifierFromStatusRegistry>;
  contentFieldFilters: ContentFieldFilters;
  contentFiltersActive: boolean;
}

function assertListAssigneeFilters(
  assigneeFilter: string | undefined,
  assigneeModeFilter: "assigned" | "unassigned" | undefined,
): void {
  if (
    assigneeFilter &&
    (assigneeFilter.toLowerCase() === "none" ||
      assigneeFilter.toLowerCase() === "null")
  ) {
    throw new PmCliError(
      '--assignee no longer accepts "none" or "null". Use --assignee-filter unassigned.',
      EXIT_CODE.USAGE,
    );
  }
  if (assigneeFilter !== undefined && assigneeModeFilter === "unassigned") {
    throw new PmCliError(
      "Cannot combine --assignee with --assignee-filter unassigned",
      EXIT_CODE.USAGE,
    );
  }
}

function resolveListFilterSet(
  status: ItemStatus[] | undefined,
  options: ListOptions,
  typeRegistry: ItemTypeRegistry,
  statusRegistry: RuntimeStatusRegistry,
): ListFilterSet {
  const assigneeFilter = options.assignee?.trim();
  const assigneeModeFilter = parseAssigneeFilter(options.assigneeFilter);
  assertListAssigneeFilters(assigneeFilter, assigneeModeFilter);
  const missingMetadataFilters = resolveMissingMetadataFilters(options);
  const contentFieldFilters = resolveContentFieldFilters(
    options as Record<string, unknown>,
  );
  return {
    idsFilter: parseIdsFilter(options.ids),
    statusSet:
      status && status.length > 0 ? new Set<ItemStatus>(status) : undefined,
    excludeTerminal: options.excludeTerminal === true,
    typeFilter: parseType(options.type, typeRegistry),
    tagFilter: options.tag?.trim().toLowerCase(),
    priorityFilter: parsePriority(options.priority),
    deadlineBefore: parseDeadline(options.deadlineBefore, "deadline-before"),
    deadlineAfter: parseDeadline(options.deadlineAfter, "deadline-after"),
    updatedAfter: resolveListUpdatedAfter(options),
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
    assigneeModeFilter,
    parentFilter: options.parent?.trim(),
    treeEnabled: options.tree === true,
    sprintFilter: options.sprint?.trim(),
    releaseFilter: options.release?.trim(),
    missingMetadataFilters,
    missingMetadataActive: hasMissingMetadataFilter(missingMetadataFilters),
    lifecycleClassifier: lifecycleClassifierFromStatusRegistry(statusRegistry),
    contentFieldFilters,
    contentFiltersActive: hasContentFieldFilter(contentFieldFilters),
  };
}

function matchesListScalarFilters(
  item: ListedItem,
  filters: ListFilterSet,
  statusRegistry: RuntimeStatusRegistry,
): boolean {
  return (
    matchesListIdentityFilters(item, filters, statusRegistry) &&
    matchesListDateFilters(item, filters) &&
    matchesListAssigneeFilterSet(item, filters) &&
    matchesListScopeFilters(item, filters)
  );
}

function matchesListIdentityFilters(
  item: ListedItem,
  filters: ListFilterSet,
  statusRegistry: RuntimeStatusRegistry,
): boolean {
  if (filters.idsFilter && !filters.idsFilter.has(item.id)) return false;
  if (filters.statusSet && !filters.statusSet.has(item.status)) return false;
  if (filters.excludeTerminal && isTerminalStatus(item.status, statusRegistry))
    return false;
  if (filters.typeFilter && item.type !== filters.typeFilter) return false;
  if (filters.tagFilter && !(item.tags ?? []).includes(filters.tagFilter))
    return false;
  return (
    filters.priorityFilter === undefined ||
    item.priority === filters.priorityFilter
  );
}

function matchesListDateFilters(
  item: ListedItem,
  filters: ListFilterSet,
): boolean {
  return matchesTimestampFilters(item, filters);
}

function matchesListAssigneeFilterSet(
  item: ListedItem,
  filters: ListFilterSet,
): boolean {
  if (filters.assigneeModeFilter === "assigned" && !item.assignee) return false;
  if (filters.assigneeModeFilter === "unassigned" && item.assignee)
    return false;
  return (
    filters.assigneeFilter === undefined ||
    item.assignee === filters.assigneeFilter
  );
}

function matchesListScopeFilters(
  item: ListedItem,
  filters: ListFilterSet,
): boolean {
  if (
    filters.parentFilter !== undefined &&
    !filters.treeEnabled &&
    item.parent !== filters.parentFilter
  )
    return false;
  if (
    filters.sprintFilter !== undefined &&
    item.sprint !== filters.sprintFilter
  )
    return false;
  return (
    filters.releaseFilter === undefined ||
    item.release === filters.releaseFilter
  );
}

function matchesListFilterSet(
  item: ListedItem,
  filters: ListFilterSet,
  statusRegistry: RuntimeStatusRegistry,
  runtimeFieldFilters: Record<string, unknown>,
): boolean {
  if (!matchesListScalarFilters(item, filters, statusRegistry)) {
    return false;
  }
  if (
    filters.missingMetadataActive &&
    !itemMatchesMissingMetadata(
      item,
      filters.missingMetadataFilters,
      filters.lifecycleClassifier,
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
  if (
    !matchesRuntimeFilters(item as Record<string, unknown>, runtimeFieldFilters)
  ) {
    return false;
  }
  return true;
}

function applyFilters(
  items: ListedItem[],
  status: ItemStatus[] | undefined,
  options: ListOptions,
  typeRegistry: ItemTypeRegistry,
  statusRegistry: RuntimeStatusRegistry,
  runtimeFieldFilters: Record<string, unknown>,
): ListedItem[] {
  const filters = resolveListFilterSet(
    status,
    options,
    typeRegistry,
    statusRegistry,
  );
  return items.filter((item) =>
    matchesListFilterSet(item, filters, statusRegistry, runtimeFieldFilters),
  );
}

function trimNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function withTreeMetadata(
  item: ListedItem,
  depth: number,
  childCount: number,
): ListTreeItem {
  const itemRecord = toItemRecord(item);
  const title = typeof itemRecord.title === "string" ? itemRecord.title : "";
  const parent =
    trimNonEmpty(
      typeof itemRecord.parent === "string" ? itemRecord.parent : undefined,
    ) ?? null;
  return {
    ...item,
    tree_depth: depth,
    tree_parent: parent,
    tree_children: childCount,
    tree_title: `${"  ".repeat(depth)}${title}`,
  };
}

function orderItemsAsTree(
  sortedItems: ListedItem[],
  parentRoot: string | undefined,
  maxDepth: number | undefined,
): ListedItem[] {
  const byId = new Map<string, ListedItem>();
  const childrenByParent = new Map<string, ListedItem[]>();
  for (const item of sortedItems) {
    byId.set(item.id, item);
    const parentId = trimNonEmpty(item.parent);
    if (!parentId) {
      continue;
    }
    const bucket = childrenByParent.get(parentId);
    if (bucket) {
      bucket.push(item);
    } else {
      childrenByParent.set(parentId, [item]);
    }
  }

  const roots = parentRoot
    ? [...(childrenByParent.get(parentRoot) ?? [])]
    : sortedItems.filter((item) => {
        const parentId = trimNonEmpty(item.parent);
        return !parentId || !byId.has(parentId);
      });
  const ordered: ListedItem[] = [];
  const visited = new Set<string>();
  const pushNode = (node: ListedItem, depth: number): void => {
    if (visited.has(node.id)) {
      return;
    }
    visited.add(node.id);
    const children = childrenByParent.get(node.id) ?? [];
    ordered.push(withTreeMetadata(node, depth, children.length));
    if (maxDepth !== undefined && depth >= maxDepth) {
      return;
    }
    for (const child of children) {
      pushNode(child, depth + 1);
    }
  };
  for (const root of roots) {
    pushNode(root, 0);
  }
  return ordered;
}

function compareNullableString(
  left: string | null,
  right: string | null,
): number {
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

function compareNullableTimestamp(
  left: string | null,
  right: string | null,
): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return compareTimestampStrings(left, right);
}

function compareBySortField(
  left: ListedItem,
  right: ListedItem,
  field: ListSortField,
): number {
  switch (field) {
    case "priority":
      return left.priority - right.priority;
    case "deadline":
      return compareNullableTimestamp(
        left.deadline ?? null,
        right.deadline ?? null,
      );
    case "updated_at":
      return compareTimestampStrings(left.updated_at, right.updated_at);
    case "created_at":
      return compareTimestampStrings(left.created_at, right.created_at);
    case "title":
      return (left.title ?? "").localeCompare(right.title ?? "");
    case "parent":
      return compareNullableString(left.parent ?? null, right.parent ?? null);
    default:
      return 0;
  }
}

function sortItems(
  items: ListedItem[],
  sortField: ListSortField | undefined,
  sortOrder: ListSortOrder,
  statusRegistry: RuntimeStatusRegistry,
): ListedItem[] {
  if (!sortField) {
    return sortItemsDefault(items, statusRegistry);
  }
  return [...items].sort((left, right) => {
    const byField = compareBySortField(left, right, sortField);
    if (byField !== 0) {
      return sortOrder === "desc" ? -byField : byField;
    }
    const fallback = compareDefaultSort(left, right, statusRegistry);
    return sortOrder === "desc" ? -fallback : fallback;
  });
}

function readListFieldValue(
  item: ListedItem,
  field: string,
  treeMode = false,
): unknown {
  const normalized = normalizeProjectionField(field.trim());
  if (normalized.length === 0) {
    return null;
  }
  const itemRecord = toItemRecord(item);
  if (
    treeMode &&
    normalized === "title" &&
    typeof itemRecord.tree_title === "string"
  ) {
    return itemRecord.tree_title;
  }
  if (Object.prototype.hasOwnProperty.call(itemRecord, normalized)) {
    return itemRecord[normalized] ?? null;
  }
  return null;
}

function projectListItems(
  items: ListedItem[],
  projection: ListProjectionConfig,
  treeMode = false,
): ListResultItem[] {
  if (projection.mode === "full") {
    return items;
  }
  return items.map((item) => {
    const projected: Record<string, unknown> = {};
    for (const field of projection.fields) {
      projected[field] = readListFieldValue(item, field, treeMode);
    }
    return projected;
  });
}

function runtimeMetadataKeysForProjection(
  definitions: Array<{ metadata_key: string }>,
): string[] {
  const keys: string[] = [];
  for (const field of definitions) {
    keys.push(field.metadata_key);
  }
  return keys;
}

interface ListRuntimeContext {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  statusRegistry: RuntimeStatusRegistry;
  runtimeFieldFilters: Record<string, unknown>;
  typeRegistry: ItemTypeRegistry;
  projection: ListProjectionConfig;
}

interface ListOrderingOptions {
  sortField: ListSortField | undefined;
  sortOrder: ListSortOrder;
  treeEnabled: boolean;
  treeDepth: number | undefined;
  parentRoot: string | undefined;
}

interface ResolvedListStatus {
  resolvedStatus: ItemStatus[] | undefined;
  explicitAllStatuses: boolean;
  effectiveOptions: ListOptions;
  filtersStatus: string | string[] | null;
}

interface ListPageResult {
  projected: ListResultItem[];
  totalMatched: number;
  truncationExtras: { total: number } | Record<string, never>;
  pageExtras: {
    has_more?: boolean;
    next_cursor?: string;
    applied_limit?: number;
    truncated?: true;
  };
}

function resolveListPageLimit(
  options: ListOptions,
  totalRows: number,
): number | undefined {
  if (options.noTruncate === true) {
    return undefined;
  }
  return (
    parseIntegerLimit(options.limit) ?? (totalRows >= 10_000 ? 20 : undefined)
  );
}

function resolveListPageStart(
  ordered: ListedItem[],
  options: ListOptions,
  cursorFingerprint: string,
): number {
  if (options.after === undefined) {
    return parseOffset(options.offset) ?? 0;
  }
  return resolveQueryCursorStart(
    ordered,
    options.after,
    cursorFingerprint,
    (item) => item.id,
  );
}

function buildListPageExtras(
  limit: number | undefined,
  hasMore: boolean,
  nextCursor: string | undefined,
): ListPageResult["pageExtras"] {
  return {
    ...(limit !== undefined ? { applied_limit: limit } : {}),
    ...(hasMore ? { has_more: true, truncated: true } : {}),
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  };
}

async function resolveListRuntimeContext(
  options: ListOptions,
  global: GlobalOptions,
): Promise<ListRuntimeContext> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const runtimeFieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
  const projection = parseProjectionConfig(options);
  validateListProjectionFields(
    projection,
    runtimeMetadataKeysForProjection(runtimeFieldRegistry.definitions),
  );
  return {
    pmRoot,
    settings,
    statusRegistry,
    runtimeFieldFilters: collectRuntimeFilterValues(
      options as Record<string, unknown>,
      runtimeFieldRegistry,
      "list",
    ),
    typeRegistry: resolveItemTypeRegistry(
      settings,
      getActiveExtensionRegistrations(),
    ),
    projection,
  };
}

async function loadListItems(
  options: ListOptions,
  runtime: ListRuntimeContext,
  listWarnings: string[],
): Promise<ListedItem[]> {
  const projectionNeedsBody = runtime.projection.fields.some(
    (field) => normalizeProjectionField(field) === "body",
  );
  const projectionNeedsCollections =
    runtime.projection.mode === "full" ||
    runtime.projection.fields.some((field) =>
      HEAVY_PROJECTION_FIELDS.has(normalizeProjectionField(field)),
    );
  const contentFieldFilters = resolveContentFieldFilters(
    options as Record<string, unknown>,
  );
  const contentNeedsCollections =
    contentFiltersNeedCollections(contentFieldFilters);
  const contentNeedsBody = contentFiltersNeedBody(contentFieldFilters);
  if (options.includeBody || projectionNeedsBody || contentNeedsBody) {
    return await listAllItemMetadataWithBody(
      runtime.pmRoot,
      runtime.settings.item_format,
      runtime.typeRegistry.type_to_folder,
      listWarnings,
      runtime.settings.schema,
    );
  }
  if (projectionNeedsCollections || contentNeedsCollections) {
    return await listAllItemMetadata(
      runtime.pmRoot,
      runtime.settings.item_format,
      runtime.typeRegistry.type_to_folder,
      listWarnings,
      runtime.settings.schema,
    );
  }
  return await listAllItemMetadataLight(
    runtime.pmRoot,
    runtime.settings.item_format,
    runtime.typeRegistry.type_to_folder,
    listWarnings,
    runtime.settings.schema,
  );
}

function resolveListOrderingOptions(options: ListOptions): ListOrderingOptions {
  const sortField = parseSortField(options.sort);
  const sortOrder = parseSortOrder(options.order) ?? "asc";
  const treeEnabled = options.tree === true;
  if (!treeEnabled && options.treeDepth !== undefined) {
    throw new PmCliError("List --tree-depth requires --tree", EXIT_CODE.USAGE);
  }
  if (!sortField && options.order !== undefined) {
    throw new PmCliError("List --order requires --sort", EXIT_CODE.USAGE);
  }
  return {
    sortField,
    sortOrder,
    treeEnabled,
    treeDepth: treeEnabled ? parseTreeDepth(options.treeDepth) : undefined,
    parentRoot: treeEnabled ? trimNonEmpty(options.parent) : undefined,
  };
}

function resolveListStatusSelection(
  status: ItemStatus | undefined,
  options: ListOptions,
  statusRegistry: RuntimeStatusRegistry,
): ResolvedListStatus {
  const explicitStatus = resolveStatusFilter(
    options.status as ItemStatus | undefined,
    statusRegistry,
  );
  const resolvedStatus =
    explicitStatus ?? resolveStatusFilter(status, statusRegistry);
  const explicitAllStatuses = isStatusAllFilterInput(options.status);
  const effectiveOptions =
    explicitStatus || explicitAllStatuses
      ? { ...options, excludeTerminal: false }
      : options;
  const filtersStatus = explicitAllStatuses
    ? "all"
    : resolvedStatus === undefined
      ? null
      : resolvedStatus.length === 1
        ? resolvedStatus[0]
        : resolvedStatus;
  return {
    resolvedStatus,
    explicitAllStatuses,
    effectiveOptions,
    filtersStatus,
  };
}

function pageAndProjectListItems(
  ordered: ListedItem[],
  options: ListOptions,
  projection: ListProjectionConfig,
  treeEnabled: boolean,
  cursorFingerprint: string,
): ListPageResult {
  if (options.after !== undefined && options.offset !== undefined) {
    throw new PmCliError(
      "List --after cannot be combined with --offset.",
      EXIT_CODE.USAGE,
    );
  }
  const limit = resolveListPageLimit(options, ordered.length);
  const offset = resolveListPageStart(ordered, options, cursorFingerprint);
  const limited =
    limit === undefined
      ? ordered.slice(offset)
      : ordered.slice(offset, offset + limit);
  const projected = projectListItems(limited, projection, treeEnabled);
  const totalMatched = ordered.length;
  const hasMore = limited.length > 0 && offset + limited.length < totalMatched;
  const nextCursor =
    hasMore && limited.length > 0
      ? encodeQueryCursor(
          cursorFingerprint,
          limited[limited.length - 1]!.id,
          offset + limited.length - 1,
        )
      : undefined;
  return {
    projected,
    totalMatched,
    truncationExtras:
      projected.length < totalMatched || offset > 0
        ? { total: totalMatched }
        : {},
    pageExtras: buildListPageExtras(limit, hasMore, nextCursor),
  };
}

function buildListCursorFingerprint(
  status: string | string[] | null,
  options: ListOptions,
  ordering: ListOrderingOptions,
): string {
  const normalizedOptions: Record<string, unknown> = { ...options };
  delete normalizedOptions.after;
  delete normalizedOptions.limit;
  delete normalizedOptions.offset;
  delete normalizedOptions.noTruncate;
  delete normalizedOptions.includeBody;
  delete normalizedOptions.compact;
  delete normalizedOptions.brief;
  delete normalizedOptions.full;
  delete normalizedOptions.fields;
  return createQueryFingerprint("list", {
    status,
    options: normalizedOptions,
    sort: ordering.sortField ?? "default",
    order: ordering.sortOrder,
    tree: ordering.treeEnabled,
    tree_depth: ordering.treeDepth ?? null,
  });
}

function buildVerboseListFilters(params: {
  filtersStatus: string | string[] | null;
  options: ListOptions;
  noTruncate: boolean;
  treeEnabled: boolean;
  treeDepth: number | undefined;
  sortField: ListSortField | undefined;
  sortOrder: ListSortOrder;
  runtimeFieldFilters: Record<string, unknown>;
}): Record<string, unknown> {
  const {
    filtersStatus,
    options,
    noTruncate,
    treeEnabled,
    treeDepth,
    sortField,
    sortOrder,
    runtimeFieldFilters,
  } = params;
  const filters: Record<string, unknown> = { status: filtersStatus };
  if (options.dependencyBlocked === true) {
    filters.blocked_semantics = "status_or_dependency";
  }
  const optionRecord = options as Record<string, unknown>;
  for (const entry of VERBOSE_LIST_VALUE_FILTER_ECHO_ENTRIES) {
    filters[entry.summaryKey] = optionRecord[entry.optionKey] ?? null;
  }
  for (const entry of VERBOSE_LIST_BOOLEAN_FILTER_ECHO_ENTRIES) {
    if (optionRecord[entry.key] === true) {
      filters[entry.summaryKey] = true;
    }
  }
  Object.assign(
    filters,
    buildGovernanceMissingFilterEcho(options),
    buildContentFilterEcho(options),
  );
  applyListWindowFilterEcho(filters, options);
  if (noTruncate) {
    filters.no_truncate = true;
  }
  if (treeEnabled) {
    filters.tree = true;
    filters.tree_depth = treeDepth ?? null;
  }
  filters.sort = sortField ?? null;
  filters.order = sortField ? sortOrder : null;
  filters.runtime_filters = runtimeFieldFilters;
  return filters;
}

/** Return complete item metadata when the caller explicitly requests full projection. */
export function runList(
  status: ItemStatus | undefined,
  options: ListOptions & { full: true },
  global: GlobalOptions,
): Promise<ListFullResult>;
/** Implements run list for the public runtime surface of this module. */
export function runList(
  status: ItemStatus | undefined,
  options: ListOptions,
  global: GlobalOptions,
): Promise<ListResult>;
/** Execute a list query with projection-aware public result typing. */
export async function runList(
  status: ItemStatus | undefined,
  options: ListOptions,
  global: GlobalOptions,
): Promise<ListResult> {
  const runtime = await resolveListRuntimeContext(options, global);
  const listWarnings: string[] = [];
  const items = await loadListItems(options, runtime, listWarnings);
  const ordering = resolveListOrderingOptions(options);
  const statusSelection = resolveListStatusSelection(
    status,
    options,
    runtime.statusRegistry,
  );
  const filtered = applyFilters(
    items,
    statusSelection.resolvedStatus,
    statusSelection.effectiveOptions,
    runtime.typeRegistry,
    runtime.statusRegistry,
    runtime.runtimeFieldFilters,
  );
  // Edge-aware blocked selection (GH-578): classify against the complete
  // loaded corpus so terminal blocker targets count as satisfied, then narrow
  // the already-filtered rows to the shared blocked set.
  const scoped =
    options.dependencyBlocked === true
      ? (() => {
          const blockedIds = collectDependencyBlockedIds(
            items,
            runtime.statusRegistry,
          );
          return filtered.filter((item) =>
            blockedIds.has(item.id.trim().toLowerCase()),
          );
        })()
      : filtered;
  const sorted = sortItems(
    scoped,
    ordering.sortField,
    ordering.sortOrder,
    runtime.statusRegistry,
  );
  const ordered = ordering.treeEnabled
    ? orderItemsAsTree(sorted, ordering.parentRoot, ordering.treeDepth)
    : sorted;
  const noTruncate = options.noTruncate === true;
  const page = pageAndProjectListItems(
    ordered,
    options,
    runtime.projection,
    ordering.treeEnabled,
    buildListCursorFingerprint(
      statusSelection.filtersStatus,
      options,
      ordering,
    ),
  );
  const now = nowIso();
  const warnings = [...new Set(listWarnings)].sort((left, right) =>
    left.localeCompare(right),
  );
  const projectionFields =
    runtime.projection.mode === "full" ? null : [...runtime.projection.fields];
  const compactSummaryMode =
    runtime.projection.mode === "compact" && options.compact === true;
  if (compactSummaryMode) {
    const compactFilters = buildCompactListFilterSummary({
      filtersStatus: statusSelection.filtersStatus,
      options,
      treeEnabled: ordering.treeEnabled,
      treeDepth: ordering.treeDepth,
      sortField: ordering.sortField,
      sortOrder: ordering.sortOrder,
      runtimeFieldFilters: runtime.runtimeFieldFilters,
    });
    return {
      items: page.projected,
      count: page.projected.length,
      ...page.truncationExtras,
      ...page.pageExtras,
      filters: compactFilters,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
  return {
    items: page.projected,
    count: page.projected.length,
    ...page.truncationExtras,
    ...page.pageExtras,
    filters: buildVerboseListFilters({
      filtersStatus: statusSelection.filtersStatus,
      options,
      noTruncate,
      treeEnabled: ordering.treeEnabled,
      treeDepth: ordering.treeDepth,
      sortField: ordering.sortField,
      sortOrder: ordering.sortOrder,
      runtimeFieldFilters: runtime.runtimeFieldFilters,
    }),
    projection: {
      mode: runtime.projection.mode,
      fields: projectionFields,
    },
    sorting: {
      sort: ordering.sortField ?? "default",
      order: ordering.sortField ? ordering.sortOrder : "asc",
    },
    now,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  applyFilters,
  buildCompactListFilterSummary,
  buildContentFilterEcho,
  buildGovernanceMissingFilterEcho,
  resolveContentFieldFilters,
  resolveMissingMetadataFilters,
  compareBySortField,
  compareDefaultSort,
  compareNullableString,
  compareNullableTimestamp,
  normalizeProjectionField,
  parseAssigneeFilter,
  parseFieldSelectors,
  parseIdsFilter,
  parseOffset,
  parseProjectionConfig,
  resolveListUpdatedAfter,
  resolveListPageLimit,
  parseSortField,
  parseSortOrder,
  orderItemsAsTree,
  projectListItems,
  readListFieldValue,
  runtimeMetadataKeysForProjection,
  sortItems,
  trimNonEmpty,
  withTreeMetadata,
};
