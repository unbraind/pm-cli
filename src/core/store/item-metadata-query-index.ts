/**
 * @module core/store/item-metadata-query-index
 *
 * Maintains a rebuildable SQLite projection for bounded metadata queries.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ItemMetadata } from "../../types/index.js";

const QUERY_INDEX_FILENAME = "metadata-query-index.sqlite";
const QUERY_INDEX_VERSION = "1";

/** One light-metadata row projected into the persistent query index. */
export interface ItemMetadataQueryIndexRow {
  /** Tracker-relative authoritative item path. */
  relativePath: string;
  /** Light item metadata serialized into the row store. */
  metadata: ItemMetadata;
}

/** Selection supported directly by the persistent metadata query index. */
export interface ItemMetadataIndexQuery {
  /** Include only these lifecycle statuses. */
  statuses?: readonly string[];
  /** Exclude these lifecycle statuses. */
  excludeStatuses?: readonly string[];
  /** Statuses sorted after active rows by the default list ordering contract. */
  terminalStatuses?: readonly string[];
  /** Include only these item types. */
  types?: readonly string[];
  /** Include only these exact item identifiers. */
  ids?: readonly string[];
  /** Include only direct children of this item. */
  parent?: string;
  /** Include only this assignee value. */
  assignee?: string;
  /** Include only this sprint value. */
  sprint?: string;
  /** Include only this release value. */
  release?: string;
  /** Include only this numeric priority. */
  priority?: number;
  /** Maximum rows returned after deterministic default ordering. */
  limit?: number;
  /** Number of ordered rows skipped before returning results. */
  offset?: number;
}

/** Bounded query result carrying total match count and index provenance. */
export interface ItemMetadataIndexQueryResult {
  /** Effective index source cursor. */
  source_cursor: string;
  /** Total matching rows before offset and limit. */
  total: number;
  /** Ordered light metadata rows in the requested window. */
  items: ItemMetadata[];
}

