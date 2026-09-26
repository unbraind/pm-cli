/**
 * @module sdk/extension/static-inventory
 * Reads configured extension state without loading modules, running hooks, or
 * creating the schema files that the general settings reader may scaffold.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveGlobalPmRoot } from "../../core/store/paths.js";
import { normalizeManagedState, type ManagedExtensionRecord } from "./managed-state.js";
import { normalizeExtensionNameForMatch, normalizeStringList, parseExtensionManifest } from "./shared.js";

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
}

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
    if (isMissing(error)) return { status: "absent", entries: [] };
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
  const managed = !isTrustedSourceStatus(input.managed.status) ? null : input.managed.entries.some((entry) =>
    normalizeExtensionNameForMatch(entry.name) === normalizeExtensionNameForMatch(name) ||
    normalizeExtensionNameForMatch(entry.directory) === normalizeExtensionNameForMatch(input.directory));
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
  const extensions: StaticExtensionInventoryEntry[] = [];
  for (const directory of listed.directories) {
    const manifestPath = path.join(extensionsRoot, directory, "manifest.json");
    const inspected = await readManifest(manifestPath);
    if (inspected.error) errors.push(inspected.error);
    const entry = projectConfiguredEntry({ directory, scope, manifest: inspected.manifest, settings, managed });
    if (requested && ![entry.name, directory].some((value) => normalizeExtensionNameForMatch(value) === normalizeExtensionNameForMatch(requested))) {
      continue;
    }
    extensions.push(entry);
  }
  if (requested && extensions.length === 0 && errors.every((error) => error.code !== "extensions_unreadable")) {
    extensions.push({ name: requested, directory: null, scope, installed: false, status: "absent",
      configured_enabled: isTrustedSourceStatus(settings.status) ? false : null,
      managed: isTrustedSourceStatus(managed.status) ? false : null,
      runtime_active: null });
  }
  return { scope, complete: errors.length === 0, settings_status: settings.status, managed_state_status: managed.status, extensions, errors };
}
