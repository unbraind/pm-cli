import type { PmSettings } from "../../types/index.js";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  executeSearchJsonRequest,
  normalizeSearchHttpTimeoutMs,
  resolveSearchHttpFetcher,
} from "./http-client.js";
import type { SearchHttpFetcher, SearchHttpResponse } from "./http-client.js";
import {
  isFiniteNumberArray,
  toErrorMessage,
  toNonEmptyString,
  trimTrailingSlashes,
} from "../shared/primitives.js";

export type VectorStoreName = "qdrant" | "lancedb";

export interface QdrantVectorStoreConfig {
  name: "qdrant";
  url: string;
  api_key?: string;
}

export interface LanceDbVectorStoreConfig {
  name: "lancedb";
  path: string;
}

export type VectorStoreConfig = QdrantVectorStoreConfig | LanceDbVectorStoreConfig;

export interface VectorStoreResolution {
  active: VectorStoreConfig | null;
  available: VectorStoreConfig[];
}

export interface VectorStoreRequestTarget {
  store: VectorStoreName;
  query_target: string;
  upsert_target: string;
}

export interface VectorQueryPlan {
  target: VectorStoreRequestTarget;
  method: "POST" | "LOCAL";
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface VectorRecord {
  id: string;
  vector: number[];
  payload?: Record<string, unknown>;
}

export interface VectorUpsertPlan {
  target: VectorStoreRequestTarget;
  method: "POST" | "LOCAL";
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface VectorDeletePlan {
  target: VectorStoreRequestTarget;
  method: "POST" | "LOCAL";
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface VectorQueryHit {
  id: string;
  score: number;
  payload?: Record<string, unknown>;
}

export interface VectorUpsertResult {
  status: string;
}

export type VectorHttpResponse = SearchHttpResponse;

export type VectorRequestFetcher = SearchHttpFetcher<VectorHttpResponse>;

export interface ExecuteVectorRequestOptions {
  timeout_ms?: number;
  fetcher?: VectorRequestFetcher;
  warnings?: string[];
}

type VectorSettingsInput = {
  vector_store?: {
    qdrant?: {
      url?: string;
      api_key?: string;
    };
    lancedb?: {
      path?: string;
    };
  };
};

const DEFAULT_COLLECTION = "pm_items";
const LANCE_DB_LOCAL_SNAPSHOT_DIR = ".pm-cli-local-vectors";
const LANCE_DB_LOCAL_SNAPSHOT_VERSION = 1;
interface LanceDbLocalTableCacheEntry {
  records: Map<string, VectorRecord>;
  mtimeMs: number | null;
  size: number | null;
}

const lanceDbLocalTables = new Map<string, LanceDbLocalTableCacheEntry>();

function normalizeVector(value: unknown): number[] {
  if (!isFiniteNumberArray(value) || value.length === 0) {
    throw new Error("Vector values must be a non-empty numeric array");
  }
  return [...value];
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Vector query limit must be a positive number");
  }
  return Math.floor(value);
}

function normalizeQdrantQueryResponse(payload: unknown): VectorQueryHit[] {
  const result = (payload as { result?: unknown }).result;
  if (!Array.isArray(result)) {
    throw new TypeError("Qdrant query response must include a result array");
  }
  const hits = result.map((entry, index) => {
    const idValue = (entry as { id?: unknown }).id;
    const idCandidate = typeof idValue === "number" ? String(idValue) : idValue;
    const id = toNonEmptyString(idCandidate);
    if (!id) {
      throw new Error(`Qdrant query response entry at index ${index} is missing a non-empty id`);
    }

    const score = (entry as { score?: unknown }).score;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new TypeError(`Qdrant query response entry at index ${index} is missing a finite numeric score`);
    }

    const payloadValue = (entry as { payload?: unknown }).payload;
    if (
      payloadValue !== undefined &&
      (typeof payloadValue !== "object" || payloadValue === null || Array.isArray(payloadValue))
    ) {
      throw new Error(`Qdrant query response entry at index ${index} must provide payload as an object when set`);
    }

    return {
      id,
      score,
      ...(payloadValue ? { payload: payloadValue as Record<string, unknown> } : {}),
    };
  });
  hits.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.id.localeCompare(right.id);
  });
  return hits;
}

