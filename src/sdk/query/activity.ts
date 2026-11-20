/**
 * @module sdk/query/activity
 *
 * Implements the pm activity command surface and its agent-facing runtime behavior.
 */
import { assertInitializedTracker } from "../environment/tracker-preflight.js";
import { isFileMissingError } from "../../core/fs/fs-utils.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getActiveExtensionRegistrations,
  runActiveOnReadHooks,
  enforceHistoryStreamPolicyForItems,
  resolveItemTypeRegistry,
  EXIT_CODE,
  type GlobalOptions,
  PmCliError,
  compareTimestampStrings,
  resolveIsoOrRelative,
  listAllItemMetadataLight,
  resolvePmRoot,
  readSettings,
} from "../runtime-primitives.js";
import { hasActiveOnReadHooks } from "../../core/extensions/index.js";
import { readHistorySnapshot, readIdentifiedHistorySnapshot } from "../../core/history/read.js";
import {
  openHistoryStreamSummary,
  type HistoryStreamBounds,
  type HistoryStreamSummaryFallback,
  type HistoryStreamSummarySession,
} from "../../core/history/stream-summary.js";
import { parseLimit } from "./parsers.js";
import { fingerprintWindowRows, paginateWindowQuery, resolveWindowQueryClock } from "./window-pagination.js";
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
  /** Continue the original fixed-window query with its opaque producer cursor. */
  after?: string;
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
  /** Zero-based position of the first returned row in the matching set. */
  page_start: number;
  /** Fixed evaluation clock and normalized inclusive/exclusive time bounds. */
  window: { anchor: string; from: string | null; to: string | null };
  /** Opaque producer cursor; repeat the same query with after to continue. */
  next_cursor?: string;
  /** Number of matching rows remaining after this page. */
  omitted_count: number;
  /** Whether a subsequent bounded page is available. */
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
  /** Present only when a tracker that keeps derived stream bounds could not bound this read by its window. */
  history_read?: ActivityHistoryReadReceipt;
}

/**
 * Constant-size disclosure that a read on a tracker large enough to keep
 * derived stream bounds was not bounded by its window, so its cost followed
 * the history archive (GH-1664). Bounded reads emit no receipt.
 */
export interface ActivityHistoryReadReceipt {
  /**
   * `summary_missing` / `summary_invalid` / `summary_stale`: the derived bounds
   * were absent, unreadable, or current for at most half of the streams, and
   * this read rebuilds them; `irregular_timestamps`: most streams hold
   * timestamps that are not canonical millisecond UTC, so bounds cannot
   * exclude them; `read_hooks_active`: an extension observes every stream
   * read; `unwindowed_query`: no `--from` bound and most streams were parsed
   * (add `--from` to bound the read); `window_reaches_most_streams`: the
   * bounds were current but the window (or, for recent rows, a clock pinned
   * before most streams' newest entries) still reached most streams.
   */
  reason: HistoryStreamSummaryFallback | "unwindowed_query" | "window_reaches_most_streams";
  /** History streams parsed by this read. */
  streams_read: number;
  /** History streams present when the read began. */
  streams_total: number;
}

