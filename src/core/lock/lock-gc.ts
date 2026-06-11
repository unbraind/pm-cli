/**
 * lock-gc.ts — Stale lock file garbage collector.
 *
 * Safety-first policy: if a lock file cannot be read or parsed, it is RETAINED
 * rather than deleted. We only remove locks whose staleness can be conclusively
 * determined from the lock's own embedded `ttl_seconds` field.
 *
 * Staleness formula: (now_ms - Date.parse(created_at)) > ttl_seconds * 1000
 * Zero ttl means any lock older than 0 ms is stale. Negative ttl means always stale.
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface StaleLockScanEntry {
  /** e.g. "pm-abc1.lock" */
  file: string;
  /** parsed id, or null if unparseable */
  id: string | null;
  owner: string | null;
  created_at: string | null;
  ttl_seconds: number | null;
  /** floor((now - created_at)/1000), null if unparseable */
  age_seconds: number | null;
  /** true only when classified expired */
  stale: boolean;
  reason: "expired" | "active" | "unparseable";
}

export interface LockGcHooks {
  onRead?: (lockPath: string) => Promise<string[]> | string[];
  onWrite?: (lockPath: string) => Promise<string[]> | string[];
}

export interface LockGcOptions {
  dryRun: boolean;
  /** epoch ms; defaults to Date.now() — injectable for deterministic tests */
  now?: number;
  hooks?: LockGcHooks;
}

export interface LockGcResult {
  /** number of *.lock files examined */
  scanned: number;
  /** relative paths like "locks/pm-abc1.lock" (removed, or would-remove under dryRun) */
  removed: string[];
  /** relative paths retained (active OR unparseable — never delete what we can't reason about) */
  retained: string[];
  warnings: string[];
  /** one per scanned *.lock file, sorted by file name asc */
  entries: StaleLockScanEntry[];
}

interface ParsedLock {
  id: string;
  owner: string;
  created_at: string;
  ttl_seconds: number;
}

function parseLock(raw: string): ParsedLock | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  const { id, owner, created_at, ttl_seconds } = candidate;
  if (
    typeof id !== "string" ||
    typeof owner !== "string" ||
    typeof created_at !== "string" ||
    typeof ttl_seconds !== "number" ||
    !Number.isFinite(ttl_seconds)
  ) {
    return null;
  }
  return { id, owner, created_at, ttl_seconds };
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

/**
 * Fine-grained classification outcome for one readable lock file's content.
 * `unparseable_json` and `invalid_timestamp` both surface as the coarse
 * `reason: "unparseable"` on the scan entry (gc retains both), but stay
 * distinct here so callers can emit precise warnings.
 */
export type LockClassificationDetail = "active" | "expired" | "unparseable_json" | "invalid_timestamp";

export interface LockContentClassification {
  detail: LockClassificationDetail;
  entry: StaleLockScanEntry;
}

/**
 * Pure classification of one lock file's raw content against `nowMs`. This is
 * the single staleness/parse policy shared by `pm gc --scope locks` (which acts
 * on it) and the `pm health` locks check (which only reports it).
 */
export function classifyLockContent(file: string, raw: string, nowMs: number): LockContentClassification {
  const lock = parseLock(raw);
  if (lock === null) {
    return {
      detail: "unparseable_json",
      entry: {
        file,
        id: null,
        owner: null,
        created_at: null,
        ttl_seconds: null,
        age_seconds: null,
        stale: false,
        reason: "unparseable",
      },
    };
  }
  const createdAtMs = Date.parse(lock.created_at);
  if (!Number.isFinite(createdAtMs)) {
    return {
      detail: "invalid_timestamp",
      entry: {
        file,
        id: lock.id,
        owner: lock.owner,
        created_at: lock.created_at,
        ttl_seconds: lock.ttl_seconds,
        age_seconds: null,
        stale: false,
        reason: "unparseable",
      },
    };
  }
  const ageMs = nowMs - createdAtMs;
  const age_seconds = Math.floor(ageMs / 1000);
  const stale = ageMs > lock.ttl_seconds * 1000;
  return {
    detail: stale ? "expired" : "active",
    entry: {
      file,
      id: lock.id,
      owner: lock.owner,
      created_at: lock.created_at,
      ttl_seconds: lock.ttl_seconds,
      age_seconds,
      stale,
      reason: stale ? "expired" : "active",
    },
  };
}

export interface LockHealthScan {
  /** number of *.lock files examined (ghost files that vanish mid-scan are skipped) */
  scanned: number;
  active_lock_count: number;
  stale_lock_count: number;
  unreadable_lock_count: number;
  /** invalid JSON, wrong shape, or an unparseable created_at timestamp */
  unparseable_lock_count: number;
}

