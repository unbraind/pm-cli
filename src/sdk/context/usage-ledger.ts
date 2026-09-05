/**
 * @module sdk/context/usage-ledger
 *
 * Bounds derived feedback reads and writes in bytes. High-water compaction
 * retains a half-full suffix under the same lock as append, leaving headroom
 * for subsequent serves without rewriting on every context request.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { isFileMissingError } from "../../core/fs/fs-utils.js";
import { acquireLock } from "../../core/lock/lock.js";
import type { ContextUsageEvent, ContextUsageLedgerOptions } from "../context-usage.js";

/** Public storage and sampling ceilings shared by every feedback producer. */
export const CONTEXT_USAGE_LIMITS = {
  max_serving_rows: 256,
  max_bytes: 262_144,
  max_event_bytes: 32_768,
  retained_byte_fraction: 0.5,
  max_events: 2_048,
  retention_days: 30,
} as const;

/** Measured persistence work for one lock-protected feedback write. */
export interface ContextUsageWriteReceipt {
  /** Bytes written to the append or replacement file; excludes lock metadata. */
  written_bytes: number;
  /** Physical ledger size at the end of the protected write. */
  ledger_bytes: number;
  /** Whether this write replaced the ledger with a retained suffix. */
  compacted: boolean;
  /** Wall-clock time waiting to acquire the cross-process ledger lock. */
  lock_wait_ms: number;
}

/** Named validation failure emitted by context-usage SDK inputs. */
export class ContextUsageValidationError extends TypeError {
  /** Stable code for package and CLI hosts. */
  readonly code = "context_usage_validation_failed";

  /** Reject invalid feedback controls without exposing ledger contents. */
  constructor(message: string) {
    super(message);
    this.name = "ContextUsageValidationError";
  }
}

/** Normalize one timestamp so filtering and serialization share the same clock. */
export function resolveNow(options: ContextUsageLedgerOptions): { iso: string; ms: number } {
  const ms = Date.parse(options.now ?? new Date().toISOString());
  if (!Number.isFinite(ms)) throw new ContextUsageValidationError("Context usage now must be a valid timestamp");
  return { iso: new Date(ms).toISOString(), ms };
}

/** Resolve checked byte, count and time bounds before touching storage. */
function bounds(options: ContextUsageLedgerOptions) {
  const maxBytes = options.maxBytes ?? CONTEXT_USAGE_LIMITS.max_bytes;
  const maxEvents = options.maxEvents ?? CONTEXT_USAGE_LIMITS.max_events;
  const retentionDays = options.retentionDays ?? CONTEXT_USAGE_LIMITS.retention_days;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > CONTEXT_USAGE_LIMITS.max_bytes ||
      !Number.isSafeInteger(maxEvents) || maxEvents < 1 || !Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new ContextUsageValidationError("Context usage retention requires positive maxEvents and retentionDays, and maxBytes from 1024 through 262144");
  }
  return { maxBytes, maxEvents, cutoff: resolveNow(options).ms - retentionDays * 86_400_000 };
}