function normalizeQdrantUpsertResponse(payload: unknown): VectorUpsertResult {
  const nestedStatus = toNonEmptyString((payload as { result?: { status?: unknown } }).result?.status);
  if (nestedStatus) {
    return { status: nestedStatus };
  }
  const topLevelStatus = toNonEmptyString((payload as { status?: unknown }).status);
  if (topLevelStatus) {
    return { status: topLevelStatus };
  }
  throw new Error("Qdrant upsert response must include status metadata");
}

async function executeRemoteVectorPlan(
  endpoint: string,
  plan: {
    method: "POST";
    headers: Record<string, string>;
    body: Record<string, unknown>;
  },
  timeoutMs: number,
  fetcher: VectorRequestFetcher,
  requestKind: "query" | "upsert" | "delete",
): Promise<unknown> {
  return await executeSearchJsonRequest({
    endpoint,
    method: plan.method,
    headers: plan.headers,
    body: plan.body,
    timeoutMs,
    fetcher,
    requestLabel: `Vector ${requestKind} request`,
    responseLabel: `Vector ${requestKind} response`,
  });
}

function resolveQdrantStore(settings: VectorSettingsInput): QdrantVectorStoreConfig | null {
  const url = toNonEmptyString(settings.vector_store?.qdrant?.url);
  if (!url) {
    return null;
  }
  const apiKey = toNonEmptyString(settings.vector_store?.qdrant?.api_key);
  return {
    name: "qdrant",
    url,
    ...(apiKey ? { api_key: apiKey } : {}),
  };
}

function resolveLanceDbStore(settings: VectorSettingsInput): LanceDbVectorStoreConfig | null {
  const lancedbPath = toNonEmptyString(settings.vector_store?.lancedb?.path);
  if (!lancedbPath) {
    return null;
  }
  return {
    name: "lancedb",
    path: lancedbPath,
  };
}

function normalizeVectorRecords(records: VectorRecord[]): VectorRecord[] {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("Vector upsert records must include at least one entry");
  }
  return records.map((record, index) => {
    const id = toNonEmptyString(record.id);
    if (!id) {
      throw new Error(`Vector upsert record at index ${index} is missing a non-empty id`);
    }
    const vector = normalizeVector(record.vector);
    const payload = record.payload;
    if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) {
      throw new Error(`Vector upsert record at index ${index} must provide payload as an object when set`);
    }
    return {
      id,
      vector,
      ...(payload ? { payload } : {}),
    };
  });
}

function normalizeVectorDeleteIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("Vector delete ids must include at least one entry");
  }
  const normalizedIds = ids
    .map((id, index) => {
      const normalized = toNonEmptyString(id);
      if (!normalized) {
        throw new Error(`Vector delete id at index ${index} is missing a non-empty value`);
      }
      return normalized;
    })
    .sort((left, right) => left.localeCompare(right));
  const uniqueIds: string[] = [];
  for (const id of normalizedIds) {
    if (uniqueIds.at(-1) !== id) {
      uniqueIds.push(id);
    }
  }
  return uniqueIds;
}

function resolveQdrantDeleteTarget(upsertTarget: string): string {
  return upsertTarget.replace(/\/points\?wait=true$/, "/points/delete?wait=true");
}

function getLanceDbLocalTableKey(storePath: string, table: string): string {
  return getLanceDbSnapshotPath(storePath, table);
}

function getLanceDbSnapshotPath(storePath: string, table: string): string {
  return join(resolve(storePath), LANCE_DB_LOCAL_SNAPSHOT_DIR, `${table}.json`);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function normalizeSnapshotRecord(entry: unknown, index: number, snapshotPath: string): VectorRecord {
  const id = toNonEmptyString((entry as { id?: unknown }).id);
  if (!id) {
    throw new Error(`LanceDB local snapshot '${snapshotPath}' record at index ${index} is missing a non-empty id`);
  }
  const vector = normalizeVector((entry as { vector?: unknown }).vector);
  const payload = (entry as { payload?: unknown }).payload;
  if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) {
    throw new Error(
      `LanceDB local snapshot '${snapshotPath}' record '${id}' must provide payload as an object when set`,
    );
  }
  return {
    id,
    vector,
    ...(payload ? { payload: payload as Record<string, unknown> } : {}),
  };
}

