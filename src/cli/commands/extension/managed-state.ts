import fs from "node:fs/promises";
import path from "node:path";
import { nowIso } from "../../../core/shared/time.js";
import { normalizeExtensionNameForMatch, normalizeStringList } from "./shared.js";
import type { ExtensionScope } from "../extension.js";

const MANAGED_EXTENSION_STATE_FILENAME = ".managed-extensions.json";
const MANAGED_EXTENSION_STATE_VERSION = 1;

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

export interface ManagedExtensionState {
  version: number;
  updated_at: string;
  entries: ManagedExtensionRecord[];
}

export interface ManagedExtensionStateReadResult {
  path: string;
  state: ManagedExtensionState;
  warnings: string[];
}

export function resolveManagedExtensionStatePath(extensionsRoot: string): string {
  return path.join(extensionsRoot, MANAGED_EXTENSION_STATE_FILENAME);
}

export function createEmptyManagedExtensionState(): ManagedExtensionState {
  return {
    version: MANAGED_EXTENSION_STATE_VERSION,
    updated_at: nowIso(),
    entries: [],
  };
}

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
    if (typeof rawEntry !== "object" || rawEntry === null) {
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    if (
      typeof entry.name !== "string" ||
      entry.name.trim().length === 0 ||
      typeof entry.directory !== "string" ||
      entry.directory.trim().length === 0 ||
      (entry.scope !== "project" && entry.scope !== "global") ||
      typeof entry.manifest_version !== "string" ||
      typeof entry.manifest_entry !== "string" ||
      !Array.isArray(entry.capabilities) ||
      entry.capabilities.some((value) => typeof value !== "string") ||
      typeof entry.installed_at !== "string" ||
      typeof entry.updated_at !== "string" ||
      typeof entry.source !== "object" ||
      entry.source === null
    ) {
      continue;
    }
    const source = entry.source as Record<string, unknown>;
    if (
      (source.kind !== "local" && source.kind !== "github" && source.kind !== "npm" && source.kind !== "builtin") ||
      typeof source.input !== "string" ||
      typeof source.location !== "string"
    ) {
      continue;
    }
    entries.push({
      name: entry.name.trim(),
      directory: entry.directory.trim(),
      scope: entry.scope,
      manifest_version: entry.manifest_version,
      manifest_entry: entry.manifest_entry,
      capabilities: normalizeStringList(entry.capabilities as string[]),
      installed_at: entry.installed_at,
      updated_at: entry.updated_at,
      source: {
        kind: source.kind,
        input: source.input,
        location: source.location,
        name: typeof source.name === "string" ? source.name : undefined,
        package: typeof source.package === "string" ? source.package : undefined,
        version: typeof source.version === "string" ? source.version : undefined,
        repository: typeof source.repository === "string" ? source.repository : undefined,
        owner: typeof source.owner === "string" ? source.owner : undefined,
        repo: typeof source.repo === "string" ? source.repo : undefined,
        ref: typeof source.ref === "string" ? source.ref : undefined,
        subpath: typeof source.subpath === "string" ? source.subpath : undefined,
        commit: typeof source.commit === "string" ? source.commit : undefined,
      },
      last_update_check_at: typeof entry.last_update_check_at === "string" ? entry.last_update_check_at : undefined,
      last_update_remote_commit:
        typeof entry.last_update_remote_commit === "string" ? entry.last_update_remote_commit : undefined,
      update_available:
        typeof entry.update_available === "boolean" || entry.update_available === null
          ? entry.update_available
          : undefined,
      update_error: typeof entry.update_error === "string" ? entry.update_error : undefined,
    });
  }
  return {
    version: MANAGED_EXTENSION_STATE_VERSION,
    updated_at: typeof candidate.updated_at === "string" ? candidate.updated_at : nowIso(),
    entries: sortManagedEntries(entries),
  };
}

export async function readManagedExtensionState(extensionsRoot: string): Promise<ManagedExtensionStateReadResult> {
  const statePath = resolveManagedExtensionStatePath(extensionsRoot);
  const fallback = createEmptyManagedExtensionState();
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeManagedState(parsed);
    if (!normalized) {
      return {
        path: statePath,
        state: fallback,
        warnings: [`extension_manager_state_invalid_schema:${statePath}`],
      };
    }
    return {
      path: statePath,
      state: normalized,
      warnings: [],
    };
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return {
        path: statePath,
        state: fallback,
        warnings: [],
      };
    }
    return {
      path: statePath,
      state: fallback,
      warnings: [`extension_manager_state_read_failed:${statePath}`],
    };
  }
}

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
