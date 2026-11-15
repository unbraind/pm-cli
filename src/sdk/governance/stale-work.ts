/**
 * @module sdk/governance/stale-work
 *
 * Detects unattended in-progress work from tracker metadata and append-only
 * history without changing item ownership or lifecycle state. One activity
 * clock and one threshold serve every consumer (health, context, claim
 * refusals, stale-claim takeover and next-item occupancy). Advisory reads
 * degrade unreadable history to metadata activity while the takeover fails
 * closed, so an advisory "idle" is a candidate, never takeover eligibility.
 * The clock includes history
 * because some recorded work leaves `updated_at` behind: `pm restore` writes
 * the historical document, with its historical `updated_at`, then appends a
 * new `restore` entry. Only substantive entries count: maintenance such as
 * `history_compact` or `history_repair` preserves the record without working
 * on the item, so it must not reset an abandoned claim's idle time. A
 * compaction baseline stands for its pruned prefix: it contributes the
 * prefix's newest substantive time, which compaction records as
 * `context.history_compaction.last_activity_at` (null when the prefix held no
 * work). A baseline written before that field existed contributes its own
 * timestamp, the time of the last pruned entry: an upper bound, so a legacy
 * baseline can only make a claim look more recent, never take over active work.
 */
import path from "node:path";
import { classifyHistoryEvent } from "../../core/history/event-classification.js";
import { readHistoryEntries } from "../../core/history/read.js";
import { normalizeStatusForRegistry } from "../../core/item/status.js";
import type { RuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { redactIdentityCredentials } from "../../core/shared/url-credentials.js";
import type { ItemMetadata } from "../../types/index.js";

/** Setting key that owns the stale-work inactivity threshold for every consumer. */
export const STALE_WORK_THRESHOLD_SETTING = "mutation_guard.stale_in_progress_hours";

const HOUR_MS = 3_600_000;

/** One unclaimed in-progress item whose recorded activity exceeded policy. */
export interface StaleInProgressItem {
  /** Stable item identifier. */
  id: string;
  /** Most recent valid item or history timestamp. */
  last_activity_at: string;
  /** Whole hours elapsed at scan time. */
  age_hours: number;
}

/** Read-only stale-work diagnostic returned to SDK and health consumers. */
export interface StaleInProgressScan {
  /** Policy threshold applied by the scan. */
  threshold_hours: number;
  /** Number of stale items. */
  count: number;
  /** Deterministically ordered stale items. */
  items: StaleInProgressItem[];
  /** Agent-facing recovery guidance. */
  remediation: string;
}

/** One in-progress item reported by the ownership and idleness classification. */
export interface InProgressWorkItem {
  /** Stable item identifier. */
  id: string;
  /** Most recent valid item or history timestamp; null when neither parses. */
  last_activity_at: string | null;
  /** Whole hours elapsed at scan time; null when the activity time is unknown. */
  age_hours: number | null;
  /** Current holder, with URL credentials an older version stored redacted (GH-1707); omitted when the item has no assignee. */
  assignee?: string;
}

/** Count and deterministically ordered members of one in-progress work group. */
export interface InProgressWorkGroup {
  /** Number of items in the group. */
  count: number;
  /** Members ordered by idle age descending, then id. */
  items: InProgressWorkItem[];
}

/** Ownership and idleness classification of in-progress work (GH-1724). */
export interface InProgressWorkScan {
  /** Policy threshold applied by the scan, in whole hours. */
  threshold_hours: number;
  /** In-progress items with no assignee, and so no live claim, at any age. */
  unowned: InProgressWorkGroup;
  /** In-progress items with no recorded activity within the threshold, owned or not. */
  idle: InProgressWorkGroup;
  /** Unowned and idle items: the `stale_in_progress_items` population. */
  stale: StaleInProgressScan;
}

/** Inputs for the pure stale-work classifiers. */
export interface InspectStaleInProgressOptions {
  /** Status id configured as the active lifecycle state. */
  in_progress_status?: string;
  /**
   * Workspace status registry. When present, each item's stored status
   * resolves through the registry's aliases before matching, so the scan reads
   * the same population as the `in_progress` counters; the target defaults to
   * the registry's in-progress status. Without it, statuses match by their
   * trimmed, lowercased, underscore-normalized spelling.
   */
  status_registry?: RuntimeStatusRegistry;
  /** Age threshold in hours. */
  threshold_hours: number;
  /** Scan timestamp, injectable for deterministic tests. */
  now?: Date;
  /** Optional latest-history timestamp lookup. */
  last_history_activity?: (item: ItemMetadata) => string | undefined;
}

function normalizedStatus(value: string | undefined): string {
  return (value ?? "in_progress").trim().toLowerCase().replaceAll("-", "_");
}

/** Normalize a configured stale-work threshold to whole hours, never below one. */
export function normalizeStaleWorkThresholdHours(value: number): number {
  return Math.max(1, Math.trunc(value));
}

/**
 * Return the item's last recorded activity: the most recent valid timestamp
 * among its `updated_at` and its newest substantive history entry, or
 * undefined when neither parses. Ordinary mutations advance both; a restore or
 * rollback advances only the history stream, so the stream must be consulted.
 */
export function resolveLastActivityAt(
  updatedAt: string | undefined,
  historyTimestamp: string | undefined,
): string | undefined {
  let latest: { value: string; time: number } | undefined;
  for (const value of [updatedAt, historyTimestamp]) {
    const time = Date.parse(value ?? "");
    if (typeof value === "string" && Number.isFinite(time) && (latest === undefined || time > latest.time)) {
      latest = { value, time };
    }
  }
  return latest?.value;
}

/** Whole hours elapsed from a valid timestamp to `nowMs`, never negative. */
export function wholeHoursSince(timestamp: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(timestamp)) / HOUR_MS));
}

