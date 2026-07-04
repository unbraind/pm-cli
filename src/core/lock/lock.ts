/**
 * @module core/lock/lock
 *
 * Coordinates tracker lock ownership and cleanup for Lock.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { runActiveOnReadHooks, runActiveOnWriteHooks, runActiveServiceOverride } from "../extensions/index.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { toErrorMessage } from "../shared/primitives.js";
import { getLockPath } from "../store/paths.js";
import { nowIso } from "../shared/time.js";

interface LockInfo {
  id: string;
  pid: number;
  owner: string;
  created_at: string;
  ttl_seconds: number;
}

type LockWriteOp = "lock:create" | "lock:release" | "lock:stale_remove";

interface LockReadResult {
  info: LockInfo | null;
  warnings: string[];
}

function parseLockInfo(raw: string): LockReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      info: null,
      warnings: ["lock_info_invalid_json"],
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      info: null,
      warnings: ["lock_info_invalid_shape"],
    };
  }
  const candidate = parsed as Record<string, unknown>;
  const id = candidate.id;
  const pid = candidate.pid;
  const owner = candidate.owner;
  const createdAt = candidate.created_at;
  const ttlSeconds = candidate.ttl_seconds;
  if (
    typeof id !== "string" ||
    typeof pid !== "number" ||
    !Number.isFinite(pid) ||
    typeof owner !== "string" ||
    typeof createdAt !== "string" ||
    typeof ttlSeconds !== "number" ||
    !Number.isFinite(ttlSeconds)
  ) {
    return {
      info: null,
      warnings: ["lock_info_invalid_shape"],
    };
  }
  return {
    info: {
      id,
      pid,
      owner,
      created_at: createdAt,
      ttl_seconds: ttlSeconds,
    },
    warnings: [],
  };
}

async function readLockInfo(lockPath: string): Promise<LockReadResult> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    await runActiveOnReadHooks({
      path: lockPath,
      scope: "project",
    });
    return parseLockInfo(raw);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      return {
        info: null,
        warnings: [],
      };
    }
    return {
      info: null,
      warnings: ["lock_info_read_failed"],
    };
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}

async function emitLockWriteHook(lockPath: string, op: LockWriteOp): Promise<void> {
  await runActiveOnWriteHooks({
    path: lockPath,
    scope: "project",
    op,
  });
}

function buildLockPayload(id: string, owner: string, ttlSeconds: number): LockInfo {
  return {
    id,
    pid: process.pid,
    owner,
    created_at: nowIso(),
    ttl_seconds: ttlSeconds,
  };
}

async function createLockFile(lockPath: string, id: string, owner: string, ttlSeconds: number): Promise<void> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const handle = await fs.open(lockPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(buildLockPayload(id, owner, ttlSeconds), null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await emitLockWriteHook(lockPath, "lock:create");
}

async function unlinkLockWithHook(lockPath: string, op: "lock:release" | "lock:stale_remove"): Promise<boolean> {
  try {
    await fs.unlink(lockPath);
    await emitLockWriteHook(lockPath, op);
    return true;
  } catch {
    // Lock cleanup is best-effort.
    return false;
  }
}

function isStaleLock(info: LockInfo | null, ttlSeconds: number): boolean {
  const createdAtMs = info?.created_at ? Date.parse(info.created_at) : Number.NaN;
  const ageMs = Number.isFinite(createdAtMs) ? Date.now() - createdAtMs : Number.POSITIVE_INFINITY;
  return ageMs > ttlSeconds * 1000;
}

function lockOwnerSuffix(info: LockInfo | null): string {
  return info?.owner ? ` (owner ${info.owner})` : "";
}

const LOCK_WAIT_INITIAL_DELAY_MS = 25;
const LOCK_WAIT_MAX_DELAY_MS = 200;
const LOCK_CONFLICT_RETRY_HINT_MS = 250;
const MAX_STALE_LOCK_REMOVALS = 3;

function parseNonNegativeIntegerWaitMs(value: string | number | undefined): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return undefined;
}

/**
 * Resolves the effective bounded wait budget for a contended lock: the
 * PM_LOCK_WAIT_MS environment override wins when it parses as a non-negative
 * integer, then the caller-provided budget (settings `locks.wait_ms`), then 0
 * (fail-fast, the pre-wait behavior).
 */
function resolveLockWaitMs(waitMs: number | undefined): number {
  const envRaw = process.env.PM_LOCK_WAIT_MS;
  const envParsed = parseNonNegativeIntegerWaitMs(envRaw);
  if (envParsed !== undefined) {
    return envParsed;
  }
  const callerParsed = parseNonNegativeIntegerWaitMs(waitMs);
  if (callerParsed !== undefined) {
    return callerParsed;
  }
  return 0;
}

