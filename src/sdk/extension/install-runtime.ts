/**
 * @module sdk/extension/install-runtime
 *
 * Provides cross-platform extension copy safety and owner-bound install locks.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "../../core/fs/fs-utils.js";
import { isPathWithinDirectory } from "../../core/fs/path-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";

const EXTENSION_INSTALL_COPY_ATTEMPTS = 3;
const EXTENSION_INSTALL_LOCK_ATTEMPTS = 120;
const EXTENSION_INSTALL_LOCK_DELAY_MS = 250;
const EXTENSION_INSTALL_LOCK_STALE_MS = 120_000;
const RETRIABLE_EXTENSION_INSTALL_COPY_CODES = new Set([
  "EEXIST",
  "ENOTEMPTY",
  "ENOENT",
]);

interface ExtensionInstallLockOwner {
  pid: number;
  token: string;
  created_at: string;
  destination: string;
}

/** Retry and lease timing overrides for one extension install lock. */
export interface ExtensionInstallLockOptions {
  /** Maximum lock-acquisition attempts. */
  attempts?: number;
  /** Delay between contended acquisition attempts. */
  delay_ms?: number;
  /** Age after which an unchanged owner lease can be reclaimed. */
  stale_ms?: number;
  /** Lease heartbeat interval while the operation runs. */
  heartbeat_ms?: number;
}

/** Return an errno-style code from an unknown failure when one is present. */
const errnoCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;

/** Identify transient copy races that are safe to retry during extension installation. */
export const isRetriableExtensionInstallCopyError = (error: unknown): boolean =>
  RETRIABLE_EXTENSION_INSTALL_COPY_CODES.has(String(errnoCode(error)));

/** Test an unknown failure against one expected errno-style code. */
export const isErrnoCode = (error: unknown, code: string): boolean =>
  errnoCode(error) === code;

/** Delay an extension filesystem retry without blocking the event loop. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Ensure an installed extension carries an ESM package boundary marker. */
export const ensureExtensionModuleTypeMarker = async (
  destinationDirectory: string,
): Promise<void> => {
  const markerPath = path.join(destinationDirectory, "package.json");
  if (await pathExists(markerPath)) {
    return;
  }
  await fs.writeFile(
    markerPath,
    `${JSON.stringify({ type: "module" }, null, 2)}\n`,
    "utf8",
  );
};

/** Resolve a possibly partial extension destination through every existing symlink segment. */
export const resolveCanonicalExtensionInstallDestination = async (
  destinationDirectory: string,
): Promise<string> => {
  const resolvedDestination = path.resolve(destinationDirectory);
  const destinationParent = path.dirname(resolvedDestination);
  const destinationRoot = path.parse(destinationParent).root;
  let canonicalDestinationParent = await fs
    .realpath(destinationRoot)
    .catch(() => destinationRoot);
  const relativeDestinationParent = path.relative(
    destinationRoot,
    destinationParent,
  );
  const destinationSegments =
    relativeDestinationParent === ""
      ? []
      : relativeDestinationParent.split(path.sep);
  for (const [index, segment] of destinationSegments.entries()) {
    const candidate = path.join(canonicalDestinationParent, segment);
    try {
      canonicalDestinationParent = await fs.realpath(candidate);
    } catch {
      canonicalDestinationParent = path.join(
        canonicalDestinationParent,
        ...destinationSegments.slice(index),
      );
      break;
    }
  }
  return path.join(
    canonicalDestinationParent,
    path.basename(resolvedDestination),
  );
};

/** Copy an extension without recursively copying a destination nested below its source. */
export const copyExtensionDirectoryWithoutSelfNesting = async (
  sourceDirectory: string,
  destinationDirectory: string,
  copyDirectory: typeof fs.cp,
  temporaryDirectory = os.tmpdir(),
): Promise<void> => {
  const resolvedSource = path.resolve(sourceDirectory);
  const canonicalSource = await fs
    .realpath(resolvedSource)
    .catch(() => resolvedSource);
  const canonicalDestination =
    await resolveCanonicalExtensionInstallDestination(destinationDirectory);
  if (canonicalSource === canonicalDestination) {
    return;
  }
  if (!isPathWithinDirectory(canonicalSource, canonicalDestination)) {
    await copyDirectory(sourceDirectory, destinationDirectory, {
      recursive: true,
      force: true,
    });
    return;
  }

  const systemTempDirectory = path.resolve(temporaryDirectory);
  const stagingBase = isPathWithinDirectory(
    canonicalSource,
    systemTempDirectory,
  )
    ? path.dirname(canonicalSource)
    : systemTempDirectory;
  if (isPathWithinDirectory(canonicalSource, stagingBase)) {
    throw new PmCliError(
      `Extension source "${sourceDirectory}" contains its install destination and no external staging directory is available. Install a narrower package directory instead.`,
      EXIT_CODE.USAGE,
      { code: "extension_install_source_contains_destination" },
    );
  }
  const stagingRoot = await fs.mkdtemp(
    path.join(stagingBase, "pm-extension-copy-"),
  );
  const stagedDirectory = path.join(stagingRoot, "extension");
  try {
    await copyDirectory(sourceDirectory, stagedDirectory, {
      recursive: true,
      force: true,
    });
    await copyDirectory(stagedDirectory, destinationDirectory, {
      recursive: true,
      force: true,
    });
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
};

/** Copy one extension directory with bounded transient-race retries. */
export const copyExtensionDirectoryForInstall = async (
  sourceDirectory: string,
  destinationDirectory: string,
  copyDirectory: typeof fs.cp = fs.cp,
): Promise<void> => {
  for (
    let attempt = 1;
    attempt <= EXTENSION_INSTALL_COPY_ATTEMPTS;
    attempt += 1
  ) {
    try {
      await fs.rm(destinationDirectory, { recursive: true, force: true });
      await copyExtensionDirectoryWithoutSelfNesting(
        sourceDirectory,
        destinationDirectory,
        copyDirectory,
      );
      return;
    } catch (error: unknown) {
      if (
        !isRetriableExtensionInstallCopyError(error) ||
        attempt === EXTENSION_INSTALL_COPY_ATTEMPTS
      ) {
        throw error;
      }
      await sleep(EXTENSION_INSTALL_LOCK_DELAY_MS);
    }
  }
};

/** Read the unique owner token recorded for one extension scope lock. */
const readExtensionInstallLockOwnerToken = async (
  lockPath: string,
): Promise<string | null> => {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(lockPath, "owner.json"), "utf8"),
    ) as Record<string, unknown>;
    return typeof parsed.token === "string" && parsed.token.length > 0
      ? parsed.token
      : null;
  } catch {
    return null;
  }
};

