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

    // --- parse ---
    const lock = parseLock(raw);
    if (lock === null) {
      result.warnings.push(`lock_unparseable:${file}`);
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

    // --- validate timestamp ---
    const createdAtMs = Date.parse(lock.created_at);
    if (!Number.isFinite(createdAtMs)) {
      result.warnings.push(`lock_invalid_timestamp:${file}`);
      result.retained.push(relPath);
      result.entries.push({
        file,
        id: lock.id,
        owner: lock.owner,
        created_at: lock.created_at,
        ttl_seconds: lock.ttl_seconds,
        age_seconds: null,
        stale: false,
        reason: "unparseable",
      });
      continue;
    }

    const ageMs = nowMs - createdAtMs;
    const age_seconds = Math.floor(ageMs / 1000);
    const stale = ageMs > lock.ttl_seconds * 1000;

    if (!stale) {
      result.retained.push(relPath);
      result.entries.push({
        file,
        id: lock.id,
        owner: lock.owner,
        created_at: lock.created_at,
        ttl_seconds: lock.ttl_seconds,
        age_seconds,
        stale: false,
        reason: "active",
      });
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
          result.entries.push({
            file,
            id: lock.id,
            owner: lock.owner,
            created_at: lock.created_at,
            ttl_seconds: lock.ttl_seconds,
            age_seconds,
            stale: true,
            reason: "expired",
          });
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
    result.entries.push({
      file,
      id: lock.id,
      owner: lock.owner,
      created_at: lock.created_at,
      ttl_seconds: lock.ttl_seconds,
      age_seconds,
      stale: true,
      reason: "expired",
    });
  }

  return result;
}
