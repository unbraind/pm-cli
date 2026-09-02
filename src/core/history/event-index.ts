/**
 * @module core/history/event-index
 *
 * Maintains a rebuildable SQLite projection over append-only history streams
 * for cursor-resumable cross-item mutation event reads.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { HistoryEntry } from "../../types/index.js";
import { isFileMissingError } from "../fs/fs-utils.js";
import {
  acquireLock,
  captureProcessIdentity,
  isProcessIdentityAlive,
} from "../lock/lock.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { isMillisecondPrecisionRfc3339DateTime } from "../shared/time.js";
import { readHistoryEntries } from "./read.js";
import { classifyHistoryEvent } from "./event-classification.js";

const EVENT_INDEX_FILENAME = "history-event-index.sqlite";
const EVENT_INDEX_VERSION = "5";
const AUTHORITATIVE_HISTORY_CACHE_LIMIT = 8;
const HISTORY_EVENT_INDEX_LOCK_ID = "history-event-index";
const HISTORY_EVENT_INDEX_LOCK_TTL_SECONDS = 300;
const HISTORY_EVENT_INDEX_LOCK_WAIT_MS = 30_000;
const HISTORY_EVENT_INDEX_INVALIDATION_LOCK_ID =
  "history-event-index-invalidation";
const HISTORY_EVENT_INDEX_INVALIDATION_DIRECTORY =
  "history-event-index-invalidations";
const HISTORY_EVENT_INDEX_INVALIDATION_MAX_UNVERIFIED_AGE_MS =
  HISTORY_EVENT_INDEX_LOCK_TTL_SECONDS * 2 * 1_000;
const HISTORY_INDEX_LOCK_CONTENDED = Symbol("history-index-lock-contended");
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
  stream_byte_sizes: ReadonlyMap<string, number>;
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
}

/** Index-native filters and continuation bounds for mutation events. */
export interface HistoryEventIndexQuery {
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
}

/** Latest substantive immutable event for each requested history stream. */
export type LatestSubstantiveHistoryEvents = Readonly<
  Record<string, IndexedHistoryEvent>
>;