/** Remove an extension scope lock only while its persisted owner token still matches. */
const removeExtensionInstallLockIfOwned = async (
  lockPath: string,
  ownerToken: string,
): Promise<boolean> => {
  const currentOwnerToken = await readExtensionInstallLockOwnerToken(lockPath);
  if (currentOwnerToken !== ownerToken) {
    return false;
  }
  await fs.rm(lockPath, { recursive: true, force: true });
  return true;
};

/** Reclaim an expired extension scope lock when its persisted owner remains unchanged. */
const reclaimStaleExtensionInstallLock = async (
  lockPath: string,
  staleMs: number,
): Promise<boolean> => {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(lockPath);
  } catch {
    return false;
  }
  if (Date.now() - stat.mtimeMs <= staleMs) {
    return false;
  }
  const staleOwnerToken = await readExtensionInstallLockOwnerToken(lockPath);
  return staleOwnerToken === null
    ? false
    : removeExtensionInstallLockIfOwned(lockPath, staleOwnerToken);
};

/** Start an owner-bound lease heartbeat and return an async stop barrier. */
const startExtensionInstallLockHeartbeat = (
  lockPath: string,
  ownerToken: string,
  intervalMs: number,
): (() => Promise<void>) => {
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat
      .then(async () => {
        if (
          (await readExtensionInstallLockOwnerToken(lockPath)) !== ownerToken
        ) {
          return;
        }
        const heartbeatAt = new Date();
        await fs.utimes(lockPath, heartbeatAt, heartbeatAt);
      })
      .catch(() => undefined);
  }, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await heartbeat;
  };
};

/** Create one owner-bound extension install lock, removing partial state on failure. */
const createExtensionInstallLock = async (
  lockPath: string,
  owner: ExtensionInstallLockOwner,
): Promise<void> => {
  await fs.mkdir(lockPath);
  try {
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify(owner, null, 2)}\n`,
      "utf8",
    );
  } catch (error: unknown) {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
};

/** Retry owner-bound extension lock acquisition while reclaiming stale owners. */
const acquireExtensionInstallLock = async (
  lockPath: string,
  owner: ExtensionInstallLockOwner,
  attempts: number,
  delayMs: number,
  staleMs: number,
): Promise<boolean> => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await createExtensionInstallLock(lockPath, owner);
      return true;
    } catch (error: unknown) {
      if (!isErrnoCode(error, "EEXIST")) {
        throw error;
      }
      if (!(await reclaimStaleExtensionInstallLock(lockPath, staleMs))) {
        await sleep(delayMs);
      }
    }
  }
  return false;
};

/** Run one operation under an owner-bound extension install lock and heartbeat lease. */
export const withExtensionInstallLock = async <T>(
  settingsRoot: string,
  destinationDirectoryName: string,
  run: () => Promise<T>,
  options?: ExtensionInstallLockOptions,
): Promise<T> => {
  const lockRoot = path.join(
    settingsRoot,
    "runtime",
    "extension-install-locks",
  );
  const lockPath = path.join(lockRoot, "scope.lock");
  await fs.mkdir(lockRoot, { recursive: true });
  const {
    attempts: rawAttempts = EXTENSION_INSTALL_LOCK_ATTEMPTS,
    delay_ms: rawDelayMs = EXTENSION_INSTALL_LOCK_DELAY_MS,
    stale_ms: rawStaleMs = EXTENSION_INSTALL_LOCK_STALE_MS,
    heartbeat_ms: rawHeartbeatMs,
  } = options ?? {};
  const attempts = Math.max(1, Math.floor(rawAttempts));
  const delayMs = Math.max(0, Math.floor(rawDelayMs));
  const staleMs = Math.max(0, Math.floor(rawStaleMs));
  const heartbeatMs = Math.max(
    1,
    Math.floor(rawHeartbeatMs ?? Math.max(1, staleMs / 3)),
  );
  const owner: ExtensionInstallLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    created_at: nowIso(),
    destination: destinationDirectoryName,
  };
  const acquired = await acquireExtensionInstallLock(
    lockPath,
    owner,
    attempts,
    delayMs,
    staleMs,
  );
  if (!acquired) {
    throw new PmCliError(
      `Timed out waiting for extension install lock for "${destinationDirectoryName}".`,
      EXIT_CODE.CONFLICT,
    );
  }

  const stopHeartbeat = startExtensionInstallLockHeartbeat(
    lockPath,
    owner.token,
    heartbeatMs,
  );
  try {
    return await run();
  } finally {
    await stopHeartbeat();
    await removeExtensionInstallLockIfOwned(lockPath, owner.token).catch(
      () => false,
    );
  }
};
