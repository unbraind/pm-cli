/**
 * Metadata governance & coverage observability primitives.
 *
 * One dependency-light module that powers the whole metadata-governance
 * surface: missing-field selection (pm list / pm update-many), coverage
 * percentages (pm stats --metadata-coverage / pm validate), and grouped
 * lifecycle breakdowns (pm stats --by-assignee/--by-tag/--by-priority,
 * pm aggregate explicit labels).
 *
 * The module is pure: it performs no IO and imports no heavy runtime
 * dependencies. Lifecycle semantics are injected via a {@link LifecycleClassifier}
 * so callers map their runtime status registry to lifecycle buckets while the
 * pure logic here stays trivially testable with a fake classifier.
 */

import { toNonEmptyStringOrUndefined } from "../shared/primitives.js";

/** Minimal structural shape this module needs from an item's item metadata. */
export interface CoverageItem {
  /** Schema type that determines the shape and validation rules for this value. */
  type: string;
  /** Lifecycle state reported for status. */
  status: string;
  /** Value that configures or reports assignee for this contract. */
  assignee?: string;
  /** Value that configures or reports tags for this contract. */
  tags?: string[];
  /** Value that configures or reports parent for this contract. */
  parent?: string;
  /** Value that configures or reports priority for this contract. */
  priority?: number;
  /** Value that configures or reports acceptance criteria for this contract. */
  acceptance_criteria?: string;
  /** Value that configures or reports estimated minutes for this contract. */
  estimated_minutes?: number;
  /** Value that configures or reports resolution for this contract. */
  resolution?: string;
  /** Value that configures or reports reviewer for this contract. */
  reviewer?: string;
  /** Value that configures or reports risk for this contract. */
  risk?: string;
  /** Confidence is a string-like enum or a numeric score depending on workspace. */
  confidence?: string | number;
  /** Value that configures or reports sprint for this contract. */
  sprint?: string;
  /** Value that configures or reports release for this contract. */
  release?: string;
  [key: string]: unknown;
}

/** Lifecycle buckets used by grouped breakdowns and distributions. */
export type LifecycleBucket =
  | "open"
  | "in_progress"
  | "blocked"
  | "draft"
  | "closed"
  | "canceled"
  | "other";

/** Stable rendering order for lifecycle buckets. */
export const LIFECYCLE_BUCKET_ORDER: readonly LifecycleBucket[] = [
  "open",
  "in_progress",
  "blocked",
  "draft",
  "closed",
  "canceled",
  "other",
] as const;

/**
 * Classifies a raw status string into a lifecycle bucket and reports whether a
 * status is terminal (closed/canceled). Callers build this from their resolved
 * runtime status registry via {@link lifecycleClassifierFromStatusRegistry}.
 */
export interface LifecycleClassifier {
  /** Value that configures or reports classify for this contract. */
  classify(status: string): LifecycleBucket;
  /** Whether terminal applies to this operation. */
  isTerminal(status: string): boolean;
}

/** The subset of a resolved runtime status registry this module consumes. */
export interface StatusRegistryLike {
  /** Value that configures or reports alias to id for this contract. */
  alias_to_id: Map<string, string>;
  /** Value that configures or reports terminal statuses for this contract. */
  terminal_statuses: Set<string>;
  /** Value that configures or reports terminal canceled statuses for this contract. */
  terminal_canceled_statuses: Set<string>;
  /** Value that configures or reports blocked statuses for this contract. */
  blocked_statuses: Set<string>;
  /** Value that configures or reports draft statuses for this contract. */
  draft_statuses: Set<string>;
  /** Value that configures or reports active statuses for this contract. */
  active_statuses: Set<string>;
  /** Lifecycle state reported for openthe record. */
  open_status: string;
}

function normalizeStatus(status: string, registry: StatusRegistryLike): string {
  const trimmed = status.trim().toLowerCase();
  return registry.alias_to_id.get(trimmed) ?? trimmed;
}

/**
 * Adapt a resolved runtime status registry into a {@link LifecycleClassifier}.
 *
 * Precedence is deliberate and disjoint: canceled → closed → blocked → draft →
 * open → in_progress (active but not the default open status) → other.
 */
