/**
 * @module core/history/drift-scan
 *
 * Implements append-only history and replay behavior for Drift Scan.
 */
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { getHistoryPath } from "../store/paths.js";
import { isFileMissingError, writeFileAtomic } from "../fs/fs-utils.js";
import {
  CURRENT_HISTORY_ITEM_HASH_VERSION,
  SUPPORTED_HISTORY_ITEM_HASH_VERSIONS,
  hashDocumentForVersion,
  type HistoryItemHashVersion,
} from "./history.js";
import { verifyHistoryChainWithVersion } from "./replay.js";
import {
  getWorkspaceHistoryPath,
  inspectWorkspaceHistoryState,
  WORKSPACE_HISTORY_ID,
} from "./workspace-history.js";
import type { HistoryEntry, ItemMetadata } from "../../types/index.js";

/** Documents the drift scan result payload exchanged by command, SDK, and package integrations. */
export interface DriftScanResult {
  /** Value that configures or reports missing streams for this contract. */
  missingStreams: string[];
  /** Value that configures or reports unreadable streams for this contract. */
  unreadableStreams: string[];
  /** Value that configures or reports hash mismatches for this contract. */
  hashMismatches: string[];
  /** Value that configures or reports chain mismatches for this contract. */
  chainMismatches: string[];
  /** Streams written with a hash capability newer than this runtime understands. */
  versionSkews: string[];
  /** Value that configures or reports drifted items for this contract. */
  driftedItems: string[];
  /** Governed singleton files whose JSON differs from workspace-history replay. */
  workspaceStateMismatches: string[];
  /** Governed singleton files absent from disk. */
  workspaceStateMissing: string[];
  /** Governed singleton files unreadable as safe workspace-local JSON. */
  workspaceStateUnreadable: string[];
}

const DRIFT_CACHE_VERSION = 6;
const DRIFT_CACHE_FILENAME = "history-drift-cache.json";

/** Controls how cached history stream verification is trusted when the file stat tuple still matches a previous scan. */
export type DriftCacheHitVerification = "content_hash" | "metadata";

/** Documents the history drift scan options shared by health, validate, and repair callers. */
export interface DriftScanOptions {
  /** Value that configures or reports cache hit verification for this contract. */
  cacheHitVerification?: DriftCacheHitVerification;
}

interface DriftCacheEntry {
  mtime_ms: number;
  ctime_ms: number;
  size: number;
  content_hash: string;
  latest_after_hash: string;
  chain_ok: boolean;
  version_skew?: boolean;
  latest_hash_comparable: boolean;
  item_hash_version: HistoryItemHashVersion;
}

interface DriftCacheEnvelope {
  version: number;
  history_item_hash_version: HistoryItemHashVersion;
  entries: Record<string, DriftCacheEntry>;
}

function getDriftCachePath(pmRoot: string): string {
  return path.join(pmRoot, "runtime", DRIFT_CACHE_FILENAME);
}

