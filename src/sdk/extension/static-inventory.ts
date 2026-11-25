/**
 * @module sdk/extension/static-inventory
 * Reads configured extension state without loading modules, running hooks, or
 * creating the schema files that the general settings reader may scaffold.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveGlobalPmRoot } from "../../core/store/paths.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { normalizeManagedState, type ManagedExtensionRecord } from "./managed-state.js";
import { normalizeExtensionNameForMatch, normalizeStringList, parseExtensionManifest } from "./shared.js";
import { findApplicableUpdateObservation, readExtensionUpdateObservations, resolveObservedUpdateVersion, type ExtensionUpdateObservation } from "./update-observations.js";

/** One read failure or malformed document that prevents a complete inventory. */
export interface StaticExtensionInventoryError {
  /** Stable machine-readable reason. */
  code: "settings_invalid" | "settings_unreadable" | "managed_state_invalid" | "managed_state_unreadable" | "extensions_unreadable" | "manifest_invalid" | "manifest_unreadable";
  /** File or directory whose read failed. */
  path: string;
}

/** A configured package; runtime activation has deliberately not been tested. */
export interface StaticExtensionInventoryEntry {
  /** Manifest name, or directory name when the manifest is malformed. */
  name: string;
  /** Extension directory basename. */
  directory: string | null;
  /** Selected storage scope. */
  scope: "project" | "global";
  /** Whether an installed directory was found. */
  installed: boolean;
  /** Installed, disabled, absent, or unreadable manifest outcome. */
  status: "installed" | "inactive" | "absent" | "malformed_manifest";
  /** Effective configured state; null when settings cannot be trusted. */
  configured_enabled: boolean | null;
  /** Whether managed metadata identifies this install; null when that metadata is invalid. */
  managed: boolean | null;
  /** Runtime state is never inferred from configuration. */
  runtime_active: null;
  /** Manifest version when available. */
  version?: string;
  /**
   * Newer version the last `pm package manage` check observed for this installed
   * version, or null when none is known (pm-gh1777); absent on a row for a
   * requested package that is not installed.
   */
  update?: string | null;
}

/** The `--fields` contract every package listing shares (pm-gh1777), published with the listing it serves. */
export { parseListingFields, projectListingRows } from "./listing-fields.js";

/** The read-output controls a caller passed, by their global-option keys. */
export interface StaticInventoryReadOutputControls {
  /** Row cap a read would apply; the inventory cannot page, so any value is refused. */
  outputLimit?: string;
  /** Projection mode a read would apply; the inventory projects with `--fields` instead, so any value is refused. */
  outputInclude?: string;
  /** Read session that would suppress repeated rows across calls; refused because the inventory keeps no session. */
  outputSession?: string;
  /** Continuation token of an earlier page; refused because the inventory returns every row at once. */
  outputCursor?: string;
  /** Request for the per-row identity contract; refused when true because inventory rows carry none. */
  outputRowContract?: boolean;
  /** Byte budget for the rendered result; only `unbounded` is accepted, since the inventory cannot trim rows to fit. */
  outputBudget?: string;
}

/**
 * The static inventory returns every installed package and applies no read-output
 * row controls, so those controls are refused instead of silently ignored; the
 * output format and an unbounded budget still apply (Codex review round 2).
 */
export function refuseStaticInventoryReadOutputControls(controls: StaticInventoryReadOutputControls): void {
  const unsupported = [
    ["--output-limit", controls.outputLimit],
    ["--output-include", controls.outputInclude],
    ["--output-session", controls.outputSession],
    ["--output-cursor", controls.outputCursor],
    ["--output-row-contract", controls.outputRowContract === true ? "true" : undefined],
    ["--output-budget", controls.outputBudget === "unbounded" ? undefined : controls.outputBudget],
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([flag]) => flag);
  if (unsupported.length === 0) return;
  throw new PmCliError(
    `pm package list does not apply ${unsupported.join(", ")}: it returns every installed package. Narrow rows with --fields, or use pm package manage or pm package catalog for read-output controls.`,
    EXIT_CODE.USAGE,
    {
      code: "read_output_surface_unsupported",
      details: { command: "package list", output_option_keys: unsupported },
      required: "Drop the row-shaping output controls; pm package list keeps --output-format and an unbounded --output-budget.",
      examples: ["pm package list --fields name,version,update"],
    },
  );
}

/** Row keys `pm package list --fields` selects from, in their emitted order. */
export const INVENTORY_ROW_FIELDS = [
  "name", "directory", "scope", "installed", "status", "configured_enabled", "managed", "runtime_active", "version", "update",
] as const;

