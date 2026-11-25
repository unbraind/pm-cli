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
import { acquireLock } from "../../core/lock/lock.js";
import { writeFileAtomic } from "../../core/fs/fs-utils.js";
import { readManagedExtensionState, type ManagedExtensionRecord } from "./managed-state.js";
import { isRegistryNpmSource } from "./npm-spec.js";
import { normalizeExtensionNameForMatch } from "./shared.js";

/** File name of the observation record under a scope's `runtime/` directory. */
export const EXTENSION_UPDATE_OBSERVATIONS_FILE = "extension-update-observations.json";

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
}

/** Path of the observation record for a scope root (`.agents/pm` or the global pm root). */
export function resolveExtensionUpdateObservationsPath(scopeRoot: string): string {
  return path.join(scopeRoot, "runtime", EXTENSION_UPDATE_OBSERVATIONS_FILE);
}

/** Keep only well-formed rows; a malformed record reads as no knowledge, never as a refusal. */
function parseObservation(value: unknown): ExtensionUpdateObservation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const text = (key: string): string | undefined => (typeof row[key] === "string" && (row[key] as string).length > 0 ? (row[key] as string) : undefined);
  const name = text("name");
  const installedVersion = text("installed_version");
  const installedUpdatedAt = text("installed_updated_at");
  const checkedAt = text("checked_at");
  if (name === undefined || installedVersion === undefined || installedUpdatedAt === undefined || checkedAt === undefined || typeof row.update_available !== "boolean") return undefined;
  // Ordering compares check times, so a row whose time does not parse is not one pm wrote, and one dated
  // beyond the clock-skew tolerance (a check saved while the clock ran ahead) would outrank every later check.
  const checkedAtMs = Date.parse(checkedAt);
  if (!Number.isFinite(checkedAtMs) || checkedAtMs > Date.now() + MAX_FUTURE_CHECK_SKEW_MS) return undefined;
  return {
    name,
    installed_version: installedVersion,
    installed_updated_at: installedUpdatedAt,
    remote_version: text("remote_version") ?? null,
    update_available: row.update_available,
    checked_at: checkedAt,
  };
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
    const rows = typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { observations?: unknown }).observations)
      ? (parsed as { observations: unknown[] }).observations
      : [];
    return rows.flatMap((row) => parseObservation(row) ?? []);
  } catch {
    return [];
  }
}

/** Open flags that neither follow a final link nor block on a FIFO, where the platform defines them (Windows has neither). */
export function resolveGuardedReadFlags(constants: { O_RDONLY: number; O_NOFOLLOW?: number; O_NONBLOCK?: number } = fsConstants): number {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
}

/**
 * Read a file only when the opened descriptor is a regular file within the byte
 * limit. The open neither follows a final link nor blocks on a FIFO where the
 * platform supports it, and the checks run on the descriptor, so a file swapped
 * after a path check cannot widen the read.
 */
async function readBoundedRegularFile(file: string, limit: number): Promise<string | undefined> {
  // The entry itself must be a regular file: where O_NOFOLLOW is undefined (Windows) the open would follow a final link.
  if (!(await fs.lstat(file)).isFile()) return undefined;
  const handle = await fs.open(file, resolveGuardedReadFlags());
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    // Read until end of file, since one read may return fewer bytes (network filesystems); one byte past
    // the limit proves the file is too large, however it changed since it was opened.
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total <= limit) {
      const { bytesRead } = await handle.read(buffer, total, limit + 1 - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return total > limit ? undefined : buffer.subarray(0, total).toString("utf8");
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
      // A local npm artifact is reinstalled as it is, so a registry release is never an update for it.
      typeof entry.last_update_check_at === "string" && entry.update_error === undefined && typeof entry.update_available === "boolean" &&
      (entry.source.kind !== "npm" || isRegistryNpmSource(entry.source))
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
  const release = await acquireLock(scopeRoot, "extension-update-observations", 30, "pm package manage", false, true, OBSERVATION_LOCK_WAIT_MS, { maxWaitMs: OBSERVATION_LOCK_WAIT_MS });
  try {
    await assertRuntimeDirectory();
    const candidates = [...(await readExtensionUpdateObservations(scopeRoot)), ...observations];
    const rows = (await readManagedExtensionState(extensionsRoot)).state.entries.flatMap((record) => {
      const latest = candidates
        .filter((entry) => describesInstallation(entry, record))
        .sort((left, right) => Date.parse(right.checked_at) - Date.parse(left.checked_at))[0];
      return latest === undefined ? [] : [latest];
    }).sort((left, right) => left.name.localeCompare(right.name));
    const serialized = `${JSON.stringify({ version: 1, observations: rows }, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_OBSERVATIONS_BYTES) throw new Error("update observation record exceeds its size limit");
    await writeFileAtomic(file, serialized);
  } finally {
    await release();
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
  if (offline) return undefined;
  try {
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot, collectExtensionUpdateObservations(entries));
    return undefined;
  } catch {
    return "extension_update_observation_write_failed";
  }
}

/** The observation that still describes an installation: same name, same manifest version, same managed record. */
export function findApplicableUpdateObservation(
  observations: readonly ExtensionUpdateObservation[],
  installation: ExtensionInstallationIdentity,
): ExtensionUpdateObservation | undefined {
  if (typeof installation.version !== "string" || installation.updated_at === undefined) return undefined;
  const key = normalizeExtensionNameForMatch(installation.name);
  return observations.find((entry) =>
    normalizeExtensionNameForMatch(entry.name) === key &&
    entry.installed_version === installation.version &&
    entry.installed_updated_at === installation.updated_at);
}

/** The newer version an applicable observation reports (`available` when the provider named none), or null when none is known. */
export function resolveObservedUpdateVersion(observation: ExtensionUpdateObservation | undefined): string | null {
  return observation?.update_available === true ? (observation.remote_version ?? "available") : null;
}
