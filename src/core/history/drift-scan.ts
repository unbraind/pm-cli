/**
 * @module core/history/drift-scan
 *
 * Implements append-only history and replay behavior for Drift Scan.
 */
import fs from "fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { getHistoryPath } from "../store/paths.js";
import { writeFileAtomic } from "../fs/fs-utils.js";
import { hashDocument } from "./history.js";
import { verifyHistoryChain } from "./replay.js";
import type { HistoryEntry, ItemMetadata } from "../../types/index.js";

/**
 * Documents the drift scan result payload exchanged by command, SDK, and package integrations.
 */
export interface DriftScanResult {
  missingStreams: string[];
  unreadableStreams: string[];
  hashMismatches: string[];
  chainMismatches: string[];
  driftedItems: string[];
}

const DRIFT_CACHE_VERSION = 3;
const DRIFT_CACHE_FILENAME = "history-drift-cache.json";

/**
 * Controls how cached history stream verification is trusted when the file stat
 * tuple still matches a previous scan.
 */
export type DriftCacheHitVerification = "content_hash" | "metadata";

/**
 * Documents the history drift scan options shared by health, validate, and
 * repair callers.
 */
export interface DriftScanOptions {
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

async function loadDriftCache(pmRoot: string): Promise<DriftCacheEnvelope | null> {
  try {
    const raw = await fs.readFile(getDriftCachePath(pmRoot), "utf8");
    const parsed = JSON.parse(raw) as DriftCacheEnvelope;
    if (parsed.version !== DRIFT_CACHE_VERSION || typeof parsed.entries !== "object" || parsed.entries === null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}

interface StreamVerification {
  latestAfterHash: string;
  chainOk: boolean;
  contentHash: string;
}

function hashContent(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function readHistoryContentHash(historyPath: string): Promise<string> {
  const raw = await fs.readFile(historyPath, "utf8");
  return hashContent(raw);
}

/**
 * Read and fully verify one history stream's hash chain. Returns null for an
 * empty/missing stream (caller records it as a missing stream).
 */
async function verifyHistoryStream(historyPath: string): Promise<StreamVerification | null> {
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
    if (typeof parsed.after_hash !== "string" || parsed.after_hash.trim().length === 0) {
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
  const missingStreams: string[] = [];
  const unreadableStreams: string[] = [];
  const hashMismatches: string[] = [];
  const chainMismatches: string[] = [];

  const cache = await loadDriftCache(pmRoot);
  const previousEntries: Record<string, DriftCacheEntry> = cache?.entries ?? {};
  const nextEntries: Record<string, DriftCacheEntry> = {};
  let cacheDirty = false;
  const verifyCacheHitByContent = options.cacheHitVerification !== "metadata";

  for (const item of items) {
    const historyPath = getHistoryPath(pmRoot, item.id);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(historyPath);
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) {
        missingStreams.push(item.id);
      } else {
        unreadableStreams.push(item.id);
      }
      continue;
    }

    const loadStreamVerification = async (): Promise<StreamVerification | null | "unreadable"> => {
      try {
        return await verifyHistoryStream(historyPath);
      } catch {
        return "unreadable";
      }
    };

    const loadFreshVerification = async (): Promise<StreamVerification | null> => {
      const loaded = await loadStreamVerification();
      if (loaded === "unreadable") {
        unreadableStreams.push(item.id);
        return null;
      }
      if (!loaded) {
        missingStreams.push(item.id);
        return null;
      }
      return loaded;
    };

    const cached = previousEntries[item.id];
    let verification: StreamVerification;
    const metadataMatchesCache =
      cached !== undefined &&
      cached.mtime_ms === stat.mtimeMs &&
      cached.ctime_ms === stat.ctimeMs &&
      cached.size === stat.size;
    const cachedContentHash =
      typeof cached?.content_hash === "string" && cached.content_hash.length > 0 ? cached.content_hash : undefined;
    const canUseCache = metadataMatchesCache && cachedContentHash !== undefined;
    if (canUseCache && cached) {
      let currentContentHash: string;
      if (verifyCacheHitByContent) {
        try {
          currentContentHash = await readHistoryContentHash(historyPath);
        } catch {
          unreadableStreams.push(item.id);
          continue;
        }
      } else {
        currentContentHash = cachedContentHash;
      }
      if (!verifyCacheHitByContent || currentContentHash === cachedContentHash) {
        verification = {
          latestAfterHash: cached.latest_after_hash,
          chainOk: cached.chain_ok,
          contentHash: currentContentHash,
        };
      } else {
        cacheDirty = true;
        const refreshed = await loadFreshVerification();
        if (!refreshed) {
          continue;
        }
        verification = refreshed;
      }
    } else {
      cacheDirty = true;
      const refreshed = await loadFreshVerification();
      if (!refreshed) {
        continue;
      }
      verification = refreshed;
    }

    if (!verification.chainOk) {
      chainMismatches.push(item.id);
    }
    nextEntries[item.id] = {
      mtime_ms: stat.mtimeMs,
      ctime_ms: stat.ctimeMs,
      size: stat.size,
      content_hash: verification.contentHash,
      latest_after_hash: verification.latestAfterHash,
      chain_ok: verification.chainOk,
    };

    const { body, ...frontMatter } = item;
    const currentHash = hashDocument({
      metadata: frontMatter as ItemMetadata,
      body,
    });
    if (currentHash !== verification.latestAfterHash) {
      hashMismatches.push(item.id);
    }
  }

  if (cacheDirty || Object.keys(previousEntries).length !== Object.keys(nextEntries).length) {
    const cachePath = getDriftCachePath(pmRoot);
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await writeFileAtomic(cachePath, JSON.stringify({ version: DRIFT_CACHE_VERSION, entries: nextEntries }));
    } catch {
      // Best-effort cache write: a failed persist must never fail a health scan.
    }
  }

  const driftedItems = [...new Set([...missingStreams, ...unreadableStreams, ...hashMismatches, ...chainMismatches])].sort((a, b) =>
    a.localeCompare(b),
  );
  return { missingStreams, unreadableStreams, hashMismatches, chainMismatches, driftedItems };
}