function eventIndexPath(pmRoot: string): string {
  return path.join(pmRoot, "runtime", EVENT_INDEX_FILENAME);
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

async function withHistoryEventIndexInvalidationLock<T>(
  pmRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireLock(
    pmRoot,
    HISTORY_EVENT_INDEX_INVALIDATION_LOCK_ID,
    HISTORY_EVENT_INDEX_LOCK_TTL_SECONDS,
    `history-event-index-invalidation:${process.pid}`,
    false,
    false,
    HISTORY_EVENT_INDEX_LOCK_WAIT_MS,
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

async function withHistoryEventIndexLock<T>(
  pmRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireLock(
    pmRoot,
    HISTORY_EVENT_INDEX_LOCK_ID,
    HISTORY_EVENT_INDEX_LOCK_TTL_SECONDS,
    `history-event-index:${process.pid}`,
    false,
    false,
    HISTORY_EVENT_INDEX_LOCK_WAIT_MS,
  );
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function readAuthoritativeHistorySnapshot(
  pmRoot: string,
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
  const presentStreams = new Set<string>();
  let changed = !authoritativeHistoryCaches.has(pmRoot);
  for (const historyFile of entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const streamId = historyFile.name.slice(0, -".jsonl".length);
    presentStreams.add(streamId);
    const historyPath = path.join(historyRoot, historyFile.name);
    const stats = await fs.stat(historyPath, { bigint: true });
    const signature = [
      stats.dev,
      stats.ino,
      stats.size,
      stats.mtimeNs,
      stats.ctimeNs,
    ].join(":");
    if (cached.streams.get(streamId)?.signature === signature) continue;
    const history = await readIndexableHistoryEntries(historyPath, streamId);
    cached.streams.set(streamId, {
      signature,
      byte_size: Number(stats.size),
      events: history.map((entry, streamOffset) => ({
        stream_id: streamId,
        stream_offset: streamOffset,
        entry,
      })),
    });
    changed = true;
  }
  for (const streamId of cached.streams.keys()) {
    if (!presentStreams.has(streamId)) {
      cached.streams.delete(streamId);
      changed = true;
    }
  }
  if (changed) {
    cached.ordered_events = [...cached.streams.values()]
      .flatMap((stream) => stream.events)
      .sort(compareHistoryEventPosition);
  }
  authoritativeHistoryCaches.delete(pmRoot);
  authoritativeHistoryCaches.set(pmRoot, cached);
  if (authoritativeHistoryCaches.size > AUTHORITATIVE_HISTORY_CACHE_LIMIT) {
    const oldestRoot = authoritativeHistoryCaches.keys().next().value as string;
    authoritativeHistoryCaches.delete(oldestRoot);
  }
  return {
    events: cached.ordered_events,
    stream_byte_sizes: new Map(
      [...cached.streams].map(([streamId, stream]) => [
        streamId,
        stream.byte_size,
      ]),
    ),
  };
}

async function readIndexableHistoryEntries(
  historyPath: string,
  streamId: string,
): Promise<HistoryEntry[]> {
  const entries = await readHistoryEntries(historyPath, streamId);
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

async function readAuthoritativeHistoryEvents(
  pmRoot: string,
): Promise<IndexedHistoryEvent[]> {
  return (await readAuthoritativeHistorySnapshot(pmRoot)).events;
}

function loadDatabaseSync(
  loadModule: (specifier: string) => unknown,
): DatabaseSyncConstructor | null {
  try {
    const loaded = loadModule(["node", "sqlite"].join(":")) as {
      DatabaseSync?: DatabaseSyncConstructor;
    };
    return loaded.DatabaseSync ?? null;
  } catch {
    return null;
  }
}

function loadStableDatabaseSync(
  nodeVersion: string,
  loadModule: (specifier: string) => unknown,
): DatabaseSyncConstructor | null {
  const nodeMajor = Number.parseInt(nodeVersion, 10);
  return Number.isFinite(nodeMajor) && nodeMajor >= 22
    ? loadDatabaseSync(loadModule)
    : null;
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
      byte_size INTEGER NOT NULL CHECK(byte_size >= 0)
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

function upsertStreamByteSize(
  database: DatabaseSync,
  streamId: string,
  byteSize: number,
): void {
  database
    .prepare(
      `INSERT INTO streams(stream_id, byte_size) VALUES (?, ?)
       ON CONFLICT(stream_id) DO UPDATE SET byte_size = excluded.byte_size`,
    )
    .run(streamId, byteSize);
}

/** Rebuild the complete optional event projection from authoritative streams. */
export async function rebuildHistoryEventIndex(
  pmRoot: string,
): Promise<boolean> {
  const Database = resolveDatabaseSync();
  if (!Database) return false;
  return withHistoryEventIndexLock(pmRoot, async () => {
    let invalidations: HistoryEventIndexInvalidations;
    try {
      invalidations = await withHistoryEventIndexInvalidationLock(pmRoot, () =>
        recoverAbandonedHistoryEventIndexInvalidations(pmRoot),
      );
    } catch (error: unknown) {
      if (error instanceof PmCliError && error.code === "lock_conflict") {
        return false;
      }
      throw error;
    }
    if (invalidations.pending.length > 0) return false;
    const targetPath = eventIndexPath(pmRoot);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    let database: DatabaseSync | undefined;
    try {
      database = new Database(temporaryPath);
      createSchema(database);
      database.exec("BEGIN IMMEDIATE");
      const authoritative = await readAuthoritativeHistorySnapshot(pmRoot);
      for (const event of authoritative.events) {
        insertEvent(database, event);
      }
      for (const [streamId, byteSize] of authoritative.stream_byte_sizes) {
        upsertStreamByteSize(database, streamId, byteSize);
      }
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
          await fs.rm(targetPath, { force: true });
          await fs.rename(temporaryPath, targetPath);
          await Promise.all(
            invalidations.committed.map((name) =>
              fs.rm(
                path.join(historyEventIndexInvalidationDirectory(pmRoot), name),
                { force: true },
              ),
            ),
          );
          return true;
        },
      );
      if (!published) await fs.rm(temporaryPath, { force: true });
      return published;
    } catch (error: unknown) {
      database?.close();
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
  });
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
  const rows = (await readAuthoritativeHistoryEvents(pmRoot))
    .filter((event) => matchesHistoryEventQuery(event, query))
    .slice(0, limit + 1);
  return {
    events: rows.slice(0, query.limit),
    has_more: rows.length > query.limit,
  };
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
  if (!Database) {
    await append();
    return;
  }
  let authoritativeAppendCommitted = false;
  try {
    await withHistoryEventIndexLock(pmRoot, async () => {
      const targetPath = eventIndexPath(pmRoot);
      try {
        await fs.access(targetPath);
      } catch {
        await append();
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
      } catch {
        database?.close();
        await fs.rm(targetPath, { force: true });
        await append();
        return;
      }
      try {
        database.exec("PRAGMA busy_timeout = 5000");
        database.exec("BEGIN IMMEDIATE");
      } catch (error: unknown) {
        database.close();
        throw error;
      }
      let appended = false;
      try {
        await append();
        appended = true;
        authoritativeAppendCommitted = true;
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
        upsertStreamByteSize(
          database,
          streamId,
          (await fs.stat(historyPath)).size,
        );
        database.exec("COMMIT");
        database.close();
      } catch (error: unknown) {
        database?.close();
        if (!appended) throw error;
        await invalidateHistoryEventIndex(pmRoot);
      }
    });
  } catch (error: unknown) {
    if (authoritativeAppendCommitted) {
      await invalidateHistoryEventIndex(pmRoot);
      return;
    }
    if (!(error instanceof PmCliError) || error.code !== "lock_conflict") {
      throw error;
    }
    let pendingMarkerPath: string | undefined;
    try {
      await withHistoryEventIndexInvalidationLock(pmRoot, async () => {
        const marker = await beginHistoryEventIndexInvalidation(pmRoot);
        pendingMarkerPath = marker.pendingPath;
        try {
          await append();
          authoritativeAppendCommitted = true;
        } catch (appendError: unknown) {
          await fs.rm(marker.pendingPath, { force: true });
          throw appendError;
        }
        await fs.rename(marker.pendingPath, marker.committedPath);
        await invalidateHistoryEventIndex(pmRoot);
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

/** Query the optional event projection without scanning history streams. */
export async function queryHistoryEventIndex(
  pmRoot: string,
  query: HistoryEventIndexQuery,
): Promise<HistoryEventIndexQueryResult | null> {
  const Database = resolveDatabaseSync();
  if (!Database) return null;
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
  let database: DatabaseSync | undefined;
  try {
    return await withHistoryEventIndexLock(pmRoot, async () => {
      return withHistoryEventIndexInvalidationLock(pmRoot, async () => {
        const invalidations =
          await recoverAbandonedHistoryEventIndexInvalidations(pmRoot);
        if (
          invalidations.pending.length > 0 ||
          invalidations.committed.length > 0
        ) {
          return null;
        }
        database = new Database(eventIndexPath(pmRoot), { readOnly: true });
        const version = database
          .prepare("SELECT value FROM metadata WHERE key = 'version'")
          .get() as { value?: unknown } | undefined;
        const validationStreamIds = await historyIndexValidationStreamIds(
          database,
          pmRoot,
          query.stream_ids,
        );
        if (
          version?.value !== EVENT_INDEX_VERSION ||
          !(await historyIndexMatchesStreamSizes(
            database,
            pmRoot,
            validationStreamIds,
          ))
        ) {
          database.close();
          database = undefined;
          return null;
        }
        const rows = database
          .prepare(
            `SELECT stream_id, stream_offset, entry_json
             FROM events${where}
             ORDER BY ts, stream_id, stream_offset
             LIMIT ?`,
          )
          .all(...parameters, Math.max(0, Math.floor(query.limit)) + 1);
        const events = rows.slice(0, query.limit).map(parseIndexedHistoryEvent);
        database.close();
        database = undefined;
        return events.includes(null)
          ? null
          : {
              events: events as IndexedHistoryEvent[],
              has_more: rows.length > query.limit,
            };
      });
    });
  } catch {
    database?.close();
    return null;
  }
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

async function readHistoryStreamByteSize(
  pmRoot: string,
  streamId: string,
): Promise<number | null> {
  if (path.basename(streamId) !== streamId) return null;
  try {
    return (await fs.stat(path.join(pmRoot, "history", `${streamId}.jsonl`)))
      .size;
  } catch (error: unknown) {
    if (isFileMissingError(error)) return 0;
    throw error;
  }
}

async function historyIndexMatchesStreamSizes(
  database: DatabaseSync,
  pmRoot: string,
  streamIds: readonly string[],
): Promise<boolean> {
  for (let start = 0; start < streamIds.length; start += 500) {
    const chunk = streamIds.slice(start, start + 500);
    const storedSizes = new Map(
      database
        .prepare(
          `SELECT stream_id, byte_size FROM streams
           WHERE stream_id IN (${chunk.map(() => "?").join(", ")})`,
        )
        .all(...chunk)
        .map((row) => [String(row.stream_id), Number(row.byte_size)]),
    );
    const currentSizes = await Promise.all(
      chunk.map((streamId) => readHistoryStreamByteSize(pmRoot, streamId)),
    );
    for (const [index, currentSize] of currentSizes.entries()) {
      if (currentSize === null) return false;
      const streamId = chunk[index] as string;
      const storedSize = storedSizes.get(streamId);
      if (currentSize === 0 && storedSize === undefined) continue;
      if (currentSize !== storedSize) return false;
    }
  }
  return true;
}

async function historyIndexValidationStreamIds(
  database: DatabaseSync,
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
  const indexed = database
    .prepare("SELECT stream_id FROM streams")
    .all()
    .map((row) => String(row.stream_id));
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

async function readIndexedLatestSubstantiveEvents(
  Database: DatabaseSyncConstructor | null,
  pmRoot: string,
  streamIds: readonly string[],
  requested: ReadonlySet<string>,
): Promise<
  | Record<string, IndexedHistoryEvent>
  | typeof HISTORY_INDEX_LOCK_CONTENDED
  | null
> {
  if (!Database) return null;
  let database: DatabaseSync | undefined;
  try {
    return await withHistoryEventIndexLock(pmRoot, async () => {
      return withHistoryEventIndexInvalidationLock(pmRoot, async () => {
        const invalidations =
          await recoverAbandonedHistoryEventIndexInvalidations(pmRoot);
        if (
          invalidations.pending.length > 0 ||
          invalidations.committed.length > 0
        ) {
          return null;
        }
        database = new Database(eventIndexPath(pmRoot), { readOnly: true });
        const version = database
          .prepare("SELECT value FROM metadata WHERE key = 'version'")
          .get() as { value?: unknown } | undefined;
        if (
          version?.value !== EVENT_INDEX_VERSION ||
          !(await historyIndexMatchesStreamSizes(database, pmRoot, streamIds))
        ) {
          database.close();
          database = undefined;
          return null;
        }
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
          if (parsed.includes(null)) {
            database.close();
            database = undefined;
            return null;
          }
          indexed.push(...(parsed as IndexedHistoryEvent[]));
        }
        database.close();
        database = undefined;
        return collectLatestSubstantiveEvents(indexed, requested);
      });
    });
  } catch (error) {
    database?.close();
    if (error instanceof PmCliError && error.code === "lock_conflict") {
      return HISTORY_INDEX_LOCK_CONTENDED;
    }
    return null;
  }
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
  if (indexed !== null && indexed !== HISTORY_INDEX_LOCK_CONTENDED) {
    return indexed;
  }
  if (Database && indexed !== HISTORY_INDEX_LOCK_CONTENDED) {
    try {
      if (await rebuildHistoryEventIndex(pmRoot)) {
        const rebuilt = await readIndexedLatestSubstantiveEvents(
          Database,
          pmRoot,
          uniqueIds,
          requested,
        );
        if (rebuilt !== null && rebuilt !== HISTORY_INDEX_LOCK_CONTENDED) {
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