export function lifecycleClassifierFromStatusRegistry(
  registry: StatusRegistryLike,
): LifecycleClassifier {
  return {
    isTerminal(status: string): boolean {
      return registry.terminal_statuses.has(normalizeStatus(status, registry));
    },
    classify(status: string): LifecycleBucket {
      const id = normalizeStatus(status, registry);
      if (registry.terminal_canceled_statuses.has(id)) {
        return "canceled";
      }
      if (registry.terminal_statuses.has(id)) {
        return "closed";
      }
      if (registry.blocked_statuses.has(id)) {
        return "blocked";
      }
      if (registry.draft_statuses.has(id)) {
        return "draft";
      }
      if (id === registry.open_status) {
        return "open";
      }
      if (registry.active_statuses.has(id)) {
        return "in_progress";
      }
      return "other";
    },
  };
}

// ---------------------------------------------------------------------------
// Missing-metadata predicates
// ---------------------------------------------------------------------------

/** True when an item has no non-empty acceptance_criteria. */
export function isAcMissing(item: CoverageItem): boolean {
  return toNonEmptyStringOrUndefined(item.acceptance_criteria) === undefined;
}

/** True when an item has no finite estimated_minutes. */
export function isEstimateMissing(item: CoverageItem): boolean {
  return !Number.isFinite(item.estimated_minutes);
}

/**
 * True when a terminal (closed/canceled) item has no non-empty resolution.
 * Resolution is only expected on terminal items, so open items are never
 * considered "resolution-missing".
 */
export function isResolutionMissing(
  item: CoverageItem,
  classifier: LifecycleClassifier,
): boolean {
  if (!classifier.isTerminal(item.status)) {
    return false;
  }
  return toNonEmptyStringOrUndefined(item.resolution) === undefined;
}

/** True when an item has no non-empty reviewer. */
export function isReviewerMissing(item: CoverageItem): boolean {
  return toNonEmptyStringOrUndefined(item.reviewer) === undefined;
}

/** True when an item has no non-empty risk level. */
export function isRiskMissing(item: CoverageItem): boolean {
  return toNonEmptyStringOrUndefined(item.risk) === undefined;
}

/**
 * True when an item has no confidence value. Confidence is a string-like enum
 * or a numeric score depending on workspace, so a finite number counts as
 * present and only blank/absent values are treated as missing.
 */
export function isConfidenceMissing(item: CoverageItem): boolean {
  if (typeof item.confidence === "number") {
    return !Number.isFinite(item.confidence);
  }
  return toNonEmptyStringOrUndefined(item.confidence) === undefined;
}

/** True when an item has no non-empty sprint. */
export function isSprintMissing(item: CoverageItem): boolean {
  return toNonEmptyStringOrUndefined(item.sprint) === undefined;
}

/** True when an item has no non-empty release. */
export function isReleaseMissing(item: CoverageItem): boolean {
  return toNonEmptyStringOrUndefined(item.release) === undefined;
}

/** Selection flags for {@link filterMissingMetadata}. */
export interface MissingMetadataFilters {
  /** Value that configures or reports ac missing for this contract. */
  acMissing?: boolean;
  /** Value that configures or reports estimates missing for this contract. */
  estimatesMissing?: boolean;
  /** Value that configures or reports resolution missing for this contract. */
  resolutionMissing?: boolean;
  /** Value that configures or reports reviewer missing for this contract. */
  reviewerMissing?: boolean;
  /** Value that configures or reports risk missing for this contract. */
  riskMissing?: boolean;
  /** Value that configures or reports confidence missing for this contract. */
  confidenceMissing?: boolean;
  /** Value that configures or reports sprint missing for this contract. */
  sprintMissing?: boolean;
  /** Value that configures or reports release missing for this contract. */
  releaseMissing?: boolean;
  /** Match items missing ANY of the tracked metadata fields (union). */
  metadataMissing?: boolean;
}

