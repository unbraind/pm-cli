/**
 * @module core/history/event-index
 *
 * Maintains a rebuildable SQLite projection over append-only history streams
 * for cursor-resumable cross-item mutation event reads.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { HistoryEntry } from "../../types/index.js";
import { isFileMissingError } from "../fs/fs-utils.js";
import {
  acquireLock,
  captureProcessIdentity,
  isProcessIdentityAlive,
  hasUnexpiredLockOwner,
} from "../lock/lock.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { isMillisecondPrecisionRfc3339DateTime } from "../shared/time.js";
import { readHistorySnapshot } from "./read.js";
import { verifyHistoryChainWithVersion } from "./replay.js";
import { classifyHistoryEvent } from "./event-classification.js";
import {
  loadDatabaseSync,
  loadStableDatabaseSync,
} from "../store/sqlite-runtime.js";

const EVENT_INDEX_FILENAME = "history-event-index.sqlite";
const EVENT_INDEX_VERSION = "7";
const AUTHORITATIVE_HISTORY_CACHE_LIMIT = 8;
const HISTORY_STREAM_CONTENT_READ_CONCURRENCY = 32;
const HISTORY_EVENT_INDEX_LOCK_ID = "history-event-index";
const HISTORY_EVENT_INDEX_APPEND_OWNER_PREFIX = "history-event-index:append:";
const HISTORY_EVENT_INDEX_REPAIR_COOLDOWN_MS = 5_000;
const HISTORY_EVENT_INDEX_LOCK_TTL_SECONDS = 300;
const HISTORY_EVENT_INDEX_LOCK_WAIT_MS = 30_000;
const HISTORY_EVENT_INDEX_INVALIDATION_LOCK_ID =
  "history-event-index-invalidation";
const HISTORY_EVENT_INDEX_INVALIDATION_DIRECTORY =
  "history-event-index-invalidations";
const HISTORY_EVENT_INDEX_INVALIDATION_MAX_UNVERIFIED_AGE_MS =
  HISTORY_EVENT_INDEX_LOCK_TTL_SECONDS * 2 * 1_000;
const HISTORY_INDEX_CHANGED = Symbol("history-index-changed");
type DatabaseSyncConstructor = typeof DatabaseSync;

interface AuthoritativeHistoryStreamCache {
  signature: string;
  byte_size: number;
  events: IndexedHistoryEvent[];
}

interface AuthoritativeHistoryCache {
  streams: Map<string, AuthoritativeHistoryStreamCache>;
  ordered_events: IndexedHistoryEvent[];
}

interface AuthoritativeHistorySnapshot {
  events: IndexedHistoryEvent[];
  stream_receipts: ReadonlyMap<string, HistoryStreamContentReceipt>;
}

/** Full-stream byte identity, independent of filesystem timestamps. */
interface HistoryStreamContentReceipt {
  byte_size: number;
  content_hash: string;
}

const authoritativeHistoryCaches = new Map<string, AuthoritativeHistoryCache>();

/** Stable location of one history entry inside its authoritative stream. */
export interface IndexedHistoryEvent {
  /** History stream subject, normally an item id or `_workspace`. */
  stream_id: string;
  /** Zero-based line position among parsed entries in the stream. */
  stream_offset: number;
  /** Authoritative history entry. */
  entry: HistoryEntry;
  /** Exact recorded values retained by authoritative verification before timestamp normalization. */
  recorded_entry?: HistoryEntry;
}

/** Index-native filters and continuation bounds for mutation events. */
export interface HistoryEventIndexQuery {
  /** Verify every selected authoritative chain before filtering or pagination. */
  verify?: boolean;
  /** Return events strictly after this timestamp. */
  after_ts?: string;
  /** Stream tie-breaker paired with `after_ts`. */
  after_stream_id?: string;
  /** Offset tie-breaker paired with `after_ts` and `after_stream_id`. */
  after_stream_offset?: number;
  /** Inclusive timestamp lower bound used when no cursor is supplied. */
  since_ts?: string;
  /** Include only these operation names. */
  ops?: readonly string[];
  /** Include only these authors. */
  authors?: readonly string[];
  /** Include recorded harnesses or alias authors resolving to them. */
  harnesses?: readonly string[];
  /** Legacy author literals accepted by the requested harness vocabulary. */
  harness_alias_authors?: readonly string[];
  /** Include only these privacy-safe invocation fingerprints. */
  agent_instances?: readonly string[];
  /** Exact extensible provenance dimension predicates. */
  provenance?: ReadonlyArray<{
    dimension: string;
    values: readonly string[];
  }>;
  /** Include only these stream subjects. */
  stream_ids?: readonly string[];
  /** Maximum events returned. */
  limit: number;
}

/** Bounded mutation-event query result from the persistent projection. */
export interface HistoryEventIndexQueryResult {
  /** Ordered event rows. */
  events: IndexedHistoryEvent[];
  /** Whether another matching event exists. */
  has_more: boolean;
  /** Number of complete authoritative streams verified, when requested. */
  verified_streams?: number;
}

/** Latest substantive immutable event for each requested history stream. */
export type LatestSubstantiveHistoryEvents = Readonly<
  Record<string, IndexedHistoryEvent>
>;

function eventIndexPath(pmRoot: string): string {
  return path.join(pmRoot, "runtime", EVENT_INDEX_FILENAME);
}

/** Share automatic-repair backoff across independent CLI and SDK readers. */
function refusedHistoryRepairPath(pmRoot: string): string {
  return path.join(pmRoot, "runtime", "history-event-index-repair-deferred");
}

/** A refused full publication must not restart a complete build on every read. */
async function hasRecentRefusedHistoryRepair(pmRoot: string): Promise<boolean> {
  try {
    const deferredAt = Number(
      await fs.readFile(refusedHistoryRepairPath(pmRoot), "utf8"),
    );
    const age = Date.now() - deferredAt;
    return age >= 0 && age < HISTORY_EVENT_INDEX_REPAIR_COOLDOWN_MS;
  } catch {
    return false;
  }
}

/** Backoff is optional derived state and cannot mask repair errors or revive removed storage. */
async function deferAutomaticHistoryRepair(pmRoot: string): Promise<void> {
  try {
    await fs.writeFile(refusedHistoryRepairPath(pmRoot), `${Date.now()}\n`);
  } catch {
    // A failed receipt only loses backoff; authority and invalidations are unchanged.
  }
}