/** Largest absolute epoch offset a JavaScript Date can represent (ECMA-262). */
const MAX_DATE_MS = 8.64e15;

/** Instant at which activity recorded at `timestamp` becomes stale, or null when it lies beyond the representable Date range. */
export function staleEligibleAt(timestamp: string, thresholdHours: number): string | null {
  const eligibleMs = Date.parse(timestamp) + thresholdHours * HOUR_MS;
  return Math.abs(eligibleMs) <= MAX_DATE_MS ? new Date(eligibleMs).toISOString() : null;
}

/** Build the in-progress membership test once per scan: registry-resolved when a registry is given. */
function inProgressMatcher(
  options: Pick<InspectStaleInProgressOptions, "in_progress_status" | "status_registry">,
): (item: ItemMetadata) => boolean {
  const registry = options.status_registry;
  if (registry === undefined) {
    const target = normalizedStatus(options.in_progress_status);
    return (item) => normalizedStatus(String(item.status)) === target;
  }
  const target = normalizeStatusForRegistry(options.in_progress_status ?? registry.in_progress_status, registry);
  return (item) => normalizeStatusForRegistry(item.status, registry) === target;
}

function assigneeOf(item: ItemMetadata): string | undefined {
  const assignee = item.assignee?.trim();
  return assignee !== undefined && assignee.length > 0 ? assignee : undefined;
}

/** Order by idle age descending (unknown ages last), then id. */
function sortWorkItems<T extends { id: string; age_hours: number | null }>(items: T[]): T[] {
  return items.sort(
    (left, right) =>
      (right.age_hours ?? -1) - (left.age_hours ?? -1) || left.id.localeCompare(right.id),
  );
}

const STALE_REMEDIATION =
  "Claim active work with `pm claim <id>` or return abandoned work to open with `pm update <id> --status open`.";

/** Where one in-progress item belongs: its ownership group row, idle row and stale row, each optional. */
interface InProgressWorkPlacement {
  unowned?: InProgressWorkItem;
  idle?: InProgressWorkItem;
  stale?: StaleInProgressItem;
}

/** Place one in-progress item; idleness needs a valid activity time, ownership does not. */
function placeInProgressItem(
  item: ItemMetadata,
  lastActivityAt: string | undefined,
  thresholdHours: number,
  nowMs: number,
): InProgressWorkPlacement {
  const assignee = assigneeOf(item);
  if (lastActivityAt === undefined) {
    return assignee === undefined
      ? { unowned: { id: item.id, last_activity_at: null, age_hours: null } }
      : {};
  }
  const row: StaleInProgressItem = {
    id: item.id,
    last_activity_at: lastActivityAt,
    age_hours: wholeHoursSince(lastActivityAt, nowMs),
  };
  const isIdle = row.age_hours >= thresholdHours;
  // Diagnostics never echo URL userinfo an older version stored in an identity (GH-1707).
  if (assignee !== undefined) return isIdle ? { idle: { ...row, assignee: redactIdentityCredentials(assignee) } } : {};
  return isIdle
    ? { unowned: { ...row }, idle: { ...row }, stale: { ...row } }
    : { unowned: { ...row } };
}