/** True when any missing-metadata filter is requested. */
export function hasMissingMetadataFilter(
  filters: MissingMetadataFilters,
): boolean {
  return Boolean(
    filters.acMissing ||
    filters.estimatesMissing ||
    filters.resolutionMissing ||
    filters.reviewerMissing ||
    filters.riskMissing ||
    filters.confidenceMissing ||
    filters.sprintMissing ||
    filters.releaseMissing ||
    filters.metadataMissing,
  );
}

function itemMatchesSpecificMetadataFilters(
  item: CoverageItem,
  filters: MissingMetadataFilters,
  classifier: LifecycleClassifier,
): boolean {
  const checks: Array<[boolean | undefined, boolean]> = [
    [filters.acMissing, isAcMissing(item)],
    [filters.estimatesMissing, isEstimateMissing(item)],
    [filters.resolutionMissing, isResolutionMissing(item, classifier)],
    [filters.reviewerMissing, isReviewerMissing(item)],
    [filters.riskMissing, isRiskMissing(item)],
    [filters.confidenceMissing, isConfidenceMissing(item)],
    [filters.sprintMissing, isSprintMissing(item)],
    [filters.releaseMissing, isReleaseMissing(item)],
  ];
  return checks.every(([requested, matched]) => requested !== true || matched);
}

function itemMatchesCoreMetadataMissingUnion(
  item: CoverageItem,
  classifier: LifecycleClassifier,
): boolean {
  return (
    isAcMissing(item) ||
    isEstimateMissing(item) ||
    isResolutionMissing(item, classifier)
  );
}

/**
 * Does a single item satisfy the requested missing-metadata filters?
 *
 * Specific flags (acMissing/estimatesMissing/resolutionMissing plus the
 * governance flags reviewerMissing/riskMissing/confidenceMissing/sprintMissing/
 * releaseMissing) are ANDed together so callers can narrow precisely.
 * `metadataMissing` is ORed in as a union shortcut for "missing any of the
 * core tracked fields" (acceptance_criteria/estimated_minutes/resolution); it
 * deliberately excludes the governance fields so the long-standing flag keeps
 * its original meaning. When no filter is requested the item passes.
 */
export function itemMatchesMissingMetadata(
  item: CoverageItem,
  filters: MissingMetadataFilters,
  classifier: LifecycleClassifier,
): boolean {
  if (!hasMissingMetadataFilter(filters)) {
    return true;
  }
  if (!itemMatchesSpecificMetadataFilters(item, filters, classifier)) {
    return false;
  }
  if (
    filters.metadataMissing &&
    !itemMatchesCoreMetadataMissingUnion(item, classifier)
  ) {
    return false;
  }
  return true;
}

/** Filter a list of items by the requested missing-metadata predicates. */
export function filterMissingMetadata<T extends CoverageItem>(
  items: readonly T[],
  filters: MissingMetadataFilters,
  classifier: LifecycleClassifier,
): T[] {
  if (!hasMissingMetadataFilter(filters)) {
    return [...items];
  }
  return items.filter((item) =>
    itemMatchesMissingMetadata(item, filters, classifier),
  );
}

// ---------------------------------------------------------------------------
// Metadata coverage percentages
// ---------------------------------------------------------------------------

/** Coverage-tracked metadata fields. */
export type CoverageField =
  | "acceptance_criteria"
  | "estimated_minutes"
  | "resolution"
  | "tags"
  | "parent";

/** Stable ordering of coverage fields for rendering. */
export const COVERAGE_FIELD_ORDER: readonly CoverageField[] = [
  "acceptance_criteria",
  "estimated_minutes",
  "resolution",
  "tags",
  "parent",
] as const;

/** Coverage of a single field: present vs applicable, with a rounded percent. */
export interface FieldCoverage {
  /** Value that configures or reports present for this contract. */
  present: number;
  /** Items for which the field is expected (all items, except resolution = terminal only). */
  applicable: number;
  /** present/applicable * 100, rounded to one decimal; 100 when applicable is 0. */
  percent: number;
}

/**
 * Documents the metadata coverage report payload exchanged by command, SDK, and package integrations.
 */