interface HistoryEventIndexInvalidations {
  pending: string[];
  committed: string[];
}

function historyEventIndexInvalidationDirectory(pmRoot: string): string {
  return path.join(
    pmRoot,
    "runtime",
    HISTORY_EVENT_INDEX_INVALIDATION_DIRECTORY,
  );
}

async function listHistoryEventIndexInvalidations(
  pmRoot: string,
): Promise<HistoryEventIndexInvalidations> {
  const entries = await fs
    .readdir(historyEventIndexInvalidationDirectory(pmRoot))
    .catch((error: unknown) => {
      if (isFileMissingError(error)) return [];
      throw error;
    });
  return {
    pending: entries.filter((name) => name.endsWith(".pending")).sort(),
    committed: entries.filter((name) => name.endsWith(".committed")).sort(),
  };
}

/** Remove only pending markers proven abandoned by the caller's invalidation-lock ownership. */
async function recoverAbandonedHistoryEventIndexInvalidations(
  pmRoot: string,
): Promise<HistoryEventIndexInvalidations> {
  const invalidations = await listHistoryEventIndexInvalidations(pmRoot);
  const pending = (
    await Promise.all(
      invalidations.pending.map(async (name) => {
        const owner = /^(\d+)-(unknown|\d+)-(\d+)-.+\.pending$/u.exec(name);
        if (owner !== null) {
          const processStartIdentity = owner[2];
          if (
            await isProcessIdentityAlive(
              {
                pid: Number(owner[1]),
                ...(processStartIdentity === "unknown"
                  ? {}
                  : { process_start_identity: processStartIdentity }),
              },
              Math.max(0, Date.now() - Number(owner[3])),
              HISTORY_EVENT_INDEX_INVALIDATION_MAX_UNVERIFIED_AGE_MS,
            )
          ) {
            return name;
          }
        }
        await fs.rm(
          path.join(historyEventIndexInvalidationDirectory(pmRoot), name),
          {
            force: true,
          },
        );
        return null;
      }),
    )
  ).filter((name): name is string => name !== null);
  return { pending, committed: invalidations.committed };
}

/** Serialize marker publication and recovery, honoring optional zero-retry repair. */
async function withHistoryEventIndexInvalidationLock<T>(
  pmRoot: string,
  operation: () => Promise<T>,
  waitMs = HISTORY_EVENT_INDEX_LOCK_WAIT_MS,
): Promise<T> {
  const release = await acquireLock(
    pmRoot,
    HISTORY_EVENT_INDEX_INVALIDATION_LOCK_ID,
    HISTORY_EVENT_INDEX_LOCK_TTL_SECONDS,
    `history-event-index-invalidation:${process.pid}`,
    false,
    false,
    waitMs,
    waitMs === 0 ? { maxWaitMs: 0 } : undefined,
  );
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function beginHistoryEventIndexInvalidation(
  pmRoot: string,
): Promise<{ pendingPath: string; committedPath: string }> {
  const directory = historyEventIndexInvalidationDirectory(pmRoot);
  await fs.mkdir(directory, { recursive: true });
  const token = randomUUID();
  const processIdentity = await captureProcessIdentity();
  const pendingPath = path.join(
    directory,
    `${processIdentity.pid}-${processIdentity.process_start_identity ?? "unknown"}-${Date.now()}-${token}.pending`,
  );
  await fs.writeFile(pendingPath, "pending\n", { flag: "wx" });
  return {
    pendingPath,
    committedPath: path.join(directory, `${token}.committed`),
  };
}

function sameInvalidationNames(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((name, index) => name === right[index])
  );
}

async function invalidateHistoryEventIndex(pmRoot: string): Promise<void> {
  try {
    await fs.rm(eventIndexPath(pmRoot), { force: true });
  } catch {
    // The authoritative append already committed. A retained projection remains
    // unusable because its recorded stream byte size no longer matches authority.
  }
}

/** Persist invalidation while optionally retaining a potentially contended cache file. */
async function recordHistoryEventIndexInvalidation(
  pmRoot: string,
  retainCache: boolean,
): Promise<void> {
  const directory = historyEventIndexInvalidationDirectory(pmRoot);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(
      directory,
      `${randomUUID()}${retainCache ? ".contended" : ""}.committed`,
    ),
    "committed\n",
    { flag: "wx" },
  );
  if (!retainCache) await invalidateHistoryEventIndex(pmRoot);
}

/** Recognize retained native contention without treating settled damage as transient. */
function hasContendedHistoryEventIndexInvalidation(
  invalidations: HistoryEventIndexInvalidations,
): boolean {
  return invalidations.committed.some((name) =>
    name.endsWith(".contended.committed"),
  );
}

/** Make a zero-wait native recovery probe; ordinary snapshot reads remain read-only. */
function hasNativeHistoryEventIndexContention(
  pmRoot: string,
  Database: DatabaseSyncConstructor,
): boolean {
  let database: DatabaseSync | undefined;
  try {
    database = new Database(eventIndexPath(pmRoot));
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN EXCLUSIVE");
    return false;
  } catch (error: unknown) {
    return isHistoryIndexSqliteContention(error);
  } finally {
    database?.close();
  }
}

/** A token-owned append lease is the progress marker until its projection work completes. */
async function historyEventIndexAppendIsActive(
  pmRoot: string,
  invalidations: HistoryEventIndexInvalidations,
): Promise<boolean> {
  return (
    invalidations.pending.length > 0 ||
    (await hasUnexpiredLockOwner(
      pmRoot,
      HISTORY_EVENT_INDEX_LOCK_ID,
      HISTORY_EVENT_INDEX_APPEND_OWNER_PREFIX,
    ))
  );
}

