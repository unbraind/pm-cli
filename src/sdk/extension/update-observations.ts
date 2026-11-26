/**
 * @module sdk/extension/update-observations
 *
 * The last registry freshness a `pm package manage` check observed, kept as
 * derived, untracked runtime state so offline reads (`pm context`, `pm package
 * list`) can say which installed packages have a known update without making a
 * network call (pm-gh1778). Managed install records stay untouched: diagnostics
 * never persist remote evidence into `.managed-extensions.json`.
 *
 * An observation describes one installation: the manifest version and the
 * managed record's `updated_at` it was taken against. Any install, upgrade or
 * reinstall rewrites that record, so it retires the observation, including a
 * commit-only upgrade of a repository source that keeps its manifest version.
 */
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isReproducibleExecutionActive } from "../../core/reproducibility/context.js";
import { acquireLockLease } from "../../core/lock/lock.js";
import { writeFileAtomic } from "../../core/fs/fs-utils.js";
import { normalizeManagedState, resolveManagedExtensionStatePath, type ManagedExtensionRecord } from "./managed-state.js";
import { isFileMissingError } from "../../core/fs/fs-utils.js";
import { isExactNpmVersion, isNewerRegistryVersion, isRegistryNpmSource } from "./npm-spec.js";
import { normalizeExtensionNameForMatch } from "./shared.js";

/** File name of the observation record under a scope's `runtime/` directory. */
export const EXTENSION_UPDATE_OBSERVATIONS_FILE = "extension-update-observations.json";

/** Envelope version of the observation record. */
const OBSERVATIONS_RECORD_VERSION = 1;

/** Size of each read of a guarded file; a small file never allocates its ceiling. */
const READ_CHUNK_BYTES = 64 * 1024;

/** Ceiling for the managed install state read while merging (its contribution maps make it the largest input). */
const MAX_MANAGED_STATE_BYTES = 16 * 1024 * 1024;

/** A record larger than this is not one pm wrote, so it reads as no knowledge. */
const MAX_OBSERVATIONS_BYTES = 1024 * 1024;

/** How far in the future a recorded check time may lie before it reads as a clock error. */
const MAX_FUTURE_CHECK_SKEW_MS = 5 * 60 * 1000;

/** How long a manage check waits for a concurrent check's merge before warning instead. */
const OBSERVATION_LOCK_WAIT_MS = 2_000;

/** One registry check outcome for one installed package. */
export interface ExtensionUpdateObservation {
  /** Manifest name of the package that was checked. */
  name: string;
  /** Installed manifest version the check compared against. */
  installed_version: string;
  /** `updated_at` of the managed install record the check compared against. */
  installed_updated_at: string;
  /** Registry version the check saw, or the short remote commit for a repository source; null when the provider reports neither. */
  remote_version: string | null;
  /** Whether the check found a newer release. */
  update_available: boolean;
  /** ISO 8601 time of the check. */
  checked_at: string;
}

/** The installation an observation must still describe to apply. */
export interface ExtensionInstallationIdentity {
  /** Manifest name. */
  name: string;
  /** Installed manifest version, when the manifest is readable. */
  version: string | null | undefined;
  /** `updated_at` of the current managed install record, when the package is managed. */
  updated_at: string | undefined;
  /** Source of the current managed install record; when given, a cached verdict must be consistent with it. */
  source?: ManagedExtensionRecord["source"];
}

/** Path of the observation record for a scope root (`.agents/pm` or the global pm root). */
export function resolveExtensionUpdateObservationsPath(scopeRoot: string): string {
  return path.join(scopeRoot, "runtime", EXTENSION_UPDATE_OBSERVATIONS_FILE);
}

/** Longest field value pm writes (package names, versions, commits and ISO times are far shorter). */
const MAX_OBSERVATION_FIELD_LENGTH = 256;

/**
 * A non-empty string field of a row within the field bound, or undefined. The bound
 * keeps one corrupt row from filling the record and blocking every later merge
 * (Codex review round 7).
 */
function readRowText(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.length > 0 && value.length <= MAX_OBSERVATION_FIELD_LENGTH ? value : undefined;
}

