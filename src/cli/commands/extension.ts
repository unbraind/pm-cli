import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { activateExtensions, loadExtensions, nextExtensionReloadToken } from "../../core/extensions/index.js";
import {
  EXTENSION_CAPABILITY_CONTRACT,
  KNOWN_EXTENSION_CAPABILITIES,
  parseLegacyExtensionCapabilityAliasWarning,
  parseUnknownExtensionCapabilityWarning,
  resolveExtensionRoots,
  type ExtensionManifest,
  type UnknownExtensionCapabilityWarningDetails,
} from "../../core/extensions/loader.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { resolveGlobalPmRoot, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings, writeSettings } from "../../core/store/settings.js";
import type { PmSettings } from "../../types/index.js";

const execFileAsync = promisify(execFile);
const DEFAULT_EXTENSION_PRIORITY = 100;
const MANAGED_EXTENSION_STATE_FILENAME = ".managed-extensions.json";
const MANAGED_EXTENSION_STATE_VERSION = 1;
const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const BUNDLED_EXTENSION_ALIASES: Record<string, string> = {
  beads: "beads",
  todos: "todos",
};

export type ExtensionCommandAction =
  | "install"
  | "uninstall"
  | "explore"
  | "manage"
  | "reload"
  | "doctor"
  | "adopt"
  | "adopt-all"
  | "activate"
  | "deactivate"
  | "init";
export type ExtensionScope = "project" | "global";
export type ExtensionActivationStatus = "ok" | "failed" | "not_loaded" | "unknown";

export interface ExtensionCommandOptions {
  install?: boolean;
  uninstall?: boolean;
  explore?: boolean;
  manage?: boolean;
  reload?: boolean;
  doctor?: boolean;
  init?: boolean;
  scaffold?: boolean;
  strictExit?: boolean;
  failOnWarn?: boolean;
  adopt?: boolean;
  adoptAll?: boolean;
  activate?: boolean;
  deactivate?: boolean;
  project?: boolean;
  local?: boolean;
  global?: boolean;
  gh?: string;
  github?: string;
  ref?: string;
  detail?: string;
  trace?: boolean;
  watch?: boolean;
  runtimeProbe?: boolean;
  fixManagedState?: boolean;
}

export interface ManagedExtensionSource {
  kind: "local" | "github" | "npm";
  input: string;
  location: string;
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

interface ValidatedExtensionDirectory {
  directory: string;
  manifest_path: string;
  entry_path: string;
  manifest: ExtensionManifest;
}

interface LocalInstallSource {
  kind: "local";
  input: string;
  absolute_path: string;
}

interface GithubInstallSource {
  kind: "github";
  input: string;
  owner: string;
  repo: string;
  repository: string;
  ref?: string;
  subpath?: string;
}

interface NpmInstallSource {
  kind: "npm";
  input: string;
  spec: string;
}

type InstallSource = LocalInstallSource | GithubInstallSource | NpmInstallSource;

interface ResolvedInstallSource {
  source: InstallSource;
  directory: string;
  resolved_subpath?: string;
  commit?: string;
  npm_package?: string;
  npm_version?: string;
  cleanup?: () => Promise<void>;
}

function resolvePackageRootCandidates(): string[] {
  const candidates: string[] = [];
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  if (typeof envRoot === "string" && envRoot.trim().length > 0) {
    candidates.push(path.resolve(envRoot.trim()));
  }
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  candidates.push(moduleRoot);
  return [...new Set(candidates)];
}

async function resolveBundledExtensionAliasSource(input: string): Promise<string | null> {
  const normalized = input.trim().toLowerCase();
  const alias = BUNDLED_EXTENSION_ALIASES[normalized];
  if (!alias) {
    return null;
  }

  for (const packageRoot of resolvePackageRootCandidates()) {
    const bundledPath = path.join(packageRoot, ".agents", "pm", "extensions", alias);
    if (await pathExists(path.join(bundledPath, "manifest.json"))) {
      return bundledPath;
    }
  }
  return null;
}

export interface ManagedExtensionSummary {
  name: string;
  directory: string;
  version: string;
  entry: string;
  scope: ExtensionScope;
  // Backward-compatible alias for configured enabled state. Prefer `enabled`.
  active: boolean;
  enabled: boolean;
  runtime_active: boolean | null;
  activation_status: ExtensionActivationStatus;
  managed: boolean;
  source?: ManagedExtensionSource;
  update_available?: boolean | null;
  last_update_check_at?: string;
  last_update_remote_commit?: string;
  update_error?: string;
  update_check_status: ExtensionUpdateCheckStatus;
  update_check_reason: string;
}

export interface ExtensionCommandResult {
  ok: boolean;
  action: ExtensionCommandAction;
  scope: ExtensionScope;
  roots: {
    project: string;
    global: string;
    selected: string;
    settings_root: string;
  };
  warnings: string[];
  details: Record<string, unknown>;
}

interface ExtensionTriageSummary {
  status: "ok" | "warn";
  warning_count: number;
  warning_codes: string[];
  warnings: string[];
  policy_warning_count: number;
  policy_violation_count: number;
  policy_blocked_count: number;
  total_extensions: number;
  managed_total: number;
  enabled_total: number;
  active_total: number;
  update_available_total: number;
  update_health_coverage: "full" | "partial";
  update_health_partial: boolean;
  unmanaged_loaded_extension_count: number;
  unmanaged_loaded_extensions: string[];
  unmanaged_expected_extension_count: number;
  unmanaged_expected_extensions: string[];
  unmanaged_action_required_extension_count: number;
  unmanaged_action_required_extensions: string[];
  update_check_status_totals: Record<ExtensionUpdateCheckStatus, number>;
  update_check_failed_total: number;
  top_warnings: string[];
  remediation: string[];
}

type ExtensionUpdateCheckStatus = "checked" | "skipped_unmanaged" | "skipped_non_github" | "failed" | "not_checked";

interface ExtensionUpdateCheckResolution {
  status: ExtensionUpdateCheckStatus;
  reason: string;
}

type ExtensionDoctorDetailMode = "summary" | "deep";

function normalizeStringList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function summarizePolicyWarnings(warnings: string[]): {
  warning_count: number;
  violation_count: number;
  blocked_count: number;
} {
  let warningCount = 0;
  let violationCount = 0;
  let blockedCount = 0;
  for (const warning of warnings) {
    if (!warning.startsWith("extension_policy_")) {
      continue;
    }
    warningCount += 1;
    if (warning.startsWith("extension_policy_violation_")) {
      violationCount += 1;
      continue;
    }
    if (warning.startsWith("extension_policy_blocked_")) {
      blockedCount += 1;
    }
  }
  return {
    warning_count: warningCount,
    violation_count: violationCount,
    blocked_count: blockedCount,
  };
}

function buildExtensionPolicyDetails(policy: PmSettings["extensions"]["policy"]): {
  mode: "off" | "warn" | "enforce";
  trust_mode: "off" | "warn" | "enforce";
  require_provenance: boolean;
  trusted_extensions: string[];
  default_sandbox_profile: "none" | "restricted" | "strict";
  allowed_extensions: string[];
  blocked_extensions: string[];
  allowed_capabilities: string[];
  blocked_capabilities: string[];
  allowed_surfaces: string[];
  blocked_surfaces: string[];
  allowed_commands: string[];
  blocked_commands: string[];
  allowed_actions: string[];
  blocked_actions: string[];
  allowed_services: string[];
  blocked_services: string[];
  extension_overrides: Array<{
    name: string;
    disabled?: boolean;
    require_trusted?: boolean;
    require_provenance?: boolean;
    sandbox_profile?: "none" | "restricted" | "strict";
    allowed_capabilities?: string[];
    blocked_capabilities?: string[];
    allowed_surfaces?: string[];
    blocked_surfaces?: string[];
    allowed_commands?: string[];
    blocked_commands?: string[];
    allowed_actions?: string[];
    blocked_actions?: string[];
    allowed_services?: string[];
    blocked_services?: string[];
  }>;
} {
  const overrides = (policy.extension_overrides ?? [])
    .map((override) => ({
      name: override.name.trim(),
      disabled: override.disabled === true ? true : undefined,
      require_trusted: override.require_trusted === true ? true : undefined,
      require_provenance: override.require_provenance === true ? true : undefined,
      sandbox_profile: override.sandbox_profile,
      allowed_capabilities: normalizeStringList(override.allowed_capabilities ?? []),
      blocked_capabilities: normalizeStringList(override.blocked_capabilities ?? []),
      allowed_surfaces: normalizeStringList(override.allowed_surfaces ?? []),
      blocked_surfaces: normalizeStringList(override.blocked_surfaces ?? []),
      allowed_commands: normalizeStringList(override.allowed_commands ?? []),
      blocked_commands: normalizeStringList(override.blocked_commands ?? []),
      allowed_actions: normalizeStringList(override.allowed_actions ?? []),
      blocked_actions: normalizeStringList(override.blocked_actions ?? []),
      allowed_services: normalizeStringList(override.allowed_services ?? []),
      blocked_services: normalizeStringList(override.blocked_services ?? []),
    }))
    .filter((override) => override.name.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    mode: policy.mode,
    trust_mode: policy.trust_mode,
    require_provenance: policy.require_provenance === true,
    trusted_extensions: normalizeStringList(policy.trusted_extensions ?? []),
    default_sandbox_profile: policy.default_sandbox_profile ?? "none",
    allowed_extensions: normalizeStringList(policy.allowed_extensions ?? []),
    blocked_extensions: normalizeStringList(policy.blocked_extensions ?? []),
    allowed_capabilities: normalizeStringList(policy.allowed_capabilities ?? []),
    blocked_capabilities: normalizeStringList(policy.blocked_capabilities ?? []),
    allowed_surfaces: normalizeStringList(policy.allowed_surfaces ?? []),
    blocked_surfaces: normalizeStringList(policy.blocked_surfaces ?? []),
    allowed_commands: normalizeStringList(policy.allowed_commands ?? []),
    blocked_commands: normalizeStringList(policy.blocked_commands ?? []),
    allowed_actions: normalizeStringList(policy.allowed_actions ?? []),
    blocked_actions: normalizeStringList(policy.blocked_actions ?? []),
    allowed_services: normalizeStringList(policy.allowed_services ?? []),
    blocked_services: normalizeStringList(policy.blocked_services ?? []),
    extension_overrides: overrides.map((override) => ({
      name: override.name,
      ...(override.disabled === true ? { disabled: true } : {}),
      ...(override.require_trusted === true ? { require_trusted: true } : {}),
      ...(override.require_provenance === true ? { require_provenance: true } : {}),
      ...(override.sandbox_profile ? { sandbox_profile: override.sandbox_profile } : {}),
      ...(override.allowed_capabilities.length > 0 ? { allowed_capabilities: override.allowed_capabilities } : {}),
      ...(override.blocked_capabilities.length > 0 ? { blocked_capabilities: override.blocked_capabilities } : {}),
      ...(override.allowed_surfaces.length > 0 ? { allowed_surfaces: override.allowed_surfaces } : {}),
      ...(override.blocked_surfaces.length > 0 ? { blocked_surfaces: override.blocked_surfaces } : {}),
      ...(override.allowed_commands.length > 0 ? { allowed_commands: override.allowed_commands } : {}),
      ...(override.blocked_commands.length > 0 ? { blocked_commands: override.blocked_commands } : {}),
      ...(override.allowed_actions.length > 0 ? { allowed_actions: override.allowed_actions } : {}),
      ...(override.blocked_actions.length > 0 ? { blocked_actions: override.blocked_actions } : {}),
      ...(override.allowed_services.length > 0 ? { allowed_services: override.allowed_services } : {}),
      ...(override.blocked_services.length > 0 ? { blocked_services: override.blocked_services } : {}),
    })),
  };
}

function normalizeManagedDirectoryName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized.length === 0) {
    throw new PmCliError("Extension manifest name must resolve to a non-empty directory name.", EXIT_CODE.USAGE);
  }
  return normalized;
}

