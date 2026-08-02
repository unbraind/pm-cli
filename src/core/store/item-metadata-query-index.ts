/**
 * @module core/store/item-metadata-query-index
 *
 * Maintains a rebuildable SQLite projection for bounded metadata queries.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ItemMetadata, LinkedFile, LinkScope } from "../../types/index.js";

const QUERY_INDEX_FILENAME = "metadata-query-index.sqlite";
const QUERY_INDEX_VERSION = "4";
type DatabaseSyncConstructor = typeof DatabaseSync;

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

let RuntimeDatabaseSync: DatabaseSyncConstructor | null | undefined;

function loadStableDatabaseSync(
  nodeVersion: string,
  loadModule: (specifier: string) => unknown,
): DatabaseSyncConstructor | null {
  const nodeMajor = Number.parseInt(nodeVersion, 10);
  return Number.isFinite(nodeMajor) && nodeMajor >= 22
    ? loadDatabaseSync(loadModule)
    : null;
}

function resolveDatabaseSync(): DatabaseSyncConstructor | null {
  if (RuntimeDatabaseSync !== undefined) return RuntimeDatabaseSync;
  RuntimeDatabaseSync = loadStableDatabaseSync(
    process.versions.node,
    createRequire(import.meta.url),
  );
  return RuntimeDatabaseSync;
}

/** One light-metadata row projected into the persistent query index. */
export interface ItemMetadataQueryIndexRow {
  /** Tracker-relative authoritative item path. */
  relativePath: string;
  /** Light item metadata serialized into the row store. */
  metadata: ItemMetadata;
  /** Heavy linked-file records projected separately for reverse traceability. */
  linkedFiles?: readonly LinkedFile[];
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
  /** Include only rows that define every requested metadata key. */
  metadataKeys?: readonly string[];
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

/** Bounded lexical candidate result from the persistent metadata projection. */
export interface SimilarItemMetadataIndexResult {
  /** Effective index source cursor. */
  source_cursor: string;
  /** FTS-ranked light metadata candidates. */
  items: ItemMetadata[];
}

/** One indexed item and the requested linked-file records that reference it. */
export interface IndexedLinkedFileMatch {
  /** Light metadata for the referencing item. */
  item: ItemMetadata;
  /** Exact linked-file records matching the requested paths and optional scope. */
  files: LinkedFile[];
}

/** Bounded reverse linked-file query result from the persistent projection. */
export interface LinkedFileMetadataIndexResult {
  /** Effective index source cursor. */
  source_cursor: string;
  /** Total matching items before offset and limit. */
  total: number;
  /** Deterministically ordered referencing items in the requested window. */
  matches: IndexedLinkedFileMatch[];
}

function normalizeIndexWindowValue(
  value: number | undefined,
  fallback: number,
): number {
  return Math.max(0, Math.floor(value === undefined ? fallback : value));
}

function queryIndexPath(pmRoot: string): string {
  return path.join(pmRoot, "runtime", QUERY_INDEX_FILENAME);
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
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
    CREATE TABLE item_metadata_keys (
      item_id TEXT NOT NULL,
      key TEXT NOT NULL,
      PRIMARY KEY(item_id, key),
      FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX item_metadata_keys_key_item
      ON item_metadata_keys(key, item_id);
    CREATE TABLE item_linked_files (
      item_id TEXT NOT NULL,
      path TEXT NOT NULL,
      scope TEXT NOT NULL,
      note TEXT,
      PRIMARY KEY(item_id, path, scope),
      FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX item_linked_files_path_scope_item
      ON item_linked_files(path, scope, item_id);
    CREATE VIRTUAL TABLE item_search USING fts5(
      id UNINDEXED,
      title,
      description,
      tags,
      tokenize = 'unicode61'
    );
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
  database
    .prepare("DELETE FROM item_metadata_keys WHERE item_id = ?")
    .run(metadata.id);
  database
    .prepare("DELETE FROM item_linked_files WHERE item_id = ?")
    .run(metadata.id);
  database.prepare("DELETE FROM item_search WHERE id = ?").run(metadata.id);
  database
    .prepare(
      "INSERT INTO item_search(id, title, description, tags) VALUES (?, ?, ?, ?)",
    )
    .run(
      metadata.id,
      metadata.title,
      metadata.description,
      metadata.tags.join(" "),
    );
  const insertMetadataKey = database.prepare(
    "INSERT INTO item_metadata_keys(item_id, key) VALUES (?, ?)",
  );
  for (const key of Object.keys(metadata)) {
    insertMetadataKey.run(metadata.id, key);
  }
  const insertLinkedFile = database.prepare(
    "INSERT INTO item_linked_files(item_id, path, scope, note) VALUES (?, ?, ?, ?)",
  );
  for (const file of row.linkedFiles ?? []) {
    insertLinkedFile.run(metadata.id, file.path, file.scope, file.note ?? null);
  }
}

/** Atomically rebuild the complete query projection from authoritative cache rows. */
export async function rebuildItemMetadataQueryIndex(options: {
  pmRoot: string;
  contextFingerprint: string;
  sourceCursor: string;
  rows: readonly ItemMetadataQueryIndexRow[];
}): Promise<void> {
  const targetPath = queryIndexPath(options.pmRoot);
  const Database = resolveDatabaseSync();
  if (!Database) {
    await fs.rm(targetPath, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  let database: DatabaseSync | undefined;
  try {
    database = new Database(temporaryPath);
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
    const Database = resolveDatabaseSync();
    if (!Database) return false;
    database = new Database(indexPath);
    database.exec("PRAGMA foreign_keys = ON");
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
    const findIdByPath = database.prepare(
      "SELECT id FROM items WHERE relative_path = ?",
    );
    const deleteSearchById = database.prepare(
      "DELETE FROM item_search WHERE id = ?",
    );
    for (const relativePath of options.deletedRelativePaths ?? []) {
      const deleted = findIdByPath.get(relativePath) as
        | { id: string }
        | undefined;
      deleteByPath.run(relativePath);
      if (deleted) deleteSearchById.run(deleted.id);
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

function buildQueryPredicates(query: ItemMetadataIndexQuery): {
  where: string;
  parameters: SQLInputValue[];
} {
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
  for (const metadataKey of query.metadataKeys ?? []) {
    clauses.push(
      "EXISTS (SELECT 1 FROM item_metadata_keys AS indexed_key WHERE indexed_key.item_id = items.id AND indexed_key.key = ?)",
    );
    parameters.push(metadataKey);
  }
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
  return {
    where: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`,
    parameters,
  };
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
  const Database = resolveDatabaseSync();
  if (!Database) return null;
  const query = options.query ?? {};
  const { where, parameters } = buildQueryPredicates(query);
  let database: DatabaseSync | undefined;
  try {
    database = new Database(queryIndexPath(options.pmRoot), {
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

/**
 * Resolve items that link any requested project-relative path without loading
 * heavy item collections. Returns null when the optional projection is absent,
 * stale, or corrupt so callers can fall back to authoritative item reads.
 */
export async function queryLinkedFileMetadataIndex(options: {
  pmRoot: string;
  expectedSourceCursor: string;
  paths: readonly string[];
  scope?: LinkScope;
  limit?: number;
  offset?: number;
}): Promise<LinkedFileMetadataIndexResult | null> {
  const Database = resolveDatabaseSync();
  if (!Database || options.paths.length === 0) return null;
  let database: DatabaseSync | undefined;
  try {
    database = new Database(queryIndexPath(options.pmRoot), {
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
    const pathPlaceholders = options.paths.map(() => "?").join(", ");
    const scopePredicate = options.scope === undefined ? "" : " AND scope = ?";
    const matchParameters: SQLInputValue[] = [
      ...options.paths,
      ...(options.scope === undefined ? [] : [options.scope]),
    ];
    const predicate = `path IN (${pathPlaceholders})${scopePredicate}`;
    const totalRow = database
      .prepare(
        `SELECT COUNT(DISTINCT item_id) AS count
         FROM item_linked_files
         WHERE ${predicate}`,
      )
      .get(...matchParameters) as { count: number };
    const limit = normalizeIndexWindowValue(options.limit, 50);
    const offset = normalizeIndexWindowValue(options.offset, 0);
    const itemRows = database
      .prepare(
        `SELECT items.id, items.metadata_json
         FROM items
         WHERE EXISTS (
           SELECT 1 FROM item_linked_files
           WHERE item_linked_files.item_id = items.id AND ${predicate}
         )
         ORDER BY items.priority ASC, items.updated_at DESC, items.id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...matchParameters, limit, offset);
    const matches: IndexedLinkedFileMatch[] = [];
    if (itemRows.length > 0) {
      const itemIds = itemRows.map((row) => String(row.id));
      const linkedRows = database
        .prepare(
          `SELECT item_id, path, scope, note
           FROM item_linked_files
           WHERE item_id IN (${itemIds.map(() => "?").join(", ")})
             AND ${predicate}
           ORDER BY path ASC, scope ASC`,
        )
        .all(...itemIds, ...matchParameters);
      const filesByItem = new Map<string, LinkedFile[]>(
        itemIds.map((itemId) => [itemId, []]),
      );
      for (const row of linkedRows) {
        const itemId = String(row.item_id);
        const files = filesByItem.get(itemId)!;
        files.push({
          path: String(row.path),
          scope: String(row.scope) as LinkScope,
          ...(row.note === null ? {} : { note: String(row.note) }),
        });
        filesByItem.set(itemId, files);
      }
      for (const row of itemRows) {
        const item = JSON.parse(String(row.metadata_json)) as ItemMetadata;
        matches.push({ item, files: filesByItem.get(String(row.id))! });
      }
    }
    database.close();
    return {
      source_cursor: metadata.source_cursor,
      total: Number(totalRow.count),
      matches,
    };
  } catch {
    database?.close();
    return null;
  }
}

/**
 * Query FTS-ranked item candidates without materializing the workspace. The
 * caller owns final similarity scoring and threshold semantics.
 */
export async function querySimilarItemMetadataIndex(options: {
  pmRoot: string;
  expectedSourceCursor: string;
  query: string;
  limit: number;
}): Promise<SimilarItemMetadataIndexResult | null> {
  const Database = resolveDatabaseSync();
  if (!Database) return null;
  let database: DatabaseSync | undefined;
  try {
    database = new Database(queryIndexPath(options.pmRoot), {
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
    const rows = database
      .prepare(
        `SELECT items.metadata_json
         FROM item_search
         JOIN items ON items.id = item_search.id
         WHERE item_search MATCH ?
         ORDER BY bm25(item_search), items.priority, items.updated_at DESC, items.id
         LIMIT ?`,
      )
      .all(options.query, Math.max(0, Math.floor(options.limit)));
    const items = rows.map(
      (row) => JSON.parse(String(row.metadata_json)) as ItemMetadata,
    );
    database.close();
    return {
      source_cursor: metadata.source_cursor,
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

/** Test-only dependency seam for runtimes that do not implement node:sqlite. */
export const _testOnly = {
  loadDatabaseSync,
  loadStableDatabaseSync,
  /** Replace the optional constructor and return a restoration callback. */
  setDatabaseSync(databaseSync: DatabaseSyncConstructor | null): () => void {
    const previous = RuntimeDatabaseSync;
    RuntimeDatabaseSync = databaseSync;
    return () => {
      RuntimeDatabaseSync = previous;
    };
  },
};