function parseLanceDbSnapshot(snapshotPath: string, expectedTable: string, raw: string): Map<string, VectorRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`LanceDB local snapshot at '${snapshotPath}' is not valid JSON: ${toErrorMessage(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`LanceDB local snapshot at '${snapshotPath}' must be a JSON object`);
  }

  const version = (parsed as { version?: unknown }).version;
  if (version !== LANCE_DB_LOCAL_SNAPSHOT_VERSION) {
    throw new Error(
      `LanceDB local snapshot at '${snapshotPath}' must include version=${LANCE_DB_LOCAL_SNAPSHOT_VERSION}`,
    );
  }

  const table = toNonEmptyString((parsed as { table?: unknown }).table);
  if (!table) {
    throw new Error(`LanceDB local snapshot at '${snapshotPath}' must include a non-empty table value`);
  }
  if (table !== expectedTable) {
    throw new Error(
      `LanceDB local snapshot at '${snapshotPath}' table mismatch: expected '${expectedTable}', received '${table}'`,
    );
  }

  const recordsValue = (parsed as { records?: unknown }).records;
  if (!Array.isArray(recordsValue)) {
    throw new TypeError(`LanceDB local snapshot at '${snapshotPath}' must include a records array`);
  }

  const tableRecords = new Map<string, VectorRecord>();
  for (let index = 0; index < recordsValue.length; index += 1) {
    const record = normalizeSnapshotRecord(recordsValue[index], index, snapshotPath);
    tableRecords.set(record.id, record);
  }
  return tableRecords;
}

async function loadLanceDbLocalTable(storePath: string, table: string): Promise<Map<string, VectorRecord>> {
  const key = getLanceDbLocalTableKey(storePath, table);
  const snapshotPath = getLanceDbSnapshotPath(storePath, table);
  let snapshotStats: { mtimeMs: number; size: number } | null = null;
  try {
    const stats = await stat(snapshotPath);
    snapshotStats = { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }

  const cached = lanceDbLocalTables.get(key);
  if (cached && !snapshotStats) {
    if (cached.mtimeMs === null && cached.size === null && cached.records.size === 0) {
      return cached.records;
    }
    const loaded = new Map<string, VectorRecord>();
    lanceDbLocalTables.set(key, { records: loaded, mtimeMs: null, size: null });
    return loaded;
  }
  if (
    cached &&
    snapshotStats &&
    cached.mtimeMs === snapshotStats.mtimeMs &&
    cached.size === snapshotStats.size
  ) {
    return cached.records;
  }

  let loaded = new Map<string, VectorRecord>();
  try {
    const raw = await readFile(snapshotPath, "utf8");
    loaded = parseLanceDbSnapshot(snapshotPath, table, raw);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
  lanceDbLocalTables.set(key, {
    records: loaded,
    mtimeMs: snapshotStats?.mtimeMs ?? null,
    size: snapshotStats?.size ?? null,
  });
  return loaded;
}

function buildSnapshotRecords(table: Map<string, VectorRecord>): VectorRecord[] {
  const records = [...table.values()];
  records.sort((left, right) => left.id.localeCompare(right.id));
  return records.map((record) => ({
    id: record.id,
    vector: [...record.vector],
    ...(record.payload ? { payload: record.payload } : {}),
  }));
}

async function removeSnapshotFile(snapshotPath: string): Promise<void> {
  try {
    await unlink(snapshotPath);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw new Error(`LanceDB local snapshot delete failed at '${snapshotPath}': ${toErrorMessage(error)}`);
    }
  }
}

async function persistLanceDbLocalTable(storePath: string, tableName: string, table: Map<string, VectorRecord>): Promise<void> {
  const snapshotPath = getLanceDbSnapshotPath(storePath, tableName);
  if (table.size === 0) {
    await removeSnapshotFile(snapshotPath);
    return;
  }

  const snapshotDir = dirname(snapshotPath);
  try {
    await mkdir(snapshotDir, { recursive: true });
  } catch (error) {
    throw new Error(
      `LanceDB local snapshot directory create failed at '${snapshotDir}': ${toErrorMessage(error)}`,
    );
  }

  const tempPath = join(
    snapshotDir,
    `${basename(snapshotPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const serialized = `${JSON.stringify(
    {
      version: LANCE_DB_LOCAL_SNAPSHOT_VERSION,
      table: tableName,
      records: buildSnapshotRecords(table),
    },
    null,
    2,
  )}\n`;
  try {
    await writeFile(tempPath, serialized, "utf8");
    await rename(tempPath, snapshotPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw new Error(`LanceDB local snapshot write failed at '${snapshotPath}': ${toErrorMessage(error)}`);
  }
}

function l2Norm(vector: number[]): number {
  let sumSq = 0;
  for (let index = 0; index < vector.length; index += 1) {
    sumSq += vector[index] * vector[index];
  }
  return Math.sqrt(sumSq);
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dotProd = 0;
  for (let index = 0; index < left.length; index += 1) {
    dotProd += left[index] * right[index];
  }
  const leftNorm = l2Norm(left);
  const rightNorm = l2Norm(right);
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dotProd / (leftNorm * rightNorm);
}

export function resolveVectorStores(settings: PmSettings | VectorSettingsInput): VectorStoreResolution {
  const qdrant = resolveQdrantStore(settings);
  const lancedb = resolveLanceDbStore(settings);
  const available = [qdrant, lancedb].filter((entry): entry is VectorStoreConfig => entry !== null);
  return {
    active: available[0] ?? null,
    available,
  };
}

export function resolveVectorStoreRequestTarget(store: VectorStoreConfig): VectorStoreRequestTarget {
  if (store.name === "qdrant") {
    const baseUrl = trimTrailingSlashes(store.url);
    return {
      store: "qdrant",
      query_target: `${baseUrl}/collections/${DEFAULT_COLLECTION}/points/search`,
      upsert_target: `${baseUrl}/collections/${DEFAULT_COLLECTION}/points?wait=true`,
    };
  }
  const encodedPath = encodeURIComponent(store.path);
  return {
    store: "lancedb",
    query_target: `lancedb://${encodedPath}#${DEFAULT_COLLECTION}`,
    upsert_target: `lancedb://${encodedPath}#${DEFAULT_COLLECTION}`,
  };
}

export function buildVectorQueryPlan(store: VectorStoreConfig, vector: number[], limit: number): VectorQueryPlan {
  const target = resolveVectorStoreRequestTarget(store);
  const normalizedVector = normalizeVector(vector);
  const normalizedLimit = normalizeLimit(limit);
  if (store.name === "qdrant") {
    return {
      target,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(store.api_key ? { "api-key": store.api_key } : {}),
      },
      body: {
        vector: normalizedVector,
        limit: normalizedLimit,
        with_payload: true,
      },
    };
  }
  return {
    target,
    method: "LOCAL",
    headers: {},
    body: {
      table: DEFAULT_COLLECTION,
      vector: normalizedVector,
      limit: normalizedLimit,
    },
  };
}

export function buildVectorUpsertPlan(store: VectorStoreConfig, records: VectorRecord[]): VectorUpsertPlan {
  const target = resolveVectorStoreRequestTarget(store);
  const normalizedRecords = normalizeVectorRecords(records);
  if (store.name === "qdrant") {
    return {
      target,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(store.api_key ? { "api-key": store.api_key } : {}),
      },
      body: {
        points: normalizedRecords,
      },
    };
  }
  return {
    target,
    method: "LOCAL",
    headers: {},
    body: {
      table: DEFAULT_COLLECTION,
      records: normalizedRecords,
    },
  };
}