function parseExtensionManifest(raw: unknown): ExtensionManifest | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
    return null;
  }
  if (typeof candidate.version !== "string" || candidate.version.trim().length === 0) {
    return null;
  }
  if (typeof candidate.entry !== "string" || candidate.entry.trim().length === 0) {
    return null;
  }

  let priority = DEFAULT_EXTENSION_PRIORITY;
  if (candidate.priority !== undefined && candidate.priority !== null) {
    if (typeof candidate.priority !== "number" || !Number.isInteger(candidate.priority)) {
      return null;
    }
    priority = candidate.priority;
  }

  let capabilities: string[] = [];
  if (candidate.capabilities !== undefined && candidate.capabilities !== null) {
    if (!Array.isArray(candidate.capabilities) || candidate.capabilities.some((value) => typeof value !== "string")) {
      return null;
    }
    capabilities = normalizeStringList(candidate.capabilities.map((value) => String(value).toLowerCase()));
  }

  return {
    name: candidate.name.trim(),
    version: candidate.version.trim(),
    entry: candidate.entry.trim(),
    priority,
    capabilities,
  };
}

function isPathWithinDirectory(directory: string, targetPath: string): boolean {
  const relative = path.relative(directory, targetPath);
  if (relative.length === 0) {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function isCanonicalPathWithinDirectory(directory: string, targetPath: string): Promise<boolean> {
  const [resolvedDirectory, resolvedTargetPath] = await Promise.all([fs.realpath(directory), fs.realpath(targetPath)]);
  return isPathWithinDirectory(resolvedDirectory, resolvedTargetPath);
}

async function validateExtensionDirectory(directory: string): Promise<ValidatedExtensionDirectory> {
  const manifestPath = path.join(directory, "manifest.json");
  if (!(await pathExists(manifestPath))) {
    throw new PmCliError(`Extension manifest is missing at "${manifestPath}".`, EXIT_CODE.USAGE);
  }

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new PmCliError(
      `Failed to parse extension manifest at "${manifestPath}": ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODE.USAGE,
    );
  }

  const manifest = parseExtensionManifest(parsedManifest);
  if (!manifest) {
    throw new PmCliError(`Extension manifest at "${manifestPath}" is invalid.`, EXIT_CODE.USAGE);
  }

  const entryPath = path.resolve(directory, manifest.entry);
  if (!isPathWithinDirectory(directory, entryPath)) {
    throw new PmCliError(
      `Extension entry "${manifest.entry}" resolves outside extension directory "${directory}".`,
      EXIT_CODE.USAGE,
    );
  }
  if (!(await pathExists(entryPath))) {
    throw new PmCliError(`Extension entry file is missing at "${entryPath}".`, EXIT_CODE.USAGE);
  }
  if (!(await isCanonicalPathWithinDirectory(directory, entryPath))) {
    throw new PmCliError(
      `Extension entry "${manifest.entry}" resolves outside extension directory after symlink resolution.`,
      EXIT_CODE.USAGE,
    );
  }

  return {
    directory,
    manifest_path: manifestPath,
    entry_path: entryPath,
    manifest,
  };
}

export function resolveManagedExtensionStatePath(extensionsRoot: string): string {
  return path.join(extensionsRoot, MANAGED_EXTENSION_STATE_FILENAME);
}

function createEmptyManagedExtensionState(): ManagedExtensionState {
  return {
    version: MANAGED_EXTENSION_STATE_VERSION,
    updated_at: nowIso(),
    entries: [],
  };
}

function sortManagedEntries(entries: ManagedExtensionRecord[]): ManagedExtensionRecord[] {
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

function normalizeManagedState(raw: unknown): ManagedExtensionState | null {
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
      (source.kind !== "local" && source.kind !== "github" && source.kind !== "npm") ||
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

function normalizeExtensionNameForMatch(value: string): string {
  return value.trim().toLowerCase();
}

async function resolveBundledAliasManifestName(input: string): Promise<string | null> {
  const bundledAliasSource = await resolveBundledExtensionAliasSource(input);
  if (!bundledAliasSource) {
    return null;
  }
  try {
    const validated = await validateExtensionDirectory(bundledAliasSource);
    return validated.manifest.name;
  } catch {
    return null;
  }
}

async function resolveInstalledExtensionCandidate(
  installed: ManagedExtensionSummary[],
  extensionTarget: string,
): Promise<ManagedExtensionSummary | undefined> {
  const lookupValues = [extensionTarget];
  const bundledAliasManifestName = await resolveBundledAliasManifestName(extensionTarget);
  if (bundledAliasManifestName) {
    lookupValues.push(bundledAliasManifestName);
  }
  const normalizedLookups = [...new Set(lookupValues.map((value) => normalizeExtensionNameForMatch(value)).filter((value) => value.length > 0))];
  for (const lookup of normalizedLookups) {
    const byName = installed.find((entry) => normalizeExtensionNameForMatch(entry.name) === lookup);
    if (byName) {
      return byName;
    }
    const byDirectory = installed.find((entry) => normalizeExtensionNameForMatch(entry.directory) === lookup);
    if (byDirectory) {
      return byDirectory;
    }
  }
  return undefined;
}

function isExtensionEnabled(settings: PmSettings, name: string): boolean {
  const normalizedName = name.trim();
  const enabled = new Set(normalizeStringList(settings.extensions.enabled));
  const disabled = new Set(normalizeStringList(settings.extensions.disabled));
  if (disabled.has(normalizedName)) {
    return false;
  }
  if (enabled.size === 0) {
    return true;
  }
  return enabled.has(normalizedName);
}

function ensureActivated(settings: PmSettings, name: string): boolean {
  const normalizedName = name.trim();
  const enabled = new Set(normalizeStringList(settings.extensions.enabled));
  const disabled = new Set(normalizeStringList(settings.extensions.disabled));
  const previousEnabled = [...enabled];
  const previousDisabled = [...disabled];
  disabled.delete(normalizedName);
  if (enabled.size > 0) {
    enabled.add(normalizedName);
  }
  settings.extensions.enabled = [...enabled].sort((left, right) => left.localeCompare(right));
  settings.extensions.disabled = [...disabled].sort((left, right) => left.localeCompare(right));
  return (
    settings.extensions.enabled.join("\u0000") !== previousEnabled.join("\u0000") ||
    settings.extensions.disabled.join("\u0000") !== previousDisabled.join("\u0000")
  );
}

function ensureDeactivated(settings: PmSettings, name: string): boolean {
  const normalizedName = name.trim();
  const enabled = new Set(normalizeStringList(settings.extensions.enabled));
  const disabled = new Set(normalizeStringList(settings.extensions.disabled));
  const previousEnabled = [...enabled];
  const previousDisabled = [...disabled];
  enabled.delete(normalizedName);
  disabled.add(normalizedName);
  settings.extensions.enabled = [...enabled].sort((left, right) => left.localeCompare(right));
  settings.extensions.disabled = [...disabled].sort((left, right) => left.localeCompare(right));
  return (
    settings.extensions.enabled.join("\u0000") !== previousEnabled.join("\u0000") ||
    settings.extensions.disabled.join("\u0000") !== previousDisabled.join("\u0000")
  );
}

function clearExtensionState(settings: PmSettings, name: string): boolean {
  const normalizedName = name.trim();
  const enabled = new Set(normalizeStringList(settings.extensions.enabled));
  const disabled = new Set(normalizeStringList(settings.extensions.disabled));
  const previousEnabled = [...enabled];
  const previousDisabled = [...disabled];
  enabled.delete(normalizedName);
  disabled.delete(normalizedName);
  settings.extensions.enabled = [...enabled].sort((left, right) => left.localeCompare(right));
  settings.extensions.disabled = [...disabled].sort((left, right) => left.localeCompare(right));
  return (
    settings.extensions.enabled.join("\u0000") !== previousEnabled.join("\u0000") ||
    settings.extensions.disabled.join("\u0000") !== previousDisabled.join("\u0000")
  );
}

function resolveAction(target: string | undefined, options: ExtensionCommandOptions): ExtensionCommandAction {
  const selected = [...new Set([
    options.install ? "install" : null,
    options.uninstall ? "uninstall" : null,
    options.explore ? "explore" : null,
    options.manage ? "manage" : null,
    options.reload ? "reload" : null,
    options.doctor ? "doctor" : null,
    options.init ? "init" : null,
    options.scaffold ? "init" : null,
    options.adopt ? "adopt" : null,
    options.adoptAll ? "adopt-all" : null,
    options.activate ? "activate" : null,
    options.deactivate ? "deactivate" : null,
  ].filter((value): value is ExtensionCommandAction => value !== null))];
  if (selected.length === 0) {
    if (typeof target === "string" && target.trim().toLowerCase() === "doctor") {
      return "doctor";
    }
    if (typeof target === "string" && target.trim().toLowerCase() === "reload") {
      return "reload";
    }
    if (typeof target === "string" && (target.trim().toLowerCase() === "init" || target.trim().toLowerCase() === "scaffold")) {
      return "init";
    }
    throw new PmCliError(
      "One action flag is required. Use one of: --install, --uninstall, --explore, --manage, --reload, --doctor, --init/--scaffold, --adopt, --adopt-all, --activate, --deactivate.",
      EXIT_CODE.USAGE,
    );
  }
  if (selected.length > 1) {
    throw new PmCliError("Extension action flags are mutually exclusive.", EXIT_CODE.USAGE);
  }
  return selected[0];
}

function resolveScope(options: ExtensionCommandOptions): ExtensionScope {
  const projectLike = options.project === true || options.local === true;
  const global = options.global === true;
  if (projectLike && global) {
    throw new PmCliError('Options "--project/--local" and "--global" are mutually exclusive.', EXIT_CODE.USAGE);
  }
  return global ? "global" : "project";
}

function parseGithubPathSpec(pathSpec: string, input: string, refOverride?: string): GithubInstallSource | null {
  const segments = pathSpec
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return null;
  }
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");
  if (owner.length === 0 || repo.length === 0) {
    return null;
  }
  const tail = segments.slice(2);
  let ref: string | undefined;
  let subpath: string | undefined;
  if (tail[0] === "tree" && tail.length >= 2) {
    ref = tail[1];
    subpath = tail.slice(2).join("/");
  } else if (tail.length > 0) {
    subpath = tail.join("/");
  }
  if (typeof refOverride === "string" && refOverride.trim().length > 0) {
    ref = refOverride.trim();
  }
  return {
    kind: "github",
    input,
    owner,
    repo,
    repository: `https://github.com/${owner}/${repo}.git`,
    ref,
    subpath: subpath && subpath.length > 0 ? subpath : undefined,
  };
}

export function parseExtensionInstallSource(input: string, options: { forceGithub?: boolean; ref?: string } = {}): InstallSource {
  const normalizedInput = input.trim();
  if (normalizedInput.length === 0) {
    throw new PmCliError("Extension source is required for --install.", EXIT_CODE.USAGE);
  }
  const refOverride = typeof options.ref === "string" && options.ref.trim().length > 0 ? options.ref.trim() : undefined;

  if (normalizedInput.startsWith("npm:")) {
    const spec = normalizedInput.slice("npm:".length).trim();
    if (spec.length === 0) {
      throw new PmCliError('npm package source must include a package spec after "npm:".', EXIT_CODE.USAGE);
    }
    if (options.forceGithub) {
      throw new PmCliError('Options "--gh/--github" cannot be combined with npm: package sources.', EXIT_CODE.USAGE);
    }
    if (refOverride) {
      throw new PmCliError('Option "--ref" cannot be combined with npm: package sources.', EXIT_CODE.USAGE);
    }
    return {
      kind: "npm",
      input: normalizedInput,
      spec,
    };
  }

  const maybeGithubByUrl = (() => {
    try {
      const parsed = new URL(normalizedInput);
      if (parsed.hostname !== "github.com") {
        return null;
      }
      const pathSpec = parsed.pathname.replace(/^\/+/, "");
      return parseGithubPathSpec(pathSpec, normalizedInput, refOverride);
    } catch {
      return null;
    }
  })();
  if (maybeGithubByUrl) {
    return maybeGithubByUrl;
  }

  const strippedDomainInput = normalizedInput.startsWith("github.com/") ? normalizedInput.slice("github.com/".length) : null;
  if (strippedDomainInput) {
    const parsed = parseGithubPathSpec(strippedDomainInput, normalizedInput, refOverride);
    if (!parsed) {
      throw new PmCliError(`Invalid GitHub source "${normalizedInput}".`, EXIT_CODE.USAGE);
    }
    return parsed;
  }

  if (options.forceGithub) {
    const parsed = parseGithubPathSpec(normalizedInput, normalizedInput, refOverride);
    if (!parsed) {
      throw new PmCliError(`Invalid GitHub shorthand "${normalizedInput}".`, EXIT_CODE.USAGE);
    }
    return parsed;
  }

  if (/^https?:\/\//i.test(normalizedInput)) {
    throw new PmCliError(
      `Unsupported extension source URL "${normalizedInput}". Supported remote source host: github.com.`,
      EXIT_CODE.USAGE,
    );
  }

  return {
    kind: "local",
    input: normalizedInput,
    absolute_path: path.resolve(process.cwd(), normalizedInput),
  };
}

async function runGitCommand(args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { encoding: "utf8" });
    return (result.stdout ?? "").trim();
  } catch (error: unknown) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String((error as { stderr: unknown }).stderr) : "";
    const message = stderr.trim().length > 0 ? stderr.trim() : error instanceof Error ? error.message : String(error);
    throw new PmCliError(`Git command failed: git ${args.join(" ")}\n${message}`, EXIT_CODE.GENERIC_FAILURE);
  }
}