/** Serialize projection writers without requiring readers to join their lock queue. */
async function withHistoryEventIndexLock<T>(
  pmRoot: string,
  operation: () => Promise<T>,
  waitMs = HISTORY_EVENT_INDEX_LOCK_WAIT_MS,
  purpose: "append" | "rebuild" = "rebuild",
): Promise<T> {
  const release = await acquireLock(
    pmRoot,
    HISTORY_EVENT_INDEX_LOCK_ID,
    HISTORY_EVENT_INDEX_LOCK_TTL_SECONDS,
    `history-event-index:${purpose}:${process.pid}`,
    false,
    false,
    waitMs,
    waitMs === 0 ? { maxWaitMs: 0 } : undefined,
  );
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function readAuthoritativeHistorySnapshot(
  pmRoot: string,
  requestedStreamIds?: readonly string[],
  verify = false,
): Promise<AuthoritativeHistorySnapshot> {
  const historyRoot = path.join(pmRoot, "history");
  const entries = await fs
    .readdir(historyRoot, { withFileTypes: true })
    .catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    });
  const cached = authoritativeHistoryCaches.get(pmRoot) ?? {
    streams: new Map<string, AuthoritativeHistoryStreamCache>(),
    ordered_events: [],
  };
  const streams = new Map(cached.streams);
  const presentStreams = new Set<string>();
  let changed = !authoritativeHistoryCaches.has(pmRoot);
  for (const historyFile of entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const streamId = historyFile.name.slice(0, -".jsonl".length);
    presentStreams.add(streamId);
    const historyPath = path.join(historyRoot, historyFile.name);
    if (!historyStreamIsSelected(streamId, requestedStreamIds)) continue;
    const stream = await readChangedHistoryStream(historyPath, streamId, streams.get(streamId), verify);
    if (stream === undefined) continue;
    streams.set(streamId, stream);
    changed = true;
  }
  for (const streamId of streams.keys()) {
    if (!presentStreams.has(streamId)) {
      streams.delete(streamId);
      changed = true;
    }
  }
  if (changed) {
    cached.ordered_events = [...streams.values()]
      .flatMap((stream) => stream.events)
      .sort(compareHistoryEventPosition);
  }
  cached.streams = streams;
  authoritativeHistoryCaches.delete(pmRoot);
  authoritativeHistoryCaches.set(pmRoot, cached);
  if (authoritativeHistoryCaches.size > AUTHORITATIVE_HISTORY_CACHE_LIMIT) {
    const oldestRoot = authoritativeHistoryCaches.keys().next().value as string;
    authoritativeHistoryCaches.delete(oldestRoot);
  }
  return {
    events: cached.ordered_events.filter((event) => historyStreamIsSelected(event.stream_id, requestedStreamIds)).map((event) => projectRecordedHistoryEvent(event, verify)),
    stream_receipts: new Map(
      [...cached.streams].filter(([streamId]) => historyStreamIsSelected(streamId, requestedStreamIds)).map(([streamId, stream]) => [
        streamId,
        { byte_size: stream.byte_size, content_hash: stream.signature },
      ]),
    ),
  };
}

/** Keep default full-entry timestamps independent of earlier strict reads sharing this cache. */
function projectRecordedHistoryEvent(event: IndexedHistoryEvent, verify: boolean): IndexedHistoryEvent {
  if (verify || event.recorded_entry === undefined) return event;
  return { stream_id: event.stream_id, stream_offset: event.stream_offset, entry: event.entry };
}

/** Empty or omitted selections retain the existing all-stream query semantics. */
function historyStreamIsSelected(streamId: string, requested: readonly string[] | undefined): boolean {
  return !requested?.length || requested.includes(streamId);
}

/** Reuse parsed rows only after validating every byte; strict reads always replay. */
async function readChangedHistoryStream(historyPath: string, streamId: string, previous: AuthoritativeHistoryStreamCache | undefined, verify: boolean): Promise<AuthoritativeHistoryStreamCache | undefined> {
  if (!verify) {
    const stats = await fs.stat(historyPath);
    const signature = createHash("sha256").update(await fs.readFile(historyPath)).digest("hex");
    if (previous?.byte_size === stats.size && previous.signature === signature) return undefined;
  }
  return readIndexableHistoryStream(historyPath, streamId, verify);
}

/** Capture rows and their complete byte receipt from the same authoritative read. */
async function readIndexableHistoryStream(historyPath: string, streamId: string, verify: boolean): Promise<AuthoritativeHistoryStreamCache> {
  const snapshot = await readHistorySnapshot(historyPath, streamId);
  if (verify) {
    const result = verifyHistoryChainWithVersion(snapshot.entries);
    if (!result.ok) throw new PmCliError(
      `Authoritative history integrity verification failed for ${streamId}.`,
      EXIT_CODE.GENERIC_FAILURE,
      { code: "event_history_integrity_failed", why: result.errors.join(", "),
        nextSteps: [`Run pm history ${streamId} --verify to inspect the authoritative chain before retrying.`] },
    );
  }
  const raw = snapshot.raw_bytes ?? new Uint8Array();
  return {
    signature: createHash("sha256").update(raw).digest("hex"),
    byte_size: raw.byteLength,
    events: normalizeIndexableHistoryEntries(snapshot.entries, streamId).map((entry, streamOffset) => ({ stream_id: streamId, stream_offset: streamOffset, entry,
      ...(verify ? { recorded_entry: snapshot.entries[streamOffset] } : {}),
    })),
  };
}

async function readIndexableHistoryEntries(
  historyPath: string,
  streamId: string,
): Promise<HistoryEntry[]> {
  return normalizeIndexableHistoryEntries((await readHistorySnapshot(historyPath, streamId)).entries, streamId);
}

/** Normalize timestamps only after integrity checks have seen the recorded values. */
function normalizeIndexableHistoryEntries(entries: HistoryEntry[], streamId: string): HistoryEntry[] {
  for (const [index, entry] of entries.entries()) {
    if (
      typeof entry.ts !== "string" ||
      !isMillisecondPrecisionRfc3339DateTime(entry.ts.trim())
    ) {
      throw new PmCliError(
        `History for ${streamId} contains an invalid or sub-millisecond timestamp at line ${index + 1}. Repair or restore the history stream and retry.`,
        EXIT_CODE.GENERIC_FAILURE,
        { code: "history_timestamp_invalid" },
      );
    }
  }
  return entries.map((entry) => ({
    ...entry,
    ts: new Date(entry.ts.trim()).toISOString(),
  }));
}

let RuntimeDatabaseSync: DatabaseSyncConstructor | null | undefined;

