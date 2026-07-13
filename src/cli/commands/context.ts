/**
 * @module cli/commands/context
 *
 * Implements the pm context command surface and its agent-facing runtime behavior.
 */
import { SETTINGS_DEFAULTS, EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { compareTimestampStrings, nowIso } from "../../core/shared/time.js";
import {
  isTerminalStatus,
  normalizeStatusForRegistry,
  normalizeStatusInput,
} from "../../core/item/status.js";
import {
  resolveRuntimeStatusRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type {
  ContextDepth,
  ContextSectionName,
  ContextSettings,
  ItemMetadata,
  ItemStatus,
  PmSettings,
} from "../../types/index.js";
import {
  CONTEXT_DEPTH_VALUES,
  CONTEXT_SECTION_VALUES,
} from "../../types/index.js";
import { parseIntegerLimit } from "../shared-parsers.js";
import {
  runCalendar,
  type CalendarOptions,
  type CalendarRow,
} from "./calendar.js";
import { runList, type ListOptions } from "./list.js";
import { runActivity, type CompactActivityEntry } from "./activity.js";
import {
  scoreContextCandidatesWithActiveExtensions,
  type ContextRelevanceCandidate,
  type ContextRelevanceContributions,
  type ContextRelevanceReport,
  type ContextRelevanceSignalName,
} from "../../sdk/context-relevance.js";
import {
  createQueryFingerprint,
  encodeQueryCursor,
  resolveQueryCursorStart,
} from "../../sdk/pagination.js";
import {
  packContextCandidates,
  type ContextPackingReport,
} from "../../sdk/context-packing.js";
import {
  readContextUsageAffinity,
  recordContextUsageServing,
} from "../../sdk/context-usage.js";

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

/** Supported values accepted by the context output contract. */
export const CONTEXT_OUTPUT_VALUES = ["markdown", "toon", "json"] as const;
/** Restricts context output format values accepted by command, SDK, and storage contracts. */
export type ContextOutputFormat = (typeof CONTEXT_OUTPUT_VALUES)[number];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Documents the context options payload exchanged by command, SDK, and package integrations. */
export interface ContextOptions {
  /** Value that configures or reports date for this contract. */
  date?: string;
  /** Value that configures or reports from for this contract. */
  from?: string;
  /** Value that configures or reports to for this contract. */
  to?: string;
  /** Value that configures or reports past for this contract. */
  past?: boolean;
  /** Schema type that determines the shape and validation rules for this value. */
  type?: string;
  /** Value that configures or reports tag for this contract. */
  tag?: string;
  /** Value that configures or reports priority for this contract. */
  priority?: string;
  /** Value that configures or reports assignee for this contract. */
  assignee?: string;
  /** Value that configures or reports assignee filter for this contract. */
  assigneeFilter?: string;
  /** Value that configures or reports sprint for this contract. */
  sprint?: string;
  /** Value that configures or reports release for this contract. */
  release?: string;
  /** Value that configures or reports limit for this contract. */
  limit?: string;
  /** Value that configures or reports max items for this contract. */
  maxItems?: string;
  /** Opaque cursor returned by a previous context focus page. */
  after?: string;
  /** Value that configures or reports format for this contract. */
  format?: string;
  /** Value that configures or reports depth for this contract. */
  depth?: string;
  /** Value that configures or reports fields for this contract. */
  fields?: string;
  /** Value that configures or reports section for this contract. */
  section?: string[];
  /** Value that configures or reports activity limit for this contract. */
  activityLimit?: string;
  /** Value that configures or reports stale threshold for this contract. */
  staleThreshold?: string;
  /** Value that configures or reports parent for this contract. */
  parent?: string;
  /** Value that configures or reports explain ranking for this contract. */
  explainRanking?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Focus item (unchanged from original)
// ---------------------------------------------------------------------------

/** Documents the context focus item payload exchanged by command, SDK, and package integrations. */
export interface ContextFocusItem {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports title for this contract. */
  title: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type: string;
  /** Lifecycle state reported for status. */
  status: ItemStatus;
  /** Value that configures or reports priority for this contract. */
  priority: number;
  /** Value that configures or reports order for this contract. */
  order: number | null;
  /** Value that configures or reports deadline for this contract. */
  deadline: string | null;
  /** Value that configures or reports assignee for this contract. */
  assignee: string | null;
  /** Value that configures or reports tags for this contract. */
  tags: string[];
  /** ISO 8601 timestamp recording when updated occurred. */
  updated_at: string;
  /** Value that configures or reports parent for this contract. */
  parent: string | null;
  /** Value that configures or reports children total for this contract. */
  children_total?: number;
  /** Value that configures or reports children closed for this contract. */
  children_closed?: number;
  /** Value that configures or reports completion pct for this contract. */
  completion_pct?: number;
}

// ---------------------------------------------------------------------------
// Section data types
// ---------------------------------------------------------------------------

/** Documents the hierarchy child payload exchanged by command, SDK, and package integrations. */
export interface HierarchyChild {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports title for this contract. */
  title: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type: string;
  /** Lifecycle state reported for status. */
  status: ItemStatus;
  /** Value that configures or reports children total for this contract. */
  children_total: number;
  /** Value that configures or reports children closed for this contract. */
  children_closed: number;
}

/** Documents the hierarchy node payload exchanged by command, SDK, and package integrations. */
export interface HierarchyNode {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports title for this contract. */
  title: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type: string;
  /** Lifecycle state reported for status. */
  status: ItemStatus;
  /** Value that configures or reports children total for this contract. */
  children_total: number;
  /** Value that configures or reports children closed for this contract. */
  children_closed: number;
  /** Value that configures or reports children open for this contract. */
  children_open: number;
  /** Value that configures or reports children in progress for this contract. */
  children_in_progress: number;
  /** Value that configures or reports children blocked for this contract. */
  children_blocked: number;
  /** Value that configures or reports children for this contract. */
  children: HierarchyChild[];
}

/** Documents the progress entry payload exchanged by command, SDK, and package integrations. */
export interface ProgressEntry {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports title for this contract. */
  title: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type: string;
  /** Value that configures or reports total for this contract. */
  total: number;
  /** Value that configures or reports closed for this contract. */
  closed: number;
  /** Value that configures or reports open for this contract. */
  open: number;
  /** Value that configures or reports in progress for this contract. */
  in_progress: number;
  /** Value that configures or reports blocked for this contract. */
  blocked: number;
  /** Value that configures or reports completion pct for this contract. */
  completion_pct: number;
}

/** Documents the blocker entry payload exchanged by command, SDK, and package integrations. */
export interface BlockerEntry {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports title for this contract. */
  title: string;
  /** Value that configures or reports blocked by for this contract. */
  blocked_by: string | null;
  /** Value that configures or reports blocked by title for this contract. */
  blocked_by_title: string | null;
  /** Lifecycle state reported for blocked bythe record. */
  blocked_by_status: ItemStatus | null;
  /** Value that configures or reports blocked reason for this contract. */
  blocked_reason: string | null;
  /** Value that configures or reports unblock note for this contract. */
  unblock_note: string | null;
}

/** Documents the hot file payload exchanged by command, SDK, and package integrations. */
export interface HotFile {
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports references for this contract. */
  references: number;
  /** Value that configures or reports items for this contract. */
  items: string[];
}

/** Documents the workload entry payload exchanged by command, SDK, and package integrations. */
export interface WorkloadEntry {
  /** Value that configures or reports assignee for this contract. */
  assignee: string | null;
  /** Value that configures or reports active for this contract. */
  active: number;
  /** Value that configures or reports in progress for this contract. */
  in_progress: number;
  /** Value that configures or reports items for this contract. */
  items: string[];
}

/** Documents the stale entry payload exchanged by command, SDK, and package integrations. */
export interface StaleEntry {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports title for this contract. */
  title: string;
  /** Lifecycle state reported for status. */
  status: ItemStatus;
  /** ISO 8601 timestamp recording when updated occurred. */
  updated_at: string;
  /** Value that configures or reports stale days for this contract. */
  stale_days: number;
}

/** Documents the recent context item payload exchanged by command, SDK, and package integrations. */
export interface RecentContextItem extends ContextFocusItem {
  /** ISO 8601 timestamp recording when created occurred. */
  created_at?: string;
}

/** Documents the test health summary payload exchanged by command, SDK, and package integrations. */
export interface TestHealthSummary {
  /** Value that configures or reports items with tests for this contract. */
  items_with_tests: number;
  /** Value that configures or reports items with recent runs for this contract. */
  items_with_recent_runs: number;
  /** Value that configures or reports recent runs for this contract. */
  recent_runs: {
    passed: number;
    failed: number;
    skipped: number;
  };
  /** Value that configures or reports items failing for this contract. */
  items_failing: string[];
}

// ---------------------------------------------------------------------------
// Agenda / summary (unchanged)
// ---------------------------------------------------------------------------

interface ContextAgendaSummary {
  events: number;
  items: number;
  deadlines: number;
  reminders: number;
  scheduled: number;
}

interface ContextSummary {
  active_items: number;
  in_progress: number;
  open: number;
  blocked: number;
  blocked_fallback_used: boolean;
  high_level: number;
  low_level: number;
  agenda_events: number;
  total_items?: number;
  closed?: number;
  canceled?: number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Documents the context result payload exchanged by command, SDK, and package integrations. */
export interface ContextResult {
  /** Value that configures or reports output default for this contract. */
  output_default: "toon";
  /** Value that configures or reports now for this contract. */
  now: string;
  /** Value that configures or reports depth for this contract. */
  depth: ContextDepth;
  /** Value that configures or reports sections included for this contract. */
  sections_included: ContextSectionName[];
  /** Value that configures or reports window for this contract. */
  window: {
    anchor: string;
    start: string | null;
    end: string | null;
    past: boolean;
    from: string | null;
    to: string | null;
  };
  /** Value that configures or reports filters for this contract. */
  filters: {
    type: string | null;
    tag: string | null;
    priority: string | null;
    assignee: string | null;
    assignee_filter: string | null;
    sprint: string | null;
    release: string | null;
    limit: string | null;
    parent: string | null;
    runtime_filters?: Record<string, unknown>;
  };
  /** Value that configures or reports summary for this contract. */
  summary: ContextSummary;
  /** Value that configures or reports high level for this contract. */
  high_level: ContextFocusItem[];
  /** Value that configures or reports low level for this contract. */
  low_level: ContextFocusItem[];
  /** Value that configures or reports blocked fallback for this contract. */
  blocked_fallback: ContextFocusItem[];
  /** Value that configures or reports agenda for this contract. */
  agenda: {
    summary: ContextAgendaSummary;
    events: CalendarRow[];
  };
  /** Value that configures or reports hierarchy for this contract. */
  hierarchy?: HierarchyNode[];
  /** Value that configures or reports activity for this contract. */
  activity?: CompactActivityEntry[];
  /** Value that configures or reports progress for this contract. */
  progress?: ProgressEntry[];
  /** Value that configures or reports blockers for this contract. */
  blockers?: BlockerEntry[];
  /** Value that configures or reports recently created for this contract. */
  recently_created?: RecentContextItem[];
  /** Value that configures or reports unparented for this contract. */
  unparented?: ContextFocusItem[];
  /** Value that configures or reports files for this contract. */
  files?: HotFile[];
  /** Value that configures or reports workload for this contract. */
  workload?: WorkloadEntry[];
  /** Value that configures or reports staleness for this contract. */
  staleness?: StaleEntry[];
  /** Value that configures or reports tests for this contract. */
  tests?: TestHealthSummary;
  /** Value that configures or reports suggestions for this contract. */
  suggestions?: string[];
  /** Focus-row field subset requested via --fields; null/omitted means full rows. */
  focus_fields?: string[];
  /** Value that configures or reports warnings for this contract. */
  warnings?: string[];
  /** Value that configures or reports ranking for this contract. */
  ranking?: ContextRankingSummary;
  /** Token-budget selection and projection accounting for ranked focus rows. */
  packing?: ContextPackingSummary;
  /** Whether additional ranked focus rows remain after this page. */
  has_more?: boolean;
  /** Opaque continuation cursor for the next ranked focus page. */
  next_cursor?: string;
  /** Effective ranked-focus page size. */
  applied_limit?: number;
  /** Explicit marker that focus rows were bounded. */
  truncated?: true;
}

/** Compact token-budget accounting shared by context and next results. */
export type ContextPackingSummary = Omit<
  ContextPackingReport<unknown>,
  "included"
> & {
  included: Array<{ id: string; projection: string; tokens: number }>;
};

/** Compact explainability envelope shared by context and next JSON results. */
export interface ContextRankingSummary {
  /** Value that configures or reports model for this contract. */
  model: string;
  /** Value that configures or reports available signals for this contract. */
  available_signals: ContextRelevanceSignalName[];
  /** Value that configures or reports items for this contract. */
  items: Array<{
    id: string;
    rank: number;
    baseline_rank: number;
    score: number;
    contributions: ContextRelevanceContributions;
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIGH_LEVEL_TYPES = new Set<string>(["Epic", "Feature"]);
const DEFAULT_CONTEXT_LIMIT = 10;
const CONTEXT_SCALE_THRESHOLD = 10_000;

const STANDARD_SECTIONS: ContextSectionName[] = [
  "hierarchy",
  "activity",
  "progress",
  "recently_created",
  "unparented",
  "workload",
];
const DEEP_SECTIONS: ContextSectionName[] = [
  ...STANDARD_SECTIONS,
  "blockers",
  "files",
  "staleness",
  "tests",
];
const LEADING_HYPHEN_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const LEADING_COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})(?:[T ]?\d{2}|$)/;
const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/;
const COMPACT_DATETIME =
  /^(\d{4})(\d{2})(\d{2})(?:[T\s]?)(\d{2})(\d{2})(\d{2})?(Z|[+-]\d{2}:?\d{2})?$/i;

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseOutputFormat(
  raw: string | undefined,
): ContextOutputFormat | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!CONTEXT_OUTPUT_VALUES.includes(normalized as ContextOutputFormat)) {
    throw new PmCliError(
      "Context format must be one of markdown|toon|json",
      EXIT_CODE.USAGE,
    );
  }
  return normalized as ContextOutputFormat;
}

// Fields selectable by `pm context --fields` for focus-row projection. Every
// ContextFocusItem scalar plus `created_at` (carried by recently-created rows)
// is addressable; unknown names are rejected with a usage hint.
const FOCUS_PROJECTION_FIELDS = new Set<string>([
  "id",
  "title",
  "type",
  "status",
  "priority",
  "order",
  "deadline",
  "assignee",
  "tags",
  "updated_at",
  "parent",
  "children_total",
  "children_closed",
  "completion_pct",
  "created_at",
]);

/** Parses the comma-separated `--fields` value into a validated, de-duplicated focus-row projection list. Returns undefined when no projection was requested. */
export function parseContextFocusFields(
  raw: string | undefined,
): string[] | undefined {
  if (raw === undefined) return undefined;
  const fields: string[] = [];
  for (const token of raw.split(",")) {
    const normalized = token.trim().toLowerCase();
    if (normalized.length === 0) continue;
    if (!FOCUS_PROJECTION_FIELDS.has(normalized)) {
      throw new PmCliError(
        `Context --fields value not projectable: ${normalized} (valid: ${[...FOCUS_PROJECTION_FIELDS].join(", ")})`,
        EXIT_CODE.USAGE,
      );
    }
    if (!fields.includes(normalized)) fields.push(normalized);
  }
  if (fields.length === 0) {
    throw new PmCliError(
      "Context --fields requires at least one field name",
      EXIT_CODE.USAGE,
    );
  }
  return fields;
}

/** Projects focus rows onto the requested field subset, preserving field order so the rendered/serialized output mirrors the `--fields` argument. */
export function projectContextFocusRows<T extends ContextFocusItem>(
  rows: T[],
  fields: string[],
): ContextFocusItem[] {
  return rows.map((row) => {
    const projected: Record<string, unknown> = {};
    const source = row as Record<string, unknown>;
    for (const field of fields) {
      projected[field] = source[field] ?? null;
    }
    return projected as unknown as ContextFocusItem;
  });
}

/** Implements resolve context output format for the public runtime surface of this module. */
export function resolveContextOutputFormat(
  options: ContextOptions,
  global: GlobalOptions,
): ContextOutputFormat {
  const commandFormat = parseOutputFormat(options.format);
  if (global.json && commandFormat && commandFormat !== "json") {
    throw new PmCliError(
      "Cannot combine --json with --format markdown|toon",
      EXIT_CODE.USAGE,
    );
  }
  if (global.json) {
    return "json";
  }
  return commandFormat ?? "toon";
}

// --depth full surfaces the entire backlog: when no explicit --limit is given,
// every section returns all rows instead of the default top-N sample.
function parseContextLimit(
  raw: string | undefined,
  depth: ContextDepth,
): number {
  return (
    parseIntegerLimit(raw, "--limit") ??
    (depth === "full" ? Number.MAX_SAFE_INTEGER : DEFAULT_CONTEXT_LIMIT)
  );
}

function resolveContextLimitAtScale(limit: number, itemCount: number): number {
  return itemCount >= CONTEXT_SCALE_THRESHOLD && limit === Number.MAX_SAFE_INTEGER
    ? DEFAULT_CONTEXT_LIMIT
    : limit;
}

/** Implements parse context depth for the public runtime surface of this module. */
export function parseContextDepth(
  raw: string | undefined,
  settings: ContextSettings,
): ContextDepth {
  if (!raw) return settings.default_depth;
  const normalized = raw.trim().toLowerCase();
  if (!CONTEXT_DEPTH_VALUES.includes(normalized as ContextDepth)) {
    throw new PmCliError(
      `Context --depth must be one of ${CONTEXT_DEPTH_VALUES.join("|")}`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized as ContextDepth;
}

/** Implements parse context sections for the public runtime surface of this module. */
export function parseContextSections(
  raw: string[] | undefined,
  depth: ContextDepth,
  settings: ContextSettings,
): ContextSectionName[] {
  if (raw && raw.length > 0) {
    const sections: ContextSectionName[] = [];
    for (const value of raw) {
      const normalized = value.trim().toLowerCase();
      if (!CONTEXT_SECTION_VALUES.includes(normalized as ContextSectionName)) {
        throw new PmCliError(
          `Context --section must be one of ${CONTEXT_SECTION_VALUES.join("|")}`,
          EXIT_CODE.USAGE,
        );
      }
      if (!sections.includes(normalized as ContextSectionName)) {
        sections.push(normalized as ContextSectionName);
      }
    }
    return sections;
  }
  if (depth === "brief") return [];
  // --depth full is the comprehensive snapshot: every known section, regardless
  // of the per-section settings toggles that brief/standard/deep respect.
  if (depth === "full") return [...CONTEXT_SECTION_VALUES];
  const pool = depth === "deep" ? DEEP_SECTIONS : STANDARD_SECTIONS;
  return pool.filter((section) => settings.sections[section]);
}

function parseActivityLimit(
  raw: string | undefined,
  settings: ContextSettings,
): number {
  if (!raw) return settings.activity_limit;
  const parsed = parseIntegerLimit(raw, "--activity-limit");
  /* c8 ignore start -- parseIntegerLimit either throws or returns a number; fallback is defensive typing guard */
  return parsed ?? settings.activity_limit;
  /* c8 ignore stop */
}

function parseStaleThresholdDays(
  raw: string | undefined,
  settings: ContextSettings,
): number {
  if (!raw) return settings.stale_threshold_days;
  const trimmed = raw.trim().toLowerCase();
  const match = /^(\d+)d?$/.exec(trimmed);
  if (!match) {
    throw new PmCliError(
      "--stale-threshold must be a number of days (e.g. 7 or 7d)",
      EXIT_CODE.USAGE,
    );
  }
  const days = parseInt(match[1], 10);
  if (days <= 0) {
    throw new PmCliError("--stale-threshold must be positive", EXIT_CODE.USAGE);
  }
  return days;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function statusRank(
  status: ItemStatus,
  statusRegistry: RuntimeStatusRegistry,
): number {
  const normalizedStatus = normalizeStatusForRegistry(status, statusRegistry);
  const inProgressStatus = normalizeStatusInput("in_progress", statusRegistry);
  const openStatus = normalizeStatusInput("open", statusRegistry);
  const blockedStatus = normalizeStatusInput("blocked", statusRegistry);
  const draftStatus = normalizeStatusInput("draft", statusRegistry);
  if (inProgressStatus && normalizedStatus === inProgressStatus) return 0;
  if (openStatus && normalizedStatus === openStatus) return 1;
  if (blockedStatus && normalizedStatus === blockedStatus) return 2;
  if (draftStatus && normalizedStatus === draftStatus) return 3;
  if (statusRegistry.active_statuses.has(normalizedStatus)) return 4;
  if (statusRegistry.blocked_statuses.has(normalizedStatus)) return 5;
  if (statusRegistry.terminal_statuses.has(normalizedStatus)) return 7;
  return 6;
}

function isClosedStatus(
  status: ItemStatus,
  statusRegistry: RuntimeStatusRegistry,
): boolean {
  const closeStatus = normalizeStatusInput("closed", statusRegistry);
  return normalizeStatusForRegistry(status, statusRegistry) === closeStatus;
}

function isInProgressStatus(
  status: ItemStatus,
  statusRegistry: RuntimeStatusRegistry,
): boolean {
  const inProgressStatus = normalizeStatusInput("in_progress", statusRegistry);
  return (
    normalizeStatusForRegistry(status, statusRegistry) === inProgressStatus
  );
}

function isOpenStatus(
  status: ItemStatus,
  statusRegistry: RuntimeStatusRegistry,
): boolean {
  const openStatus = normalizeStatusInput("open", statusRegistry);
  return normalizeStatusForRegistry(status, statusRegistry) === openStatus;
}

function isBlockedStatus(
  status: ItemStatus,
  statusRegistry: RuntimeStatusRegistry,
): boolean {
  return statusRegistry.blocked_statuses.has(
    normalizeStatusForRegistry(status, statusRegistry),
  );
}

// Projection flags belong to list/calendar/activity output shaping and must not
// leak into runContext's downstream calls, which need full ItemMetadata rows.
// --parent is a context-level subtree scope computed here transitively, so it
// must not reach runList (whose --parent matches direct children only).
const LIST_PROJECTION_FLAGS = [
  "compact",
  "brief",
  "fields",
  "includeBody",
  "include_body",
  "parent",
] as const;

function stripListProjectionFlags(
  options: ContextOptions,
): Record<string, unknown> {
  const copy: Record<string, unknown> = {
    ...(options as Record<string, unknown>),
  };
  for (const key of LIST_PROJECTION_FLAGS) {
    delete copy[key];
  }
  return copy;
}

/**
 * Resolves the transitive subtree (the anchor item plus every descendant via
 * parent links) so `--parent` can scope a snapshot to one epic/milestone. Reuses
 * the same {@link buildChildrenByParent}/{@link collectDescendants} helpers the
 * hierarchy section relies on, so subtree membership stays consistent across the
 * snapshot. Ids are normalized to lowercase for case-insensitive membership; the
 * `found` flag is false when the anchor id is absent from the corpus. Exported so
 * sibling read commands (e.g. `pm next`) can apply the same subtree scoping.
 */
export function collectSubtreeIds(
  corpus: ItemMetadata[],
  parentId: string,
): { ids: Set<string>; found: boolean } {
  const target = parentId.trim().toLowerCase();
  const anchor = corpus.find((item) => item.id.trim().toLowerCase() === target);
  if (!anchor) {
    return { ids: new Set<string>(), found: false };
  }
  const childrenByParent = buildChildrenByParent(corpus);
  const descendants = collectDescendants(anchor.id, childrenByParent);
  // Store normalized ids so membership checks are case-insensitive end-to-end.
  const ids = new Set<string>(
    [anchor.id, ...descendants.map((item) => item.id)].map((id) =>
      id.trim().toLowerCase(),
    ),
  );
  return { ids, found: true };
}

function parseContextParent(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new PmCliError(
      "Context --parent requires an item id",
      EXIT_CODE.USAGE,
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Sorting / mapping helpers (unchanged from original)
// ---------------------------------------------------------------------------

function compareOptionalOrder(
  left: number | null | undefined,
  right: number | null | undefined,
): number {
  const leftValue = left ?? null;
  const rightValue = right ?? null;
  if (leftValue === null && rightValue === null) return 0;
  if (leftValue === null) return 1;
  if (rightValue === null) return -1;
  return leftValue - rightValue;
}

function compareOptionalDeadline(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  const leftValue = left ?? null;
  const rightValue = right ?? null;
  if (leftValue === null && rightValue === null) return 0;
  if (leftValue === null) return 1;
  if (rightValue === null) return -1;
  return compareTimestampStrings(leftValue, rightValue);
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function hasNoInvalidDatePrefix(value: string): boolean {
  const match =
    LEADING_HYPHEN_DATE.exec(value) ?? LEADING_COMPACT_DATE.exec(value);
  if (!match) {
    return true;
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInUtcMonth(year, month - 1)
  );
}

function normalizeTimestampCandidate(value: string): string {
  const compactDate = COMPACT_DATE.exec(value);
  if (compactDate) {
    return `${compactDate[1]}-${compactDate[2]}-${compactDate[3]}`;
  }
  const compactDateTime = COMPACT_DATETIME.exec(value);
  if (compactDateTime) {
    const [, year, month, day, hour, minute, secondRaw, offsetRaw] =
      compactDateTime;
    const second = secondRaw ? `:${secondRaw}` : "";
    const offset =
      offsetRaw && offsetRaw.length === 5 && offsetRaw !== "Z"
        ? `${offsetRaw.slice(0, 3)}:${offsetRaw.slice(3)}`
        : (offsetRaw ?? "");
    return `${year}-${month}-${day}T${hour}:${minute}${second}${offset}`;
  }
  return value;
}

function parseContextTimestampMs(value: unknown): number {
  if (typeof value !== "string") {
    return Number.NaN;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || !hasNoInvalidDatePrefix(trimmed)) {
    return Number.NaN;
  }
  const parsed = Date.parse(normalizeTimestampCandidate(trimmed));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function sortableTimestamp(value: unknown): string {
  const parsed = parseContextTimestampMs(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function dateTokenForTimestamp(value: unknown): string {
  const parsed = parseContextTimestampMs(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().slice(0, 10)
    : "unknown";
}

function normalizedParentId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Ranks two items by work criticality: in-progress before open before blocked
 * before draft (via {@link statusRank}), then ascending priority, explicit order,
 * earliest deadline, most-recently-updated, and finally id for a total order.
 * Exported as the canonical focus ordering so sibling read commands (e.g.
 * `pm next`) recommend work in the exact same sequence as `pm context`.
 */
export function compareCriticalItems(
  left: ItemMetadata,
  right: ItemMetadata,
  statusRegistry: RuntimeStatusRegistry,
): number {
  const byStatus =
    statusRank(left.status, statusRegistry) -
    statusRank(right.status, statusRegistry);
  if (byStatus !== 0) return byStatus;
  const byPriority = left.priority - right.priority;
  if (byPriority !== 0) return byPriority;
  const byOrder = compareOptionalOrder(left.order, right.order);
  if (byOrder !== 0) return byOrder;
  const byDeadline = compareOptionalDeadline(left.deadline, right.deadline);
  if (byDeadline !== 0) return byDeadline;
  const byUpdated = compareTimestampStrings(
    sortableTimestamp(right.updated_at),
    sortableTimestamp(left.updated_at),
  );
  const byId = left.id.localeCompare(right.id);
  return byUpdated !== 0 ? byUpdated : byId;
}

function normalizedPressure(value: unknown, maximum: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return 0;
  return 1 - Math.min(Math.max(parsed, 0), maximum) / maximum;
}

function resolveDeadlinePressure(deadline: unknown, nowMs: number): number {
  const deadlineMs =
    typeof deadline === "string"
      ? Date.parse(deadline)
      : deadline instanceof Date
        ? deadline.getTime()
        : typeof deadline === "number"
          ? deadline
          : Number.NaN;
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) return 0;
  const deadlineDays = (deadlineMs - nowMs) / (24 * 60 * 60 * 1000);
  return deadlineDays <= 0 ? 1 : 1 / (1 + deadlineDays / 30);
}

function resolveRiskPressure(risk: ItemMetadata["risk"]): number {
  const normalized =
    typeof risk === "string" ? risk.trim().toLowerCase() : undefined;
  if (normalized === "critical" || normalized === "high") return 1;
  if (normalized === "medium") return 0.5;
  return normalized === "low" ? 0.1 : 0;
}

function buildItemContextRelevanceCandidate(
  item: ItemMetadata,
  params: {
    statusRegistry: RuntimeStatusRegistry;
    nowMs: number;
    normalizedAuthor: string | undefined;
    recencyRank: ReadonlyMap<string, number>;
    recencyDenominator: number;
    itemCount: number;
    usageAffinity?: Readonly<Record<string, number>>;
  },
): ContextRelevanceCandidate<ItemMetadata> {
  const assignedToAuthor =
    params.normalizedAuthor !== undefined &&
    typeof item.assignee === "string" &&
    item.assignee.trim().toLowerCase() === params.normalizedAuthor;
  const claimFocus = isInProgressStatus(item.status, params.statusRegistry)
    ? 1
    : assignedToAuthor
      ? 0.75
      : 0;
  const riskPressure = resolveRiskPressure(item.risk);
  const knowledgeEntries =
    (item.comments?.length ?? 0) +
    (item.notes?.length ?? 0) +
    (item.learnings?.length ?? 0);
  return {
    id: item.id,
    item,
    signals: {
      recency:
        params.itemCount === 1
          ? 1
          : 1 -
            (params.recencyRank.get(item.id) as number) /
              params.recencyDenominator,
      graph_proximity: item.parent ? 0.3 : 0,
      claim_focus: claimFocus,
      priority_pressure: normalizedPressure(item.priority, 4),
      risk_pressure: riskPressure,
      deadline_pressure: resolveDeadlinePressure(item.deadline, params.nowMs),
      knowledge_density: Math.min(knowledgeEntries / 5, 1),
      author_affinity: assignedToAuthor ? 1 : 0,
      usage_affinity: params.usageAffinity?.[item.id],
    },
  };
}

/** Derives the metadata signals currently available on compact item rows. More expensive history/index/semantic signals can be added by an extension scorer without changing the public candidate contract. */
export function buildItemContextRelevanceCandidates(
  items: readonly ItemMetadata[],
  statusRegistry: RuntimeStatusRegistry,
  now: string,
  author: string | undefined,
  usageAffinity?: Readonly<Record<string, number>>,
): ContextRelevanceCandidate<ItemMetadata>[] {
  const recencyOrder = [...items].sort(
    (left, right) =>
      compareTimestampStrings(
        sortableTimestamp(right.updated_at),
        sortableTimestamp(left.updated_at),
      ) || left.id.localeCompare(right.id),
  );
  const recencyRank = new Map(
    recencyOrder.map((item, index) => [item.id, index]),
  );
  const recencyDenominator = Math.max(items.length - 1, 1);
  const normalizedAuthor = author?.trim().toLowerCase();
  const nowMs = Date.parse(now);
  return items.map((item) =>
    buildItemContextRelevanceCandidate(item, {
      statusRegistry,
      nowMs,
      normalizedAuthor,
      recencyRank,
      recencyDenominator,
      itemCount: items.length,
      usageAffinity,
    }),
  );
}

const tokenEncoder = new TextEncoder();

function estimateJsonTokens(value: unknown): number {
  return Math.max(
    1,
    Math.ceil(tokenEncoder.encode(JSON.stringify(value)).length / 4),
  );
}

/** Packs a relevance report with monotone identity, summary, and full item projections. */
export function packRankedContextItems(
  report: ContextRelevanceReport<ItemMetadata>,
  tokenBudget: number,
  requiredIds: ReadonlySet<string> = new Set(),
  profile: "context" | "next" = "context",
): ContextPackingReport<ItemMetadata> {
  return packContextCandidates(
    report.ranked.map((entry) => ({
      id: entry.id,
      item: entry.item,
      rank: entry.rank,
      score: entry.score,
      required: requiredIds.has(entry.id),
      cluster: entry.item.parent?.trim() || entry.item.type,
      token_costs: {
        identity: estimateJsonTokens({ id: entry.id, title: entry.item.title }),
        summary: estimateJsonTokens({
          id: entry.id,
          title: entry.item.title,
          type: entry.item.type,
          status: entry.item.status,
          priority: entry.item.priority,
          parent: entry.item.parent,
        }),
        full: estimateJsonTokens(entry.item),
      },
    })),
    { tokenBudget, profile, latencyBudgetMs: 25 },
  );
}

/** Projects the SDK packer report onto the stable low-token command envelope. */
export function toContextPackingSummary(
  report: ContextPackingReport<ItemMetadata>,
): ContextPackingSummary {
  return {
    ...report,
    included: report.included.map((entry) => ({
      id: entry.id,
      projection: entry.projection,
      tokens: entry.tokens,
    })),
  };
}

/** Project a full scorer report onto the low-token command explanation shape. */
export function toContextRankingSummary<TItem>(
  report: ContextRelevanceReport<TItem>,
): ContextRankingSummary {
  return {
    model: report.model,
    available_signals: report.available_signals,
    items: report.ranked.map((entry) => ({
      id: entry.id,
      rank: entry.rank,
      baseline_rank: entry.baseline_rank,
      score: entry.score,
      contributions: entry.contributions,
    })),
  };
}

function completionPct(closed: number, total: number): number {
  return total > 0 ? Math.round((closed / total) * 100) : 0;
}

/** Indexes items by their parent id, yielding a parent→direct-children map used by the hierarchy/progress rollups and by focus-row child completion. Items without a parent are skipped. Exported so sibling read commands reuse the same index. */
export function buildChildrenByParent(
  allItems: ItemMetadata[],
): Map<string, ItemMetadata[]> {
  const childrenByParent = new Map<string, ItemMetadata[]>();
  for (const item of allItems) {
    const parent = normalizedParentId(item.parent);
    if (!parent) continue;
    const children = childrenByParent.get(parent) ?? [];
    children.push(item);
    childrenByParent.set(parent, children);
  }
  return childrenByParent;
}

/**
 * Projects an item onto the compact {@link ContextFocusItem} focus row. When both
 * a status registry and a parent→children index are supplied, it also folds in the
 * descendant rollup (`children_total`/`children_closed`/`completion_pct`). Exported
 * so sibling read commands (e.g. `pm next`) emit identically-shaped focus rows.
 */
export function toContextFocusItem(
  item: ItemMetadata,
  statusRegistry?: RuntimeStatusRegistry,
  childrenByParent?: Map<string, ItemMetadata[]>,
): ContextFocusItem {
  const focus: ContextFocusItem = {
    id: item.id,
    title: item.title,
    type: item.type,
    status: item.status,
    priority: item.priority,
    order: item.order ?? null,
    deadline: item.deadline ?? null,
    assignee: item.assignee ?? null,
    tags: Array.isArray(item.tags) ? [...item.tags] : [],
    updated_at: item.updated_at,
    parent: normalizedParentId(item.parent),
  };
  if (statusRegistry && childrenByParent) {
    const descendants = collectDescendants(item.id, childrenByParent);
    const total = descendants.length;
    if (total > 0) {
      const closed = descendants.filter((desc) =>
        isClosedStatus(desc.status, statusRegistry),
      ).length;
      focus.children_total = total;
      focus.children_closed = closed;
      focus.completion_pct = completionPct(closed, total);
    }
  }
  return focus;
}

function summarizeAgenda(events: CalendarRow[]): ContextAgendaSummary {
  let deadlines = 0;
  let reminders = 0;
  let scheduled = 0;
  const itemIds = new Set<string>();
  for (const event of events) {
    itemIds.add(event.item_id);
    if (event.kind === "deadline") {
      deadlines += 1;
      continue;
    }
    if (event.kind === "reminder") {
      reminders += 1;
      continue;
    }
    scheduled += 1;
  }
  return {
    events: events.length,
    items: itemIds.size,
    deadlines,
    reminders,
    scheduled,
  };
}

function mergeSortedWarnings(
  ...warningGroups: Array<string[] | undefined>
): string[] {
  return [...new Set(warningGroups.flatMap((group) => group ?? []))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function filterTerminalCalendarEvents(
  events: CalendarRow[],
  statusRegistry: RuntimeStatusRegistry,
): CalendarRow[] {
  return events.filter(
    (event) =>
      !statusRegistry.terminal_statuses.has(
        normalizeStatusForRegistry(event.item_status, statusRegistry),
      ),
  );
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildHierarchy(
  allItems: ItemMetadata[],
  activeItems: ItemMetadata[],
  statusRegistry: RuntimeStatusRegistry,
  limit: number,
): HierarchyNode[] {
  const itemMap = new Map<string, ItemMetadata>();
  for (const item of allItems) {
    itemMap.set(item.id, item);
  }

  const childrenByParent = buildChildrenByParent(allItems);

  const activeHighLevelIds = new Set(
    activeItems
      .filter((item) => HIGH_LEVEL_TYPES.has(item.type))
      .map((item) => item.id),
  );

  const nodes: HierarchyNode[] = [];
  for (const parentId of activeHighLevelIds) {
    const parent = itemMap.get(parentId);
    if (!parent) continue;
    const allDescendants = collectDescendants(parentId, childrenByParent);
    const childItems = childrenByParent.get(parentId) ?? [];

    let closedCount = 0;
    let openCount = 0;
    let inProgressCount = 0;
    let blockedCount = 0;
    /* c8 ignore start -- chained status-classification branch accounting is noisy under v8 for mixed descendant sets */
    for (const desc of allDescendants) {
      if (isClosedStatus(desc.status, statusRegistry)) closedCount++;
      else if (isInProgressStatus(desc.status, statusRegistry))
        inProgressCount++;
      else if (isBlockedStatus(desc.status, statusRegistry)) blockedCount++;
      else if (isOpenStatus(desc.status, statusRegistry)) openCount++;
    }
    /* c8 ignore stop */

    const children: HierarchyChild[] = childItems
      .sort((a, b) => compareCriticalItems(a, b, statusRegistry))
      .slice(0, limit)
      .map((child) => {
        const grandchildren = collectDescendants(child.id, childrenByParent);
        const gcClosed = grandchildren.filter((gc) =>
          isClosedStatus(gc.status, statusRegistry),
        ).length;
        return {
          id: child.id,
          title: child.title,
          type: child.type,
          status: child.status,
          children_total: grandchildren.length,
          children_closed: gcClosed,
        };
      });

    nodes.push({
      id: parent.id,
      title: parent.title,
      type: parent.type,
      status: parent.status,
      children_total: allDescendants.length,
      children_closed: closedCount,
      children_open: openCount,
      children_in_progress: inProgressCount,
      children_blocked: blockedCount,
      children,
    });
  }

  return nodes
    .sort((a, b) => {
      const aParent = itemMap.get(a.id)!;
      const bParent = itemMap.get(b.id)!;
      return compareCriticalItems(aParent, bParent, statusRegistry);
    })
    .slice(0, limit);
}

function collectDescendants(
  parentId: string,
  childrenByParent: Map<string, ItemMetadata[]>,
): ItemMetadata[] {
  const result: ItemMetadata[] = [];
  const stack = [parentId];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const children = childrenByParent.get(current) ?? [];
    for (const child of children) {
      result.push(child);
      stack.push(child.id);
    }
  }
  return result;
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  buildActivity,
  buildBlockers,
  buildChildrenByParent,
  buildHierarchy,
  buildHotFiles,
  buildProgress,
  buildRecentlyCreated,
  buildStaleness,
  buildTestHealth,
  buildUnparented,
  buildWorkload,
  collectDescendants,
  collectSubtreeIds,
  compareCriticalItems,
  compareOptionalDeadline,
  compareOptionalOrder,
  completionPct,
  dateTokenForTimestamp,
  filterTerminalCalendarEvents,
  isBlockedStatus,
  isClosedStatus,
  isInProgressStatus,
  isOpenStatus,
  mergeSortedWarnings,
  normalizedParentId,
  parseActivityLimit,
  parseContextLimit,
  resolveContextLimitAtScale,
  parseContextParent,
  parseContextTimestampMs,
  parseStaleThresholdDays,
  sortableTimestamp,
  statusRank,
  stripListProjectionFlags,
  summarizeAgenda,
  toContextFocusItem,
};

async function buildActivity(
  activityLimit: number,
  global: GlobalOptions,
): Promise<CompactActivityEntry[]> {
  const result = await runActivity(
    { compact: true, limit: String(activityLimit) },
    global,
  );
  return result.compact_activity ?? [];
}

function buildProgress(
  allItems: ItemMetadata[],
  activeItems: ItemMetadata[],
  statusRegistry: RuntimeStatusRegistry,
  limit: number,
): ProgressEntry[] {
  const childrenByParent = new Map<string, ItemMetadata[]>();
  for (const item of allItems) {
    if (!item.parent) continue;
    const children = childrenByParent.get(item.parent) ?? [];
    children.push(item);
    childrenByParent.set(item.parent, children);
  }

  const activeHighLevel = activeItems.filter((item) =>
    HIGH_LEVEL_TYPES.has(item.type),
  );
  const entries: ProgressEntry[] = [];
  for (const parent of activeHighLevel) {
    const descendants = collectDescendants(parent.id, childrenByParent);
    const total = descendants.length;
    if (total === 0) continue;

    let closed = 0;
    let open = 0;
    let inProgress = 0;
    let blocked = 0;
    /* c8 ignore start -- chained status-classification branch accounting is noisy under v8 for mixed descendant sets */
    for (const desc of descendants) {
      if (isClosedStatus(desc.status, statusRegistry)) closed++;
      else if (isInProgressStatus(desc.status, statusRegistry)) inProgress++;
      else if (isBlockedStatus(desc.status, statusRegistry)) blocked++;
      else if (isOpenStatus(desc.status, statusRegistry)) open++;
    }
    /* c8 ignore stop */

    entries.push({
      id: parent.id,
      title: parent.title,
      type: parent.type,
      total,
      closed,
      open,
      in_progress: inProgress,
      blocked,
      completion_pct: completionPct(closed, total),
    });
  }

  return entries
    .sort((a, b) => a.completion_pct - b.completion_pct)
    .slice(0, limit);
}

function buildBlockers(
  blockedItems: ItemMetadata[],
  itemMap: Map<string, ItemMetadata>,
  limit: number,
): BlockerEntry[] {
  return blockedItems.slice(0, limit).map((item) => {
    const blockerItem = item.blocked_by
      ? itemMap.get(item.blocked_by)
      : undefined;
    return {
      id: item.id,
      title: item.title,
      blocked_by: item.blocked_by ?? null,
      blocked_by_title: blockerItem?.title ?? null,
      blocked_by_status: blockerItem?.status ?? null,
      blocked_reason: item.blocked_reason ?? null,
      unblock_note: item.unblock_note ?? null,
    };
  });
}

function buildHotFiles(
  activeItems: ItemMetadata[],
  limit: number,
): HotFile[] {
  const fileMap = new Map<string, Set<string>>();
  for (const item of activeItems) {
    for (const file of item.files ?? []) {
      const existing = fileMap.get(file.path) ?? new Set<string>();
      existing.add(item.id);
      fileMap.set(file.path, existing);
    }
  }

  return [...fileMap.entries()]
    .map(([filePath, itemIds]) => ({
      path: filePath,
      references: itemIds.size,
      items: [...itemIds].sort(),
    }))
    .sort((a, b) => b.references - a.references)
    .slice(0, limit);
}

function buildWorkload(
  activeItems: ItemMetadata[],
  statusRegistry: RuntimeStatusRegistry,
  limit: number,
): WorkloadEntry[] {
  const groups = new Map<string | null, ItemMetadata[]>();
  for (const item of activeItems) {
    const key = item.assignee ?? null;
    const existing = groups.get(key) ?? [];
    existing.push(item);
    groups.set(key, existing);
  }

  return [...groups.entries()]
    .map(([assignee, items]) => ({
      assignee,
      active: items.length,
      in_progress: items.filter((item) =>
        isInProgressStatus(item.status, statusRegistry),
      ).length,
      items: items.map((item) => item.id).sort(),
    }))
    .sort((a, b) => b.active - a.active)
    .slice(0, limit);
}

function buildStaleness(
  allNonTerminal: ItemMetadata[],
  staleThresholdDays: number,
  now: string,
  limit: number,
): StaleEntry[] {
  const cutoffMs =
    new Date(now).getTime() - staleThresholdDays * 24 * 60 * 60 * 1000;

  return allNonTerminal
    .filter((item) => new Date(item.updated_at).getTime() < cutoffMs)
    .map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      updated_at: item.updated_at,
      stale_days: Math.floor(
        (new Date(now).getTime() - new Date(item.updated_at).getTime()) /
          (24 * 60 * 60 * 1000),
      ),
    }))
    .sort((a, b) => b.stale_days - a.stale_days)
    .slice(0, limit);
}

function buildRecentlyCreated(
  allNonTerminal: ItemMetadata[],
  statusRegistry: RuntimeStatusRegistry,
  childrenByParent: Map<string, ItemMetadata[]>,
  limit: number,
): RecentContextItem[] {
  return allNonTerminal
    .map((item) => ({ item, sortKey: sortableTimestamp(item.created_at) }))
    .sort((left, right) => {
      const byCreated = compareTimestampStrings(right.sortKey, left.sortKey);
      return byCreated !== 0
        ? byCreated
        : left.item.id.localeCompare(right.item.id);
    })
    .slice(0, limit)
    .map(({ item }) => ({
      ...toContextFocusItem(item, statusRegistry, childrenByParent),
      created_at: item.created_at,
    }));
}

function buildUnparented(
  allNonTerminal: ItemMetadata[],
  statusRegistry: RuntimeStatusRegistry,
  childrenByParent: Map<string, ItemMetadata[]>,
  limit: number,
): ContextFocusItem[] {
  return allNonTerminal
    .filter(
      (item) =>
        !normalizedParentId(item.parent) && !HIGH_LEVEL_TYPES.has(item.type),
    )
    .sort((left, right) => compareCriticalItems(left, right, statusRegistry))
    .slice(0, limit)
    .map((item) => toContextFocusItem(item, statusRegistry, childrenByParent));
}

function buildTestHealth(activeItems: ItemMetadata[]): TestHealthSummary {
  let itemsWithTests = 0;
  let itemsWithRecentRuns = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const itemsFailing: string[] = [];

  for (const item of activeItems) {
    if ((item.tests ?? []).length > 0) {
      itemsWithTests++;
    }
    const runs = item.test_runs ?? [];
    if (runs.length > 0) {
      itemsWithRecentRuns++;
      let itemHasFailure = false;
      for (const run of runs) {
        passed += run.passed ?? 0;
        failed += run.failed ?? 0;
        skipped += run.skipped ?? 0;
        if ((run.failed ?? 0) > 0) {
          itemHasFailure = true;
        }
      }
      if (itemHasFailure) {
        itemsFailing.push(item.id);
      }
    }
  }

  return {
    items_with_tests: itemsWithTests,
    items_with_recent_runs: itemsWithRecentRuns,
    recent_runs: { passed, failed, skipped },
    items_failing: itemsFailing.sort(),
  };
}

// ---------------------------------------------------------------------------
// Markdown formatting
// ---------------------------------------------------------------------------

function formatClock(timestamp: string): string {
  return `${new Date(timestamp).toISOString().slice(11, 16)}Z`;
}

function formatFocusLine(item: ContextFocusItem): string {
  const orderToken = item.order === null ? "-" : String(item.order);
  const deadlineToken = item.deadline ?? "-";
  const parentToken = item.parent ? ` parent:${item.parent}` : "";
  const progressToken =
    item.children_total !== undefined &&
    item.children_closed !== undefined &&
    item.completion_pct !== undefined
      ? ` children:${item.children_closed}/${item.children_total} done:${item.completion_pct}%`
      : "";
  return `${item.id} p${item.priority} ${item.status} ${item.type} order:${orderToken} deadline:${deadlineToken}${parentToken}${progressToken} ${item.title}`;
}

// Renders a focus row projected to a `--fields` subset as space-separated
// field:value tokens, mirroring the projection field order. Array values join
// with commas; missing/null values render as `-`.
function formatProjectedFocusLine(
  item: ContextFocusItem,
  fields: string[],
): string {
  const source = item as unknown as Record<string, unknown>;
  return fields
    .map((field) => {
      const value = source[field];
      if (Array.isArray(value)) return `${field}:${value.join(",")}`;
      return `${field}:${value ?? "-"}`;
    })
    .join(" ");
}

function formatAgendaLine(event: CalendarRow): string {
  const base = `${formatClock(event.at)} [${event.kind}] ${event.item_id} p${event.item_priority} ${event.item_status} ${event.item_title}`;
  if (event.kind === "reminder") {
    return `${base} — ${event.reminder_text}`;
  }
  if (event.kind === "event") {
    const recurringSuffix = event.event_recurring ? " (recurring)" : "";
    const title = event.event_title ?? event.item_title;
    return `${base} — ${title}${recurringSuffix}`;
  }
  return base;
}

function pushContextFocusSection(
  lines: string[],
  title: string,
  rows: ContextFocusItem[],
  emptyText: string,
  renderFocus: (item: ContextFocusItem) => string,
): void {
  lines.push(`## ${title}`);
  if (rows.length === 0) {
    lines.push(emptyText);
  } else {
    for (const item of rows) {
      lines.push(`- ${renderFocus(item)}`);
    }
  }
  lines.push("");
}

function pushBlockedFallbackSection(
  lines: string[],
  result: ContextResult,
  renderFocus: (item: ContextFocusItem) => string,
): void {
  if (result.blocked_fallback.length === 0) {
    return;
  }
  lines.push("## Blocked fallback");
  for (const item of result.blocked_fallback) {
    lines.push(`- ${renderFocus(item)}`);
  }
  lines.push("");
}

function pushAgendaSection(lines: string[], result: ContextResult): void {
  lines.push("## Agenda");
  lines.push(
    `- events: ${result.agenda.summary.events} (deadlines: ${result.agenda.summary.deadlines}, reminders: ${result.agenda.summary.reminders}, scheduled: ${result.agenda.summary.scheduled})`,
  );
  if (result.agenda.events.length === 0) {
    lines.push("No agenda events matched the selected filters.");
  } else {
    for (const event of result.agenda.events) {
      lines.push(`- ${formatAgendaLine(event)}`);
    }
  }
  lines.push("");
}

function pushHierarchySection(lines: string[], result: ContextResult): void {
  if (!result.hierarchy || result.hierarchy.length === 0) {
    return;
  }
  lines.push("## Hierarchy");
  for (const node of result.hierarchy) {
    const pct =
      node.children_total > 0
        ? Math.round((node.children_closed / node.children_total) * 100)
        : 0;
    lines.push(
      `- ${node.id} ${node.type} ${node.status} "${node.title}" [${node.children_closed}/${node.children_total} done ${pct}%]`,
    );
    for (const child of node.children) {
      const cpct =
        child.children_total > 0
          ? Math.round((child.children_closed / child.children_total) * 100)
          : 0;
      lines.push(
        `  - ${child.id} ${child.type} ${child.status} "${child.title}" [${child.children_closed}/${child.children_total} done ${cpct}%]`,
      );
    }
  }
  lines.push("");
}

function pushProgressSection(lines: string[], result: ContextResult): void {
  if (!result.progress || result.progress.length === 0) {
    return;
  }
  lines.push("## Progress");
  for (const entry of result.progress) {
    lines.push(
      `- ${entry.id} "${entry.title}" ${entry.completion_pct}% (${entry.closed}/${entry.total} closed, ${entry.in_progress} wip, ${entry.open} open, ${entry.blocked} blocked)`,
    );
  }
  lines.push("");
}

function pushRecentlyCreatedSection(
  lines: string[],
  result: ContextResult,
  focusFields: string[] | undefined,
  renderFocus: (item: ContextFocusItem) => string,
): void {
  if (!result.recently_created || result.recently_created.length === 0) {
    return;
  }
  lines.push("## Recently created");
  for (const item of result.recently_created) {
    lines.push(
      focusFields
        ? `- ${renderFocus(item)}`
        : `- ${dateTokenForTimestamp(item.created_at)} ${formatFocusLine(item)}`,
    );
  }
  lines.push("");
}

function pushUnparentedSection(
  lines: string[],
  result: ContextResult,
  renderFocus: (item: ContextFocusItem) => string,
): void {
  if (!result.unparented || result.unparented.length === 0) {
    return;
  }
  lines.push("## Unparented");
  for (const item of result.unparented) {
    lines.push(`- ${renderFocus(item)}`);
  }
  lines.push("");
}

function pushActivitySection(lines: string[], result: ContextResult): void {
  if (!result.activity || result.activity.length === 0) {
    return;
  }
  lines.push("## Recent activity");
  for (const entry of result.activity) {
    const msg = entry.msg ? ` ${entry.msg}` : "";
    lines.push(
      `- ${entry.ts.slice(0, 16)}Z ${entry.id} ${entry.op} by:${entry.author}${msg}`,
    );
  }
  lines.push("");
}

function pushBlockersSection(lines: string[], result: ContextResult): void {
  if (!result.blockers || result.blockers.length === 0) {
    return;
  }
  lines.push("## Blockers");
  for (const entry of result.blockers) {
    const by = entry.blocked_by
      ? `blocked_by:${entry.blocked_by}(${entry.blocked_by_status ?? "?"})`
      : "blocked_by:-";
    const reason = entry.blocked_reason
      ? ` reason:"${entry.blocked_reason}"`
      : "";
    const note = entry.unblock_note ? ` unblock:"${entry.unblock_note}"` : "";
    lines.push(`- ${entry.id} "${entry.title}" ${by}${reason}${note}`);
  }
  lines.push("");
}

function pushFilesSection(lines: string[], result: ContextResult): void {
  if (!result.files || result.files.length === 0) {
    return;
  }
  lines.push("## Hot files");
  for (const file of result.files) {
    lines.push(
      `- ${file.path} refs:${file.references} items:[${file.items.join(",")}]`,
    );
  }
  lines.push("");
}

function pushWorkloadSection(lines: string[], result: ContextResult): void {
  if (!result.workload || result.workload.length === 0) {
    return;
  }
  lines.push("## Workload");
  for (const entry of result.workload) {
    const who = entry.assignee ?? "(unassigned)";
    lines.push(
      `- ${who} active:${entry.active} wip:${entry.in_progress} items:[${entry.items.join(",")}]`,
    );
  }
  lines.push("");
}

function pushStalenessSection(lines: string[], result: ContextResult): void {
  if (!result.staleness || result.staleness.length === 0) {
    return;
  }
  lines.push("## Stale items");
  for (const entry of result.staleness) {
    lines.push(
      `- ${entry.id} ${entry.status} stale:${entry.stale_days}d last:${entry.updated_at.slice(0, 10)} "${entry.title}"`,
    );
  }
  lines.push("");
}

function pushTestHealthSection(lines: string[], result: ContextResult): void {
  if (!result.tests) {
    return;
  }
  lines.push("## Test health");
  lines.push(`- items_with_tests: ${result.tests.items_with_tests}`);
  lines.push(
    `- items_with_recent_runs: ${result.tests.items_with_recent_runs}`,
  );
  lines.push(
    `- passed: ${result.tests.recent_runs.passed}, failed: ${result.tests.recent_runs.failed}, skipped: ${result.tests.recent_runs.skipped}`,
  );
  if (result.tests.items_failing.length > 0) {
    lines.push(`- items_failing: [${result.tests.items_failing.join(",")}]`);
  }
  lines.push("");
}

function pushEmptyContextSuggestions(
  lines: string[],
  result: ContextResult,
): void {
  const isEmpty =
    result.summary.active_items === 0 &&
    result.summary.blocked === 0 &&
    result.agenda.summary.events === 0;
  if (!isEmpty) {
    return;
  }
  lines.push("## Suggestions");
  lines.push("No active work items or upcoming events. Consider:");
  lines.push('- `pm create --type Task --title "..."` to add a new work item');
  lines.push(
    "- `pm list --status closed --limit 5` to review recent completions",
  );
  lines.push("- `pm search <keywords>` to find related past work");
  lines.push("- `pm aggregate` for a full project status overview");
}

/** Implements render context markdown for the public runtime surface of this module. */
export function renderContextMarkdown(result: ContextResult): string {
  const lines: string[] = [];
  const focusFields = result.focus_fields;
  const renderFocus = (item: ContextFocusItem): string =>
    focusFields
      ? formatProjectedFocusLine(item, focusFields)
      : formatFocusLine(item);
  lines.push("# pm context");
  lines.push("");
  lines.push(`- now: ${result.now}`);
  lines.push(`- depth: ${result.depth}`);
  if (result.filters.parent) {
    lines.push(`- scope: subtree of ${result.filters.parent}`);
  }
  lines.push(
    `- active_items: ${result.summary.active_items} (in_progress: ${result.summary.in_progress}, open: ${result.summary.open})`,
  );
  if (result.summary.total_items !== undefined) {
    lines.push(
      `- total_items: ${result.summary.total_items} (closed: ${result.summary.closed ?? 0}, canceled: ${result.summary.canceled ?? 0})`,
    );
  }
  lines.push(`- agenda_events: ${result.summary.agenda_events}`);
  lines.push(
    `- blocked_fallback_used: ${result.summary.blocked_fallback_used}`,
  );
  const renderedSections = result.sections_included.filter(
    (section) => section !== "blockers" || (result.blockers?.length ?? 0) > 0,
  );
  if (renderedSections.length > 0) {
    lines.push(`- sections: ${renderedSections.join(", ")}`);
  }
  lines.push("");

  pushContextFocusSection(
    lines,
    "High-level focus",
    result.high_level,
    "No high-level active items.",
    renderFocus,
  );
  pushContextFocusSection(
    lines,
    "Low-level focus",
    result.low_level,
    "No low-level active items.",
    renderFocus,
  );
  pushBlockedFallbackSection(lines, result, renderFocus);
  pushAgendaSection(lines, result);
  pushHierarchySection(lines, result);
  pushProgressSection(lines, result);
  pushRecentlyCreatedSection(lines, result, focusFields, renderFocus);
  pushUnparentedSection(lines, result, renderFocus);
  pushActivitySection(lines, result);
  pushBlockersSection(lines, result);
  pushFilesSection(lines, result);
  pushWorkloadSection(lines, result);
  pushStalenessSection(lines, result);
  pushTestHealthSection(lines, result);
  pushEmptyContextSuggestions(lines, result);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

interface ContextRuntime {
  settings: PmSettings;
  contextSettings: ContextSettings;
  statusRegistry: RuntimeStatusRegistry;
  depth: ContextDepth;
  limit: number;
  sectionsIncluded: ContextSectionName[];
  activityLimit: number;
  staleThresholdDays: number;
  parentScope: string | undefined;
  focusFields: string[] | undefined;
  baseListOptions: Record<string, unknown>;
}

interface ContextCorpus {
  listed: Awaited<ReturnType<typeof runList>>;
  listedItemMetadata: ItemMetadata[];
  allItems: ItemMetadata[];
  fullCorpus: ItemMetadata[];
  subtreeIds: Set<string> | undefined;
}

interface ContextFocusGroups {
  activeItems: ItemMetadata[];
  blockedItems: ItemMetadata[];
  highLevel: ContextFocusItem[];
  lowLevel: ContextFocusItem[];
  blockedFallback: ContextFocusItem[];
  blockedFallbackUsed: boolean;
  ranking: ContextRelevanceReport<ItemMetadata>;
  packing: ContextPackingReport<ItemMetadata>;
  pageExtras: {
    has_more?: boolean;
    next_cursor?: string;
    applied_limit?: number;
    truncated?: true;
  };
}

interface ContextOptionalSections {
  hierarchy?: HierarchyNode[];
  activity?: CompactActivityEntry[];
  progress?: ProgressEntry[];
  blockersSection?: BlockerEntry[];
  recentlyCreated?: RecentContextItem[];
  unparented?: ContextFocusItem[];
  filesSection?: HotFile[];
  workload?: WorkloadEntry[];
  staleness?: StaleEntry[];
  tests?: TestHealthSummary;
}

async function resolveContextRuntime(
  options: ContextOptions,
  global: GlobalOptions,
): Promise<ContextRuntime> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const settings = await readSettings(pmRoot);
  /* c8 ignore start -- settings persistence currently always materializes context defaults */
  const contextSettings = settings.context ?? SETTINGS_DEFAULTS.context;
  /* c8 ignore stop */
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const depth = parseContextDepth(options.depth, contextSettings);
  return {
    settings,
    contextSettings,
    statusRegistry,
    depth,
    limit: parseContextLimit(options.limit ?? options.maxItems, depth),
    sectionsIncluded: parseContextSections(
      options.section,
      depth,
      contextSettings,
    ),
    activityLimit: parseActivityLimit(options.activityLimit, contextSettings),
    staleThresholdDays: parseStaleThresholdDays(
      options.staleThreshold,
      contextSettings,
    ),
    parentScope: parseContextParent(options.parent),
    focusFields: parseContextFocusFields(options.fields),
    baseListOptions: stripListProjectionFlags(options),
  };
}

function contextNeedsAllItems(sectionsIncluded: ContextSectionName[]): boolean {
  return sectionsIncluded.some((section) =>
    [
      "hierarchy",
      "progress",
      "blockers",
      "staleness",
      "recently_created",
      "unparented",
    ].includes(section),
  );
}

function buildUnpaginatedContextListOptions(
  baseListOptions: Record<string, unknown>,
  extra: Partial<ListOptions>,
): ListOptions {
  return {
    ...baseListOptions,
    ...extra,
    noTruncate: true,
    limit: undefined,
    offset: undefined,
    after: undefined,
  };
}

async function loadContextCorpus(
  options: ContextOptions,
  global: GlobalOptions,
  runtime: ContextRuntime,
): Promise<ContextCorpus> {
  const needsAllItems = contextNeedsAllItems(runtime.sectionsIncluded);
  const listOptions = buildUnpaginatedContextListOptions(
    runtime.baseListOptions,
    { excludeTerminal: true },
  );
  const listed = await runList(undefined, listOptions, global);
  let listedItemMetadata = listed.items as ItemMetadata[];
  let allItems: ItemMetadata[] = listedItemMetadata;
  if (needsAllItems || runtime.parentScope !== undefined) {
    const allListed = await runList(
      undefined,
      buildUnpaginatedContextListOptions(runtime.baseListOptions, {
        excludeTerminal: false,
      }),
      global,
    );
    allItems = allListed.items as ItemMetadata[];
  }
  const fullCorpus = allItems;
  const subtreeIds = resolveContextSubtreeIds(runtime.parentScope, fullCorpus);
  if (subtreeIds) {
    listedItemMetadata = listedItemMetadata.filter((item) =>
      subtreeIds.has(item.id.trim().toLowerCase()),
    );
    allItems = allItems.filter((item) =>
      subtreeIds.has(item.id.trim().toLowerCase()),
    );
  }
  return { listed, listedItemMetadata, allItems, fullCorpus, subtreeIds };
}

function resolveContextSubtreeIds(
  parentScope: string | undefined,
  fullCorpus: ItemMetadata[],
): Set<string> | undefined {
  if (parentScope === undefined) {
    return undefined;
  }
  const subtree = collectSubtreeIds(fullCorpus, parentScope);
  if (!subtree.found) {
    throw new PmCliError(
      `Context --parent item not found: ${parentScope}`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  return subtree.ids;
}

async function resolveContextFocusGroups(
  listedItemMetadata: ItemMetadata[],
  allItems: ItemMetadata[],
  statusRegistry: RuntimeStatusRegistry,
  sectionsIncluded: ContextSectionName[],
  limit: number,
  now: string,
  author: string,
  cursor: string | undefined,
  cursorFingerprint: string,
  useBoundedPage: boolean,
  pmRoot: string,
): Promise<ContextFocusGroups> {
  const structural = [...listedItemMetadata].sort((left, right) =>
    compareCriticalItems(left, right, statusRegistry),
  );
  const usage = await readContextUsageAffinity({
    pmRoot,
    author,
    enabled: process.env.PM_CONTEXT_USAGE_DISABLED !== "1",
  });
  const ranking = await scoreContextCandidatesWithActiveExtensions(
    "context",
    buildItemContextRelevanceCandidates(
      structural,
      statusRegistry,
      now,
      author,
      usage.affinity,
    ),
  );
  const packing = packRankedContextItems(ranking, Math.max(256, limit * 160));
  const ranked = packing.included.map((entry) => entry.item);
  const activeStatuses = statusRegistry.active_statuses;
  const activeItems = ranked.filter((item) =>
    activeStatuses.has(normalizeStatusForRegistry(item.status, statusRegistry)),
  );
  const pageStart = useBoundedPage
    ? resolveQueryCursorStart(
        activeItems,
        cursor,
        cursorFingerprint,
        (item) => item.id,
      )
    : 0;
  const focusPage = useBoundedPage
    ? activeItems.slice(pageStart, pageStart + limit)
    : activeItems;
  const hasMore =
    useBoundedPage &&
    focusPage.length > 0 &&
    pageStart + focusPage.length < activeItems.length;
  const nextCursor =
    hasMore && focusPage.length > 0
      ? encodeQueryCursor(
          cursorFingerprint,
          focusPage[focusPage.length - 1]!.id,
          pageStart + focusPage.length - 1,
        )
      : undefined;
  const blockedItems = ranked.filter((item) =>
    statusRegistry.blocked_statuses.has(
      normalizeStatusForRegistry(item.status, statusRegistry),
    ),
  );
  const childrenByParent = buildChildrenByParent(allItems);
  const focusChildrenByParent = contextNeedsAllItems(sectionsIncluded)
    ? childrenByParent
    : undefined;
  const highLevel = focusPage
    .filter((item) => HIGH_LEVEL_TYPES.has(item.type))
    .slice(0, useBoundedPage ? focusPage.length : limit)
    .map((item) =>
      toContextFocusItem(item, statusRegistry, focusChildrenByParent),
    );
  const lowLevel = focusPage
    .filter((item) => !HIGH_LEVEL_TYPES.has(item.type))
    .slice(0, useBoundedPage ? focusPage.length : limit)
    .map((item) =>
      toContextFocusItem(item, statusRegistry, focusChildrenByParent),
    );
  const blockedFallbackUsed = activeItems.length === 0;
  return {
    activeItems,
    blockedItems,
    highLevel,
    lowLevel,
    blockedFallback: blockedFallbackUsed
      ? blockedItems
          .slice(0, limit)
          .map((item) =>
            toContextFocusItem(item, statusRegistry, focusChildrenByParent),
          )
      : [],
    blockedFallbackUsed,
    ranking,
    packing,
    pageExtras: {
      ...(useBoundedPage ? { applied_limit: limit } : {}),
      ...(hasMore ? { has_more: true, truncated: true } : {}),
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    },
  };
}

function buildContextCursorFingerprint(options: ContextOptions): string {
  const normalizedOptions: Record<string, unknown> = { ...options };
  delete normalizedOptions.after;
  delete normalizedOptions.limit;
  delete normalizedOptions.maxItems;
  delete normalizedOptions.format;
  delete normalizedOptions.fields;
  delete normalizedOptions.section;
  delete normalizedOptions.activityLimit;
  delete normalizedOptions.staleThreshold;
  delete normalizedOptions.explainRanking;
  return createQueryFingerprint("context", normalizedOptions);
}

function shouldPageContextFocus(
  options: ContextOptions,
  corpusItemCount: number,
): boolean {
  return (
    options.limit !== undefined ||
    options.maxItems !== undefined ||
    options.after !== undefined ||
    corpusItemCount >= CONTEXT_SCALE_THRESHOLD
  );
}

async function buildContextAgenda(
  options: ContextOptions,
  global: GlobalOptions,
  runtime: ContextRuntime,
  subtreeIds: Set<string> | undefined,
): Promise<{
  agenda: Awaited<ReturnType<typeof runCalendar>>;
  agendaEvents: CalendarRow[];
  agendaSummary: ContextAgendaSummary;
}> {
  const calendarOptions: CalendarOptions = {
    ...runtime.baseListOptions,
    view: "agenda",
    include: "all",
    limit:
      runtime.parentScope === undefined ? String(runtime.limit) : undefined,
  };
  const agenda = await runCalendar(calendarOptions, global);
  const scopedAgenda =
    subtreeIds === undefined
      ? agenda.events
      : agenda.events.filter((event) =>
          subtreeIds.has(event.item_id.trim().toLowerCase()),
        );
  const agendaEvents = filterTerminalCalendarEvents(
    scopedAgenda,
    runtime.statusRegistry,
  ).slice(0, runtime.limit);
  return { agenda, agendaEvents, agendaSummary: summarizeAgenda(agendaEvents) };
}

function countContextStatus(
  items: ItemMetadata[],
  status: string | undefined,
  statusRegistry: RuntimeStatusRegistry,
): number {
  const targetStatus = String(status);
  return items.filter(
    (item) =>
      normalizeStatusForRegistry(item.status, statusRegistry) === targetStatus,
  ).length;
}

async function buildOptionalContextSections(params: {
  runtime: ContextRuntime;
  allItems: ItemMetadata[];
  fullCorpus: ItemMetadata[];
  focusGroups: ContextFocusGroups;
  now: string;
  global: GlobalOptions;
}): Promise<ContextOptionalSections> {
  const { runtime, allItems, fullCorpus, focusGroups, now, global } = params;
  const childrenByParent = buildChildrenByParent(allItems);
  const itemMap = new Map(fullCorpus.map((item) => [item.id, item]));
  const allNonTerminal = allItems.filter(
    (item) => !isTerminalStatus(item.status, runtime.statusRegistry),
  );
  const has = (section: ContextSectionName) =>
    runtime.sectionsIncluded.includes(section);
  return {
    hierarchy: has("hierarchy")
      ? buildHierarchy(
          allItems,
          focusGroups.activeItems,
          runtime.statusRegistry,
          runtime.limit,
        )
      : undefined,
    activity: has("activity")
      ? await buildActivity(runtime.activityLimit, global)
      : undefined,
    progress: has("progress")
      ? buildProgress(
          allItems,
          focusGroups.activeItems,
          runtime.statusRegistry,
          runtime.limit,
        )
      : undefined,
    blockersSection: has("blockers")
      ? buildBlockers(focusGroups.blockedItems, itemMap, runtime.limit)
      : undefined,
    recentlyCreated: has("recently_created")
      ? buildRecentlyCreated(
          allNonTerminal,
          runtime.statusRegistry,
          childrenByParent,
          runtime.limit,
        )
      : undefined,
    unparented: has("unparented")
      ? buildUnparented(
          allNonTerminal,
          runtime.statusRegistry,
          childrenByParent,
          runtime.limit,
        )
      : undefined,
    filesSection: has("files")
      ? buildHotFiles(focusGroups.activeItems, runtime.limit)
      : undefined,
    workload: has("workload")
      ? buildWorkload(
          focusGroups.activeItems,
          runtime.statusRegistry,
          runtime.limit,
        )
      : undefined,
    staleness: has("staleness")
      ? buildStaleness(
          allNonTerminal,
          runtime.staleThresholdDays,
          now,
          runtime.limit,
        )
      : undefined,
    tests: has("tests") ? buildTestHealth(focusGroups.activeItems) : undefined,
  };
}

function buildContextSummaryExtras(
  needsAllItems: boolean,
  allItems: ItemMetadata[],
  statusRegistry: RuntimeStatusRegistry,
): Pick<ContextSummary, "total_items" | "closed" | "canceled"> {
  if (!needsAllItems) {
    return {};
  }
  const canceledStatus = normalizeStatusInput("canceled", statusRegistry);
  return {
    total_items: allItems.length,
    closed: allItems.filter((item) =>
      isClosedStatus(item.status, statusRegistry),
    ).length,
    canceled: allItems.filter(
      (item) =>
        normalizeStatusForRegistry(item.status, statusRegistry) ===
        canceledStatus,
    ).length,
  };
}

function attachOptionalContextSections(
  result: ContextResult,
  sections: ContextOptionalSections,
): void {
  if (sections.hierarchy) result.hierarchy = sections.hierarchy;
  if (sections.activity) result.activity = sections.activity;
  if (sections.progress) result.progress = sections.progress;
  if (sections.blockersSection) result.blockers = sections.blockersSection;
  if (sections.recentlyCreated)
    result.recently_created = sections.recentlyCreated;
  if (sections.unparented) result.unparented = sections.unparented;
  if (sections.filesSection) result.files = sections.filesSection;
  if (sections.workload) result.workload = sections.workload;
  if (sections.staleness) result.staleness = sections.staleness;
  if (sections.tests) result.tests = sections.tests;
}

function applyContextFocusProjection(
  result: ContextResult,
  focusFields: string[] | undefined,
): void {
  if (!focusFields) {
    return;
  }
  result.focus_fields = focusFields;
  result.high_level = projectContextFocusRows(result.high_level, focusFields);
  result.low_level = projectContextFocusRows(result.low_level, focusFields);
  result.blocked_fallback = projectContextFocusRows(
    result.blocked_fallback,
    focusFields,
  );
  if (result.recently_created) {
    result.recently_created = projectContextFocusRows(
      result.recently_created,
      focusFields,
    ) as RecentContextItem[];
  }
  if (result.unparented) {
    result.unparented = projectContextFocusRows(result.unparented, focusFields);
  }
}

function maybeAttachEmptyContextSuggestions(
  result: ContextResult,
  activeItems: ItemMetadata[],
  blockedItems: ItemMetadata[],
): void {
  if (
    activeItems.length > 0 ||
    blockedItems.length > 0 ||
    result.agenda.events.length > 0
  ) {
    return;
  }
  result.suggestions = [
    'pm create --type Task --title "..." to add a new work item',
    "pm list --status closed --limit 5 to review recent completions",
    "pm search <keywords> to find related past work",
    "pm aggregate for a full project status overview",
  ];
}

async function attachContextUsageFeedback(
  result: ContextResult,
  focusGroups: ContextFocusGroups,
  pmRoot: string,
  author: string,
): Promise<void> {
  try {
    const included = new Set(
      focusGroups.packing.included.map((entry) => entry.id),
    );
    await recordContextUsageServing({
      pmRoot,
      author,
      surface: "context",
      profile: focusGroups.packing.profile,
      rows: focusGroups.ranking.ranked.map((entry) => ({
        id: entry.id,
        rank: entry.rank,
        included: included.has(entry.id),
      })),
      enabled: process.env.PM_CONTEXT_USAGE_DISABLED !== "1",
    });
  } catch {
    result.warnings = mergeSortedWarnings(result.warnings, [
      "context_usage_feedback_write_failed",
    ]);
  }
}

/** Implements run context for the public runtime surface of this module. */
export async function runContext(
  options: ContextOptions,
  global: GlobalOptions,
): Promise<ContextResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const resolvedRuntime = await resolveContextRuntime(options, global);
  const corpus = await loadContextCorpus(options, global, resolvedRuntime);
  const runtime = {
    ...resolvedRuntime,
    limit: resolveContextLimitAtScale(
      resolvedRuntime.limit,
      corpus.fullCorpus.length,
    ),
  };
  const author = process.env.PM_AUTHOR ?? runtime.settings.author_default;
  const focusGroups = await resolveContextFocusGroups(
    corpus.listedItemMetadata,
    corpus.allItems,
    runtime.statusRegistry,
    runtime.sectionsIncluded,
    runtime.limit,
    nowIso(),
    author,
    options.after,
    buildContextCursorFingerprint(options),
    shouldPageContextFocus(options, corpus.fullCorpus.length),
    pmRoot,
  );
  const agendaContext = await buildContextAgenda(
    options,
    global,
    runtime,
    corpus.subtreeIds,
  );
  const warnings = mergeSortedWarnings(
    corpus.listed.warnings,
    agendaContext.agenda.warnings,
    focusGroups.ranking.warnings,
  );
  const inProgressCount = countContextStatus(
    focusGroups.activeItems,
    normalizeStatusInput("in_progress", runtime.statusRegistry),
    runtime.statusRegistry,
  );
  const openCount = countContextStatus(
    focusGroups.activeItems,
    normalizeStatusInput("open", runtime.statusRegistry),
    runtime.statusRegistry,
  );
  const sections = await buildOptionalContextSections({
    runtime,
    allItems: corpus.allItems,
    fullCorpus: corpus.fullCorpus,
    focusGroups,
    now: agendaContext.agenda.now,
    global,
  });
  const summaryExtras = buildContextSummaryExtras(
    contextNeedsAllItems(runtime.sectionsIncluded),
    corpus.allItems,
    runtime.statusRegistry,
  );

  const result: ContextResult = {
    output_default: "toon",
    now: agendaContext.agenda.now,
    depth: runtime.depth,
    sections_included: runtime.sectionsIncluded,
    window: {
      anchor: agendaContext.agenda.anchor,
      start: agendaContext.agenda.range.start,
      end: agendaContext.agenda.range.end,
      past: agendaContext.agenda.range.past,
      from: agendaContext.agenda.range.from,
      to: agendaContext.agenda.range.to,
    },
    filters: {
      type: options.type ?? null,
      tag: options.tag ?? null,
      priority: options.priority ?? null,
      assignee: options.assignee ?? null,
      assignee_filter: options.assigneeFilter ?? null,
      sprint: options.sprint ?? null,
      release: options.release ?? null,
      limit: options.limit ?? options.maxItems ?? null,
      parent: runtime.parentScope ?? null,
      /* c8 ignore next -- listed/calendar runtime filters are always materialized by their command handlers */
      runtime_filters: (corpus.listed.filters.runtime_filters ??
        agendaContext.agenda.filters.runtime_filters ??
        {}) as Record<string, unknown>,
    },
    summary: {
      active_items: focusGroups.activeItems.length,
      in_progress: inProgressCount,
      open: openCount,
      blocked: focusGroups.blockedItems.length,
      blocked_fallback_used: focusGroups.blockedFallbackUsed,
      high_level: focusGroups.highLevel.length,
      low_level: focusGroups.lowLevel.length,
      agenda_events: agendaContext.agendaSummary.events,
      ...summaryExtras,
    },
    high_level: focusGroups.highLevel,
    low_level: focusGroups.lowLevel,
    blocked_fallback: focusGroups.blockedFallback,
    agenda: {
      summary: agendaContext.agendaSummary,
      events: agendaContext.agendaEvents,
    },
    ...focusGroups.pageExtras,
  };

  attachOptionalContextSections(result, sections);
  if (options.explainRanking === true) {
    result.ranking = toContextRankingSummary(focusGroups.ranking);
    result.packing = toContextPackingSummary(focusGroups.packing);
  }
  applyContextFocusProjection(result, runtime.focusFields);
  if (warnings.length > 0) result.warnings = warnings;
  maybeAttachEmptyContextSuggestions(
    result,
    focusGroups.activeItems,
    focusGroups.blockedItems,
  );
  await attachContextUsageFeedback(result, focusGroups, pmRoot, author);

  return result;
}