export function buildVectorDeletePlan(store: VectorStoreConfig, ids: string[]): VectorDeletePlan {
  const target = resolveVectorStoreRequestTarget(store);
  const normalizedIds = normalizeVectorDeleteIds(ids);
  if (store.name === "qdrant") {
    return {
      target,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(store.api_key ? { "api-key": store.api_key } : {}),
      },
      body: {
        points: normalizedIds,
      },
    };
  }
  return {
    target,
    method: "LOCAL",
    headers: {},
    body: {
      table: DEFAULT_COLLECTION,
      ids: normalizedIds,
    },
  };
}

export async function executeVectorQuery(
  store: VectorStoreConfig,
  vector: number[],
  limit: number,
  options: ExecuteVectorRequestOptions = {},
): Promise<VectorQueryHit[]> {
  const plan = buildVectorQueryPlan(store, vector, limit);
  if (plan.method === "LOCAL") {
    const lanceDbStore = store as LanceDbVectorStoreConfig;
    const queryBody = plan.body as {
      table: string;
      vector: number[];
      limit: number;
    };
    const table = await loadLanceDbLocalTable(lanceDbStore.path, queryBody.table);
    if (table.size === 0) {
      return [];
    }
    const queryVector = normalizeVector(queryBody.vector);
    const queryLimit = normalizeLimit(queryBody.limit);
    const hits: VectorQueryHit[] = [];
    let dimensionMismatchCount = 0;
    for (const record of table.values()) {
      if (record.vector.length !== queryVector.length) {
        dimensionMismatchCount++;
        continue;
      }
      hits.push({
        id: record.id,
        score: cosineSimilarity(queryVector, record.vector),
        ...(record.payload ? { payload: record.payload } : {}),
      });
    }
    if (dimensionMismatchCount > 0 && options.warnings) {
      options.warnings.push(
        `vector_dimension_mismatch:${dimensionMismatchCount} records skipped (expected ${queryVector.length} dimensions)`,
      );
    }
    hits.sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.id.localeCompare(right.id);
    });
    return hits.slice(0, queryLimit);
  }
  const timeoutMs = normalizeSearchHttpTimeoutMs(options.timeout_ms, "Vector request");
  const fetcher = resolveSearchHttpFetcher(options.fetcher, "Vector request");
  const payload = await executeRemoteVectorPlan(
    plan.target.query_target,
    {
      method: "POST",
      headers: plan.headers,
      body: plan.body,
    },
    timeoutMs,
    fetcher,
    "query",
  );
  return normalizeQdrantQueryResponse(payload);
}

