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
import { readHistoryEntries } from "./read.js";

const EVENT_INDEX_FILENAME = "history-event-index.sqlite";
const EVENT_INDEX_VERSION = "1";
type DatabaseSyncConstructor = typeof DatabaseSync;

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

function eventIndexPath(pmRoot: string): string {
  return path.join(pmRoot, "runtime", EVENT_INDEX_FILENAME);
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
  return Number.isFinite(nodeMajor) && nodeMajor >= 23
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
      op TEXT NOT NULL,
      entry_json TEXT NOT NULL,
      PRIMARY KEY(stream_id, stream_offset)
    ) STRICT;
    CREATE INDEX events_order
      ON events(ts, stream_id, stream_offset);
    CREATE INDEX events_op_order
      ON events(op, ts, stream_id, stream_offset);
    CREATE INDEX events_author_order
      ON events(author, ts, stream_id, stream_offset);
  `);
  database
    .prepare("INSERT INTO metadata(key, value) VALUES ('version', ?)")
    .run(EVENT_INDEX_VERSION);
}

function insertEvent(
  database: DatabaseSync,
  event: IndexedHistoryEvent,
): void {
  database
    .prepare(
      `INSERT INTO events(
        stream_id, stream_offset, ts, author, op, entry_json
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.stream_id,
      event.stream_offset,
      event.entry.ts,
      event.entry.author,
      event.entry.op,
      JSON.stringify(event.entry),
    );
}

/** Rebuild the complete optional event projection from authoritative streams. */
export async function rebuildHistoryEventIndex(pmRoot: string): Promise<boolean> {
  const Database = resolveDatabaseSync();
  if (!Database) return false;
  const historyRoot = path.join(pmRoot, "history");
  const entries = await fs.readdir(historyRoot, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    },
  );
  const historyFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const targetPath = eventIndexPath(pmRoot);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  let database: DatabaseSync | undefined;
  try {
    database = new Database(temporaryPath);
    createSchema(database);
    database.exec("BEGIN IMMEDIATE");
    for (const historyFile of historyFiles) {
      const streamId = historyFile.name.slice(0, -".jsonl".length);
      const history = await readHistoryEntries(
        path.join(historyRoot, historyFile.name),
        streamId,
      );
      for (const [streamOffset, entry] of history.entries()) {
        insertEvent(database, {
          stream_id: streamId,
          stream_offset: streamOffset,
          entry,
        });
      }
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

/**
 * Update an already-built event projection after one authoritative append.
 * Absence is a cheap no-op; corrupt projections are removed for lazy rebuild.
 */
export async function updateHistoryEventIndexAfterAppend(
  historyPath: string,
  entry: HistoryEntry,
): Promise<void> {
  const pmRoot = path.dirname(path.dirname(historyPath));
  const targetPath = eventIndexPath(pmRoot);
  try {
    await fs.access(targetPath);
  } catch {
    return;
  }
  const Database = resolveDatabaseSync();
  if (!Database) return;
  let database: DatabaseSync | undefined;
  try {
    database = new Database(targetPath);
    const version = database
      .prepare("SELECT value FROM metadata WHERE key = 'version'")
      .get() as { value?: unknown } | undefined;
    if (version?.value !== EVENT_INDEX_VERSION) {
      throw new TypeError("Unsupported history event index version");
    }
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
    database.close();
  } catch {
    database?.close();
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

/** Test-only dependency seam for runtimes without stable `node:sqlite`. */
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
