/**
 * lock-gc.ts — Stale lock file garbage collector.
 *
 * Safety-first policy: if a lock file cannot be read or parsed, it is RETAINED
 * rather than deleted. We only remove locks whose staleness can be conclusively
 * determined from the embedded lease or positive same-host owner-death evidence.
 * Deletion is revalidated under the writer cleanup gate.
 *
 * Staleness formula: (now_ms - Date.parse(created_at)) > ttl_seconds * 1000
 * Zero ttl means any lock older than 0 ms is stale. Negative ttl means always stale.
 */

import { inspectLockOwner, type LockOwnerIdentity } from "./lock-owner.js";
import { acquireStaleCleanupGate, recordDeadLockRecovery } from "./lock.js";
import { isFileMissingError } from "../fs/fs-utils.js";
import fs from "node:fs/promises";
import path from "node:path";

/** Documents the stale lock scan entry payload exchanged by command, SDK, and package integrations. */
export interface StaleLockScanEntry {
  /** e.g. "pm-abc1.lock" */
  file: string;
  /** parsed id, or null if unparseable */
  id: string | null;
  /** Value that configures or reports owner for this contract. */
  owner: string | null;
  /** ISO 8601 timestamp recording when created occurred. */
  created_at: string | null;
  /** Value that configures or reports ttl seconds for this contract. */
  ttl_seconds: number | null;
  /** floor((now - created_at)/1000), null if unparseable */
  age_seconds: number | null;
  /** True only when lease expiry or positive original-owner death is established. */
  stale: boolean;
  /** Value that configures or reports reason for this contract. */
  reason: "expired" | "owner_dead" | "active" | "unparseable";
  /** Verified original-process liveness, when the receipt supports same-host observation. */
  owner_state?: "alive" | "dead" | "unknown";
  /** Valid recorded PID, available for diagnosis without revealing host coordinates. */
  pid?: number;
}

/** Documents the lock gc hooks payload exchanged by command, SDK, and package integrations. */
export interface LockGcHooks {
  /** Value that configures or reports on read for this contract. */
  onRead?: (lockPath: string) => Promise<string[]> | string[];
  /** Value that configures or reports on write for this contract. */
  onWrite?: (lockPath: string) => Promise<string[]> | string[];
}

/** Documents the lock gc options payload exchanged by command, SDK, and package integrations. */
export interface LockGcOptions {
  /** Value that configures or reports dry run for this contract. */
  dryRun: boolean;
  /** epoch ms; defaults to Date.now() — injectable for deterministic tests */
  now?: number;
  /** Value that configures or reports hooks for this contract. */
  hooks?: LockGcHooks;
}