/**
 * Whether a recorded check time can order observations: it must parse, and lie no
 * further in the future than the clock-skew tolerance (a check saved while the
 * clock ran ahead would otherwise outrank every later check).
 */
function isUsableCheckTime(checkedAt: string): boolean {
  const checkedAtMs = Date.parse(checkedAt);
  return Number.isFinite(checkedAtMs) && checkedAtMs <= Date.now() + MAX_FUTURE_CHECK_SKEW_MS;
}

/** The remote version of a row: a non-empty string or null, or undefined when the value is not one pm writes. */
function readRowRemoteVersion(row: Record<string, unknown>): string | null | undefined {
  if (row.remote_version === undefined || row.remote_version === null) return null;
  return readRowText(row, "remote_version");
}

/** Keep only well-formed rows; a malformed record reads as no knowledge, never as a refusal. */
function parseObservation(value: unknown): ExtensionUpdateObservation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const name = readRowText(row, "name");
  const installedVersion = readRowText(row, "installed_version");
  const installedUpdatedAt = readRowText(row, "installed_updated_at");
  const checkedAt = readRowText(row, "checked_at");
  const remoteVersion = readRowRemoteVersion(row);
  if (name === undefined || installedVersion === undefined || installedUpdatedAt === undefined || remoteVersion === undefined) return undefined;
  if (checkedAt === undefined || !isUsableCheckTime(checkedAt) || typeof row.update_available !== "boolean") return undefined;
  return {
    name,
    installed_version: installedVersion,
    installed_updated_at: installedUpdatedAt,
    remote_version: remoteVersion,
    update_available: row.update_available,
    checked_at: checkedAt,
  };
}

/** The core lock's stale-cleanup gate directory suffix, whose owner.json the lock reads while reclaiming. */
const STALE_CLEANUP_GATE_SUFFIX = ".stale-cleanup";

/** Lock metadata pm writes is a few hundred bytes; anything far larger is not lock state the core lease should read whole. */
const MAX_LOCK_METADATA_BYTES = 64 * 1024;

/** Whether a lock metadata path exists as something the core lease must not read: not a regular file, or oversized. */
async function isUnsafeLockMetadata(target: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(target);
    return !stat.isFile() || stat.size > MAX_LOCK_METADATA_BYTES;
  } catch {
    return false;
  }
}

