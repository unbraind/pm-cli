/**
 * @module sdk/extension/update-observations
 *
 * The last registry freshness a `pm package manage` check observed, kept as
 * derived, untracked runtime state so offline reads (`pm context`, `pm package
 * list`) can say which installed packages have a known update without making a
 * network call (pm-gh1778). Managed install records stay untouched: diagnostics
 * never persist remote evidence into `.managed-extensions.json`.
 *
 * An observation applies only while the installed version it was taken against
 * is still the installed version, so an update or a reinstall retires it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../../core/fs/fs-utils.js";
import type { ManagedExtensionRecord } from "./managed-state.js";
import { normalizeExtensionNameForMatch } from "./shared.js";

/** File name of the observation record under a scope's `runtime/` directory. */
export const EXTENSION_UPDATE_OBSERVATIONS_FILE = "extension-update-observations.json";

/** One registry check outcome for one installed package. */
export interface ExtensionUpdateObservation {
  /** Manifest name of the package that was checked. */
  name: string;
  /** Installed version the check compared against. */
  installed_version: string;
  /** Registry version the check saw, or the short remote commit for a repository source; null when the provider reports neither. */
  remote_version: string | null;
  /** Whether the check found a newer release. */
  update_available: boolean;
  /** ISO 8601 time of the check. */
  checked_at: string;
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
  const checkedAt = text("checked_at");
  if (name === undefined || installedVersion === undefined || checkedAt === undefined || typeof row.update_available !== "boolean") return undefined;
  return { name, installed_version: installedVersion, remote_version: text("remote_version") ?? null, update_available: row.update_available, checked_at: checkedAt };
}

/** Read the observations recorded for a scope; an absent, unreadable or malformed record yields none. */
export async function readExtensionUpdateObservations(scopeRoot: string): Promise<ExtensionUpdateObservation[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(resolveExtensionUpdateObservationsPath(scopeRoot), "utf8"));
    const rows = typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { observations?: unknown }).observations)
      ? (parsed as { observations: unknown[] }).observations
      : [];
    return rows.flatMap((row) => parseObservation(row) ?? []);
  } catch {
    return [];
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
      typeof entry.last_update_check_at === "string" && entry.update_error === undefined && typeof entry.update_available === "boolean"
        ? [{
            name: entry.name,
            installed_version: entry.manifest_version,
            remote_version: entry.last_update_remote_version ?? entry.last_update_remote_commit?.slice(0, 12) ?? null,
            update_available: entry.update_available,
            checked_at: entry.last_update_check_at,
          }]
        : [])
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Replace a scope's observations with the ones a check just made. Packages the
 * check did not answer for keep their earlier observation, so one failed lookup
 * does not erase what an earlier check learned.
 */
export async function recordExtensionUpdateObservations(scopeRoot: string, observations: readonly ExtensionUpdateObservation[]): Promise<void> {
  if (observations.length === 0) return;
  const answered = new Set(observations.map((entry) => normalizeExtensionNameForMatch(entry.name)));
  const kept = (await readExtensionUpdateObservations(scopeRoot)).filter((entry) => !answered.has(normalizeExtensionNameForMatch(entry.name)));
  const merged = [...kept, ...observations].sort((left, right) => left.name.localeCompare(right.name));
  await writeFileAtomic(resolveExtensionUpdateObservationsPath(scopeRoot), `${JSON.stringify({ version: 1, observations: merged }, null, 2)}\n`);
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

/** The observation that still describes an installed package: same name, same installed version. */
export function findApplicableUpdateObservation(
  observations: readonly ExtensionUpdateObservation[],
  name: string,
  installedVersion: string | null | undefined,
): ExtensionUpdateObservation | undefined {
  if (typeof installedVersion !== "string") return undefined;
  const key = normalizeExtensionNameForMatch(name);
  return observations.find((entry) => normalizeExtensionNameForMatch(entry.name) === key && entry.installed_version === installedVersion);
}

/** The newer version an applicable observation reports (`available` when the provider named none), or null when none is known. */
export function resolveObservedUpdateVersion(observation: ExtensionUpdateObservation | undefined): string | null {
  return observation?.update_available === true ? (observation.remote_version ?? "available") : null;
}
