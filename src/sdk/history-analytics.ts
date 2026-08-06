/**
 * @module sdk/history-analytics
 *
 * Derives bounded provenance coverage and fleet outcome analytics from the
 * immutable history event index without introducing telemetry-owned state.
 */
import {
  AGENT_PROVENANCE_DIMENSIONS,
  BUILTIN_HARNESS_SIGNAL_DESCRIPTORS,
  type HarnessSignalDescriptor,
} from "../core/shared/author.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import type { HistoryEntry, ItemMetadata } from "../types/index.js";
import { listMutationEvents } from "./mutation-events.js";
import {
  analyzeAgentProvenanceDescriptorCoverage,
  summarizeAgentProvenance,
  type AgentProvenanceDescriptorCoverage,
  type AgentProvenanceDimensionCoverage,
} from "./provenance.js";

const DEFAULT_HISTORY_ANALYTICS_LIMIT = 10_000;
const MAX_HISTORY_ANALYTICS_LIMIT = 100_000;
const HISTORY_EVENT_PAGE_LIMIT = 1_000;
const DEFAULT_HISTORY_WINDOW_DAYS = 30;
const ANNOTATION_OPERATION_PREFIXES = [
  "append",
  "comment",
  "docs",
  "file",
  "learning",
  "note",
  "test_run",
] as const;

/** Bounded immutable-history window controls shared by analytics surfaces. */
export interface HistoryAnalyticsWindowOptions {
  /** Inclusive ISO timestamp or negative day/hour duration such as -30d. */
  since?: string;
  /** Maximum indexed events consumed across all pages. */
  eventLimit?: number;
  /** Minimum denominator required before a rate is reported. */
  minimumSample?: number;
}

/** Read receipt proving how much immutable history contributed. */
export interface HistoryAnalyticsWindowReceipt {
  /** Inclusive lower bound used for the scan. */
  since: string;
  /** Number of indexed immutable events inspected. */
  events: number;
  /** Whether the configured event ceiling omitted matching rows. */
  truncated: boolean;
  /** Cursor that resumes after the last inspected event when truncated. */
  next_cursor?: string;
  /** Derived read source. */
  source: "history_event_index";
}

/** Live declared-versus-observed provenance report. */
export interface ProvenanceCoverageAnalytics {
  /** Descriptor coverage for every declared dimension. */
  descriptors: AgentProvenanceDescriptorCoverage[];
  /** Per-harness availability over the bounded event window. */
  observations: AgentProvenanceDimensionCoverage[];
  /** Declared dimensions with enough explicit samples but no observations. */
  inert: Array<{
    harness: string;
    dimension: string;
    explicit_samples: number;
  }>;
  /** Dimensions no configured harness declares. */
  undeclared: string[];
  /** Stable warning codes suitable for health/gate adapters. */
  warnings: string[];
  /** Bounded source receipt. */
  window: HistoryAnalyticsWindowReceipt;
}

/** One bounded attribution bucket with honest denominator states. */
export interface FleetAttributionRow {
  /** Recorded grouping value. */
  value: string;
  /** Immutable events attributed to the bucket. */
  events: number;
  /** State-changing events attributed to the bucket. */
  state_events: number;
  /** Annotation/evidence events attributed to the bucket. */
  annotation_events: number;
  /** Terminal transitions attributed to the bucket. */
  closes: number;
  /** Active transitions after a terminal transition in the observed window. */
  reopens: number;
  /** Issue items linked discovered_from to work closed by this bucket. */
  defect_escapes: number;
  /** Terminal transitions per observed day, or null for insufficient samples. */
  throughput_per_day: number | null;
  /** Reopens divided by closes, or null for insufficient samples. */
  rework_rate: number | null;
  /** Defect escapes divided by closes, or null for insufficient samples. */
  defect_escape_rate: number | null;
  /** Denominator state preventing tiny samples from masquerading as rates. */
  sample_status: "available" | "insufficient";
}

/** One supported fleet grouping dimension. */
export interface FleetAttributionDimension {
  /** Stable dimension name. */
  dimension: "harness" | "model" | "author_source";
  /** Whether at least one event supplied this dimension. */
  status: "available" | "unavailable";
  /** Deterministically sorted bounded aggregate rows. */
  rows: FleetAttributionRow[];
}