/**
 * Read-only locks scan for `pm health`: classifies every lock file with the
 * same policy `pm gc --scope locks` uses but never removes anything.
 */
export async function scanLockHealth(pmRoot: string, now?: number): Promise<LockHealthScan> {
  const nowMs = now ?? Date.now();
  const locksDir = path.join(pmRoot, "locks");
  const scan: LockHealthScan = {
    scanned: 0,
    active_lock_count: 0,
    stale_lock_count: 0,
    unreadable_lock_count: 0,
    unparseable_lock_count: 0,
  };

  let dirEntries: string[];
  try {
    const rawDir = await fs.readdir(locksDir);
    dirEntries = rawDir.filter((f) => f.endsWith(".lock")).sort();
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      return scan;
    }
    throw error;
  }

  for (const file of dirEntries) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(locksDir, file), "utf8");
    } catch (readError: unknown) {
      if (isErrno(readError, "ENOENT")) {
        // Disappeared between readdir and readFile — treat as a ghost; skip quietly.
        continue;
      }
      scan.scanned += 1;
      scan.unreadable_lock_count += 1;
      continue;
    }
    scan.scanned += 1;
    const { detail } = classifyLockContent(file, raw, nowMs);
    if (detail === "active") {
      scan.active_lock_count += 1;
    } else if (detail === "expired") {
      scan.stale_lock_count += 1;
    } else {
      scan.unparseable_lock_count += 1;
    }
  }

  return scan;
}

export async function runLockGc(pmRoot: string, options: LockGcOptions): Promise<LockGcResult> {
  const { dryRun, hooks } = options;
  const nowMs = options.now ?? Date.now();
  const locksDir = path.join(pmRoot, "locks");

  const result: LockGcResult = {
    scanned: 0,
    removed: [],
    retained: [],
    warnings: [],
    entries: [],
  };

  let dirEntries: string[];
  try {
    const raw = await fs.readdir(locksDir);
    dirEntries = raw.filter((f) => f.endsWith(".lock")).sort();
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      return result;
    }
    throw error;
  }

  for (const file of dirEntries) {
    result.scanned += 1;
    const absPath = path.join(locksDir, file);
    const relPath = `locks/${file}`;

    // --- onRead hook ---
    if (hooks?.onRead) {
      const hookWarnings = await hooks.onRead(absPath);
      result.warnings.push(...hookWarnings);
    }

    // --- read file ---
    let raw: string;
    try {
      raw = await fs.readFile(absPath, "utf8");
    } catch (readError: unknown) {
      if (isErrno(readError, "ENOENT")) {
        // Disappeared between readdir and readFile — treat as a ghost; skip quietly.
        result.scanned -= 1;
        continue;
      }
      result.warnings.push(`lock_unreadable:${file}`);
      result.retained.push(relPath);
      result.entries.push({
        file,
        id: null,
        owner: null,
        created_at: null,
        ttl_seconds: null,
        age_seconds: null,
        stale: false,
        reason: "unparseable",
      });
      continue;
    }

    // --- classify (shared with the read-only pm health locks scan) ---
    const classified = classifyLockContent(file, raw, nowMs);
    if (classified.detail === "unparseable_json") {
      result.warnings.push(`lock_unparseable:${file}`);
      result.retained.push(relPath);
      result.entries.push(classified.entry);
      continue;
    }
    if (classified.detail === "invalid_timestamp") {
      result.warnings.push(`lock_invalid_timestamp:${file}`);
      result.retained.push(relPath);
      result.entries.push(classified.entry);
      continue;
    }
    if (classified.detail === "active") {
      result.retained.push(relPath);
      result.entries.push(classified.entry);
      continue;
    }

    // --- stale: remove or preview ---
    if (!dryRun) {
      try {
        await fs.unlink(absPath);
      } catch (unlinkError: unknown) {
        if (!isErrno(unlinkError, "ENOENT")) {
          result.warnings.push(`lock_remove_failed:${file}`);
          result.retained.push(relPath);
          result.entries.push(classified.entry);
          continue;
        }
        // ENOENT on unlink = already gone (race); treat as removed
      }
      // onWrite hook after successful removal
      if (hooks?.onWrite) {
        const hookWarnings = await hooks.onWrite(absPath);
        result.warnings.push(...hookWarnings);
      }
    }

    result.removed.push(relPath);
    result.entries.push(classified.entry);
  }

  return result;
}