/** Classify in-progress work by ownership and idleness without filesystem access. */
export function inspectInProgressWork(
  items: readonly ItemMetadata[],
  options: InspectStaleInProgressOptions,
): InProgressWorkScan {
  const thresholdHours = normalizeStaleWorkThresholdHours(options.threshold_hours);
  const nowMs = (options.now ?? new Date()).getTime();
  const isInProgress = inProgressMatcher(options);
  const unowned: InProgressWorkItem[] = [];
  const idle: InProgressWorkItem[] = [];
  const stale: StaleInProgressItem[] = [];
  for (const item of items) {
    if (!isInProgress(item)) continue;
    const placement = placeInProgressItem(
      item,
      resolveLastActivityAt(item.updated_at, options.last_history_activity?.(item)),
      thresholdHours,
      nowMs,
    );
    if (placement.unowned) unowned.push(placement.unowned);
    if (placement.idle) idle.push(placement.idle);
    if (placement.stale) stale.push(placement.stale);
  }
  return {
    threshold_hours: thresholdHours,
    unowned: { count: unowned.length, items: sortWorkItems(unowned) },
    idle: { count: idle.length, items: sortWorkItems(idle) },
    stale: {
      threshold_hours: thresholdHours,
      count: stale.length,
      items: sortWorkItems(stale),
      remediation: STALE_REMEDIATION,
    },
  };
}

/** Classify stale unclaimed in-progress items without filesystem access. */
export function inspectStaleInProgressItems(
  items: readonly ItemMetadata[],
  options: InspectStaleInProgressOptions,
): StaleInProgressScan {
  return inspectInProgressWork(items, options).stale;
}

/** A decoded history value with the shape every activity and ownership read relies on. */
export interface WellFormedHistoryRecord {
  /** Event timestamp (validity is judged separately). */
  ts: string;
  /** Operation name. */
  op: string;
  /** Patch operations, each a record with a string path. */
  patch: Array<{ path: string; value?: unknown }>;
  /** Declared semantic effect, when present. */
  event_class?: unknown;
}

/**
 * Whether a decoded history value is a well-formed record: string `ts` and
 * `op`, and a `patch` list whose operations are all records with a string
 * `path` (event classification splits it). Shared by the
 * advisory reads, which skip anything else, and the stale-claim takeover,
 * which refuses to judge a stream containing anything else.
 */
export function isWellFormedHistoryRecord(entry: unknown): entry is WellFormedHistoryRecord {
  if (entry === null || typeof entry !== "object") return false;
  const record = entry as { ts?: unknown; op?: unknown; patch?: unknown };
  return (
    typeof record.ts === "string" &&
    typeof record.op === "string" &&
    Array.isArray(record.patch) &&
    record.patch.every(
      (operation) =>
        operation !== null && typeof operation === "object" && typeof (operation as { path?: unknown }).path === "string",
    )
  );
}

/**
 * The activity time one decoded history value contributes: a substantive
 * record's own timestamp, a compaction baseline's recorded prefix activity
 * (or its timestamp when it predates that field), and nothing for maintenance
 * or for values that are not well-formed records.
 */
function activityTimestampOf(entry: unknown): string | undefined {
  if (!isWellFormedHistoryRecord(entry)) return undefined;
  if (entry.op === "history_compact_baseline") {
    const recorded = readCompactionActivity(entry);
    // A legacy or malformed receipt degrades to the baseline's own time, the conservative bound.
    return recorded.kind === "recorded" ? (recorded.at ?? undefined) : entry.ts;
  }
  return classifyHistoryEvent(entry as unknown as Parameters<typeof classifyHistoryEvent>[0]) === "substantive"
    ? entry.ts
    : undefined;
}

