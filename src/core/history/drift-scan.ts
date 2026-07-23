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
import { writeFileAtomic } from "../fs/fs-utils.js";
import { hashDocument } from "./history.js";
import { verifyHistoryChain } from "./replay.js";
import {
  getWorkspaceHistoryPath,
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
  /** Value that configures or reports drifted items for this contract. */
  driftedItems: string[];
}

const DRIFT_CACHE_VERSION = 3;
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
}

interface DriftCacheEnvelope {
  version: number;
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
      typeof parsed.entries !== "object" ||
      parsed.entries === null
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

interface StreamVerification {
  latestAfterHash: string;
  chainOk: boolean;
  contentHash: string;
}

interface DriftScanAccumulator {
  missingStreams: string[];
  unreadableStreams: string[];
  hashMismatches: string[];
  chainMismatches: string[];
}

async function scanWorkspaceHistory(
  pmRoot: string,
  accumulator: DriftScanAccumulator,
): Promise<void> {
  try {
    const verification = await verifyHistoryStream(
      getWorkspaceHistoryPath(pmRoot),
    );
    if (verification && !verification.chainOk) {
      accumulator.chainMismatches.push(WORKSPACE_HISTORY_ID);
    }
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) {
      accumulator.unreadableStreams.push(WORKSPACE_HISTORY_ID);
    }
  }
}

function hashContent(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function readHistoryContentHash(historyPath: string): Promise<string> {
  const raw = await fs.readFile(historyPath, "utf8");
  return hashContent(raw);
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
  return {
    latestAfterHash,
    chainOk: verifyHistoryChain(entries).ok,
    contentHash,
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
  let currentContentHash: string;
  if (params.verifyCacheHitByContent) {
    try {
      currentContentHash = await readHistoryContentHash(params.historyPath);
    } catch {
      params.accumulator.unreadableStreams.push(params.itemId);
      return { verification: null, cacheDirty: false };
    }
  } else {
    currentContentHash = cachedContentHash;
  }
  if (
    !params.verifyCacheHitByContent ||
    currentContentHash === cachedContentHash
  ) {
    return {
      verification: {
        latestAfterHash: params.cached.latest_after_hash,
        chainOk: params.cached.chain_ok,
        contentHash: currentContentHash,
      },
      cacheDirty: false,
    };
  }
  return {
    verification: await loadFreshStreamVerification(
      params.itemId,
      params.historyPath,
      params.accumulator,
    ),
    cacheDirty: true,
  };
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
  };

  const cache = await loadDriftCache(pmRoot);
  const previousEntries: Record<string, DriftCacheEntry> = cache?.entries ?? {};
  const nextEntries: Record<string, DriftCacheEntry> = {};
  let cacheDirty = false;
  // Metadata mode does not open a stat-matched stream, so unreadable-after-stat
  // failures are intentionally deferred to strict validate/history-repair scans.
  const verifyCacheHitByContent = options.cacheHitVerification !== "metadata";

  for (const item of items) {
    const historyPath = getHistoryPath(pmRoot, item.id);

    let stat: Stats;
    try {
      stat = await fs.stat(historyPath);
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) {
        accumulator.missingStreams.push(item.id);
      } else {
        accumulator.unreadableStreams.push(item.id);
      }
      continue;
    }

    const cached = previousEntries[item.id];
    const resolved = await resolveStreamVerification({
      itemId: item.id,
      historyPath,
      stat,
      cached,
      verifyCacheHitByContent,
      accumulator,
    });
    cacheDirty ||= resolved.cacheDirty;
    if (!resolved.verification) {
      continue;
    }

    if (!resolved.verification.chainOk) {
      accumulator.chainMismatches.push(item.id);
    }
    nextEntries[item.id] = {
      mtime_ms: stat.mtimeMs,
      ctime_ms: stat.ctimeMs,
      size: stat.size,
      content_hash: resolved.verification.contentHash,
      latest_after_hash: resolved.verification.latestAfterHash,
      chain_ok: resolved.verification.chainOk,
    };

    const { body, ...itemMetadata } = item;
    const currentHash = hashDocument({
      metadata: itemMetadata as ItemMetadata,
      body,
    });
    if (currentHash !== resolved.verification.latestAfterHash) {
      accumulator.hashMismatches.push(item.id);
    }
  }
  await scanWorkspaceHistory(pmRoot, accumulator);

  if (
    cacheDirty ||
    Object.keys(previousEntries).length !== Object.keys(nextEntries).length
  ) {
    const cachePath = getDriftCachePath(pmRoot);
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await writeFileAtomic(
        cachePath,
        JSON.stringify({ version: DRIFT_CACHE_VERSION, entries: nextEntries }),
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
    ]),
  ].sort((a, b) => a.localeCompare(b));
  return { ...accumulator, driftedItems };
}