function resolveDatabaseSync(): DatabaseSyncConstructor | null {
  if (RuntimeDatabaseSync !== undefined) return RuntimeDatabaseSync;
  RuntimeDatabaseSync = loadStableDatabaseSync(
    process.versions.node,
    createRequire(import.meta.url),
  );
  return RuntimeDatabaseSync;
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE events (
      stream_id TEXT NOT NULL,
      stream_offset INTEGER NOT NULL,
      ts TEXT NOT NULL,
      author TEXT NOT NULL,
      agent_harness TEXT,
      agent_instance TEXT,
      op TEXT NOT NULL,
      event_class TEXT NOT NULL CHECK(event_class IN ('substantive', 'maintenance')),
      entry_json TEXT NOT NULL,
      PRIMARY KEY(stream_id, stream_offset)
    ) STRICT;
    CREATE TABLE streams (
      stream_id TEXT PRIMARY KEY,
      byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
      content_hash TEXT NOT NULL
    ) STRICT;
    CREATE INDEX events_order
      ON events(ts, stream_id, stream_offset);
    CREATE INDEX events_op_order
      ON events(op, ts, stream_id, stream_offset);
    CREATE INDEX events_class_stream_order
      ON events(event_class, stream_id, ts, stream_offset);
    CREATE INDEX events_author_order
      ON events(author, ts, stream_id, stream_offset);
    CREATE INDEX events_harness_order
      ON events(agent_harness, ts, stream_id, stream_offset);
    CREATE INDEX events_instance_order
      ON events(agent_instance, ts, stream_id, stream_offset);
  `);
  database
    .prepare("INSERT INTO metadata(key, value) VALUES ('version', ?)")
    .run(EVENT_INDEX_VERSION);
}

function insertEvent(database: DatabaseSync, event: IndexedHistoryEvent): void {
  const entry = {
    ...event.entry,
    ts: new Date(event.entry.ts.trim()).toISOString(),
  };
  database
    .prepare(
      `INSERT INTO events(
        stream_id, stream_offset, ts, author, agent_harness,
        agent_instance, op, event_class, entry_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.stream_id,
      event.stream_offset,
      entry.ts,
      entry.author,
      entry.agent_harness ?? null,
      entry.agent_instance ?? null,
      entry.op,
      classifyHistoryEvent(entry),
      JSON.stringify(entry),
    );
}

function parseIndexedHistoryEvent(row: {
  stream_id?: unknown;
  stream_offset?: unknown;
  entry_json?: unknown;
}): IndexedHistoryEvent | null {
  const entry = JSON.parse(String(row.entry_json)) as HistoryEntry;
  if (
    typeof entry.ts !== "string" ||
    !isMillisecondPrecisionRfc3339DateTime(entry.ts.trim())
  ) {
    return null;
  }
  return {
    stream_id: String(row.stream_id),
    stream_offset: Number(row.stream_offset),
    entry: { ...entry, ts: new Date(entry.ts.trim()).toISOString() },
  };
}

function upsertStreamContentReceipt(
  database: DatabaseSync,
  streamId: string,
  receipt: HistoryStreamContentReceipt,
): void {
  database
    .prepare(
      `INSERT INTO streams(stream_id, byte_size, content_hash) VALUES (?, ?, ?)
       ON CONFLICT(stream_id) DO UPDATE SET byte_size = excluded.byte_size, content_hash = excluded.content_hash`,
    )
    .run(streamId, receipt.byte_size, receipt.content_hash);
}

/** Rebuild the complete optional event projection from authoritative streams. */
export async function rebuildHistoryEventIndex(
  pmRoot: string,
  options: { lockWaitMs?: number } = {},
): Promise<boolean> {
  const Database = resolveDatabaseSync();
  if (!Database) return false;
  return withHistoryEventIndexLock(
    pmRoot,
    async () => {
      let invalidations: HistoryEventIndexInvalidations;
      try {
        invalidations = await withHistoryEventIndexInvalidationLock(
          pmRoot,
          () => recoverAbandonedHistoryEventIndexInvalidations(pmRoot),
          options.lockWaitMs,
        );
      } catch (error: unknown) {
        if (error instanceof PmCliError && error.code === "lock_conflict") {
          return false;
        }
        throw error;
      }
      if (invalidations.pending.length > 0) return false;
      if (
        hasContendedHistoryEventIndexInvalidation(invalidations) &&
        hasNativeHistoryEventIndexContention(pmRoot, Database)
      )
        return false;
      const targetPath = eventIndexPath(pmRoot);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
      let database: DatabaseSync | undefined;
      try {
        database = new Database(temporaryPath);
        createSchema(database);
        database.exec("BEGIN IMMEDIATE");
        const authoritative = await readAuthoritativeHistorySnapshot(pmRoot);
        await populateHistoryEventIndex(database, authoritative);
        database.exec("COMMIT");
        database.close();
        database = undefined;
        const published = await withHistoryEventIndexInvalidationLock(
          pmRoot,
          async () => {
            const current =
              await recoverAbandonedHistoryEventIndexInvalidations(pmRoot);
            if (
              current.pending.length > 0 ||
              !sameInvalidationNames(invalidations.committed, current.committed)
            ) {
              return false;
            }
            if (
              hasContendedHistoryEventIndexInvalidation(current) &&
              hasNativeHistoryEventIndexContention(pmRoot, Database)
            )
              return false;
            await fs.rm(targetPath, { force: true });
            await fs.rename(temporaryPath, targetPath);
            return true;
          },
          options.lockWaitMs,
        );
        if (published)
          await Promise.all(
            invalidations.committed.map((name) =>
              fs.rm(
                path.join(historyEventIndexInvalidationDirectory(pmRoot), name),
                { force: true },
              ),
            ),
          );
        if (!published) {
          await deferAutomaticHistoryRepair(pmRoot);
          await fs.rm(temporaryPath, { force: true });
        }
        return published;
      } catch (error: unknown) {
        await deferAutomaticHistoryRepair(pmRoot);
        database?.close();
        await fs.rm(temporaryPath, { force: true });
        throw error;
      }
    },
    options.lockWaitMs,
  );
}

/** Yield during full projection construction so optional repair cannot monopolize an SDK host. */
async function populateHistoryEventIndex(
  database: DatabaseSync,
  snapshot: AuthoritativeHistorySnapshot,
): Promise<void> {
  let inserted = 0;
  for (const event of snapshot.events) {
    insertEvent(database, event);
    if (++inserted % 500 === 0) await yieldToEventLoop();
  }
  for (const [streamId, receipt] of snapshot.stream_receipts) {
    upsertStreamContentReceipt(database, streamId, receipt);
    if (++inserted % 500 === 0) await yieldToEventLoop();
  }
}

function matchesSet(
  value: string,
  accepted: readonly string[] | undefined,
): boolean {
  return !accepted || accepted.length === 0 || accepted.includes(value);
}

function compareHistoryEventPosition(
  left: IndexedHistoryEvent,
  right: IndexedHistoryEvent,
): number {
  return (
    left.entry.ts.localeCompare(right.entry.ts) ||
    left.stream_id.localeCompare(right.stream_id) ||
    left.stream_offset - right.stream_offset
  );
}

function canonicalHistoryQueryTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : value;
}

function isInsideHistoryEventWindow(
  event: IndexedHistoryEvent,
  query: HistoryEventIndexQuery,
): boolean {
  if (
    query.after_ts !== undefined &&
    query.after_stream_id !== undefined &&
    query.after_stream_offset !== undefined
  ) {
    if (
      compareHistoryEventPosition(event, {
        stream_id: query.after_stream_id,
        stream_offset: query.after_stream_offset,
        entry: {
          ...event.entry,
          ts: canonicalHistoryQueryTimestamp(query.after_ts),
        },
      }) <= 0
    ) {
      return false;
    }
  } else if (
    query.since_ts !== undefined &&
    event.entry.ts < canonicalHistoryQueryTimestamp(query.since_ts)
  ) {
    return false;
  }
  return true;
}

function matchesHistoryEventHarness(
  event: IndexedHistoryEvent,
  query: HistoryEventIndexQuery,
): boolean {
  if (!query.harnesses || query.harnesses.length === 0) return true;
  if (query.harnesses.includes(event.entry.agent_harness ?? "")) return true;
  return (
    event.entry.agent_harness === undefined &&
    (query.harness_alias_authors ?? []).includes(event.entry.author)
  );
}

function matchesHistoryEventQuery(
  event: IndexedHistoryEvent,
  query: HistoryEventIndexQuery,
): boolean {
  if (
    !isInsideHistoryEventWindow(event, query) ||
    !matchesSet(event.entry.op, query.ops) ||
    !matchesSet(event.entry.author, query.authors) ||
    !matchesSet(event.entry.agent_instance ?? "", query.agent_instances) ||
    !matchesSet(event.stream_id, query.stream_ids) ||
    !matchesHistoryEventHarness(event, query)
  ) {
    return false;
  }
  return (query.provenance ?? []).every((predicate) => {
    const value = event.entry.agent_provenance?.[predicate.dimension]?.value;
    return value !== undefined && predicate.values.includes(value);
  });
}

/**
 * Query authoritative history streams when the optional SQLite accelerator is
 * unavailable. The result preserves the index contract at higher read cost.
 */
export async function queryHistoryEventStreams(
  pmRoot: string,
  query: HistoryEventIndexQuery,
): Promise<HistoryEventIndexQueryResult> {
  const limit = Math.max(0, Math.floor(query.limit));
  const snapshot = await readAuthoritativeHistorySnapshot(pmRoot, query.stream_ids, query.verify);
  const rows = snapshot.events
    .filter((event) => matchesHistoryEventQuery(event, query))
    .slice(0, limit + 1);
  return {
    events: rows.slice(0, query.limit),
    has_more: rows.length > query.limit,
    ...(query.verify ? { verified_streams: snapshot.stream_receipts.size } : {}),
  };
}

/** Certify the complete incremental base before a later append advances its content receipt. */
async function historyEventIndexHasAppendBase(
  database: DatabaseSync,
  historyPath: string,
): Promise<boolean> {
  const stored = database
    .prepare("SELECT byte_size, content_hash FROM streams WHERE stream_id = ?")
    .get(path.basename(historyPath, ".jsonl")) as
    | HistoryStreamContentReceipt
    | undefined;
  let actualSize = 0;
  try {
    actualSize = (await fs.stat(historyPath)).size;
  } catch (error: unknown) {
    if (!isFileMissingError(error)) throw error;
  }
  if (Number(stored?.byte_size ?? 0) !== actualSize) return false;
  const current = await readHistoryStreamContentReceipt(path.dirname(path.dirname(historyPath)), path.basename(historyPath, ".jsonl"));
  return stored === undefined ? current?.byte_size === 0 : current?.content_hash === stored.content_hash;
}

/**
 * Serialize an authoritative append with its optional SQLite projection.
 * The database write lock spans the file append and size capture, so compliant
 * cross-process writers cannot certify a newer stream size with older rows.
 */
export async function appendHistoryEntryWithEventIndex(
  historyPath: string,
  entry: HistoryEntry,
  append: () => Promise<void>,
): Promise<void> {
  const pmRoot = path.dirname(path.dirname(historyPath));
  const Database = resolveDatabaseSync();
  let authoritativeAppendCommitted = false;
  const appendAuthoritative = async () => {
    await append();
    authoritativeAppendCommitted = true;
  };
  if (!Database) {
    await appendUnindexedHistory(pmRoot, appendAuthoritative);
    return;
  }
  try {
    await withHistoryEventIndexLock(
      pmRoot,
      async () => {
        const targetPath = eventIndexPath(pmRoot);
        try {
          await fs.access(targetPath);
        } catch {
          await appendAuthoritative();
          return;
        }
        let database: DatabaseSync | undefined;
        try {
          database = new Database(targetPath);
          const version = database
            .prepare("SELECT value FROM metadata WHERE key = 'version'")
            .get() as { value?: unknown } | undefined;
          if (version?.value !== EVENT_INDEX_VERSION) {
            throw new TypeError("Unsupported history event index version");
          }
          if (!(await historyEventIndexHasAppendBase(database, historyPath))) {
            throw new TypeError("Stale history event index append base");
          }
        } catch (error: unknown) {
          database?.close();
          if (isHistoryIndexSqliteContention(error)) throw error;
          await recordHistoryEventIndexInvalidation(pmRoot, true);
          await appendAuthoritative();
          return;
        }
        try {
          // The projection is optional: native readers must not delay authority
          // at BEGIN or COMMIT after the filesystem writer lock was acquired.
          database.exec("PRAGMA busy_timeout = 0");
          database.exec("BEGIN IMMEDIATE");
        } catch (error: unknown) {
          database.close();
          if (
            isHistoryIndexSqliteContention(error) ||
            !(error instanceof Error) ||
            (error as NodeJS.ErrnoException).code !== "ERR_SQLITE_ERROR"
          )
            throw error;
          // Native storage damage in this optional projection must not abort
          // the authoritative append. Publish invalidation before proceeding.
          await recordHistoryEventIndexInvalidation(pmRoot, false);
          await appendAuthoritative();
          return;
        }
        let appended = false;
        try {
          await appendAuthoritative();
          appended = true;
          const streamId = path.basename(historyPath, ".jsonl");
          const offset = database
            .prepare(
              "SELECT COALESCE(MAX(stream_offset), -1) + 1 AS value FROM events WHERE stream_id = ?",
            )
            .get(streamId) as { value: number };
          insertEvent(database, {
            stream_id: streamId,
            stream_offset: Number(offset.value),
            entry,
          });
          upsertStreamContentReceipt(
            database,
            streamId,
            (await readHistoryStreamContentReceipt(pmRoot, streamId))!,
          );
          database.exec("COMMIT");
          database.close();
        } catch (error: unknown) {
          database?.close();
          if (!appended) throw error;
          await recordHistoryEventIndexInvalidation(
            pmRoot,
            isHistoryIndexSqliteContention(error),
          );
        }
      },
      0,
      "append",
    );
  } catch (error: unknown) {
    if (authoritativeAppendCommitted) {
      await invalidateHistoryEventIndex(pmRoot);
      return;
    }
    if (!isHistoryIndexWriteContention(error)) {
      throw error;
    }
    await appendUnindexedHistory(
      pmRoot,
      appendAuthoritative,
      isHistoryIndexSqliteContention(error),
    );
  }
}

