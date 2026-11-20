/**
 * @module core/history/stream-summary
 *
 * Derived, rebuildable per-stream timestamp bounds that let bounded history
 * readers skip streams which cannot contribute to their window (GH-1664).
 *
 * The summary is never authoritative. A recorded entry is trusted only while
 * the stream's stat signature (device, inode, size, mtime, ctime) is the one
 * observed before the read that produced it, and only when that read began
 * more than the racy window after the stream's last change. Every append,
 * replacement, repair, redaction and compaction therefore invalidates the
 * entry without any writer cooperation, the same rule Git applies to racily
 * clean index entries. A missing, unreadable or foreign summary is rebuilt by
 * the next bounded read, and persistence failures never fail that read.
 */
import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BigIntStats, Stats } from "node:fs";
import { hasActiveOnReadHooks } from "../extensions/index.js";
import { isFileMissingError, writeFileAtomic } from "../fs/fs-utils.js";
import type { HistoryEntry } from "../../types/index.js";
import type { IdentifiedHistoryStreamSnapshot } from "./read.js";

/** Tracker-relative location of the derived summary, for cleanup registries. */
export const HISTORY_STREAM_SUMMARY_RELATIVE_PATH = "runtime/history-stream-summary.json";
const SUMMARY_VERSION = 1;
const STAT_CONCURRENCY = 64;
/**
 * A change inside this window of the read that recorded an entry could leave
 * the same signature (coarse filesystem clocks, FAT's two-second mtime), so
 * such entries are not persisted and the stream is read again next time.
 */
const RACY_WINDOW_NS = 2_000_000_000n;

/**
 * Smallest stream count at which bounded readers consult the summary. Below it
 * a full read is already cheap, so no summary file is written; this mirrors
 * the metadata cache's derived-index minimum.
 */
export const HISTORY_STREAM_SUMMARY_MINIMUM_STREAMS = 500;

let minimumStreams = HISTORY_STREAM_SUMMARY_MINIMUM_STREAMS;
let wallClockMs: () => number = () => Date.now();
// Read once per summary session, never cached for the process: a long-lived
// SDK host can change its effective credentials between reads.
let readerIdentity: () => string | undefined = () => readerDigest(readerIdentityOf(process, os.userInfo));

/**
 * A fixed-length digest of the reader identity, so every record stays small
 * however many supplementary groups the account has.
 */