export interface MetadataCoverageReport {
  /** Value that configures or reports overall for this contract. */
  overall: Record<CoverageField, FieldCoverage>;
  /** Schema type that determines the shape and validation rules for this value. */
  by_type: Record<string, Record<CoverageField, FieldCoverage>>;
}

function isFieldPresent(item: CoverageItem, field: CoverageField): boolean {
  switch (field) {
    case "acceptance_criteria":
      return !isAcMissing(item);
    case "estimated_minutes":
      return !isEstimateMissing(item);
    case "resolution":
      return toNonEmptyStringOrUndefined(item.resolution) !== undefined;
    case "tags":
      return Array.isArray(item.tags) && item.tags.length > 0;
    default:
      return toNonEmptyStringOrUndefined(item.parent) !== undefined;
  }
}

/** Whether a field applies to a given item (resolution only applies to terminal items). */
function isFieldApplicable(
  item: CoverageItem,
  field: CoverageField,
  classifier: LifecycleClassifier,
): boolean {
  if (field === "resolution") {
    return classifier.isTerminal(item.status);
  }
  return true;
}

function roundPercent(present: number, applicable: number): number {
  if (applicable === 0) {
    return 100;
  }
  return Math.round((present / applicable) * 1000) / 10;
}

function emptyFieldCoverage(): Record<CoverageField, FieldCoverage> {
  const record = {} as Record<CoverageField, FieldCoverage>;
  for (const field of COVERAGE_FIELD_ORDER) {
    record[field] = { present: 0, applicable: 0, percent: 100 };
  }
  return record;
}

function accumulateCoverage(
  target: Record<CoverageField, FieldCoverage>,
  item: CoverageItem,
  classifier: LifecycleClassifier,
): void {
  for (const field of COVERAGE_FIELD_ORDER) {
    if (!isFieldApplicable(item, field, classifier)) {
      continue;
    }
    const entry = target[field];
    entry.applicable += 1;
    if (isFieldPresent(item, field)) {
      entry.present += 1;
    }
  }
}

function finalizePercentages(
  record: Record<CoverageField, FieldCoverage>,
): void {
  for (const field of COVERAGE_FIELD_ORDER) {
    const entry = record[field];
    entry.percent = roundPercent(entry.present, entry.applicable);
  }
}

/**
 * Compute metadata coverage overall and per item type. For each tracked field
 * we report present/applicable counts and a rounded percentage. Resolution is
 * scoped to terminal items (its only applicable population).
 */
export function computeMetadataCoverage(
  items: readonly CoverageItem[],
  classifier: LifecycleClassifier,
): MetadataCoverageReport {
  const overall = emptyFieldCoverage();
  const byType: Record<string, Record<CoverageField, FieldCoverage>> = {};
  for (const item of items) {
    accumulateCoverage(overall, item, classifier);
    const typeRecord =
      byType[item.type] ?? (byType[item.type] = emptyFieldCoverage());
    accumulateCoverage(typeRecord, item, classifier);
  }
  finalizePercentages(overall);
  for (const typeRecord of Object.values(byType)) {
    finalizePercentages(typeRecord);
  }
  return { overall, by_type: byType };
}

// ---------------------------------------------------------------------------
// Grouped lifecycle breakdowns
// ---------------------------------------------------------------------------

/** Dimensions a breakdown can group by. */
export type GroupDimension =
  | "assignee"
  | "priority"
  | "tag"
  | "parent"
  | "type"
  | "status";

/** Explicit labels for empty/blank group keys, by dimension. */
const EMPTY_GROUP_LABELS: Record<GroupDimension, string> = {
  assignee: "(unassigned)",
  priority: "(no priority)",
  tag: "(untagged)",
  parent: "(unparented)",
  type: "(untyped)",
  status: "(no status)",
};

/** Explicit label for an empty/blank group value for a given dimension. */
export function emptyGroupLabel(dimension: GroupDimension): string {
  return EMPTY_GROUP_LABELS[dimension];
}

/**
 * Documents the group row payload exchanged by command, SDK, and package integrations.
 */
export interface GroupRow {
  /** Display label; explicit "(unassigned)"-style label for blank keys. */
  label: string;
  /** Stable structured key (null for the empty/blank group). */
  key: string | null;
  /** Value that configures or reports buckets for this contract. */
  buckets: Record<LifecycleBucket, number>;
  /** Value that configures or reports total for this contract. */
  total: number;
}

