/**
 * @module core/lock/lock
 *
 * Coordinates tracker lock ownership and cleanup for Lock.
 */
import { isFileMissingError } from "../fs/fs-utils.js";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  runActiveOnReadHooks,
  runActiveOnWriteHooks,
  runActiveServiceOverride,
} from "../extensions/index.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError, type PmCliErrorContext } from "../shared/errors.js";
import { toErrorMessage } from "../shared/primitives.js";
import { getLockPath } from "../store/paths.js";
import { nowIso } from "../shared/time.js";

import {
  captureProcessIdentity,
  captureLockOwnerIdentity,
  inspectLockOwner,
  isProcessIdentityAlive,
  parseLinuxProcessStartIdentity,
  readProcessStartIdentity,
  type ProcessIdentity,
  type LockOwnerIdentity,
} from "./lock-owner.js";
export {
  captureProcessIdentity,
  isProcessIdentityAlive,
  readProcessStartIdentity,
} from "./lock-owner.js";

interface LockInfo extends LockOwnerIdentity {
  id: string;
  pid: number;
  owner: string;
  token?: string;
  created_at: string;
  ttl_seconds: number;
}

type LockWriteOp = "lock:create" | "lock:release" | "lock:stale_remove";

interface LockReadResult {
  info: LockInfo | null;
  warnings: string[];
}

interface StaleLockRemovalResult {
  lockInfo: LockReadResult;
  shouldRetryCreate: boolean;
  staleRemovalCounted: boolean;
}

interface StaleCleanupGateOwner extends ProcessIdentity {
  token: string;
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
  const token = candidate.token;
  const createdAt = candidate.created_at;
  const ttlSeconds = candidate.ttl_seconds;
  if (
    typeof id !== "string" ||
    typeof pid !== "number" ||
    !Number.isFinite(pid) ||
    typeof owner !== "string" ||
    (token !== undefined &&
      (typeof token !== "string" || token.trim().length === 0)) ||
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
      ...(typeof token === "string" ? { token } : {}),
      created_at: createdAt,
      ttl_seconds: ttlSeconds,
      host_identity: candidate.host_identity,
      process_start_identity: candidate.process_start_identity,
    },
    warnings: [],
  };
}

