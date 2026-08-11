/**
 * @module sdk/query/activity
 *
 * Implements the pm activity command surface and its agent-facing runtime behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  getActiveExtensionRegistrations,
  runActiveOnReadHooks,
  pathExists,
  enforceHistoryStreamPolicyForItems,
  resolveItemTypeRegistry,
  EXIT_CODE,
  type GlobalOptions,
  PmCliError,
  compareTimestampStrings,
  nowIso,
  resolveIsoOrRelative,
  listAllItemMetadataLight,
  getSettingsPath,
  resolvePmRoot,
  readSettings,
} from "../runtime-primitives.js";
import { readHistoryEntries } from "../history-read.js";
import { parseLimit } from "./parsers.js";
import type { HistoryEntry } from "../../types/index.js";
import {
  resolveModePairedOutputOmissionReceipt,
  type OutputOmissionReceipt,
} from "../output-projection.js";
import {
  compileHistoryProvenanceMatcher,
  projectHistoryProvenance,
  resolveHistoryProvenanceDimensions,
  summarizeHistoryProvenance,
  type HistoryProvenanceRow,
  type HistoryProvenanceSummary,
} from "../history-provenance.js";

const DEFAULT_COMPACT_ACTIVITY_LIMIT = 20;
const DEFAULT_FULL_ACTIVITY_LIMIT = 5;
const DEFAULT_DIGEST_ACTIVITY_LIMIT = 15;
const DEFAULT_DIGEST_WINDOW = "-24h";

/** Documents the activity command options payload exchanged by command, SDK, and package integrations. */
export interface ActivityCommandOptions {
  /** Stable identifier used to reference this record across commands and storage. */
  id?: string;
  /** Value that configures or reports op for this contract. */
  op?: string;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Value that configures or reports from for this contract. */
  from?: string;
  /** Value that configures or reports to for this contract. */
  to?: string;
  /** Value that configures or reports limit for this contract. */
  limit?: string;
  /** Value that configures or reports compact for this contract. */
  compact?: boolean;
  /** Return the legacy per-event stream instead of the item-centric digest. */
  raw?: boolean;
  /** Explicitly disables the default activity bound. */
  unbounded?: boolean;
  /** Return patch-free provenance rows. */
  provenance?: boolean;
  /** Include constant-size provenance completeness metrics. */
  provenanceSummary?: boolean;
  /** Filter by canonical recorded or vocabulary-resolved harness. */
  harness?: string | readonly string[];
  /** Filter by privacy-safe invocation fingerprint. */
  agentInstance?: string | readonly string[];
  /** Exact provenance dimension predicates (`dimension=value`). */
  provenanceFilter?: string | readonly string[];
}

/** Normalize raw and full aliases into one explicit activity row projection. */
export function normalizeActivityProjectionOptions(
  options: ActivityCommandOptions & { full?: unknown },
): ActivityCommandOptions {
  const normalized = { ...options };
  if (normalized.full === true) {
    normalized.raw = true;
    normalized.compact = false;
  } else if (normalized.raw === true && normalized.compact === undefined) {
    normalized.compact = true;
  }
  delete normalized.full;
  return normalized;
}

/** Documents the activity entry payload exchanged by command, SDK, and package integrations. */
export interface ActivityEntry extends HistoryEntry {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
}

/** Documents the compact activity entry payload exchanged by command, SDK, and package integrations. */
export interface CompactActivityEntry {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports op for this contract. */
  op: string;
  /** Value that configures or reports ts for this contract. */
  ts: string;
  /** Value that configures or reports author for this contract. */
  author: string;
  /** Value that configures or reports msg for this contract. */
  msg?: string;
}

/** One item-centric summary of every matching immutable event for that item. */
export interface ActivityDigestEntry {
  /** Stable item identifier. */
  id: string;
  /** Current item type from the light metadata join. */
  type: string;
  /** Current lifecycle status from the light metadata join. */
  status: string;
  /** Current item title, bounded for predictable context cost. */
  title: string;
  /** Matching immutable events folded into this row. */
  event_count: number;
  /** Oldest matching event timestamp. */
  first_ts: string;
  /** Newest matching event timestamp. */
  last_ts: string;
  /** Bounded operation histogram encoded as comma-separated op:count pairs. */
  operations: string;
}