/** Publish every non-indexed producer, including SQLite-less runtimes, through one invalidation protocol. */
async function appendUnindexedHistory(
  pmRoot: string,
  append: () => Promise<void>,
  nativeContention = false,
): Promise<void> {
  let authoritativeAppendCommitted = false;
  let pendingMarkerPath: string | undefined;
  try {
    await withHistoryEventIndexInvalidationLock(pmRoot, async () => {
      const contended =
        nativeContention ||
        hasContendedHistoryEventIndexInvalidation(
          await listHistoryEventIndexInvalidations(pmRoot),
        );
      const marker = await beginHistoryEventIndexInvalidation(pmRoot);
      pendingMarkerPath = marker.pendingPath;
      try {
        await append();
        authoritativeAppendCommitted = true;
      } catch (appendError: unknown) {
        await fs.rm(marker.pendingPath, { force: true });
        throw appendError;
      }
      await fs.rename(
        marker.pendingPath,
        contended
          ? marker.committedPath.replace(
              /\.committed$/u,
              ".contended.committed",
            )
          : marker.committedPath,
      );
      if (!contended) await invalidateHistoryEventIndex(pmRoot);
    });
  } catch (fallbackError: unknown) {
    if (authoritativeAppendCommitted) {
      await invalidateHistoryEventIndex(pmRoot);
      try {
        await fs.rm(pendingMarkerPath as string, { force: true });
      } catch {
        // The authoritative append is durable; marker cleanup is best effort.
      }
      return;
    }
    throw fallbackError;
  }
}

/** Invalidate the optional event projection after a non-append rewrite. */
export async function removeHistoryEventIndexForHistoryPath(
  historyPath: string,
): Promise<void> {
  await fs.rm(eventIndexPath(path.dirname(path.dirname(historyPath))), {
    force: true,
  });
}

function appendSetPredicate(
  clauses: string[],
  parameters: SQLInputValue[],
  column: string,
  values: readonly string[] | undefined,
): void {
  if (!values || values.length === 0) return;
  clauses.push(`${column} IN (${values.map(() => "?").join(", ")})`);
  parameters.push(...values);
}

function appendHarnessPredicate(
  clauses: string[],
  parameters: SQLInputValue[],
  harnesses: readonly string[] | undefined,
  aliasAuthors: readonly string[] | undefined,
): void {
  if (!harnesses || harnesses.length === 0) return;
  const harnessPlaceholders = harnesses.map(() => "?").join(", ");
  const aliases = aliasAuthors ?? [];
  if (aliases.length > 0) {
    clauses.push(
      `(agent_harness IN (${harnessPlaceholders}) OR (agent_harness IS NULL AND author IN (${aliases.map(() => "?").join(", ")})))`,
    );
    parameters.push(...harnesses, ...aliases);
    return;
  }
  clauses.push(`agent_harness IN (${harnessPlaceholders})`);
  parameters.push(...harnesses);
}

/** Read rows and size receipts synchronously in one SQLite transaction, then close
 * before any asynchronous filesystem validation. Readers never acquire either
 * writer lock. Any concurrent projection change or invalidation refuses the
 * snapshot so callers can use authoritative history instead of waiting.
 */
async function readHistoryEventIndexSnapshot<T>(
  pmRoot: string,
  Database: DatabaseSyncConstructor,
  requestedStreamIds: readonly string[] | undefined,
  read: (database: DatabaseSync) => T | null,
): Promise<T | null | typeof HISTORY_INDEX_CHANGED> {
  let database: DatabaseSync | undefined;
  try {
    const invalidations = await listHistoryEventIndexInvalidations(pmRoot);
    if (await historyEventIndexAppendIsActive(pmRoot, invalidations))
      return HISTORY_INDEX_CHANGED;
    const before = await historyEventIndexSignature(pmRoot);
    if (invalidations.committed.length > 0) {
      return hasContendedHistoryEventIndexInvalidation(invalidations) &&
        hasNativeHistoryEventIndexContention(pmRoot, Database)
        ? HISTORY_INDEX_CHANGED
        : null;
    }
    database = new Database(eventIndexPath(pmRoot), { readOnly: true });
    database.exec("BEGIN");
    const version = database
      .prepare("SELECT value FROM metadata WHERE key = 'version'")
      .get() as { value?: unknown } | undefined;
    if (version?.value !== EVENT_INDEX_VERSION) return null;
    const result = read(database);
    if (result === null) return null;
    const storedSizes = readHistoryEventIndexStreamReceipts(
      database,
      requestedStreamIds,
    );
    const completed = database;
    database = undefined;
    completed.close();
    const streamIds = await historyIndexValidationStreamIds(
      [...storedSizes.keys()],
      pmRoot,
      requestedStreamIds,
    );
    const sizesMatch = await historyIndexMatchesStreamContents(
      storedSizes,
      pmRoot,
      streamIds,
    );
    const current = await listHistoryEventIndexInvalidations(pmRoot);
    if (
      current.committed.length > 0 ||
      (await historyEventIndexAppendIsActive(pmRoot, current))
    )
      return HISTORY_INDEX_CHANGED;
    if (before !== (await historyEventIndexSignature(pmRoot)))
      return HISTORY_INDEX_CHANGED;
    return sizesMatch ? result : null;
  } catch (error: unknown) {
    return isHistoryIndexSqliteContention(error) ? HISTORY_INDEX_CHANGED : null;
  } finally {
    database?.close();
  }
}