/** Observational fleet analytics derived only from immutable history. */
export interface FleetAttributionAnalytics {
  /** Grouped analytics for every supported provenance dimension. */
  dimensions: FleetAttributionDimension[];
  /** Minimum close denominator required for rates. */
  minimum_sample: number;
  /** Safety statement retained in every transport. */
  policy: "observational_only_not_for_authorization_or_routing";
  /** Bounded source receipt. */
  window: HistoryAnalyticsWindowReceipt;
}

interface IndexedAnalyticsEvent {
  item_id: string;
  entry: HistoryEntry;
}

interface MutableFleetBucket {
  events: number;
  stateEvents: number;
  annotationEvents: number;
  closes: number;
  reopens: number;
  defectEscapes: number;
}

function parseHistoryAnalyticsLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_HISTORY_ANALYTICS_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_HISTORY_ANALYTICS_LIMIT
  ) {
    throw new PmCliError(
      `History analytics event limit must be an integer from 1 to ${MAX_HISTORY_ANALYTICS_LIMIT}.`,
      EXIT_CODE.USAGE,
      { code: "invalid_history_analytics_limit" },
    );
  }
  return limit;
}

function parseMinimumSample(value: number | undefined): number {
  const minimum = value ?? 5;
  if (!Number.isSafeInteger(minimum) || minimum < 1 || minimum > 10_000) {
    throw new PmCliError(
      "History analytics minimum sample must be an integer from 1 to 10000.",
      EXIT_CODE.USAGE,
      { code: "invalid_history_analytics_minimum_sample" },
    );
  }
  return minimum;
}

function resolveHistoryAnalyticsSince(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) {
    return new Date(
      Date.now() - DEFAULT_HISTORY_WINDOW_DAYS * 86_400_000,
    ).toISOString();
  }
  const relative = /^-(\d+)([dh])$/u.exec(raw);
  if (relative) {
    const amount = Number(relative[1]);
    const multiplier = relative[2] === "d" ? 86_400_000 : 3_600_000;
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new PmCliError(
        "History analytics --since duration must be positive.",
        EXIT_CODE.USAGE,
        {
          code: "invalid_history_analytics_since",
        },
      );
    }
    return new Date(Date.now() - amount * multiplier).toISOString();
  }
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) {
    throw new PmCliError(
      "History analytics --since must be an ISO timestamp or negative duration such as -30d.",
      EXIT_CODE.USAGE,
      { code: "invalid_history_analytics_since" },
    );
  }
  return new Date(milliseconds).toISOString();
}

async function readBoundedHistoryWindow(
  pmRoot: string,
  options: HistoryAnalyticsWindowOptions,
): Promise<{
  events: IndexedAnalyticsEvent[];
  receipt: HistoryAnalyticsWindowReceipt;
}> {
  const eventLimit = parseHistoryAnalyticsLimit(options.eventLimit);
  const since = resolveHistoryAnalyticsSince(options.since);
  const events: IndexedAnalyticsEvent[] = [];
  let cursor: string | undefined = since;
  let hasMore = false;
  while (events.length < eventLimit) {
    const page = await listMutationEvents({
      pmRoot,
      since: cursor,
      limit: Math.min(HISTORY_EVENT_PAGE_LIMIT, eventLimit - events.length),
      full: true,
    });
    const pageEvents = page.events.map((event) => ({
      item_id: event.item_id,
      entry: event.entry as HistoryEntry,
    }));
    events.push(...pageEvents);
    hasMore = page.has_more;
    cursor = page.next_cursor;
    if (!page.has_more) break;
  }
  return {
    events,
    receipt: {
      since,
      events: events.length,
      truncated: hasMore,
      ...(hasMore ? { next_cursor: cursor } : {}),
      source: "history_event_index",
    },
  };
}

function provenanceValue(
  entry: HistoryEntry,
  dimension: FleetAttributionDimension["dimension"],
): string | undefined {
  if (dimension === "harness") return entry.agent_harness;
  if (dimension === "author_source") return entry.author_source;
  return entry.agent_model ?? entry.agent_provenance?.model?.value;
}