/** Whether a path exists as something other than a real directory (a link, a file, a FIFO). */
async function isNonDirectoryEntry(target: string): Promise<boolean> {
  try {
    return !(await fs.lstat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read the observations recorded for a scope. Only a bounded regular file in a
 * real `runtime/` directory is read: a link, a FIFO or an oversized file yields
 * no knowledge rather than a read outside the scope or a hang, and so does an
 * absent, unreadable or malformed record.
 */
export async function readExtensionUpdateObservations(scopeRoot: string): Promise<ExtensionUpdateObservation[]> {
  const file = resolveExtensionUpdateObservationsPath(scopeRoot);
  try {
    if (await isNonDirectoryEntry(path.dirname(file))) return [];
    const raw = await readBoundedRegularFile(file, MAX_OBSERVATIONS_BYTES);
    if (raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    // Only the envelope version this reader understands is read; another version reads as no knowledge.
    const envelope = typeof parsed === "object" && parsed !== null ? (parsed as { version?: unknown; observations?: unknown }) : {};
    const rows = envelope.version === OBSERVATIONS_RECORD_VERSION && Array.isArray(envelope.observations) ? envelope.observations : [];
    return rows.flatMap((row) => parseObservation(row) ?? []);
  } catch {
    return [];
  }
}

/** Open flags that never block on a FIFO and, unless links are followed, never follow a final link, where the platform defines them (Windows has neither). */
export function resolveGuardedReadFlags(
  constants: { O_RDONLY: number; O_NOFOLLOW?: number; O_NONBLOCK?: number } = fsConstants,
  followLinks = false,
): number {
  return constants.O_RDONLY | (followLinks ? 0 : (constants.O_NOFOLLOW ?? 0)) | (constants.O_NONBLOCK ?? 0);
}

/**
 * Read a file only when the entry and the opened descriptor are a regular file within the byte
 * limit. The open neither follows a final link nor blocks on a FIFO where the
 * platform supports it, and the checks run on the descriptor, so a file swapped
 * after a path check cannot widen the read.
 */
export async function readBoundedRegularFile(file: string, limit: number, options: { followLinks?: boolean } = {}): Promise<string | undefined> {
  // The entry itself must be a regular file: where O_NOFOLLOW is undefined (Windows) the open would follow a final link.
  // A caller that honors links (installed manifests, as the runtime loader does) still gets a non-blocking, bounded read.
  if (options.followLinks !== true && !(await fs.lstat(file)).isFile()) return undefined;
  const handle = await fs.open(file, resolveGuardedReadFlags(fsConstants, options.followLinks === true));
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    // Read until end of file in bounded chunks, since one read may return fewer bytes (network filesystems) and a
    // small file should not allocate the whole ceiling (CodeRabbit review round 8); one byte past the limit proves
    // the file is too large, however it changed since it was opened.
    // One scratch buffer is reused, and only the bytes each read returned are kept, so many short reads never pin
    // a full chunk apiece (Greptile review round 9).
    const scratch = Buffer.alloc(Math.min(READ_CHUNK_BYTES, limit + 1));
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= limit) {
      const { bytesRead } = await handle.read(scratch, 0, Math.min(scratch.length, limit + 1 - total), total);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
      total += bytesRead;
    }
    return total > limit ? undefined : Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Project the managed entries a freshness check just settled into observations:
 * an entry counts only when the provider answered (a check time, no error and a
 * boolean verdict), so a timed-out or failed lookup never reads as up to date.
 */
export function collectExtensionUpdateObservations(entries: readonly ManagedExtensionRecord[]): ExtensionUpdateObservation[] {
  return entries
    .flatMap((entry) =>
      // Only sources a check actually queries are recorded: a GitHub repository or a registry npm package. A local
      // artifact is reinstalled as it is, and a stale verdict left on a record the refresh skips is not an answer.
      typeof entry.last_update_check_at === "string" && entry.update_error === undefined && typeof entry.update_available === "boolean" &&
      (entry.source.kind === "github" || isRegistryNpmSource(entry.source)) &&
      // The writer applies the reader's field bound, so a row the reader would drop is never written (Codex review round 10).
      [entry.name, entry.manifest_version, entry.updated_at, entry.last_update_remote_version ?? ""].every((value) => value.length <= MAX_OBSERVATION_FIELD_LENGTH)
        ? [{
            name: entry.name,
            installed_version: entry.manifest_version,
            installed_updated_at: entry.updated_at,
            remote_version: entry.last_update_remote_version ?? entry.last_update_remote_commit?.slice(0, 12) ?? null,
            // The provider's verdict already applies SemVer precedence, so manage and the offline readers agree.
            update_available: entry.update_available,
            checked_at: entry.last_update_check_at,
          }]
        : [])
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The managed install records of a scope when every entry is valid, else
 * undefined. The shared state reader drops a malformed entry silently; pruning
 * against such a partial snapshot would delete that package's observation, and
 * reporting from it would disagree with the static inventory, which marks the
 * file invalid (Codex review round 6). An absent file is a valid empty snapshot.
 */
export async function readStrictManagedRecords(extensionsRoot: string): Promise<ManagedExtensionRecord[] | undefined> {
  // Parse, normalize and count the same bytes, so a file replaced between two reads can never pass (Codex review round 7),
  // read through the guarded bounded reader, so a FIFO or endless stream never holds the observation lease (round 11).
  let raw: string | undefined;
  try {
    // Follows links like the static inventory, so both offline readers judge the same file the same way (round 15).
    raw = await readBoundedRegularFile(resolveManagedExtensionStatePath(extensionsRoot), MAX_MANAGED_STATE_BYTES, { followLinks: true });
  } catch (error: unknown) {
    return isFileMissingError(error) ? [] : undefined;
  }
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const normalized = normalizeManagedState(parsed);
    const declared = (parsed as { entries?: unknown }).entries;
    return normalized !== null && Array.isArray(declared) && declared.length === normalized.entries.length ? normalized.entries : undefined;
  } catch {
    return undefined;
  }
}

/** The latest observation for each installation (name, manifest version, managed record) among candidates. */
function latestPerInstallation(candidates: readonly ExtensionUpdateObservation[]): ExtensionUpdateObservation[] {
  const latest = new Map<string, ExtensionUpdateObservation>();
  for (const entry of candidates) {
    const key = `${normalizeExtensionNameForMatch(entry.name)}\u0000${entry.installed_version}\u0000${entry.installed_updated_at}`;
    const current = latest.get(key);
    if (current === undefined || Date.parse(current.checked_at) <= Date.parse(entry.checked_at)) latest.set(key, entry);
  }
  return [...latest.values()];
}

/** Whether an observation was taken against this managed installation. */
function describesInstallation(entry: ExtensionUpdateObservation, record: ManagedExtensionRecord): boolean {
  return normalizeExtensionNameForMatch(entry.name) === normalizeExtensionNameForMatch(record.name) &&
    entry.installed_version === record.manifest_version &&
    entry.installed_updated_at === record.updated_at;
}

/**
 * Merge a check's observations into a scope's record. Under a per-scope lock the
 * record is rebuilt from the managed state on disk at that moment: each current
 * installation keeps the latest observation taken against it, from this check
 * or an earlier one, and everything else is dropped. So two concurrent checks
 * keep each other's answers, an answer for an installation that has since been
 * replaced never displaces one for the current installation, and the record
 * never outgrows the managed packages it describes. The record is written only
 * into a real `runtime/` directory, never through a link.
 */
export async function recordExtensionUpdateObservations(
  scopeRoot: string,
  extensionsRoot: string,
  observations: readonly ExtensionUpdateObservation[],
): Promise<void> {
  if (observations.length === 0) return;
  const file = resolveExtensionUpdateObservationsPath(scopeRoot);
  const assertRuntimeDirectory = async (): Promise<void> => {
    if (await isNonDirectoryEntry(path.dirname(file))) throw new Error(`${path.dirname(file)} is not a directory`);
  };
  await assertRuntimeDirectory();
  // maxWaitMs caps the wait even when PM_LOCK_WAIT_MS asks for longer: this derived write must never stall a manage call.
  // The core lock readers block on a FIFO and read a file whole, so a lock file or stale-cleanup gate owner file that
  // is not a small regular file refuses this derived write up front instead of hanging or exhausting memory after a
  // successful check (Codex review rounds 15, 17 and 18).
  const lockPath = path.join(scopeRoot, "locks", "extension-update-observations.lock");
  for (const metadata of [lockPath, path.join(`${lockPath}${STALE_CLEANUP_GATE_SUFFIX}`, "owner.json")]) {
    if (await isUnsafeLockMetadata(metadata)) throw new Error("update observation lock metadata is not a small regular file");
  }
  // An expired lease of an interrupted check may be reclaimed (as session state does): the cache is derived, and the
  // commit fence below keeps a resumed stale holder from overwriting its successor (Codex review round 12).
  const lease = await acquireLockLease(scopeRoot, "extension-update-observations", 30, "pm package manage", false, false, OBSERVATION_LOCK_WAIT_MS, { maxWaitMs: OBSERVATION_LOCK_WAIT_MS });
  try {
    await assertRuntimeDirectory();
    const candidates = [...(await readExtensionUpdateObservations(scopeRoot)), ...observations];
    const records = await readStrictManagedRecords(extensionsRoot);
    const rows = (records === undefined
      // Managed state unreadable at this moment (a lifecycle write in progress): keep every answer, the latest per
      // installation, and leave pruning to the next merge that reads a complete snapshot (Codex review round 5).
      ? latestPerInstallation(candidates)
      // A candidate the current source could not have produced never wins the newest-first pick (Codex review round 15).
      : records.flatMap((record) => latestPerInstallation(candidates.filter((entry) => describesInstallation(entry, record) && isConsistentWithSource(entry, record.source))))
    ).sort((left, right) => left.name.localeCompare(right.name));
    const serialized = `${JSON.stringify({ version: OBSERVATIONS_RECORD_VERSION, observations: rows }, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_OBSERVATIONS_BYTES) throw new Error("update observation record exceeds its size limit");
    // Publish only while this lease still owns the lock: a writer whose expired lease was reclaimed refuses with
    // lock_lost instead of overwriting the newer answers its successor saved (Codex review round 10).
    await lease.fence(() => writeFileAtomic(file, serialized));
  } finally {
    await lease.release();
  }
}

/**
 * Record what a manage freshness check settled for one scope. An offline check
 * learned nothing and records nothing. Returns the warning code when the
 * derived record could not be written, so the check itself never fails on it.
 */
export async function recordCheckedUpdateObservations(
  scopeRoot: string,
  extensionsRoot: string,
  entries: readonly ManagedExtensionRecord[],
  offline: boolean,
): Promise<string | undefined> {
  // A pinned reproducible clock stamps check times that cannot order a wall-clock cache, nor tell two installs
  // apart that share a pinned updated_at, so such a run records nothing (Codex review round 16).
  if (offline || isReproducibleExecutionActive()) return undefined;
  try {
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot, collectExtensionUpdateObservations(entries));
    return undefined;
  } catch (error: unknown) {
    // Keep the typed reason (a stale lock left by a crashed process, say), so its own recovery guidance applies.
    const code = (error as { context?: { code?: unknown } } | null)?.context?.code;
    return typeof code === "string" && code.length > 0 ? `extension_update_observation_write_failed:${code}` : "extension_update_observation_write_failed";
  }
}

/** The observation that still describes an installation: same name, same manifest version, same managed record. */
export function findApplicableUpdateObservation(
  observations: readonly ExtensionUpdateObservation[],
  installation: ExtensionInstallationIdentity,
): ExtensionUpdateObservation | undefined {
  if (typeof installation.version !== "string" || installation.updated_at === undefined) return undefined;
  const key = normalizeExtensionNameForMatch(installation.name);
  // The newest valid row wins, as in the writer's merge, so a restored or edited cache with two rows for one
  // installation never lets an older or incompatible row mask a newer answer (Codex review round 16).
  return latestPerInstallation(observations.filter((entry) =>
    normalizeExtensionNameForMatch(entry.name) === key &&
    entry.installed_version === installation.version &&
    entry.installed_updated_at === installation.updated_at &&
    isConsistentWithSource(entry, installation.source)))[0];
}

/**
 * Whether a cached verdict is one a check of this source could have produced, so an edited or corrupt row
 * never marks a local artifact updatable or an older npm release newer (Codex review round 12): only GitHub
 * and registry npm sources are checked, and an npm "update" must be newer under SemVer precedence.
 */
function isConsistentWithSource(observation: ExtensionUpdateObservation, source: ManagedExtensionRecord["source"] | undefined): boolean {
  if (source === undefined || observation.update_available === false) return true;
  // A positive repository check always records the short hexadecimal remote commit; anything else, a missing commit
  // included, is not one it produced (Codex review round 14, CodeRabbit review round 10).
  if (source.kind === "github") return observation.remote_version !== null && /^[0-9a-f]{7,40}$/u.test(observation.remote_version);
  if (!isRegistryNpmSource(source)) return false;
  // A registry version the live check would refuse is not one it produced (Codex review rounds 13 and 14).
  return observation.remote_version !== null && isExactNpmVersion(observation.remote_version) &&
    isNewerRegistryVersion(observation.remote_version, source.version ?? observation.installed_version);
}

/** The newer version an applicable observation reports (`available` when the provider named none), or null when none is known. */
export function resolveObservedUpdateVersion(observation: ExtensionUpdateObservation | undefined): string | null {
  return observation?.update_available === true ? (observation.remote_version ?? "available") : null;
}
