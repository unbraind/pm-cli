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
import fs from "node:fs/promises";
import path from "node:path";
import { acquireLock } from "../../core/lock/lock.js";
import { compareComparableVersions } from "../../core/extensions/version-compat.js";
import { writeFileAtomic } from "../../core/fs/fs-utils.js";
import type { ManagedExtensionRecord } from "./managed-state.js";
import { normalizeExtensionNameForMatch } from "./shared.js";

/** File name of the observation record under a scope's `runtime/` directory. */
export const EXTENSION_UPDATE_OBSERVATIONS_FILE = "extension-update-observations.json";

/** A record larger than this is not one pm wrote, so it reads as no knowledge. */
const MAX_OBSERVATIONS_BYTES = 1024 * 1024;

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
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_OBSERVATIONS_BYTES) return [];
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    const rows = typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { observations?: unknown }).observations)
      ? (parsed as { observations: unknown[] }).observations
      : [];
    return rows.flatMap((row) => parseObservation(row) ?? []);
  } catch {
    return [];
  }
}

/**
 * Whether a check that reported "available" saw a release that is actually
 * newer. A registry `latest` older than (or equal to) the installed version is
 * no update: following the upgrade hint would downgrade. Versions that do not
 * compare, and repository sources that report only a commit, keep the
 * provider's verdict.
 */
function isNewerRelease(installedVersion: string, remoteVersion: string | undefined): boolean {
  const order = remoteVersion === undefined ? null : compareComparableVersions(remoteVersion, installedVersion);
  return order === null || order === 1;
}

/**
 * Project the managed entries a freshness check just settled into observations:
 * an entry counts only when the provider answered (a check time, no error and a
 * boolean verdict), so a timed-out or failed lookup never reads as up to date.
 */
export function collectExtensionUpdateObservations(entries: readonly ManagedExtensionRecord[]): ExtensionUpdateObservation[] {
  return entries
    .flatMap((entry) =>
      typeof entry.last_update_check_at === "string" && entry.update_error === undefined && typeof entry.update_available === "boolean"
        ? [{
            name: entry.name,
            installed_version: entry.manifest_version,
            installed_updated_at: entry.updated_at,
            remote_version: entry.last_update_remote_version ?? entry.last_update_remote_commit?.slice(0, 12) ?? null,
            update_available: entry.update_available && isNewerRelease(entry.manifest_version, entry.last_update_remote_version),
            checked_at: entry.last_update_check_at,
          }]
        : [])
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Merge a check's observations into a scope's record under a per-scope lock, so
 * two concurrent checks never drop each other's answers. Packages the check did
 * not answer for keep their earlier observation, and when both name the same
 * package the later check wins. The record is written only into a real
 * `runtime/` directory, never through a link.
 */
export async function recordExtensionUpdateObservations(scopeRoot: string, observations: readonly ExtensionUpdateObservation[]): Promise<void> {
  if (observations.length === 0) return;
  const file = resolveExtensionUpdateObservationsPath(scopeRoot);
  if (await isNonDirectoryEntry(path.dirname(file))) {
    throw new Error(`${path.dirname(file)} is not a directory`);
  }
  const release = await acquireLock(scopeRoot, "extension-update-observations", 30, "pm package manage", false, true, OBSERVATION_LOCK_WAIT_MS);
  try {
    const merged = new Map<string, ExtensionUpdateObservation>();
    for (const entry of [...(await readExtensionUpdateObservations(scopeRoot)), ...observations]) {
      const key = normalizeExtensionNameForMatch(entry.name);
      const current = merged.get(key);
      if (current === undefined || current.checked_at <= entry.checked_at) merged.set(key, entry);
    }
    const rows = [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
    await writeFileAtomic(file, `${JSON.stringify({ version: 1, observations: rows }, null, 2)}\n`);
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
  entries: readonly ManagedExtensionRecord[],
  offline: boolean,
): Promise<string | undefined> {
  if (offline) return undefined;
  try {
    await recordExtensionUpdateObservations(scopeRoot, collectExtensionUpdateObservations(entries));
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
