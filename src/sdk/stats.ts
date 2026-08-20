/**
 * @module sdk/stats
 *
 * Implements the pm stats command surface and its agent-facing runtime behavior.
 */
import { assertInitializedTracker } from "./environment/tracker-preflight.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getActiveExtensionRegistrations,
  runActiveOnReadHooks,
} from "../core/extensions/index.js";
import {
  computeContentFieldUtilization,
  type ContentFieldUtilizationReport,
} from "../core/governance/content-fields.js";
import {
  computeMetadataCoverage,
  groupItemsByDimension,
  lifecycleClassifierFromStatusRegistry,
  type CoverageItem,
  type GroupedBreakdown,
  type LifecycleClassifier,
  type MetadataCoverageReport,
} from "../core/governance/metadata-coverage.js";
import { pathExists, readFileIfExists } from "../core/fs/fs-utils.js";
import { enforceHistoryStreamPolicyForItems } from "../core/history/history-stream-policy.js";
import {
  computeHistoryStorageStats,
  type HistoryStorageStats,
} from "../core/history/history-storage-stats.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import { resolveRuntimeStatusRegistry } from "../core/schema/runtime-schema.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { nowIso } from "../core/shared/time.js";
import {
  listAllItemMetadataLight,
  listAllItemMetadataWithBody,
} from "../core/store/item-store.js";
import {resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import type { ItemStatus, ItemType } from "../types/index.js";
import {
  recordImprovementObservation,
  readImprovementLedger,
  type ImprovementDirection,
  type ImprovementLedgerResult,
  type RecordImprovementObservationResult,
} from "./improvement-ledger.js";
import {
  projectFleetAttributionAnalytics,
  projectProvenanceCoverageAnalytics,
  readHistoryAnalyticsWindow,
  type FleetAttributionAnalytics,
  type ProvenanceCoverageAnalytics,
} from "./history-analytics.js";
import { parseTestRunMeasurements } from "./test/measurements.js";

/** Documents the stats command options payload exchanged by command, SDK, and package integrations. */
export interface StatsCommandOptions {
  /** Restore zero-count item-type and status buckets for schema-governance dashboards. */
  includeEmpty?: boolean;
  /** Include aggregate per-stream history storage metrics (sizes, depth, oldest/newest). */
  storage?: boolean;
  /** Include metadata coverage percentages (AC, estimates, resolution, tags, parent) overall and by type. */
  metadataCoverage?: boolean;
  /** Include a lifecycle-bucketed breakdown grouped by assignee. */
  byAssignee?: boolean;
  /** Include a lifecycle-bucketed breakdown grouped by tag (optionally filtered by --tag-prefix). */
  byTag?: boolean;
  /** Include a lifecycle-bucketed breakdown grouped by priority. */
  byPriority?: boolean;
  /** With --by-tag: only consider tags starting with this prefix (e.g. "domain:"). */
  tagPrefix?: string;
  /** Include a content-field utilization breakdown (notes/learnings/files/docs/tests/comments/deps/body usage rates). */
  fieldUtilization?: boolean;
  /** Include the audited improvement observation ledger and derived trends. */
  measurements?: boolean;
  /** Exact improvement metric filter used with --measurements. */
  metric?: string;
  /** Maximum newest improvement observations returned. */
  measurementLimit?: number;
  /** Repeatable name=value[,unit=...][,threshold=...] observations to append. */
  observe?: string[];
  /** Improvement direction applied to newly recorded observations. */
  direction?: ImprovementDirection;
  /** Producing gate or instrument associated with new observations. */
  measurementSource?: string;
  /** Tracked owner associated with new observations. */
  measurementItem?: string;
  /** Explicit source revision for new observations. */
  measurementRevision?: string;
  /** Intentional mutation author override. */
  author?: string;
  /** Human-readable observation audit rationale. */
  message?: string;
  /** Include live declared-versus-observed provenance coverage. */
  provenanceCoverage?: boolean;
  /** Include immutable-history fleet outcome attribution. */
  fleetAttribution?: boolean;
  /** Inclusive history analytics lower bound or negative duration. */
  since?: string;
  /** Maximum immutable events consumed by each analytics projection. */
  eventLimit?: number;
  /** Minimum close or explicit-value denominator required for rates. */
  minimumSample?: number;
}

/** Compact, tabular lifecycle row used by the default stats type distribution. */
export interface StatsTypeLifecycleRow {
  /** Item type represented by this row. */
  type: string;
  /** Total items of this type across every lifecycle bucket. */
  total: number;
  /** Items in the default open lifecycle bucket. */
  open: number;
  /** Items in active non-default lifecycle states. */
  in_progress: number;
  /** Items in blocked lifecycle states. */
  blocked: number;
  /** Items in draft lifecycle states. */
  draft: number;
  /** Items in completed lifecycle states. */
  closed: number;
  /** Items in canceled lifecycle states. */
  canceled: number;
  /** Items whose custom status is outside the recognized lifecycle buckets. */
  other: number;
}

/** Screen-sized type distribution rendered as one canonical TOON table. */
export type StatsTypeBreakdown = StatsTypeLifecycleRow[];

/** Documents the stats result payload exchanged by command, SDK, and package integrations. */
export interface StatsResult {
  /** Value that configures or reports totals for this contract. */
  totals: {
    items: number;
    history_streams: number;
    history_entries: number;
  };
  /** Schema type that determines the shape and validation rules for this value. */
  by_type: StatsTypeBreakdown;
  /** Item counts grouped by lifecycle status. */
  by_status: Partial<Record<ItemStatus, number>>;
  /** Total zero-count type and status buckets omitted from the default projection. */
  omitted_zero_buckets: number;
  /** Present only with --metadata-coverage: per-field coverage overall and by type. */
  metadata_coverage?: MetadataCoverageReport;
  /** Present only with --by-assignee/--by-tag/--by-priority: lifecycle-bucketed group breakdowns. */
  breakdowns?: {
    assignee?: GroupedBreakdown;
    tag?: GroupedBreakdown;
    priority?: GroupedBreakdown;
  };
  /** Present only with --storage: aggregate history-stream metrics for compaction/planning. */
  storage?: HistoryStorageStats;
  /** Present only with --field-utilization: content-field utilization rates across all items. */
  field_utilization?: ContentFieldUtilizationReport;
  /** Audited improvement observations and baseline-to-latest trends. */
  improvement_ledger?: ImprovementLedgerResult;
  /** Receipts for observations appended by this invocation. */
  recorded_observations?: RecordImprovementObservationResult[];
  /** Live provenance coverage over a bounded immutable-history window. */
  provenance_coverage?: ProvenanceCoverageAnalytics;
  /** Bounded fleet attribution derived from immutable history. */
  fleet_attribution?: FleetAttributionAnalytics;
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

function zeroByType(itemTypes: string[]): Record<ItemType, number> {
  return itemTypes.reduce(
    (acc, value) => {
      acc[value] = 0;
      return acc;
    },
    {} as Record<ItemType, number>,
  );
}

function zeroByStatus(statuses: string[]): Record<ItemStatus, number> {
  return statuses.reduce(
    (acc, value) => {
      acc[value] = 0;
      return acc;
    },
    {} as Record<ItemStatus, number>,
  );
}

function projectStatsDistributions(
  items: readonly CoverageItem[],
  itemTypes: readonly string[],
  statuses: readonly string[],
  classifier: LifecycleClassifier,
  includeEmpty: boolean,
): {
  byType: StatsTypeBreakdown;
  byStatus: Partial<Record<ItemStatus, number>>;
  omitted: number;
} {
  const grouped = groupItemsByDimension(items, "type", classifier);
  const presentTypes = new Set(grouped.rows.map((row) => row.key));
  const missingTypes = itemTypes.filter((type) => !presentTypes.has(type));
  const groupedRows = includeEmpty
    ? [
        ...grouped.rows,
        ...missingTypes.map((type) => ({
          label: type,
          key: type,
          total: 0,
          buckets: {
            open: 0,
            in_progress: 0,
            blocked: 0,
            draft: 0,
            closed: 0,
            canceled: 0,
            other: 0,
          },
        })),
      ]
    : grouped.rows;
  const byType: StatsTypeBreakdown = groupedRows.map((row) => ({
      type: row.key ?? row.label,
      total: row.total,
      open: row.buckets.open,
      in_progress: row.buckets.in_progress,
      blocked: row.buckets.blocked,
      draft: row.buckets.draft,
      closed: row.buckets.closed,
      canceled: row.buckets.canceled,
      other: row.buckets.other,
    }));
  const counts = zeroByStatus([...statuses]);
  for (const item of items) counts[item.status] += 1;
  const byStatus = Object.fromEntries(
    Object.entries(counts).filter(([, count]) => includeEmpty || count > 0),
  ) as Partial<Record<ItemStatus, number>>;
  return {
    byType,
    byStatus,
    omitted: includeEmpty
      ? 0
      : missingTypes.length +
        Object.values(counts).filter((count) => count === 0).length,
  };
}

function countNonEmptyLines(raw: string): number {
  if (raw.trim().length === 0) {
    return 0;
  }
  return raw.split(/\r?\n/u).filter((line) => line.trim().length > 0).length;
}

async function readHistoryStreamContents(
  pmRoot: string,
): Promise<Array<{ id: string; raw: string }>> {
  const historyDir = path.join(pmRoot, "history");
  if (!(await pathExists(historyDir))) {
    return [];
  }

  await runActiveOnReadHooks({
    path: historyDir,
    scope: "project",
  });
  const historyFiles = (await fs.readdir(historyDir))
    .filter((entry) => entry.endsWith(".jsonl"))
    .sort((a, b) => a.localeCompare(b));

  const streams: Array<{ id: string; raw: string }> = [];
  for (const file of historyFiles) {
    const historyPath = path.join(historyDir, file);
    const raw = await readFileIfExists(historyPath);
    if (raw === null) {
      continue;
    }
    await runActiveOnReadHooks({
      path: historyPath,
      scope: "project",
    });
    streams.push({ id: file.slice(0, -".jsonl".length), raw });
  }

  return streams;
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  zeroByType,
  zeroByStatus,
  countNonEmptyLines,
  readHistoryStreamContents,
  projectStatsDistributions,
};

async function recordStatsObservations(
  global: GlobalOptions,
  options: StatsCommandOptions,
): Promise<RecordImprovementObservationResult[]> {
  const recorded: RecordImprovementObservationResult[] = [];
  const observedAt = nowIso();
  for (const measurement of parseTestRunMeasurements(
    options.observe,
    observedAt,
  )) {
    recorded.push(
      await recordImprovementObservation(
        {
          metric: measurement.name,
          value: measurement.value,
          direction: options.direction,
          unit: measurement.unit,
          threshold: measurement.threshold,
          source: options.measurementSource,
          itemId: options.measurementItem,
          revision: options.measurementRevision,
          observedAt,
          author: options.author,
          message: options.message,
        },
        global,
      ),
    );
  }
  return recorded;
}

function requestedBreakdowns(
  items: Awaited<ReturnType<typeof listAllItemMetadataLight>>,
  options: StatsCommandOptions,
  classifier: ReturnType<typeof lifecycleClassifierFromStatusRegistry>,
): NonNullable<StatsResult["breakdowns"]> {
  const breakdowns: NonNullable<StatsResult["breakdowns"]> = {};
  if (options.byAssignee) {
    breakdowns.assignee = groupItemsByDimension(items, "assignee", classifier);
  }
  if (options.byTag) {
    breakdowns.tag = groupItemsByDimension(items, "tag", classifier, {
      tagPrefix: options.tagPrefix,
    });
  }
  if (options.byPriority) {
    breakdowns.priority = groupItemsByDimension(items, "priority", classifier);
  }
  return breakdowns;
}

async function requestedHistoryAnalytics(
  pmRoot: string,
  items: Awaited<ReturnType<typeof listAllItemMetadataLight>>,
  settings: Awaited<ReturnType<typeof readSettings>>,
  terminalStatuses: ReadonlySet<string>,
  options: StatsCommandOptions,
): Promise<{
  provenanceCoverage: ProvenanceCoverageAnalytics | undefined;
  fleetAttribution: FleetAttributionAnalytics | undefined;
}> {
  const historyOptions = {
    since: options.since,
    eventLimit: options.eventLimit,
    minimumSample: options.minimumSample,
  };
  const sharedWindow =
    options.provenanceCoverage || options.fleetAttribution
      ? await readHistoryAnalyticsWindow(pmRoot, historyOptions)
      : undefined;
  return {
    provenanceCoverage:
      options.provenanceCoverage && sharedWindow
        ? projectProvenanceCoverageAnalytics(
            sharedWindow,
            settings.agent_identity?.harness_signals,
            historyOptions,
          )
        : undefined,
    fleetAttribution:
      options.fleetAttribution && sharedWindow
        ? projectFleetAttributionAnalytics(
            sharedWindow,
            items,
            terminalStatuses,
            historyOptions,
          )
        : undefined,
  };
}

function assembleStatsResult(
  totals: StatsResult["totals"],
  byType: StatsResult["by_type"],
  byStatus: StatsResult["by_status"],
  omittedZeroBuckets: StatsResult["omitted_zero_buckets"],
  optional: {
    metadataCoverage: MetadataCoverageReport | undefined;
    breakdowns: NonNullable<StatsResult["breakdowns"]>;
    storage: HistoryStorageStats | undefined;
    fieldUtilization: ContentFieldUtilizationReport | undefined;
    improvementLedger: ImprovementLedgerResult | undefined;
    recordedObservations: RecordImprovementObservationResult[];
    provenanceCoverage: ProvenanceCoverageAnalytics | undefined;
    fleetAttribution: FleetAttributionAnalytics | undefined;
  },
): StatsResult {
  const hasBreakdowns = Object.keys(optional.breakdowns).length > 0;
  return {
    totals,
    by_type: byType,
    by_status: byStatus,
    omitted_zero_buckets: omittedZeroBuckets,
    ...(optional.metadataCoverage
      ? { metadata_coverage: optional.metadataCoverage }
      : {}),
    ...(hasBreakdowns ? { breakdowns: optional.breakdowns } : {}),
    ...(optional.storage ? { storage: optional.storage } : {}),
    ...(optional.fieldUtilization
      ? { field_utilization: optional.fieldUtilization }
      : {}),
    ...(optional.improvementLedger
      ? { improvement_ledger: optional.improvementLedger }
      : {}),
    ...(optional.recordedObservations.length > 0
      ? { recorded_observations: optional.recordedObservations }
      : {}),
    ...(optional.provenanceCoverage
      ? { provenance_coverage: optional.provenanceCoverage }
      : {}),
    ...(optional.fleetAttribution
      ? { fleet_attribution: optional.fleetAttribution }
      : {}),
    generated_at: nowIso(),
  };
}

/** Implements run stats for the public runtime surface of this module. */
export async function runStats(
  global: GlobalOptions,
  options: StatsCommandOptions = {},
): Promise<StatsResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await assertInitializedTracker(pmRoot);

  const settings = await readSettings(pmRoot);
  const recordedObservations = await recordStatsObservations(global, options);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  // Field utilization needs the heavy collections (notes/learnings/files/docs/
  // tests/comments/deps) AND the body, which the light reader drops — so when it
  // is requested we read the WithBody rows and use them for every section.
  const items = options.fieldUtilization
    ? await listAllItemMetadataWithBody(
        pmRoot,
        settings.item_format,
        typeRegistry.type_to_folder,
        undefined,
        settings.schema,
      )
    : await listAllItemMetadataLight(
        pmRoot,
        settings.item_format,
        typeRegistry.type_to_folder,
        undefined,
        settings.schema,
      );
  await enforceHistoryStreamPolicyForItems({
    pmRoot,
    settings,
    itemIds: items.map((item) => item.id),
    commandLabel: "stats",
  });

  const classifier = lifecycleClassifierFromStatusRegistry(statusRegistry);
  const distributions = projectStatsDistributions(
    items,
    typeRegistry.types,
    statusRegistry.definitions.map((definition) => definition.id),
    classifier,
    options.includeEmpty === true,
  );

  const streams = await readHistoryStreamContents(pmRoot);
  let historyEntries = 0;
  for (const stream of streams) {
    historyEntries += countNonEmptyLines(stream.raw);
  }
  const storage = options.storage
    ? computeHistoryStorageStats(streams)
    : undefined;

  const metadataCoverage = options.metadataCoverage
    ? computeMetadataCoverage(items, classifier)
    : undefined;
  const breakdowns = requestedBreakdowns(items, options, classifier);
  const fieldUtilization = options.fieldUtilization
    ? computeContentFieldUtilization(items)
    : undefined;
  const improvementLedger =
    options.measurements === true || recordedObservations.length > 0
      ? await readImprovementLedger({
          pmRoot,
          metric: options.metric,
          itemId: options.measurementItem,
          limit: options.measurementLimit,
        })
      : undefined;
  const { provenanceCoverage, fleetAttribution } =
    await requestedHistoryAnalytics(
      pmRoot,
      items,
      settings,
      statusRegistry.terminal_statuses,
      options,
    );

  return assembleStatsResult(
    {
      items: items.length,
      history_streams: streams.length,
      history_entries: historyEntries,
    },
    distributions.byType,
    distributions.byStatus,
    distributions.omitted,
    {
      metadataCoverage,
      breakdowns,
      storage,
      fieldUtilization,
      improvementLedger,
      recordedObservations,
      provenanceCoverage,
      fleetAttribution,
    },
  );
}