function readerDigest(identity: string | undefined): string | undefined {
  return identity === undefined ? undefined : createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

/** The credential sources readerIdentityOf consults; process and os in production. */
interface ReaderCredentials {
  geteuid?: () => number;
  getegid?: () => number;
  getgroups?: () => number[];
}

/**
 * The credentials this process opens files with: on POSIX the effective user
 * id, effective group id and sorted supplementary groups (sessions of one
 * user can differ in groups), elsewhere (Windows) the account name.
 * Undefined when the platform reports neither, and then no stream earns
 * trust.
 */
function readerIdentityOf(
  credentials: ReaderCredentials,
  userInfo: () => { username: string },
): string | undefined {
  try {
    if (credentials.geteuid && credentials.getegid && credentials.getgroups) {
      const groups = [...new Set(credentials.getgroups())].sort((left, right) => left - right);
      return `uid:${credentials.geteuid()}:gid:${credentials.getegid()}:groups:${groups.join(",")}`;
    }
    const { username } = userInfo();
    return username.length > 0 ? `user:${username}` : undefined;
  } catch {
    return undefined;
  }
}

/** Timestamp bounds of every entry one history stream held when it was read. */
export interface HistoryStreamBounds {
  /** Number of parsed entries in the stream. */
  count: number;
  /** Oldest canonical entry timestamp; null when no entry has one. */
  oldest: string | null;
  /** Newest canonical entry timestamp; null when no entry has one. */
  newest: string | null;
  /**
   * True when any entry timestamp is not a canonical millisecond UTC string
   * (`YYYY-MM-DDTHH:mm:ss.sssZ`), so the bounds cannot prove the stream is
   * outside a window and readers must read it.
   */
  irregular: boolean;
}

/** Why a bounded read could not use trusted bounds for a stream population. */
export type HistoryStreamSummaryFallback =
  | "summary_missing"
  | "summary_invalid"
  | "summary_stale"
  | "irregular_timestamps"
  | "read_hooks_active";

/** One read's view of the persisted summary, bound to stats taken before any stream read. */
export interface HistoryStreamSummarySession {
  /** Whether trusted bounds may be used to skip streams. */
  readonly enabled: boolean;
  /**
   * Set when the summary could not serve most of this read: it is absent or
   * unreadable, more than half of the streams lack usable regular bounds, or
   * read hooks require every stream to be read.
   */
  readonly fallback: HistoryStreamSummaryFallback | undefined;
  /** Streams without current bounds when the session opened (stale or never recorded). */
  readonly staleAtOpen: number;
  /** Bounds recorded for the stream's unchanged signature, or undefined when it must be read. */
  trusted(file: string): HistoryStreamBounds | undefined;
  /**
   * Record the bounds of a stream this read parsed completely, under the
   * identity of the open file that supplied the bytes (`snapshot.source`, the
   * stat of that handle; null when the stream was absent). Bounds are kept
   * only when the bytes read are the whole of that file, so they always
   * describe the exact revision their signature names, whatever happened to
   * the path.
   */
  record(file: string, snapshot: Pick<IdentifiedHistoryStreamSnapshot, "entries" | "raw_bytes" | "source">): void;
  /**
   * Re-stat streams this read skipped on trusted bounds, just before the read
   * finishes, and return those whose signature changed since the session
   * opened (they are no longer trusted). Reading them keeps a change that
   * completed while the read ran from being dropped; a change after this
   * check is one a complete read could also have missed.
   */
  revalidate(files: readonly string[]): Promise<string[]>;
  /** Persist changed bounds best-effort; a failure leaves the next read to rebuild. */
  commit(): Promise<void>;
}

interface StoredStream {
  signature: string;
  bounds: HistoryStreamBounds;
}

interface ObservedStream {
  signature: string;
  /** Byte size the stat reported; bytes of any other length are not recorded. */
  size: bigint;
  /** Latest of mtime and ctime, in nanoseconds since the epoch. */
  changedAtNs: bigint;
}

interface StoredSummary {
  state: "loaded" | "missing" | "invalid";
  streams: Map<string, StoredStream>;
}

const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** Days in a proleptic Gregorian month, as Date computes them. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Whether a value is a canonical millisecond UTC timestamp whose string order
 * is its time order: exactly what `new Date(Date.parse(v)).toISOString() === v`
 * accepts for the fixed `YYYY-MM-DDTHH:mm:ss.sssZ` shape, checked on the
 * calendar fields instead of a Date round trip, which dominated summary
 * rebuilds (about 256 ms per 200,000 entries).
 */
export function isCanonicalHistoryTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    Number(value.slice(11, 13)) < 24 &&
    Number(value.slice(14, 16)) < 60 &&
    Number(value.slice(17, 19)) < 60
  );
}

/** Derive the bounds a full read of one stream observed. */
export function summarizeHistoryStreamBounds(
  entries: readonly HistoryEntry[],
): HistoryStreamBounds {
  let oldest: string | null = null;
  let newest: string | null = null;
  let irregular = false;
  for (const entry of entries) {
    // The decoder accepts any JSON value per line; a non-object entry has no
    // usable timestamp, so the stream is irregular and always read in full.
    const timestamp: unknown = typeof entry === "object" && entry !== null ? (entry as { ts?: unknown }).ts : undefined;
    if (!isCanonicalHistoryTimestamp(timestamp)) {
      irregular = true;
      continue;
    }
    if (oldest === null || timestamp < oldest) oldest = timestamp;
    if (newest === null || timestamp > newest) newest = timestamp;
  }
  return { count: entries.length, oldest, newest, irregular };
}

/** Lower the engagement threshold for specs that cannot afford 500 streams. */
function setMinimumStreams(value: number): () => void {
  const previous = minimumStreams;
  minimumStreams = value;
  return () => {
    minimumStreams = previous;
  };
}

/** Replace the reader identity so specs can model another user on a shared tracker. */
function setReaderIdentity(identity: () => string | undefined): () => void {
  const previous = readerIdentity;
  readerIdentity = identity;
  return () => {
    readerIdentity = previous;
  };
}