async function runNpmCommand(args: string[], cwd?: string): Promise<string> {
  try {
    const result = await execFileAsync("npm", args, { cwd, encoding: "utf8" });
    return (result.stdout ?? "").trim();
  } catch (error: unknown) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String((error as { stderr: unknown }).stderr) : "";
    const message = stderr.trim().length > 0 ? stderr.trim() : error instanceof Error ? error.message : String(error);
    throw new PmCliError(`npm command failed: npm ${args.join(" ")}\n${message}`, EXIT_CODE.GENERIC_FAILURE);
  }
}

async function resolveLocalNpmPackagePath(spec: string): Promise<string | null> {
  if (path.isAbsolute(spec) || spec.startsWith(".") || spec.startsWith("..")) {
    const absolutePath = path.resolve(process.cwd(), spec);
    return (await pathExists(absolutePath)) ? absolutePath : null;
  }

  try {
    const parsed = new URL(spec);
    if (parsed.protocol === "file:") {
      const absolutePath = fileURLToPath(parsed);
      return (await pathExists(absolutePath)) ? absolutePath : null;
    }
  } catch {
    // Registry package specs are not URLs.
  }

  return null;
}

async function resolveNpmPackSpec(spec: string): Promise<string> {
  const localPath = await resolveLocalNpmPackagePath(spec);
  if (localPath) {
    return pathToFileURL(localPath).href;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) {
    return spec;
  }

  return spec;
}

function parsePackedNpmPackage(stdout: string, packDirectory: string): { tarball: string; package?: string; version?: string } {
  try {
    const parsed = JSON.parse(stdout) as Array<{ filename?: unknown; name?: unknown; version?: unknown }>;
    const first = Array.isArray(parsed) ? parsed[0] : undefined;
    if (first && typeof first.filename === "string" && first.filename.trim().length > 0) {
      return {
        tarball: path.resolve(packDirectory, first.filename),
        package: typeof first.name === "string" ? first.name : undefined,
        version: typeof first.version === "string" ? first.version : undefined,
      };
    }
  } catch {
    // Fall back to the last stdout line for older npm output.
  }
  const lastLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (!lastLine) {
    throw new PmCliError("npm pack did not report a tarball filename.", EXIT_CODE.GENERIC_FAILURE);
  }
  return {
    tarball: path.resolve(packDirectory, lastLine),
  };
}