function statusFromEntry(entry: HistoryEntry): string | undefined {
  for (let index = entry.patch.length - 1; index >= 0; index -= 1) {
    const operation = entry.patch[index];
    if (
      operation.path === "/metadata/status" &&
      "value" in operation &&
      typeof operation.value === "string"
    ) {
      return operation.value;
    }
  }
  return undefined;
}

function annotationOperation(op: string): boolean {
  return ANNOTATION_OPERATION_PREFIXES.some((prefix) => op.startsWith(prefix));
}

function bucketFor(
  buckets: Map<string, MutableFleetBucket>,
  value: string,
): MutableFleetBucket {
  const existing = buckets.get(value);
  if (existing) return existing;
  const created = {
    events: 0,
    stateEvents: 0,
    annotationEvents: 0,
    closes: 0,
    reopens: 0,
    defectEscapes: 0,
  };
  buckets.set(value, created);
  return created;
}

function accumulateFleetEvents(
  dimension: FleetAttributionDimension["dimension"],
  events: readonly IndexedAnalyticsEvent[],
  terminalStatuses: ReadonlySet<string>,
): {
  buckets: Map<string, MutableFleetBucket>;
  lastCloseValue: Map<string, string>;
} {
  const buckets = new Map<string, MutableFleetBucket>();
  const streamTerminal = new Map<string, boolean>();
  const lastCloseValue = new Map<string, string>();
  for (const event of events) {
    const value = provenanceValue(event.entry, dimension);
    const status = statusFromEntry(event.entry);
    const wasTerminal = streamTerminal.get(event.item_id) === true;
    const isTerminal =
      status === undefined ? wasTerminal : terminalStatuses.has(status);
    if (status !== undefined) streamTerminal.set(event.item_id, isTerminal);
    if (!value) continue;
    const bucket = bucketFor(buckets, value);
    bucket.events += 1;
    if (annotationOperation(event.entry.op)) bucket.annotationEvents += 1;
    else bucket.stateEvents += 1;
    if (status !== undefined && !wasTerminal && isTerminal) {
      bucket.closes += 1;
      lastCloseValue.set(event.item_id, value);
    } else if (status !== undefined && wasTerminal && !isTerminal) {
      bucket.reopens += 1;
    }
  }
  return { buckets, lastCloseValue };
}

function attributeDefectEscapes(
  buckets: Map<string, MutableFleetBucket>,
  lastCloseValue: ReadonlyMap<string, string>,
  items: readonly Pick<ItemMetadata, "id" | "type" | "dependencies">[],
): void {
  for (const item of items) {
    if (item.type !== "Issue") continue;
    const sources = new Set(
      (item.dependencies ?? [])
        .filter((dependency) => dependency.kind === "discovered_from")
        .map((dependency) => dependency.id),
    );
    for (const source of sources) {
      const value = lastCloseValue.get(source);
      if (value) bucketFor(buckets, value).defectEscapes += 1;
    }
  }
}

function fleetRow(
  value: string,
  bucket: MutableFleetBucket,
  minimumSample: number,
  windowDays: number,
): FleetAttributionRow {
  const sampleStatus =
    bucket.closes >= minimumSample ? "available" : "insufficient";
  return {
    value,
    events: bucket.events,
    state_events: bucket.stateEvents,
    annotation_events: bucket.annotationEvents,
    closes: bucket.closes,
    reopens: bucket.reopens,
    defect_escapes: bucket.defectEscapes,
    throughput_per_day:
      sampleStatus === "available" ? bucket.closes / windowDays : null,
    rework_rate:
      sampleStatus === "available" ? bucket.reopens / bucket.closes : null,
    defect_escape_rate:
      sampleStatus === "available"
        ? bucket.defectEscapes / bucket.closes
        : null,
    sample_status: sampleStatus,
  };
}