/** Documents the lock gc result payload exchanged by command, SDK, and package integrations. */
export interface LockGcResult {
  /** number of *.lock files examined */
  scanned: number;
  /** relative paths like "locks/pm-abc1.lock" (removed, or would-remove under dryRun) */
  removed: string[];
  /** relative paths retained (active OR unparseable — never delete what we can't reason about) */
  retained: string[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** one per scanned *.lock file, sorted by file name asc */
  entries: StaleLockScanEntry[];
}

interface ParsedLock extends LockOwnerIdentity {
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
  return {
    id,
    owner,
    created_at,
    ttl_seconds,
    pid: candidate.pid,
    host_identity: candidate.host_identity,
    process_start_identity: candidate.process_start_identity,
  };
}

/** Fine-grained classification outcome for one readable lock file's content. `unparseable_json` and `invalid_timestamp` both surface as the coarse `reason: "unparseable"` on the scan entry (gc retains both), but stay distinct here so callers can emit precise warnings. */
export type LockClassificationDetail =
  | "active"
  | "expired"
  | "owner_dead"
  | "unparseable_json"
  | "invalid_timestamp";

/** Documents the lock content classification payload exchanged by command, SDK, and package integrations. */
export interface LockContentClassification {
  /** Value that configures or reports detail for this contract. */
  detail: LockClassificationDetail;
  /** Value that configures or reports entry for this contract. */
  entry: StaleLockScanEntry;
}

/** Pure TTL classification retained for callers that cannot observe the owner process. Health and GC additionally share conservative same-host liveness observation. */
export function classifyLockContent(
  file: string,
  raw: string,
  nowMs: number,
): LockContentClassification {
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

/** Add positive same-host owner-death proof to the shared conservative TTL classification. */
async function classifyObservedLock(
  file: string,
  raw: string,
  nowMs: number,
): Promise<LockContentClassification> {
  const classified = classifyLockContent(file, raw, nowMs);
  if (classified.detail !== "active") return classified;
  const lock = parseLock(raw)!;
  const state = await inspectLockOwner(lock);
  if (state === "unknown") return classified;
  return {
    detail: state === "dead" ? "owner_dead" : "active",
    entry: {
      ...classified.entry,
      owner_state: state,
      pid: lock.pid as number,
      ...(state === "dead"
        ? { stale: true, reason: "owner_dead" as const }
        : {}),
    },
  };
}

/** Compare the observed receipt under the same gate that fences writers and initialization. */
async function removeObservedLock(
  lockPath: string,
  raw: string,
  ownerDead: boolean,
): Promise<boolean> {
  const release = await acquireStaleCleanupGate(lockPath, "gc");
  if (release === null) return false;
  try {
    let current: string;
    try {
      current = await fs.readFile(lockPath, "utf8");
    } catch (error: unknown) {
      if (isFileMissingError(error)) return true;
      throw error;
    }
    if (current !== raw) return false;
    if (ownerDead) await recordDeadLockRecovery(lockPath, raw);
    try {
      await fs.unlink(lockPath);
    } catch (error: unknown) {
      if (!isFileMissingError(error)) throw error;
    }
    return true;
  } finally {
    await release();
  }
}

/** Documents the lock health scan payload exchanged by command, SDK, and package integrations. */
export interface LockHealthScan {
  /** number of *.lock files examined (ghost files that vanish mid-scan are skipped) */
  scanned: number;
  /** Number of active lock entries represented by this result. */
  active_lock_count: number;
  /** Number of stale lock entries represented by this result. */
  stale_lock_count: number;
  /** Number of unreadable lock entries represented by this result. */
  unreadable_lock_count: number;
  /** invalid JSON, wrong shape, or an unparseable created_at timestamp */
  unparseable_lock_count: number;
  /** At most twenty verified dead-owner receipts for actionable full health diagnosis. */
  owner_dead_lock_samples?: StaleLockScanEntry[];
}

function addHealthObservation(
  scan: LockHealthScan,
  detail: LockClassificationDetail,
  entry: StaleLockScanEntry,
): void {
  if (detail === "owner_dead") {
    scan.owner_dead_lock_samples ??= [];
    if (scan.owner_dead_lock_samples.length < 20)
      scan.owner_dead_lock_samples.push(entry);
  }
  if (detail === "active") {
    scan.active_lock_count += 1;
  } else if (detail === "expired" || detail === "owner_dead") {
    scan.stale_lock_count += 1;
  } else {
    scan.unparseable_lock_count += 1;
  }
}

/** Read-only locks scan for `pm health`: classifies every lock file with the same policy `pm gc --scope locks` uses but never removes anything. */
export async function scanLockHealth(
  pmRoot: string,
  now?: number,
): Promise<LockHealthScan> {
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
    if (isFileMissingError(error)) {
      return scan;
    }
    throw error;
  }

  for (const file of dirEntries) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(locksDir, file), "utf8");
    } catch (readError: unknown) {
      if (isFileMissingError(readError)) {
        // Disappeared between readdir and readFile — treat as a ghost; skip quietly.
        continue;
      }
      scan.scanned += 1;
      scan.unreadable_lock_count += 1;
      continue;
    }
    scan.scanned += 1;
    const { detail, entry } = await classifyObservedLock(file, raw, nowMs);
    addHealthObservation(scan, detail, entry);
  }

  return scan;
}

async function removeOrPreviewLock(
  result: LockGcResult,
  options: LockGcOptions,
  absPath: string,
  relPath: string,
  file: string,
  raw: string,
  entry: StaleLockScanEntry,
): Promise<void> {
  if (!options.dryRun) {
    try {
      if (!(await removeObservedLock(absPath, raw, entry.reason === "owner_dead"))) {
        result.warnings.push(`lock_changed_or_busy:${file}`);
        result.retained.push(relPath);
        result.entries.push(entry);
        return;
      }
    } catch {
      result.warnings.push(`lock_remove_failed:${file}`);
      result.retained.push(relPath);
      result.entries.push(entry);
      return;
    }
    // onWrite hook after successful removal
    if (options.hooks?.onWrite) {
      const hookWarnings = await options.hooks.onWrite(absPath);
      result.warnings.push(...hookWarnings);
    }
  }

  result.removed.push(relPath);
  result.entries.push(entry);
}

/** Implements run lock gc for the public runtime surface of this module. */
export async function runLockGc(
  pmRoot: string,
  options: LockGcOptions,
): Promise<LockGcResult> {
  const { hooks } = options;
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
    if (isFileMissingError(error)) {
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
      if (isFileMissingError(readError)) {
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
    const classified = await classifyObservedLock(file, raw, nowMs);
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

    await removeOrPreviewLock(
      result,
      options,
      absPath,
      relPath,
      file,
      raw,
      classified.entry,
    );
  }

  return result;
}