/** A read-only inventory with explicit completeness and source receipts. */
export interface StaticExtensionInventoryResult {
  /** Selected storage scope. */
  scope: "project" | "global";
  /** False if any source could not be read or parsed completely. */
  complete: boolean;
  /** Status of the two configuration sources. */
  settings_status: "ok" | "absent" | "invalid" | "unreadable";
  /** Status of the managed install metadata. */
  managed_state_status: "ok" | "absent" | "invalid" | "unreadable";
  /** Installed entries whose last observed check found a newer release; always set by {@link inspectStaticExtensionInventory}. */
  updates_available?: number;
  /** Installed entries, or one absent entry for a missing requested name. */
  extensions: StaticExtensionInventoryEntry[];
  /** Every failure that affected completeness. */
  errors: StaticExtensionInventoryError[];
}

/** Distinguish absent optional files from I/O failures. */
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** An absent optional source is trustworthy; malformed and unreadable sources are not. */
function isTrustedSourceStatus(status: "ok" | "absent" | "invalid" | "unreadable"): boolean {
  return status !== "invalid" && status !== "unreadable";
}

/** Validate the saved enablement lists before they influence a hosted read. */
function parseEnablement(raw: string): { enabled: string[]; disabled: string[] } {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new SyntaxError("Invalid settings object");
  const configured = (parsed as Record<string, unknown>).extensions;
  if (configured === undefined) return { enabled: [], disabled: [] };
  if (typeof configured !== "object" || configured === null || Array.isArray(configured)) throw new SyntaxError("Invalid extensions settings");
  const value = configured as Record<string, unknown>;
  if ((value.enabled !== undefined && (!Array.isArray(value.enabled) || !value.enabled.every((entry) => typeof entry === "string"))) ||
      (value.disabled !== undefined && (!Array.isArray(value.disabled) || !value.disabled.every((entry) => typeof entry === "string")))) {
    throw new SyntaxError("Invalid extension enablement lists");
  }
  return { enabled: (value.enabled as string[] | undefined) ?? [], disabled: (value.disabled as string[] | undefined) ?? [] };
}

/** Read only the enablement fields; the general settings reader may scaffold schema files. */
async function readEnablement(settingsPath: string): Promise<{
  status: StaticExtensionInventoryResult["settings_status"];
  enabled: string[];
  disabled: string[];
  error?: StaticExtensionInventoryError;
}> {
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, "utf8");
  } catch (error: unknown) {
    if (isMissing(error)) return { status: "absent", enabled: [], disabled: [] };
    return { status: "unreadable", enabled: [], disabled: [], error: { code: "settings_unreadable", path: settingsPath } };
  }
  try {
    return { status: "ok", ...parseEnablement(raw) };
  } catch {
    return { status: "invalid", enabled: [], disabled: [], error: { code: "settings_invalid", path: settingsPath } };
  }
}

/** Keep malformed managed metadata visible rather than silently dropping records. */
async function readManagedRecords(managedPath: string): Promise<{
  status: StaticExtensionInventoryResult["managed_state_status"];
  entries: ManagedExtensionRecord[];
  error?: StaticExtensionInventoryError;
}> {
  let raw: string;
  try {
    raw = await fs.readFile(managedPath, "utf8");
  } catch (error: unknown) {
    if (isMissing(error)) {
      try {
        if ((await fs.stat(path.dirname(managedPath))).isDirectory()) {
          return { status: "absent", entries: [] };
        }
      } catch (parentError: unknown) {
        if (isMissing(parentError)) return { status: "absent", entries: [] };
      }
    }
    return { status: "unreadable", entries: [], error: { code: "managed_state_unreadable", path: managedPath } };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const normalized = normalizeManagedState(parsed);
    if (!normalized || typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { entries?: unknown }).entries) ||
        normalized.entries.length !== (parsed as { entries: unknown[] }).entries.length) {
      throw new SyntaxError("Invalid managed extension state");
    }
    return { status: "ok", entries: normalized.entries };
  } catch {
    return { status: "invalid", entries: [], error: { code: "managed_state_invalid", path: managedPath } };
  }
}

