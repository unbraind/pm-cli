/**
 * @module core/lock/lock-owner
 *
 * Proves original lock-owner liveness only within one Linux boot and PID namespace.
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

/** Stable operating-system identity for a process when the host exposes one. */
export interface ProcessIdentity {
  /** Operating-system process identifier captured with the owner record. */
  pid: number;
  /** Host process-start coordinate that distinguishes reuse of the same PID. */
  process_start_identity?: string;
}

/** Untrusted optional receipt coordinates; validate before observing host processes. */
export interface LockOwnerIdentity {
  /** PID recorded by the writer; legacy GC receipts may omit it. */
  pid?: unknown;
  /** Opaque boot and PID-namespace identity, absent on unsupported hosts. */
  host_identity?: unknown;
  /** Original process start tick, absent on legacy receipts. */
  process_start_identity?: unknown;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isErrno(error, "ESRCH")) {
      return false;
    }
    return true;
  }
}

/** Parse the kernel start tick without treating spaces in a process name as fields. */
export function parseLinuxProcessStartIdentity(raw: string): string | null {
  const closeParenIndex = raw.lastIndexOf(")");
  if (closeParenIndex < 0) return null;
  const startTime = raw
    .slice(closeParenIndex + 2)
    .trim()
    .split(/\s+/u)[19];
  return startTime !== undefined && /^\d+$/u.test(startTime) ? startTime : null;
}

/** Read the host process-start coordinate used to distinguish PID reuse. */
export async function readProcessStartIdentity(
  pid: number,
): Promise<string | null> {
  try {
    return parseLinuxProcessStartIdentity(
      await fs.readFile(`/proc/${pid}/stat`, "utf8"),
    );
  } catch {
    return null;
  }
}

/** Capture the current PID plus a host process-start coordinate when available. */
export async function captureProcessIdentity(
  pid = process.pid,
): Promise<ProcessIdentity> {
  const processStartIdentity = await readProcessStartIdentity(pid);
  return {
    pid,
    ...(processStartIdentity === null
      ? {}
      : { process_start_identity: processStartIdentity }),
  };
}

/**
 * Verify that a captured process owner still exists, with a bounded grace
 * period when the host cannot expose a reusable-PID-safe start coordinate.
 */
export async function isProcessIdentityAlive(
  identity: ProcessIdentity,
  unverifiedAgeMs: number,
  maxUnverifiedAgeMs: number,
): Promise<boolean> {
  if (!isProcessAlive(identity.pid)) return false;
  const currentStartIdentity = await readProcessStartIdentity(identity.pid);
  if (
    identity.process_start_identity !== undefined &&
    currentStartIdentity !== null
  ) {
    return currentStartIdentity === identity.process_start_identity;
  }
  return unverifiedAgeMs <= maxUnverifiedAgeMs;
}

/** Opaque same-boot, same-PID-namespace coordinate; unavailable means no early reclaim. */
export async function readLockHostIdentity(): Promise<string | null> {
  try {
    const [boot, namespace] = await Promise.all([
      fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      fs.readlink("/proc/self/ns/pid"),
    ]);
    if (!/^[a-f0-9-]{36}\s*$/u.test(boot) || !/^pid:\[\d+\]$/u.test(namespace))
      return null;
    return createHash("sha256")
      .update(`${boot.trim()}:${namespace}`)
      .digest("hex");
  } catch {
    return null;
  }
}

/** Capture only the coordinates this host can actually verify later. */
export async function captureLockOwnerIdentity(): Promise<LockOwnerIdentity> {
  const [host, start] = await Promise.all([
    readLockHostIdentity(),
    readProcessStartIdentity(process.pid),
  ]);
  return host !== null && start !== null
    ? { host_identity: host, process_start_identity: start }
    : {};
}

/** Positive proof of original-owner death; foreign, legacy, inaccessible and malformed evidence stays unknown. */
export async function inspectLockOwner(
  identity: LockOwnerIdentity | null,
): Promise<"alive" | "dead" | "unknown"> {
  if (
    !identity ||
    typeof identity.pid !== "number" ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    typeof identity.host_identity !== "string" ||
    typeof identity.process_start_identity !== "string" ||
    !/^\d+$/u.test(identity.process_start_identity)
  )
    return "unknown";
  const host = await readLockHostIdentity();
  if (host === null || host !== identity.host_identity) return "unknown";
  try {
    process.kill(identity.pid, 0);
  } catch (error: unknown) {
    return isErrno(error, "ESRCH") ? "dead" : "unknown";
  }
  const current = await readProcessStartIdentity(identity.pid);
  if (current === null) return "unknown";
  return current === identity.process_start_identity ? "alive" : "dead";
}