/** Move the racy-window clock so specs can treat just-written streams as settled. */
function setWallClock(clock: () => number): () => void {
  const previous = wallClockMs;
  wallClockMs = clock;
  return () => {
    wallClockMs = previous;
  };
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function summaryPath(pmRoot: string): string {
  return path.join(pmRoot, ...HISTORY_STREAM_SUMMARY_RELATIVE_PATH.split("/"));
}

function signatureOf(stats: BigIntStats, reader: string | undefined): ObservedStream | undefined {
  // Without a stable file identity a replaced stream could reuse the old size
  // and timestamps, so filesystems that report inode 0 never earn trust.
  if (!stats.isFile() || stats.ino === 0n || reader === undefined) return undefined;
  return {
    size: stats.size,
    // The reader is part of the signature: on a shared tracker another user
    // may be able to stat a stream it cannot read, and a skipped stream must
    // not hide the complete read's permission error.
    signature: [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs, reader].join(":"),
    changedAtNs: stats.mtimeNs > stats.ctimeNs ? stats.mtimeNs : stats.ctimeNs,
  };
}

async function observeStreams(
  historyDir: string,
  files: readonly string[],
  reader: string | undefined,
): Promise<Map<string, ObservedStream>> {
  const observed = new Map<string, ObservedStream>();
  for (let start = 0; start < files.length; start += STAT_CONCURRENCY) {
    const chunk = files.slice(start, start + STAT_CONCURRENCY);
    const stats = await Promise.all(
      chunk.map((file) =>
        fs.stat(path.join(historyDir, file), { bigint: true }).catch(() => undefined),
      ),
    );
    stats.forEach((stat, index) => {
      const signature = stat === undefined ? undefined : signatureOf(stat, reader);
      if (signature !== undefined) observed.set(chunk[index]!, signature);
    });
  }
  return observed;
}

function isNullableCanonical(value: unknown): value is string | null {
  return value === null || isCanonicalHistoryTimestamp(value);
}

/**
 * Whether bounds could have been produced by summarizeHistoryStreamBounds:
 * an empty stream has no timestamps and is regular, a regular non-empty
 * stream has both, timestamps appear together and in order. A record that
 * fails this is damaged, and trusting it could hide a non-empty stream.
 */
function areConsistentBounds(bounds: HistoryStreamBounds): boolean {
  if ((bounds.oldest === null) !== (bounds.newest === null)) return false;
  if (bounds.count === 0) return bounds.oldest === null && !bounds.irregular;
  if (bounds.oldest === null) return bounds.irregular;
  return bounds.oldest <= bounds.newest!;
}

function parseStoredStream(value: unknown): StoredStream | undefined {
  if (!Array.isArray(value) || value.length !== 5) return undefined;
  const [signature, count, oldest, newest, irregular] = value as unknown[];
  if (
    typeof signature !== "string" ||
    !Number.isSafeInteger(count) ||
    (count as number) < 0 ||
    !isNullableCanonical(oldest) ||
    !isNullableCanonical(newest) ||
    typeof irregular !== "boolean"
  ) {
    return undefined;
  }
  const bounds = { count: count as number, oldest, newest, irregular };
  return areConsistentBounds(bounds) ? { signature, bounds } : undefined;
}

/** Generous per-record allowance plus envelope; a larger file is not a summary of these streams. */
function summaryByteCap(streamCount: number): number {
  return 4096 + streamCount * 1024;
}

/**
 * Whether an opened summary can be evidence for this reader: an unshared
 * regular file of plausible size and, on POSIX, owned by the effective user
 * and writable by no one else, so another account that can write runtime/
 * cannot author bounds that suppress history it may not alter.
 */
function isTrustedSummaryFile(stats: Stats, streamCount: number, euid: number | undefined): boolean {
  if (!stats.isFile() || stats.nlink !== 1 || stats.size > summaryByteCap(streamCount)) return false;
  return euid === undefined || (stats.uid === euid && (stats.mode & 0o022) === 0);
}

/** Whether runtime/ is a real directory, never a symbolic link or junction out of the tracker. */
async function hasRealRuntimeDirectory(pmRoot: string): Promise<boolean> {
  return (await fs.lstat(path.join(pmRoot, "runtime"))).isDirectory();
}

/**
 * Whether an entry other than a regular file (a link, directory, FIFO, socket
 * or device) occupies the summary path. The summary never reads through such
 * an entry and never replaces it. A missing or uninspectable entry is not one;
 * the read and write paths handle those themselves.
 */
async function hasNonRegularSummaryEntry(pmRoot: string): Promise<boolean> {
  try {
    return !(await fs.lstat(summaryPath(pmRoot))).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether no commit may ever persist the summary here: runtime/ exists but is
 * not a real directory (a link, junction or file), or a non-regular entry
 * occupies the summary path. A missing runtime/ is left to the commit.
 */
async function isSummaryUnwritable(pmRoot: string): Promise<boolean> {
  try {
    if (!(await hasRealRuntimeDirectory(pmRoot))) return true;
  } catch {
    return false;
  }
  return hasNonRegularSummaryEntry(pmRoot);
}

/**
 * Read the summary only from a trusted file inside a real runtime directory,
 * opened without following links and non-blocking, so a FIFO, device,
 * redirected directory or oversized file cannot stall or mislead a read.
 */
async function readSummaryText(pmRoot: string, streamCount: number): Promise<string> {
  if (!(await hasRealRuntimeDirectory(pmRoot))) throw new Error("runtime directory is redirected");
  // Windows has no O_NOFOLLOW, so the entry itself is checked before opening.
  if ((await fs.lstat(summaryPath(pmRoot))).isSymbolicLink()) throw new Error("history stream summary is a link");
  const handle = await fs.open(summaryPath(pmRoot), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!isTrustedSummaryFile(await handle.stat(), streamCount, process.geteuid?.())) {
      throw new Error("history stream summary is not a trusted file");
    }
    return await readAtMost(handle, summaryByteCap(streamCount));
  } finally {
    await handle.close();
  }
}

/** Read the whole file, refusing one that grew past the cap after its stat. */
async function readAtMost(handle: FileHandle, cap: number): Promise<string> {
  const buffer = Buffer.alloc(cap + 1);
  let length = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
    if (length > cap) throw new Error("history stream summary grew past its size cap");
  }
  return buffer.subarray(0, length).toString("utf8");
}

async function readStoredSummary(pmRoot: string, streamCount: number): Promise<StoredSummary> {
  let raw: string;
  try {
    raw = await readSummaryText(pmRoot, streamCount);
  } catch (error: unknown) {
    return { state: isFileMissingError(error) ? "missing" : "invalid", streams: new Map() };
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; checksum?: unknown; streams?: unknown };
    if (
      parsed.version !== SUMMARY_VERSION ||
      typeof parsed.streams !== "object" ||
      parsed.streams === null ||
      Array.isArray(parsed.streams) ||
      // A damaged value can stay well formed (a timestamp moved earlier), so
      // the persisted streams must still hash to the checksum written with them.
      parsed.checksum !== checksumOf(parsed.streams)
    ) {
      return { state: "invalid", streams: new Map() };
    }
    const streams = new Map<string, StoredStream>();
    for (const [file, value] of Object.entries(parsed.streams)) {
      const stream = parseStoredStream(value);
      if (stream === undefined) return { state: "invalid", streams: new Map() };
      streams.set(file, stream);
    }
    return { state: "loaded", streams };
  } catch {
    return { state: "invalid", streams: new Map() };
  }
}

