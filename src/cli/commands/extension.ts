/**
 * @module cli/commands/extension
 *
 * Implements the pm extension command surface and its agent-facing runtime behavior.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { activateExtensions, loadExtensions, nextExtensionReloadToken } from "../../core/extensions/index.js";
import { resolveExtensionRoots } from "../../core/extensions/loader.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { isPathWithinDirectory } from "../../core/fs/path-utils.js";
import { collectPackageExtensionDirectories } from "../../core/packages/manifest.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { resolveGlobalPmRoot, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings, writeSettings } from "../../core/store/settings.js";
import type { PmSettings } from "../../types/index.js";
// Cohesive helper groups now live in ./extension/* sibling modules. They are
// imported for the command wiring that stays here and re-exported below so
// existing import sites (sdk barrels, upgrade.ts, tests) keep importing the
// public surface (runExtension, managed-state read/write, install-source
// parsing, …) from "./extension.js" unchanged.
import {
  normalizeStringList,
  normalizeExtensionNameForMatch,
  normalizeManagedDirectoryName,
  parseExtensionManifest,
  validateExtensionDirectory,
} from "./extension/shared.js";
import {
  sortManagedEntries,
  managedExtensionSourcesEquivalent,
  readManagedExtensionState,
  writeManagedExtensionState,
  upsertManagedEntry,
  resolveManagedExtensionStatePath,
  type ManagedExtensionSource,
  type ManagedExtensionRecord,
  type ManagedExtensionState,
} from "./extension/managed-state.js";
import {
  parseExtensionInstallSource,
  resolveInstallSource,
  areDirectoriesEquivalent,
  runGitCommand,
} from "./extension/install-sources.js";
import {
  resolveBundledExtensionAliasSource,
  isBundledPackageInstallAllTarget,
  listBundledPackageAliases,
  resolveBundledAliasManifestName,
  buildBundledPackageCatalog,
} from "./extension/bundled-catalog.js";
import { scaffoldExtensionProject } from "./extension/scaffold.js";
import { buildExtensionDescribeResult } from "./extension/describe.js";
import {
  applyDoctorRuntimeActivationState,
  classifyDoctorLoadFailureWarnings,
  classifyDoctorActivationFailureWarnings,
  classifyUnusedCapabilityWarnings,
  buildExtensionTriageSummary,
  parseDoctorDetailMode,
  collectUnknownCapabilityGuidance,
  buildCapabilityContractMetadata,
  buildDoctorConsistencySummary,
} from "./extension/doctor.js";
// Re-export the public surface that lives in sibling modules but was previously
// exported from this file (used by sdk barrels, upgrade.ts, and tests).
export {
  parseExtensionManifest,
  validateExtensionDirectory,
  readManagedExtensionState,
  writeManagedExtensionState,
  resolveManagedExtensionStatePath,
  parseExtensionInstallSource,
};
export type {
  ManagedExtensionSource,
  ManagedExtensionRecord,
  ManagedExtensionState,
};
export type { ManagedExtensionStateReadResult } from "./extension/managed-state.js";

const execFileAsync = promisify(execFile);
const EXTENSION_INSTALL_COPY_ATTEMPTS = 3;
const EXTENSION_INSTALL_LOCK_ATTEMPTS = 120;
const EXTENSION_INSTALL_LOCK_DELAY_MS = 250;
const EXTENSION_INSTALL_LOCK_STALE_MS = 120_000;

/**
 * Restricts extension command action values accepted by command, SDK, and storage contracts.
 */
export type ExtensionCommandAction =
  | "install"
  | "uninstall"
  | "explore"
  | "manage"
  | "describe"
  | "reload"
  | "doctor"
  | "catalog"
  | "adopt"
  | "adopt-all"
  | "activate"
  | "deactivate"
  | "init";
/**
 * Restricts extension scope values accepted by command, SDK, and storage contracts.
 */
export type ExtensionScope = "project" | "global";
/**
 * Restricts extension activation status values accepted by command, SDK, and storage contracts.
 */
export type ExtensionActivationStatus = "ok" | "failed" | "not_loaded" | "unknown";

/**
 * Documents the extension command options payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionCommandOptions {
  install?: boolean;
  uninstall?: boolean;
  explore?: boolean;
  manage?: boolean;
  describe?: boolean;
  reload?: boolean;
  doctor?: boolean;
  catalog?: boolean;
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
  fields?: string;
  capability?: string;
  vocabulary?: "extension" | "package";
}

/**
 * Documents the managed extension summary payload exchanged by command, SDK, and package integrations.
 */
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
  command_paths?: string[];
  action_paths?: string[];
  managed: boolean;
  source?: ManagedExtensionSource;
  update_available?: boolean | null;
  last_update_check_at?: string;
  last_update_remote_commit?: string;
  update_error?: string;
  update_check_status: ExtensionUpdateCheckStatus;
  update_check_reason: string;
}