/** Documents the activity result payload exchanged by command, SDK, and package integrations. */
export interface ActivityResult {
  /** Default item-centric workspace activity rows. */
  activity_digest?: ActivityDigestEntry[];
  /** Value that configures or reports activity for this contract. */
  activity?: ActivityEntry[];
  /** Value that configures or reports compact activity for this contract. */
  compact_activity?: CompactActivityEntry[];
  /** Patch-free immutable provenance rows. */
  provenance_activity?: HistoryProvenanceRow[];
  /** Value that configures or reports compact for this contract. */
  compact: boolean;
  /** Explicit active row projection. */
  projection: {
    /** Stable projection mode. */
    mode: "digest" | "compact" | "provenance" | "full";
    /** Active row collection key. */
    row_key:
      | "activity_digest"
      | "compact_activity"
      | "provenance_activity"
      | "activity";
  };
  /** Constant-size disclosure of field groups withheld by the active mode. */
  omission_receipt: OutputOmissionReceipt;
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Total matching rows before the applied bound. */
  total_count: number;
  /** Value that configures or reports limit for this contract. */
  limit: number | null;
  /** Number of matching rows withheld by the applied bound. */
  omitted_count: number;
  /** Whether matching rows remain available through a larger or unbounded request. */
  has_more: boolean;
  /** Describes whether the effective bound came from a default, caller input, or an explicit opt-out. */
  applied_bound: {
    kind: "limit" | "unbounded";
    source: "default" | "explicit";
    value: number | null;
  };
  /** Constant-size description of the selected time window and matching corpus. */
  activity_summary?: {
    window: { from: string | null; to: string | null };
    event_count: number;
    item_count: number;
    author_count: number;
    operation_counts: Record<string, number>;
  };
  /** Constant-size provenance completeness metrics. */
  provenance_summary?: HistoryProvenanceSummary;
}

interface ActivityFilters {
  id: string | undefined;
  op: string | undefined;
  author: string | undefined;
  from: string | undefined;
  to: string | undefined;
  limit: number | undefined;
  limitSource: "default" | "explicit";
  harness: string | readonly string[] | undefined;
  agentInstance: string | readonly string[] | undefined;
  provenance: string | readonly string[] | undefined;
}

interface ActivityRuntimeContext {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
}

interface ActivityItemMetadata {
  title: string;
  type: string;
  status: string;
}

interface PreparedActivityRead {
  historyDir: string;
  itemsById: Map<string, ActivityItemMetadata>;
}

type ActivityProjectionMode = ActivityResult["projection"]["mode"];

interface ActivityRowsProjection {
  rows: Pick<
    ActivityResult,
    | "activity_digest"
    | "compact_activity"
    | "provenance_activity"
    | "activity"
  >;
  compact: boolean;
  totalRows: number;
  returnedRows: number;
}

const ACTIVITY_ROW_KEY_BY_MODE: Readonly<
  Record<ActivityProjectionMode, ActivityResult["projection"]["row_key"]>
> = {
  digest: "activity_digest",
  compact: "compact_activity",
  provenance: "provenance_activity",
  full: "activity",
};

function parseNonEmptyFilter(
  raw: string | undefined,
  flagLabel: string,
): string | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim();
  if (normalized.length === 0) {
    throw new PmCliError(`${flagLabel} must not be empty`, EXIT_CODE.USAGE);
  }
  return normalized;
}

function parseRangeBound(
  raw: string | undefined,
  nowValue: string,
  fieldLabel: string,
): string | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim();
  if (normalized.length === 0) {
    throw new PmCliError(
      "Activity time bounds must not be empty",
      EXIT_CODE.USAGE,
    );
  }
  const relativeInput =
    fieldLabel === "--from" && /^\d+[hdwm]$/iu.test(normalized)
      ? `-${normalized}`
      : normalized;
  return resolveIsoOrRelative(relativeInput, new Date(nowValue), fieldLabel);
}

function includeByTimeWindow(
  entry: ActivityEntry,
  from: string | undefined,
  to: string | undefined,
): boolean {
  if (entry.ts.length === 0 && (from || to)) {
    return false;
  }
  if (from && compareTimestampStrings(entry.ts, from) < 0) {
    return false;
  }
  if (to && compareTimestampStrings(entry.ts, to) >= 0) {
    return false;
  }
  return true;
}

function limitEntries<T>(values: T[], limit: number | undefined): T[] {
  if (limit === undefined) return values;
  return values.slice(0, limit);
}