function queryIndexPath(pmRoot: string): string {
  return path.join(pmRoot, "runtime", QUERY_INDEX_FILENAME);
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL UNIQUE,
      metadata_json TEXT NOT NULL,
      status TEXT NOT NULL,
      type TEXT NOT NULL,
      priority INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      parent TEXT,
      assignee TEXT,
      sprint TEXT,
      release TEXT
    ) STRICT;
    CREATE INDEX items_default_order
      ON items(priority, updated_at DESC, id);
    CREATE INDEX items_status_default_order
      ON items(status, priority, updated_at DESC, id);
    CREATE INDEX items_type_default_order
      ON items(type, priority, updated_at DESC, id);
    CREATE INDEX items_parent_default_order
      ON items(parent, priority, updated_at DESC, id);
  `);
}

function writeMetadata(
  database: DatabaseSync,
  key: string,
  value: string,
): void {
  database
    .prepare(
      "INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

function insertRow(
  database: DatabaseSync,
  row: ItemMetadataQueryIndexRow,
): void {
  const metadata = row.metadata;
  database
    .prepare(
      `INSERT INTO items(
        id, relative_path, metadata_json, status, type, priority,
        updated_at, created_at, parent, assignee, sprint, release
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        relative_path = excluded.relative_path,
        metadata_json = excluded.metadata_json,
        status = excluded.status,
        type = excluded.type,
        priority = excluded.priority,
        updated_at = excluded.updated_at,
        created_at = excluded.created_at,
        parent = excluded.parent,
        assignee = excluded.assignee,
        sprint = excluded.sprint,
        release = excluded.release`,
    )
    .run(
      metadata.id,
      row.relativePath,
      JSON.stringify(metadata),
      metadata.status,
      metadata.type,
      metadata.priority,
      metadata.updated_at,
      metadata.created_at,
      metadata.parent ?? null,
      metadata.assignee ?? null,
      metadata.sprint ?? null,
      metadata.release ?? null,
    );
}

/** Atomically rebuild the complete query projection from authoritative cache rows. */
export async function rebuildItemMetadataQueryIndex(options: {
  pmRoot: string;
  contextFingerprint: string;
  sourceCursor: string;
  rows: readonly ItemMetadataQueryIndexRow[];
}): Promise<void> {
  const targetPath = queryIndexPath(options.pmRoot);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(temporaryPath);
    createSchema(database);
    database.exec("BEGIN IMMEDIATE");
    writeMetadata(database, "version", QUERY_INDEX_VERSION);
    writeMetadata(database, "context_fingerprint", options.contextFingerprint);
    writeMetadata(database, "source_cursor", options.sourceCursor);
    for (const row of options.rows) insertRow(database, row);
    database.exec("COMMIT");
    database.close();
    database = undefined;
    await fs.rm(targetPath, { force: true });
    await fs.rename(temporaryPath, targetPath);
  } catch (error: unknown) {
    database?.close();
    await Promise.allSettled([fs.rm(temporaryPath, { force: true })]);
    throw error;
  }
}

function readIndexMetadata(database: DatabaseSync): Record<string, string> {
  return Object.fromEntries(
    database
      .prepare("SELECT key, value FROM metadata")
      .all()
      .map((row) => [String(row.key), String(row.value)]),
  );
}

/**
 * Apply one authoritative metadata mutation in the same writer critical
 * section as the JSON derived-index delta. A cursor mismatch fails closed so
 * callers can remove and lazily rebuild this optional projection.
 */
export async function updateItemMetadataQueryIndex(options: {
  pmRoot: string;
  contextFingerprint: string;
  expectedSourceCursor: string;
  sourceCursor: string;
  row: ItemMetadataQueryIndexRow | null;
  deletedRelativePaths?: readonly string[];
}): Promise<boolean> {
  const indexPath = queryIndexPath(options.pmRoot);
  let database: DatabaseSync | undefined;
  try {
    await fs.access(indexPath);
    database = new DatabaseSync(indexPath);
    const metadata = readIndexMetadata(database);
    if (
      metadata.version !== QUERY_INDEX_VERSION ||
      metadata.context_fingerprint !== options.contextFingerprint ||
      metadata.source_cursor !== options.expectedSourceCursor
    ) {
      database.close();
      return false;
    }
    database.exec("BEGIN IMMEDIATE");
    const deleteByPath = database.prepare(
      "DELETE FROM items WHERE relative_path = ?",
    );
    for (const relativePath of options.deletedRelativePaths ?? []) {
      deleteByPath.run(relativePath);
    }
    if (options.row) insertRow(database, options.row);
    writeMetadata(database, "source_cursor", options.sourceCursor);
    database.exec("COMMIT");
    database.close();
    return true;
  } catch {
    try {
      database?.exec("ROLLBACK");
    } catch {
      // The optional query projection will be invalidated below.
    }
    database?.close();
    return false;
  }
}

function appendSetPredicate(
  clauses: string[],
  parameters: SQLInputValue[],
  column: string,
  values: readonly string[] | undefined,
  operator: "IN" | "NOT IN",
): void {
  if (!values || values.length === 0) return;
  clauses.push(`${column} ${operator} (${values.map(() => "?").join(", ")})`);
  parameters.push(...values);
}

/**
 * Query the persistent projection without materializing the full metadata
 * cache. Returns null when the database is absent, stale, corrupt, or active
 * extension read hooks require canonical per-document dispatch.
 */
export async function queryItemMetadataIndex(options: {
  pmRoot: string;
  expectedSourceCursor: string;
  query?: ItemMetadataIndexQuery;
}): Promise<ItemMetadataIndexQueryResult | null> {
  const query = options.query ?? {};
  const clauses: string[] = [];
  const parameters: SQLInputValue[] = [];
  appendSetPredicate(clauses, parameters, "status", query.statuses, "IN");
  appendSetPredicate(
    clauses,
    parameters,
    "status",
    query.excludeStatuses,
    "NOT IN",
  );
  appendSetPredicate(clauses, parameters, "type", query.types, "IN");
  appendSetPredicate(clauses, parameters, "id", query.ids, "IN");
  for (const [column, value] of [
    ["parent", query.parent],
    ["assignee", query.assignee],
    ["sprint", query.sprint],
    ["release", query.release],
  ] as const) {
    if (value !== undefined) {
      clauses.push(`${column} = ?`);
      parameters.push(value);
    }
  }
  if (query.priority !== undefined) {
    clauses.push("priority = ?");
    parameters.push(query.priority);
  }
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(queryIndexPath(options.pmRoot), {
      readOnly: true,
    });
    const metadata = readIndexMetadata(database);
    if (
      metadata.version !== QUERY_INDEX_VERSION ||
      metadata.source_cursor !== options.expectedSourceCursor
    ) {
      database.close();
      return null;
    }
    const totalRow = database
      .prepare(`SELECT COUNT(*) AS count FROM items${where}`)
      .get(...parameters) as { count: number };
    const windowParameters: SQLInputValue[] = [];
    let window = "";
    if (query.limit !== undefined) {
      window += " LIMIT ?";
      windowParameters.push(Math.max(0, Math.floor(query.limit)));
      if (query.offset !== undefined) {
        window += " OFFSET ?";
        windowParameters.push(Math.max(0, Math.floor(query.offset)));
      }
    } else if (query.offset !== undefined) {
      window += " LIMIT -1 OFFSET ?";
      windowParameters.push(Math.max(0, Math.floor(query.offset)));
    }
    const rows = database
      .prepare(
        `SELECT metadata_json FROM items${where}
         ORDER BY ${
           query.terminalStatuses && query.terminalStatuses.length > 0
             ? `CASE WHEN status IN (${query.terminalStatuses
                 .map(() => "?")
                 .join(", ")}) THEN 1 ELSE 0 END ASC, `
             : ""
         }priority ASC, updated_at DESC, id ASC${window}`,
      )
      .all(
        ...parameters,
        ...(query.terminalStatuses ?? []),
        ...windowParameters,
      );
    const items = rows.map((row) => {
      const parsed = JSON.parse(String(row.metadata_json)) as ItemMetadata;
      if (!parsed.id) throw new TypeError("Indexed metadata row has no id");
      return parsed;
    });
    database.close();
    return {
      source_cursor: metadata.source_cursor,
      total: Number(totalRow.count),
      items,
    };
  } catch {
    database?.close();
    return null;
  }
}

/** Remove only the optional SQLite query projection. */
export async function removeItemMetadataQueryIndex(
  pmRoot: string,
): Promise<void> {
  await fs.rm(queryIndexPath(pmRoot), { force: true });
}