/**
 * Documents the extension command result payload exchanged by command, SDK, and package integrations.
 */
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

const NATIVE_OUTPUT_MARKER = "__pm_native_output";

/**
 * Documents the extension triage summary payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionTriageSummary {
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
  collision_plan?: ExtensionCollisionPlan;
}

/**
 * Documents the extension collision plan payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionCollisionPlan {
  status: "ok" | "conflicts_detected";
  collision_count: number;
  extension_count: number;
  next_best_command: string;
  collisions: Array<{
    code: string;
    surface: string;
    winner: { layer: ExtensionScope; name: string };
    displaced: { layer: ExtensionScope; name: string };
  }>;
  remediation_candidates: Array<{
    action: "deactivate";
    extension: string;
    command: string;
    affected_collisions: number;
    feature_loss: {
      command_paths: string[];
      action_paths: string[];
    };
  }>;
}

/**
 * Restricts extension update check status values accepted by command, SDK, and storage contracts.
 */
export type ExtensionUpdateCheckStatus = "checked" | "skipped_unmanaged" | "skipped_non_github" | "failed" | "not_checked";

interface ExtensionUpdateCheckResolution {
  status: ExtensionUpdateCheckStatus;
  reason: string;
}

/**
 * Restricts extension doctor detail mode values accepted by command, SDK, and storage contracts.
 */
export type ExtensionDoctorDetailMode = "summary" | "deep";
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

function isRetriableExtensionInstallCopyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOENT";
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Implements copy extension directory for install for the public runtime surface of this module.
 */
export async function copyExtensionDirectoryForInstall(
  sourceDirectory: string,
  destinationDirectory: string,
  copyDirectory: typeof fs.cp = fs.cp,
): Promise<void> {
  for (let attempt = 1; attempt <= EXTENSION_INSTALL_COPY_ATTEMPTS; attempt += 1) {
    try {
      if (await pathExists(destinationDirectory)) {
        await fs.rm(destinationDirectory, { recursive: true, force: true });
      }
      await copyExtensionDirectoryWithoutSelfNesting(sourceDirectory, destinationDirectory, copyDirectory);
      return;
    } catch (error: unknown) {
      if (!isRetriableExtensionInstallCopyError(error) || attempt === EXTENSION_INSTALL_COPY_ATTEMPTS) {
        throw error;
      }
      await sleep(EXTENSION_INSTALL_LOCK_DELAY_MS);
    }
  }
}