/** Bounded recent-activity rows for context-style readers that need no page cursor. */
export interface RecentActivityResult {
  /** Newest matching events, in the activity sort order. */
  rows: CompactActivityEntry[];
  /** Present only when a tracker that keeps derived stream bounds could not bound this read. */
  history_read?: ActivityHistoryReadReceipt;
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
  page: Omit<ReturnType<typeof paginateWindowQuery>, "rows">;
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

/** Newest first, then item id and operation; equal keys keep stream order (stable sort). */
function compareActivityEntries(a: ActivityEntry, b: ActivityEntry): number {
  const byTimestamp = b.ts.localeCompare(a.ts);
  if (byTimestamp !== 0) return byTimestamp;
  const byId = a.id.localeCompare(b.id);
  if (byId !== 0) return byId;
  return a.op.localeCompare(b.op);
}

function sortActivity(entries: ActivityEntry[]): ActivityEntry[] {
  return [...entries].sort(compareActivityEntries);
}

async function listHistoryFiles(historyDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(historyDir))
      .filter((entry) => entry.endsWith(".jsonl"))
      .sort((a, b) => a.localeCompare(b));
  } catch (error: unknown) {
    // Activity should degrade gracefully when optional history storage is absent.
    if (isFileMissingError(error)) {
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

/** Normalize filters and default bounds against the recovered first-page clock. */
function resolveActivityFilters(
  options: ActivityCommandOptions,
  projectionMode: ActivityProjectionMode,
  nowValue: string,
): ActivityFilters {
  const digest = projectionMode === "digest";
  const to = parseRangeBound(
    options.to ?? (digest || options.unbounded !== true ? nowValue : undefined),
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
  await assertInitializedTracker(pmRoot);
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

function historyStreamId(file: string): string {
  return file.slice(0, -".jsonl".length);
}

/**
 * Whether trusted bounds leave any entry of the stream inside `[from, to)`.
 * Window bounds are canonical instants (resolveIsoOrRelative) and regular
 * entry timestamps compare chronologically under compareTimestampStrings, so
 * the newest entry below `from` or the oldest at or after `to` excludes every
 * entry; irregular streams are always read.
 */
function streamMayMatchWindow(
  bounds: HistoryStreamBounds,
  filters: Pick<ActivityFilters, "from" | "to">,
): boolean {
  if (bounds.count === 0) return false;
  if (bounds.irregular) return true;
  if (filters.from && compareTimestampStrings(bounds.newest!, filters.from) < 0) return false;
  return !(filters.to && compareTimestampStrings(bounds.oldest!, filters.to) >= 0);
}

interface ActivityStreamRead {
  summary: HistoryStreamSummarySession;
  files: string[];
  streamsRead: number;
  /** Skipped streams whose bounds went stale while the read ran. */
  revalidatedStale: number;
  /** Streams parsed because their trusted bounds hold irregular timestamps. */
  irregularRead: number;
  /** Whether read hooks became active while the read ran, ending pruning. */
  hooksActivated: boolean;
}

async function openActivityStreamRead(
  pmRoot: string,
  historyDir: string,
  filters: ActivityFilters,
): Promise<ActivityStreamRead> {
  const files = (await listHistoryFiles(historyDir)).filter(
    (file) => !filters.id || historyStreamId(file) === filters.id,
  );
  return {
    summary: await openHistoryStreamSummary({ pmRoot, historyDir, files }),
    files,
    streamsRead: 0,
    revalidatedStale: 0,
    irregularRead: 0,
    hooksActivated: false,
  };
}

/** Whether read hooks are active on a read that may skip streams, which ends pruning for it. */
function readHooksEndPruning(read: ActivityStreamRead): boolean {
  if (!read.summary.enabled || !hasActiveOnReadHooks()) return false;
  read.hooksActivated = true;
  return true;
}

/**
 * Finish a bounded read: read the skipped streams whose bounds went stale
 * while it ran, persist the bounds, then read every skipped stream not yet
 * read if read hooks are active. Each hook check follows an await, and the
 * last one follows the last (the summary write), so a hook registered at any
 * point during the read observes every stream the read has not read, exactly
 * once; after that check no await can admit a hook unobserved.
 */
async function finishBoundedRead<T extends { file: string }>(
  read: ActivityStreamRead,
  skipped: readonly T[],
  readStream: (stream: T) => Promise<void>,
): Promise<void> {
  let pending = [...skipped];
  const readPending = async (selected: (stream: T) => boolean) => {
    const now = pending.filter(selected);
    pending = pending.filter((stream) => !selected(stream));
    for (const stream of now) await readStream(stream);
  };
  if (pending.length > 0 && !readHooksEndPruning(read)) {
    const changed = new Set(await read.summary.revalidate(pending.map(({ file }) => file)));
    if (!readHooksEndPruning(read)) {
      read.revalidatedStale = changed.size;
      await readPending(({ file }) => changed.has(file));
    }
  }
  await read.summary.commit();
  if (pending.length > 0 && (read.hooksActivated || readHooksEndPruning(read))) await readPending(() => true);
}

/** Parse one stream completely, record its bounds, and append its matching rows. */
async function readActivityStream(
  read: ActivityStreamRead,
  historyDir: string,
  file: string,
  filters: ActivityFilters,
  target: ActivityEntry[],
): Promise<void> {
  const id = historyStreamId(file);
  const historyPath = path.join(historyDir, file);
  if (read.summary.trusted(file)?.irregular === true) read.irregularRead += 1;
  // Only a session that keeps bounds needs the identity of the bytes read.
  const snapshot = read.summary.enabled
    ? await readIdentifiedHistorySnapshot(historyPath, id)
    : { ...(await readHistorySnapshot(historyPath, id)), source: null };
  // A stream removed since the listing contributed no bytes, so it was not parsed.
  if (snapshot.raw_bytes !== null) read.streamsRead += 1;
  read.summary.record(file, snapshot);
  for (const entry of snapshot.entries) {
    const candidate = normalizeActivityEntry(id, entry);
    if (includeActivityEntry(entry, candidate, filters)) {
      target.push(candidate);
    }
  }
}

/** Disclose an unbounded read on a tracker large enough to keep stream bounds. */
function activityHistoryReadReceipt(
  read: ActivityStreamRead,
  unwindowed: boolean,
): ActivityHistoryReadReceipt | undefined {
  const { summary, files, streamsRead, revalidatedStale, irregularRead } = read;
  // A healthy summary still discloses a read that parsed most streams: its
  // cost followed the archive because the query, not the summary, reached it,
  // unless most of the parsed streams had stale bounds (at open or mid-read;
  // disjoint counts) or irregular timestamps, which are always read.
  const parsedMost = summary.enabled && streamsRead * 2 > files.length;
  const staleReads = summary.staleAtOpen + revalidatedStale;
  const queryReason = (staleReads + irregularRead) * 2 > streamsRead
    ? (staleReads >= irregularRead ? "summary_stale" : "irregular_timestamps")
    : unwindowed
      ? "unwindowed_query"
      : "window_reaches_most_streams";
  // Hooks that ended pruning explain the full read better than stale bounds,
  // which a rebuild would not fix while the hooks stay registered.
  const reason = read.hooksActivated ? "read_hooks_active" : summary.fallback ?? (parsedMost ? queryReason : undefined);
  return reason === undefined
    ? undefined
    : { reason, streams_read: streamsRead, streams_total: files.length };
}

/**
 * Collect every matching entry in history-file order. Trusted bounds skip
 * streams outside the window; the rows are exactly those of a complete read.
 */
async function collectActivityEntries(
  pmRoot: string,
  historyDir: string,
  filters: ActivityFilters,
): Promise<{ entries: ActivityEntry[]; history_read?: ActivityHistoryReadReceipt }> {
  const read = await openActivityStreamRead(pmRoot, historyDir, filters);
  // Rows per history file, so streams re-read after revalidation keep file order.
  const rowsByPosition: ActivityEntry[][] = read.files.map(() => []);
  const skipped: Array<{ file: string; position: number }> = [];
  for (const [position, file] of read.files.entries()) {
    const bounds = read.summary.trusted(file);
    if (bounds !== undefined && !streamMayMatchWindow(bounds, filters)) {
      skipped.push({ file, position });
      continue;
    }
    await readActivityStream(read, historyDir, file, filters, rowsByPosition[position]!);
  }
  await finishBoundedRead(read, skipped, ({ file, position }) =>
    readActivityStream(read, historyDir, file, filters, rowsByPosition[position]!));
  const combined = rowsByPosition.flat();
  const receipt = activityHistoryReadReceipt(read, filters.from === undefined);
  return receipt === undefined ? { entries: combined } : { entries: combined, history_read: receipt };
}

/**
 * Whether an unread regular stream can still place an entry above `last`.
 * Its entries sort no earlier than its newest timestamp, and entries tied on
 * that timestamp sort by item id, which is the stream's own id.
 */
function streamCanOutrank(newest: string, streamId: string, last: ActivityEntry): boolean {
  const byTimestamp = newest.localeCompare(last.ts);
  return byTimestamp > 0 || (byTimestamp === 0 && streamId.localeCompare(last.id) <= 0);
}

interface DeferredActivityStream {
  file: string;
  /** Position in history-file order, the complete read's tie-breaker. */
  position: number;
  id: string;
  newest: string;
}

/**
 * Order unread regular streams by the activity order of their best possible
 * entry (newest timestamp, then item id, then file order for distinct names
 * that collate equally), so once one stream cannot outrank the last selected
 * row, no later stream can either.
 */
function compareDeferredStreams(left: DeferredActivityStream, right: DeferredActivityStream): number {
  return (
    right.newest.localeCompare(left.newest) ||
    left.id.localeCompare(right.id) ||
    left.position - right.position
  );
}

/**
 * The newest-rows selection: rows accumulate unsorted and are cut back to
 * `limit` only once the pool doubles, so each row is sorted a bounded number
 * of times. Between cuts the cutoff is the last cut's row, which ranks no
 * higher than the true cutoff, so stopping against it never skips a stream
 * that could contribute. Equal sort keys keep history-file order.
 */
class RecentActivityPool {
  private rows: ActivityEntry[] = [];
  // Weak keys let rows (and their patch payloads) cut from the pool be freed.
  private readonly filePosition = new WeakMap<ActivityEntry, number>();
  private cutoff: ActivityEntry | undefined;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Parse one stream into the pool, remembering its history-file position. */
  async read(read: ActivityStreamRead, historyDir: string, filters: ActivityFilters, stream: { file: string; position: number }): Promise<void> {
    const start = this.rows.length;
    await readActivityStream(read, historyDir, stream.file, filters, this.rows);
    for (let index = start; index < this.rows.length; index += 1) this.filePosition.set(this.rows[index]!, stream.position);
  }

  /** Whether an unread regular stream may still contribute a selected row. */
  admits(stream: DeferredActivityStream): boolean {
    if (this.limit === 0) return false;
    return this.cutoff === undefined || streamCanOutrank(stream.newest, stream.id, this.cutoff);
  }

  /** Cut once the pool first fills, then whenever it doubles. */
  cutWhenFull(): void {
    if (this.rows.length >= (this.cutoff === undefined ? this.limit : 2 * this.limit)) this.cut();
  }

  /** Sort and keep the `limit` best rows; the last one becomes the cutoff. */
  cut(): ActivityEntry[] {
    this.rows = this.rows
      .sort((left, right) => compareActivityEntries(left, right) || this.filePosition.get(left)! - this.filePosition.get(right)!)
      .slice(0, this.limit);
    this.cutoff = this.limit > 0 && this.rows.length === this.limit ? this.rows[this.limit - 1] : undefined;
    return this.rows;
  }
}

/**
 * Split the streams a recent read can reach: untrusted and irregular streams
 * are read first, so a damaged stream raises the complete read's error even
 * for a zero limit; trusted regular streams are deferred in the activity
 * order of their newest entry.
 */
function partitionRecentActivityStreams(
  read: ActivityStreamRead,
  filters: ActivityFilters,
): { readFirst: Array<{ file: string; position: number }>; deferred: DeferredActivityStream[]; outsideWindow: Array<{ file: string; position: number }> } {
  const readFirst: Array<{ file: string; position: number }> = [];
  const deferred: DeferredActivityStream[] = [];
  const outsideWindow: Array<{ file: string; position: number }> = [];
  for (const [position, file] of read.files.entries()) {
    const bounds = read.summary.trusted(file);
    if (bounds !== undefined && !streamMayMatchWindow(bounds, filters)) {
      outsideWindow.push({ file, position });
      continue;
    }
    if (bounds !== undefined && !bounds.irregular) {
      deferred.push({ file, position, id: historyStreamId(file), newest: bounds.newest! });
    } else {
      readFirst.push({ file, position });
    }
  }
  return { readFirst, deferred: deferred.sort(compareDeferredStreams), outsideWindow };
}

/**
 * Select the `limit` newest matching entries, reading deferred streams until
 * the next one cannot outrank the cutoff row, so no unread entry can enter
 * the selection.
 */
async function collectRecentActivityEntries(
  pmRoot: string,
  historyDir: string,
  filters: ActivityFilters,
  limit: number,
): Promise<{ entries: ActivityEntry[]; history_read?: ActivityHistoryReadReceipt }> {
  const read = await openActivityStreamRead(pmRoot, historyDir, filters);
  const { readFirst, deferred, outsideWindow } = partitionRecentActivityStreams(read, filters);
  const pool = new RecentActivityPool(limit);
  for (const stream of readFirst) {
    await pool.read(read, historyDir, filters, stream);
    pool.cutWhenFull();
  }
  pool.cut();
  let consumed = 0;
  for (const stream of deferred) {
    if (!pool.admits(stream)) break;
    await pool.read(read, historyDir, filters, stream);
    pool.cutWhenFull();
    consumed += 1;
  }
  // Streams skipped on their bounds that changed while the read ran are read
  // now; a better cutoff from them can only exclude more, never readmit.
  const skipped = [...deferred.slice(consumed), ...outsideWindow];
  await finishBoundedRead(read, skipped, async (stream) => {
    await pool.read(read, historyDir, filters, stream);
    pool.cutWhenFull();
  });
  const entries = pool.cut();
  const receipt = activityHistoryReadReceipt(read, false);
  return receipt === undefined ? { entries } : { entries, history_read: receipt };
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

/** Bind continuation to matching content before emitting digest or per-event rows. */
function projectActivityRows(
  projectionMode: ActivityProjectionMode,
  matchingActivity: ActivityEntry[],
  pageOptions: Parameters<typeof paginateWindowQuery>[1],
  itemsById: ReadonlyMap<string, ActivityItemMetadata>,
  projectProvenance: (entry: ActivityEntry) => HistoryProvenanceRow,
): ActivityRowsProjection {
  if (projectionMode === "digest") {
    const { rows, ...page } = paginateWindowQuery(buildActivityDigest(matchingActivity, itemsById), pageOptions);
    return { rows: { activity_digest: rows }, compact: false, page };
  }
  const { rows: activity, ...page } = paginateWindowQuery(matchingActivity, pageOptions);
  if (projectionMode === "compact") {
    return { rows: { compact_activity: formatCompactActivity(activity) }, compact: true, page };
  }
  if (projectionMode === "provenance") {
    return { rows: { provenance_activity: activity.map(projectProvenance) }, compact: false, page };
  }
  return { rows: { activity }, compact: false, page };
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
  streamMayMatchWindow,
  streamCanOutrank,
  compareDeferredStreams,
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
  const clock = resolveWindowQueryClock("activity", options.after);
  const filters = resolveActivityFilters(options, projectionMode, clock);
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
  const collected = await collectActivityEntries(
    context.pmRoot,
    prepared.historyDir,
    filters,
  );
  const matchingActivity = sortActivity(collected.entries).filter(
    matchesProvenance,
  );
  const projected = projectActivityRows(
    projectionMode,
    matchingActivity,
    {
      command: "activity", after: options.after, clock, limit: filters.limit,
      query: { pmRoot: context.pmRoot, projectionMode, filters: { ...filters, limit: undefined, limitSource: undefined }, matching_activity_digest: projectionMode === "digest" ? fingerprintWindowRows(matchingActivity) : undefined, vocabulary, provenanceDimensions },
    },
    prepared.itemsById,
    (entry) =>
      projectHistoryProvenance(entry, vocabulary, { itemId: entry.id }),
  );
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
    ...projected.page,
    window: { anchor: clock, from: filters.from ?? null, to: filters.to ?? null },
    limit: filters.limit ?? null,
    ...(projectionMode === "digest"
      ? {
          activity_summary: {
            window: { from: filters.from!, to: filters.to! },
            event_count: matchingActivity.length,
            item_count: projected.page.total_count,
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
    ...(collected.history_read ? { history_read: collected.history_read } : {}),
  };
}

/**
 * Read the newest compact activity rows without a page cursor or totals.
 * Rows equal the first page of `pm activity --raw --limit <limit>`. The limit
 * caps the rows returned, not the history parsed: trusted stream bounds let
 * the read skip streams that cannot reach those rows, but a tracker under the
 * summary threshold (500 streams) parses every stream, with no receipt.
 */
export async function readRecentActivity(
  options: { limit: number },
  global: GlobalOptions,
): Promise<RecentActivityResult> {
  const context = await resolveActivityRuntimeContext(global);
  const clock = resolveWindowQueryClock("activity", undefined);
  const filters = resolveActivityFilters(
    { compact: true, limit: String(options.limit) },
    "compact",
    clock,
  );
  const prepared = await prepareActivityHistoryRead(context);
  const collected = await collectRecentActivityEntries(
    context.pmRoot,
    prepared.historyDir,
    filters,
    filters.limit!,
  );
  return {
    rows: formatCompactActivity(collected.entries),
    ...(collected.history_read ? { history_read: collected.history_read } : {}),
  };
}
