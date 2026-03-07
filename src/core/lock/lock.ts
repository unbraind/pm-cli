import fs from "node:fs/promises";
import { runActiveOnReadHooks, runActiveOnWriteHooks } from "../extensions/index.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
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

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    await runActiveOnReadHooks({
      path: lockPath,
      scope: "project",
    });
    return JSON.parse(raw) as LockInfo;
  } catch {
    return null;
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
  const handle = await fs.open(lockPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(buildLockPayload(id, owner, ttlSeconds), null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await emitLockWriteHook(lockPath, "lock:create");
}

async function unlinkLockWithHook(lockPath: string, op: "lock:release" | "lock:stale_remove"): Promise<void> {
  try {
    await fs.unlink(lockPath);
    await emitLockWriteHook(lockPath, op);
  } catch {
    // Lock cleanup is best-effort.
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

async function handleExistingLock(lockPath: string, id: string, ttlSeconds: number, force: boolean): Promise<void> {
  const info = await readLockInfo(lockPath);
  if (!isStaleLock(info, ttlSeconds)) {
    throw new PmCliError(`Item ${id} is locked${lockOwnerSuffix(info)}`, EXIT_CODE.CONFLICT);
  }

  if (!force) {
    throw new PmCliError(
      `Item ${id} lock is stale; rerun with --force when supported for this command`,
      EXIT_CODE.CONFLICT,
    );
  }

  await unlinkLockWithHook(lockPath, "lock:stale_remove");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export async function acquireLock(
  pmRoot: string,
  id: string,
  ttlSeconds: number,
  owner: string,
  force = false,
): Promise<() => Promise<void>> {
  const lockPath = getLockPath(pmRoot, id);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await createLockFile(lockPath, id, owner, ttlSeconds);
      return async () => {
        await unlinkLockWithHook(lockPath, "lock:release");
      };
    } catch (error: unknown) {
      if (!isErrno(error, "EEXIST")) {
        throw new PmCliError(`Failed to acquire lock for ${id}: ${toErrorMessage(error)}`, EXIT_CODE.GENERIC_FAILURE);
      }
      await handleExistingLock(lockPath, id, ttlSeconds, force);
    }
  }

  throw new PmCliError(`Failed to acquire lock for ${id}`, EXIT_CODE.CONFLICT);
}
