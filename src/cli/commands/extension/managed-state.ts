/**
 * @module cli/commands/extension/managed-state
 *
 * Implements extension package-management support for Managed State.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { EXIT_CODE } from "../../../core/shared/constants.js";
import { PmCliError } from "../../../core/shared/errors.js";
import { nowIso } from "../../../core/shared/time.js";
import { normalizeExtensionNameForMatch, normalizeStringList } from "./shared.js";
import type { ExtensionScope } from "../extension.js";

const MANAGED_EXTENSION_STATE_FILENAME = ".managed-extensions.json";
const MANAGED_EXTENSION_STATE_VERSION = 1;

/**
 * Documents the managed extension source payload exchanged by command, SDK, and package integrations.
 */
export interface ManagedExtensionSource {
  kind: "local" | "github" | "npm" | "builtin";
  input: string;
  location: string;
  name?: string;
  package?: string;
  version?: string;
  repository?: string;
  owner?: string;
  repo?: string;
  ref?: string;
  subpath?: string;
  commit?: string;
}

/**
 * Documents the managed extension record payload exchanged by command, SDK, and package integrations.
 */
export interface ManagedExtensionRecord {
  name: string;
  directory: string;
  scope: ExtensionScope;
  manifest_version: string;
  manifest_entry: string;
  capabilities: string[];
  installed_at: string;
  updated_at: string;
  source: ManagedExtensionSource;
  last_update_check_at?: string;
  last_update_remote_commit?: string;
  update_available?: boolean | null;
  update_error?: string;
}

/**
 * Documents the managed extension state payload exchanged by command, SDK, and package integrations.
 */
export interface ManagedExtensionState {
  version: number;
  updated_at: string;
  entries: ManagedExtensionRecord[];
}

/**
 * Documents the managed extension state read result payload exchanged by command, SDK, and package integrations.
 */
export interface ManagedExtensionStateReadResult {
  path: string;
  state: ManagedExtensionState;
  warnings: string[];
}

/**
 * Implements resolve managed extension state path for the public runtime surface of this module.
 */
export function resolveManagedExtensionStatePath(extensionsRoot: string): string {
  return path.join(extensionsRoot, MANAGED_EXTENSION_STATE_FILENAME);
}

/**
 * Implements create empty managed extension state for the public runtime surface of this module.
 */
export function createEmptyManagedExtensionState(): ManagedExtensionState {
  return {
    version: MANAGED_EXTENSION_STATE_VERSION,
    updated_at: nowIso(),
    entries: [],
  };
}

/**
 * Implements sort managed entries for the public runtime surface of this module.
 */
export function sortManagedEntries(entries: ManagedExtensionRecord[]): ManagedExtensionRecord[] {
  return [...entries].sort((left, right) => {
    const byScope = left.scope.localeCompare(right.scope);
    if (byScope !== 0) {
      return byScope;
    }
    const byName = left.name.localeCompare(right.name);
    if (byName !== 0) {
      return byName;
    }
    return left.directory.localeCompare(right.directory);
  });
}

/**
 * Implements managed extension sources equivalent for the public runtime surface of this module.
 */
export function managedExtensionSourcesEquivalent(left: ManagedExtensionSource, right: ManagedExtensionSource): boolean {
  if (left.kind !== right.kind || left.input !== right.input || left.location !== right.location) {
    return false;
  }
  if (left.kind === "npm" && right.kind === "npm") {
    return left.package === right.package && left.version === right.version;
  }
  if (left.kind === "github" && right.kind === "github") {
    return left.repository === right.repository && left.ref === right.ref && left.subpath === right.subpath && left.commit === right.commit;
  }
  if (left.kind === "builtin" && right.kind === "builtin") {
    return left.name === right.name;
  }
  return true;
}

/**
 * Narrow `value` to a string, or `undefined` for any other type — the
 * normalization applied to every optional managed-state string field so an
 * absent or malformed value is dropped rather than carried through as `unknown`.
 */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Type guard asserting `entry` carries every always-present managed-record field
 * with the right primitive type: a non-empty `name`/`directory`, a known
 * {@link ExtensionScope}, string manifest metadata, a `string[]` capability
 * list, and string `installed_at`/`updated_at` timestamps. The optional columns
 * (`source` plus the update-check fields) are validated separately by the
 * caller, so this guard narrows only the required columns.
 */
function hasRequiredManagedRecordFields(
  entry: Record<string, unknown>,
): entry is Record<string, unknown> &
  Pick<
    ManagedExtensionRecord,
    "name" | "directory" | "scope" | "manifest_version" | "manifest_entry" | "capabilities" | "installed_at" | "updated_at"
  > {
  return (
    typeof entry.name === "string" &&
    entry.name.trim().length > 0 &&
    typeof entry.directory === "string" &&
    entry.directory.trim().length > 0 &&
    (entry.scope === "project" || entry.scope === "global") &&
    typeof entry.manifest_version === "string" &&
    typeof entry.manifest_entry === "string" &&
    Array.isArray(entry.capabilities) &&
    entry.capabilities.every((value): value is string => typeof value === "string") &&
    typeof entry.installed_at === "string" &&
    typeof entry.updated_at === "string"
  );
}