async function copyExtensionDirectoryWithoutSelfNesting(
  sourceDirectory: string,
  destinationDirectory: string,
  copyDirectory: typeof fs.cp,
): Promise<void> {
  const resolvedSource = path.resolve(sourceDirectory);
  const resolvedDestination = path.resolve(destinationDirectory);
  if (resolvedSource === resolvedDestination) {
    return;
  }
  if (!isPathWithinDirectory(resolvedSource, resolvedDestination)) {
    await copyDirectory(sourceDirectory, destinationDirectory, { recursive: true, force: true });
    return;
  }

  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-extension-copy-"));
  const stagedDirectory = path.join(stagingRoot, "extension");
  try {
    await copyDirectory(sourceDirectory, stagedDirectory, { recursive: true, force: true });
    await copyDirectory(stagedDirectory, destinationDirectory, { recursive: true, force: true });
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function withExtensionInstallLock<T>(
  settingsRoot: string,
  destinationDirectoryName: string,
  run: () => Promise<T>,
  options?: {
    attempts?: number;
    delay_ms?: number;
    stale_ms?: number;
  },
): Promise<T> {
  const lockRoot = path.join(settingsRoot, "runtime", "extension-install-locks");
  const lockPath = path.join(lockRoot, `${destinationDirectoryName}.lock`);
  await fs.mkdir(lockRoot, { recursive: true });
  const attempts = Math.max(1, Math.floor(options?.attempts ?? EXTENSION_INSTALL_LOCK_ATTEMPTS));
  const delayMs = Math.max(0, Math.floor(options?.delay_ms ?? EXTENSION_INSTALL_LOCK_DELAY_MS));
  const staleMs = Math.max(0, Math.floor(options?.stale_ms ?? EXTENSION_INSTALL_LOCK_STALE_MS));

  let acquired = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.mkdir(lockPath);
      acquired = true;
      await fs.writeFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, created_at: nowIso(), destination: destinationDirectoryName }, null, 2)}\n`,
        "utf8",
      );
      break;
    } catch (error: unknown) {
      if (!isErrnoCode(error, "EEXIST")) {
        throw error;
      }
      let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
      try {
        stat = await fs.stat(lockPath);
      } catch {
        stat = null;
      }
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        await fs.rm(lockPath, { recursive: true, force: true });
        continue;
      }
      await sleep(delayMs);
    }
  }

  if (!acquired) {
    throw new PmCliError(
      `Timed out waiting for extension install lock for "${destinationDirectoryName}".`,
      EXIT_CODE.CONFLICT,
    );
  }

  try {
    return await run();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
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
    options.describe ? "describe" : null,
    options.reload ? "reload" : null,
    options.doctor ? "doctor" : null,
    options.catalog ? "catalog" : null,
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
    if (typeof target === "string" && target.trim().toLowerCase() === "catalog") {
      return "catalog";
    }
    if (typeof target === "string" && (target.trim().toLowerCase() === "init" || target.trim().toLowerCase() === "scaffold")) {
      return "init";
    }
    if (typeof target === "string" && target.trim().toLowerCase() === "explore") {
      return "explore";
    }
    if (typeof target === "string" && target.trim().toLowerCase() === "manage") {
      return "manage";
    }
    if (typeof target === "string" && (target.trim().toLowerCase() === "list" || target.trim() === "")) {
      return "explore";
    }
    if (target === undefined) {
      return "explore";
    }
    throw new PmCliError(
      "One action flag is required. Use one of: --install, --uninstall, --explore, --manage, --describe, --reload, --doctor, --catalog, --init/--scaffold, --adopt, --adopt-all, --activate, --deactivate. Bare `pm package` and `pm extension` default to --explore.",
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
interface GithubUpdateStatus {
  checked_at: string;
  available: boolean | null;
  remote_commit?: string;
  error?: string;
}
type ActivationFailureEntry = Awaited<ReturnType<typeof activateExtensions>>["failed"][number];

interface ActivationFailureDiagnostic {
  layer: string;
  name: string;
  entry_path: string;
  error: string;
  missing_capability?: string;
  hint?: string;
  trace?: {
    method: string;
    registration_index: number;
    expected_schema: string;
    command?: string;
    capability?: string;
    missing_capability?: string;
    hint?: string;
  };
}

function summarizeRuntimeCommandPathsForExtension(
  extensionName: string,
  installed: ManagedExtensionSummary[],
): { command_paths: string[]; action_paths: string[] } {
  const normalizedName = normalizeExtensionNameForMatch(extensionName);
  const entry = installed.find((candidate) => normalizeExtensionNameForMatch(candidate.name) === normalizedName);
  return {
    command_paths: [...(entry?.command_paths ?? [])].sort((left, right) => left.localeCompare(right)),
    action_paths: [...(entry?.action_paths ?? [])].sort((left, right) => left.localeCompare(right)),
  };
}

function resolveCommandDiscoveryPackageName(extensionName: string, source: ManagedExtensionSource): string {
  if (source.kind === "npm" && typeof source.package === "string" && source.package.trim().length > 0) {
    return source.package.trim();
  }
  if (source.kind === "builtin" && typeof source.name === "string" && source.name.trim().length > 0) {
    return source.name.trim();
  }
  return extensionName;
}

function buildInstallCommandDiscovery(
  extensionName: string,
  source: ManagedExtensionSource,
  commandSummary: { command_paths: string[]; action_paths: string[] },
): Record<string, unknown> {
  const helpCommands = commandSummary.command_paths.map((commandPath) => `pm ${commandPath} --help`);
  return {
    package_name: resolveCommandDiscoveryPackageName(extensionName, source),
    extension_name: extensionName,
    command_paths: commandSummary.command_paths,
    action_paths: commandSummary.action_paths,
    help_commands: helpCommands,
    next_steps:
      commandSummary.command_paths.length > 0
        ? helpCommands
        : ["Run pm package doctor --project --detail deep if expected package commands are missing."],
  };
}

function summarizeActivationFailureForDiagnostics(failure: ActivationFailureEntry): ActivationFailureDiagnostic {
  const trace = failure.trace
    ? {
        method: failure.trace.method,
        registration_index: failure.trace.registration_index,
        expected_schema: failure.trace.expected_schema,
        ...(failure.trace.command ? { command: failure.trace.command } : {}),
        ...(failure.trace.capability ? { capability: failure.trace.capability } : {}),
        ...(failure.trace.missing_capability ? { missing_capability: failure.trace.missing_capability } : {}),
        ...(failure.trace.hint ? { hint: failure.trace.hint } : {}),
      }
    : undefined;
  return {
    layer: failure.layer,
    name: failure.name,
    entry_path: failure.entry_path,
    error: failure.error,
    ...(failure.trace?.missing_capability ? { missing_capability: failure.trace.missing_capability } : {}),
    ...(failure.trace?.hint ? { hint: failure.trace.hint } : {}),
    ...(trace ? { trace } : {}),
  };
}

function collectActivationFailureDiagnostics(failures: ActivationFailureEntry[]): ActivationFailureDiagnostic[] {
  return failures
    .map((failure) => summarizeActivationFailureForDiagnostics(failure))
    .sort((left, right) => `${left.layer}:${left.name}`.localeCompare(`${right.layer}:${right.name}`));
}

function findActivationFailureByName(
  extensionName: string,
  failures: ActivationFailureDiagnostic[],
  layer?: ExtensionScope,
): ActivationFailureDiagnostic | undefined {
  const normalizedName = normalizeExtensionNameForMatch(extensionName);
  return failures.find(
    (failure) =>
      (layer === undefined || failure.layer === layer) &&
      normalizeExtensionNameForMatch(failure.name) === normalizedName,
  );
}

function resolveInstallRuntimeActivationStatus(
  extensionName: string,
  scope: ExtensionScope,
  runtimeInstalled: ManagedExtensionSummary[],
  installActivationFailure: ActivationFailureDiagnostic | undefined,
): ExtensionActivationStatus {
  const runtimeInstalledExtension = runtimeInstalled.find(
    (entry) =>
      entry.scope === scope && normalizeExtensionNameForMatch(entry.name) === normalizeExtensionNameForMatch(extensionName),
  );
  return runtimeInstalledExtension?.activation_status ?? (installActivationFailure ? "failed" : "unknown");
}

async function probeRuntimeCommandPathsForInstall(
  pmRoot: string,
  settings: PmSettings,
  refreshedInstalled: ManagedExtensionSummary[],
  global: GlobalOptions,
): Promise<{ installed: ManagedExtensionSummary[]; warnings: string[]; activation_failures: ActivationFailureDiagnostic[] }> {
  const loadResult = await loadExtensions({
    pmRoot,
    settings,
    cwd: process.cwd(),
    noExtensions: global.noExtensions === true,
    reload_token: nextExtensionReloadToken(),
    cache_bust: true,
  });
  const activationResult = await activateExtensions({
    ...loadResult,
    loaded: loadResult.loaded,
  });
  return {
    installed: applyDoctorRuntimeActivationState(refreshedInstalled, loadResult, activationResult),
    warnings: [...loadResult.warnings, ...activationResult.warnings],
    activation_failures: collectActivationFailureDiagnostics(activationResult.failed),
  };
}

async function checkGithubUpdate(
  source: ManagedExtensionSource,
  gitCommandRunner: typeof runGitCommand = runGitCommand,
): Promise<GithubUpdateStatus> {
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
    const output = await gitCommandRunner(["ls-remote", source.repository, ref]);
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
    /* c8 ignore start -- firstLine is trimmed non-empty, so split always yields a non-empty first token */
    if (typeof remoteCommit !== "string" || remoteCommit.length === 0) {
      return {
        checked_at: checkedAt,
        available: null,
        error: "invalid_remote_reference",
      };
    }
    /* c8 ignore stop */
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
        'Action "init" requires a scaffold target path (for example: pm package init ./my-package or pm extension init ./my-extension).',
        EXIT_CODE.USAGE,
      );
    }
    throw new PmCliError(`Action "${action}" requires an extension name or source target argument.`, EXIT_CODE.USAGE);
  }
  return normalized;
}

function collectGlobalOutputOverrideDoctorWarnings(
  activationResult: Awaited<ReturnType<typeof activateExtensions>>,
): string[] {
  const warnings: string[] = [];
  for (const entry of activationResult.services.overrides) {
    if (entry.service !== "output_format") {
      continue;
    }
    warnings.push(`extension_output_service_override_global:${entry.service}:${entry.layer}:${entry.name}`);
  }
  for (const entry of activationResult.renderers.overrides) {
    warnings.push(`extension_output_renderer_override_global:${entry.format}:${entry.layer}:${entry.name}`);
  }
  return [...new Set(warnings)].sort((left, right) => left.localeCompare(right));
}

/**
 * Doctor advisory: flag loaded extensions that contribute GLOBAL schema (custom
 * item types or fields) yet also declare narrow `activation.commands`.
 *
 * Custom item types and fields must be present for the built-in commands the
 * extension does not own and cannot enumerate (`pm create <type>`,
 * `pm list --type <type>`, `pm validate`). Declaring `activation.commands` gates
 * lazy activation to only the listed command paths, so the package never
 * activates for those built-ins and its custom type silently fails to register —
 * a quiet footgun (decision pm-halx). The `schema` scaffold deliberately omits
 * the field; this advisory catches hand-authored packages that do not. It is
 * doctor-only and non-blocking — `pm health` does not surface it — so the author
 * can either drop `activation.commands` or, when the schema is intentionally
 * command-scoped, knowingly ignore the hint.
 */
function collectSchemaNarrowActivationDoctorWarnings(
  loadResult: Awaited<ReturnType<typeof loadExtensions>>,
  activationResult: Awaited<ReturnType<typeof activateExtensions>>,
): string[] {
  const schemaContributors = new Set<string>();
  for (const entry of activationResult.registrations.item_types) {
    if (entry.types.length > 0) {
      schemaContributors.add(`${entry.layer}:${normalizeExtensionNameForMatch(entry.name)}`);
    }
  }
  for (const entry of activationResult.registrations.item_fields) {
    if (entry.fields.length > 0) {
      schemaContributors.add(`${entry.layer}:${normalizeExtensionNameForMatch(entry.name)}`);
    }
  }
  const warnings: string[] = [];
  for (const extension of loadResult.loaded) {
    if ((extension.activation?.commands ?? []).length === 0) {
      continue;
    }
    if (schemaContributors.has(`${extension.layer}:${normalizeExtensionNameForMatch(extension.name)}`)) {
      warnings.push(`extension_schema_narrow_activation:${extension.layer}:${extension.name}`);
    }
  }
  return [...new Set(warnings)].sort((left, right) => left.localeCompare(right));
}

/**
 * Implements run extension for the public runtime surface of this module.
 */
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
  if (options.capability !== undefined && action !== "init") {
    throw new PmCliError("--capability is only valid with --init/--scaffold.", EXIT_CODE.USAGE);
  }
  /* c8 ignore start -- alias-normalization matrix is covered by resolveAction tests; this IIFE only rewrites positional aliases */
  const normalizedTarget = (() => {
    const normalizedInput = target?.trim().toLowerCase();
    if (action === "doctor" && normalizedInput === "doctor") {
      return undefined;
    }
    if (action === "reload" && normalizedInput === "reload") {
      return undefined;
    }
    if (action === "catalog" && normalizedInput === "catalog") {
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
  /* c8 ignore stop */
  const scope = resolveScope(options);
  const resolvedRoots = resolveExtensionRootsForScope(scope, global);
  const warnings: string[] = [];

  const withResult = (details: Record<string, unknown>): ExtensionCommandResult => {
    const result: ExtensionCommandResult = {
      ok: true,
      action,
      scope,
      roots: action === "catalog" && typeof options.fields === "string" && options.fields.trim().length > 0
        ? {
            project: "project",
            global: "global",
            selected: scope,
            settings_root: "project",
          }
        : {
            project: resolvedRoots.roots.project,
            global: resolvedRoots.roots.global,
            selected: resolvedRoots.selected_root,
            settings_root: resolvedRoots.settings_root,
          },
      warnings: [...new Set(warnings)].sort((left, right) => left.localeCompare(right)),
      details,
    };
    if (action === "doctor") {
      Object.defineProperty(result, NATIVE_OUTPUT_MARKER, {
        value: true,
        enumerable: false,
        configurable: false,
      });
    }
    return result;
  };

  if (action === "init") {
    const githubOption = resolveGithubOption(options);
    if (githubOption !== undefined || (typeof options.ref === "string" && options.ref.trim().length > 0)) {
      throw new PmCliError('Action "init" does not accept --gh/--github/--ref options.', EXIT_CODE.USAGE);
    }
    const scaffoldTarget = requireTarget(normalizedTarget, action);
    const scaffold = await scaffoldExtensionProject(scaffoldTarget, options.vocabulary ?? "extension", options.capability);
    const quotedTargetPath = JSON.stringify(scaffold.target_path);
    // Forward-slash the path for the copy-pasteable `cd` hint: Windows cmd.exe /
    // PowerShell reject the doubled backslashes JSON.stringify emits, while both
    // shells (and POSIX) accept forward slashes.
    const quotedShellTargetPath = JSON.stringify(scaffold.target_path.replace(/\\/g, "/"));
    return withResult({
      scaffolded: scaffold.created_directory || scaffold.files.some((entry) => entry.status === "created"),
      extension: {
        name: scaffold.extension_name,
        command: scaffold.command_name,
      },
      capability: scaffold.capability,
      target_path: scaffold.target_path,
      created_directory: scaffold.created_directory,
      files: scaffold.files,
      next_steps: [
        // Extensions are authored AND loaded as TypeScript (ADR pm-2c28 / pm-m1uz):
        // the manifest entry is ./index.ts and pm strips types on load (Node
        // >=22.18), so there is no compile/build step — install dependencies, then
        // install the scaffold directly.
        ...(options.vocabulary === "package"
          ? [`Install dependencies: cd ${quotedShellTargetPath}, then run "npm install"`]
          : [
              `Install type-check dependencies: cd ${quotedShellTargetPath}, then run "npm install -D typescript @types/node @unbrained/pm-cli"`,
            ]),
        `Install the scaffold: ${options.vocabulary === "package" ? "pm install --project" : "pm extension --install --project"} ${quotedTargetPath}`,
        `Smoke-test command path: pm ${scaffold.command_name}`,
        ...(options.vocabulary === "package"
          ? [`Validate the package: cd ${quotedShellTargetPath}, then run "npm run typecheck" and "npm test"`]
          : [`Type-check the source (optional): cd ${quotedShellTargetPath}, then run "npx tsc --noEmit"`]),
        `Run diagnostics: ${options.vocabulary === "package" ? "pm package doctor" : "pm extension --doctor"} --project --detail summary`,
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

  if (action === "catalog") {
    if (typeof normalizedTarget === "string" && normalizedTarget.length > 0 && normalizedTarget !== "catalog") {
      throw new PmCliError('Action "catalog" does not accept a package target.', EXIT_CODE.USAGE);
    }
    return withResult(await buildBundledPackageCatalog(scope, global, options));
  }

  if (action === "install") {
    const githubOption = resolveGithubOption(options);
    const explicitSourceInput = githubOption ?? requireTarget(normalizedTarget, action);
    if (typeof githubOption !== "string" && isBundledPackageInstallAllTarget(explicitSourceInput)) {
      if (typeof options.ref === "string" && options.ref.trim().length > 0) {
        throw new PmCliError('Action "install all" does not accept --ref.', EXIT_CODE.USAGE);
      }
      const aliases = await listBundledPackageAliases();
      const packages: Array<{ alias: string; result: ExtensionCommandResult }> = [];
      for (const alias of aliases) {
        packages.push({
          alias,
          result: await runExtension(alias, { ...options, install: true }, global),
        });
      }
      for (const entry of packages) {
        warnings.push(...entry.result.warnings);
      }
      return withResult({
        installed_all: true,
        installed_count: packages.length,
        packages: packages.map((entry) => ({
          alias: entry.alias,
          ok: entry.result.ok,
          extension: (entry.result.details as { extension?: unknown }).extension,
          source: (entry.result.details as { source?: unknown }).source,
          destination_path: (entry.result.details as { destination_path?: unknown }).destination_path,
          activated: (entry.result.details as { activated?: unknown }).activated,
          settings_changed: (entry.result.details as { settings_changed?: unknown }).settings_changed,
          command_paths: (entry.result.details as { command_paths?: unknown }).command_paths,
          action_paths: (entry.result.details as { action_paths?: unknown }).action_paths,
          command_discovery: (entry.result.details as { command_discovery?: unknown }).command_discovery,
          warnings: entry.result.warnings,
        })),
      });
    }
    /* c8 ignore start -- github/local alias-source split is exercised in install-action integration tests */
    const bundledAliasSource =
      typeof githubOption === "string" ? null : await resolveBundledExtensionAliasSource(explicitSourceInput);
    /* c8 ignore stop */
    const bundledAliasName = bundledAliasSource === null ? null : explicitSourceInput.trim().toLowerCase();
    const sourceInput = bundledAliasSource ?? explicitSourceInput;
    /* c8 ignore start -- install-source branch combinations are covered in install-sources focused tests */
    const installSource = parseExtensionInstallSource(sourceInput, {
      forceGithub: typeof githubOption === "string",
      ref: options.ref,
    });
    /* c8 ignore stop */
    const resolvedSource = await resolveInstallSource(installSource);
    try {
      const validated = await validateExtensionDirectory(resolvedSource.directory);
      const destinationDirectoryName = normalizeManagedDirectoryName(validated.manifest.name);
      return await withExtensionInstallLock(resolvedRoots.settings_root, destinationDirectoryName, async () => {
        const settings = await readSettings(resolvedRoots.settings_root);
        const managedStateRead = await readManagedExtensionState(resolvedRoots.selected_root);
        warnings.push(...managedStateRead.warnings);
        const destinationDirectory = path.join(resolvedRoots.selected_root, destinationDirectoryName);
        const destinationExists = await pathExists(destinationDirectory);
        const installInPlace = await areDirectoriesEquivalent(validated.directory, destinationDirectory);

        await fs.mkdir(resolvedRoots.selected_root, { recursive: true });
        if (!installInPlace) {
          await copyExtensionDirectoryForInstall(validated.directory, destinationDirectory);
        }

        /* c8 ignore start -- source-shape branch combinations are exercised in install-source focused tests */
        const sourceRecord: ManagedExtensionSource =
          bundledAliasName
            ? {
                kind: "builtin",
                input: bundledAliasName,
                location: bundledAliasName,
                name: bundledAliasName,
              }
            : installSource.kind === "local"
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
        /* c8 ignore stop */

        const now = nowIso();
        const existingManagedEntry = managedStateRead.state.entries.find(
          (entry) => normalizeExtensionNameForMatch(entry.name) === normalizeExtensionNameForMatch(validated.manifest.name),
        );
        const sourceUnchanged =
          existingManagedEntry !== undefined &&
          existingManagedEntry.manifest_version === validated.manifest.version &&
          managedExtensionSourcesEquivalent(existingManagedEntry.source, sourceRecord);
        const managedState = upsertManagedEntry(managedStateRead.state, {
          name: validated.manifest.name,
          directory: destinationDirectoryName,
          scope,
          manifest_version: validated.manifest.version,
          manifest_entry: validated.manifest.entry,
          capabilities: [...validated.manifest.capabilities],
          installed_at: existingManagedEntry?.installed_at ?? now,
          updated_at: sourceUnchanged ? existingManagedEntry.updated_at : now,
          source: sourceRecord,
        });
        await writeManagedExtensionState(resolvedRoots.selected_root, managedState);

        const activationChanged = ensureActivated(settings, validated.manifest.name);
        if (activationChanged) {
          await writeSettings(resolvedRoots.settings_root, settings, "settings:write");
        }
        const refreshedInstalled = await listInstalledExtensions(resolvedRoots.selected_root, scope, settings, managedState);
        warnings.push(...refreshedInstalled.warnings);
        const runtimeProbe = await probeRuntimeCommandPathsForInstall(
          resolvedRoots.pm_root,
          settings,
          refreshedInstalled.extensions,
          global,
        );
        warnings.push(...runtimeProbe.warnings);
        const commandSummary = summarizeRuntimeCommandPathsForExtension(validated.manifest.name, runtimeProbe.installed);
        const installActivationFailure = findActivationFailureByName(
          validated.manifest.name,
          runtimeProbe.activation_failures,
          scope,
        );
        const runtimeActivationStatus = resolveInstallRuntimeActivationStatus(
          validated.manifest.name,
          scope,
          runtimeProbe.installed,
          installActivationFailure,
        );

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
          runtime_activation_status: runtimeActivationStatus,
          command_paths: commandSummary.command_paths,
          action_paths: commandSummary.action_paths,
          command_discovery: buildInstallCommandDiscovery(validated.manifest.name, sourceRecord, commandSummary),
          activation_diagnostics: {
            failed_count: runtimeProbe.activation_failures.length,
            failed: runtimeProbe.activation_failures,
            installed_extension_failed: installActivationFailure ?? null,
          },
        });
      });
    } finally {
      /* c8 ignore start -- cleanup hooks are only present for transient install sources */
      if (resolvedSource.cleanup) {
        await resolvedSource.cleanup();
      }
      /* c8 ignore stop */
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
    const triage = buildExtensionTriageSummary(scope, warnings, refreshedInstalled.extensions, options);
    warnings.push(...triage.warnings);
    /* c8 ignore start -- refresh-entry optional metadata is display-only and exercised indirectly */
    const adoptedDetails = adoption.adopted_entries.map((entry) => {
      const refreshedEntry =
        refreshedInstalled.extensions.find(
          (candidate) =>
            normalizeExtensionNameForMatch(candidate.name) === normalizeExtensionNameForMatch(entry.name) &&
            normalizeExtensionNameForMatch(candidate.directory) === normalizeExtensionNameForMatch(entry.directory),
        ) ??
        /* c8 ignore next 3 -- fallback only matters if a manifest renames between adopt and refresh */
        refreshedInstalled.extensions.find(
          (candidate) => normalizeExtensionNameForMatch(candidate.directory) === normalizeExtensionNameForMatch(entry.directory),
        );
      return {
        ...entry,
        update_check_status: refreshedEntry?.update_check_status ?? null,
        update_check_reason: refreshedEntry?.update_check_reason ?? null,
      };
    });
    /* c8 ignore stop */
    /* c8 ignore start -- adopt-all summary booleans are deterministic mirrors of adoptedDetails length */
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
    /* c8 ignore stop */
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
            /* c8 ignore start -- forceGithub guarantees a github-kind install source */
            if (parsed.kind !== "github") {
              throw new PmCliError(`Invalid GitHub shorthand "${githubOption}".`, EXIT_CODE.USAGE);
            }
            /* c8 ignore stop */
            /* c8 ignore start -- github subpath defaults are validated in install-source parser tests */
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
            /* c8 ignore stop */
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
    /* c8 ignore start -- fallback only matters if a manifest renames between adopt and refresh */
    const refreshedEntry =
      refreshedInstalled.extensions.find(
        (entry) => normalizeExtensionNameForMatch(entry.name) === normalizeExtensionNameForMatch(validated.manifest.name),
      ) ??
      refreshedInstalled.extensions.find(
        (entry) => normalizeExtensionNameForMatch(entry.directory) === normalizeExtensionNameForMatch(candidate.directory),
      );
    /* c8 ignore stop */

    /* c8 ignore start -- adopt result mirrors refreshedEntry optionals for display only */
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
    /* c8 ignore stop */
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
      /* c8 ignore start -- uninstall filter keeps both name+directory guards for legacy managed-state migrations */
      entries: managedStateRead.state.entries.filter(
        (entry) =>
          normalizeExtensionNameForMatch(entry.name) !== normalizeExtensionNameForMatch(candidate.name) &&
          normalizeExtensionNameForMatch(entry.directory) !== normalizeExtensionNameForMatch(candidate.directory),
      ),
      /* c8 ignore stop */
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
    warnings.push(...classifyDoctorActivationFailureWarnings(activationResult.failed));
    warnings.push(...classifyUnusedCapabilityWarnings(loadResult, activationResult));
    warnings.push(...collectGlobalOutputOverrideDoctorWarnings(activationResult));
    warnings.push(...collectSchemaNarrowActivationDoctorWarnings(loadResult, activationResult));
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

    const triage = buildExtensionTriageSummary(scope, warnings, runtimeInstalledExtensions, options);
    warnings.push(...triage.warnings);
    const normalizedWarnings = [...triage.warnings];
    const policySummary = {
      mode: loadResult.policy.mode,
      trust_mode: loadResult.policy.trust_mode,
      require_provenance: loadResult.policy.require_provenance,
      default_sandbox_profile: loadResult.policy.default_sandbox_profile,
      // Honest trust model (ADR pm-6ef3): keep this caveat to one concise line.
      sandbox_enforcement:
        "advisory: sandbox_profile/permissions are declaration-based load gates, not runtime isolation (ADR pm-6ef3)",
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
          /* c8 ignore start -- vocabulary-specific remediation branches are copy-only variants */
          ...(loadResult.failed.length > 0
            ? [
              options.vocabulary === "package"
                ? "Run pm package explore --project and pm package explore --global to inspect load failures."
                : "Run pm extension --explore --project and pm extension --explore --global to inspect load failures.",
            ]
            : []),
          ...(activationResult.failed.length > 0
            ? [
              options.vocabulary === "package"
                ? "Review activation failures in pm package doctor --detail deep output."
                : "Review activation failures in pm extension --doctor --detail deep output.",
            ]
            : []),
          /* c8 ignore stop */
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
              capability: entry.trace?.capability,
              missing_capability: entry.trace?.missing_capability,
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

  if (action === "describe") {
    const settings = await readSettings(resolvedRoots.settings_root);
    const loadResult = await loadExtensions({
      pmRoot: resolvedRoots.pm_root,
      settings,
      cwd: process.cwd(),
      noExtensions: global.noExtensions === true,
    });
    const activationResult = await activateExtensions(loadResult);
    warnings.push(...loadResult.warnings);
    warnings.push(...activationResult.warnings);
    const describeResult = buildExtensionDescribeResult(normalizedTarget, loadResult, activationResult);
    if (normalizedTarget !== undefined && describeResult.extensions.length === 0) {
      const noun = options.vocabulary === "package" ? "package" : "extension";
      throw new PmCliError(
        `No loaded ${noun} named "${normalizedTarget}" was found in ${scope} scope. Run pm ${noun} explore to list discovered ${noun}s.`,
        EXIT_CODE.NOT_FOUND,
      );
    }
    return withResult({
      target: describeResult.target,
      total: describeResult.total,
      extensions: describeResult.extensions,
      union: describeResult.union,
    });
  }

  /* c8 ignore start -- explore/manage action split is validated by dedicated command-action tests */
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
    let runtimeActivationFailures: ActivationFailureDiagnostic[] | undefined;
    if (action === "explore" || options.runtimeProbe === true) {
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
      runtimeActivationFailures = collectActivationFailureDiagnostics(activationResult.failed);
      runtimeProbeSummary = {
        requested: true,
        executed: true,
        reason: action === "explore" ? "explore_defaults_to_runtime_probe" : "runtime_probe_requested",
        load_failure_count: loadResult.failed.length,
        activation_failure_count: activationResult.failed.length,
        warning_count: [...new Set([...loadResult.warnings, ...activationResult.warnings])].length,
        policy: loadResult.policy,
      };
    } else if (action === "manage") {
      runtimeProbeSummary = {
        requested: false,
        executed: false,
      };
    }

    const triage = buildExtensionTriageSummary(scope, warnings, runtimeInstalledExtensions, options);
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
    if (runtimeActivationFailures !== undefined) {
      details.activation_diagnostics = {
        failed_count: runtimeActivationFailures.length,
        failed: runtimeActivationFailures,
      };
    }
    if (action === "explore") {
      details.runtime_probe = runtimeProbeSummary;
    }
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
  /* c8 ignore stop */

  /* c8 ignore start -- resolveAction returns a closed ExtensionCommandAction union */
  throw new PmCliError(`Unsupported extension action "${action}".`, EXIT_CODE.USAGE);
  /* c8 ignore stop */
}

export const _testOnly = {
  adoptUnmanagedExtensions,
  buildExtensionPolicyDetails,
  buildInstallCommandDiscovery,
  checkGithubUpdate,
  clearExtensionState,
  collectActivationFailureDiagnostics,
  findActivationFailureByName,
  resolveInstallRuntimeActivationStatus,
  collectGlobalOutputOverrideDoctorWarnings,
  collectSchemaNarrowActivationDoctorWarnings,
  copyExtensionDirectoryWithoutSelfNesting,
  isErrnoCode,
  isRetriableExtensionInstallCopyError,
  listInstalledExtensions,
  requireTarget,
  resolveAction,
  resolveCommandDiscoveryPackageName,
  resolveGithubOption,
  resolveInstalledExtensionCandidate,
  resolveScope,
  resolveUpdateCheckResolution,
  withExtensionInstallLock,
};