/** List installed directories without importing or resolving their entrypoints. */
async function readExtensionDirectories(extensionsRoot: string): Promise<{ directories: string[]; error?: StaticExtensionInventoryError }> {
  try {
    const directories = (await fs.readdir(extensionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    return { directories };
  } catch (error: unknown) {
    if (isMissing(error)) return { directories: [] };
    return { directories: [], error: { code: "extensions_unreadable", path: extensionsRoot } };
  }
}

/** Parse manifest metadata only; an invalid entry remains in the receipt. */
async function readManifest(manifestPath: string): Promise<{
  manifest: ReturnType<typeof parseExtensionManifest>;
  error?: StaticExtensionInventoryError;
}> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (error: unknown) {
    if (isMissing(error)) {
      return { manifest: null, error: { code: "manifest_invalid", path: manifestPath } };
    }
    return { manifest: null, error: { code: "manifest_unreadable", path: manifestPath } };
  }
  try {
    const manifest = parseExtensionManifest(JSON.parse(raw) as unknown);
    return manifest ? { manifest } : { manifest: null, error: { code: "manifest_invalid", path: manifestPath } };
  } catch {
    return { manifest: null, error: { code: "manifest_invalid", path: manifestPath } };
  }
}

/** The managed install record of a package, matched by manifest name or directory. */
function findManagedRecord(entries: readonly ManagedExtensionRecord[], name: string, directory: string): ManagedExtensionRecord | undefined {
  return entries.find((entry) =>
    normalizeExtensionNameForMatch(entry.name) === normalizeExtensionNameForMatch(name) ||
    normalizeExtensionNameForMatch(entry.directory) === normalizeExtensionNameForMatch(directory));
}

/** Project saved state without presenting it as runtime activation truth. */
function projectConfiguredEntry(input: {
  directory: string;
  scope: "project" | "global";
  manifest: NonNullable<ReturnType<typeof parseExtensionManifest>> | null;
  settings: Awaited<ReturnType<typeof readEnablement>>;
  managed: Awaited<ReturnType<typeof readManagedRecords>>;
}): StaticExtensionInventoryEntry {
  const name = input.manifest?.name ?? input.directory;
  const enabled = new Set(normalizeStringList(input.settings.enabled));
  const disabled = new Set(normalizeStringList(input.settings.disabled));
  const configuredEnabled = !isTrustedSourceStatus(input.settings.status) || !input.manifest ? null :
    !disabled.has(name) && (enabled.size === 0 || enabled.has(name));
  const managed = !isTrustedSourceStatus(input.managed.status) ? null : findManagedRecord(input.managed.entries, name, input.directory) !== undefined;
  return {
    name,
    directory: input.directory,
    scope: input.scope,
    installed: true,
    status: input.manifest ? configuredEnabled === false ? "inactive" : "installed" : "malformed_manifest",
    configured_enabled: configuredEnabled,
    managed,
    runtime_active: null,
    ...(input.manifest ? { version: input.manifest.version } : {}),
  };
}

/** Attach the update the last manage check observed for exactly this installation (pm-gh1778). */
function withObservedUpdate(
  entry: StaticExtensionInventoryEntry,
  directory: string,
  records: readonly ManagedExtensionRecord[],
  observations: readonly ExtensionUpdateObservation[],
): StaticExtensionInventoryEntry {
  // Bind the evidence to this directory's own managed record, so a same-named unmanaged copy never borrows it.
  const record = records.find((candidate) => candidate.directory === directory);
  const installation = { name: entry.name, version: entry.version, updated_at: record?.updated_at };
  return { ...entry, update: resolveObservedUpdateVersion(findApplicableUpdateObservation(observations, installation)) };
}

/** Read configured extension state through filesystem reads only. */
export async function inspectStaticExtensionInventory(options: {
  /** Tracker root for the project scope. */
  pmRoot: string;
  /** Storage scope; project is the default. */
  scope?: "project" | "global";
  /** Optional name or directory to inspect, including absent installs. */
  name?: string;
  /** Base directory used to resolve the global PM root. */
  cwd?: string;
}): Promise<StaticExtensionInventoryResult> {
  const scope = options.scope ?? "project";
  const selectedRoot = scope === "global" ? resolveGlobalPmRoot(options.cwd ?? process.cwd()) : options.pmRoot;
  const extensionsRoot = path.join(selectedRoot, "extensions");
  const settings = await readEnablement(path.join(selectedRoot, "settings.json"));
  const managed = await readManagedRecords(path.join(extensionsRoot, ".managed-extensions.json"));
  const listed = await readExtensionDirectories(extensionsRoot);
  const errors: StaticExtensionInventoryError[] = [];
  for (const source of [settings, managed, listed]) {
    if (source.error) errors.push(source.error);
  }

  const requested = options.name?.trim();
  const observations = await readExtensionUpdateObservations(selectedRoot);
  const extensions: StaticExtensionInventoryEntry[] = [];
  for (const directory of listed.directories) {
    const manifestPath = path.join(extensionsRoot, directory, "manifest.json");
    const inspected = await readManifest(manifestPath);
    if (inspected.error) errors.push(inspected.error);
    const entry = projectConfiguredEntry({ directory, scope, manifest: inspected.manifest, settings, managed });
    if (requested && ![entry.name, directory].some((value) => normalizeExtensionNameForMatch(value) === normalizeExtensionNameForMatch(requested))) {
      continue;
    }
    extensions.push(withObservedUpdate(entry, directory, managed.entries, observations));
  }
  if (requested && extensions.length === 0 && errors.every((error) => error.code !== "extensions_unreadable")) {
    extensions.push({ name: requested, directory: null, scope, installed: false, status: "absent",
      configured_enabled: isTrustedSourceStatus(settings.status) ? false : null,
      managed: isTrustedSourceStatus(managed.status) ? false : null,
      runtime_active: null });
  }
  const updatesAvailable = extensions.filter((entry) => typeof entry.update === "string").length;
  return { scope, complete: errors.length === 0, settings_status: settings.status, managed_state_status: managed.status, updates_available: updatesAvailable, extensions, errors };
}