async function readLockInfo(
  lockPath: string,
  emitReadHook = true,
): Promise<LockReadResult> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    if (emitReadHook) {
      await runActiveOnReadHooks({
        path: lockPath,
        scope: "project",
      });
    }
    return parseLockInfo(raw);
  } catch (error: unknown) {
    if (isFileMissingError(error)) {
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
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

/**
 * Classify exclusive-create failures that prove another lock lifecycle is in
 * flight. Windows can report `EPERM`, `EACCES`, or `EBUSY` while a just-unlinked
 * lock is still delete-pending; treating those as fatal makes bounded lock
 * waiting fail nondeterministically. Existing paths are contention on every
 * host. A missing or temporarily unstatable Windows path is contention only
 * when its parent remains writable, preserving genuine permission failures.
 */
async function isLockCreateContention(
  error: unknown,
  lockPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (isErrno(error, "EEXIST")) return true;
  if (
    !isErrno(error, "EPERM") &&
    !isErrno(error, "EACCES") &&
    !isErrno(error, "EBUSY")
  ) {
    return false;
  }
  try {
    await fs.lstat(lockPath);
    return true;
  } catch (probeError: unknown) {
    if (
      platform !== "win32" ||
      (!isFileMissingError(probeError) &&
        !isErrno(probeError, "EPERM") &&
        !isErrno(probeError, "EACCES") &&
        !isErrno(probeError, "EBUSY"))
    ) {
      return false;
    }
  }
  try {
    await fs.access(path.dirname(lockPath), fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function emitLockWriteHook(
  lockPath: string,
  op: LockWriteOp,
): Promise<void> {
  await runActiveOnWriteHooks({
    path: lockPath,
    scope: "project",
    op,
  });
}

async function buildLockPayload(
  id: string,
  owner: string,
  ttlSeconds: number,
  token: string = randomUUID(),
): Promise<LockInfo> {
  return {
    ...(await captureLockOwnerIdentity()),
    id,
    pid: process.pid,
    owner,
    token,
    created_at: nowIso(),
    ttl_seconds: ttlSeconds,
  };
}

/**
 * Publish owner metadata while holding the stale-cleanup coordination gate so
 * an empty, exclusively created file cannot be reclaimed by a competing owner.
 * Failed initialization closes and removes only the file this call created.
 */
async function createLockFile(
  lockPath: string,
  id: string,
  owner: string,
  ttlSeconds: number,
  token: string,
  createParentDirectories: boolean,
): Promise<string> {
  if (createParentDirectories)
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
  // Publication of an empty file precedes its owner JSON. Fence both steps
  // against stale cleanup so no peer can reclaim a live initializing owner.
  const releaseCleanupGate = await acquireStaleCleanupGate(lockPath, id);
  if (releaseCleanupGate === null) {
    // A removed parent is absence, not another owner's initializing lock.
    // Preserve its native error instead of spending the contention budget.
    await fs.access(path.dirname(lockPath));
    throw Object.assign(new Error("Lock initialization is contended"), {
      code: "EEXIST",
    });
  }
  let createdAt: string;
  try {
    const handle = await fs.open(lockPath, "wx");
    try {
      try {
        const payload = await buildLockPayload(id, owner, ttlSeconds, token);
        createdAt = payload.created_at;
        await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      await unlinkLockWithHook(lockPath, "lock:release");
      throw error;
    }
  } finally {
    await releaseCleanupGate();
  }
  await emitLockWriteHook(lockPath, "lock:create");
  return createdAt;
}

async function unlinkLockWithHook(
  lockPath: string,
  op: "lock:release" | "lock:stale_remove",
): Promise<boolean> {
  try {
    await fs.unlink(lockPath);
    await emitLockWriteHook(lockPath, op);
    return true;
  } catch {
    // Lock cleanup is best-effort.
    return false;
  }
}

async function releaseOwnedLock(
  lockPath: string,
  id: string,
  owner: string,
  token: string,
): Promise<void> {
  const startedAtMs = Date.now();
  let backoffMs = LOCK_WAIT_INITIAL_DELAY_MS;
  for (;;) {
    const releaseCleanupGate = await acquireStaleCleanupGate(lockPath, id);
    if (releaseCleanupGate !== null) {
      try {
        const current = await readLockInfo(lockPath, false);
        if (isOwnedLock(current.info, id, owner, token)) {
          await unlinkLockWithHook(lockPath, "lock:release");
        }
      } finally {
        await releaseCleanupGate();
      }
      return;
    }
    const current = await readLockInfo(lockPath, false);
    if (!isOwnedLock(current.info, id, owner, token)) {
      return;
    }
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs >= LOCK_RELEASE_GATE_WAIT_MS) {
      return;
    }
    await sleepWithJitter(
      Math.min(backoffMs, LOCK_RELEASE_GATE_WAIT_MS - elapsedMs),
    );
    backoffMs = Math.min(backoffMs * 2, LOCK_WAIT_MAX_DELAY_MS);
  }
}

function isOwnedLock(
  info: LockInfo | null,
  id: string,
  owner: string,
  token: string,
): boolean {
  return (
    info?.id === id &&
    info.pid === process.pid &&
    info.owner === owner &&
    info.token === token
  );
}

function isStaleLock(info: LockInfo | null, ttlSeconds: number): boolean {
  const createdAtMs = info?.created_at
    ? Date.parse(info.created_at)
    : Number.NaN;
  const ageMs = Number.isFinite(createdAtMs)
    ? Date.now() - createdAtMs
    : Number.POSITIVE_INFINITY;
  return ageMs > ttlSeconds * 1000;
}

async function isConfirmedDeadLock(info: LockInfo | null): Promise<boolean> {
  return (
    info !== null &&
    Number.isFinite(Date.parse(info.created_at)) &&
    (await inspectLockOwner(info)) === "dead"
  );
}

async function isReclaimableLock(
  info: LockInfo | null,
  ttlSeconds: number,
): Promise<boolean> {
  return isStaleLock(info, ttlSeconds) || (await isConfirmedDeadLock(info));
}

/** Observe a built-in lock's owner lease without acquiring it or changing storage. */
export async function hasUnexpiredLockOwner(
  pmRoot: string,
  id: string,
  ownerPrefix: string,
): Promise<boolean> {
  const { info } = await readLockInfo(getLockPath(pmRoot, id), false);
  return (
    info !== null &&
    info.owner.startsWith(ownerPrefix) &&
    !(await isReclaimableLock(info, info.ttl_seconds))
  );
}

function lockOwnerSuffix(info: LockInfo | null): string {
  return info?.owner ? ` (owner ${info.owner})` : "";
}

const LOCK_WAIT_INITIAL_DELAY_MS = 25;
const LOCK_WAIT_MAX_DELAY_MS = 200;
const LOCK_CONFLICT_RETRY_HINT_MS = 250;
/** Hard ceiling for a wait whose no-progress window keeps restarting on owner handoffs. */
const LOCK_PROGRESS_MAX_WAIT_MS = 120_000;
const MAX_STALE_LOCK_REMOVALS = 3;
const STALE_CLEANUP_GATE_SUFFIX = ".stale-cleanup";
const STALE_CLEANUP_GATE_OWNER_FILE = "owner.json";
const STALE_CLEANUP_GATE_STALE_MS = 10_000;
const LOCK_RELEASE_GATE_WAIT_MS =
  STALE_CLEANUP_GATE_STALE_MS + LOCK_WAIT_MAX_DELAY_MS;
const STALE_CLEANUP_GATE_MAX_UNVERIFIED_MS = 60 * 60_000;

function parseNonNegativeIntegerWaitMs(
  value: string | number | undefined,
): number | undefined {
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

/** Resolves the effective bounded wait budget for a contended lock: the PM_LOCK_WAIT_MS environment override wins when it parses as a non-negative integer, then the caller-provided budget (settings `locks.wait_ms`), then 0 (fail-fast, the pre-wait behavior). */
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

/** Apply a caller's retry ceiling after resolving the ordinary environment policy. */
function cappedLockWaitMs(
  waitMs: number | undefined,
  maxWaitMs: number | undefined,
): number {
  return Math.min(resolveLockWaitMs(waitMs), maxWaitMs ?? Infinity);
}

function sleepWithJitter(baseDelayMs: number): Promise<void> {
  const jitteredMs = Math.max(
    1,
    Math.round(baseDelayMs * (0.5 + Math.random())),
  );
  return new Promise((resolve) => setTimeout(resolve, jitteredMs));
}

async function buildLockConflictError(
  id: string,
  info: LockInfo | null,
  waitedMs: number,
  ownerHandoffs = 0,
): Promise<PmCliError> {
  const ownerState = await inspectLockOwner(info);
  const handoffSuffix =
    ownerHandoffs > 0 ? ` across ${ownerHandoffs} owner handoff(s)` : "";
  const waitedSuffix =
    waitedMs > 0 ? ` after waiting ${waitedMs}ms${handoffSuffix}` : "";
  return new PmCliError(
    `Item ${id} is locked${lockOwnerSuffix(info)} (owner process ${ownerState})${waitedSuffix}`,
    EXIT_CODE.CONFLICT,
    {
      code: "lock_conflict",
      item_id: id,
      reason: `lock_owner_${ownerState}`,
      required:
        "Wait for the owner to release the lock, then retry the same operation. Set PM_LOCK_WAIT_MS to a larger bounded millisecond budget when contention is expected. Inspect stale receipts with pm gc --scope locks --dry-run.",
      recovery: {
        retry_after_ms: LOCK_CONFLICT_RETRY_HINT_MS,
        ...(waitedMs > 0
          ? { waited_ms: waitedMs, owner_handoffs: ownerHandoffs }
          : {}),
      },
    },
  );
}

/** Outcome of observing a contended lock once while waiting for it. */
interface LockWaitObservation {
  /** The wait must stop and refuse with lock_conflict. */
  exhausted: boolean;
  /** Milliseconds since the wait started. */
  elapsedMs: number;
  /** Longest sleep that stays inside both the stall window and the ceiling. */
  remainingMs: number;
  /** Lock generations observed to change hands so far. */
  ownerHandoffs: number;
}

/**
 * Track a no-progress wait window: every observed owner handoff restarts it,
 * while the total wait stays bounded by `totalCeilingMs`.
 */
function createLockWaitTracker(waitBudgetMs: number, totalCeilingMs: number) {
  const startedAtMs = Date.now();
  let stallStartedAtMs = startedAtMs;
  let observedGeneration: string | undefined;
  let ownerHandoffs = 0;
  return {
    startedAtMs,
    observe(info: LockInfo | null): LockWaitObservation {
      const nowMs = Date.now();
      const generation = lockGenerationKey(info);
      if (
        observedGeneration !== undefined &&
        generation !== observedGeneration
      ) {
        ownerHandoffs += 1;
        stallStartedAtMs = nowMs;
      }
      observedGeneration = generation;
      const elapsedMs = nowMs - startedAtMs;
      const stalledMs = nowMs - stallStartedAtMs;
      return {
        exhausted:
          waitBudgetMs === 0 ||
          stalledMs >= waitBudgetMs ||
          elapsedMs >= totalCeilingMs,
        elapsedMs,
        remainingMs: Math.min(
          waitBudgetMs - stalledMs,
          totalCeilingMs - elapsedMs,
        ),
        ownerHandoffs,
      };
    },
  };
}

/** Identity of one lock generation; a change proves another writer made progress. */
function lockGenerationKey(info: LockInfo | null): string {
  if (info === null) return "released";
  return info.token ?? `${info.pid}:${info.owner}:${info.created_at}`;
}

function describeLease(lease: {
  owner: string;
  acquiredAt: string;
  ttlSeconds: number;
}): NonNullable<PmCliErrorContext["lease"]> {
  const acquiredMs = Date.parse(lease.acquiredAt);
  return {
    owner: lease.owner,
    acquired_at: lease.acquiredAt,
    ttl_seconds: lease.ttlSeconds,
    expires_at: Number.isFinite(acquiredMs)
      ? new Date(acquiredMs + lease.ttlSeconds * 1000).toISOString()
      : null,
  };
}

function buildLockLostError(
  id: string,
  lease: { owner: string; acquiredAt: string; ttlSeconds: number },
  current: LockInfo | null,
  reason: "lease_taken_over" | "lease_released" | "fence_gate_unavailable",
): PmCliError {
  const holder =
    reason === "fence_gate_unavailable"
      ? "its commit fence could not be entered"
      : current === null
        ? "the lock no longer exists"
        : `it is now held by ${current.owner} since ${current.created_at}`;
  return new PmCliError(
    `Lock for ${id} was lost before commit: the lease acquired at ${lease.acquiredAt} (ttl ${lease.ttlSeconds}s) is no longer owned by this writer, and ${holder}. Nothing was written.`,
    EXIT_CODE.CONFLICT,
    {
      code: "lock_lost",
      item_id: id,
      reason,
      lease: describeLease(lease),
      current_owner:
        current === null
          ? null
          : {
              owner: current.owner,
              pid: current.pid,
              created_at: current.created_at,
              ttl_seconds: current.ttl_seconds,
            },
      required:
        "Re-read the item and apply the mutation again; this writer's change was not committed and the newer value was kept. Keep mutation work shorter than locks.ttl_seconds, or raise locks.ttl_seconds for long-running callbacks.",
      recovery: {
        retry_after_ms: LOCK_CONFLICT_RETRY_HINT_MS,
      },
    },
  );
}

/** Wait for the per-lock cleanup gate that every takeover must also hold. */
async function waitForStaleCleanupGate(
  lockPath: string,
  id: string,
): Promise<(() => Promise<void>) | null> {
  const startedAtMs = Date.now();
  let backoffMs = LOCK_WAIT_INITIAL_DELAY_MS;
  for (;;) {
    const releaseCleanupGate = await acquireStaleCleanupGate(lockPath, id);
    if (releaseCleanupGate !== null) return releaseCleanupGate;
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs >= LOCK_RELEASE_GATE_WAIT_MS) return null;
    await sleepWithJitter(
      Math.min(backoffMs, LOCK_RELEASE_GATE_WAIT_MS - elapsedMs),
    );
    backoffMs = Math.min(backoffMs * 2, LOCK_WAIT_MAX_DELAY_MS);
  }
}

/**
 * Run a commit only while this writer still owns its lock generation. Stale
 * removal and lock publication both hold the same cleanup gate, so verifying the
 * token under that gate excludes a takeover for the whole commit.
 */
async function fenceOwnedLock<T>(
  lockPath: string,
  id: string,
  lease: {
    owner: string;
    token: string;
    acquiredAt: string;
    ttlSeconds: number;
  },
  commit: () => Promise<T>,
): Promise<T> {
  const releaseCleanupGate = await waitForStaleCleanupGate(lockPath, id);
  if (releaseCleanupGate === null) {
    const current = await readLockInfo(lockPath, false);
    throw buildLockLostError(id, lease, current.info, "fence_gate_unavailable");
  }
  try {
    const current = await readLockInfo(lockPath, false);
    if (!isOwnedLock(current.info, id, lease.owner, lease.token)) {
      throw buildLockLostError(
        id,
        lease,
        current.info,
        current.info === null ? "lease_released" : "lease_taken_over",
      );
    }
    return await commit();
  } finally {
    await releaseCleanupGate();
  }
}

type LockReleaseOverride = () => Promise<void> | void;

function resolveLockOverrideRelease(
  result: unknown,
): LockReleaseOverride | null {
  if (typeof result === "function") {
    return result as LockReleaseOverride;
  }
  if (typeof result === "object" && result !== null && "release" in result) {
    const release = (result as { release?: unknown }).release;
    return typeof release === "function"
      ? (release as LockReleaseOverride)
      : null;
  }
  return null;
}

function throwIfStaleLockNeedsForce(
  id: string,
  lockInfo: LockReadResult,
  force: boolean,
  forceRequired: boolean,
): void {
  if (!force && forceRequired) {
    const warningSuffix =
      lockInfo.warnings.length > 0 ? ` (${lockInfo.warnings.join(",")})` : "";
    throw new PmCliError(
      `Item ${id} lock is stale${warningSuffix}; rerun with --force when supported for this command`,
      EXIT_CODE.CONFLICT,
    );
  }
}

function parseStaleCleanupGateOwner(raw: string): StaleCleanupGateOwner | null {
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
  const pid = candidate.pid;
  const token = candidate.token;
  const processStartIdentity = candidate.process_start_identity;
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof token !== "string" ||
    token.length === 0 ||
    (processStartIdentity !== undefined &&
      (typeof processStartIdentity !== "string" ||
        !/^\d+$/u.test(processStartIdentity)))
  ) {
    return null;
  }
  return {
    pid,
    token,
    ...(typeof processStartIdentity === "string"
      ? { process_start_identity: processStartIdentity }
      : {}),
  };
}

async function readStaleCleanupGateOwner(
  gatePath: string,
): Promise<StaleCleanupGateOwner | null> {
  try {
    return parseStaleCleanupGateOwner(
      await fs.readFile(
        path.join(gatePath, STALE_CLEANUP_GATE_OWNER_FILE),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
}

async function removeStaleCleanupGateDirectory(
  gatePath: string,
): Promise<boolean> {
  try {
    await fs.rm(gatePath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function releaseStaleCleanupGate(
  gatePath: string,
  token: string,
): Promise<void> {
  const owner = await readStaleCleanupGateOwner(gatePath);
  if (owner === null || owner.token !== token) {
    return;
  }
  await removeStaleCleanupGateDirectory(gatePath);
}

async function tryCreateStaleCleanupGate(
  gatePath: string,
): Promise<StaleCleanupGateOwner | null> {
  try {
    await fs.mkdir(gatePath);
  } catch (error: unknown) {
    if (isErrno(error, "EEXIST")) {
      return null;
    }
    return null;
  }
  const owner: StaleCleanupGateOwner = {
    ...(await captureProcessIdentity()),
    token: randomUUID(),
  };
  try {
    await fs.writeFile(
      path.join(gatePath, STALE_CLEANUP_GATE_OWNER_FILE),
      `${JSON.stringify(owner)}\n`,
      "utf8",
    );
  } catch {
    await removeStaleCleanupGateDirectory(gatePath);
    return null;
  }
  return owner;
}

async function removeExpiredStaleCleanupGate(
  gatePath: string,
): Promise<boolean> {
  let gateAgeMs: number;
  try {
    const stats = await fs.stat(gatePath);
    gateAgeMs = Date.now() - stats.mtimeMs;
    if (gateAgeMs <= STALE_CLEANUP_GATE_STALE_MS) {
      return false;
    }
  } catch (error: unknown) {
    return isFileMissingError(error);
  }
  const owner = await readStaleCleanupGateOwner(gatePath);
  if (
    owner !== null &&
    (await isProcessIdentityAlive(
      owner,
      gateAgeMs,
      STALE_CLEANUP_GATE_MAX_UNVERIFIED_MS,
    ))
  ) {
    return false;
  }
  return removeStaleCleanupGateDirectory(gatePath);
}

/** Fence lock publication, release and garbage collection under one cleanup owner. */
export async function acquireStaleCleanupGate(
  lockPath: string,
  _id: string,
): Promise<(() => Promise<void>) | null> {
  const gatePath = `${lockPath}${STALE_CLEANUP_GATE_SUFFIX}`;
  const owner = await tryCreateStaleCleanupGate(gatePath);
  if (owner !== null) {
    return async () => releaseStaleCleanupGate(gatePath, owner.token);
  }
  if (!(await removeExpiredStaleCleanupGate(gatePath))) {
    return null;
  }
  const recoveredOwner = await tryCreateStaleCleanupGate(gatePath);
  if (recoveredOwner === null) {
    return null;
  }
  return async () => releaseStaleCleanupGate(gatePath, recoveredOwner.token);
}

/** Retain an immutable local audit of early-recovery intent before removing the observed owner. */
export async function recordDeadLockRecovery(
  lockPath: string,
  raw: string,
): Promise<void> {
  const directory = path.join(path.dirname(lockPath), "recoveries");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, `${randomUUID()}.json`),
    `${JSON.stringify({
      event: "owner_dead_recovery_attempt",
      recorded_at: nowIso(),
      lock: JSON.parse(raw) as unknown,
    })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

async function removeConfirmedStaleLock(params: {
  lockPath: string;
  id: string;
  ttlSeconds: number;
  force: boolean;
  forceRequiredForStaleLock: boolean;
  staleRemovals: number;
  waitBudgetMs: number;
  startedAtMs: number;
  fallbackLockInfo: LockReadResult;
}): Promise<StaleLockRemovalResult> {
  const releaseCleanupGate = await acquireStaleCleanupGate(
    params.lockPath,
    params.id,
  );
  if (releaseCleanupGate === null) {
    return {
      lockInfo: params.fallbackLockInfo,
      shouldRetryCreate: false,
      staleRemovalCounted: false,
    };
  }
  try {
    const currentLockInfo = await readLockInfo(params.lockPath);
    if (
      currentLockInfo.info === null &&
      currentLockInfo.warnings.length === 0
    ) {
      return {
        lockInfo: currentLockInfo,
        shouldRetryCreate: true,
        staleRemovalCounted: false,
      };
    }
    const ownerDead = await isConfirmedDeadLock(currentLockInfo.info);
    if (!isStaleLock(currentLockInfo.info, params.ttlSeconds) && !ownerDead) {
      return {
        lockInfo: currentLockInfo,
        shouldRetryCreate: false,
        staleRemovalCounted: false,
      };
    }
    throwIfStaleLockNeedsForce(
      params.id,
      currentLockInfo,
      params.force || ownerDead,
      params.forceRequiredForStaleLock,
    );
    if (params.staleRemovals >= MAX_STALE_LOCK_REMOVALS) {
      throw await buildLockConflictError(
        params.id,
        currentLockInfo.info,
        Date.now() - params.startedAtMs,
      );
    }
    if (ownerDead)
      await recordDeadLockRecovery(
        params.lockPath,
        JSON.stringify(currentLockInfo.info),
      );
    return {
      lockInfo: currentLockInfo,
      shouldRetryCreate: await unlinkLockWithHook(
        params.lockPath,
        "lock:stale_remove",
      ),
      staleRemovalCounted: true,
    };
  } finally {
    await releaseCleanupGate();
  }
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  parseLockInfo,
  readLockInfo,
  isErrno,
  isLockCreateContention,
  buildLockPayload,
  isStaleLock,
  lockOwnerSuffix,
  resolveLockWaitMs,
  lockGenerationKey,
  parseLinuxProcessStartIdentity,
  readProcessStartIdentity,
  acquireStaleCleanupGate,
  removeConfirmedStaleLock,
};

/** A held tracker lock whose commits can be fenced against a lost lease. */
export interface LockLease {
  /** Release the lock if this writer still owns it; idempotent for peers' locks. */
  release: () => Promise<void>;
  /**
   * Run `commit` only while this lease still owns its lock generation. A lease
   * that expired and was taken over (or released) refuses with `lock_lost` and
   * never runs `commit`. Extension lock overrides own their lifecycle, so their
   * leases run `commit` unfenced.
   */
  fence: <T>(commit: () => Promise<T>) => Promise<T>;
}

/** Positional lock policy shared by acquireLock and acquireLockLease. */
type AcquireLockOptions = {
  /** Allow lock acquisition to initialize missing lock directories. */
  createParentDirectories?: boolean;
  /** Ceiling on the effective retry budget, including PM_LOCK_WAIT_MS. */
  maxWaitMs?: number;
};

/**
 * Acquire a token-owned tracker lock with bounded contention waiting and
 * explicit stale-owner policy. Proven same-host original-process death permits
 * automatic early recovery; unverifiable owners retain TTL policy.
 * Background consumers may disable creation of
 * parent directories so acquiring or retrying a lock cannot revive removed
 * storage. An explicit maxWaitMs caps contention retries even when the process
 * environment requests a longer wait. Extension overrides receive that ceiling
 * and retain responsibility for their own lifecycle.
 */
export async function acquireLock(
  pmRoot: string,
  id: string,
  ttlSeconds: number,
  owner: string,
  force = false,
  forceRequiredForStaleLock = true,
  waitMs?: number,
  options: AcquireLockOptions = {},
): Promise<() => Promise<void>> {
  const lease = await acquireLockLease(
    pmRoot,
    id,
    ttlSeconds,
    owner,
    force,
    forceRequiredForStaleLock,
    waitMs,
    options,
  );
  return lease.release;
}

/**
 * Acquire a lock as a fenceable lease. The wait budget is a no-progress window:
 * every observed owner handoff restarts it, so a queue of live writers drains
 * instead of failing at a fixed deadline, while a stalled owner still refuses
 * after the configured budget. Without an explicit maxWaitMs the total wait is
 * bounded by LOCK_PROGRESS_MAX_WAIT_MS (or the budget itself when larger).
 */
export async function acquireLockLease(
  pmRoot: string,
  id: string,
  ttlSeconds: number,
  owner: string,
  force = false,
  forceRequiredForStaleLock = true,
  waitMs?: number,
  options: AcquireLockOptions = {},
): Promise<LockLease> {
  const maxWaitMs = parseNonNegativeIntegerWaitMs(options.maxWaitMs);
  const lockOverride = await runActiveServiceOverride("lock_acquire", {
    pm_root: pmRoot,
    id,
    ttl_seconds: ttlSeconds,
    owner,
    force,
    force_required_for_stale_lock: forceRequiredForStaleLock,
    ...(maxWaitMs === undefined ? {} : { max_wait_ms: maxWaitMs }),
  });
  if (lockOverride.handled) {
    const release = resolveLockOverrideRelease(lockOverride.result);
    if (release) {
      return {
        release: async () => {
          await Promise.resolve(release());
          await runActiveServiceOverride("lock_release", {
            pm_root: pmRoot,
            id,
            owner,
          });
        },
        fence: (commit) => commit(),
      };
    }
  }

  const lockPath = getLockPath(pmRoot, id);
  const waitBudgetMs = cappedLockWaitMs(waitMs, maxWaitMs);
  const totalCeilingMs =
    maxWaitMs === undefined
      ? Math.max(waitBudgetMs, LOCK_PROGRESS_MAX_WAIT_MS)
      : waitBudgetMs;
  const waitTracker = createLockWaitTracker(waitBudgetMs, totalCeilingMs);
  const startedAtMs = waitTracker.startedAtMs;
  let staleRemovals = 0;
  let backoffMs = LOCK_WAIT_INITIAL_DELAY_MS;
  const token = randomUUID();

  for (;;) {
    try {
      const acquiredAt = await createLockFile(
        lockPath,
        id,
        owner,
        ttlSeconds,
        token,
        options.createParentDirectories !== false,
      );
      const lease = { owner, token, acquiredAt, ttlSeconds };
      return {
        release: async () => {
          await releaseOwnedLock(lockPath, id, owner, token);
          await runActiveServiceOverride("lock_release", {
            pm_root: pmRoot,
            id,
            owner,
          });
        },
        fence: (commit) => fenceOwnedLock(lockPath, id, lease, commit),
      };
    } catch (error: unknown) {
      if (!(await isLockCreateContention(error, lockPath))) {
        throw new PmCliError(
          `Failed to acquire lock for ${id}: ${toErrorMessage(error)}`,
          EXIT_CODE.GENERIC_FAILURE,
        );
      }
      let lockInfo = await readLockInfo(lockPath);
      if (await isReclaimableLock(lockInfo.info, ttlSeconds)) {
        const staleRemoval = await removeConfirmedStaleLock({
          lockPath,
          id,
          ttlSeconds,
          force,
          forceRequiredForStaleLock,
          staleRemovals,
          waitBudgetMs,
          startedAtMs,
          fallbackLockInfo: lockInfo,
        });
        lockInfo = staleRemoval.lockInfo;
        if (staleRemoval.staleRemovalCounted) {
          staleRemovals += 1;
        }
        if (staleRemoval.shouldRetryCreate) {
          continue;
        }
      }
      const observation = waitTracker.observe(lockInfo.info);
      if (observation.exhausted) {
        throw await buildLockConflictError(
          id,
          lockInfo.info,
          waitBudgetMs === 0 ? 0 : observation.elapsedMs,
          observation.ownerHandoffs,
        );
      }
      await sleepWithJitter(Math.min(backoffMs, observation.remainingMs));
      backoffMs = Math.min(backoffMs * 2, LOCK_WAIT_MAX_DELAY_MS);
    }
  }
}