async function loadDriftCache(
  pmRoot: string,
): Promise<DriftCacheEnvelope | null> {
  try {
    const raw = await fs.readFile(getDriftCachePath(pmRoot), "utf8");
    const parsed = JSON.parse(raw) as DriftCacheEnvelope;
    if (
      parsed.version !== DRIFT_CACHE_VERSION ||
      parsed.history_item_hash_version !== CURRENT_HISTORY_ITEM_HASH_VERSION ||
      typeof parsed.entries !== "object" ||
      parsed.entries === null ||
      Object.values(parsed.entries).some(
        (entry) =>
          typeof entry.chain_ok !== "boolean" ||
          typeof entry.latest_hash_comparable !== "boolean" ||
          (!(
            SUPPORTED_HISTORY_ITEM_HASH_VERSIONS as readonly number[]
          ).includes(entry.item_hash_version) &&
            entry.version_skew !== true),
      )
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

interface StreamVerification {
  latestAfterHash: string;
  chainOk: boolean;
  versionSkew: boolean;
  latestHashComparable: boolean;
  contentHash: string;
  itemHashVersion: HistoryItemHashVersion;
}

interface DriftScanAccumulator {
  missingStreams: string[];
  unreadableStreams: string[];
  hashMismatches: string[];
  chainMismatches: string[];
  versionSkews: string[];
  workspaceStateMismatches: string[];
  workspaceStateMissing: string[];
  workspaceStateUnreadable: string[];
}

interface DriftScanCacheState {
  previousEntries: Record<string, DriftCacheEntry>;
  nextEntries: Record<string, DriftCacheEntry>;
  verifyCacheHitByContent: boolean;
}

async function scanWorkspaceHistory(
  pmRoot: string,
  previousEntries: Record<string, DriftCacheEntry>,
  nextEntries: Record<string, DriftCacheEntry>,
  verifyCacheHitByContent: boolean,
  accumulator: DriftScanAccumulator,
): Promise<boolean> {
  const historyPath = getWorkspaceHistoryPath(pmRoot);
  let stat: Stats;
  try {
    stat = await fs.stat(historyPath);
  } catch (error: unknown) {
    if (isFileMissingError(error)) return false;
    accumulator.unreadableStreams.push(WORKSPACE_HISTORY_ID);
    return false;
  }
  const missingCount = accumulator.missingStreams.length;
  const resolved = await resolveStreamVerification({
    itemId: WORKSPACE_HISTORY_ID,
    historyPath,
    stat,
    cached: previousEntries[WORKSPACE_HISTORY_ID],
    verifyCacheHitByContent,
    accumulator,
  });
  if (!resolved.verification) {
    accumulator.missingStreams.splice(missingCount);
    return resolved.cacheDirty;
  }
  if (resolved.verification.versionSkew) {
    accumulator.versionSkews.push(WORKSPACE_HISTORY_ID);
  }
  if (!resolved.verification.chainOk) {
    accumulator.chainMismatches.push(WORKSPACE_HISTORY_ID);
  }
  nextEntries[WORKSPACE_HISTORY_ID] = {
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
    size: stat.size,
    content_hash: resolved.verification.contentHash,
    latest_after_hash: resolved.verification.latestAfterHash,
    chain_ok: resolved.verification.chainOk,
    version_skew: resolved.verification.versionSkew,
    latest_hash_comparable: resolved.verification.latestHashComparable,
    item_hash_version: resolved.verification.itemHashVersion,
  };
  return resolved.cacheDirty;
}

function hashContent(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Read and fully verify one history stream's hash chain. Returns null for an empty/missing stream (caller records it as a missing stream). */
async function verifyHistoryStream(
  historyPath: string,
): Promise<StreamVerification | null> {
  const raw = await fs.readFile(historyPath, "utf8");
  const contentHash = hashContent(raw);
  if (raw.trim().length === 0) {
    return null;
  }
  const entries: HistoryEntry[] = [];
  let latestAfterHash: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parsed = JSON.parse(trimmed) as HistoryEntry;
    if (
      typeof parsed.after_hash !== "string" ||
      parsed.after_hash.trim().length === 0
    ) {
      throw new Error("missing after_hash");
    }
    entries.push(parsed);
    latestAfterHash = parsed.after_hash;
  }
  /* c8 ignore start -- defensive guard for future history schema changes. */
  if (!latestAfterHash) {
    return null;
  }
  /* c8 ignore stop */
  const verification = verifyHistoryChainWithVersion(entries);
  const versionSkew = entries.some(
    (entry) =>
      entry.item_hash_version !== undefined &&
      !(SUPPORTED_HISTORY_ITEM_HASH_VERSIONS as readonly number[]).includes(
        entry.item_hash_version,
      ),
  );
  const latestEntry = entries[entries.length - 1];
  const latestExplicitVersion = latestEntry.item_hash_version;
  const latestExplicitVersionSupported =
    latestExplicitVersion !== undefined &&
    (SUPPORTED_HISTORY_ITEM_HASH_VERSIONS as readonly number[]).includes(
      latestExplicitVersion,
    );
  const latestHashVersion = latestExplicitVersionSupported
    ? (latestExplicitVersion as HistoryItemHashVersion)
    : verification.item_hash_version;
  return {
    latestAfterHash,
    chainOk: verification.ok,
    versionSkew,
    latestHashComparable:
      latestHashVersion !== undefined &&
      (!versionSkew || latestExplicitVersionSupported),
    contentHash,
    itemHashVersion: latestHashVersion ?? CURRENT_HISTORY_ITEM_HASH_VERSION,
  };
}

function cacheMetadataMatches(
  cached: DriftCacheEntry | undefined,
  stat: Stats,
): boolean {
  return (
    cached !== undefined &&
    cached.mtime_ms === stat.mtimeMs &&
    cached.ctime_ms === stat.ctimeMs &&
    cached.size === stat.size
  );
}

async function loadFreshStreamVerification(
  itemId: string,
  historyPath: string,
  accumulator: DriftScanAccumulator,
): Promise<StreamVerification | null> {
  try {
    const loaded = await verifyHistoryStream(historyPath);
    if (!loaded) {
      accumulator.missingStreams.push(itemId);
      return null;
    }
    return loaded;
  } catch {
    accumulator.unreadableStreams.push(itemId);
    return null;
  }
}

async function resolveStreamVerification(params: {
  itemId: string;
  historyPath: string;
  stat: Stats;
  cached: DriftCacheEntry | undefined;
  verifyCacheHitByContent: boolean;
  accumulator: DriftScanAccumulator;
}): Promise<{ verification: StreamVerification | null; cacheDirty: boolean }> {
  const cachedContentHash =
    typeof params.cached?.content_hash === "string" &&
    params.cached.content_hash.length > 0
      ? params.cached.content_hash
      : undefined;
  const canUseCache =
    cacheMetadataMatches(params.cached, params.stat) &&
    cachedContentHash !== undefined &&
    params.cached !== undefined;
  if (!canUseCache || !params.cached) {
    return {
      verification: await loadFreshStreamVerification(
        params.itemId,
        params.historyPath,
        params.accumulator,
      ),
      cacheDirty: true,
    };
  }
  if (params.verifyCacheHitByContent) {
    const verification = await loadFreshStreamVerification(
      params.itemId,
      params.historyPath,
      params.accumulator,
    );
    return {
      verification,
      cacheDirty:
        verification === null ||
        verification.contentHash !== cachedContentHash ||
        verification.latestAfterHash !== params.cached.latest_after_hash ||
        verification.chainOk !== params.cached.chain_ok ||
        verification.versionSkew !== (params.cached.version_skew === true) ||
        verification.latestHashComparable !==
          params.cached.latest_hash_comparable ||
        verification.itemHashVersion !== params.cached.item_hash_version,
    };
  }
  return {
    verification: {
      latestAfterHash: params.cached.latest_after_hash,
      chainOk: params.cached.chain_ok,
      versionSkew: params.cached.version_skew === true,
      latestHashComparable:
        params.cached.latest_hash_comparable &&
        (SUPPORTED_HISTORY_ITEM_HASH_VERSIONS as readonly number[]).includes(
          params.cached.item_hash_version,
        ),
      contentHash: cachedContentHash,
      itemHashVersion: params.cached.item_hash_version,
    },
    cacheDirty: false,
  };
}

/** Scan one item stream and return whether its cache entry needs persistence. */
async function scanItemHistory(
  pmRoot: string,
  item: ItemMetadata & { body: string },
  cache: DriftScanCacheState,
  accumulator: DriftScanAccumulator,
): Promise<boolean> {
  const historyPath = getHistoryPath(pmRoot, item.id);
  let stat: Stats;
  try {
    stat = await fs.stat(historyPath);
  } catch (error: unknown) {
    (isFileMissingError(error)
      ? accumulator.missingStreams
      : accumulator.unreadableStreams
    ).push(item.id);
    return false;
  }
  const resolved = await resolveStreamVerification({
    itemId: item.id,
    historyPath,
    stat,
    cached: cache.previousEntries[item.id],
    verifyCacheHitByContent: cache.verifyCacheHitByContent,
    accumulator,
  });
  if (!resolved.verification) return resolved.cacheDirty;
  if (resolved.verification.versionSkew) {
    accumulator.versionSkews.push(item.id);
  }
  if (!resolved.verification.chainOk) {
    accumulator.chainMismatches.push(item.id);
  }
  cache.nextEntries[item.id] = {
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
    size: stat.size,
    content_hash: resolved.verification.contentHash,
    latest_after_hash: resolved.verification.latestAfterHash,
    chain_ok: resolved.verification.chainOk,
    version_skew: resolved.verification.versionSkew,
    latest_hash_comparable: resolved.verification.latestHashComparable,
    item_hash_version: resolved.verification.itemHashVersion,
  };
  const { body, ...itemMetadata } = item;
  if (!resolved.verification.latestHashComparable) return resolved.cacheDirty;
  const currentHash = hashDocumentForVersion(
    { metadata: itemMetadata as ItemMetadata, body },
    resolved.verification.itemHashVersion,
  );
  if (currentHash !== resolved.verification.latestAfterHash)
    accumulator.hashMismatches.push(item.id);
  return resolved.cacheDirty;
}

/** Compare the verified workspace stream with every governed singleton file. */
async function scanWorkspaceStateAgreement(
  pmRoot: string,
  accumulator: DriftScanAccumulator,
): Promise<void> {
  if (
    accumulator.unreadableStreams.includes(WORKSPACE_HISTORY_ID) ||
    accumulator.chainMismatches.includes(WORKSPACE_HISTORY_ID) ||
    accumulator.versionSkews.includes(WORKSPACE_HISTORY_ID)
  )
    return;
  try {
    const agreement = await inspectWorkspaceHistoryState(pmRoot);
    accumulator.workspaceStateMismatches.push(
      ...agreement.mismatched_documents,
    );
    accumulator.workspaceStateMissing.push(...agreement.missing_documents);
    accumulator.workspaceStateUnreadable.push(
      ...agreement.unreadable_documents,
    );
  } catch {
    accumulator.unreadableStreams.push(WORKSPACE_HISTORY_ID);
  }
}

/**
 * Scan every item's history stream for drift (missing/unreadable streams, broken
 * hash chains, and item/history hash mismatches).
 *
 * Full chain re-verification of a large history tree is the dominant cost of
 * `pm health`. We cache the per-stream verification keyed by the history file's
 * mtime/ctime/size plus content hash. Strict callers keep recomputing the
 * content hash on metadata hits; latency-sensitive health checks can opt into
 * trusting the stat tuple and skip rereading unchanged streams.
 */
export async function scanHistoryDrift(
  pmRoot: string,
  items: Array<ItemMetadata & { body: string }>,
  options: DriftScanOptions = {},
): Promise<DriftScanResult> {
  const accumulator: DriftScanAccumulator = {
    missingStreams: [],
    unreadableStreams: [],
    hashMismatches: [],
    chainMismatches: [],
    versionSkews: [],
    workspaceStateMismatches: [],
    workspaceStateMissing: [],
    workspaceStateUnreadable: [],
  };

  const cache = await loadDriftCache(pmRoot);
  const previousEntries: Record<string, DriftCacheEntry> = cache?.entries ?? {};
  const nextEntries: Record<string, DriftCacheEntry> = {};
  let cacheDirty = false;
  // Metadata mode does not open a stat-matched stream, so unreadable-after-stat
  // failures are intentionally deferred to strict validate/history-repair scans.
  const verifyCacheHitByContent = options.cacheHitVerification !== "metadata";

  const cacheState: DriftScanCacheState = {
    previousEntries,
    nextEntries,
    verifyCacheHitByContent,
  };
  for (const item of items) {
    if (await scanItemHistory(pmRoot, item, cacheState, accumulator))
      cacheDirty = true;
  }
  const workspaceCacheDirty = await scanWorkspaceHistory(
    pmRoot,
    previousEntries,
    nextEntries,
    verifyCacheHitByContent,
    accumulator,
  );
  cacheDirty ||= workspaceCacheDirty;
  await scanWorkspaceStateAgreement(pmRoot, accumulator);

  if (
    cacheDirty ||
    Object.keys(previousEntries).length !== Object.keys(nextEntries).length
  ) {
    const cachePath = getDriftCachePath(pmRoot);
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await writeFileAtomic(
        cachePath,
        JSON.stringify({
          version: DRIFT_CACHE_VERSION,
          history_item_hash_version: CURRENT_HISTORY_ITEM_HASH_VERSION,
          entries: nextEntries,
        }),
      );
    } catch {
      // Best-effort cache write: a failed persist must never fail a health scan.
    }
  }

  const driftedItems = [
    ...new Set([
      ...accumulator.missingStreams,
      ...accumulator.unreadableStreams,
      ...accumulator.hashMismatches,
      ...accumulator.chainMismatches,
      ...accumulator.versionSkews,
      ...(accumulator.workspaceStateMismatches.length > 0 ||
      accumulator.workspaceStateMissing.length > 0 ||
      accumulator.workspaceStateUnreadable.length > 0
        ? [WORKSPACE_HISTORY_ID]
        : []),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  return { ...accumulator, driftedItems };
}