function readActivityString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeActivityEntry(
  id: string,
  entry: HistoryEntry,
): ActivityEntry {
  return {
    ...entry,
    id,
    ts: readActivityString(entry.ts),
    author: readActivityString(entry.author, "unknown"),
    op: readActivityString(entry.op, "unknown"),
    patch: Array.isArray(entry.patch) ? entry.patch : [],
    before_hash: readActivityString(entry.before_hash),
    after_hash: readActivityString(entry.after_hash),
  };
}

function sortActivity(entries: ActivityEntry[]): ActivityEntry[] {
  return [...entries].sort((a, b) => {
    const byTimestamp = b.ts.localeCompare(a.ts);
    if (byTimestamp !== 0) return byTimestamp;
    const byId = a.id.localeCompare(b.id);
    if (byId !== 0) return byId;
    return a.op.localeCompare(b.op);
  });
}

async function listHistoryFiles(historyDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(historyDir))
      .filter((entry) => entry.endsWith(".jsonl"))
      .sort((a, b) => a.localeCompare(b));
  } catch (error: unknown) {
    // Activity should degrade gracefully when optional history storage is absent.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function resolveActivityProjectionMode(
  options: ActivityCommandOptions,
): ActivityProjectionMode {
  if (
    options.raw !== true &&
    options.compact !== true &&
    options.provenance !== true
  ) {
    return "digest";
  }
  if (options.provenance === true) return "provenance";
  if (
    options.compact === true ||
    (options.raw === true && options.compact !== false)
  ) {
    return "compact";
  }
  return "full";
}

function resolveActivityLimit(
  options: ActivityCommandOptions,
  explicitLimit: number | undefined,
  projectionMode: ActivityProjectionMode,
): number | undefined {
  if (options.unbounded === true) return undefined;
  if (explicitLimit !== undefined) return explicitLimit;
  if (projectionMode === "digest") return DEFAULT_DIGEST_ACTIVITY_LIMIT;
  if (projectionMode === "compact") return DEFAULT_COMPACT_ACTIVITY_LIMIT;
  return DEFAULT_FULL_ACTIVITY_LIMIT;
}

function resolveActivityFilters(
  options: ActivityCommandOptions,
  projectionMode: ActivityProjectionMode,
): ActivityFilters {
  const nowValue = nowIso();
  const digest = projectionMode === "digest";
  const to = parseRangeBound(
    options.to ?? (digest ? nowValue : undefined),
    nowValue,
    "--to",
  );
  const from = parseRangeBound(
    options.from ?? (digest ? DEFAULT_DIGEST_WINDOW : undefined),
    options.from === undefined && digest ? to! : nowValue,
    "--from",
  );
  if (from && to && compareTimestampStrings(from, to) >= 0) {
    throw new PmCliError(
      "Activity --from must be before --to",
      EXIT_CODE.USAGE,
    );
  }
  const explicitLimit = parseLimit(options.limit);
  if (options.unbounded === true && explicitLimit !== undefined) {
    throw new PmCliError(
      "Activity --unbounded cannot be combined with --limit",
      EXIT_CODE.USAGE,
    );
  }
  return {
    id: parseNonEmptyFilter(options.id, "Activity --id"),
    op: parseNonEmptyFilter(options.op, "Activity --op"),
    author: parseNonEmptyFilter(options.author, "Activity --author"),
    from,
    to,
    limit: resolveActivityLimit(options, explicitLimit, projectionMode),
    limitSource:
      options.unbounded === true || explicitLimit !== undefined
        ? "explicit"
        : "default",
    harness: options.harness,
    agentInstance: options.agentInstance,
    provenance: options.provenanceFilter,
  };
}

async function resolveActivityRuntimeContext(
  global: GlobalOptions,
): Promise<ActivityRuntimeContext> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  return {
    pmRoot,
    settings: await readSettings(pmRoot),
  };
}

async function prepareActivityHistoryRead(
  context: ActivityRuntimeContext,
): Promise<PreparedActivityRead> {
  const typeRegistry = resolveItemTypeRegistry(
    context.settings,
    getActiveExtensionRegistrations(),
  );
  const items = await listAllItemMetadataLight(
    context.pmRoot,
    context.settings.item_format,
    typeRegistry.type_to_folder,
    undefined,
    context.settings.schema,
  );
  await enforceHistoryStreamPolicyForItems({
    pmRoot: context.pmRoot,
    settings: context.settings,
    itemIds: items.map((item) => item.id),
    commandLabel: "activity",
  });
  const historyDir = path.join(context.pmRoot, "history");
  await runActiveOnReadHooks({
    path: historyDir,
    scope: "project",
  });
  return {
    historyDir,
    itemsById: new Map(
      items.map((item) => [
        item.id,
        { title: item.title, type: item.type, status: item.status },
      ]),
    ),
  };
}