export async function executeVectorUpsert(
  store: VectorStoreConfig,
  records: VectorRecord[],
  options: ExecuteVectorRequestOptions = {},
): Promise<VectorUpsertResult> {
  const plan = buildVectorUpsertPlan(store, records);
  if (plan.method === "LOCAL") {
    const lanceDbStore = store as LanceDbVectorStoreConfig;
    const upsertBody = plan.body as {
      table: string;
      records: VectorRecord[];
    };
    const key = getLanceDbLocalTableKey(lanceDbStore.path, upsertBody.table);
    const table = await loadLanceDbLocalTable(lanceDbStore.path, upsertBody.table);
    for (const record of upsertBody.records) {
      table.set(record.id, record);
    }
    await persistLanceDbLocalTable(lanceDbStore.path, upsertBody.table, table);
    const snapshotPath = getLanceDbSnapshotPath(lanceDbStore.path, upsertBody.table);
    const snapshotStats = await stat(snapshotPath);
    lanceDbLocalTables.set(key, {
      records: table,
      mtimeMs: snapshotStats.mtimeMs,
      size: snapshotStats.size,
    });
    return { status: "ok" };
  }
  const timeoutMs = normalizeSearchHttpTimeoutMs(options.timeout_ms, "Vector request");
  const fetcher = resolveSearchHttpFetcher(options.fetcher, "Vector request");
  const payload = await executeRemoteVectorPlan(
    plan.target.upsert_target,
    {
      method: "POST",
      headers: plan.headers,
      body: plan.body,
    },
    timeoutMs,
    fetcher,
    "upsert",
  );
  return normalizeQdrantUpsertResponse(payload);
}

export async function executeVectorDelete(
  store: VectorStoreConfig,
  ids: string[],
  options: ExecuteVectorRequestOptions = {},
): Promise<VectorUpsertResult> {
  const plan = buildVectorDeletePlan(store, ids);
  if (plan.method === "LOCAL") {
    const lanceDbStore = store as LanceDbVectorStoreConfig;
    const deleteBody = plan.body as {
      table: string;
      ids: string[];
    };
    const key = getLanceDbLocalTableKey(lanceDbStore.path, deleteBody.table);
    const table = await loadLanceDbLocalTable(lanceDbStore.path, deleteBody.table);
    if (table.size === 0) {
      return { status: "ok" };
    }
    for (const id of deleteBody.ids) {
      table.delete(id);
    }
    await persistLanceDbLocalTable(lanceDbStore.path, deleteBody.table, table);
    if (table.size === 0) {
      lanceDbLocalTables.delete(key);
    } else {
      const snapshotPath = getLanceDbSnapshotPath(lanceDbStore.path, deleteBody.table);
      const snapshotStats = await stat(snapshotPath);
      lanceDbLocalTables.set(key, {
        records: table,
        mtimeMs: snapshotStats.mtimeMs,
        size: snapshotStats.size,
      });
    }
    return { status: "ok" };
  }
  const timeoutMs = normalizeSearchHttpTimeoutMs(options.timeout_ms, "Vector request");
  const fetcher = resolveSearchHttpFetcher(options.fetcher, "Vector request");
  const payload = await executeRemoteVectorPlan(
    resolveQdrantDeleteTarget(plan.target.upsert_target),
    {
      method: "POST",
      headers: plan.headers,
      body: plan.body,
    },
    timeoutMs,
    fetcher,
    "delete",
  );
  return normalizeQdrantUpsertResponse(payload);
}