/**
 * Normalize one persisted managed-extension source object, returning `null` when
 * the discriminant (`kind`) or the required `input`/`location` strings are
 * missing or malformed so the caller can skip the owning record.
 */
function normalizeManagedSource(raw: unknown): ManagedExtensionSource | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const source = raw as Record<string, unknown>;
  if (
    (source.kind !== "local" && source.kind !== "github" && source.kind !== "npm" && source.kind !== "builtin") ||
    typeof source.input !== "string" ||
    typeof source.location !== "string"
  ) {
    return null;
  }
  return {
    kind: source.kind,
    input: source.input,
    location: source.location,
    name: optionalString(source.name),
    package: optionalString(source.package),
    version: optionalString(source.version),
    repository: optionalString(source.repository),
    owner: optionalString(source.owner),
    repo: optionalString(source.repo),
    ref: optionalString(source.ref),
    subpath: optionalString(source.subpath),
    commit: optionalString(source.commit),
  };
}

/**
 * Normalize one persisted managed-extension record, returning `null` when any
 * required field or its `source` is missing or malformed so {@link
 * normalizeManagedState} can drop the entry without discarding the rest of the
 * file.
 */
function normalizeManagedRecord(raw: unknown): ManagedExtensionRecord | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  if (!hasRequiredManagedRecordFields(entry)) {
    return null;
  }
  const source = normalizeManagedSource(entry.source);
  if (!source) {
    return null;
  }
  return {
    name: entry.name.trim(),
    directory: entry.directory.trim(),
    scope: entry.scope,
    manifest_version: entry.manifest_version,
    manifest_entry: entry.manifest_entry,
    capabilities: normalizeStringList(entry.capabilities),
    installed_at: entry.installed_at,
    updated_at: entry.updated_at,
    source,
    last_update_check_at: optionalString(entry.last_update_check_at),
    last_update_remote_commit: optionalString(entry.last_update_remote_commit),
    update_available:
      typeof entry.update_available === "boolean" || entry.update_available === null
        ? entry.update_available
        : undefined,
    update_error: optionalString(entry.update_error),
  };
}

/**
 * Implements normalize managed state for the public runtime surface of this module.
 */
export function normalizeManagedState(raw: unknown): ManagedExtensionState | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.version !== MANAGED_EXTENSION_STATE_VERSION || !Array.isArray(candidate.entries)) {
    return null;
  }

  const entries: ManagedExtensionRecord[] = [];
  for (const rawEntry of candidate.entries) {
    const record = normalizeManagedRecord(rawEntry);
    if (record) {
      entries.push(record);
    }
  }
  return {
    version: MANAGED_EXTENSION_STATE_VERSION,
    updated_at: optionalString(candidate.updated_at) ?? nowIso(),
    entries: sortManagedEntries(entries),
  };
}

/**
 * Implements read managed extension state for the public runtime surface of this module.
 */
export async function readManagedExtensionState(extensionsRoot: string): Promise<ManagedExtensionStateReadResult> {
  const statePath = resolveManagedExtensionStatePath(extensionsRoot);
  const fallback = createEmptyManagedExtensionState();
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeManagedState(parsed);
    if (!normalized) {
      throw new PmCliError(
        `Managed extension state file "${statePath}" has an invalid schema. Repair or remove it before mutating extension state.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    return {
      path: statePath,
      state: normalized,
      warnings: [],
    };
  } catch (error: unknown) {
    if (error instanceof PmCliError) {
      throw error;
    }
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return {
        path: statePath,
        state: fallback,
        warnings: [],
      };
    }
    throw new PmCliError(
      `Managed extension state file "${statePath}" could not be read. Repair or remove it before mutating extension state.`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
}

/**
 * Implements write managed extension state for the public runtime surface of this module.
 */
export async function writeManagedExtensionState(extensionsRoot: string, state: ManagedExtensionState): Promise<void> {
  const statePath = resolveManagedExtensionStatePath(extensionsRoot);
  const normalized: ManagedExtensionState = {
    version: MANAGED_EXTENSION_STATE_VERSION,
    updated_at: nowIso(),
    entries: sortManagedEntries(state.entries),
  };
  await fs.mkdir(extensionsRoot, { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}


/**
 * Implements upsert managed entry for the public runtime surface of this module.
 */
export function upsertManagedEntry(state: ManagedExtensionState, entry: ManagedExtensionRecord): ManagedExtensionState {
  const updatedEntries = state.entries.filter(
    (candidate) =>
      normalizeExtensionNameForMatch(candidate.name) !== normalizeExtensionNameForMatch(entry.name) &&
      normalizeExtensionNameForMatch(candidate.directory) !== normalizeExtensionNameForMatch(entry.directory),
  );
  updatedEntries.push(entry);
  return {
    ...state,
    updated_at: nowIso(),
    entries: sortManagedEntries(updatedEntries),
  };
}