/** Open only a private regular ledger, refusing redirected runtime directories and file links. */
async function openLedger(target: string, flags: number) {
  if (!(await lstat(path.dirname(target))).isDirectory()) {
    throw new ContextUsageValidationError("Context usage runtime must be a real directory");
  }
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new ContextUsageValidationError("Context usage ledger must not be a symbolic link");
    }
  } catch (error) {
    if (!isFileMissingError(error)) throw error;
  }
  // Unsupported platform flags contribute zero to the numeric bit mask. The
  // lstat check also rejects existing links where no-follow is unavailable.
  const handle = await open(target, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new ContextUsageValidationError("Context usage ledger must be an unshared regular file");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Read only a bounded file suffix, dropping a partial first JSONL row. */
export async function readEvents(options: ContextUsageLedgerOptions): Promise<ContextUsageEvent[]> {
  const policy = bounds(options);
  try {
    const handle = await openLedger(path.join(options.pmRoot, "runtime", "context-usage.jsonl"), constants.O_RDONLY);
    try {
      const size = (await handle.stat()).size;
      const start = Math.max(0, size - policy.maxBytes);
      const buffer = Buffer.alloc(Math.min(size, policy.maxBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const lines = (start > 0 ? (text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "") : text).split("\n");
      return lines.flatMap((line) => {
        try {
          const event = JSON.parse(line) as ContextUsageEvent;
          return event && Date.parse(event.at) >= policy.cutoff ? [event] : [];
        } catch {
          return [];
        }
      }).slice(-policy.maxEvents);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

/** Retain a contiguous newest suffix within both byte and event-count bounds. */
function retainedText(events: readonly ContextUsageEvent[], byteLimit: number, maxEvents: number): string {
  const lines: string[] = [];
  let bytes = 0;
  for (let index = events.length - 1; index >= 0 && lines.length < maxEvents; index -= 1) {
    const line = `${JSON.stringify(events[index])}\n`;
    bytes += Buffer.byteLength(line);
    if (bytes > byteLimit) break;
    lines.push(line);
  }
  return lines.reverse().join("");
}

/**
 * Append once, or compact atomically to a half-full suffix at the high-water mark.
 * Requires trusted, stable workspace directory entries and ancestors; the lock
 * coordinates cooperating writers and cannot constrain hostile path replacement.
 */
export async function appendEvents(
  options: ContextUsageLedgerOptions,
  events: readonly ContextUsageEvent[],
  deliveryServeId?: string,
): Promise<ContextUsageWriteReceipt> {
  const policy = bounds(options);
  const target = path.join(options.pmRoot, "runtime", "context-usage.jsonl");
  const retainedBytes = Math.floor(policy.maxBytes * CONTEXT_USAGE_LIMITS.retained_byte_fraction);
  const eventLimit = Math.min(CONTEXT_USAGE_LIMITS.max_event_bytes, retainedBytes);
  if (events.some((event) => Buffer.byteLength(`${JSON.stringify(event)}\n`) > eventLimit)) {
    throw new ContextUsageValidationError("Context usage event exceeds the declared byte ceiling");
  }
  const current = events.filter((event) => Date.parse(event.at) >= policy.cutoff);
  const appended = retainedText(current, retainedBytes, policy.maxEvents);
  const lockStarted = performance.now();
  const releaseLock = await acquireLock(options.pmRoot, "context-usage-ledger", 30, `context-usage:${process.pid}`, false, false, 3_000);
  const lockWaitMs = performance.now() - lockStarted;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    let handle: FileHandle | undefined = await openLedger(target, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
    try {
      const size = (await handle.stat()).size;
      const previous = deliveryServeId === undefined ? undefined : await readEvents(options);
      if (previous?.some((event) => event.kind === "delivery" && event.serve_id === deliveryServeId)) {
        return { written_bytes: 0, ledger_bytes: size, compacted: false, lock_wait_ms: lockWaitMs };
      }
      const customRetention = options.maxEvents !== undefined || options.retentionDays !== undefined;
      if (!customRetention && size + Buffer.byteLength(appended) <= policy.maxBytes) {
        await handle.writeFile(appended, "utf8");
        return { written_bytes: Buffer.byteLength(appended), ledger_bytes: size + Buffer.byteLength(appended), compacted: false, lock_wait_ms: lockWaitMs };
      }
      const retained = retainedText([...(previous ?? await readEvents(options)), ...current], retainedBytes, policy.maxEvents);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      const replacement = await open(temporary, "wx", 0o600);
      try {
        try {
          await replacement.writeFile(retained, "utf8");
        } finally {
          await replacement.close();
        }
        // Windows cannot replace the destination while our append handle is open.
        await handle.close();
        handle = undefined;
        await rename(temporary, target);
        return { written_bytes: Buffer.byteLength(retained), ledger_bytes: Buffer.byteLength(retained), compacted: true, lock_wait_ms: lockWaitMs };
      } finally {
        await rm(temporary, { force: true });
      }
    } finally {
      await handle?.close();
    }
  } finally {
    await releaseLock();
  }
}