function serializeSummary(streams: ReadonlyMap<string, StoredStream>): string {
  // Map keys are unique, so a two-way comparison is a total order here.
  const ordered = [...streams.entries()].sort(([left], [right]) =>
    left < right ? -1 : 1,
  );
  const encoded: Record<string, unknown> = {};
  for (const [file, { signature, bounds }] of ordered) {
    encoded[file] = [signature, bounds.count, bounds.oldest, bounds.newest, bounds.irregular];
  }
  return `${JSON.stringify({ version: SUMMARY_VERSION, checksum: checksumOf(encoded), streams: encoded })}\n`;
}

/** Hash the canonical serialization the writer produced; JSON round-trips it exactly. */
function checksumOf(streams: unknown): string {
  return createHash("sha256").update(JSON.stringify(streams)).digest("hex");
}

/**
 * Disclose a summary that cannot serve most of this read: absent or
 * unreadable, or more than half of the streams lack usable regular bounds,
 * because they changed since they were recorded (a checkout or bulk rewrite,
 * `summary_stale`) or hold irregular timestamps (`irregular_timestamps`),
 * whichever cause covers more streams.
 */
function summaryFallback(
  state: StoredSummary["state"],
  current: ReadonlyMap<string, StoredStream>,
  streamCount: number,
): HistoryStreamSummaryFallback | undefined {
  if (state === "missing") return "summary_missing";
  if (state === "invalid") return "summary_invalid";
  const stale = streamCount - current.size;
  let irregular = 0;
  for (const { bounds } of current.values()) if (bounds.irregular) irregular += 1;
  // Stale and irregular streams are both read in full, so they count together.
  if ((stale + irregular) * 2 <= streamCount) return undefined;
  return stale >= irregular ? "summary_stale" : "irregular_timestamps";
}

function disabledSession(fallback: HistoryStreamSummaryFallback | undefined): HistoryStreamSummarySession {
  return {
    enabled: false,
    staleAtOpen: 0,
    fallback,
    trusted: () => undefined,
    record: () => undefined,
    revalidate: async () => [],
    commit: async () => undefined,
  };
}