function includeActivityEntry(
  entry: HistoryEntry,
  candidate: ActivityEntry,
  filters: ActivityFilters,
): boolean {
  // Preserve legacy filter semantics: op/author filters compare the raw
  // history row before missing metadata is normalized to "unknown" for display.
  if (filters.op && entry.op !== filters.op) {
    return false;
  }
  if (filters.author && entry.author !== filters.author) {
    return false;
  }
  return includeByTimeWindow(candidate, filters.from, filters.to);
}

async function collectActivityEntries(
  historyDir: string,
  filters: ActivityFilters,
): Promise<ActivityEntry[]> {
  const combined: ActivityEntry[] = [];
  for (const file of await listHistoryFiles(historyDir)) {
    const id = file.slice(0, -".jsonl".length);
    if (filters.id && id !== filters.id) {
      continue;
    }
    const entries = await readHistoryEntries(path.join(historyDir, file), id);
    for (const entry of entries) {
      const candidate = normalizeActivityEntry(id, entry);
      if (includeActivityEntry(entry, candidate, filters)) {
        combined.push(candidate);
      }
    }
  }
  return combined;
}

function formatCompactActivity(
  activity: ActivityEntry[],
): CompactActivityEntry[] {
  return activity.map(
    (entry): CompactActivityEntry => ({
      id: entry.id,
      op: entry.op,
      ts: entry.ts,
      author: entry.author,
      ...(entry.message ? { msg: entry.message } : {}),
    }),
  );
}

function boundedOperationSummary(counts: ReadonlyMap<string, number>): string {
  const ordered = [...counts.entries()].sort(
    ([leftOp, leftCount], [rightOp, rightCount]) =>
      rightCount - leftCount || leftOp.localeCompare(rightOp),
  );
  const visible = ordered.slice(0, 4).map(([op, count]) => `${op}:${count}`);
  if (ordered.length > visible.length) {
    visible.push(`+${ordered.length - visible.length}`);
  }
  return visible.join(",");
}

function buildActivityDigest(
  activity: readonly ActivityEntry[],
  itemsById: ReadonlyMap<string, ActivityItemMetadata>,
): ActivityDigestEntry[] {
  const grouped = new Map<
    string,
    {
      firstTs: string;
      lastTs: string;
      eventCount: number;
      operations: Map<string, number>;
    }
  >();
  for (const entry of activity) {
    const current = grouped.get(entry.id);
    if (current === undefined) {
      grouped.set(entry.id, {
        firstTs: entry.ts,
        lastTs: entry.ts,
        eventCount: 1,
        operations: new Map([[entry.op, 1]]),
      });
      continue;
    }
    current.eventCount += 1;
    if (compareTimestampStrings(entry.ts, current.firstTs) < 0) {
      current.firstTs = entry.ts;
    }
    if (compareTimestampStrings(entry.ts, current.lastTs) > 0) {
      current.lastTs = entry.ts;
    }
    current.operations.set(
      entry.op,
      (current.operations.get(entry.op) ?? 0) + 1,
    );
  }
  return [...grouped.entries()]
    .map(([id, summary]): ActivityDigestEntry => {
      const item = itemsById.get(id);
      return {
        id,
        type: item?.type ?? "unknown",
        status: item?.status ?? "unknown",
        title: (item?.title ?? "(item metadata unavailable)").slice(0, 160),
        event_count: summary.eventCount,
        first_ts: summary.firstTs,
        last_ts: summary.lastTs,
        operations: boundedOperationSummary(summary.operations),
      };
    })
    .sort(
      (left, right) =>
        compareTimestampStrings(right.last_ts, left.last_ts) ||
        left.id.localeCompare(right.id),
    );
}