/** SQLite busy/locked reads are transient writer activity, not cache damage. */
function isHistoryIndexSqliteContention(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    [5, 6].includes(error.errcode as number)
  );
}

/** Either native or file-lock contention permits the authoritative append fallback. */
function isHistoryIndexWriteContention(error: unknown): boolean {
  return (
    isHistoryIndexSqliteContention(error) ||
    (error instanceof PmCliError && error.code === "lock_conflict")
  );
}

/** Capture content receipts in the same synchronous transaction as the requested rows. */
function readHistoryEventIndexStreamReceipts(
  database: DatabaseSync,
  requestedStreamIds: readonly string[] | undefined,
): Map<string, HistoryStreamContentReceipt> {
  const storedSizes = new Map<string, HistoryStreamContentReceipt>();
  const ids =
    requestedStreamIds && requestedStreamIds.length > 0
      ? [...new Set(requestedStreamIds)]
      : undefined;
  if (ids === undefined) {
    for (const row of database
      .prepare("SELECT stream_id, byte_size, content_hash FROM streams")
      .all()) {
      storedSizes.set(String(row.stream_id), { byte_size: Number(row.byte_size), content_hash: String(row.content_hash) });
    }
  } else {
    for (let start = 0; start < ids.length; start += 500) {
      const chunk = ids.slice(start, start + 500);
      for (const row of database
        .prepare(
          `SELECT stream_id, byte_size, content_hash FROM streams WHERE stream_id IN (${chunk.map(() => "?").join(", ")})`,
        )
        .all(...chunk)) {
        storedSizes.set(String(row.stream_id), { byte_size: Number(row.byte_size), content_hash: String(row.content_hash) });
      }
    }
  }
  return storedSizes;
}

/** Bind optimistic validation to the same physical projection and write generation. */
async function historyEventIndexSignature(pmRoot: string): Promise<string> {
  const stats = await fs.stat(eventIndexPath(pmRoot), { bigint: true });
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(
    ":",
  );
}

/** Distinguish repairable cache absence/damage from transient concurrent writes. */
export async function readHistoryEventIndexPage(
  pmRoot: string,
  query: HistoryEventIndexQuery,
): Promise<{
  result: HistoryEventIndexQueryResult | null;
  repair_needed: boolean;
}> {
  if (query.verify) return { result: await queryHistoryEventStreams(pmRoot, query), repair_needed: false };
  const Database = resolveDatabaseSync();
  if (!Database) return { result: null, repair_needed: false };
  const clauses: string[] = [];
  const parameters: SQLInputValue[] = [];
  if (
    query.after_ts !== undefined &&
    query.after_stream_id !== undefined &&
    query.after_stream_offset !== undefined
  ) {
    clauses.push(
      "(ts > ? OR (ts = ? AND stream_id > ?) OR (ts = ? AND stream_id = ? AND stream_offset > ?))",
    );
    const afterTimestamp = canonicalHistoryQueryTimestamp(query.after_ts);
    parameters.push(
      afterTimestamp,
      afterTimestamp,
      query.after_stream_id,
      afterTimestamp,
      query.after_stream_id,
      query.after_stream_offset,
    );
  } else if (query.since_ts !== undefined) {
    clauses.push("ts >= ?");
    parameters.push(canonicalHistoryQueryTimestamp(query.since_ts));
  }
  appendSetPredicate(clauses, parameters, "op", query.ops);
  appendSetPredicate(clauses, parameters, "author", query.authors);
  appendHarnessPredicate(
    clauses,
    parameters,
    query.harnesses,
    query.harness_alias_authors,
  );
  appendSetPredicate(
    clauses,
    parameters,
    "agent_instance",
    query.agent_instances,
  );
  for (const predicate of query.provenance ?? []) {
    clauses.push(
      `json_extract(entry_json, '$.agent_provenance.${predicate.dimension}.value') IN (${predicate.values.map(() => "?").join(", ")})`,
    );
    parameters.push(...predicate.values);
  }
  appendSetPredicate(clauses, parameters, "stream_id", query.stream_ids);
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const attempt = await readHistoryEventIndexSnapshot(
    pmRoot,
    Database,
    query.stream_ids,
    (database) => {
      const rows = database
        .prepare(
          `SELECT stream_id, stream_offset, entry_json
         FROM events${where}
         ORDER BY ts, stream_id, stream_offset
         LIMIT ?`,
        )
        .all(...parameters, Math.max(0, Math.floor(query.limit)) + 1);
      const events = rows.slice(0, query.limit).map(parseIndexedHistoryEvent);
      return events.includes(null)
        ? null
        : {
            events: events as IndexedHistoryEvent[],
            has_more: rows.length > query.limit,
          };
    },
  );
  return {
    result: attempt === HISTORY_INDEX_CHANGED ? null : attempt,
    repair_needed:
      attempt === null && !(await hasRecentRefusedHistoryRepair(pmRoot)),
  };
}

/** Query the optional event projection without scanning history streams. */
export async function queryHistoryEventIndex(
  pmRoot: string,
  query: HistoryEventIndexQuery,
): Promise<HistoryEventIndexQueryResult | null> {
  return (await readHistoryEventIndexPage(pmRoot, query)).result;
}

function collectLatestSubstantiveEvents(
  events: readonly IndexedHistoryEvent[],
  requested: ReadonlySet<string>,
): Record<string, IndexedHistoryEvent> {
  const latest: Record<string, IndexedHistoryEvent> = Object.create(
    null,
  ) as Record<string, IndexedHistoryEvent>;
  for (const event of events) {
    if (
      !requested.has(event.stream_id) ||
      classifyHistoryEvent(event.entry) !== "substantive"
    ) {
      continue;
    }
    const current = latest[event.stream_id];
    if (
      current === undefined ||
      compareHistoryEventPosition(current, event) < 0
    ) {
      latest[event.stream_id] = event;
    }
  }
  return latest;
}

/** Treat absent streams as empty while preserving unsafe paths and storage errors. */
async function readHistoryStreamContentReceipt(
  pmRoot: string,
  streamId: string,
): Promise<HistoryStreamContentReceipt | null> {
  if (path.basename(streamId) !== streamId) return null;
  try {
    const historyPath = path.join(pmRoot, "history", `${streamId}.jsonl`);
    const stats = await fs.stat(historyPath);
    const raw = await fs.readFile(historyPath);
    if (stats.size !== raw.length) return null;
    return { byte_size: raw.length, content_hash: createHash("sha256").update(raw).digest("hex") };
  } catch (error: unknown) {
    if (isFileMissingError(error)) return { byte_size: 0, content_hash: createHash("sha256").digest("hex") };
    throw error;
  }
}

