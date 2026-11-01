/**
 * @module core/lock/lock-confinement
 *
 * Confines tracker locks to the tracker: a lock is only ever created in a real
 * directory under the tracker root, never through a symlinked or swapped
 * component (pm-gh1647).
 */
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { isFileMissingError } from "../fs/fs-utils.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";

/** Typed refusal code for a lock path that leaves, or could leave, the tracker. */
export const LOCK_PATH_UNSAFE_CODE = "lock_path_unsafe";

/** Device and inode identity of a confined lock directory or lock entry. */
export interface LockEntryIdentity {
  /** Device that holds the entry. */
  readonly dev: number;
  /** Inode of the entry on that device. */
  readonly ino: number;
}

/** Stable failure classes reported in the `reason` of a lock_path_unsafe refusal. */
export type LockPathUnsafeReason =
  | "lock_path_outside_tracker"
  | "lock_directory_symlink"
  | "lock_directory_not_directory"
  | "lock_entry_symlink"
  | "lock_directory_replaced";

function toPortableRelative(pmRoot: string, target: string): string {
  return path.relative(pmRoot, target).split(path.sep).join("/");
}

/** Build the typed refusal for a lock path that cannot be proven confined. */
export function buildLockPathUnsafeError(params: {
  pmRoot: string;
  lockPath: string;
  id: string;
  reason: LockPathUnsafeReason;
  component?: string;
  strayLockRemoved?: boolean;
}): PmCliError {
  const component = params.component ?? path.dirname(params.lockPath);
  const relativeComponent = toPortableRelative(params.pmRoot, component);
  return new PmCliError(
    `Refused to acquire lock ${params.id}: ${relativeComponent} is not a real directory inside the tracker (${params.reason}). Locks are never created through a symlinked or replaced lock directory.`,
    EXIT_CODE.CONFLICT,
    {
      // Literal so the generated error-code catalog sees the emitter.
      code: "lock_path_unsafe",
      item_id: params.id,
      reason: params.reason,
      lock_component: relativeComponent,
      ...(params.strayLockRemoved === undefined
        ? {}
        : { stray_lock_removed: params.strayLockRemoved }),
      required:
        "Replace the symlinked or replaced lock directory with a real directory inside the tracker (for example: remove the link, then let pm recreate locks/), then retry the same operation.",
    },
  );
}

function sameIdentity(
  left: LockEntryIdentity,
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Verify that every path component between the tracker root and the lock's
 * parent directory is a real directory, never a symlink. Returns the parent's
 * identity. A missing component returns null when `allowMissing` (the caller's
 * own creation or absence handling then applies) and otherwise rethrows the
 * native error. The tracker root itself may be a symlink; confinement is
 * relative to it.
 */
export async function inspectConfinedLockDirectory(
  pmRoot: string,
  lockPath: string,
  id: string,
  allowMissing: false,
): Promise<LockEntryIdentity>;
/** Inspect the lock directory, returning null when a component is missing and absence is allowed. */
export async function inspectConfinedLockDirectory(
  pmRoot: string,
  lockPath: string,
  id: string,
  allowMissing?: boolean,
): Promise<LockEntryIdentity | null>;
/** Shared implementation of both inspectConfinedLockDirectory overloads. */
export async function inspectConfinedLockDirectory(
  pmRoot: string,
  lockPath: string,
  id: string,
  allowMissing = true,
): Promise<LockEntryIdentity | null> {
  const root = path.resolve(pmRoot);
  const directory = path.dirname(path.resolve(lockPath));
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw buildLockPathUnsafeError({
      pmRoot: root,
      lockPath,
      id,
      reason: "lock_path_outside_tracker",
      component: directory,
    });
  }
  let current = root;
  let identity: LockEntryIdentity | null = null;
  for (const segment of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    let stats: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stats = await fs.lstat(current);
    } catch (error: unknown) {
      if (allowMissing && isFileMissingError(error)) return null;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw buildLockPathUnsafeError({
        pmRoot: root,
        lockPath,
        id,
        reason: "lock_directory_symlink",
        component: current,
      });
    }
    if (!stats.isDirectory()) {
      throw buildLockPathUnsafeError({
        pmRoot: root,
        lockPath,
        id,
        reason: "lock_directory_not_directory",
        component: current,
      });
    }
    identity = { dev: stats.dev, ino: stats.ino };
  }
  if (identity !== null) return identity;
  const rootStats = await fs.stat(root);
  return { dev: rootStats.dev, ino: rootStats.ino };
}

/** Refuse a lock entry that is itself a symlink instead of waiting on it as a peer's lock. */
export async function assertLockEntryNotSymlink(
  pmRoot: string,
  lockPath: string,
  id: string,
): Promise<void> {
  let stats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stats = await fs.lstat(lockPath);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) {
    throw buildLockPathUnsafeError({
      pmRoot,
      lockPath,
      id,
      reason: "lock_entry_symlink",
      component: lockPath,
    });
  }
}

/** Locate the file an open handle refers to, where the platform exposes it. */
async function resolveHandlePath(
  handle: FileHandle,
  platform: NodeJS.Platform,
): Promise<string | null> {
  if (platform !== "linux") return null;
  try {
    return await fs.readlink(`/proc/self/fd/${handle.fd}`);
  } catch {
    return null;
  }
}

/** Remove a lock this process created outside the confined directory, when it can be located. */
async function removeStrayLock(
  handle: FileHandle,
  created: LockEntryIdentity,
  platform: NodeJS.Platform,
): Promise<boolean> {
  const strayPath = await resolveHandlePath(handle, platform);
  if (strayPath === null) return false;
  try {
    const stats = await fs.lstat(strayPath);
    if (!sameIdentity(created, stats)) return false;
    await fs.unlink(strayPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prove that the lock just created through `handle` is the entry at `lockPath`
 * inside the same confined directory observed before creation. A directory
 * swapped between the check and the create means the lock landed elsewhere:
 * the stray lock is removed where the platform can locate it, and the
 * acquisition refuses with lock_path_unsafe instead of returning a lease that
 * excludes no one.
 */
export async function verifyConfinedLockCreation(params: {
  pmRoot: string;
  lockPath: string;
  id: string;
  handle: FileHandle;
  directory: LockEntryIdentity;
  platform?: NodeJS.Platform;
}): Promise<void> {
  const platform = params.platform ?? process.platform;
  const createdStats = await params.handle.stat();
  const created: LockEntryIdentity = {
    dev: createdStats.dev,
    ino: createdStats.ino,
  };
  let confined = false;
  try {
    const directory = await inspectConfinedLockDirectory(
      params.pmRoot,
      params.lockPath,
      params.id,
      false,
    );
    if (sameIdentity(params.directory, directory)) {
      const entry = await fs.lstat(params.lockPath);
      confined = !entry.isSymbolicLink() && sameIdentity(created, entry);
    }
  } catch {
    confined = false;
  }
  if (confined) return;
  const strayLockRemoved = await removeStrayLock(
    params.handle,
    created,
    platform,
  );
  throw buildLockPathUnsafeError({
    pmRoot: params.pmRoot,
    lockPath: params.lockPath,
    id: params.id,
    reason: "lock_directory_replaced",
    strayLockRemoved,
  });
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  resolveHandlePath,
  removeStrayLock,
};