function activityOperationCounts(
  activity: readonly Pick<ActivityEntry, "op">[],
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const entry of activity) {
    counts.set(entry.op, (counts.get(entry.op) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort(
    (left, right) =>
      right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  const visible = ordered.slice(0, 8);
  if (visible.length < ordered.length) {
    visible.push([
      `+${String(ordered.length - visible.length)}`,
      ordered
        .slice(visible.length)
        .reduce((total, [, count]) => total + count, 0),
    ]);
  }
  return Object.fromEntries(visible);
}

function projectActivityRows(
  projectionMode: ActivityProjectionMode,
  matchingActivity: ActivityEntry[],
  limit: number | undefined,
  itemsById: ReadonlyMap<string, ActivityItemMetadata>,
  projectProvenance: (entry: ActivityEntry) => HistoryProvenanceRow,
): ActivityRowsProjection {
  if (projectionMode === "digest") {
    const matchingDigest = buildActivityDigest(matchingActivity, itemsById);
    const activityDigest = limitEntries(matchingDigest, limit);
    return {
      rows: { activity_digest: activityDigest },
      compact: false,
      totalRows: matchingDigest.length,
      returnedRows: activityDigest.length,
    };
  }
  const activity = limitEntries(matchingActivity, limit);
  if (projectionMode === "compact") {
    return {
      rows: { compact_activity: formatCompactActivity(activity) },
      compact: true,
      totalRows: matchingActivity.length,
      returnedRows: activity.length,
    };
  }
  if (projectionMode === "provenance") {
    return {
      rows: { provenance_activity: activity.map(projectProvenance) },
      compact: false,
      totalRows: matchingActivity.length,
      returnedRows: activity.length,
    };
  }
  return {
    rows: { activity },
    compact: false,
    totalRows: matchingActivity.length,
    returnedRows: activity.length,
  };
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  parseNonEmptyFilter,
  parseRangeBound,
  includeByTimeWindow,
  limitEntries,
  readActivityString,
  normalizeActivityEntry,
  sortActivity,
  listHistoryFiles,
  buildActivityDigest,
  activityOperationCounts,
};

/** Implements run activity for the public runtime surface of this module. */
export async function runActivity(
  options: ActivityCommandOptions,
  global: GlobalOptions,
): Promise<ActivityResult> {
  const context = await resolveActivityRuntimeContext(global);
  const projectionMode = resolveActivityProjectionMode(options);
  const filters = resolveActivityFilters(options, projectionMode);
  const prepared = await prepareActivityHistoryRead(context);
  const provenanceDimensions = resolveHistoryProvenanceDimensions(
    context.settings.agent_identity!.harness_signals,
  );
  const vocabulary = context.settings.agent_identity!.identity_vocabulary!;
  const matchesProvenance = compileHistoryProvenanceMatcher(
    {
      harness: filters.harness,
      agentInstance: filters.agentInstance,
      provenance: filters.provenance,
    },
    vocabulary,
    provenanceDimensions,
  );
  const matchingActivity = sortActivity(
    await collectActivityEntries(prepared.historyDir, filters),
  ).filter(matchesProvenance);
  const projected = projectActivityRows(
    projectionMode,
    matchingActivity,
    filters.limit,
    prepared.itemsById,
    (entry) =>
      projectHistoryProvenance(entry, vocabulary, { itemId: entry.id }),
  );
  const omittedCount = projected.totalRows - projected.returnedRows;
  return {
    ...projected.rows,
    compact: projected.compact,
    projection: {
      mode: projectionMode,
      row_key: ACTIVITY_ROW_KEY_BY_MODE[projectionMode],
    },
    omission_receipt: resolveModePairedOutputOmissionReceipt(
      "activity",
      projectionMode,
    ),
    count: projected.returnedRows,
    total_count: projected.totalRows,
    limit: filters.limit ?? null,
    omitted_count: omittedCount,
    has_more: omittedCount > 0,
    ...(projectionMode === "digest"
      ? {
          activity_summary: {
            window: { from: filters.from!, to: filters.to! },
            event_count: matchingActivity.length,
            item_count: projected.totalRows,
            author_count: new Set(
              matchingActivity.map((entry) => entry.author),
            ).size,
            operation_counts: activityOperationCounts(matchingActivity),
          },
        }
      : {}),
    ...(options.provenanceSummary === true
      ? {
          provenance_summary: summarizeHistoryProvenance(
            matchingActivity,
            vocabulary,
            provenanceDimensions,
          ),
        }
      : {}),
    applied_bound: {
      kind: filters.limit === undefined ? "unbounded" : "limit",
      source: filters.limitSource,
      value: filters.limit ?? null,
    },
  };
}