/**
 * Documents the grouped breakdown payload exchanged by command, SDK, and package integrations.
 */
export interface GroupedBreakdown {
  /** Value that configures or reports dimension for this contract. */
  dimension: GroupDimension;
  /** Value that configures or reports rows for this contract. */
  rows: GroupRow[];
  /** Distinct items observed (an item can contribute to multiple tag rows). */
  total_items: number;
}

/**
 * Documents the group options payload exchanged by command, SDK, and package integrations.
 */
export interface GroupOptions {
  /** For dimension="tag": only consider tags starting with this prefix. */
  tagPrefix?: string;
}

function emptyBuckets(): Record<LifecycleBucket, number> {
  return {
    open: 0,
    in_progress: 0,
    blocked: 0,
    draft: 0,
    closed: 0,
    canceled: 0,
    other: 0,
  };
}

/**
 * Resolve the group keys an item belongs to for a dimension. Most dimensions
 * yield exactly one key (possibly null for blank); tag yields one key per
 * matching tag (or [null] when none match), so an item can span multiple rows.
 */
function groupKeysForItem(
  item: CoverageItem,
  dimension: GroupDimension,
  options: GroupOptions,
): (string | null)[] {
  switch (dimension) {
    case "assignee":
      return [toNonEmptyStringOrUndefined(item.assignee) ?? null];
    case "parent":
      return [toNonEmptyStringOrUndefined(item.parent) ?? null];
    case "type":
      return [toNonEmptyStringOrUndefined(item.type) ?? null];
    case "status":
      return [toNonEmptyStringOrUndefined(item.status) ?? null];
    case "priority":
      return [typeof item.priority === "number" ? `P${item.priority}` : null];
    default: {
      const prefix = options.tagPrefix?.trim();
      const tags = Array.isArray(item.tags) ? item.tags : [];
      const matching = tags.filter(
        (tag) =>
          typeof tag === "string" &&
          tag.length > 0 &&
          (!prefix || tag.startsWith(prefix)),
      );
      return matching.length > 0 ? matching : [null];
    }
  }
}

/**
 * Group items by a dimension into lifecycle-bucketed rows. Blank keys render
 * with an explicit "(unassigned)"-style label. Rows are sorted by total
 * descending, then label ascending, with the empty group sorted last on ties.
 */
export function groupItemsByDimension(
  items: readonly CoverageItem[],
  dimension: GroupDimension,
  classifier: LifecycleClassifier,
  options: GroupOptions = {},
): GroupedBreakdown {
  const rows = new Map<string, GroupRow>();
  let totalItems = 0;
  for (const item of items) {
    totalItems += 1;
    const bucket = classifier.classify(item.status);
    for (const key of groupKeysForItem(item, dimension, options)) {
      const mapKey = key ?? " empty";
      let row = rows.get(mapKey);
      if (!row) {
        row = {
          label: key ?? emptyGroupLabel(dimension),
          key,
          buckets: emptyBuckets(),
          total: 0,
        };
        rows.set(mapKey, row);
      }
      row.buckets[bucket] += 1;
      row.total += 1;
    }
  }
  const sorted = [...rows.values()].sort((left, right) => {
    if (right.total !== left.total) {
      return right.total - left.total;
    }
    // All blank-key items collapse into a single row per dimension, so at most
    // one row has key === null; it sorts last on ties.
    if (left.key === null) {
      return 1;
    }
    if (right.key === null) {
      return -1;
    }
    return left.label.localeCompare(right.label);
  });
  return { dimension, rows: sorted, total_items: totalItems };
}

/** Lifecycle-bucket distribution across all items (for stats lifecycle section). */
export function computeLifecycleDistribution(
  items: readonly CoverageItem[],
  classifier: LifecycleClassifier,
): Record<LifecycleBucket, number> {
  const buckets = emptyBuckets();
  for (const item of items) {
    buckets[classifier.classify(item.status)] += 1;
  }
  return buckets;
}