function buildFleetDimension(
  dimension: FleetAttributionDimension["dimension"],
  events: readonly IndexedAnalyticsEvent[],
  items: readonly Pick<ItemMetadata, "id" | "type" | "dependencies">[],
  terminalStatuses: ReadonlySet<string>,
  minimumSample: number,
  windowDays: number,
): FleetAttributionDimension {
  const { buckets, lastCloseValue } = accumulateFleetEvents(
    dimension,
    events,
    terminalStatuses,
  );
  attributeDefectEscapes(buckets, lastCloseValue, items);
  return {
    dimension,
    status: buckets.size === 0 ? "unavailable" : "available",
    rows: [...buckets]
      .map(([value, bucket]) =>
        fleetRow(value, bucket, minimumSample, windowDays),
      )
      .sort(
        (left, right) =>
          right.events - left.events || left.value.localeCompare(right.value),
      ),
  };
}

/** Evaluate a negative-control-friendly declared-versus-observed coverage gate. */
export function evaluateProvenanceCoverage(
  entries: readonly HistoryEntry[],
  descriptors: readonly HarnessSignalDescriptor[],
  minimumSample: number,
): Omit<ProvenanceCoverageAnalytics, "window"> {
  const descriptorCoverage =
    analyzeAgentProvenanceDescriptorCoverage(descriptors);
  const observations = summarizeAgentProvenance(
    entries,
    AGENT_PROVENANCE_DIMENSIONS,
    minimumSample,
  );
  const inert = observations
    .filter((row) => row.inert)
    .map((row) => ({
      harness: row.harness,
      dimension: row.dimension,
      explicit_samples: row.observed + row.unavailable,
    }));
  const undeclared = descriptorCoverage
    .filter((row) => !row.covered)
    .map((row) => row.dimension);
  return {
    descriptors: descriptorCoverage,
    observations,
    inert,
    undeclared,
    warnings: [
      ...inert.map(
        (row) =>
          `provenance_dimension_inert:${row.harness}:${row.dimension}:${String(row.explicit_samples)}`,
      ),
      ...undeclared.map(
        (dimension) => `provenance_dimension_undeclared:${dimension}`,
      ),
    ],
  };
}

/** Read live, bounded provenance coverage from authoritative history. */
export async function runProvenanceCoverageAnalytics(
  pmRoot: string,
  descriptors: readonly HarnessSignalDescriptor[] = BUILTIN_HARNESS_SIGNAL_DESCRIPTORS,
  options: HistoryAnalyticsWindowOptions = {},
): Promise<ProvenanceCoverageAnalytics> {
  const minimumSample = parseMinimumSample(options.minimumSample);
  const window = await readBoundedHistoryWindow(pmRoot, options);
  return {
    ...evaluateProvenanceCoverage(
      window.events.map((event) => event.entry),
      descriptors,
      minimumSample,
    ),
    window: window.receipt,
  };
}

/** Derive bounded fleet rates grouped by harness, model, and author source. */
export async function runFleetAttributionAnalytics(
  pmRoot: string,
  items: readonly Pick<ItemMetadata, "id" | "type" | "dependencies">[],
  terminalStatuses: ReadonlySet<string>,
  options: HistoryAnalyticsWindowOptions = {},
): Promise<FleetAttributionAnalytics> {
  const minimumSample = parseMinimumSample(options.minimumSample);
  const window = await readBoundedHistoryWindow(pmRoot, options);
  const firstTimestamp = window.events[0]?.entry.ts ?? window.receipt.since;
  const lastTimestamp =
    window.events[window.events.length - 1]?.entry.ts ?? firstTimestamp;
  const windowDays = Math.max(
    1,
    (Date.parse(lastTimestamp) - Date.parse(firstTimestamp)) / 86_400_000,
  );
  return {
    dimensions: (["harness", "model", "author_source"] as const).map(
      (dimension) =>
        buildFleetDimension(
          dimension,
          window.events,
          items,
          terminalStatuses,
          minimumSample,
          windowDays,
        ),
    ),
    minimum_sample: minimumSample,
    policy: "observational_only_not_for_authorization_or_routing",
    window: window.receipt,
  };
}

/** Pure seams for deterministic analytics and negative-control tests. */
export const _testOnlyHistoryAnalytics = {
  annotationOperation,
  buildFleetDimension,
  parseHistoryAnalyticsLimit,
  parseMinimumSample,
  provenanceValue,
  resolveHistoryAnalyticsSince,
  statusFromEntry,
};