/**
 * Open the summary for one bounded read of `files` (stream file names in
 * `historyDir`). Stats are captured here, before the caller reads any stream,
 * so a stream changed after this call can never be recorded under its new
 * signature.
 */
export async function openHistoryStreamSummary(params: {
  pmRoot: string;
  historyDir: string;
  files: readonly string[];
}): Promise<HistoryStreamSummarySession> {
  if (params.files.length < minimumStreams) return disabledSession(undefined);
  // Read hooks observe every stream a command reads; skipping streams would
  // silence them, so extensions with read hooks keep the complete read.
  if (hasActiveOnReadHooks()) return disabledSession("read_hooks_active");
  // Bounds that may never be persisted are not worth computing: the read is
  // the complete read, without a stat pass or per-stream bounds work.
  if (await isSummaryUnwritable(params.pmRoot)) return disabledSession("summary_invalid");
  const observedAtNs = BigInt(Math.floor(wallClockMs())) * 1_000_000n;
  const reader = readerIdentity();
  const [stored, observed] = await Promise.all([
    readStoredSummary(params.pmRoot, params.files.length),
    observeStreams(params.historyDir, params.files, reader),
  ]);
  const next = new Map<string, StoredStream>();
  for (const [file, stream] of stored.streams) {
    if (observed.get(file)?.signature === stream.signature) next.set(file, stream);
  }
  // Only newly recorded bounds are worth a rewrite: stale entries already
  // fail their signature check, and are dropped whenever the file is written.
  let dirty = false;
  return {
    enabled: true,
    staleAtOpen: params.files.length - next.size,
    fallback: summaryFallback(stored.state, next, params.files.length),
    trusted: (file) => next.get(file)?.bounds,
    record: (file, { entries, raw_bytes: rawBytes, source }) => {
      const observation = source === null || rawBytes === null ? undefined : signatureOf(source, reader);
      if (observation === undefined || BigInt(rawBytes!.length) !== observation.size) return;
      // A change this close to the read could recur with the same signature.
      if (observation.changedAtNs + RACY_WINDOW_NS >= observedAtNs) return;
      const previous = next.get(file);
      if (previous?.signature === observation.signature) return;
      next.set(file, {
        signature: observation.signature,
        bounds: summarizeHistoryStreamBounds(entries),
      });
      dirty = true;
    },
    revalidate: async (files) => {
      const current = await observeStreams(params.historyDir, files, reader);
      const changed = files.filter((file) => current.get(file)?.signature !== next.get(file)?.signature);
      for (const file of changed) next.delete(file);
      return changed;
    },
    commit: async () => {
      if (!dirty) return;
      dirty = false;
      await persistSummary(params.pmRoot, next);
    },
  };
}

/** Write the summary best-effort; any failure leaves the next bounded read to rebuild it. */
async function persistSummary(pmRoot: string, streams: ReadonlyMap<string, StoredStream>): Promise<void> {
  try {
    // Only beneath an existing tracker: a tracker moved or removed during
    // the read must not be recreated as a cache-only directory tree.
    await fs.mkdir(path.join(pmRoot, "runtime")).catch((error: unknown) => {
      if (!isFileExistsError(error)) throw error;
    });
    // Never write through a redirected runtime directory, and replace only
    // a regular file: an entry that became a link, directory, FIFO or
    // socket since the read began is left alone.
    if (!(await hasRealRuntimeDirectory(pmRoot))) return;
    if (await hasNonRegularSummaryEntry(pmRoot)) return;
    // Owner-only on POSIX: the bounds describe streams other accounts may
    // not be allowed to read. Windows ignores the mode, and the file
    // inherits the runtime directory's ACL.
    await writeFileAtomic(summaryPath(pmRoot), serializeSummary(streams), { createParentDirectories: false, mode: 0o600 });
  } catch {
    // Derived bounds are an optimization: a read-only or contended runtime
    // directory leaves the next bounded read to rebuild them.
  }
}

/** Test-only seams for the engagement threshold and racy window. */
export const _testOnly = {
  areConsistentBounds,
  readAtMost,
  readerDigest,
  isTrustedSummaryFile,
  summaryByteCap,
  readerIdentityOf,
  checksumOf,
  setMinimumStreams,
  setReaderIdentity,
  setWallClock,
  signatureOf,
  RACY_WINDOW_NS,
  SUMMARY_VERSION,
  serializeSummary,
  parseStoredStream,
};
