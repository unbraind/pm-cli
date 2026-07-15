/**
 * @module sdk/extension
 *
 * Implements the pm extension command surface and its agent-facing runtime behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  activateExtensions,
  createSerialQueue,
  loadExtensions,
  nextExtensionReloadToken,
} from "../core/extensions/index.js";
import { resolveExtensionRoots } from "../core/extensions/loader.js";
import { pathExists } from "../core/fs/fs-utils.js";
import { resolvePmPackageRootFromModule } from "../core/packages/root.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { levenshteinDistanceWithinLimit } from "../core/shared/levenshtein.js";
import { nowIso } from "../core/shared/time.js";
import {
  resolveGlobalPmRoot,
  resolvePmRoot,
} from "../core/store/paths.js";
import { readSettings, writeSettings } from "../core/store/settings.js";
import { quoteCommandArg, renderPmCommand } from "./command-line.js";
import { ensureTypeFolderScaffold } from "./schema.js";
import type { PmSettings } from "../types/index.js";
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
} from "./extension/install-sources.js";
import {
  resolveBundledExtensionAliasSource,
  resolveBundledPackageNpmName,
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
import {
  copyExtensionDirectoryForInstall,
  copyExtensionDirectoryWithoutSelfNesting,
  ensureExtensionModuleTypeMarker,
  isErrnoCode,
  isRetriableExtensionInstallCopyError,
  resolveCanonicalExtensionInstallDestination,
  withExtensionInstallLock,
} from "./extension/install-runtime.js";
import { mapWithFixedConcurrency } from "./extension/concurrency.js";
import { checkGithubUpdate } from "./extension/update-check.js";
import {
  captureExtensionInstallSnapshot,
  readOptionalMetadataFile,
  restoreExtensionInstallSnapshot,
} from "./extension/install-snapshot.js";
// Re-export the public surface that lives in sibling modules but was previously
// exported from this file (used by sdk barrels, upgrade.ts, and tests).
export {
  parseExtensionManifest,
  validateExtensionDirectory,
  readManagedExtensionState,
  writeManagedExtensionState,
  resolveManagedExtensionStatePath,
  parseExtensionInstallSource,
  copyExtensionDirectoryForInstall,
  resolveCanonicalExtensionInstallDestination,
};
export type {
  ManagedExtensionSource,
  ManagedExtensionRecord,
  ManagedExtensionState,
};
export type { ManagedExtensionStateReadResult } from "./extension/managed-state.js";

const GITHUB_UPDATE_CHECK_CONCURRENCY = 4;

/** Restricts extension command action values accepted by command, SDK, and storage contracts. */
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

const LIFECYCLE_ACTION_TARGETS = [
  ["install", "install", "--install"],
  ["uninstall", "uninstall", "--uninstall"],
  ["explore", "explore", "--explore"],
  ["list", "explore", "--explore"],
  ["manage", "manage", "--manage"],
  ["describe", "describe", "--describe"],
  ["reload", "reload", "--reload"],
  ["doctor", "doctor", "--doctor"],
  ["catalog", "catalog", "--catalog"],
  ["init", "init", "--init"],
  ["scaffold", "init", "--scaffold"],
  ["adopt", "adopt", "--adopt"],
  ["adopt-all", "adopt-all", "--adopt-all"],
  ["activate", "activate", "--activate"],
  ["deactivate", "deactivate", "--deactivate"],
] as const satisfies readonly (readonly [
  string,
  ExtensionCommandAction,
  `--${string}`,
])[];

const LIFECYCLE_ACTION_FLAG_HINT = LIFECYCLE_ACTION_TARGETS.map(
  ([, , flag]) => flag,
)
  .filter((flag, index, flags) => flags.indexOf(flag) === index)
  .join(", ");
const LIFECYCLE_ACTION_FLAGS: Record<ExtensionCommandAction, `--${string}`> = {
  install: "--install",
  uninstall: "--uninstall",
  explore: "--explore",
  manage: "--manage",
  describe: "--describe",
  reload: "--reload",
  doctor: "--doctor",
  catalog: "--catalog",
  adopt: "--adopt",
  "adopt-all": "--adopt-all",
  activate: "--activate",
  deactivate: "--deactivate",
  init: "--init",
};
/** Restricts extension scope values accepted by command, SDK, and storage contracts. */
export type ExtensionScope = "project" | "global";
/** Restricts extension activation status values accepted by command, SDK, and storage contracts. */
export type ExtensionActivationStatus =
  | "ok"
  | "failed"
  | "not_loaded"
  | "unknown";

/** Documents the extension command options payload exchanged by command, SDK, and package integrations. */
export interface ExtensionCommandOptions {
  /** Value that configures or reports install for this contract. */
  install?: boolean;
  /** Value that configures or reports uninstall for this contract. */
  uninstall?: boolean;
  /** Value that configures or reports explore for this contract. */
  explore?: boolean;
  /** Value that configures or reports manage for this contract. */
  manage?: boolean;
  /** Value that configures or reports describe for this contract. */
  describe?: boolean;
  /** Value that configures or reports markdown for this contract. */
  markdown?: boolean;
  /** Value that configures or reports output for this contract. */
  output?: string;
  /** Value that configures or reports reload for this contract. */
  reload?: boolean;
  /** Value that configures or reports doctor for this contract. */
  doctor?: boolean;
  /** Value that configures or reports catalog for this contract. */
  catalog?: boolean;
  /** Value that configures or reports init for this contract. */
  init?: boolean;
  /** Value that configures or reports scaffold for this contract. */
  scaffold?: boolean;
  /** Value that configures or reports strict exit for this contract. */
  strictExit?: boolean;
  /** Value that configures or reports fail on warn for this contract. */
  failOnWarn?: boolean;
  /** Value that configures or reports adopt for this contract. */
  adopt?: boolean;
  /** Value that configures or reports adopt all for this contract. */
  adoptAll?: boolean;
  /** Registers this package's commands, actions, and runtime hooks with the host. */
  activate?: boolean;
  /** Value that configures or reports deactivate for this contract. */
  deactivate?: boolean;
  /** Value that configures or reports project for this contract. */
  project?: boolean;
  /** Value that configures or reports local for this contract. */
  local?: boolean;
  /** Value that configures or reports global for this contract. */
  global?: boolean;
  /** Value that configures or reports gh for this contract. */
  gh?: string;
  /** Value that configures or reports github for this contract. */
  github?: string;
  /** Value that configures or reports ref for this contract. */
  ref?: string;
  /** Value that configures or reports detail for this contract. */
  detail?: string;
  /** Value that configures or reports trace for this contract. */
  trace?: boolean;
  /** Value that configures or reports watch for this contract. */
  watch?: boolean;
  /** Value that configures or reports runtime probe for this contract. */
  runtimeProbe?: boolean;
  /** Value that configures or reports fix managed state for this contract. */
  fixManagedState?: boolean;
  /** Value that configures or reports isolated for this contract. */
  isolated?: boolean;
  /** Value that configures or reports ignore global for this contract. */
  ignoreGlobal?: boolean;
  /** Value that configures or reports fields for this contract. */
  fields?: string;
  /** Value that configures or reports capability for this contract. */
  capability?: string;
  /** Value that configures or reports declarative for this contract. */
  declarative?: boolean;
  /** Value that configures or reports vocabulary for this contract. */
  vocabulary?: "extension" | "package";
}

/** Documents the managed extension summary payload exchanged by command, SDK, and package integrations. */
export interface ManagedExtensionSummary {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports directory for this contract. */
  directory: string;
  /** Value that configures or reports version for this contract. */
  version: string;
  /** Value that configures or reports entry for this contract. */
  entry: string;
  /** Value that configures or reports scope for this contract. */
  scope: ExtensionScope;
  // Backward-compatible alias for configured enabled state. Prefer `enabled`.
  /** Value that configures or reports active for this contract. */
  active: boolean;
  /** Whether enabled applies to this operation. */
  enabled: boolean;
  /** Value that configures or reports runtime active for this contract. */
  runtime_active: boolean | null;
  /** Lifecycle state reported for activationthe record. */
  activation_status: ExtensionActivationStatus;
  /** Value that configures or reports command paths for this contract. */
  command_paths?: string[];
  /** Value that configures or reports action paths for this contract. */
  action_paths?: string[];
  /** Value that configures or reports managed for this contract. */
  managed: boolean;
  /** Value that configures or reports source for this contract. */
  source?: ManagedExtensionSource;
  /** Value that configures or reports update available for this contract. */
  update_available?: boolean | null;
  /** ISO 8601 timestamp recording when last update check occurred. */
  last_update_check_at?: string;
  /** Value that configures or reports last update remote commit for this contract. */
  last_update_remote_commit?: string;
  /** Value that configures or reports update error for this contract. */
  update_error?: string;
  /** Lifecycle state reported for update checkthe record. */
  update_check_status: ExtensionUpdateCheckStatus;
  /** Value that configures or reports update check reason for this contract. */
  update_check_reason: string;
}

/** Documents the extension command result payload exchanged by command, SDK, and package integrations. */
export interface ExtensionCommandResult {
  /** Whether the operation completed without a blocking failure. */
  ok: boolean;
  /** Value that configures or reports action for this contract. */
  action: ExtensionCommandAction;
  /** Value that configures or reports scope for this contract. */
  scope: ExtensionScope;
  /** Value that configures or reports roots for this contract. */
  roots: {
    project: string;
    global: string;
    selected: string;
    settings_root: string;
  };
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** Value that configures or reports details for this contract. */
  details: Record<string, unknown>;
}

const NATIVE_OUTPUT_MARKER = "__pm_native_output";