function sleepWithJitter(baseDelayMs: number): Promise<void> {
  const jitteredMs = Math.max(1, Math.round(baseDelayMs * (0.5 + Math.random())));
  return new Promise((resolve) => setTimeout(resolve, jitteredMs));
}

function buildLockConflictError(id: string, info: LockInfo | null, waitedMs: number): PmCliError {
  const waitedSuffix = waitedMs > 0 ? ` after waiting ${waitedMs}ms` : "";
  return new PmCliError(`Item ${id} is locked${lockOwnerSuffix(info)}${waitedSuffix}`, EXIT_CODE.CONFLICT, {
    code: "lock_conflict",
    recovery: {
      retry_after_ms: LOCK_CONFLICT_RETRY_HINT_MS,
    },
  });
}

type LockReleaseOverride = () => Promise<void> | void;

function resolveLockOverrideRelease(result: unknown): LockReleaseOverride | null {
  if (typeof result === "function") {
    return result as LockReleaseOverride;
  }
  if (typeof result === "object" && result !== null && "release" in result) {
    const release = (result as { release?: unknown }).release;
    return typeof release === "function" ? (release as LockReleaseOverride) : null;
  }
  return null;
}

function throwIfStaleLockNeedsForce(id: string, lockInfo: LockReadResult, force: boolean, forceRequired: boolean): void {
  if (!force && forceRequired) {
    const warningSuffix = lockInfo.warnings.length > 0 ? ` (${lockInfo.warnings.join(",")})` : "";
    throw new PmCliError(
      `Item ${id} lock is stale${warningSuffix}; rerun with --force when supported for this command`,
      EXIT_CODE.CONFLICT,
    );
  }
}

export const _testOnly = {
  parseLockInfo,
  readLockInfo,
  isErrno,
  buildLockPayload,
  isStaleLock,
  lockOwnerSuffix,
  resolveLockWaitMs,
};


/**
 * Implements acquire lock for the public runtime surface of this module.
 */
export async function acquireLock(
  pmRoot: string,
  id: string,
  ttlSeconds: number,
  owner: string,
  force = false,
  forceRequiredForStaleLock = true,
  waitMs?: number,
): Promise<() => Promise<void>> {
  const lockOverride = await runActiveServiceOverride("lock_acquire", {
    pm_root: pmRoot,
    id,
    ttl_seconds: ttlSeconds,
    owner,
    force,
    force_required_for_stale_lock: forceRequiredForStaleLock,
  });
  if (lockOverride.handled) {
    const release = resolveLockOverrideRelease(lockOverride.result);
    if (release) {
      return async () => {
        await Promise.resolve(release());
        await runActiveServiceOverride("lock_release", {
          pm_root: pmRoot,
          id,
          owner,
        });
      };
    }
  }

  const lockPath = getLockPath(pmRoot, id);
  const waitBudgetMs = resolveLockWaitMs(waitMs);
  const startedAtMs = Date.now();
  let staleRemovals = 0;
  let backoffMs = LOCK_WAIT_INITIAL_DELAY_MS;

  for (;;) {
    try {
      await createLockFile(lockPath, id, owner, ttlSeconds);
      return async () => {
        await unlinkLockWithHook(lockPath, "lock:release");
        await runActiveServiceOverride("lock_release", {
          pm_root: pmRoot,
          id,
          owner,
        });
      };
    } catch (error: unknown) {
      if (!isErrno(error, "EEXIST")) {
        throw new PmCliError(`Failed to acquire lock for ${id}: ${toErrorMessage(error)}`, EXIT_CODE.GENERIC_FAILURE);
      }
      const lockInfo = await readLockInfo(lockPath);
      if (isStaleLock(lockInfo.info, ttlSeconds)) {
        throwIfStaleLockNeedsForce(id, lockInfo, force, forceRequiredForStaleLock);
        if (staleRemovals >= MAX_STALE_LOCK_REMOVALS) {
          throw buildLockConflictError(id, lockInfo.info, waitBudgetMs);
        }
        staleRemovals += 1;
        await unlinkLockWithHook(lockPath, "lock:stale_remove");
        continue;
      }
      const elapsedMs = Date.now() - startedAtMs;
      if (waitBudgetMs === 0 || elapsedMs >= waitBudgetMs) {
        throw buildLockConflictError(id, lockInfo.info, waitBudgetMs);
      }
      await sleepWithJitter(Math.min(backoffMs, waitBudgetMs - elapsedMs));
      backoffMs = Math.min(backoffMs * 2, LOCK_WAIT_MAX_DELAY_MS);
    }
  }
}