/** Compare captured projection receipts with complete authoritative content outside SQLite. */
async function historyIndexMatchesStreamContents(
  storedSizes: ReadonlyMap<string, HistoryStreamContentReceipt>,
  pmRoot: string,
  streamIds: readonly string[],
): Promise<boolean> {
  for (let start = 0; start < streamIds.length; start += HISTORY_STREAM_CONTENT_READ_CONCURRENCY) {
    const chunk = streamIds.slice(start, start + HISTORY_STREAM_CONTENT_READ_CONCURRENCY);
    const currentSizes = await Promise.all(
      chunk.map((streamId) => readHistoryStreamContentReceipt(pmRoot, streamId)),
    );
    for (const [index, currentSize] of currentSizes.entries()) {
      if (currentSize === null) return false;
      const streamId = chunk[index] as string;
      const storedSize = storedSizes.get(streamId);
      if (currentSize.byte_size === 0 && storedSize === undefined) continue;
      if (currentSize.byte_size !== storedSize?.byte_size || currentSize.content_hash !== storedSize.content_hash) return false;
    }
  }
  return true;
}

/** Include newly created authoritative streams when validating a global snapshot. */
async function historyIndexValidationStreamIds(
  indexed: readonly string[],
  pmRoot: string,
  requestedStreamIds: readonly string[] | undefined,
): Promise<string[]> {
  if (requestedStreamIds && requestedStreamIds.length > 0) {
    return [
      ...new Set(
        requestedStreamIds.filter((streamId) => streamId.trim().length > 0),
      ),
    ];
  }
  const authoritative = await fs
    .readdir(path.join(pmRoot, "history"), { withFileTypes: true })
    .then((entries) =>
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name.slice(0, -".jsonl".length)),
    )
    .catch((error: unknown) => {
      if (isFileMissingError(error)) return [];
      throw error;
    });
  return [...new Set([...indexed, ...authoritative])];
}

/** Select recency rows from the same nonblocking snapshot used by event pages. */
async function readIndexedLatestSubstantiveEvents(
  Database: DatabaseSyncConstructor | null,
  pmRoot: string,
  streamIds: readonly string[],
  requested: ReadonlySet<string>,
): Promise<
  Record<string, IndexedHistoryEvent> | null | typeof HISTORY_INDEX_CHANGED
> {
  if (!Database) return null;
  return readHistoryEventIndexSnapshot(
    pmRoot,
    Database,
    streamIds,
    (database) => {
      const indexed: IndexedHistoryEvent[] = [];
      for (let start = 0; start < streamIds.length; start += 500) {
        const chunk = streamIds.slice(start, start + 500);
        const rows = database
          .prepare(
            `SELECT stream_id, stream_offset, entry_json
           FROM (
             SELECT stream_id, stream_offset, entry_json,
                    ROW_NUMBER() OVER (
                      PARTITION BY stream_id
                      ORDER BY ts DESC, stream_offset DESC
                    ) AS recency_rank
             FROM events
             WHERE event_class = 'substantive'
               AND stream_id IN (${chunk.map(() => "?").join(", ")})
           )
           WHERE recency_rank = 1`,
          )
          .all(...chunk);
        const parsed = rows.map(parseIndexedHistoryEvent);
        if (parsed.includes(null)) return null;
        indexed.push(...(parsed as IndexedHistoryEvent[]));
      }
      return collectLatestSubstantiveEvents(indexed, requested);
    },
  );
}

/**
 * Read one latest substantive coordinate per requested stream. The optional
 * SQLite projection is preferred; individual authoritative streams are the
 * fail-closed fallback and remain the source of truth.
 */
export async function readLatestSubstantiveHistoryEvents(
  pmRoot: string,
  streamIds: readonly string[],
): Promise<LatestSubstantiveHistoryEvents> {
  const uniqueIds = [
    ...new Set(
      streamIds.filter(
        (id) => id.trim().length > 0 && path.basename(id) === id,
      ),
    ),
  ];
  if (uniqueIds.length === 0) return {};
  const requested = new Set(uniqueIds);
  const Database = resolveDatabaseSync();
  const indexed = await readIndexedLatestSubstantiveEvents(
    Database,
    pmRoot,
    uniqueIds,
    requested,
  );
  if (indexed !== null && indexed !== HISTORY_INDEX_CHANGED) {
    return indexed;
  }
  if (
    Database &&
    indexed !== HISTORY_INDEX_CHANGED &&
    !(await hasRecentRefusedHistoryRepair(pmRoot))
  ) {
    try {
      if (await rebuildHistoryEventIndex(pmRoot, { lockWaitMs: 0 })) {
        const rebuilt = await readIndexedLatestSubstantiveEvents(
          Database,
          pmRoot,
          uniqueIds,
          requested,
        );
        if (rebuilt !== null && rebuilt !== HISTORY_INDEX_CHANGED) {
          return rebuilt;
        }
      }
    } catch {
      // A corrupt unrelated stream must not prevent requested authoritative reads.
    }
  }
  const authoritative: IndexedHistoryEvent[] = [];
  await Promise.all(
    uniqueIds.map(async (streamId) => {
      const historyPath = path.join(pmRoot, "history", `${streamId}.jsonl`);
      const entries = await readIndexableHistoryEntries(
        historyPath,
        streamId,
      ).catch((error: unknown) => {
        if (
          error instanceof PmCliError &&
          error.code === "history_timestamp_invalid"
        ) {
          return [];
        }
        throw error;
      });
      entries.forEach((entry, streamOffset) => {
        authoritative.push({
          stream_id: streamId,
          stream_offset: streamOffset,
          entry,
        });
      });
    }),
  );
  return collectLatestSubstantiveEvents(authoritative, requested);
}

/** Test-only dependency seam for runtimes without `node:sqlite`. */
export const _testOnly = {
  collectLatestSubstantiveEvents,
  loadDatabaseSync,
  loadStableDatabaseSync,
  setDatabaseSync(databaseSync: DatabaseSyncConstructor | null): () => void {
    const previous = RuntimeDatabaseSync;
    RuntimeDatabaseSync = databaseSync;
    return () => {
      RuntimeDatabaseSync = previous;
    };
  },
};