/** Whether a value is a non-null, non-array object. */
function isPlainRecord(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read the prefix activity a compaction baseline records. `recorded` carries
 * a parseable timestamp or null (no work in the prefix); `legacy` means the
 * receipt predates the field; `malformed` means the context, the receipt or
 * the value has the wrong shape (for example `history_compaction: null`).
 */
function readCompactionActivity(
  entry: WellFormedHistoryRecord,
): { kind: "recorded"; at: string | null } | { kind: "legacy" } | { kind: "malformed" } {
  const context = (entry as { context?: unknown }).context;
  if (context === undefined) return { kind: "legacy" };
  if (!isPlainRecord(context)) return { kind: "malformed" };
  const receipt = (context as { history_compaction?: unknown }).history_compaction;
  if (receipt === undefined) return { kind: "legacy" };
  if (!isPlainRecord(receipt)) return { kind: "malformed" };
  if (!("last_activity_at" in receipt)) return { kind: "legacy" };
  const at = (receipt as { last_activity_at?: unknown }).last_activity_at;
  if (at === null) return { kind: "recorded", at: null };
  return typeof at === "string" && Number.isFinite(Date.parse(at)) ? { kind: "recorded", at } : { kind: "malformed" };
}

/**
 * Whether a decoded history value supports an idleness judgement: a
 * well-formed record with a parseable timestamp and, for a compaction
 * baseline, a receipt that is absent (legacy) or well formed. The stale-claim
 * takeover treats a stream with any other value as unreadable, because a
 * skipped record could be the recent work.
 */
export function isJudgeableHistoryRecord(entry: unknown): entry is WellFormedHistoryRecord {
  return (
    isWellFormedHistoryRecord(entry) &&
    Number.isFinite(Date.parse(entry.ts)) &&
    (entry.op !== "history_compact_baseline" || readCompactionActivity(entry).kind !== "malformed")
  );
}

/**
 * Newest valid activity time among history entries: substantive records and
 * the recorded prefix activity of compaction baselines. Undefined when none
 * parses. Decoded values that are not well-formed records (a `null` line, a
 * record without `op`) are skipped.
 */
export function latestHistoryTimestamp(
  history: ReadonlyArray<unknown>,
): string | undefined {
  let latest: { value: string; time: number } | undefined;
  for (const entry of history) {
    const value = activityTimestampOf(entry);
    const time = Date.parse(value ?? "");
    if (value !== undefined && Number.isFinite(time) && (latest === undefined || time > latest.time)) {
      latest = { value, time };
    }
  }
  return latest?.value;
}

/**
 * The activity a compaction baseline records for the prefix it prunes: the
 * prefix's newest activity time, or null when the prefix held no work.
 */
export function recordedPrefixActivity(prunedEntries: ReadonlyArray<unknown>): string | null {
  return latestHistoryTimestamp(prunedEntries) ?? null;
}

/** Read the newest valid history timestamp of one item stream, or undefined when unreadable or empty. */
export async function readLatestHistoryActivity(
  pmRoot: string,
  itemId: string,
): Promise<string | undefined> {
  let history: Awaited<ReturnType<typeof readHistoryEntries>>;
  try {
    history = await readHistoryEntries(
      path.join(pmRoot, "history", `${itemId}.jsonl`),
      itemId,
    );
  } catch {
    return undefined;
  }
  return latestHistoryTimestamp(history);
}

/**
 * Scan tracker metadata and history for unowned and idle in-progress work.
 * History is read for every unowned in-progress item, whose row is published
 * with its exact activity time, and for owned ones whose `updated_at` is
 * already at or past the threshold (or unparseable): a newer history entry can
 * only make an item more recent, so a fresh `updated_at` proves an owned item
 * is not idle, and owned fresh items are never published.
 * An unreadable stream degrades to metadata activity, since these reads are
 * advisory; a takeover instead refuses when it cannot read the stream.
 */
export async function scanInProgressWork(
  pmRoot: string,
  items: readonly ItemMetadata[],
  options: Omit<InspectStaleInProgressOptions, "last_history_activity">,
): Promise<InProgressWorkScan> {
  const thresholdHours = normalizeStaleWorkThresholdHours(options.threshold_hours);
  const nowMs = (options.now ?? new Date()).getTime();
  const isInProgress = inProgressMatcher(options);
  const historyTimestamps = new Map<string, string>();
  await Promise.all(
    items
      .filter((item) => {
        if (!isInProgress(item)) return false;
        if (assigneeOf(item) === undefined) return true;
        const updatedAt = resolveLastActivityAt(item.updated_at, undefined);
        return updatedAt === undefined || wholeHoursSince(updatedAt, nowMs) >= thresholdHours;
      })
      .map(async (item) => {
        const latest = await readLatestHistoryActivity(pmRoot, item.id);
        if (latest !== undefined) historyTimestamps.set(item.id, latest);
      }),
  );
  return inspectInProgressWork(items, {
    ...options,
    now: new Date(nowMs),
    last_history_activity: (item) => historyTimestamps.get(item.id),
  });
}

/** Scan tracker history and metadata for stale unclaimed in-progress work. */
export async function scanStaleInProgressItems(
  pmRoot: string,
  items: readonly ItemMetadata[],
  options: Omit<InspectStaleInProgressOptions, "last_history_activity">,
): Promise<StaleInProgressScan> {
  return (await scanInProgressWork(pmRoot, items, options)).stale;
}