/** Documents the extension triage summary payload exchanged by command, SDK, and package integrations. */
export interface ExtensionTriageSummary {
  /** Lifecycle state reported for status. */
  status: "ok" | "warn";
  /** Number of warning entries represented by this result. */
  warning_count: number;
  /** Value that configures or reports warning codes for this contract. */
  warning_codes: string[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** Number of policy warning entries represented by this result. */
  policy_warning_count: number;
  /** Number of policy violation entries represented by this result. */
  policy_violation_count: number;
  /** Number of policy blocked entries represented by this result. */
  policy_blocked_count: number;
  /** Value that configures or reports total extensions for this contract. */
  total_extensions: number;
  /** Value that configures or reports managed total for this contract. */
  managed_total: number;
  /** Value that configures or reports enabled total for this contract. */
  enabled_total: number;
  /** Value that configures or reports active total for this contract. */
  active_total: number;
  /** Value that configures or reports update available total for this contract. */
  update_available_total: number;
  /** Value that configures or reports update health coverage for this contract. */
  update_health_coverage: "full" | "partial";
  /** Value that configures or reports update health partial for this contract. */
  update_health_partial: boolean;
  /** Number of unmanaged loaded extension entries represented by this result. */
  unmanaged_loaded_extension_count: number;
  /** Value that configures or reports unmanaged loaded extensions for this contract. */
  unmanaged_loaded_extensions: string[];
  /** Number of unmanaged expected extension entries represented by this result. */
  unmanaged_expected_extension_count: number;
  /** Value that configures or reports unmanaged expected extensions for this contract. */
  unmanaged_expected_extensions: string[];
  /** Number of unmanaged action required extension entries represented by this result. */
  unmanaged_action_required_extension_count: number;
  /** Value that configures or reports unmanaged action required extensions for this contract. */
  unmanaged_action_required_extensions: string[];
  /** Value that configures or reports update check status totals for this contract. */
  update_check_status_totals: Record<ExtensionUpdateCheckStatus, number>;
  /** Value that configures or reports update check failed total for this contract. */
  update_check_failed_total: number;
  /** Value that configures or reports top warnings for this contract. */
  top_warnings: string[];
  /** Value that configures or reports remediation for this contract. */
  remediation: string[];
  /** Value that configures or reports collision plan for this contract. */
  collision_plan?: ExtensionCollisionPlan;
}

/** Documents the extension collision plan payload exchanged by command, SDK, and package integrations. */
export interface ExtensionCollisionPlan {
  /** Lifecycle state reported for status. */
  status: "ok" | "conflicts_detected";
  /** Number of collision entries represented by this result. */
  collision_count: number;
  /** Number of extension entries represented by this result. */
  extension_count: number;
  /** Value that configures or reports next best command for this contract. */
  next_best_command: string;
  /** Value that configures or reports collisions for this contract. */
  collisions: Array<{
    code: string;
    surface: string;
    winner: { layer: ExtensionScope; name: string };
    displaced: { layer: ExtensionScope; name: string };
  }>;
  /** Value that configures or reports remediation candidates for this contract. */
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

/** Restricts extension update check status values accepted by command, SDK, and storage contracts. */
export type ExtensionUpdateCheckStatus =
  | "checked"
  | "skipped_unmanaged"
  | "skipped_non_github"
  | "failed"
  | "not_checked";

interface ExtensionUpdateCheckResolution {
  status: ExtensionUpdateCheckStatus;
  reason: string;
}

/** Restricts extension doctor detail mode values accepted by command, SDK, and storage contracts. */
export type ExtensionDoctorDetailMode = "summary" | "deep";

const EXTENSION_POLICY_ROOT_LIST_FIELDS = [
  "trusted_extensions",
  "allowed_extensions",
  "blocked_extensions",
  "allowed_capabilities",
  "blocked_capabilities",
  "allowed_surfaces",
  "blocked_surfaces",
  "allowed_commands",
  "blocked_commands",
  "allowed_actions",
  "blocked_actions",
  "allowed_services",
  "blocked_services",
] as const;

const EXTENSION_POLICY_OVERRIDE_LIST_FIELDS = [
  "allowed_capabilities",
  "blocked_capabilities",
  "allowed_surfaces",
  "blocked_surfaces",
  "allowed_commands",
  "blocked_commands",
  "allowed_actions",
  "blocked_actions",
  "allowed_services",
  "blocked_services",
] as const;
const EXTENSION_POLICY_OVERRIDE_BOOLEAN_FIELDS = [
  "disabled",
  "require_trusted",
  "require_provenance",
] as const;
const DEFAULT_EXTENSION_POLICY_DETAILS: ExtensionPolicyDetails = {
  mode: "off",
  trust_mode: "off",
  require_provenance: false,
  trusted_extensions: [],
  default_sandbox_profile: "none",
  allowed_extensions: [],
  blocked_extensions: [],
  allowed_capabilities: [],
  blocked_capabilities: [],
  allowed_surfaces: [],
  blocked_surfaces: [],
  allowed_commands: [],
  blocked_commands: [],
  allowed_actions: [],
  blocked_actions: [],
  allowed_services: [],
  blocked_services: [],
  extension_overrides: [],
};

type ExtensionPolicyRootListField =
  (typeof EXTENSION_POLICY_ROOT_LIST_FIELDS)[number];
type ExtensionPolicyOverrideListField =
  (typeof EXTENSION_POLICY_OVERRIDE_LIST_FIELDS)[number];
type ExtensionPolicyOverrideBooleanField =
  (typeof EXTENSION_POLICY_OVERRIDE_BOOLEAN_FIELDS)[number];

interface ExtensionPolicyOverrideDetails {
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
}

interface ExtensionPolicyDetails {
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
  extension_overrides: ExtensionPolicyOverrideDetails[];
}

/** Normalize every root-level extension policy list into a stable unique sequence. */
const normalizePolicyRootLists = (
  policy: PmSettings["extensions"]["policy"] | null | undefined,
): Record<ExtensionPolicyRootListField, string[]> => {
  const safePolicy = policy ?? DEFAULT_EXTENSION_POLICY_DETAILS;
  const lists = {} as Record<ExtensionPolicyRootListField, string[]>;
  for (const field of EXTENSION_POLICY_ROOT_LIST_FIELDS) {
    lists[field] = normalizeStringList(safePolicy[field] ?? []);
  }
  return lists;
};

/** Attach only populated override lists so diagnostics remain compact. */
const appendNonEmptyPolicyLists = (
  target: ExtensionPolicyOverrideDetails,
  lists: Record<ExtensionPolicyOverrideListField, string[]>,
): ExtensionPolicyOverrideDetails => {
  for (const field of EXTENSION_POLICY_OVERRIDE_LIST_FIELDS) {
    if (lists[field].length > 0) {
      target[field] = lists[field];
    }
  }
  return target;
};

/** Attach explicitly enabled scalar fields to one normalized extension override. */
const appendEnabledPolicyScalars = (
  target: ExtensionPolicyOverrideDetails,
  override: NonNullable<
    PmSettings["extensions"]["policy"]["extension_overrides"]
  >[number],
): ExtensionPolicyOverrideDetails => {
  for (const field of EXTENSION_POLICY_OVERRIDE_BOOLEAN_FIELDS) {
    if (override[field] === true) {
      target[field as ExtensionPolicyOverrideBooleanField] = true;
    }
  }
  if (override.sandbox_profile) {
    target.sandbox_profile = override.sandbox_profile;
  }
  return target;
};

/** Normalize every list field from one extension policy override. */
const normalizePolicyOverrideLists = (
  override: NonNullable<
    PmSettings["extensions"]["policy"]["extension_overrides"]
  >[number],
): Record<ExtensionPolicyOverrideListField, string[]> => {
  const lists = {} as Record<ExtensionPolicyOverrideListField, string[]>;
  for (const field of EXTENSION_POLICY_OVERRIDE_LIST_FIELDS) {
    lists[field] = normalizeStringList(override[field] ?? []);
  }
  return lists;
};

/** Build deterministic diagnostic details for one valid named extension override. */
const buildExtensionPolicyOverrideDetails = (
  override: NonNullable<
    PmSettings["extensions"]["policy"]["extension_overrides"]
  >[number],
): ExtensionPolicyOverrideDetails | null => {
  const name = typeof override.name === "string" ? override.name.trim() : "";
  if (name.length === 0) {
    return null;
  }
  return appendNonEmptyPolicyLists(
    appendEnabledPolicyScalars({ name }, override),
    normalizePolicyOverrideLists(override),
  );
};

/** Normalize and sort all named extension policy overrides. */
const normalizeExtensionPolicyOverrides = (
  overrides:
    | PmSettings["extensions"]["policy"]["extension_overrides"]
    | null
    | undefined,
): ExtensionPolicyOverrideDetails[] =>
  (overrides ?? [])
    .map((override) => buildExtensionPolicyOverrideDetails(override))
    .filter(
      (override): override is ExtensionPolicyOverrideDetails =>
        override !== null,
    )
    .sort((left, right) => left.name.localeCompare(right.name));

/** Build the normalized extension policy representation exposed by diagnostics. */
const buildExtensionPolicyDetails = (
  policy: PmSettings["extensions"]["policy"] | null | undefined,
): ExtensionPolicyDetails => {
  const safePolicy = Object.assign(
    {},
    DEFAULT_EXTENSION_POLICY_DETAILS,
    policy ?? {},
  );
  const rootLists = normalizePolicyRootLists(policy);
  const overrides = normalizeExtensionPolicyOverrides(
    safePolicy.extension_overrides,
  );
  return {
    mode: safePolicy.mode,
    trust_mode: safePolicy.trust_mode,
    require_provenance: safePolicy.require_provenance === true,
    trusted_extensions: rootLists.trusted_extensions,
    default_sandbox_profile: safePolicy.default_sandbox_profile,
    allowed_extensions: rootLists.allowed_extensions,
    blocked_extensions: rootLists.blocked_extensions,
    allowed_capabilities: rootLists.allowed_capabilities,
    blocked_capabilities: rootLists.blocked_capabilities,
    allowed_surfaces: rootLists.allowed_surfaces,
    blocked_surfaces: rootLists.blocked_surfaces,
    allowed_commands: rootLists.allowed_commands,
    blocked_commands: rootLists.blocked_commands,
    allowed_actions: rootLists.allowed_actions,
    blocked_actions: rootLists.blocked_actions,
    allowed_services: rootLists.allowed_services,
    blocked_services: rootLists.blocked_services,
    extension_overrides: overrides,
  };
};

/** Resolve a lifecycle target against managed extension names, aliases, and directories. */
const resolveInstalledExtensionCandidate = async (
  installed: ManagedExtensionSummary[],
  extensionTarget: string,
): Promise<ManagedExtensionSummary | undefined> => {
  const lookupValues = [extensionTarget];
  const bundledAliasManifestName =
    await resolveBundledAliasManifestName(extensionTarget);
  if (bundledAliasManifestName) {
    lookupValues.push(bundledAliasManifestName);
  }
  const normalizedLookups = [
    ...new Set(
      lookupValues
        .map((value) => normalizeExtensionNameForMatch(value))
        .filter((value) => value.length > 0),
    ),
  ];
  for (const lookup of normalizedLookups) {
    const byName = installed.find(
      (entry) => normalizeExtensionNameForMatch(entry.name) === lookup,
    );
    if (byName) {
      return byName;
    }
    const byDirectory = installed.find(
      (entry) => normalizeExtensionNameForMatch(entry.directory) === lookup,
    );
    if (byDirectory) {
      return byDirectory;
    }
  }
  return undefined;
};

/** Return whether one extension is enabled after explicit enabled and disabled settings are applied. */
const isExtensionEnabled = (settings: PmSettings, name: string): boolean => {
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
};

/** Mutate extension settings to activate one name and report whether persisted state changed. */
const ensureActivated = (settings: PmSettings, name: string): boolean => {
  const normalizedName = name.trim();
  const enabled = new Set(normalizeStringList(settings.extensions.enabled));
  const disabled = new Set(normalizeStringList(settings.extensions.disabled));
  const previousEnabled = [...enabled];
  const previousDisabled = [...disabled];
  disabled.delete(normalizedName);
  if (enabled.size > 0) {
    enabled.add(normalizedName);
  }
  settings.extensions.enabled = [...enabled].sort((left, right) =>
    left.localeCompare(right),
  );
  settings.extensions.disabled = [...disabled].sort((left, right) =>
    left.localeCompare(right),
  );
  return (
    settings.extensions.enabled.join("\u0000") !==
      previousEnabled.join("\u0000") ||
    settings.extensions.disabled.join("\u0000") !==
      previousDisabled.join("\u0000")
  );
};

/** Mutate extension settings to deactivate one name and report whether persisted state changed. */
const ensureDeactivated = (settings: PmSettings, name: string): boolean => {
  const normalizedName = name.trim();
  const enabled = new Set(normalizeStringList(settings.extensions.enabled));
  const disabled = new Set(normalizeStringList(settings.extensions.disabled));
  const previousEnabled = [...enabled];
  const previousDisabled = [...disabled];
  enabled.delete(normalizedName);
  disabled.add(normalizedName);
  settings.extensions.enabled = [...enabled].sort((left, right) =>
    left.localeCompare(right),
  );
  settings.extensions.disabled = [...disabled].sort((left, right) =>
    left.localeCompare(right),
  );
  return (
    settings.extensions.enabled.join("\u0000") !==
      previousEnabled.join("\u0000") ||
    settings.extensions.disabled.join("\u0000") !==
      previousDisabled.join("\u0000")
  );
};

/** Remove one extension from explicit enabled and disabled settings and report whether state changed. */
const clearExtensionState = (settings: PmSettings, name: string): boolean => {
  const normalizedName = name.trim();
  const enabled = new Set(normalizeStringList(settings.extensions.enabled));
  const disabled = new Set(normalizeStringList(settings.extensions.disabled));
  const previousEnabled = [...enabled];
  const previousDisabled = [...disabled];
  enabled.delete(normalizedName);
  disabled.delete(normalizedName);
  settings.extensions.enabled = [...enabled].sort((left, right) =>
    left.localeCompare(right),
  );
  settings.extensions.disabled = [...disabled].sort((left, right) =>
    left.localeCompare(right),
  );
  return (
    settings.extensions.enabled.join("\u0000") !==
      previousEnabled.join("\u0000") ||
    settings.extensions.disabled.join("\u0000") !==
      previousDisabled.join("\u0000")
  );
};

/** Return the nearest valid lifecycle action and flag for one user-provided target. */
const suggestLifecycleActionTarget = (
  target: string,
): { action: ExtensionCommandAction; flag: `--${string}` } | null => {
  const normalizedTarget = target.trim().toLowerCase();
  const maxDistance = Math.min(
    2,
    Math.max(1, Math.ceil(normalizedTarget.length / 4)),
  );
  const nearest = LIFECYCLE_ACTION_TARGETS.map(
    ([candidate, action, flag]): {
      action: ExtensionCommandAction;
      flag: `--${string}`;
      distance: number | null;
    } => ({
      action,
      flag,
      distance: levenshteinDistanceWithinLimit(
        normalizedTarget,
        candidate,
        maxDistance,
      ),
    }),
  )
    .filter(
      (
        entry,
      ): entry is {
        action: ExtensionCommandAction;
        flag: `--${string}`;
        distance: number;
      } => entry.distance !== null,
    )
    .sort((left, right) => left.distance - right.distance)[0];
  return nearest ? { action: nearest.action, flag: nearest.flag } : null;
};

/** Build structured recovery guidance for an unknown extension lifecycle action. */
const buildUnknownLifecycleActionError = (
  target: string,
  options: ExtensionCommandOptions,
): PmCliError => {
  const noun = options.vocabulary === "package" ? "package" : "extension";
  const suggestion = suggestLifecycleActionTarget(target);
  if (!suggestion) {
    return new PmCliError(
      `One action flag is required. Use one of: ${LIFECYCLE_ACTION_FLAG_HINT}. Bare \`pm package\` and \`pm extension\` default to --explore.`,
      EXIT_CODE.USAGE,
    );
  }
  const command = `pm ${noun} ${suggestion.flag}`;
  return new PmCliError(
    `Unknown ${noun} lifecycle action "${target}". Did you mean "${suggestion.flag}"?`,
    EXIT_CODE.USAGE,
    {
      code: "unknown_lifecycle_action",
      required: `Use one of: ${LIFECYCLE_ACTION_FLAG_HINT}.`,
      examples: [command, `pm ${noun} --help`],
      recovery: {
        attempted_command: `pm ${noun} ${target}`,
        suggested_retry: command,
        fallback_candidates: [
          {
            source: "lifecycle_action",
            command,
            reason: `nearest lifecycle action for "${target}"`,
          },
        ],
      },
    },
  );
};

// Maps each boolean action flag to the lifecycle action it selects. `scaffold`
// aliases `init` and `adoptAll` selects `adopt-all`; every other flag maps to its
// like-named action. Dispatching through the table keeps `resolveAction` flat.
const EXTENSION_ACTION_FLAG_SELECTORS = [
  ["install", "install"],
  ["uninstall", "uninstall"],
  ["explore", "explore"],
  ["manage", "manage"],
  ["describe", "describe"],
  ["reload", "reload"],
  ["doctor", "doctor"],
  ["catalog", "catalog"],
  ["init", "init"],
  ["scaffold", "init"],
  ["adopt", "adopt"],
  ["adoptAll", "adopt-all"],
  ["activate", "activate"],
  ["deactivate", "deactivate"],
] as const satisfies readonly (readonly [
  keyof ExtensionCommandOptions,
  ExtensionCommandAction,
])[];

/** Positional lifecycle shorthand mapped to the canonical extension action. */
const IMPLICIT_EXTENSION_ACTIONS: Readonly<
  Record<string, ExtensionCommandAction>
> = {
  doctor: "doctor",
  reload: "reload",
  catalog: "catalog",
  init: "init",
  scaffold: "init",
  explore: "explore",
  manage: "manage",
  list: "explore",
  "": "explore",
};

/** Map a bare positional token (already trimmed and lower-cased) to the lifecycle action it implies for `pm extension <token>` / `pm package <token>`: the `doctor`/`reload`/`catalog`/`init`/`scaffold`/`explore`/`manage` keywords, with `list` and the empty string both meaning `explore`. Returns `null` for anything else so the caller can raise a did-you-mean error. */
const resolveImplicitActionFromTarget = (
  normalizedTarget: string,
): ExtensionCommandAction | null =>
  IMPLICIT_EXTENSION_ACTIONS[normalizedTarget] ?? null;

/** Resolve mutually exclusive lifecycle flags and positional shorthand into one extension action. */
const resolveAction = (
  target: string | undefined,
  options: ExtensionCommandOptions,
): ExtensionCommandAction => {
  const selected = [
    ...new Set(
      EXTENSION_ACTION_FLAG_SELECTORS.filter(
        ([flag]) => options[flag] === true,
      ).map(([, mappedAction]) => mappedAction),
    ),
  ];
  if (selected.length === 0) {
    if (target === undefined) {
      return "explore";
    }
    const implicitAction = resolveImplicitActionFromTarget(
      target.trim().toLowerCase(),
    );
    if (implicitAction) {
      return implicitAction;
    }
    throw buildUnknownLifecycleActionError(target, options);
  }
  if (selected.length > 1) {
    throw new PmCliError(
      "Extension action flags are mutually exclusive.",
      EXIT_CODE.USAGE,
    );
  }
  return selected[0];
};

/** Resolve project or global extension scope while rejecting conflicting scope flags. */
const resolveScope = (options: ExtensionCommandOptions): ExtensionScope => {
  const projectLike = options.project === true || options.local === true;
  const global = options.global === true;
  if (projectLike && global) {
    throw new PmCliError(
      'Options "--project/--local" and "--global" are mutually exclusive.',
      EXIT_CODE.USAGE,
    );
  }
  return global ? "global" : "project";
};

type ExtensionUpdateCheckResolver = (
  managedEntry: ManagedExtensionRecord | undefined,
) => ExtensionUpdateCheckResolution | null;

/** Ordered update-check policies from unmanaged and non-GitHub cases through recorded outcomes. */
const EXTENSION_UPDATE_CHECK_RESOLVERS: ExtensionUpdateCheckResolver[] = [
  (managedEntry) =>
    managedEntry
      ? null
      : {
          status: "skipped_unmanaged",
          reason: "extension_not_managed",
        },
  (managedEntry) =>
    managedEntry && managedEntry.source.kind !== "github"
      ? {
          status: "skipped_non_github",
          reason: `managed_source_kind_${managedEntry.source.kind}`,
        }
      : null,
  (managedEntry) => {
    const updateError =
      typeof managedEntry?.update_error === "string"
        ? managedEntry.update_error.trim()
        : "";
    return updateError.length > 0
      ? { status: "failed", reason: updateError }
      : null;
  },
  (managedEntry) => {
    const entry = managedEntry as ManagedExtensionRecord;
    const checkedAt =
      typeof entry.last_update_check_at === "string"
        ? entry.last_update_check_at.trim()
        : "";
    if (checkedAt.length === 0) {
      return null;
    }
    const reason =
      {
        true: "update_available",
        false: "up_to_date",
      }[String(entry.update_available)] ?? "checked_without_commit_baseline";
    return { status: "checked", reason };
  },
];

/** Project managed-source update metadata into one deterministic update-check result. */
const resolveUpdateCheckResolution = (
  managedEntry: ManagedExtensionRecord | undefined,
): ExtensionUpdateCheckResolution => {
  for (const resolve of EXTENSION_UPDATE_CHECK_RESOLVERS) {
    const resolution = resolve(managedEntry);
    if (resolution) {
      return resolution;
    }
  }
  return {
    status: "not_checked",
    reason: "no_update_check_recorded",
  };
};

/**
 * Assemble a {@link ManagedExtensionSummary} from a directory's resolved identity
 * (name/version/entry/enabled state) and its managed-state record, projecting the
 * managed-source provenance and the resolved update-check status. Runtime
 * activation fields default to "not yet probed" (`runtime_active: null`,
 * `activation_status: "unknown"`) so a later runtime probe can overlay live state.
 */
const buildInstalledExtensionSummary = (
  identity: {
    name: string;
    directory: string;
    version: string;
    entry: string;
    enabled: boolean;
  },
  scope: ExtensionScope,
  managedEntry: ManagedExtensionRecord | undefined,
  updateCheck: ExtensionUpdateCheckResolution,
): ManagedExtensionSummary => {
  const managed = managedEntry ?? ({} as ManagedExtensionRecord);
  return {
    name: identity.name,
    directory: identity.directory,
    version: identity.version,
    entry: identity.entry,
    scope,
    active: identity.enabled,
    enabled: identity.enabled,
    runtime_active: null,
    activation_status: "unknown",
    managed: Boolean(managedEntry),
    source: managed.source,
    update_available: managed.update_available,
    last_update_check_at: managed.last_update_check_at,
    last_update_remote_commit: managed.last_update_remote_commit,
    update_error: managed.update_error,
    update_check_status: updateCheck.status,
    update_check_reason: updateCheck.reason,
  };
};

interface InstalledExtensionDirectoryInspection {
  summary?: ManagedExtensionSummary;
  warning?: string;
}

/** Project the degraded summary retained for a directory without a manifest. */
const buildMissingManifestInspection = (
  directoryName: string,
  scope: ExtensionScope,
  settings: PmSettings,
  managedEntry: ManagedExtensionRecord | undefined,
): InstalledExtensionDirectoryInspection => {
  const managed = Object.assign(
    {
      name: directoryName,
      manifest_version: "unknown",
      manifest_entry: "unknown",
    },
    managedEntry,
  );
  const enabled = managedEntry
    ? isExtensionEnabled(settings, managedEntry.name)
    : false;
  return {
    warning: `extension_manifest_missing:${scope}:${directoryName}`,
    summary: buildInstalledExtensionSummary(
      {
        name: managed.name,
        directory: directoryName,
        version: managed.manifest_version,
        entry: managed.manifest_entry,
        enabled,
      },
      scope,
      managedEntry,
      resolveUpdateCheckResolution(managedEntry),
    ),
  };
};

/** Inspect one installed extension directory and project its manifest or warning. */
const inspectInstalledExtensionDirectory = async (
  extensionsRoot: string,
  directoryName: string,
  scope: ExtensionScope,
  settings: PmSettings,
  managedByName: ReadonlyMap<string, ManagedExtensionRecord>,
  managedByDirectory: ReadonlyMap<string, ManagedExtensionRecord>,
): Promise<InstalledExtensionDirectoryInspection> => {
  const extensionDirectory = path.join(extensionsRoot, directoryName);
  const manifestPath = path.join(extensionDirectory, "manifest.json");
  const managedDirectoryEntry = managedByDirectory.get(
    normalizeExtensionNameForMatch(directoryName),
  );
  if (!(await pathExists(manifestPath))) {
    return buildMissingManifestInspection(
      directoryName,
      scope,
      settings,
      managedDirectoryEntry,
    );
  }

  const invalidJson = Symbol("invalid-extension-manifest-json");
  const rawManifest = await fs
    .readFile(manifestPath, "utf8")
    .then((contents) => JSON.parse(contents) as unknown)
    .catch(() => invalidJson);
  if (rawManifest === invalidJson) {
    return {
      warning: `extension_manifest_invalid_json:${scope}:${directoryName}`,
    };
  }
  const manifest = parseExtensionManifest(rawManifest);
  if (!manifest) {
    return { warning: `extension_manifest_invalid:${scope}:${directoryName}` };
  }
  const managedEntry =
    managedByName.get(normalizeExtensionNameForMatch(manifest.name)) ??
    managedByDirectory.get(normalizeExtensionNameForMatch(directoryName));
  return {
    summary: buildInstalledExtensionSummary(
      {
        name: manifest.name,
        directory: directoryName,
        version: manifest.version,
        entry: manifest.entry,
        enabled: isExtensionEnabled(settings, manifest.name),
      },
      scope,
      managedEntry,
      resolveUpdateCheckResolution(managedEntry),
    ),
  };
};

/** List managed and unmanaged extensions with activation, update, and command summaries. */
const listInstalledExtensions = async (
  extensionsRoot: string,
  scope: ExtensionScope,
  settings: PmSettings,
  state: ManagedExtensionState,
): Promise<{ extensions: ManagedExtensionSummary[]; warnings: string[] }> => {
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

  const managedByName = new Map(
    state.entries.map((managedEntry) => [
      normalizeExtensionNameForMatch(managedEntry.name),
      managedEntry,
    ]),
  );
  const managedByDirectory = new Map(
    state.entries.map((managedEntry) => [
      normalizeExtensionNameForMatch(managedEntry.directory),
      managedEntry,
    ]),
  );

  const warnings: string[] = [];
  const summaries: ManagedExtensionSummary[] = [];
  for (const directoryName of directories) {
    const inspected = await inspectInstalledExtensionDirectory(
      extensionsRoot,
      directoryName,
      scope,
      settings,
      managedByName,
      managedByDirectory,
    );
    if (inspected.warning) {
      warnings.push(inspected.warning);
    }
    if (inspected.summary) {
      summaries.push(inspected.summary);
    }
  }
  return {
    extensions: summaries.sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    warnings: warnings.sort((left, right) => left.localeCompare(right)),
  };
};
type ActivationFailureEntry = Awaited<
  ReturnType<typeof activateExtensions>
>["failed"][number];

const extensionRuntimeProbeQueue = createSerialQueue();

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

/** Return stable runtime command paths registered by one extension. */
const summarizeRuntimeCommandPathsForExtension = (
  extensionName: string,
  installed: ManagedExtensionSummary[],
): { command_paths: string[]; action_paths: string[] } => {
  const normalizedName = normalizeExtensionNameForMatch(extensionName);
  const entry = installed.find(
    (candidate) =>
      normalizeExtensionNameForMatch(candidate.name) === normalizedName,
  );
  return {
    command_paths: [...(entry?.command_paths ?? [])].sort((left, right) =>
      left.localeCompare(right),
    ),
    action_paths: [...(entry?.action_paths ?? [])].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
};

/** Resolve the package vocabulary name used in extension command discovery. */
const resolveCommandDiscoveryPackageName = (
  extensionName: string,
  source: ManagedExtensionSource,
): string =>
  [source.package, source.kind === "builtin" ? source.name : undefined]
    .find((candidate) => candidate?.trim())
    ?.trim() ?? extensionName;

/** Build post-install command discovery and activation guidance for one extension. */
const buildInstallCommandDiscovery = (
  extensionName: string,
  source: ManagedExtensionSource,
  commandSummary: { command_paths: string[]; action_paths: string[] },
  activationFailure?: ActivationFailureDiagnostic,
): Record<string, unknown> => {
  const helpCommands = commandSummary.command_paths.map(
    (commandPath) => `pm ${commandPath} --help`,
  );
  const sdkDependencyMissing =
    activationFailure?.error.toLowerCase().includes("@unbrained/pm-cli") ===
    true;
  const nextSteps =
    commandSummary.command_paths.length > 0
      ? [...helpCommands]
      : [
          "Run pm package doctor --project --detail deep if expected package commands are missing.",
        ];
  if (sdkDependencyMissing) {
    nextSteps.unshift(
      "Install @unbrained/pm-cli in the target workspace so declarative package runtime imports resolve, then reinstall the package.",
    );
  }
  return {
    package_name: resolveCommandDiscoveryPackageName(extensionName, source),
    extension_name: extensionName,
    command_paths: commandSummary.command_paths,
    action_paths: commandSummary.action_paths,
    help_commands: helpCommands,
    next_steps: nextSteps,
    ...(sdkDependencyMissing ? { sdk_dependency_status: "missing" } : {}),
  };
};

/** Project one activation failure into a bounded diagnostic summary. */
const summarizeActivationFailureForDiagnostics = (
  failure: ActivationFailureEntry,
): ActivationFailureDiagnostic => {
  const trace = failure.trace;
  const summary: ActivationFailureDiagnostic = {
    layer: failure.layer,
    name: failure.name,
    entry_path: failure.entry_path,
    error: failure.error,
  };
  if (!trace) return summary;
  summary.trace = Object.fromEntries(
    Object.entries(trace).filter(([, value]) => value !== undefined),
  ) as ActivationFailureDiagnostic["trace"];
  if (trace.missing_capability) {
    summary.missing_capability = trace.missing_capability;
  }
  if (trace.hint) summary.hint = trace.hint;
  return summary;
};

/** Collect activation failures that match one extension identity. */
const collectActivationFailureDiagnostics = (
  failures: ActivationFailureEntry[],
): ActivationFailureDiagnostic[] => {
  return failures
    .map((failure) => summarizeActivationFailureForDiagnostics(failure))
    .sort((left, right) =>
      `${left.layer}:${left.name}`.localeCompare(
        `${right.layer}:${right.name}`,
      ),
    );
};

/** Find the first activation failure matching one normalized extension name. */
const findActivationFailureByName = (
  extensionName: string,
  failures: ActivationFailureDiagnostic[],
  layer?: ExtensionScope,
): ActivationFailureDiagnostic | undefined => {
  const normalizedName = normalizeExtensionNameForMatch(extensionName);
  return failures.find(
    (failure) =>
      (layer === undefined || failure.layer === layer) &&
      normalizeExtensionNameForMatch(failure.name) === normalizedName,
  );
};

/** Resolve post-install runtime activation status from load and activation evidence. */
const resolveInstallRuntimeActivationStatus = (
  extensionName: string,
  scope: ExtensionScope,
  runtimeInstalled: ManagedExtensionSummary[],
  installActivationFailure: ActivationFailureDiagnostic | undefined,
): ExtensionActivationStatus => {
  const runtimeInstalledExtension = runtimeInstalled.find(
    (entry) =>
      entry.scope === scope &&
      normalizeExtensionNameForMatch(entry.name) ===
        normalizeExtensionNameForMatch(extensionName),
  );
  return (
    runtimeInstalledExtension?.activation_status ??
    (installActivationFailure ? "failed" : "unknown")
  );
};

/** Probe a temporary installed extension for runtime command registrations. */
const probeRuntimeCommandPathsForInstall = (
  pmRoot: string,
  settings: PmSettings,
  refreshedInstalled: ManagedExtensionSummary[],
  global: GlobalOptions,
): Promise<{
  installed: ManagedExtensionSummary[];
  warnings: string[];
  activation_failures: ActivationFailureDiagnostic[];
  extensions_disabled: boolean;
  item_type_registrations: Awaited<
    ReturnType<typeof activateExtensions>
  >["registrations"]["item_types"];
}> => {
  return extensionRuntimeProbeQueue.enqueue(async () => {
    const originalPackageRoot = process.env.PM_CLI_PACKAGE_ROOT;
    process.env.PM_CLI_PACKAGE_ROOT = resolvePmPackageRootFromModule(
      import.meta.url,
      ["../.."],
    );
    try {
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
      const runtimeFailures = [
        ...loadResult.failed.map((failure) => ({
          layer: failure.layer,
          name: failure.name,
          entry_path: failure.entry_path,
          error: failure.error,
        })),
        ...collectActivationFailureDiagnostics(activationResult.failed),
      ];
      return {
        installed: applyDoctorRuntimeActivationState(
          refreshedInstalled,
          loadResult,
          activationResult,
        ),
        warnings: [...loadResult.warnings, ...activationResult.warnings],
        activation_failures: runtimeFailures,
        extensions_disabled: loadResult.disabled_by_flag,
        item_type_registrations: activationResult.registrations.item_types,
      };
    } finally {
      if (originalPackageRoot === undefined) {
        delete process.env.PM_CLI_PACKAGE_ROOT;
      } else {
        process.env.PM_CLI_PACKAGE_ROOT = originalPackageRoot;
      }
    }
  });
};

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

/** Adopt unmanaged extension directories into deterministic managed state. */
const adoptUnmanagedExtensions = async (
  extensionsRoot: string,
  scope: ExtensionScope,
  installedExtensions: ManagedExtensionSummary[],
  state: ManagedExtensionState,
): Promise<AdoptUnmanagedExtensionsResult> => {
  const unmanagedCandidates = installedExtensions.filter(
    (entry) => !entry.managed,
  );
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
    already_managed_count:
      installedExtensions.length - unmanagedCandidates.length,
  };
};

/** Resolve project and global extension roots for one lifecycle scope. */
const resolveExtensionRootsForScope = (
  scope: ExtensionScope,
  global: GlobalOptions,
): {
  pm_root: string;
  scope: ExtensionScope;
  settings_root: string;
  selected_root: string;
  roots: { global: string; project: string };
} => {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const roots = resolveExtensionRoots(pmRoot, process.cwd());
  const settingsRoot =
    scope === "global" ? resolveGlobalPmRoot(process.cwd()) : pmRoot;
  const selectedRoot = scope === "global" ? roots.global : roots.project;
  return {
    pm_root: pmRoot,
    scope,
    settings_root: settingsRoot,
    selected_root: selectedRoot,
    roots,
  };
};

/** Normalize the GitHub repository option accepted by extension lifecycle actions. */
const resolveGithubOption = (
  options: ExtensionCommandOptions,
): string | undefined => {
  const values = [options.gh, options.github]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  const uniqueValues = [...new Set(values)];
  if (uniqueValues.length > 1) {
    throw new PmCliError(
      'Options "--gh" and "--github" must match when both are provided.',
      EXIT_CODE.USAGE,
    );
  }
  return uniqueValues[0];
};

/** Return the canonical command-line flag for one extension lifecycle action. */
const getLifecycleActionFlag = (
  action: ExtensionCommandAction,
): `--${string}` => {
  return LIFECYCLE_ACTION_FLAGS[action];
};

/** Throw structured recovery guidance for a missing lifecycle target. */
const throwMissingLifecycleTarget = (
  action: ExtensionCommandAction,
  options: ExtensionCommandOptions,
): never => {
  const noun = options.vocabulary === "package" ? "package" : "extension";
  const targetName = action === "install" ? "source" : "name";
  const targetLabel = `${noun} ${targetName}`;
  const actionFlag = getLifecycleActionFlag(action);
  const commandTarget = `<${targetName}>`;
  const command = `pm ${noun} ${actionFlag} ${commandTarget}`;
  throw new PmCliError(
    `Action "${action}" requires ${targetLabel} input.`,
    EXIT_CODE.USAGE,
    {
      code: "missing_lifecycle_target",
      required: `Provide a ${targetName} target for ${action}.`,
      examples: [
        `pm ${noun} ${action} ${commandTarget}`,
        command,
        `pm ${noun} --help`,
      ],
      recovery: {
        attempted_command: `pm ${noun} ${action}`,
        suggested_retry: command,
        fallback_candidates: [
          {
            source: "lifecycle_action",
            command,
            reason: `flag-form ${action} command with required ${targetName} target`,
          },
        ],
      },
    },
  );
};

/** Return a required lifecycle target or throw structured usage guidance. */
const requireTarget = (
  target: string | undefined,
  action: ExtensionCommandAction,
  options: ExtensionCommandOptions = {},
): string => {
  const normalized = target?.trim();
  if (normalized) return normalized;
  if (action === "init") {
    throw new PmCliError(
      'Action "init" requires a scaffold target path (for example: pm package init ./my-package or pm extension init ./my-extension).',
      EXIT_CODE.USAGE,
    );
  }
  return throwMissingLifecycleTarget(action, options);
};

/** Collect doctor warnings for unsafe global output override registrations. */
const collectGlobalOutputOverrideDoctorWarnings = (
  activationResult: Awaited<ReturnType<typeof activateExtensions>>,
): string[] => {
  const warnings: string[] = [];
  for (const entry of activationResult.services.overrides) {
    if (entry.service !== "output_format") {
      continue;
    }
    warnings.push(
      `extension_output_service_override_global:${entry.service}:${entry.layer}:${entry.name}`,
    );
  }
  for (const entry of activationResult.renderers.overrides) {
    warnings.push(
      `extension_output_renderer_override_global:${entry.format}:${entry.layer}:${entry.name}`,
    );
  }
  return [...new Set(warnings)].sort((left, right) =>
    left.localeCompare(right),
  );
};

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
const collectSchemaNarrowActivationDoctorWarnings = (
  loadResult: Awaited<ReturnType<typeof loadExtensions>>,
  activationResult: Awaited<ReturnType<typeof activateExtensions>>,
): string[] => {
  const schemaContributors = new Set(
    [
      ...activationResult.registrations.item_types.map((entry) => ({
        entry,
        count: entry.types.length,
      })),
      ...activationResult.registrations.item_fields.map((entry) => ({
        entry,
        count: entry.fields.length,
      })),
    ]
      .filter(({ count }) => count > 0)
      .map(
        ({ entry }) =>
          `${entry.layer}:${normalizeExtensionNameForMatch(entry.name)}`,
      ),
  );
  return loadResult.loaded
    .filter((extension) => (extension.activation?.commands ?? []).length > 0)
    .filter((extension) =>
      schemaContributors.has(
        `${extension.layer}:${normalizeExtensionNameForMatch(extension.name)}`,
      ),
    )
    .map(
      (extension) =>
        `extension_schema_narrow_activation:${extension.layer}:${extension.name}`,
    )
    .filter((warning, index, warnings) => warnings.indexOf(warning) === index)
    .sort((left, right) => left.localeCompare(right));
};

/**
 * Shared, per-invocation context threaded to each extension action handler: the
 * resolved action/scope/roots, the alias-normalized target, the accumulating
 * warnings sink, the caller options/globals, and the `withResult` builder that
 * stamps the canonical {@link ExtensionCommandResult} envelope.
 */
interface ExtensionActionContext {
  action: ExtensionCommandAction;
  normalizedTarget: string | undefined;
  scope: ExtensionScope;
  resolvedRoots: ReturnType<typeof resolveExtensionRootsForScope>;
  warnings: string[];
  options: ExtensionCommandOptions;
  global: GlobalOptions;
  withResult: (
    details: Record<string, unknown>,
    ok?: boolean,
  ) => ExtensionCommandResult;
}

/** Reject option/action combinations that are only meaningful for a specific lifecycle action — `--trace`/`--strict-exit`/`--fail-on-warn` require `--doctor`, `--watch` requires `--reload`, `--runtime-probe` requires `--manage`, `--fix-managed-state` requires `--manage`/`--doctor`, and `--capability`/`--declarative` require `--init`/`--scaffold`. Each guard pairs a "flag is set" predicate with the action(s) that permit it and throws a USAGE error on the first mismatch. */
const assertExtensionActionOptionScope = (
  action: ExtensionCommandAction,
  options: ExtensionCommandOptions,
): void => {
  const guards: Array<{
    triggered: boolean;
    allowed: boolean;
    message: string;
  }> = [
    {
      triggered: options.strictExit === true || options.failOnWarn === true,
      allowed: action === "doctor",
      message: "--strict-exit and --fail-on-warn are only valid with --doctor.",
    },
    {
      triggered: options.trace === true,
      allowed: action === "doctor",
      message: "--trace is only valid with --doctor.",
    },
    {
      triggered: options.watch === true,
      allowed: action === "reload",
      message: "--watch is only valid with --reload.",
    },
    {
      triggered: options.runtimeProbe === true,
      allowed: action === "manage",
      message: "--runtime-probe is only valid with --manage.",
    },
    {
      triggered: options.fixManagedState === true,
      allowed: action === "manage" || action === "doctor",
      message: "--fix-managed-state is only valid with --manage or --doctor.",
    },
    {
      triggered: options.isolated === true || options.ignoreGlobal === true,
      allowed: action === "doctor",
      message: "--isolated and --ignore-global are only valid with --doctor.",
    },
    {
      triggered: options.capability !== undefined,
      allowed: action === "init",
      message: "--capability is only valid with --init/--scaffold.",
    },
    {
      triggered: options.declarative === true,
      allowed: action === "init",
      message: "--declarative is only valid with --init/--scaffold.",
    },
  ];
  const invalidGuard = guards.find(
    (guard) => guard.triggered && !guard.allowed,
  );
  if (invalidGuard) {
    throw new PmCliError(invalidGuard.message, EXIT_CODE.USAGE);
  }
};

/* c8 ignore start -- alias-normalization matrix is covered by resolveAction tests; this only rewrites positional aliases */
/** Collapse a positional target that merely repeats the action keyword (`pm extension doctor`, `reload`, `catalog`, or `init`/`scaffold`) to `undefined` so the action handlers treat it as "no target" rather than an extension name; otherwise the original target is returned unchanged. */
const resolveNormalizedExtensionTarget = (
  target: string | undefined,
  action: ExtensionCommandAction,
  options: ExtensionCommandOptions,
): string | undefined => {
  const normalizedInput = String(target ?? "")
    .trim()
    .toLowerCase();
  const explicitInitAction = [options.init, options.scaffold].includes(true);
  const aliases: Partial<Record<ExtensionCommandAction, string[]>> = {
    doctor: ["doctor"],
    reload: ["reload"],
    catalog: ["catalog"],
    init: explicitInitAction ? [] : ["init", "scaffold"],
  };
  return (aliases[action] ?? []).includes(normalizedInput) ? undefined : target;
};
/* c8 ignore stop */

/** Resolve stable roots for lifecycle results, including field-projected catalogs. */
const resolveExtensionResultRoots = (
  ctx: Pick<
    ExtensionActionContext,
    "action" | "scope" | "resolvedRoots" | "options"
  >,
): ExtensionCommandResult["roots"] => {
  const projectedCatalog = [
    ctx.action === "catalog",
    typeof ctx.options.fields === "string",
    String(ctx.options.fields).trim().length > 0,
  ].every(Boolean);
  return projectedCatalog
    ? {
        project: "project",
        global: "global",
        selected: ctx.scope,
        settings_root: "project",
      }
    : {
        project: ctx.resolvedRoots.roots.project,
        global: ctx.resolvedRoots.roots.global,
        selected: ctx.resolvedRoots.selected_root,
        settings_root: ctx.resolvedRoots.settings_root,
      };
};

/** Build and mark one canonical lifecycle result envelope. */
const buildExtensionActionResult = (
  ctx: Omit<ExtensionActionContext, "withResult">,
  details: Record<string, unknown>,
  ok: boolean,
): ExtensionCommandResult => {
  const result: ExtensionCommandResult = {
    ok,
    action: ctx.action,
    scope: ctx.scope,
    roots: resolveExtensionResultRoots(ctx),
    warnings: [...new Set(ctx.warnings)].sort((left, right) =>
      left.localeCompare(right),
    ),
    details,
  };
  if (ctx.action === "doctor") {
    Object.defineProperty(result, NATIVE_OUTPUT_MARKER, {
      value: true,
      enumerable: false,
      configurable: false,
    });
  }
  return result;
};

/**
 * Entry point for the `pm extension` / `pm package` command surface. Resolves the
 * requested lifecycle action and scope, rejects out-of-scope option usage,
 * normalizes positional aliases, then dispatches to the matching action handler —
 * each of which reads and writes managed-extension state, runtime-probes, and
 * returns the canonical {@link ExtensionCommandResult}. `--doctor` results are
 * flagged for native (non-JSON-wrapped) output.
 */
export const runExtension = async (
  target: string | undefined,
  options: ExtensionCommandOptions,
  global: GlobalOptions,
): Promise<ExtensionCommandResult> => {
  const action = resolveAction(target, options);
  assertExtensionActionOptionScope(action, options);
  const normalizedTarget = resolveNormalizedExtensionTarget(
    target,
    action,
    options,
  );
  const scope = resolveScope(options);
  const resolvedRoots = resolveExtensionRootsForScope(scope, global);
  const warnings: string[] = [];
  const actionContext = {
    action,
    normalizedTarget,
    scope,
    resolvedRoots,
    warnings,
    options,
    global,
  };
  /** Build the canonical lifecycle result envelope for this invocation. */
  const withResult = (
    details: Record<string, unknown>,
    ok = true,
  ): ExtensionCommandResult =>
    buildExtensionActionResult(actionContext, details, ok);
  const ctx: ExtensionActionContext = {
    ...actionContext,
    withResult,
  };
  return await dispatchExtensionAction(ctx);
};

/** Build copy-pasteable setup and validation guidance for a fresh scaffold. */
const buildExtensionScaffoldNextSteps = (
  scaffold: Awaited<ReturnType<typeof scaffoldExtensionProject>>,
  options: ExtensionCommandOptions,
): string[] => {
  const vocabulary = options.vocabulary ?? "extension";
  const shellTargetPath = scaffold.target_path.replace(/\\/g, "/");
  const quotedShellTargetPath = quoteCommandArg(shellTargetPath);
  const dependencySteps = {
    package: `Install dependencies: cd ${quotedShellTargetPath}, then run "npm install"`,
    extension: `Install type-check dependencies: cd ${quotedShellTargetPath}, then run "npm install -D typescript @types/node @unbrained/pm-cli"`,
  };
  const validationSteps = {
    package: `Validate the package: cd ${quotedShellTargetPath}, then run "npm run typecheck" and "npm test"`,
    extension: `Type-check the source (optional): cd ${quotedShellTargetPath}, then run "npx tsc --noEmit"`,
  };
  const declarativeGuidance: string[] = [];
  if ([vocabulary === "package", options.declarative === true].every(Boolean)) {
    declarativeGuidance.push(
      "Ensure the target workspace can resolve @unbrained/pm-cli before installing this declarative package.",
    );
  }
  return [
    dependencySteps[vocabulary],
    ...declarativeGuidance,
    `Install the scaffold: ${renderPmCommand(
      vocabulary === "package"
        ? ["install", "--project", shellTargetPath]
        : ["extension", "--install", "--project", shellTargetPath],
    )}`,
    `Smoke-test command path: pm ${scaffold.command_name}`,
    validationSteps[vocabulary],
    `Run diagnostics: ${vocabulary === "package" ? "pm package doctor" : "pm extension --doctor"} --project --detail summary`,
  ];
};

/** Scaffold a new extension project from normalized lifecycle options. */
const runExtensionInitAction = async (
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> => {
  const { action, normalizedTarget, options, withResult } = ctx;
  const githubOption = resolveGithubOption(options);
  const disallowedSourceOptions = [githubOption, options.ref]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  if (disallowedSourceOptions.length > 0) {
    throw new PmCliError(
      'Action "init" does not accept --gh/--github/--ref options.',
      EXIT_CODE.USAGE,
    );
  }
  const scaffoldTarget = requireTarget(normalizedTarget, action, options);
  const scaffold = await scaffoldExtensionProject(
    scaffoldTarget,
    options.vocabulary ?? "extension",
    options.capability,
    options.declarative === true,
  );
  return withResult({
    scaffolded:
      scaffold.created_directory ||
      scaffold.files.some((entry) => entry.status === "created"),
    extension: {
      name: scaffold.extension_name,
      command: scaffold.command_name,
    },
    capability: scaffold.capability,
    style: scaffold.style,
    target_path: scaffold.target_path,
    created_directory: scaffold.created_directory,
    files: scaffold.files,
    next_steps: buildExtensionScaffoldNextSteps(scaffold, options),
  });
};

/** Reload extension runtime state and report the new generation token. */
const runExtensionReloadAction = async (
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> => {
  const {
    normalizedTarget,
    resolvedRoots,
    warnings,
    options,
    global,
    withResult,
  } = ctx;
  if (normalizedTarget !== undefined) {
    throw new PmCliError(
      'Action "reload" does not accept a target argument.',
      EXIT_CODE.USAGE,
    );
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
    activated_count: Math.max(
      0,
      reloaded.loaded.length - activation.failed.length,
    ),
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
    warnings.push(
      "extension_reload_watch_hint:watch_mode_requested_non_interactive_single_pass_only",
    );
  }
  return withResult(details);
};

/** List bundled and installed extension catalog entries. */
const runExtensionCatalogAction = async (
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> => {
  const { normalizedTarget, scope, options, global, withResult } = ctx;
  if (
    typeof normalizedTarget === "string" &&
    normalizedTarget.length > 0 &&
    normalizedTarget !== "catalog"
  ) {
    throw new PmCliError(
      'Action "catalog" does not accept a package target.',
      EXIT_CODE.USAGE,
    );
  }
  return withResult(await buildBundledPackageCatalog(scope, global, options));
};

/* c8 ignore start -- source-shape branch combinations are exercised in install-source focused tests */
/** Build managed provenance for a bundled first-party extension alias. */
const buildBundledInstallManagedSource = (
  alias: string,
  packageName: string | null,
): ManagedExtensionSource => ({
  kind: "builtin",
  input: alias,
  location: alias,
  name: alias,
  ...(packageName === null ? {} : { package: packageName }),
});

/** Build managed provenance for a local extension source. */
const buildLocalInstallManagedSource = (
  source: Extract<
    ReturnType<typeof parseExtensionInstallSource>,
    { kind: "local" }
  >,
): ManagedExtensionSource => ({
  kind: "local",
  input: source.input,
  location: source.absolute_path,
});

/** Build managed provenance for an npm extension source. */
const buildNpmInstallManagedSource = (
  source: Extract<
    ReturnType<typeof parseExtensionInstallSource>,
    { kind: "npm" }
  >,
  resolved: Awaited<ReturnType<typeof resolveInstallSource>>,
): ManagedExtensionSource => ({
  kind: "npm",
  input: source.input,
  location: resolved.resolved_subpath ?? ".",
  package: resolved.npm_package,
  version: resolved.npm_version,
});

/** Build managed provenance for a GitHub extension source. */
const buildGithubInstallManagedSource = (
  source: Extract<
    ReturnType<typeof parseExtensionInstallSource>,
    { kind: "github" }
  >,
  resolved: Awaited<ReturnType<typeof resolveInstallSource>>,
): ManagedExtensionSource => ({
  kind: "github",
  input: source.input,
  location: resolved.resolved_subpath ?? source.subpath ?? ".",
  repository: source.repository,
  owner: source.owner,
  repo: source.repo,
  ref: source.ref,
  subpath: resolved.resolved_subpath ?? source.subpath,
  commit: resolved.commit,
});

/** Build the persisted managed-source record for an install from its resolved shape: a bundled builtin alias, a local path, an npm package, or (the default) a GitHub repository, capturing the location/commit/subpath provenance the manage and upgrade flows later read back. */
const buildInstallManagedSource = (
  bundledAliasName: string | null,
  bundledPackageName: string | null,
  installSource: ReturnType<typeof parseExtensionInstallSource>,
  resolvedSource: Awaited<ReturnType<typeof resolveInstallSource>>,
): ManagedExtensionSource => {
  if (bundledAliasName) {
    return buildBundledInstallManagedSource(
      bundledAliasName,
      bundledPackageName,
    );
  }
  if (installSource.kind === "local") {
    return buildLocalInstallManagedSource(installSource);
  }
  if (installSource.kind === "npm") {
    return buildNpmInstallManagedSource(installSource, resolvedSource);
  }
  return buildGithubInstallManagedSource(installSource, resolvedSource);
};
/* c8 ignore stop */

interface ExtensionInstallUnderLockInput {
  validated: Awaited<ReturnType<typeof validateExtensionDirectory>>;
  destinationDirectoryName: string;
  bundledAliasName: string | null;
  bundledPackageName: string | null;
  installSource: ReturnType<typeof parseExtensionInstallSource>;
  resolvedSource: Awaited<ReturnType<typeof resolveInstallSource>>;
}

/** Preserve original install time and only advance update time when source content changed. */
const resolveManagedInstallTimestamps = (
  existing: ManagedExtensionRecord | undefined,
  manifestVersion: string,
  source: ManagedExtensionSource,
  now: string,
): { installed_at: string; updated_at: string } => {
  if (!existing) return { installed_at: now, updated_at: now };
  if (existing.manifest_version !== manifestVersion) {
    return { installed_at: existing.installed_at, updated_at: now };
  }
  if (!managedExtensionSourcesEquivalent(existing.source, source)) {
    return { installed_at: existing.installed_at, updated_at: now };
  }
  return {
    installed_at: existing.installed_at,
    updated_at: existing.updated_at,
  };
};

/** Copy and persist one validated extension before its runtime activation probe. */
const persistExtensionInstall = async (
  ctx: ExtensionActionContext,
  input: ExtensionInstallUnderLockInput,
): Promise<{
  settings: PmSettings;
  managedState: ManagedExtensionState;
  sourceRecord: ManagedExtensionSource;
  destinationDirectory: string;
  destinationExists: boolean;
  installInPlace: boolean;
  activationChanged: boolean;
}> => {
  const { scope, resolvedRoots, warnings } = ctx;
  const { validated, destinationDirectoryName } = input;
  const settings = await readSettings(resolvedRoots.settings_root);
  const managedStateRead = await readManagedExtensionState(
    resolvedRoots.selected_root,
  );
  warnings.push(...managedStateRead.warnings);
  const destinationDirectory = path.join(
    resolvedRoots.selected_root,
    destinationDirectoryName,
  );
  const destinationExists = await pathExists(destinationDirectory);
  const installInPlace = await areDirectoriesEquivalent(
    validated.directory,
    destinationDirectory,
  );
  await fs.mkdir(resolvedRoots.selected_root, { recursive: true });
  const backupRoot = await fs.mkdtemp(
    path.join(resolvedRoots.selected_root, ".pm-extension-install-backup-"),
  );
  const backupDirectory = path.join(backupRoot, "destination");
  try {
    const snapshot = await captureExtensionInstallSnapshot(
      resolvedRoots.selected_root,
      resolvedRoots.settings_root,
      destinationDirectory,
      destinationExists,
      backupDirectory,
    );
    const sourceRecord = buildInstallManagedSource(
      input.bundledAliasName,
      input.bundledPackageName,
      input.installSource,
      input.resolvedSource,
    );
    const existingManagedEntry = managedStateRead.state.entries.find(
      (entry) =>
        normalizeExtensionNameForMatch(entry.name) ===
        normalizeExtensionNameForMatch(validated.manifest.name),
    );
    const timestamps = resolveManagedInstallTimestamps(
      existingManagedEntry,
      validated.manifest.version,
      sourceRecord,
      nowIso(),
    );
    const managedState = upsertManagedEntry(managedStateRead.state, {
      name: validated.manifest.name,
      directory: destinationDirectoryName,
      scope,
      manifest_version: validated.manifest.version,
      manifest_entry: validated.manifest.entry,
      capabilities: [...validated.manifest.capabilities],
      ...timestamps,
      source: sourceRecord,
    });
    const activationChanged = ensureActivated(
      settings,
      validated.manifest.name,
    );
    try {
      if (!installInPlace) {
        await copyExtensionDirectoryForInstall(
          validated.directory,
          destinationDirectory,
        );
      }
      await ensureExtensionModuleTypeMarker(destinationDirectory);
      await writeManagedExtensionState(
        resolvedRoots.selected_root,
        managedState,
      );
      if (activationChanged) {
        await writeSettings(
          resolvedRoots.settings_root,
          settings,
          "settings:write",
        );
      }
    } catch (error: unknown) {
      try {
        await restoreExtensionInstallSnapshot(snapshot);
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          `Extension install failed: ${String(error)}; rollback failed: ${String(rollbackError)}`,
          { cause: rollbackError },
        );
      }
      throw error;
    }
    return {
      settings,
      managedState,
      sourceRecord,
      destinationDirectory,
      destinationExists,
      installInPlace,
      activationChanged,
    };
  } finally {
    await fs
      .rm(backupRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
};

/** Scaffold project folders contributed by item types from the installed extension. */
const scaffoldInstalledExtensionItemTypes = async (
  ctx: ExtensionActionContext,
  extensionName: string,
  registrations: Awaited<
    ReturnType<typeof activateExtensions>
  >["registrations"]["item_types"],
): Promise<Array<{ name: string; folder?: string }>> => {
  const definitions = registrations
    .filter(
      (entry) =>
        normalizeExtensionNameForMatch(entry.name) ===
        normalizeExtensionNameForMatch(extensionName),
    )
    .flatMap((entry) =>
      entry.types.map((type) => ({ name: type.name, folder: type.folder })),
    );
  if (ctx.scope === "project" && definitions.length > 0) {
    await ensureTypeFolderScaffold(
      ctx.resolvedRoots.pm_root,
      definitions,
      ctx.warnings,
      "install:type-folder",
    );
  }
  return definitions;
};

/** Resolve post-install activation state, warnings, and health verification. */
const buildInstalledExtensionActivation = (
  ctx: ExtensionActionContext,
  extensionName: string,
  runtimeProbe: Awaited<ReturnType<typeof probeRuntimeCommandPathsForInstall>>,
  commandSummary: { command_paths: string[]; action_paths: string[] },
  installedItemTypes: Array<{ name: string; folder?: string }>,
): {
  activated: boolean;
  status: ExtensionActivationStatus;
  failure: ActivationFailureDiagnostic | undefined;
  verification: Record<string, unknown>;
} => {
  const failure = findActivationFailureByName(
    extensionName,
    runtimeProbe.activation_failures,
    ctx.scope,
  );
  const status = resolveInstallRuntimeActivationStatus(
    extensionName,
    ctx.scope,
    runtimeProbe.installed,
    failure,
  );
  const activated = [!runtimeProbe.extensions_disabled, status === "ok"].every(
    Boolean,
  );
  if (!activated) {
    ctx.warnings.push(
      `extension_install_activation_failed:${ctx.scope}:${extensionName}:${status}`,
    );
  }
  const healthByActivation = {
    true: { status: "ok", blocking_failure_count: 0 },
    false: { status: "degraded", blocking_failure_count: 1 },
  };
  return {
    activated,
    status,
    failure,
    verification: {
      status: healthByActivation[String(activated) as "true" | "false"].status,
      target_pm_root: ctx.resolvedRoots.pm_root,
      activation_status: status,
      activated,
      registered_commands: commandSummary.command_paths,
      registered_actions: commandSummary.action_paths,
      registered_item_types: installedItemTypes,
      health: healthByActivation[String(activated) as "true" | "false"],
    },
  };
};

/** Run the install body while holding the scope-wide install lock: read settings and managed state, copy the validated extension into the scope root unless it is already installed in place, upsert the managed entry and activation state, scaffold any contributed item-type folders, runtime-probe the freshly installed command paths, and return the install result envelope. */
const performExtensionInstallUnderLock = async (
  ctx: ExtensionActionContext,
  input: ExtensionInstallUnderLockInput,
): Promise<ExtensionCommandResult> => {
  const { scope, resolvedRoots, warnings, global, withResult } = ctx;
  const { validated, destinationDirectoryName } = input;
  const persisted = await persistExtensionInstall(ctx, input);
  const refreshedInstalled = await listInstalledExtensions(
    resolvedRoots.selected_root,
    scope,
    persisted.settings,
    persisted.managedState,
  );
  warnings.push(...refreshedInstalled.warnings);
  const runtimeProbe = await probeRuntimeCommandPathsForInstall(
    resolvedRoots.pm_root,
    persisted.settings,
    refreshedInstalled.extensions,
    global,
  );
  warnings.push(...runtimeProbe.warnings);
  // Scaffold the folders for any item types the installed package contributes
  // so the tracker is immediately healthy — matching `pm schema add-type` and
  // `pm profile apply`, the other paths that register a type. Without this a
  // freshly-installed schema package leaves a `missing_directory` health
  // warning until the first item of its type is created. Scoped to project
  // installs, where `pm_root` is unambiguously the tracker the type folders
  // belong to; a global install is not tied to one tracker, so its folders are
  // created lazily on first use in each project.
  const installedItemTypeDefinitions =
    await scaffoldInstalledExtensionItemTypes(
      ctx,
      validated.manifest.name,
      runtimeProbe.item_type_registrations,
    );
  const commandSummary = summarizeRuntimeCommandPathsForExtension(
    validated.manifest.name,
    runtimeProbe.installed,
  );
  const activation = buildInstalledExtensionActivation(
    ctx,
    validated.manifest.name,
    runtimeProbe,
    commandSummary,
    installedItemTypeDefinitions,
  );

  return withResult(
    {
      extension: {
        name: validated.manifest.name,
        version: validated.manifest.version,
        entry: validated.manifest.entry,
        capabilities: validated.manifest.capabilities,
        directory: destinationDirectoryName,
      },
      source: persisted.sourceRecord,
      destination_path: persisted.destinationDirectory,
      overwritten: [
        persisted.destinationExists,
        !persisted.installInPlace,
      ].every(Boolean),
      installed_in_place: persisted.installInPlace,
      activated: activation.activated,
      settings_changed: persisted.activationChanged,
      runtime_activation_status: activation.status,
      command_paths: commandSummary.command_paths,
      action_paths: commandSummary.action_paths,
      command_discovery: buildInstallCommandDiscovery(
        validated.manifest.name,
        persisted.sourceRecord,
        commandSummary,
        activation.failure,
      ),
      verification: activation.verification,
      activation_diagnostics: {
        failed_count: runtimeProbe.activation_failures.length,
        failed: runtimeProbe.activation_failures,
        installed_extension_failed: activation.failure ?? null,
      },
    },
    activation.activated,
  );
};

/** Install every bundled first-party package alias and aggregate verification. */
const runBundledExtensionInstallAll = async (
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> => {
  const { options, global, warnings, withResult } = ctx;
  if (typeof options.ref === "string" && options.ref.trim().length > 0) {
    throw new PmCliError(
      'Action "install all" does not accept --ref.',
      EXIT_CODE.USAGE,
    );
  }
  const packages: Array<{ alias: string; result: ExtensionCommandResult }> = [];
  for (const alias of await listBundledPackageAliases()) {
    packages.push({
      alias,
      result: await runExtension(alias, { ...options, install: true }, global),
    });
  }
  warnings.push(...packages.flatMap((entry) => entry.result.warnings));
  const installedAll = packages.every((entry) => entry.result.ok);
  return withResult(
    {
      installed_all: installedAll,
      installed_count: packages.filter((entry) => entry.result.ok).length,
      failed_count: packages.filter((entry) => !entry.result.ok).length,
      packages: packages.map((entry) => {
        const details = entry.result.details;
        return {
          alias: entry.alias,
          ok: entry.result.ok,
          extension: details.extension,
          source: details.source,
          destination_path: details.destination_path,
          activated: details.activated,
          settings_changed: details.settings_changed,
          command_paths: details.command_paths,
          action_paths: details.action_paths,
          command_discovery: details.command_discovery,
          verification: details.verification,
          runtime_activation_status: details.runtime_activation_status,
          activation_diagnostics: details.activation_diagnostics,
          warnings: entry.result.warnings,
        };
      }),
    },
    installedAll,
  );
};

/** Resolve bundled-alias provenance before installing one extension source. */
const resolveSingleExtensionInstallSource = async (
  explicitSourceInput: string,
  githubOption: string | undefined,
  ref: string | undefined,
): Promise<{
  bundledAliasName: string | null;
  bundledPackageName: string | null;
  installSource: ReturnType<typeof parseExtensionInstallSource>;
}> => {
  /* c8 ignore start -- github/local alias-source split is exercised in install-action integration tests */
  const bundledAliasSource =
    typeof githubOption === "string"
      ? null
      : await resolveBundledExtensionAliasSource(explicitSourceInput);
  /* c8 ignore stop */
  const bundledAliasName =
    bundledAliasSource === null
      ? null
      : explicitSourceInput.trim().toLowerCase();
  const bundledPackageName =
    bundledAliasName === null
      ? null
      : await resolveBundledPackageNpmName(bundledAliasName);
  const sourceInput = bundledAliasSource ?? explicitSourceInput;
  /* c8 ignore start -- install-source branch combinations are covered in install-sources focused tests */
  const installSource = parseExtensionInstallSource(sourceInput, {
    forceGithub: typeof githubOption === "string",
    ref,
  });
  /* c8 ignore stop */
  return { bundledAliasName, bundledPackageName, installSource };
};

/** Install one resolved source and clean transient source material afterward. */
const runSingleExtensionInstall = async (
  ctx: ExtensionActionContext,
  explicitSourceInput: string,
  githubOption: string | undefined,
): Promise<ExtensionCommandResult> => {
  const { resolvedRoots } = ctx;
  const { bundledAliasName, bundledPackageName, installSource } =
    await resolveSingleExtensionInstallSource(
      explicitSourceInput,
      githubOption,
      ctx.options.ref,
    );
  const resolvedSource = await resolveInstallSource(installSource);
  try {
    const validated = await validateExtensionDirectory(
      resolvedSource.directory,
    );
    const destinationDirectoryName = normalizeManagedDirectoryName(
      validated.manifest.name,
    );
    return await withExtensionInstallLock(
      resolvedRoots.settings_root,
      destinationDirectoryName,
      () =>
        performExtensionInstallUnderLock(ctx, {
          validated,
          destinationDirectoryName,
          bundledAliasName,
          bundledPackageName,
          installSource,
          resolvedSource,
        }),
    );
  } finally {
    /* c8 ignore start -- cleanup hooks are only present for transient install sources */
    if (resolvedSource.cleanup) {
      await resolvedSource.cleanup();
    }
    /* c8 ignore stop */
  }
};

/** Install one extension source under the owner-bound lifecycle lock. */
const runExtensionInstallAction = async (
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> => {
  const githubOption = resolveGithubOption(ctx.options);
  const explicitSourceInput =
    githubOption ??
    requireTarget(ctx.normalizedTarget, ctx.action, ctx.options);
  if (
    [
      githubOption === undefined,
      isBundledPackageInstallAllTarget(explicitSourceInput),
    ].every(Boolean)
  ) {
    return runBundledExtensionInstallAll(ctx);
  }
  return runSingleExtensionInstall(ctx, explicitSourceInput, githubOption);
};

/** Adopt every eligible unmanaged extension in the selected scope. */
const runExtensionAdoptAllAction = async (
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> => {
  const {
    normalizedTarget,
    scope,
    resolvedRoots,
    warnings,
    options,
    withResult,
  } = ctx;
  if (normalizedTarget !== undefined) {
    throw new PmCliError(
      'Action "adopt-all" does not accept a target argument.',
      EXIT_CODE.USAGE,
    );
  }
  const githubOption = resolveGithubOption(options);
  if (
    githubOption !== undefined ||
    (typeof options.ref === "string" && options.ref.trim().length > 0)
  ) {
    throw new PmCliError(
      'Action "adopt-all" does not accept --gh/--github/--ref options.',
      EXIT_CODE.USAGE,
    );
  }
  const settings = await readSettings(resolvedRoots.settings_root);
  const managedStateRead = await readManagedExtensionState(
    resolvedRoots.selected_root,
  );
  warnings.push(...managedStateRead.warnings);
  const installed = await listInstalledExtensions(
    resolvedRoots.selected_root,
    scope,
    settings,
    managedStateRead.state,
  );
  warnings.push(...installed.warnings);
  const adoption = await adoptUnmanagedExtensions(
    resolvedRoots.selected_root,
    scope,
    installed.extensions,
    managedStateRead.state,
  );
  const refreshedInstalled = await listInstalledExtensions(
    resolvedRoots.selected_root,
    scope,
    settings,
    adoption.state,
  );
  warnings.push(...refreshedInstalled.warnings);
  const triage = buildExtensionTriageSummary(
    scope,
    warnings,
    refreshedInstalled.extensions,
    options,
  );
  warnings.push(...triage.warnings);
  /* c8 ignore start -- refresh-entry optional metadata is display-only and exercised indirectly */
  const refreshedByIdentity = new Map(
    refreshedInstalled.extensions.map((entry) => [
      `${normalizeExtensionNameForMatch(entry.name)}:${normalizeExtensionNameForMatch(entry.directory)}`,
      entry,
    ]),
  );
  const refreshedByDirectory = new Map(
    refreshedInstalled.extensions.map((entry) => [
      normalizeExtensionNameForMatch(entry.directory),
      entry,
    ]),
  );
  const adoptedDetails = adoption.adopted_entries.map((entry) => {
    const normalizedDirectory = normalizeExtensionNameForMatch(entry.directory);
    const refreshedEntry =
      refreshedByIdentity.get(
        `${normalizeExtensionNameForMatch(entry.name)}:${normalizedDirectory}`,
      ) ?? refreshedByDirectory.get(normalizedDirectory);
    return { ...entry, ...projectExtensionUpdateCheck(refreshedEntry) };
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
};

/** Project nullable update-check metadata for adopt result payloads. */
const projectExtensionUpdateCheck = (
  entry: ManagedExtensionSummary | undefined,
): {
  update_check_status: string | null;
  update_check_reason: string | null;
} => {
  return {
    update_check_status: entry?.update_check_status ?? null,
    update_check_reason: entry?.update_check_reason ?? null,
  };
};

/** Resolve local or GitHub provenance for an adopted extension. */
const buildAdoptedExtensionSource = (
  githubOption: string | undefined,
  extensionTarget: string,
  extensionDirectory: string,
  ref: string | undefined,
): ManagedExtensionSource => {
  if (githubOption === undefined) {
    return {
      kind: "local",
      input: extensionTarget,
      location: extensionDirectory,
    };
  }
  const parsed = parseExtensionInstallSource(githubOption, {
    forceGithub: true,
    ref,
  });
  /* c8 ignore start -- forceGithub guarantees a github-kind install source */
  if (parsed.kind !== "github") {
    throw new PmCliError(
      `Invalid GitHub shorthand "${githubOption}".`,
      EXIT_CODE.USAGE,
    );
  }
  /* c8 ignore stop */
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
};

/** Adopt one unmanaged extension into managed lifecycle state. */
const runExtensionAdoptAction = async (
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> => {
  const {
    action,
    normalizedTarget,
    scope,
    resolvedRoots,
    warnings,
    options,
    withResult,
  } = ctx;
  const extensionTarget = requireTarget(normalizedTarget, action, options);
  const githubOption = resolveGithubOption(options);
  const settings = await readSettings(resolvedRoots.settings_root);
  const managedStateRead = await readManagedExtensionState(
    resolvedRoots.selected_root,
  );
  warnings.push(...managedStateRead.warnings);
  const installed = await listInstalledExtensions(
    resolvedRoots.selected_root,
    scope,
    settings,
    managedStateRead.state,
  );
  warnings.push(...installed.warnings);
  const candidate = await resolveInstalledExtensionCandidate(
    installed.extensions,
    extensionTarget,
  );
  if (!candidate) {
    throw new PmCliError(
      `Installed extension "${extensionTarget}" was not found in ${scope} scope.`,
      EXIT_CODE.NOT_FOUND,
    );
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

  const extensionDirectory = path.join(
    resolvedRoots.selected_root,
    candidate.directory,
  );
  const validated = await validateExtensionDirectory(extensionDirectory);
  const now = nowIso();
  const sourceRecord = buildAdoptedExtensionSource(
    githubOption,
    extensionTarget,
    extensionDirectory,
    options.ref,
  );
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
  const refreshedInstalled = await listInstalledExtensions(
    resolvedRoots.selected_root,
    scope,
    settings,
    managedState,
  );
  warnings.push(...refreshedInstalled.warnings);
  /* c8 ignore start -- fallback only matters if a manifest renames between adopt and refresh */
  const refreshedEntry =
    refreshedInstalled.extensions.find(
      (entry) =>
        normalizeExtensionNameForMatch(entry.name) ===
        normalizeExtensionNameForMatch(validated.manifest.name),
    ) ??
    refreshedInstalled.extensions.find(
      (entry) =>
        normalizeExtensionNameForMatch(entry.directory) ===
        normalizeExtensionNameForMatch(candidate.directory),
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
    ...projectExtensionUpdateCheck(refreshedEntry),
  });
  /* c8 ignore stop */
};

/** Resolve a required installed extension or throw structured not-found guidance. */
const resolveRequiredInstalledExtension = async (
  ctx: ExtensionActionContext,
) => {
  const { action, normalizedTarget, scope, resolvedRoots, warnings, options } =
    ctx;
  const extensionTarget = requireTarget(normalizedTarget, action, options);
  const settings = await readSettings(resolvedRoots.settings_root);
  const managedStateRead = await readManagedExtensionState(
    resolvedRoots.selected_root,
  );
  warnings.push(...managedStateRead.warnings);
  const installed = await listInstalledExtensions(
    resolvedRoots.selected_root,
    scope,
    settings,
    managedStateRead.state,
  );
  warnings.push(...installed.warnings);
  const candidate = await resolveInstalledExtensionCandidate(
    installed.extensions,
    extensionTarget,
  );
  if (!candidate) {
    throw new PmCliError(
      `Installed extension "${extensionTarget}" was not found in ${scope} scope.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  return { settings, managedStateRead, candidate };
};

/** Uninstall one managed extension and update lifecycle state. */
const runExtensionUninstallAction = async (
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> => {
  const { resolvedRoots, withResult } = ctx;
  const { settings, managedStateRead, candidate } =
    await resolveRequiredInstalledExtension(ctx);
  const destinationDirectory = path.join(
    resolvedRoots.selected_root,
    candidate.directory,
  );
  await fs.rm(destinationDirectory, { recursive: true, force: true });

  const updatedState: ManagedExtensionState = {
    ...managedStateRead.state,
    updated_at: nowIso(),
    /* c8 ignore start -- uninstall filter keeps both name+directory guards for legacy managed-state migrations */
    entries: managedStateRead.state.entries.filter(
      (entry) =>
        normalizeExtensionNameForMatch(entry.name) !==
          normalizeExtensionNameForMatch(candidate.name) &&
        normalizeExtensionNameForMatch(entry.directory) !==
          normalizeExtensionNameForMatch(candidate.directory),
    ),
    /* c8 ignore stop */
  };
  await writeManagedExtensionState(resolvedRoots.selected_root, updatedState);

  const stateChanged = clearExtensionState(settings, candidate.name);
  if (stateChanged) {
    await writeSettings(
      resolvedRoots.settings_root,
      settings,
      "settings:write",
    );
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
};

/** Activate or deactivate one installed extension and persist the resulting state. */
const runExtensionActivateDeactivateAction = async (
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> => {
  const { action, resolvedRoots, withResult } = ctx;
  const { settings, candidate } = await resolveRequiredInstalledExtension(ctx);

  const settingsChanged =
    action === "activate"
      ? ensureActivated(settings, candidate.name)
      : ensureDeactivated(settings, candidate.name);
  if (settingsChanged) {
    await writeSettings(
      resolvedRoots.settings_root,
      settings,
      "settings:write",
    );
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
};

/** Assemble the doctor remediation hints: the triage remediations, vocabulary-aware advice to inspect load failures and activation failures, and a note when a managed-state fix adopted entries. Blank entries are trimmed and the list is de-duplicated. */
const buildDoctorRemediation = (
  baseRemediation: string[],
  loadFailureCount: number,
  activationFailureCount: number,
  vocabulary: ExtensionCommandOptions["vocabulary"],
  managedStateFix: AdoptUnmanagedExtensionsResult | null,
  isolationHint: string | null,
): string[] => {
  const noun = vocabulary === "package" ? "package" : "extension";
  const doctorAction = { package: "doctor", extension: "--doctor" }[noun];
  const adoptedCount = managedStateFix?.adopted_entries.length ?? 0;
  const conditionalEntries: Array<[boolean, string]> = [
    [isolationHint !== null, isolationHint ?? ""],
    [
      loadFailureCount > 0,
      `Run pm ${noun} explore --project and pm ${noun} explore --global to inspect load failures.`,
    ],
    [
      activationFailureCount > 0,
      `Review activation failures in pm ${noun} ${doctorAction} --detail deep output.`,
    ],
    [
      adoptedCount > 0,
      `Managed-state fix adopted ${adoptedCount} extension(s).`,
    ],
  ];
  return [
    ...new Set(
      [
        ...baseRemediation,
        ...conditionalEntries
          .filter(([include]) => include)
          .map(([, entry]) => entry),
      ]
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
};

/** Return whether doctor details contain any global-layer diagnostics. */
const hasGlobalLayerDiagnostics = (
  loadResult: Awaited<ReturnType<typeof loadExtensions>>,
): boolean => {
  return (
    loadResult.loaded.some((entry) => entry.layer === "global") ||
    loadResult.failed.some((entry) => entry.layer === "global") ||
    loadResult.warnings.some((warning) => warning.includes(":global:"))
  );
};

/** Build the project-isolation remediation hint for global extension conflicts. */
const buildDoctorIsolationHint = (
  scope: ExtensionScope,
  isolated: boolean,
  vocabulary: ExtensionCommandOptions["vocabulary"],
  loadResult: Awaited<ReturnType<typeof loadExtensions>>,
): string | null => {
  if (
    scope !== "project" ||
    isolated ||
    !hasGlobalLayerDiagnostics(loadResult)
  ) {
    return null;
  }
  const noun = vocabulary === "package" ? "package" : "extension";
  return (
    `Global ${noun} registrations are included in project diagnostics. ` +
    `For hermetic ${noun} smoke tests, rerun pm ${noun} doctor --project --isolated --detail deep --trace, ` +
    "or set PM_GLOBAL_PATH to a temporary directory for the whole test process."
  );
};

interface DoctorIsolationMetadata {
  isolated: boolean;
  global_extensions_included: boolean;
  global_diagnostics_present: boolean;
  rerun_command: string | null;
  pm_global_path_recipe: string | null;
}

/** Validate doctor-only arguments and return normalized execution switches. */
const resolveDoctorInvocationOptions = (
  target: string | undefined,
  scope: ExtensionScope,
  options: ExtensionCommandOptions,
): {
  isolated: boolean;
  detailMode: ReturnType<typeof parseDoctorDetailMode>;
  includeTrace: boolean;
} => {
  if (String(target ?? "").trim().length > 0) {
    throw new PmCliError(
      'Action "doctor" does not accept a target argument.',
      EXIT_CODE.USAGE,
    );
  }
  const isolated = [options.isolated, options.ignoreGlobal].includes(true);
  if ([isolated, scope === "global"].every(Boolean)) {
    throw new PmCliError(
      "--isolated and --ignore-global are only valid with project-scope doctor diagnostics.",
      EXIT_CODE.USAGE,
    );
  }
  const detailMode = parseDoctorDetailMode(options.detail);
  const includeTrace = options.trace === true;
  if ([includeTrace, detailMode !== "deep"].every(Boolean)) {
    throw new PmCliError(
      "--trace requires --detail deep with --doctor.",
      EXIT_CODE.USAGE,
    );
  }
  return { isolated, detailMode, includeTrace };
};

/** Optionally adopt unmanaged entries requested by doctor and return effective state. */
const applyDoctorManagedStateFix = async (
  ctx: ExtensionActionContext,
  installed: ManagedExtensionSummary[],
  state: ManagedExtensionState,
): Promise<{
  state: ManagedExtensionState;
  fix: AdoptUnmanagedExtensionsResult | null;
}> => {
  if (ctx.options.fixManagedState !== true) return { state, fix: null };
  const fix = await adoptUnmanagedExtensions(
    ctx.resolvedRoots.selected_root,
    ctx.scope,
    installed,
    state,
  );
  return { state: fix.state, fix };
};

/** Build the doctor isolation block shared by summary and details output so the over-the-wire payload stays identical for extension and package vocabulary. */
const buildDoctorIsolationMetadata = (
  scope: ExtensionScope,
  isolated: boolean,
  vocabulary: ExtensionCommandOptions["vocabulary"],
  loadResult: Awaited<ReturnType<typeof loadExtensions>>,
): DoctorIsolationMetadata => {
  const noun = vocabulary === "package" ? "package" : "extension";
  if (scope !== "project") {
    return {
      isolated,
      global_extensions_included: false,
      global_diagnostics_present: hasGlobalLayerDiagnostics(loadResult),
      rerun_command: null,
      pm_global_path_recipe: null,
    };
  }
  const isolatedCommand = `pm ${noun} doctor --project --isolated --detail deep --trace`;
  return {
    isolated,
    global_extensions_included: !isolated,
    global_diagnostics_present: hasGlobalLayerDiagnostics(loadResult),
    rerun_command: isolated ? null : isolatedCommand,
    pm_global_path_recipe: `PM_GLOBAL_PATH=$(mktemp -d) pm ${noun} doctor --project --detail deep --trace`,
  };
};

/** Run extension integrity, activation, policy, and isolation diagnostics. */
const runExtensionDoctorAction = async (
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> => {
  const {
    normalizedTarget,
    scope,
    resolvedRoots,
    warnings,
    options,
    global,
    withResult,
  } = ctx;
  const { isolated, detailMode, includeTrace } = resolveDoctorInvocationOptions(
    normalizedTarget,
    scope,
    options,
  );
  const settings = await readSettings(resolvedRoots.settings_root);
  const managedStateRead = await readManagedExtensionState(
    resolvedRoots.selected_root,
  );
  warnings.push(...managedStateRead.warnings);
  const installed = await listInstalledExtensions(
    resolvedRoots.selected_root,
    scope,
    settings,
    managedStateRead.state,
  );
  warnings.push(...installed.warnings);
  const { state: managedState, fix: managedStateFix } =
    await applyDoctorManagedStateFix(
      ctx,
      installed.extensions,
      managedStateRead.state,
    );
  const refreshedInstalled = await listInstalledExtensions(
    resolvedRoots.selected_root,
    scope,
    settings,
    managedState,
  );
  warnings.push(...refreshedInstalled.warnings);

  const loadResult = await loadExtensions({
    pmRoot: resolvedRoots.pm_root,
    settings,
    cwd: process.cwd(),
    noExtensions: global.noExtensions === true,
    ignoreGlobalExtensions: isolated,
  });
  const activationResult = await activateExtensions({
    ...loadResult,
    loaded: loadResult.loaded,
  });
  warnings.push(...loadResult.warnings);
  warnings.push(...classifyDoctorLoadFailureWarnings(loadResult.failed));
  warnings.push(...activationResult.warnings);
  warnings.push(
    ...classifyDoctorActivationFailureWarnings(activationResult.failed),
  );
  warnings.push(
    ...classifyUnusedCapabilityWarnings(loadResult, activationResult),
  );
  warnings.push(...collectGlobalOutputOverrideDoctorWarnings(activationResult));
  warnings.push(
    ...collectSchemaNarrowActivationDoctorWarnings(
      loadResult,
      activationResult,
    ),
  );
  const runtimeInstalledExtensions = applyDoctorRuntimeActivationState(
    refreshedInstalled.extensions,
    loadResult,
    activationResult,
  );
  const doctorConsistency = buildDoctorConsistencySummary(
    scope,
    runtimeInstalledExtensions,
    loadResult.loaded.map((entry) => ({
      layer: entry.layer,
      name: entry.name,
    })),
    loadResult.failed.map((entry) => ({ name: entry.name })),
    loadResult.disabled_by_flag,
  );
  warnings.push(...doctorConsistency.warnings);
  const updateCheckWarnings = runtimeInstalledExtensions
    .filter((entry) => entry.update_check_status === "failed")
    .map((entry) => `extension_update_check_failed:${entry.name}`);
  warnings.push(...updateCheckWarnings);

  const triage = buildExtensionTriageSummary(
    scope,
    warnings,
    runtimeInstalledExtensions,
    options,
  );
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
  const capabilityGuidance =
    collectUnknownCapabilityGuidance(normalizedWarnings);
  const capabilityContract = buildCapabilityContractMetadata();
  const warningCodes = triage.warning_codes;
  const isolationHint = buildDoctorIsolationHint(
    scope,
    isolated,
    options.vocabulary,
    loadResult,
  );
  const remediation = buildDoctorRemediation(
    triage.remediation,
    loadResult.failed.length,
    activationResult.failed.length,
    options.vocabulary,
    managedStateFix,
    isolationHint,
  );
  const isolation = buildDoctorIsolationMetadata(
    scope,
    isolated,
    options.vocabulary,
    loadResult,
  );

  const summary = {
    status: triage.status,
    scope,
    warning_count: triage.warning_count,
    warning_codes: warningCodes,
    total_extensions: runtimeInstalledExtensions.length,
    managed_total: runtimeInstalledExtensions.filter((entry) => entry.managed)
      .length,
    enabled_total: runtimeInstalledExtensions.filter((entry) => entry.enabled)
      .length,
    active_total: runtimeInstalledExtensions.filter((entry) => entry.active)
      .length,
    unmanaged_loaded_extension_count: triage.unmanaged_loaded_extension_count,
    unmanaged_action_required_extension_count:
      triage.unmanaged_action_required_extension_count,
    unmanaged_expected_extension_count:
      triage.unmanaged_expected_extension_count,
    runtime_active_total: runtimeInstalledExtensions.filter(
      (entry) => entry.runtime_active === true,
    ).length,
    activation_status_totals: {
      ok: runtimeInstalledExtensions.filter(
        (entry) => entry.activation_status === "ok",
      ).length,
      failed: runtimeInstalledExtensions.filter(
        (entry) => entry.activation_status === "failed",
      ).length,
      not_loaded: runtimeInstalledExtensions.filter(
        (entry) => entry.activation_status === "not_loaded",
      ).length,
      unknown: runtimeInstalledExtensions.filter(
        (entry) => entry.activation_status === "unknown",
      ).length,
    },
    unknown_capability_count: capabilityGuidance.length,
    capability_contract_version: capabilityContract.version,
    update_available_total: runtimeInstalledExtensions.filter(
      (entry) => entry.update_available === true,
    ).length,
    update_health_coverage: triage.update_health_coverage,
    update_health_partial: triage.update_health_partial,
    update_check_failed_total: runtimeInstalledExtensions.filter(
      (entry) => entry.update_check_status === "failed",
    ).length,
    load_failure_count: loadResult.failed.length,
    activation_failure_count: activationResult.failed.length,
    blocking_failure_count:
      loadResult.failed.length + activationResult.failed.length,
    has_blocking_failures:
      loadResult.failed.length + activationResult.failed.length > 0,
    consistency_warning_count: doctorConsistency.warnings.length,
    trace_enabled: includeTrace,
    isolation,
    policy: policySummary,
    remediation,
  };

  const managedStateFixSummary = managedStateFix
    ? {
        requested: true,
        applied: managedStateFix.adopted_entries.length > 0,
        adopted_count: managedStateFix.adopted_entries.length,
        already_managed_count: managedStateFix.already_managed_count,
        adopted_extensions: managedStateFix.adopted_entries.map(
          (entry) => entry.name,
        ),
      }
    : {
        requested: false,
        applied: false,
        adopted_count: 0,
        already_managed_count: refreshedInstalled.extensions.filter(
          (entry) => entry.managed,
        ).length,
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
    isolation,
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
          .filter(
            (
              entry,
            ): entry is ActivationFailureEntry & {
              trace: NonNullable<ActivationFailureEntry["trace"]>;
            } => entry.trace !== undefined,
          )
          .map((entry) => ({
            layer: entry.layer,
            name: entry.name,
            entry_path: entry.entry_path,
            error: entry.error,
            method: entry.trace.method,
            command: entry.trace.command,
            capability: entry.trace.capability,
            missing_capability: entry.trace.missing_capability,
            registration_index: entry.trace.registration_index,
            expected_schema: entry.trace.expected_schema,
            hint: entry.trace.hint,
            received: entry.trace.received,
          })),
      };
    }
  }
  return withResult(details);
};

/** Describe one installed extension and its runtime registrations. */
const runExtensionDescribeAction = async (
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> => {
  const {
    normalizedTarget,
    scope,
    resolvedRoots,
    warnings,
    options,
    global,
    withResult,
  } = ctx;
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
  const describeResult = buildExtensionDescribeResult(
    normalizedTarget,
    loadResult,
    activationResult,
  );
  if (
    normalizedTarget !== undefined &&
    describeResult.extensions.length === 0
  ) {
    const noun = options.vocabulary === "package" ? "package" : "extension";
    const loadedNames = [
      ...new Set(
        loadResult.loaded.map((entry) =>
          options.vocabulary === "package" &&
          typeof entry.source_package === "string" &&
          entry.source_package.trim().length > 0
            ? entry.source_package.trim()
            : entry.name,
        ),
      ),
    ].sort((left, right) => left.localeCompare(right));
    const loadedHint =
      loadedNames.length > 0
        ? ` Loaded ${noun} names: ${loadedNames.join(", ")}.`
        : "";
    throw new PmCliError(
      `No loaded ${noun} named "${normalizedTarget}" was found in ${scope} scope.${loadedHint} Run pm ${noun} explore to list discovered ${noun}s.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  return withResult({
    target: describeResult.target,
    total: describeResult.total,
    extensions: describeResult.extensions,
    union: describeResult.union,
  });
};

/* c8 ignore start -- explore/manage action split is validated by dedicated command-action tests */
/** Apply manage-only adoption and remote update checks to managed extension state. */
const prepareExploreManageState = async (
  ctx: ExtensionActionContext,
  installed: ManagedExtensionSummary[],
  initialState: ManagedExtensionState,
): Promise<{
  state: ManagedExtensionState;
  fix: AdoptUnmanagedExtensionsResult | null;
}> => {
  let state = initialState;
  let fix: AdoptUnmanagedExtensionsResult | null = null;
  if (
    [ctx.action === "manage", ctx.options.fixManagedState === true].every(
      Boolean,
    )
  ) {
    fix = await adoptUnmanagedExtensions(
      ctx.resolvedRoots.selected_root,
      ctx.scope,
      installed,
      initialState,
    );
    state = fix.state;
  }
  if (ctx.action === "manage") {
    const entries = await mapWithFixedConcurrency(
      state.entries,
      GITHUB_UPDATE_CHECK_CONCURRENCY,
      async (entry) => {
        if (entry.source.kind !== "github") return entry;
        const updateStatus = await checkGithubUpdate(entry.source);
        return {
          ...entry,
          last_update_check_at: updateStatus.checked_at,
          last_update_remote_commit: updateStatus.remote_commit,
          update_available: updateStatus.available,
          update_error: updateStatus.error,
        };
      },
    );
    state = {
      ...state,
      updated_at: nowIso(),
      entries: sortManagedEntries(entries),
    };
    await writeManagedExtensionState(ctx.resolvedRoots.selected_root, state);
  }
  return { state, fix };
};

/** Runtime-probe explore by default and manage only when explicitly requested. */
const probeExploreManageRuntime = async (
  ctx: ExtensionActionContext,
  settings: PmSettings,
  installed: ManagedExtensionSummary[],
): Promise<{
  installed: ManagedExtensionSummary[];
  failures: ActivationFailureDiagnostic[] | undefined;
  summary: Record<string, unknown>;
}> => {
  const requested = [
    ctx.action === "explore",
    ctx.options.runtimeProbe === true,
  ].includes(true);
  if (!requested) {
    return {
      installed,
      failures: undefined,
      summary: { requested: false, executed: false },
    };
  }
  const loadResult = await loadExtensions({
    pmRoot: ctx.resolvedRoots.pm_root,
    settings,
    cwd: process.cwd(),
    noExtensions: ctx.global.noExtensions === true,
  });
  const activationResult = await activateExtensions({
    ...loadResult,
    loaded: loadResult.loaded,
  });
  ctx.warnings.push(...loadResult.warnings, ...activationResult.warnings);
  return {
    installed: applyDoctorRuntimeActivationState(
      installed,
      loadResult,
      activationResult,
    ),
    failures: collectActivationFailureDiagnostics(activationResult.failed),
    summary: {
      requested: true,
      executed: true,
      reason:
        ctx.action === "explore"
          ? "explore_defaults_to_runtime_probe"
          : "runtime_probe_requested",
      load_failure_count: loadResult.failed.length,
      activation_failure_count: activationResult.failed.length,
      warning_count: [
        ...new Set([...loadResult.warnings, ...activationResult.warnings]),
      ].length,
      policy: loadResult.policy,
    },
  };
};

/** Project manage-only adoption details without coupling them to runtime probing. */
const projectExploreManageFix = (
  fix: AdoptUnmanagedExtensionsResult | null,
  installed: ManagedExtensionSummary[],
): Record<string, unknown> =>
  fix
    ? {
        requested: true,
        applied: fix.adopted_entries.length > 0,
        adopted_count: fix.adopted_entries.length,
        adopted_extensions: fix.adopted_entries.map((entry) => entry.name),
        already_managed_count: fix.already_managed_count,
      }
    : {
        requested: false,
        applied: false,
        adopted_count: 0,
        adopted_extensions: [],
        already_managed_count: installed.filter((entry) => entry.managed)
          .length,
      };

/** Explore installed extensions or mutate managed lifecycle state. */
const runExtensionExploreManageAction = async (
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> => {
  const { action, scope, resolvedRoots, warnings, options, withResult } = ctx;
  const settings = await readSettings(resolvedRoots.settings_root);
  const configuredPolicy = buildExtensionPolicyDetails(
    settings.extensions.policy,
  );
  const managedStateRead = await readManagedExtensionState(
    resolvedRoots.selected_root,
  );
  warnings.push(...managedStateRead.warnings);
  const installed = await listInstalledExtensions(
    resolvedRoots.selected_root,
    scope,
    settings,
    managedStateRead.state,
  );
  warnings.push(...installed.warnings);

  const { state: managedState, fix: managedStateFix } =
    await prepareExploreManageState(
      ctx,
      installed.extensions,
      managedStateRead.state,
    );

  const refreshedInstalled = await listInstalledExtensions(
    resolvedRoots.selected_root,
    scope,
    settings,
    managedState,
  );
  warnings.push(...refreshedInstalled.warnings);
  if (action === "manage") {
    const updateWarnings = refreshedInstalled.extensions
      .filter((entry) => entry.update_check_status === "failed")
      .map((entry) => `extension_update_check_failed:${entry.name}`);
    warnings.push(...updateWarnings);
  }
  const runtimeProbe = await probeExploreManageRuntime(
    ctx,
    settings,
    refreshedInstalled.extensions,
  );
  const runtimeInstalledExtensions = runtimeProbe.installed;

  const triage = buildExtensionTriageSummary(
    scope,
    warnings,
    runtimeInstalledExtensions,
    options,
  );
  warnings.push(...triage.warnings);
  const details: Record<string, unknown> = {
    total: runtimeInstalledExtensions.length,
    managed_total: runtimeInstalledExtensions.filter((entry) => entry.managed)
      .length,
    enabled_total: runtimeInstalledExtensions.filter((entry) => entry.enabled)
      .length,
    active_total: runtimeInstalledExtensions.filter((entry) => entry.active)
      .length,
    extensions: runtimeInstalledExtensions,
    triage,
    policy: configuredPolicy,
  };
  if (runtimeProbe.failures !== undefined) {
    details.activation_diagnostics = {
      failed_count: runtimeProbe.failures.length,
      failed: runtimeProbe.failures,
    };
  }
  if (action === "explore") {
    details.runtime_probe = runtimeProbe.summary;
  }
  if (action === "manage") {
    details.runtime_probe = runtimeProbe.summary;
    details.managed_state_fix = projectExploreManageFix(
      managedStateFix,
      runtimeInstalledExtensions,
    );
  }
  return withResult(details);
};
/* c8 ignore stop */

// Dispatch table from lifecycle action to its handler. `explore`/`manage` and
// `activate`/`deactivate` share a handler that branches on `ctx.action`; the
// closed ExtensionCommandAction union guarantees every action has an entry, so
// runExtension needs no unsupported-action fallthrough.
const EXTENSION_ACTION_HANDLERS: Record<
  ExtensionCommandAction,
  (ctx: ExtensionActionContext) => Promise<ExtensionCommandResult>
> = {
  init: runExtensionInitAction,
  install: runExtensionInstallAction,
  uninstall: runExtensionUninstallAction,
  explore: runExtensionExploreManageAction,
  manage: runExtensionExploreManageAction,
  describe: runExtensionDescribeAction,
  reload: runExtensionReloadAction,
  doctor: runExtensionDoctorAction,
  catalog: runExtensionCatalogAction,
  adopt: runExtensionAdoptAction,
  "adopt-all": runExtensionAdoptAllAction,
  activate: runExtensionActivateDeactivateAction,
  deactivate: runExtensionActivateDeactivateAction,
};

/** Identify lifecycle actions that mutate shared settings or managed-extension state. */
const requiresExtensionStateLock = (ctx: ExtensionActionContext): boolean =>
  [
    ctx.action === "uninstall",
    ctx.action === "manage",
    ctx.action === "adopt",
    ctx.action === "adopt-all",
    ctx.action === "activate",
    ctx.action === "deactivate",
    [ctx.action === "doctor", ctx.options.fixManagedState === true].every(
      Boolean,
    ),
  ].some(Boolean);

/** Dispatch one normalized lifecycle action through the complete handler table. */
const dispatchExtensionAction = (
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> =>
  requiresExtensionStateLock(ctx)
    ? withExtensionInstallLock(
        ctx.resolvedRoots.settings_root,
        `${ctx.action}-state`,
        () => EXTENSION_ACTION_HANDLERS[ctx.action](ctx),
      )
    : EXTENSION_ACTION_HANDLERS[ctx.action](ctx);

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  adoptUnmanagedExtensions,
  buildAdoptedExtensionSource,
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
  mapWithFixedConcurrency,
  projectExtensionUpdateCheck,
  readOptionalMetadataFile,
  requireTarget,
  resolveAction,
  resolveCommandDiscoveryPackageName,
  resolveGithubOption,
  resolveInstalledExtensionCandidate,
  resolveScope,
  resolveUpdateCheckResolution,
  withExtensionInstallLock,
};