async function resolveNpmSourceDirectory(source: NpmInstallSource): Promise<{
  directory: string;
  package?: string;
  version?: string;
  cleanup: () => Promise<void>;
}> {
  const localPackageRoot = await resolveLocalNpmPackagePath(source.spec);
  if (localPackageRoot) {
    const packageJsonPath = path.join(localPackageRoot, "package.json");
    const packageJson = (await pathExists(packageJsonPath))
      ? JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { name?: unknown; version?: unknown }
      : {};
    return {
      directory: await resolvePackageExtensionDirectory(localPackageRoot, source.input),
      package: typeof packageJson.name === "string" ? packageJson.name : undefined,
      version: typeof packageJson.version === "string" ? packageJson.version : undefined,
      cleanup: async () => {},
    };
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-npm-package-source-"));
  const packDirectory = path.join(tempRoot, "pack");
  const extractDirectory = path.join(tempRoot, "extract");
  await fs.mkdir(packDirectory, { recursive: true });
  await fs.mkdir(extractDirectory, { recursive: true });

  try {
    const packSpec = await resolveNpmPackSpec(source.spec);
    const packStdout = await runNpmCommand(["pack", packSpec, "--json", "--pack-destination", packDirectory]);
    const packed = parsePackedNpmPackage(packStdout, packDirectory);
    await execFileAsync("tar", ["-xzf", packed.tarball, "-C", extractDirectory], { encoding: "utf8" });
    const packageRoot = path.join(extractDirectory, "package");
    const directory = await resolvePackageExtensionDirectory(packageRoot, source.input);
    return {
      directory,
      package: packed.package,
      version: packed.version,
      cleanup: async () => {
        await fs.rm(tempRoot, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function listManifestDirectories(parentDirectory: string): Promise<string[]> {
  if (!(await pathExists(parentDirectory))) {
    return [];
  }
  const entries = await fs.readdir(parentDirectory, { withFileTypes: true });
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = path.join(parentDirectory, entry.name);
    if (await pathExists(path.join(directory, "manifest.json"))) {
      candidates.push(directory);
    }
  }
  return candidates.sort((left, right) => left.localeCompare(right));
}

interface PackageJsonResourceManifest {
  extensions?: unknown;
}

async function readPackageExtensionManifest(packageRoot: string): Promise<PackageJsonResourceManifest | null> {
  const packageJsonPath = path.join(packageRoot, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return null;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
      pm?: PackageJsonResourceManifest;
      pi?: PackageJsonResourceManifest;
    };
    return parsed.pm ?? parsed.pi ?? null;
  } catch (error: unknown) {
    throw new PmCliError(
      `Failed to parse package manifest at "${packageJsonPath}": ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODE.USAGE,
    );
  }
}

async function collectPackageExtensionDirectories(packageRoot: string): Promise<string[]> {
  if (await pathExists(path.join(packageRoot, "manifest.json"))) {
    return [packageRoot];
  }

  const manifest = await readPackageExtensionManifest(packageRoot);
  const manifestEntries = Array.isArray(manifest?.extensions)
    ? manifest.extensions.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const discovered = new Set<string>();

  for (const entry of manifestEntries) {
    if (entry.includes("*") || entry.startsWith("!")) {
      throw new PmCliError(
        `Package extension entry "${entry}" uses a glob/exclusion pattern. pm package installs currently require concrete extension paths or directories.`,
        EXIT_CODE.USAGE,
      );
    }
    const absolute = path.resolve(packageRoot, entry);
    if (!isPathWithinDirectory(packageRoot, absolute)) {
      throw new PmCliError(`Package extension entry "${entry}" resolves outside package root.`, EXIT_CODE.USAGE);
    }
    if (await pathExists(path.join(absolute, "manifest.json"))) {
      discovered.add(absolute);
      continue;
    }
    for (const child of await listManifestDirectories(absolute)) {
      discovered.add(child);
    }
  }

  if (manifestEntries.length === 0) {
    const conventionalRoots = [
      path.join(packageRoot, ".agents", "pm", "extensions"),
      path.join(packageRoot, "extensions"),
      path.join(packageRoot, ".custom", "pm-extensions"),
      path.join(packageRoot, ".custom", "pm-extension"),
    ];
    for (const root of conventionalRoots) {
      for (const child of await listManifestDirectories(root)) {
        discovered.add(child);
      }
    }
  }

  return [...discovered].sort((left, right) => left.localeCompare(right));
}

async function resolvePackageExtensionDirectory(packageRoot: string, sourceLabel: string): Promise<string> {
  const discovered = await collectPackageExtensionDirectories(packageRoot);
  if (discovered.length === 1) {
    return discovered[0];
  }
  if (discovered.length > 1) {
    const choices = discovered
      .map((entry) => path.relative(packageRoot, entry).replaceAll(path.sep, "/"))
      .sort((left, right) => left.localeCompare(right));
    throw new PmCliError(
      `Package source "${sourceLabel}" contains multiple extension manifests. Provide an explicit extension path. Candidates: ${choices.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  throw new PmCliError(
    `Unable to locate a pm extension manifest in package source "${sourceLabel}". Add package.json pm.extensions/pi.extensions or an extensions/ directory.`,
    EXIT_CODE.USAGE,
  );
}

async function resolveGithubSourceDirectory(cloneDirectory: string, source: GithubInstallSource): Promise<{ directory: string; resolved_subpath?: string }> {
  const candidatePaths: string[] = [];
  if (source.subpath) {
    candidatePaths.push(source.subpath);
    candidatePaths.push(path.posix.join(".agents/pm/extensions", source.subpath));
    candidatePaths.push(path.posix.join(".custom/pm-extensions", source.subpath));
    candidatePaths.push(path.posix.join(".custom/pm-extension", source.subpath));
  }

  for (const candidate of candidatePaths) {
    const absolute = path.resolve(cloneDirectory, candidate);
    if (await pathExists(path.join(absolute, "manifest.json"))) {
      return { directory: absolute, resolved_subpath: candidate };
    }
  }

  if (await pathExists(path.join(cloneDirectory, "manifest.json"))) {
    return { directory: cloneDirectory, resolved_subpath: "." };
  }

  const discoveredDirectory = await resolvePackageExtensionDirectory(cloneDirectory, source.input);
  return {
    directory: discoveredDirectory,
    resolved_subpath: path.relative(cloneDirectory, discoveredDirectory).replaceAll(path.sep, "/"),
  };
}

async function resolveInstallSource(source: InstallSource): Promise<ResolvedInstallSource> {
  if (source.kind === "local") {
    if (!(await pathExists(source.absolute_path))) {
      throw new PmCliError(`Local extension source does not exist: "${source.absolute_path}".`, EXIT_CODE.NOT_FOUND);
    }
    const stats = await fs.stat(source.absolute_path);
    if (!stats.isDirectory()) {
      throw new PmCliError(`Local extension source must be a directory: "${source.absolute_path}".`, EXIT_CODE.USAGE);
    }
    const directory = await resolvePackageExtensionDirectory(source.absolute_path, source.input);
    return {
      source,
      directory,
    };
  }

  if (source.kind === "npm") {
    const resolved = await resolveNpmSourceDirectory(source);
    return {
      source,
      directory: resolved.directory,
      cleanup: resolved.cleanup,
      resolved_subpath: path.relative(path.dirname(resolved.directory), resolved.directory).replaceAll(path.sep, "/"),
      npm_package: resolved.package,
      npm_version: resolved.version,
    };
  }

  const cloneDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pm-extension-source-"));
  const cloneArgs = ["clone", "--depth", "1"];
  if (source.ref) {
    cloneArgs.push("--branch", source.ref);
  }
  cloneArgs.push(source.repository, cloneDirectory);

  try {
    await runGitCommand(cloneArgs);
    const commit = await runGitCommand(["-C", cloneDirectory, "rev-parse", "HEAD"]);
    const resolved = await resolveGithubSourceDirectory(cloneDirectory, source);
    return {
      source,
      directory: resolved.directory,
      resolved_subpath: resolved.resolved_subpath,
      commit,
      cleanup: async () => {
        await fs.rm(cloneDirectory, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    await fs.rm(cloneDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function areDirectoriesEquivalent(left: string, right: string): Promise<boolean> {
  if (!(await pathExists(left)) || !(await pathExists(right))) {
    return false;
  }
  const [leftRealPath, rightRealPath] = await Promise.all([fs.realpath(left), fs.realpath(right)]);
  return leftRealPath === rightRealPath;
}

function upsertManagedEntry(state: ManagedExtensionState, entry: ManagedExtensionRecord): ManagedExtensionState {
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

function resolveUpdateCheckResolution(managedEntry: ManagedExtensionRecord | undefined): ExtensionUpdateCheckResolution {
  if (!managedEntry) {
    return {
      status: "skipped_unmanaged",
      reason: "extension_not_managed",
    };
  }
  if (managedEntry.source.kind !== "github") {
    return {
      status: "skipped_non_github",
      reason: `managed_source_kind_${managedEntry.source.kind}`,
    };
  }
  const updateError = typeof managedEntry.update_error === "string" ? managedEntry.update_error.trim() : "";
  if (updateError.length > 0) {
    return {
      status: "failed",
      reason: updateError,
    };
  }
  if (typeof managedEntry.last_update_check_at === "string" && managedEntry.last_update_check_at.trim().length > 0) {
    if (managedEntry.update_available === true) {
      return {
        status: "checked",
        reason: "update_available",
      };
    }
    if (managedEntry.update_available === false) {
      return {
        status: "checked",
        reason: "up_to_date",
      };
    }
    return {
      status: "checked",
      reason: "checked_without_commit_baseline",
    };
  }
  return {
    status: "not_checked",
    reason: "no_update_check_recorded",
  };
}

async function listInstalledExtensions(
  extensionsRoot: string,
  scope: ExtensionScope,
  settings: PmSettings,
  state: ManagedExtensionState,
): Promise<{ extensions: ManagedExtensionSummary[]; warnings: string[] }> {
  if (!(await pathExists(extensionsRoot))) {
    return {
      extensions: [],
      warnings: [],
    };
  }

  const entries = await fs.readdir(extensionsRoot, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const managedByName = new Map<string, ManagedExtensionRecord>();
  const managedByDirectory = new Map<string, ManagedExtensionRecord>();
  for (const managedEntry of state.entries) {
    managedByName.set(normalizeExtensionNameForMatch(managedEntry.name), managedEntry);
    managedByDirectory.set(normalizeExtensionNameForMatch(managedEntry.directory), managedEntry);
  }

  const warnings: string[] = [];
  const summaries: ManagedExtensionSummary[] = [];
  for (const directoryName of directories) {
    const extensionDirectory = path.join(extensionsRoot, directoryName);
    const manifestPath = path.join(extensionDirectory, "manifest.json");
    if (!(await pathExists(manifestPath))) {
      warnings.push(`extension_manifest_missing:${scope}:${directoryName}`);
      const managedEntry = managedByDirectory.get(normalizeExtensionNameForMatch(directoryName));
      const updateCheck = resolveUpdateCheckResolution(managedEntry);
      const enabled = managedEntry ? isExtensionEnabled(settings, managedEntry.name) : false;
      summaries.push({
        name: managedEntry?.name ?? directoryName,
        directory: directoryName,
        version: managedEntry?.manifest_version ?? "unknown",
        entry: managedEntry?.manifest_entry ?? "unknown",
        scope,
        active: enabled,
        enabled,
        runtime_active: null,
        activation_status: "unknown",
        managed: Boolean(managedEntry),
        source: managedEntry?.source,
        update_available: managedEntry?.update_available,
        last_update_check_at: managedEntry?.last_update_check_at,
        last_update_remote_commit: managedEntry?.last_update_remote_commit,
        update_error: managedEntry?.update_error,
        update_check_status: updateCheck.status,
        update_check_reason: updateCheck.reason,
      });
      continue;
    }

    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
    } catch {
      warnings.push(`extension_manifest_invalid_json:${scope}:${directoryName}`);
      continue;
    }
    const manifest = parseExtensionManifest(rawManifest);
    if (!manifest) {
      warnings.push(`extension_manifest_invalid:${scope}:${directoryName}`);
      continue;
    }
    const managedEntry =
      managedByName.get(normalizeExtensionNameForMatch(manifest.name)) ??
      managedByDirectory.get(normalizeExtensionNameForMatch(directoryName));
    const updateCheck = resolveUpdateCheckResolution(managedEntry);
    const enabled = isExtensionEnabled(settings, manifest.name);
    summaries.push({
      name: manifest.name,
      directory: directoryName,
      version: manifest.version,
      entry: manifest.entry,
      scope,
      active: enabled,
      enabled,
      runtime_active: null,
      activation_status: "unknown",
      managed: Boolean(managedEntry),
      source: managedEntry?.source,
      update_available: managedEntry?.update_available,
      last_update_check_at: managedEntry?.last_update_check_at,
      last_update_remote_commit: managedEntry?.last_update_remote_commit,
      update_error: managedEntry?.update_error,
      update_check_status: updateCheck.status,
      update_check_reason: updateCheck.reason,
    });
  }
  return {
    extensions: summaries.sort((left, right) => left.name.localeCompare(right.name)),
    warnings: warnings.sort((left, right) => left.localeCompare(right)),
  };
}

function applyDoctorRuntimeActivationState(
  extensions: ManagedExtensionSummary[],
  loadResult: Awaited<ReturnType<typeof loadExtensions>>,
  activationResult: Awaited<ReturnType<typeof activateExtensions>>,
): ManagedExtensionSummary[] {
  const loadedNames = new Set(loadResult.loaded.map((entry) => normalizeExtensionNameForMatch(entry.name)));
  const loadFailedNames = new Set(loadResult.failed.map((entry) => normalizeExtensionNameForMatch(entry.name)));
  const activationFailedNames = new Set(activationResult.failed.map((entry) => normalizeExtensionNameForMatch(entry.name)));

  return extensions.map((entry) => {
    if (!entry.enabled) {
      return {
        ...entry,
        runtime_active: false,
        activation_status: "not_loaded",
      };
    }

    const normalizedName = normalizeExtensionNameForMatch(entry.name);
    if (loadFailedNames.has(normalizedName) || activationFailedNames.has(normalizedName)) {
      return {
        ...entry,
        runtime_active: false,
        activation_status: "failed",
      };
    }

    if (loadedNames.has(normalizedName)) {
      return {
        ...entry,
        runtime_active: true,
        activation_status: "ok",
      };
    }

    return {
      ...entry,
      runtime_active: false,
      activation_status: "not_loaded",
    };
  });
}

interface GithubUpdateStatus {
  checked_at: string;
  available: boolean | null;
  remote_commit?: string;
  error?: string;
}

async function checkGithubUpdate(source: ManagedExtensionSource): Promise<GithubUpdateStatus> {
  const checkedAt = nowIso();
  if (source.kind !== "github" || !source.repository) {
    return {
      checked_at: checkedAt,
      available: null,
      error: "not_a_github_managed_source",
    };
  }
  try {
    const ref = source.ref && source.ref.trim().length > 0 ? source.ref.trim() : "HEAD";
    const output = await runGitCommand(["ls-remote", source.repository, ref]);
    const firstLine = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!firstLine) {
      return {
        checked_at: checkedAt,
        available: null,
        error: "no_remote_reference_found",
      };
    }
    const [remoteCommit] = firstLine.split(/\s+/);
    if (typeof remoteCommit !== "string" || remoteCommit.length === 0) {
      return {
        checked_at: checkedAt,
        available: null,
        error: "invalid_remote_reference",
      };
    }
    if (typeof source.commit === "string" && source.commit.trim().length > 0) {
      return {
        checked_at: checkedAt,
        remote_commit: remoteCommit,
        available: remoteCommit !== source.commit.trim(),
      };
    }
    return {
      checked_at: checkedAt,
      remote_commit: remoteCommit,
      available: null,
      error: "missing_installed_commit",
    };
  } catch (error: unknown) {
    return {
      checked_at: checkedAt,
      available: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

interface AdoptedUnmanagedExtension {
  name: string;
  directory: string;
  version: string;
  entry: string;
  source: ManagedExtensionSource;
}

interface AdoptUnmanagedExtensionsResult {
  state: ManagedExtensionState;
  adopted_entries: AdoptedUnmanagedExtension[];
  unmanaged_candidates: ManagedExtensionSummary[];
  already_managed_count: number;
}

async function adoptUnmanagedExtensions(
  extensionsRoot: string,
  scope: ExtensionScope,
  installedExtensions: ManagedExtensionSummary[],
  state: ManagedExtensionState,
): Promise<AdoptUnmanagedExtensionsResult> {
  const unmanagedCandidates = installedExtensions.filter((entry) => !entry.managed);
  const sortedCandidates = [...unmanagedCandidates].sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    if (byName !== 0) {
      return byName;
    }
    return left.directory.localeCompare(right.directory);
  });

  let nextState = state;
  const adoptedEntries: AdoptedUnmanagedExtension[] = [];
  for (const candidate of sortedCandidates) {
    const extensionDirectory = path.join(extensionsRoot, candidate.directory);
    const validated = await validateExtensionDirectory(extensionDirectory);
    const now = nowIso();
    const sourceRecord: ManagedExtensionSource = {
      kind: "local",
      input: candidate.name,
      location: extensionDirectory,
    };
    nextState = upsertManagedEntry(nextState, {
      name: validated.manifest.name,
      directory: candidate.directory,
      scope,
      manifest_version: validated.manifest.version,
      manifest_entry: validated.manifest.entry,
      capabilities: [...validated.manifest.capabilities],
      installed_at: now,
      updated_at: now,
      source: sourceRecord,
    });
    adoptedEntries.push({
      name: validated.manifest.name,
      directory: candidate.directory,
      version: validated.manifest.version,
      entry: validated.manifest.entry,
      source: sourceRecord,
    });
  }

  if (adoptedEntries.length > 0) {
    await writeManagedExtensionState(extensionsRoot, nextState);
  }

  return {
    state: nextState,
    adopted_entries: adoptedEntries,
    unmanaged_candidates: sortedCandidates,
    already_managed_count: installedExtensions.length - unmanagedCandidates.length,
  };
}

function resolveExtensionRootsForScope(scope: ExtensionScope, global: GlobalOptions): {
  pm_root: string;
  scope: ExtensionScope;
  settings_root: string;
  selected_root: string;
  roots: { global: string; project: string };
} {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const roots = resolveExtensionRoots(pmRoot, process.cwd());
  const settingsRoot = scope === "global" ? resolveGlobalPmRoot(process.cwd()) : pmRoot;
  const selectedRoot = scope === "global" ? roots.global : roots.project;
  return {
    pm_root: pmRoot,
    scope,
    settings_root: settingsRoot,
    selected_root: selectedRoot,
    roots,
  };
}

function resolveGithubOption(options: ExtensionCommandOptions): string | undefined {
  if (typeof options.gh === "string" && typeof options.github === "string" && options.gh.trim() !== options.github.trim()) {
    throw new PmCliError('Options "--gh" and "--github" must match when both are provided.', EXIT_CODE.USAGE);
  }
  if (typeof options.gh === "string" && options.gh.trim().length > 0) {
    return options.gh.trim();
  }
  if (typeof options.github === "string" && options.github.trim().length > 0) {
    return options.github.trim();
  }
  return undefined;
}

function requireTarget(target: string | undefined, action: ExtensionCommandAction): string {
  const normalized = target?.trim();
  if (!normalized) {
    if (action === "init") {
      throw new PmCliError(
        'Action "init" requires a scaffold target path (for example: pm extension --init ./my-extension or pm extension init ./my-extension).',
        EXIT_CODE.USAGE,
      );
    }
    throw new PmCliError(`Action "${action}" requires an extension name or source target argument.`, EXIT_CODE.USAGE);
  }
  return normalized;
}

interface ExtensionScaffoldFileResult {
  path: string;
  status: "created" | "unchanged";
}

interface ExtensionScaffoldResult {
  extension_name: string;
  command_name: string;
  target_path: string;
  created_directory: boolean;
  files: ExtensionScaffoldFileResult[];
}

function buildStarterExtensionScaffoldFiles(extensionName: string, commandName: string): Record<string, string> {
  const manifest = `${JSON.stringify(
    {
      name: extensionName,
      version: "0.1.0",
      entry: "./index.js",
      capabilities: ["commands"],
    },
    null,
    2,
  )}\n`;
  const entrypoint = [
    "module.exports = {",
    "  activate(api) {",
    "    api.registerCommand({",
    `      name: ${JSON.stringify(commandName)},`,
    '      description: "Starter scaffold command. Replace with your own behavior.",',
    "      run: async (context) => ({",
    "        ok: true,",
    `        source: ${JSON.stringify(extensionName)},`,
    "        command: context.command,",
    '        message: "Starter extension scaffold is active.",',
    "      }),",
    "    });",
    "  },",
    "};",
    "",
  ].join("\n");
  const readme = [
    `# ${extensionName}`,
    "",
    "Generated by `pm extension --init`.",
    "",
    "## Included Files",
    "- `manifest.json`: extension metadata and capabilities.",
    "- `index.js`: starter command registration using the `commands` capability.",
    "",
    "## Quick Start",
    "```bash",
    "pm extension --install --project <scaffold-path>",
    `pm ${commandName}`,
    "pm extension --doctor --project --detail summary",
    "```",
    "",
    "## Notes",
    "- This scaffold uses CommonJS (`module.exports`) for zero-config runtime compatibility.",
    "- Update `manifest.json` capabilities and `index.js` command behavior as your extension evolves.",
    "",
  ].join("\n");
  return {
    "manifest.json": manifest,
    "index.js": entrypoint,
    "README.md": readme,
  };
}

async function scaffoldExtensionProject(target: string): Promise<ExtensionScaffoldResult> {
  const normalizedTarget = target.trim();
  const targetPath = path.resolve(process.cwd(), normalizedTarget);
  const extensionName = normalizeManagedDirectoryName(path.basename(targetPath));
  const commandName = `${extensionName} ping`;
  const scaffoldFiles = buildStarterExtensionScaffoldFiles(extensionName, commandName);

  let createdDirectory = false;
  if (await pathExists(targetPath)) {
    const existingTargetStats = await fs.stat(targetPath);
    if (!existingTargetStats.isDirectory()) {
      throw new PmCliError(
        `Scaffold target "${targetPath}" exists and is not a directory.`,
        EXIT_CODE.CONFLICT,
      );
    }
  } else {
    await fs.mkdir(targetPath, { recursive: true });
    createdDirectory = true;
  }

  const files: ExtensionScaffoldFileResult[] = [];
  for (const [relativePath, content] of Object.entries(scaffoldFiles)) {
    const absolutePath = path.join(targetPath, relativePath);
    if (await pathExists(absolutePath)) {
      const existingContent = await fs.readFile(absolutePath, "utf8");
      if (existingContent !== content) {
        throw new PmCliError(
          `Scaffold file "${relativePath}" already exists with different content in "${targetPath}". Choose a new target path or remove conflicting files.`,
          EXIT_CODE.CONFLICT,
        );
      }
      files.push({
        path: relativePath,
        status: "unchanged",
      });
      continue;
    }
    await fs.writeFile(absolutePath, content, "utf8");
    files.push({
      path: relativePath,
      status: "created",
    });
  }

  return {
    extension_name: extensionName,
    command_name: commandName,
    target_path: targetPath,
    created_directory: createdDirectory,
    files,
  };
}

function classifyDoctorLoadFailureWarnings(loadFailures: Array<{ name: string; error: string }>): string[] {
  const warnings: string[] = [];
  for (const failure of loadFailures) {
    const normalizedError = failure.error.toLowerCase();
    if (
      normalizedError.includes("cannot find package '@unbrained/pm-cli'") ||
      normalizedError.includes('cannot find module "@unbrained/pm-cli"') ||
      normalizedError.includes("cannot find module '@unbrained/pm-cli'")
    ) {
      warnings.push(`extension_load_failed_sdk_dependency_missing:${failure.name}`);
    }
    if (
      normalizedError.includes("cannot use import statement outside a module") ||
      normalizedError.includes("to load an es module") ||
      normalizedError.includes("must use import to load es module")
    ) {
      warnings.push(`extension_load_failed_module_mode_mismatch:${failure.name}`);
    }
  }
  return [...new Set(warnings)].sort((left, right) => left.localeCompare(right));
}

function buildExtensionTriageSummary(
  scope: ExtensionScope,
  warnings: string[],
  extensions: ManagedExtensionSummary[],
): ExtensionTriageSummary {
  const normalizedWarnings = [...new Set(warnings)].sort((left, right) => left.localeCompare(right));
  const managedTotal = extensions.filter((entry) => entry.managed).length;
  const enabledTotal = extensions.filter((entry) => entry.enabled).length;
  const activeTotal = extensions.filter((entry) => entry.active).length;
  const updateAvailableTotal = extensions.filter((entry) => entry.update_available === true).length;
  const unmanagedExtensions = extensions.filter((entry) => entry.managed === false);
  const unmanagedExpectedExtensions = unmanagedExtensions
    .filter((entry) => isExpectedUnmanagedExtension(entry))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const unmanagedActionRequiredExtensions = unmanagedExtensions
    .filter((entry) => !isExpectedUnmanagedExtension(entry))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const updateCheckStatusTotals: Record<ExtensionUpdateCheckStatus, number> = {
    checked: 0,
    skipped_unmanaged: 0,
    skipped_non_github: 0,
    failed: 0,
    not_checked: 0,
  };
  for (const entry of extensions) {
    updateCheckStatusTotals[entry.update_check_status] += 1;
  }
  const updateCheckFailedTotal = updateCheckStatusTotals.failed;
  const skippedUnmanagedTotal = updateCheckStatusTotals.skipped_unmanaged;
  const skippedNonGithubTotal = updateCheckStatusTotals.skipped_non_github;
  const updateHealthPartial = unmanagedActionRequiredExtensions.length > 0;
  const updateHealthCoverage = updateHealthPartial ? "partial" : "full";
  const partialCoverageWarnings = updateHealthPartial
    ? [`extension_update_health_partial_coverage:skipped_unmanaged:${unmanagedActionRequiredExtensions.length}`]
    : [];
  const effectiveWarnings = [...new Set([...normalizedWarnings, ...partialCoverageWarnings])].sort((left, right) =>
    left.localeCompare(right),
  );
  const warningCodes = [...new Set(effectiveWarnings.map((value) => warningCode(value)))].sort((left, right) =>
    left.localeCompare(right),
  );
  const policyWarnings = summarizePolicyWarnings(effectiveWarnings);
  const scopeFlag = scope === "global" ? "--global" : "--project";
  const remediation: string[] = [];
  if (normalizedWarnings.length > 0) {
    if (normalizedWarnings.some((warning) => warning.startsWith("extension_manifest_"))) {
      remediation.push(`Run pm extension --explore ${scopeFlag} to inspect discovered manifests and directories.`);
    }
    if (normalizedWarnings.some((warning) => warning.startsWith("extension_capability_unknown:"))) {
      remediation.push(
        `Unknown extension capabilities detected. Allowed capabilities: ${KNOWN_EXTENSION_CAPABILITIES.join(", ")}. ` +
          "Review extension_capability_unknown warning details for suggested replacements.",
      );
    }
    if (normalizedWarnings.some((warning) => warning.startsWith("extension_capability_legacy_alias:"))) {
      remediation.push(
        "Legacy extension capability aliases were auto-remapped to canonical capabilities. " +
          "Update manifests to canonical names (migration/validation -> schema).",
      );
    }
    if (normalizedWarnings.some((warning) => warning.startsWith("extension_command_definition_legacy_handler_alias:"))) {
      remediation.push(
        "Extension command definitions using legacy handler were auto-remapped. " +
          "Update command definitions to use run: (context) => ... for forward compatibility.",
      );
    }
    if (normalizedWarnings.some((warning) => warning.startsWith("extension_load_failed_sdk_dependency_missing:"))) {
      remediation.push(
        `Detected extension load failures caused by missing SDK dependency resolution. ` +
          `Ensure extension package dependencies include "@unbrained/pm-cli" and reinstall dependencies before running pm extension --doctor ${scopeFlag}.`,
      );
    }
    if (normalizedWarnings.some((warning) => warning.startsWith("extension_load_failed_module_mode_mismatch:"))) {
      remediation.push(
        `Detected extension module-mode mismatches. For ESM-based extension entries/imports, set package.json "type": "module" ` +
          `or use an explicit .mjs entry and rerun pm extension --doctor ${scopeFlag}.`,
      );
    }
    if (updateCheckFailedTotal > 0) {
      remediation.push(`Run pm extension --manage ${scopeFlag} after validating network and repository access.`);
    }
    if (normalizedWarnings.some((warning) => warning.startsWith("extension_manager_state_"))) {
      remediation.push(`Review and repair ${scope} managed extension state file if schema/read warnings persist.`);
    }
    if (policyWarnings.warning_count > 0) {
      remediation.push(
        "Extension governance policy warnings detected. Review settings.extensions.policy mode and allow/block lists to confirm intended capabilities and registration surfaces.",
      );
    }
  }
  if (updateHealthPartial) {
    remediation.push(
      `Update-check coverage is partial because unmanaged extensions need adoption. Adopt existing installs via pm extension --manage ${scopeFlag} --fix-managed-state (or pm extension --adopt-all ${scopeFlag}, pm extension --adopt <name> ${scopeFlag}, or reinstall via pm extension --install ${scopeFlag} <source>).`,
    );
  } else if (skippedUnmanagedTotal > 0) {
    remediation.push(
      `Loaded unmanaged extensions are currently treated as informational. Use pm extension --manage ${scopeFlag} --fix-managed-state to adopt them for update checks.`,
    );
  }
  if (skippedNonGithubTotal > 0) {
    remediation.push(`Non-GitHub managed extensions are skipped by update checks. Use doctor output for non-update diagnostics.`);
  }
  if (updateAvailableTotal > 0) {
    remediation.push(`Update available managed extensions via pm extension --install ${scopeFlag} <source>.`);
  }
  if (remediation.length === 0) {
    remediation.push(`No immediate action required. Re-run pm extension --manage ${scopeFlag} after extension changes.`);
  }
  return {
    status: effectiveWarnings.length === 0 ? "ok" : "warn",
    warning_count: effectiveWarnings.length,
    warning_codes: warningCodes,
    warnings: effectiveWarnings,
    policy_warning_count: policyWarnings.warning_count,
    policy_violation_count: policyWarnings.violation_count,
    policy_blocked_count: policyWarnings.blocked_count,
    total_extensions: extensions.length,
    managed_total: managedTotal,
    enabled_total: enabledTotal,
    active_total: activeTotal,
    update_available_total: updateAvailableTotal,
    update_health_coverage: updateHealthCoverage,
    update_health_partial: updateHealthPartial,
    unmanaged_loaded_extension_count: unmanagedExtensions.length,
    unmanaged_loaded_extensions: unmanagedExtensions
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right)),
    unmanaged_expected_extension_count: unmanagedExpectedExtensions.length,
    unmanaged_expected_extensions: unmanagedExpectedExtensions,
    unmanaged_action_required_extension_count: unmanagedActionRequiredExtensions.length,
    unmanaged_action_required_extensions: unmanagedActionRequiredExtensions,
    update_check_status_totals: updateCheckStatusTotals,
    update_check_failed_total: updateCheckFailedTotal,
    top_warnings: effectiveWarnings.slice(0, 8),
    remediation,
  };
}

function parseDoctorDetailMode(raw: string | undefined): ExtensionDoctorDetailMode {
  if (!raw || raw.trim().length === 0) {
    return "summary";
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "summary" || normalized === "deep") {
    return normalized;
  }
  throw new PmCliError(`Invalid --detail value "${raw}". Expected summary or deep.`, EXIT_CODE.USAGE);
}

function warningCode(value: string): string {
  const normalized = value.trim();
  const separator = normalized.indexOf(":");
  if (separator === -1) {
    return normalized;
  }
  return normalized.slice(0, separator);
}

function collectUnknownCapabilityGuidance(warnings: string[]): UnknownExtensionCapabilityWarningDetails[] {
  const seen = new Set<string>();
  const guidance: UnknownExtensionCapabilityWarningDetails[] = [];
  for (const warning of warnings) {
    const parsedDetails = (() => {
      const unknownWarning = parseUnknownExtensionCapabilityWarning(warning);
      if (unknownWarning) {
        return [unknownWarning];
      }
      return parseLegacyExtensionCapabilityAliasWarning(warning);
    })();
    for (const parsed of parsedDetails) {
      const key = `${parsed.layer}:${parsed.name}:${parsed.capability}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      guidance.push(parsed);
    }
  }
  return guidance;
}

function buildCapabilityContractMetadata(): {
  version: number;
  capabilities: string[];
  legacy_aliases: Record<string, string>;
} {
  return {
    version: EXTENSION_CAPABILITY_CONTRACT.version,
    capabilities: [...EXTENSION_CAPABILITY_CONTRACT.capabilities],
    legacy_aliases: { ...EXTENSION_CAPABILITY_CONTRACT.legacy_aliases },
  };
}

function isExpectedUnmanagedExtension(entry: ManagedExtensionSummary): boolean {
  const normalizedName = normalizeExtensionNameForMatch(entry.name);
  const normalizedDirectory = normalizeExtensionNameForMatch(entry.directory);
  if (normalizedName.startsWith("builtin-")) {
    return true;
  }
  return normalizedDirectory === "beads" || normalizedDirectory === "todos";
}

function buildDoctorConsistencySummary(
  scope: ExtensionScope,
  installedExtensions: ManagedExtensionSummary[],
  loadedExtensions: Array<{ layer: string; name: string }>,
  failedLoads: Array<{ name: string }>,
  disabledByFlag: boolean,
): {
  warnings: string[];
  summary: {
    active_project_count: number;
    loaded_project_count: number;
    active_project_names: string[];
    loaded_project_names: string[];
    missing_active_project_names: string[];
  };
} {
  if (scope !== "project" || disabledByFlag) {
    return {
      warnings: [],
      summary: {
        active_project_count: 0,
        loaded_project_count: 0,
        active_project_names: [],
        loaded_project_names: [],
        missing_active_project_names: [],
      },
    };
  }

  const activeProjectNames = [
    ...new Set(
      installedExtensions
        .filter((entry) => entry.active)
        .map((entry) => normalizeExtensionNameForMatch(entry.name)),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const loadedProjectNames = [
    ...new Set(
      loadedExtensions
        .filter((entry) => entry.layer === "project")
        .map((entry) => normalizeExtensionNameForMatch(entry.name)),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const failedLoadNames = new Set(failedLoads.map((entry) => normalizeExtensionNameForMatch(entry.name)));
  const missingActiveProjectNames = activeProjectNames
    .filter((name) => !loadedProjectNames.includes(name) && !failedLoadNames.has(name))
    .sort((left, right) => left.localeCompare(right));

  const warnings = missingActiveProjectNames.length > 0
    ? [`extension_doctor_consistency_active_not_loaded:${missingActiveProjectNames.join(",")}`]
    : [];

  return {
    warnings,
    summary: {
      active_project_count: activeProjectNames.length,
      loaded_project_count: loadedProjectNames.length,
      active_project_names: activeProjectNames,
      loaded_project_names: loadedProjectNames,
      missing_active_project_names: missingActiveProjectNames,
    },
  };
}

export async function runExtension(
  target: string | undefined,
  options: ExtensionCommandOptions,
  global: GlobalOptions,
): Promise<ExtensionCommandResult> {
  const action = resolveAction(target, options);
  if ((options.strictExit === true || options.failOnWarn === true) && action !== "doctor") {
    throw new PmCliError("--strict-exit and --fail-on-warn are only valid with --doctor.", EXIT_CODE.USAGE);
  }
  if (options.trace === true && action !== "doctor") {
    throw new PmCliError("--trace is only valid with --doctor.", EXIT_CODE.USAGE);
  }
  if (options.watch === true && action !== "reload") {
    throw new PmCliError("--watch is only valid with --reload.", EXIT_CODE.USAGE);
  }
  if (options.runtimeProbe === true && action !== "manage") {
    throw new PmCliError("--runtime-probe is only valid with --manage.", EXIT_CODE.USAGE);
  }
  if (options.fixManagedState === true && action !== "manage" && action !== "doctor") {
    throw new PmCliError("--fix-managed-state is only valid with --manage or --doctor.", EXIT_CODE.USAGE);
  }
  const normalizedTarget = (() => {
    const normalizedInput = target?.trim().toLowerCase();
    if (action === "doctor" && normalizedInput === "doctor") {
      return undefined;
    }
    if (action === "reload" && normalizedInput === "reload") {
      return undefined;
    }
    const inferredInitAlias =
      action === "init" &&
      options.init !== true &&
      options.scaffold !== true &&
      (normalizedInput === "init" || normalizedInput === "scaffold");
    if (inferredInitAlias) {
      return undefined;
    }
    return target;
  })();
  const scope = resolveScope(options);
  const resolvedRoots = resolveExtensionRootsForScope(scope, global);
  const warnings: string[] = [];

  const withResult = (details: Record<string, unknown>): ExtensionCommandResult => ({
    ok: true,
    action,
    scope,
    roots: {
      project: resolvedRoots.roots.project,
      global: resolvedRoots.roots.global,
      selected: resolvedRoots.selected_root,
      settings_root: resolvedRoots.settings_root,
    },
    warnings: [...new Set(warnings)].sort((left, right) => left.localeCompare(right)),
    details,
  });

  if (action === "init") {
    const githubOption = resolveGithubOption(options);
    if (githubOption !== undefined || (typeof options.ref === "string" && options.ref.trim().length > 0)) {
      throw new PmCliError('Action "init" does not accept --gh/--github/--ref options.', EXIT_CODE.USAGE);
    }
    const scaffoldTarget = requireTarget(normalizedTarget, action);
    const scaffold = await scaffoldExtensionProject(scaffoldTarget);
    const quotedTargetPath = JSON.stringify(scaffold.target_path);
    return withResult({
      scaffolded: scaffold.created_directory || scaffold.files.some((entry) => entry.status === "created"),
      extension: {
        name: scaffold.extension_name,
        command: scaffold.command_name,
      },
      target_path: scaffold.target_path,
      created_directory: scaffold.created_directory,
      files: scaffold.files,
      next_steps: [
        `Install the scaffold: pm extension --install --project ${quotedTargetPath}`,
        `Smoke-test command path: pm ${scaffold.command_name}`,
        "Run extension diagnostics: pm extension --doctor --project --detail summary",
      ],
    });
  }

  if (action === "reload") {
    if (normalizedTarget !== undefined) {
      throw new PmCliError('Action "reload" does not accept a target argument.', EXIT_CODE.USAGE);
    }
    const settings = await readSettings(resolvedRoots.settings_root);
    const reloadToken = nextExtensionReloadToken();
    const reloaded = await loadExtensions({
      pmRoot: resolvedRoots.settings_root,
      settings,
      cwd: process.cwd(),
      noExtensions: global.noExtensions,
      reload_token: reloadToken,
      cache_bust: true,
    });
    warnings.push(...reloaded.warnings);
    const activation = await activateExtensions(reloaded);
    warnings.push(...activation.warnings);
    const details = {
      reload: {
        token: reloadToken,
        cache_bust: true,
        watch: options.watch === true,
      },
      loaded_count: reloaded.loaded.length,
      failed_count: reloaded.failed.length,
      activated_count: Math.max(0, reloaded.loaded.length - activation.failed.length),
      activation_failed_count: activation.failed.length,
      loaded_extensions: reloaded.loaded.map((entry) => ({
        name: entry.name,
        layer: entry.layer,
        version: entry.version,
      })),
      failed_extensions: reloaded.failed.map((entry) => ({
        name: entry.name,
        layer: entry.layer,
        error: entry.error,
      })),
      activation_failures: activation.failed.map((entry) => ({
        name: entry.name,
        layer: entry.layer,
        error: entry.error,
      })),
    };
    if (options.watch === true) {
      warnings.push("extension_reload_watch_hint:watch_mode_requested_non_interactive_single_pass_only");
    }
    return withResult(details);
  }

  if (action === "install") {
    const githubOption = resolveGithubOption(options);
    const explicitSourceInput = githubOption ?? requireTarget(normalizedTarget, action);
    const bundledAliasSource =
      typeof githubOption === "string" ? null : await resolveBundledExtensionAliasSource(explicitSourceInput);
    const sourceInput = bundledAliasSource ?? explicitSourceInput;
    const installSource = parseExtensionInstallSource(sourceInput, {
      forceGithub: typeof githubOption === "string",
      ref: options.ref,
    });
    const resolvedSource = await resolveInstallSource(installSource);
    const settings = await readSettings(resolvedRoots.settings_root);
    const managedStateRead = await readManagedExtensionState(resolvedRoots.selected_root);
    warnings.push(...managedStateRead.warnings);
    try {
      const validated = await validateExtensionDirectory(resolvedSource.directory);
      const destinationDirectoryName = normalizeManagedDirectoryName(validated.manifest.name);
      const destinationDirectory = path.join(resolvedRoots.selected_root, destinationDirectoryName);
      const destinationExists = await pathExists(destinationDirectory);
      const installInPlace = await areDirectoriesEquivalent(validated.directory, destinationDirectory);

      await fs.mkdir(resolvedRoots.selected_root, { recursive: true });
      if (!installInPlace) {
        if (destinationExists) {
          await fs.rm(destinationDirectory, { recursive: true, force: true });
        }
        await fs.cp(validated.directory, destinationDirectory, { recursive: true, force: true });
      }

      const sourceRecord: ManagedExtensionSource =
        installSource.kind === "local"
          ? {
              kind: "local",
              input: installSource.input,
              location: installSource.absolute_path,
            }
          : installSource.kind === "npm"
            ? {
                kind: "npm",
                input: installSource.input,
                location: resolvedSource.resolved_subpath ?? ".",
                package: resolvedSource.npm_package,
                version: resolvedSource.npm_version,
              }
            : {
              kind: "github",
              input: installSource.input,
              location: resolvedSource.resolved_subpath ?? installSource.subpath ?? ".",
              repository: installSource.repository,
              owner: installSource.owner,
              repo: installSource.repo,
              ref: installSource.ref,
              subpath: resolvedSource.resolved_subpath ?? installSource.subpath,
              commit: resolvedSource.commit,
            };

      const now = nowIso();
      const existingManagedEntry = managedStateRead.state.entries.find(
        (entry) => normalizeExtensionNameForMatch(entry.name) === normalizeExtensionNameForMatch(validated.manifest.name),
      );
      const managedState = upsertManagedEntry(managedStateRead.state, {
        name: validated.manifest.name,
        directory: destinationDirectoryName,
        scope,
        manifest_version: validated.manifest.version,
        manifest_entry: validated.manifest.entry,
        capabilities: [...validated.manifest.capabilities],
        installed_at: existingManagedEntry?.installed_at ?? now,
        updated_at: now,
        source: sourceRecord,
      });
      await writeManagedExtensionState(resolvedRoots.selected_root, managedState);

      const activationChanged = ensureActivated(settings, validated.manifest.name);
      if (activationChanged) {
        await writeSettings(resolvedRoots.settings_root, settings, "settings:write");
      }

      return withResult({
        extension: {
          name: validated.manifest.name,
          version: validated.manifest.version,
          entry: validated.manifest.entry,
          capabilities: validated.manifest.capabilities,
          directory: destinationDirectoryName,
        },
        source: sourceRecord,
        destination_path: destinationDirectory,
        overwritten: destinationExists && !installInPlace,
        installed_in_place: installInPlace,
        activated: true,
        settings_changed: activationChanged,
      });
    } finally {
      if (resolvedSource.cleanup) {
        await resolvedSource.cleanup();
      }
    }
  }

  if (action === "adopt-all") {
    if (normalizedTarget !== undefined) {
      throw new PmCliError('Action "adopt-all" does not accept a target argument.', EXIT_CODE.USAGE);
    }
    const githubOption = resolveGithubOption(options);
    if (githubOption !== undefined || (typeof options.ref === "string" && options.ref.trim().length > 0)) {
      throw new PmCliError('Action "adopt-all" does not accept --gh/--github/--ref options.', EXIT_CODE.USAGE);
    }
    const settings = await readSettings(resolvedRoots.settings_root);
    const managedStateRead = await readManagedExtensionState(resolvedRoots.selected_root);
    warnings.push(...managedStateRead.warnings);
    const installed = await listInstalledExtensions(resolvedRoots.selected_root, scope, settings, managedStateRead.state);
    warnings.push(...installed.warnings);
    const adoption = await adoptUnmanagedExtensions(
      resolvedRoots.selected_root,
      scope,
      installed.extensions,
      managedStateRead.state,
    );
    const refreshedInstalled = await listInstalledExtensions(resolvedRoots.selected_root, scope, settings, adoption.state);
    warnings.push(...refreshedInstalled.warnings);
    const triage = buildExtensionTriageSummary(scope, warnings, refreshedInstalled.extensions);
    warnings.push(...triage.warnings);
    const adoptedDetails = adoption.adopted_entries.map((entry) => {
      const refreshedEntry =
        refreshedInstalled.extensions.find(
          (candidate) =>
            normalizeExtensionNameForMatch(candidate.name) === normalizeExtensionNameForMatch(entry.name) &&
            normalizeExtensionNameForMatch(candidate.directory) === normalizeExtensionNameForMatch(entry.directory),
        ) ??
        refreshedInstalled.extensions.find(
          (candidate) => normalizeExtensionNameForMatch(candidate.directory) === normalizeExtensionNameForMatch(entry.directory),
        );
      return {
        ...entry,
        update_check_status: refreshedEntry?.update_check_status ?? null,
        update_check_reason: refreshedEntry?.update_check_reason ?? null,
      };
    });
    return withResult({
      adopted_all: adoptedDetails.length > 0,
      adopted_count: adoptedDetails.length,
      already_managed_count: adoption.already_managed_count,
      extensions: adoptedDetails,
      triage,
      warning_codes: triage.warning_codes,
      update_health_partial: triage.update_health_partial,
      update_health_coverage: triage.update_health_coverage,
    });
  }

  if (action === "adopt") {
    const extensionTarget = requireTarget(normalizedTarget, action);
    const githubOption = resolveGithubOption(options);
    const settings = await readSettings(resolvedRoots.settings_root);
    const managedStateRead = await readManagedExtensionState(resolvedRoots.selected_root);
    warnings.push(...managedStateRead.warnings);
    const installed = await listInstalledExtensions(resolvedRoots.selected_root, scope, settings, managedStateRead.state);
    warnings.push(...installed.warnings);
    const candidate = await resolveInstalledExtensionCandidate(installed.extensions, extensionTarget);
    if (!candidate) {
      throw new PmCliError(`Installed extension "${extensionTarget}" was not found in ${scope} scope.`, EXIT_CODE.NOT_FOUND);
    }
    if (candidate.managed) {
      return withResult({
        adopted: false,
        already_managed: true,
        extension: {
          name: candidate.name,
          directory: candidate.directory,
        },
      });
    }

    const extensionDirectory = path.join(resolvedRoots.selected_root, candidate.directory);
    const validated = await validateExtensionDirectory(extensionDirectory);
    const now = nowIso();
    const sourceRecord: ManagedExtensionSource =
      githubOption === undefined
        ? {
            kind: "local",
            input: extensionTarget,
            location: extensionDirectory,
          }
        : (() => {
            const parsed = parseExtensionInstallSource(githubOption, {
              forceGithub: true,
              ref: options.ref,
            });
            if (parsed.kind !== "github") {
              throw new PmCliError(`Invalid GitHub shorthand "${githubOption}".`, EXIT_CODE.USAGE);
            }
            return {
              kind: "github",
              input: parsed.input,
              location: parsed.subpath ?? ".",
              repository: parsed.repository,
              owner: parsed.owner,
              repo: parsed.repo,
              ref: parsed.ref,
              subpath: parsed.subpath,
            };
          })();
    const managedState = upsertManagedEntry(managedStateRead.state, {
      name: validated.manifest.name,
      directory: candidate.directory,
      scope,
      manifest_version: validated.manifest.version,
      manifest_entry: validated.manifest.entry,
      capabilities: [...validated.manifest.capabilities],
      installed_at: now,
      updated_at: now,
      source: sourceRecord,
    });
    await writeManagedExtensionState(resolvedRoots.selected_root, managedState);
    const refreshedInstalled = await listInstalledExtensions(resolvedRoots.selected_root, scope, settings, managedState);
    warnings.push(...refreshedInstalled.warnings);
    const refreshedEntry =
      refreshedInstalled.extensions.find(
        (entry) => normalizeExtensionNameForMatch(entry.name) === normalizeExtensionNameForMatch(validated.manifest.name),
      ) ??
      refreshedInstalled.extensions.find(
        (entry) => normalizeExtensionNameForMatch(entry.directory) === normalizeExtensionNameForMatch(candidate.directory),
      );

    return withResult({
      adopted: true,
      extension: {
        name: validated.manifest.name,
        directory: candidate.directory,
        version: validated.manifest.version,
        entry: validated.manifest.entry,
      },
      source: sourceRecord,
      update_check_status: refreshedEntry?.update_check_status ?? null,
      update_check_reason: refreshedEntry?.update_check_reason ?? null,
    });
  }

  if (action === "uninstall") {
    const extensionTarget = requireTarget(normalizedTarget, action);
    const settings = await readSettings(resolvedRoots.settings_root);
    const managedStateRead = await readManagedExtensionState(resolvedRoots.selected_root);
    warnings.push(...managedStateRead.warnings);
    const installed = await listInstalledExtensions(resolvedRoots.selected_root, scope, settings, managedStateRead.state);
    warnings.push(...installed.warnings);
    const candidate = await resolveInstalledExtensionCandidate(installed.extensions, extensionTarget);
    if (!candidate) {
      throw new PmCliError(`Installed extension "${extensionTarget}" was not found in ${scope} scope.`, EXIT_CODE.NOT_FOUND);
    }
    const destinationDirectory = path.join(resolvedRoots.selected_root, candidate.directory);
    await fs.rm(destinationDirectory, { recursive: true, force: true });

    const updatedState: ManagedExtensionState = {
      ...managedStateRead.state,
      updated_at: nowIso(),
      entries: managedStateRead.state.entries.filter(
        (entry) =>
          normalizeExtensionNameForMatch(entry.name) !== normalizeExtensionNameForMatch(candidate.name) &&
          normalizeExtensionNameForMatch(entry.directory) !== normalizeExtensionNameForMatch(candidate.directory),
      ),
    };
    await writeManagedExtensionState(resolvedRoots.selected_root, updatedState);

    const stateChanged = clearExtensionState(settings, candidate.name);
    if (stateChanged) {
      await writeSettings(resolvedRoots.settings_root, settings, "settings:write");
    }

    return withResult({
      removed: true,
      extension: {
        name: candidate.name,
        directory: candidate.directory,
      },
      destination_path: destinationDirectory,
      settings_changed: stateChanged,
    });
  }

  if (action === "activate" || action === "deactivate") {
    const extensionTarget = requireTarget(normalizedTarget, action);
    const settings = await readSettings(resolvedRoots.settings_root);
    const managedStateRead = await readManagedExtensionState(resolvedRoots.selected_root);
    warnings.push(...managedStateRead.warnings);
    const installed = await listInstalledExtensions(resolvedRoots.selected_root, scope, settings, managedStateRead.state);
    warnings.push(...installed.warnings);
    const candidate = await resolveInstalledExtensionCandidate(installed.extensions, extensionTarget);
    if (!candidate) {
      throw new PmCliError(`Installed extension "${extensionTarget}" was not found in ${scope} scope.`, EXIT_CODE.NOT_FOUND);
    }

    const settingsChanged = action === "activate" ? ensureActivated(settings, candidate.name) : ensureDeactivated(settings, candidate.name);
    if (settingsChanged) {
      await writeSettings(resolvedRoots.settings_root, settings, "settings:write");
    }

    return withResult({
      extension: {
        name: candidate.name,
        directory: candidate.directory,
      },
      active: action === "activate",
      settings_changed: settingsChanged,
      settings: {
        enabled: [...settings.extensions.enabled],
        disabled: [...settings.extensions.disabled],
      },
    });
  }

  if (action === "doctor") {
    if (normalizedTarget && normalizedTarget.trim().length > 0) {
      throw new PmCliError('Action "doctor" does not accept a target argument.', EXIT_CODE.USAGE);
    }
    const detailMode = parseDoctorDetailMode(options.detail);
    const includeTrace = options.trace === true;
    if (includeTrace && detailMode !== "deep") {
      throw new PmCliError("--trace requires --detail deep with --doctor.", EXIT_CODE.USAGE);
    }
    const settings = await readSettings(resolvedRoots.settings_root);
    const managedStateRead = await readManagedExtensionState(resolvedRoots.selected_root);
    warnings.push(...managedStateRead.warnings);
    const installed = await listInstalledExtensions(resolvedRoots.selected_root, scope, settings, managedStateRead.state);
    warnings.push(...installed.warnings);
    let managedState = managedStateRead.state;
    const managedStateFix =
      options.fixManagedState === true
        ? await adoptUnmanagedExtensions(
            resolvedRoots.selected_root,
            scope,
            installed.extensions,
            managedStateRead.state,
          )
        : null;
    if (managedStateFix) {
      managedState = managedStateFix.state;
    }
    const refreshedInstalled = await listInstalledExtensions(resolvedRoots.selected_root, scope, settings, managedState);
    warnings.push(...refreshedInstalled.warnings);

    const loadResult = await loadExtensions({
      pmRoot: resolvedRoots.pm_root,
      settings,
      cwd: process.cwd(),
      noExtensions: global.noExtensions === true,
    });
    const activationResult = await activateExtensions({
      ...loadResult,
      loaded: loadResult.loaded,
    });
    warnings.push(...loadResult.warnings);
    warnings.push(...classifyDoctorLoadFailureWarnings(loadResult.failed));
    warnings.push(...activationResult.warnings);
    const runtimeInstalledExtensions = applyDoctorRuntimeActivationState(refreshedInstalled.extensions, loadResult, activationResult);
    const doctorConsistency = buildDoctorConsistencySummary(
      scope,
      runtimeInstalledExtensions,
      loadResult.loaded.map((entry) => ({ layer: entry.layer, name: entry.name })),
      loadResult.failed.map((entry) => ({ name: entry.name })),
      loadResult.disabled_by_flag,
    );
    warnings.push(...doctorConsistency.warnings);
    const updateCheckWarnings = runtimeInstalledExtensions
      .filter((entry) => entry.update_check_status === "failed")
      .map((entry) => `extension_update_check_failed:${entry.name}`);
    warnings.push(...updateCheckWarnings);

    const triage = buildExtensionTriageSummary(scope, warnings, runtimeInstalledExtensions);
    warnings.push(...triage.warnings);
    const normalizedWarnings = [...triage.warnings];
    const policySummary = {
      mode: loadResult.policy.mode,
      trust_mode: loadResult.policy.trust_mode,
      require_provenance: loadResult.policy.require_provenance,
      default_sandbox_profile: loadResult.policy.default_sandbox_profile,
      trusted_extensions_count: loadResult.policy.trusted_extensions.length,
      allowed_extensions_count: loadResult.policy.allowed_extensions.length,
      blocked_extensions_count: loadResult.policy.blocked_extensions.length,
      allowed_capabilities_count: loadResult.policy.allowed_capabilities.length,
      blocked_capabilities_count: loadResult.policy.blocked_capabilities.length,
      allowed_surfaces_count: loadResult.policy.allowed_surfaces.length,
      blocked_surfaces_count: loadResult.policy.blocked_surfaces.length,
      allowed_commands_count: loadResult.policy.allowed_commands.length,
      blocked_commands_count: loadResult.policy.blocked_commands.length,
      allowed_actions_count: loadResult.policy.allowed_actions.length,
      blocked_actions_count: loadResult.policy.blocked_actions.length,
      allowed_services_count: loadResult.policy.allowed_services.length,
      blocked_services_count: loadResult.policy.blocked_services.length,
      extension_override_count: loadResult.policy.extension_overrides.length,
    };
    const capabilityGuidance = collectUnknownCapabilityGuidance(normalizedWarnings);
    const capabilityContract = buildCapabilityContractMetadata();
    const warningCodes = triage.warning_codes;
    const remediation = [
      ...new Set(
        [
          ...triage.remediation,
          ...(loadResult.failed.length > 0
            ? ["Run pm extension --explore --project and pm extension --explore --global to inspect load failures."]
            : []),
          ...(activationResult.failed.length > 0
            ? ["Review activation failures in pm extension --doctor --detail deep output."]
            : []),
          ...(managedStateFix && managedStateFix.adopted_entries.length > 0
            ? [`Managed-state fix adopted ${managedStateFix.adopted_entries.length} extension(s).`]
            : []),
        ].map((entry) => entry.trim()).filter((entry) => entry.length > 0),
      ),
    ];

    const summary = {
      status: triage.status,
      scope,
      warning_count: triage.warning_count,
      warning_codes: warningCodes,
      total_extensions: runtimeInstalledExtensions.length,
      managed_total: runtimeInstalledExtensions.filter((entry) => entry.managed).length,
      enabled_total: runtimeInstalledExtensions.filter((entry) => entry.enabled).length,
      active_total: runtimeInstalledExtensions.filter((entry) => entry.active).length,
      unmanaged_loaded_extension_count: triage.unmanaged_loaded_extension_count,
      unmanaged_action_required_extension_count: triage.unmanaged_action_required_extension_count,
      unmanaged_expected_extension_count: triage.unmanaged_expected_extension_count,
      runtime_active_total: runtimeInstalledExtensions.filter((entry) => entry.runtime_active === true).length,
      activation_status_totals: {
        ok: runtimeInstalledExtensions.filter((entry) => entry.activation_status === "ok").length,
        failed: runtimeInstalledExtensions.filter((entry) => entry.activation_status === "failed").length,
        not_loaded: runtimeInstalledExtensions.filter((entry) => entry.activation_status === "not_loaded").length,
        unknown: runtimeInstalledExtensions.filter((entry) => entry.activation_status === "unknown").length,
      },
      unknown_capability_count: capabilityGuidance.length,
      capability_contract_version: capabilityContract.version,
      update_available_total: runtimeInstalledExtensions.filter((entry) => entry.update_available === true).length,
      update_health_coverage: triage.update_health_coverage,
      update_health_partial: triage.update_health_partial,
      update_check_failed_total: runtimeInstalledExtensions.filter((entry) => entry.update_check_status === "failed").length,
      load_failure_count: loadResult.failed.length,
      activation_failure_count: activationResult.failed.length,
      blocking_failure_count: loadResult.failed.length + activationResult.failed.length,
      has_blocking_failures: loadResult.failed.length + activationResult.failed.length > 0,
      consistency_warning_count: doctorConsistency.warnings.length,
      trace_enabled: includeTrace,
      policy: policySummary,
      remediation,
    };

    const managedStateFixSummary = managedStateFix
      ? {
          requested: true,
          applied: managedStateFix.adopted_entries.length > 0,
          adopted_count: managedStateFix.adopted_entries.length,
          already_managed_count: managedStateFix.already_managed_count,
          adopted_extensions: managedStateFix.adopted_entries.map((entry) => entry.name),
        }
      : {
          requested: false,
          applied: false,
          adopted_count: 0,
          already_managed_count: refreshedInstalled.extensions.filter((entry) => entry.managed).length,
          adopted_extensions: [] as string[],
        };

    const details: Record<string, unknown> = {
      mode: detailMode,
      summary,
      triage,
      trace_enabled: includeTrace,
      capability_contract: capabilityContract,
      capability_guidance: capabilityGuidance,
      managed_state_fix: managedStateFixSummary,
      policy: loadResult.policy,
    };
    if (detailMode === "deep") {
      const activationFailedDetails = includeTrace
        ? activationResult.failed
        : activationResult.failed.map((entry) => {
            const { trace: _trace, ...rest } = entry;
            return rest;
          });
      details.deep = {
        warnings: normalizedWarnings,
        warning_codes: warningCodes,
        capability_contract: capabilityContract,
        capability_guidance: capabilityGuidance,
        trace_enabled: includeTrace,
        managed_state: {
          path: managedStateRead.path,
          count: managedState.entries.length,
          entries: managedState.entries,
        },
        installed_extensions: runtimeInstalledExtensions,
        load: {
          roots: loadResult.roots,
          policy: loadResult.policy,
          warnings: loadResult.warnings,
          failed: loadResult.failed,
          loaded: loadResult.loaded.map((entry) => ({
            layer: entry.layer,
            directory: entry.directory,
            name: entry.name,
            version: entry.version,
            entry: entry.entry,
            priority: entry.priority,
          })),
        },
        activation: {
          failed: activationFailedDetails,
          warnings: activationResult.warnings,
          hook_counts: activationResult.hook_counts,
          registration_counts: activationResult.registration_counts,
          parser_override_count: activationResult.parser_override_count,
          preflight_override_count: activationResult.preflight_override_count,
          service_override_count: activationResult.service_override_count,
          renderer_override_count: activationResult.renderer_override_count,
        },
        consistency: doctorConsistency.summary,
      };
      if (includeTrace) {
        (details.deep as Record<string, unknown>).trace = {
          activation_failures: activationResult.failed
            .filter((entry) => entry.trace !== undefined)
            .map((entry) => ({
              layer: entry.layer,
              name: entry.name,
              entry_path: entry.entry_path,
              error: entry.error,
              method: entry.trace?.method,
              command: entry.trace?.command,
              registration_index: entry.trace?.registration_index,
              expected_schema: entry.trace?.expected_schema,
              hint: entry.trace?.hint,
              received: entry.trace?.received,
            })),
        };
      }
    }
    return withResult(details);
  }

  if (action === "explore" || action === "manage") {
    const settings = await readSettings(resolvedRoots.settings_root);
    const configuredPolicy = buildExtensionPolicyDetails(settings.extensions.policy);
    const managedStateRead = await readManagedExtensionState(resolvedRoots.selected_root);
    warnings.push(...managedStateRead.warnings);
    const installed = await listInstalledExtensions(resolvedRoots.selected_root, scope, settings, managedStateRead.state);
    warnings.push(...installed.warnings);

    let managedState = managedStateRead.state;
    const managedStateFix =
      action === "manage" && options.fixManagedState === true
        ? await adoptUnmanagedExtensions(
            resolvedRoots.selected_root,
            scope,
            installed.extensions,
            managedStateRead.state,
          )
        : null;
    if (managedStateFix) {
      managedState = managedStateFix.state;
    }
    if (action === "manage") {
      const updates = await Promise.all(
        managedState.entries.map(async (entry) => {
          if (entry.source.kind !== "github") {
            return entry;
          }
          const updateStatus = await checkGithubUpdate(entry.source);
          return {
            ...entry,
            last_update_check_at: updateStatus.checked_at,
            last_update_remote_commit: updateStatus.remote_commit,
            update_available: updateStatus.available,
            update_error: updateStatus.error,
          };
        }),
      );
      managedState = {
        ...managedState,
        updated_at: nowIso(),
        entries: sortManagedEntries(updates),
      };
      await writeManagedExtensionState(resolvedRoots.selected_root, managedState);
    }

    const refreshedInstalled = await listInstalledExtensions(resolvedRoots.selected_root, scope, settings, managedState);
    warnings.push(...refreshedInstalled.warnings);
    if (action === "manage") {
      const updateWarnings = refreshedInstalled.extensions
        .filter((entry) => entry.update_check_status === "failed")
        .map((entry) => `extension_update_check_failed:${entry.name}`);
      warnings.push(...updateWarnings);
    }
    let runtimeProbeSummary: Record<string, unknown> | undefined;
    let runtimeInstalledExtensions = refreshedInstalled.extensions;
    if (action === "manage" && options.runtimeProbe === true) {
      const loadResult = await loadExtensions({
        pmRoot: resolvedRoots.pm_root,
        settings,
        cwd: process.cwd(),
        noExtensions: global.noExtensions === true,
      });
      const activationResult = await activateExtensions({
        ...loadResult,
        loaded: loadResult.loaded,
      });
      warnings.push(...loadResult.warnings);
      warnings.push(...activationResult.warnings);
      runtimeInstalledExtensions = applyDoctorRuntimeActivationState(refreshedInstalled.extensions, loadResult, activationResult);
      runtimeProbeSummary = {
        requested: true,
        executed: true,
        load_failure_count: loadResult.failed.length,
        activation_failure_count: activationResult.failed.length,
        warning_count: [...new Set([...loadResult.warnings, ...activationResult.warnings])].length,
        policy: loadResult.policy,
      };
    } else if (action === "manage") {
      runtimeProbeSummary = {
        requested: options.runtimeProbe === true,
        executed: false,
      };
    }

    const triage = buildExtensionTriageSummary(scope, warnings, runtimeInstalledExtensions);
    warnings.push(...triage.warnings);
    const details: Record<string, unknown> = {
      total: runtimeInstalledExtensions.length,
      managed_total: runtimeInstalledExtensions.filter((entry) => entry.managed).length,
      enabled_total: runtimeInstalledExtensions.filter((entry) => entry.enabled).length,
      active_total: runtimeInstalledExtensions.filter((entry) => entry.active).length,
      extensions: runtimeInstalledExtensions,
      triage,
      policy: configuredPolicy,
    };
    if (action === "manage") {
      details.runtime_probe = runtimeProbeSummary;
      details.managed_state_fix =
        managedStateFix !== null
          ? {
              requested: true,
              applied: managedStateFix.adopted_entries.length > 0,
              adopted_count: managedStateFix.adopted_entries.length,
              adopted_extensions: managedStateFix.adopted_entries.map((entry) => entry.name),
              already_managed_count: managedStateFix.already_managed_count,
            }
          : {
              requested: false,
              applied: false,
              adopted_count: 0,
              adopted_extensions: [],
              already_managed_count: runtimeInstalledExtensions.filter((entry) => entry.managed).length,
            };
    }
    return withResult(details);
  }

  throw new PmCliError(`Unsupported extension action "${action}".`, EXIT_CODE.USAGE);
}
