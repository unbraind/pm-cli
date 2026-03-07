import type { PmSettings } from "../../types/index.js";

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

export interface VectorHttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type VectorRequestFetcher = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<VectorHttpResponse>;

export interface ExecuteVectorRequestOptions {
  timeout_ms?: number;
  fetcher?: VectorRequestFetcher;
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
const DEFAULT_VECTOR_TIMEOUT_MS = 30_000;
const lanceDbLocalTables = new Map<string, Map<string, VectorRecord>>();

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function trimTrailingSlashes(value: string): string {
  return value.replaceAll(/\/+$/g, "");
}

function isFiniteNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

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

function resolveVectorFetcher(fetcher: VectorRequestFetcher | undefined): VectorRequestFetcher {
  if (fetcher) {
    return fetcher;
  }
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis) as unknown as VectorRequestFetcher;
  }
  throw new Error("Vector request execution requires a fetch implementation");
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? DEFAULT_VECTOR_TIMEOUT_MS;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error("Vector request timeout must be a positive finite number");
  }
  return Math.floor(resolved);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message.length > 0 ? message : error.name;
  }
  return String(error);
}

async function readFailedResponseBody(response: VectorHttpResponse): Promise<string> {
  try {
    return (await response.text()).replaceAll(/\s+/g, " ").trim();
  } catch (error) {
    return `(failed to read response body: ${toErrorMessage(error)})`;
  }
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
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    let response: VectorHttpResponse;
    try {
      response = await fetcher(endpoint, {
        method: plan.method,
        headers: plan.headers,
        body: JSON.stringify(plan.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Vector ${requestKind} request timed out after ${timeoutMs}ms`);
      }
      throw new Error(`Vector ${requestKind} request execution failed: ${toErrorMessage(error)}`);
    }

    if (!response.ok) {
      const responseBody = await readFailedResponseBody(response);
      const detail = responseBody.length > 0 ? `: ${responseBody}` : "";
      throw new Error(`Vector ${requestKind} request failed with status ${response.status} ${response.statusText}${detail}`);
    }

    try {
      return await response.json();
    } catch (error) {
      throw new Error(`Vector ${requestKind} response JSON parse failed: ${toErrorMessage(error)}`);
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
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
  return `${storePath}::${table}`;
}

function dotProduct(left: number[], right: number[]): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += left[index] * right[index];
  }
  return total;
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
    const key = getLanceDbLocalTableKey(lanceDbStore.path, queryBody.table);
    const table = lanceDbLocalTables.get(key);
    if (!table) {
      return [];
    }
    const queryVector = normalizeVector(queryBody.vector);
    const queryLimit = normalizeLimit(queryBody.limit);
    const hits: VectorQueryHit[] = [];
    for (const record of table.values()) {
      if (record.vector.length !== queryVector.length) {
        throw new Error(
          `LanceDB local vector record '${record.id}' dimension mismatch: expected ${queryVector.length}, received ${record.vector.length}`,
        );
      }
      hits.push({
        id: record.id,
        score: dotProduct(queryVector, record.vector),
        ...(record.payload ? { payload: record.payload } : {}),
      });
    }
    hits.sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.id.localeCompare(right.id);
    });
    return hits.slice(0, queryLimit);
  }
  const timeoutMs = normalizeTimeoutMs(options.timeout_ms);
  const fetcher = resolveVectorFetcher(options.fetcher);
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
    const table = lanceDbLocalTables.get(key) ?? new Map<string, VectorRecord>();
    for (const record of upsertBody.records) {
      table.set(record.id, record);
    }
    lanceDbLocalTables.set(key, table);
    return { status: "ok" };
  }
  const timeoutMs = normalizeTimeoutMs(options.timeout_ms);
  const fetcher = resolveVectorFetcher(options.fetcher);
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
    const table = lanceDbLocalTables.get(key);
    if (!table) {
      return { status: "ok" };
    }
    for (const id of deleteBody.ids) {
      table.delete(id);
    }
    if (table.size === 0) {
      lanceDbLocalTables.delete(key);
    } else {
      lanceDbLocalTables.set(key, table);
    }
    return { status: "ok" };
  }
  const timeoutMs = normalizeTimeoutMs(options.timeout_ms);
  const fetcher = resolveVectorFetcher(options.fetcher);
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
