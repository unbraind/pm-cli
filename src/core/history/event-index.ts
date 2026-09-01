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
import { readHistoryEntries } from "./read.js";
import { classifyHistoryEvent } from "./event-classification.js";

const EVENT_INDEX_FILENAME = "history-event-index.sqlite";
const EVENT_INDEX_VERSION = "4";
const AUTHORITATIVE_HISTORY_CACHE_LIMIT = 8;
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
    const history = await readHistoryEntries(historyPath, streamId);
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
      event.entry.ts,
      event.entry.author,
      event.entry.agent_harness ?? null,
      event.entry.agent_instance ?? null,
      event.entry.op,
      classifyHistoryEvent(event.entry),
      JSON.stringify(event.entry),
    );
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
    await fs.rm(targetPath, { force: true });
    await fs.rename(temporaryPath, targetPath);
    return true;
  } catch (error: unknown) {
    database?.close();
    await fs.rm(temporaryPath, { force: true });
    throw error;
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
        entry: { ...event.entry, ts: query.after_ts },
      }) <= 0
    ) {
      return false;
    }
  } else if (query.since_ts !== undefined && event.entry.ts < query.since_ts) {
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
  const targetPath = eventIndexPath(pmRoot);
  try {
    await fs.access(targetPath);
  } catch {
    await append();
    return;
  }
  const Database = resolveDatabaseSync();
  if (!Database) {
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
    upsertStreamByteSize(database, streamId, (await fs.stat(historyPath)).size);
    database.exec("COMMIT");
    database.close();
  } catch (error: unknown) {
    database?.close();
    if (!appended) throw error;
    await fs.rm(targetPath, { force: true });
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
    parameters.push(
      query.after_ts,
      query.after_ts,
      query.after_stream_id,
      query.after_ts,
      query.after_stream_id,
      query.after_stream_offset,
    );
  } else if (query.since_ts !== undefined) {
    clauses.push("ts >= ?");
    parameters.push(query.since_ts);
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
    database = new Database(eventIndexPath(pmRoot), { readOnly: true });
    const version = database
      .prepare("SELECT value FROM metadata WHERE key = 'version'")
      .get() as { value?: unknown } | undefined;
    if (version?.value !== EVENT_INDEX_VERSION) {
      database.close();
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
    const hasMore = rows.length > query.limit;
    const events = rows.slice(0, query.limit).map((row) => ({
      stream_id: String(row.stream_id),
      stream_offset: Number(row.stream_offset),
      entry: JSON.parse(String(row.entry_json)) as HistoryEntry,
    }));
    database.close();
    return { events, has_more: hasMore };
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
  for (const event of [...events].sort(compareHistoryEventPosition).reverse()) {
    if (
      requested.has(event.stream_id) &&
      latest[event.stream_id] === undefined &&
      classifyHistoryEvent(event.entry) === "substantive"
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

async function readIndexedLatestSubstantiveEvents(
  Database: DatabaseSyncConstructor | null,
  pmRoot: string,
  streamIds: readonly string[],
  requested: ReadonlySet<string>,
): Promise<Record<string, IndexedHistoryEvent> | null> {
  if (!Database) return null;
  let database: DatabaseSync | undefined;
  try {
    database = new Database(eventIndexPath(pmRoot), { readOnly: true });
    const version = database
      .prepare("SELECT value FROM metadata WHERE key = 'version'")
      .get() as { value?: unknown } | undefined;
    if (
      version?.value !== EVENT_INDEX_VERSION ||
      !(await historyIndexMatchesStreamSizes(database, pmRoot, streamIds))
    ) {
      database.close();
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
      indexed.push(
        ...rows.map((row) => ({
          stream_id: String(row.stream_id),
          stream_offset: Number(row.stream_offset),
          entry: JSON.parse(String(row.entry_json)) as HistoryEntry,
        })),
      );
    }
    database.close();
    return collectLatestSubstantiveEvents(indexed, requested);
  } catch {
    database?.close();
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
    ...new Set(streamIds.filter((id) => id.trim().length > 0)),
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
  if (indexed !== null) return indexed;
  if (Database) {
    try {
      if (await rebuildHistoryEventIndex(pmRoot)) {
        const rebuilt = await readIndexedLatestSubstantiveEvents(
          Database,
          pmRoot,
          uniqueIds,
          requested,
        );
        if (rebuilt !== null) return rebuilt;
      }
    } catch {
      // A corrupt unrelated stream must not prevent requested authoritative reads.
    }
  }
  const authoritative: IndexedHistoryEvent[] = [];
  await Promise.all(
    uniqueIds.map(async (streamId) => {
      if (path.basename(streamId) !== streamId) return;
      const historyPath = path.join(pmRoot, "history", `${streamId}.jsonl`);
      const entries = await readHistoryEntries(historyPath, streamId);
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
