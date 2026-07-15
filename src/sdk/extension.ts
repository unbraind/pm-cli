/**
 * @module sdk/extension
 *
 * Implements the pm extension command surface and its agent-facing runtime behavior.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  activateExtensions,
  createSerialQueue,
  loadExtensions,
  nextExtensionReloadToken,
} from "../core/extensions/index.js";
import { resolveExtensionRoots } from "../core/extensions/loader.js";
import { pathExists } from "../core/fs/fs-utils.js";
import { isPathWithinDirectory } from "../core/fs/path-utils.js";
import { resolvePmPackageRootFromModule } from "../core/packages/root.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { levenshteinDistanceWithinLimit } from "../core/shared/levenshtein.js";
import { nowIso } from "../core/shared/time.js";
import { resolveGlobalPmRoot, resolvePmRoot } from "../core/store/paths.js";
import { readSettings, writeSettings } from "../core/store/settings.js";
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
  runGitCommand,
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

const EXTENSION_INSTALL_COPY_ATTEMPTS = 3;
const EXTENSION_INSTALL_LOCK_ATTEMPTS = 120;
const EXTENSION_INSTALL_LOCK_DELAY_MS = 250;
const EXTENSION_INSTALL_LOCK_STALE_MS = 120_000;

interface ExtensionInstallLockOwner {
  pid: number;
  token: string;
  created_at: string;
  destination: string;
}

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
const RETRIABLE_EXTENSION_INSTALL_COPY_CODES = new Set([
  "EEXIST",
  "ENOTEMPTY",
  "ENOENT",
]);
const DEFAULT_EXTENSION_POLICY_DETAILS: PmSettings["extensions"]["policy"] = {
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
  overrides: NonNullable<
    PmSettings["extensions"]["policy"]["extension_overrides"]
  >,
): ExtensionPolicyOverrideDetails[] =>
  overrides
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
  const safePolicy = policy ?? DEFAULT_EXTENSION_POLICY_DETAILS;
  const rootLists = normalizePolicyRootLists(policy);
  const overrides = normalizeExtensionPolicyOverrides(
    safePolicy.extension_overrides ?? [],
  );
  return {
    mode: safePolicy.mode ?? DEFAULT_EXTENSION_POLICY_DETAILS.mode,
    trust_mode:
      safePolicy.trust_mode ?? DEFAULT_EXTENSION_POLICY_DETAILS.trust_mode,
    require_provenance: safePolicy.require_provenance === true,
    trusted_extensions: rootLists.trusted_extensions,
    default_sandbox_profile: safePolicy.default_sandbox_profile ?? "none",
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

/** Return an errno-style code from an unknown failure when one is present. */
const errnoCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;

/** Identify transient copy races that are safe to retry during extension installation. */
const isRetriableExtensionInstallCopyError = (error: unknown): boolean =>
  RETRIABLE_EXTENSION_INSTALL_COPY_CODES.has(String(errnoCode(error)));

/** Test an unknown failure against one expected errno-style code. */
const isErrnoCode = (error: unknown, code: string): boolean =>
  errnoCode(error) === code;

/** Delay an extension filesystem retry without blocking the event loop. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Ensure the installed extension directory carries a `package.json` with `"type": "module"`. Extension entrypoints are ESM TypeScript; without a nearby package.json Node resolves the module type from the HOST project's package.json, so installs into `"type": "commonjs"` projects fail activation with `extension_load_failed` (pm-r0m4). Extensions that ship their own package.json are left untouched. */
async function ensureExtensionModuleTypeMarker(
  destinationDirectory: string,
): Promise<void> {
  const markerPath = path.join(destinationDirectory, "package.json");
  if (await pathExists(markerPath)) {
    return;
  }
  await fs.writeFile(
    markerPath,
    `${JSON.stringify({ type: "module" }, null, 2)}\n`,
    "utf8",
  );
}

/** Implements copy extension directory for install for the public runtime surface of this module. */
export async function copyExtensionDirectoryForInstall(
  sourceDirectory: string,
  destinationDirectory: string,
  copyDirectory: typeof fs.cp = fs.cp,
): Promise<void> {
  for (
    let attempt = 1;
    attempt <= EXTENSION_INSTALL_COPY_ATTEMPTS;
    attempt += 1
  ) {
    try {
      if (await pathExists(destinationDirectory)) {
        await fs.rm(destinationDirectory, { recursive: true, force: true });
      }
      await copyExtensionDirectoryWithoutSelfNesting(
        sourceDirectory,
        destinationDirectory,
        copyDirectory,
      );
      return;
    } catch (error: unknown) {
      if (
        !isRetriableExtensionInstallCopyError(error) ||
        attempt === EXTENSION_INSTALL_COPY_ATTEMPTS
      ) {
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
  temporaryDirectory = os.tmpdir(),
): Promise<void> {
  const resolvedSource = path.resolve(sourceDirectory);
  const resolvedDestination = path.resolve(destinationDirectory);
  const canonicalSource = await fs
    .realpath(resolvedSource)
    .catch(() => resolvedSource);
  const destinationParent = path.dirname(resolvedDestination);
  const destinationRoot = path.parse(destinationParent).root;
  let canonicalDestinationParent = await fs.realpath(destinationRoot);
  const relativeDestinationParent = path.relative(
    destinationRoot,
    destinationParent,
  );
  const destinationSegments =
    relativeDestinationParent === ""
      ? []
      : relativeDestinationParent.split(path.sep);
  for (const [index, segment] of destinationSegments.entries()) {
    const candidate = path.join(canonicalDestinationParent, segment);
    try {
      canonicalDestinationParent = await fs.realpath(candidate);
    } catch {
      canonicalDestinationParent = path.join(
        canonicalDestinationParent,
        ...destinationSegments.slice(index),
      );
      break;
    }
  }
  const canonicalDestination = path.join(
    canonicalDestinationParent,
    path.basename(resolvedDestination),
  );
  if (canonicalSource === canonicalDestination) {
    return;
  }
  if (!isPathWithinDirectory(canonicalSource, canonicalDestination)) {
    await copyDirectory(sourceDirectory, destinationDirectory, {
      recursive: true,
      force: true,
    });
    return;
  }

  const systemTempDirectory = path.resolve(temporaryDirectory);
  const stagingBase = isPathWithinDirectory(
    canonicalSource,
    systemTempDirectory,
  )
    ? path.dirname(canonicalSource)
    : systemTempDirectory;
  if (isPathWithinDirectory(canonicalSource, stagingBase)) {
    throw new PmCliError(
      `Extension source "${sourceDirectory}" contains its install destination and no external staging directory is available. Install a narrower package directory instead.`,
      EXIT_CODE.USAGE,
      { code: "extension_install_source_contains_destination" },
    );
  }
  const stagingRoot = await fs.mkdtemp(
    path.join(stagingBase, "pm-extension-copy-"),
  );
  const stagedDirectory = path.join(stagingRoot, "extension");
  try {
    await copyDirectory(sourceDirectory, stagedDirectory, {
      recursive: true,
      force: true,
    });
    await copyDirectory(stagedDirectory, destinationDirectory, {
      recursive: true,
      force: true,
    });
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

/** Read the unique owner token recorded for one extension scope lock. */
async function readExtensionInstallLockOwnerToken(
  lockPath: string,
): Promise<string | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(lockPath, "owner.json"), "utf8"),
    ) as Record<string, unknown>;
    return typeof parsed.token === "string" && parsed.token.length > 0
      ? parsed.token
      : null;
  } catch {
    return null;
  }
}

/** Remove an extension scope lock only while its persisted owner token still matches. */
async function removeExtensionInstallLockIfOwned(
  lockPath: string,
  ownerToken: string,
): Promise<boolean> {
  const currentOwnerToken = await readExtensionInstallLockOwnerToken(lockPath);
  if (currentOwnerToken !== ownerToken) {
    return false;
  }
  await fs.rm(lockPath, { recursive: true, force: true });
  return true;
}

/** Reclaim an expired extension scope lock when its persisted owner remains unchanged. */
async function reclaimStaleExtensionInstallLock(
  lockPath: string,
  staleMs: number,
): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(lockPath);
  } catch {
    return false;
  }
  if (Date.now() - stat.mtimeMs <= staleMs) {
    return false;
  }
  const staleOwnerToken = await readExtensionInstallLockOwnerToken(lockPath);
  return staleOwnerToken === null
    ? false
    : removeExtensionInstallLockIfOwned(lockPath, staleOwnerToken);
}

/** Start an owner-bound lease heartbeat and return an async stop barrier for final cleanup. */
function startExtensionInstallLockHeartbeat(
  lockPath: string,
  ownerToken: string,
  intervalMs: number,
): () => Promise<void> {
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat
      .then(async () => {
        if (
          (await readExtensionInstallLockOwnerToken(lockPath)) !== ownerToken
        ) {
          return;
        }
        const heartbeatAt = new Date();
        await fs.utimes(lockPath, heartbeatAt, heartbeatAt);
      })
      .catch(() => undefined);
  }, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await heartbeat;
  };
}

async function withExtensionInstallLock<T>(
  settingsRoot: string,
  destinationDirectoryName: string,
  run: () => Promise<T>,
  options?: {
    attempts?: number;
    delay_ms?: number;
    stale_ms?: number;
    heartbeat_ms?: number;
  },
): Promise<T> {
  const lockRoot = path.join(
    settingsRoot,
    "runtime",
    "extension-install-locks",
  );
  const lockPath = path.join(lockRoot, "scope.lock");
  await fs.mkdir(lockRoot, { recursive: true });
  const attempts = Math.max(
    1,
    Math.floor(options?.attempts ?? EXTENSION_INSTALL_LOCK_ATTEMPTS),
  );
  const delayMs = Math.max(
    0,
    Math.floor(options?.delay_ms ?? EXTENSION_INSTALL_LOCK_DELAY_MS),
  );
  const staleMs = Math.max(
    0,
    Math.floor(options?.stale_ms ?? EXTENSION_INSTALL_LOCK_STALE_MS),
  );
  const heartbeatMs = Math.max(
    1,
    Math.floor(options?.heartbeat_ms ?? Math.max(1, staleMs / 3)),
  );

  const owner: ExtensionInstallLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    created_at: nowIso(),
    destination: destinationDirectoryName,
  };
  let acquired = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.mkdir(lockPath);
      try {
        await fs.writeFile(
          path.join(lockPath, "owner.json"),
          `${JSON.stringify(owner, null, 2)}\n`,
          "utf8",
        );
      } catch (error: unknown) {
        await fs.rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      acquired = true;
      break;
    } catch (error: unknown) {
      if (!isErrnoCode(error, "EEXIST")) {
        throw error;
      }
      if (await reclaimStaleExtensionInstallLock(lockPath, staleMs)) {
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

  const stopHeartbeat = startExtensionInstallLockHeartbeat(
    lockPath,
    owner.token,
    heartbeatMs,
  );
  try {
    return await run();
  } finally {
    await stopHeartbeat();
    await removeExtensionInstallLockIfOwned(lockPath, owner.token).catch(
      () => false,
    );
  }
}

async function resolveInstalledExtensionCandidate(
  installed: ManagedExtensionSummary[],
  extensionTarget: string,
): Promise<ManagedExtensionSummary | undefined> {
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
}

function ensureDeactivated(settings: PmSettings, name: string): boolean {
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
}

function clearExtensionState(settings: PmSettings, name: string): boolean {
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
}

function suggestLifecycleActionTarget(
  target: string,
): { action: ExtensionCommandAction; flag: `--${string}` } | null {
  const normalizedTarget = target.trim().toLowerCase();
  const exactMatch = LIFECYCLE_ACTION_TARGETS.find(
    ([candidate]) => candidate === normalizedTarget,
  );
  if (exactMatch) {
    return { action: exactMatch[1], flag: exactMatch[2] };
  }
  const maxDistance = normalizedTarget.length <= 4 ? 1 : 2;
  let nearest: {
    action: ExtensionCommandAction;
    flag: `--${string}`;
    distance: number;
  } | null = null;
  for (const [candidate, action, flag] of LIFECYCLE_ACTION_TARGETS) {
    const distance = levenshteinDistanceWithinLimit(
      normalizedTarget,
      candidate,
      maxDistance,
    );
    if (distance === null) {
      continue;
    }
    if (nearest === null) {
      nearest = { action, flag, distance };
      continue;
    }
    if (distance < nearest.distance) {
      nearest = { action, flag, distance };
    }
  }
  return nearest === null
    ? null
    : { action: nearest.action, flag: nearest.flag };
}

function buildUnknownLifecycleActionError(
  target: string,
  options: ExtensionCommandOptions,
): PmCliError {
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
}

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

/** Map a bare positional token (already trimmed and lower-cased) to the lifecycle action it implies for `pm extension <token>` / `pm package <token>`: the `doctor`/`reload`/`catalog`/`init`/`scaffold`/`explore`/`manage` keywords, with `list` and the empty string both meaning `explore`. Returns `null` for anything else so the caller can raise a did-you-mean error. */
function resolveImplicitActionFromTarget(
  normalizedTarget: string,
): ExtensionCommandAction | null {
  if (normalizedTarget === "doctor") {
    return "doctor";
  }
  if (normalizedTarget === "reload") {
    return "reload";
  }
  if (normalizedTarget === "catalog") {
    return "catalog";
  }
  if (normalizedTarget === "init" || normalizedTarget === "scaffold") {
    return "init";
  }
  if (normalizedTarget === "explore") {
    return "explore";
  }
  if (normalizedTarget === "manage") {
    return "manage";
  }
  if (normalizedTarget === "list" || normalizedTarget === "") {
    return "explore";
  }
  return null;
}

function resolveAction(
  target: string | undefined,
  options: ExtensionCommandOptions,
): ExtensionCommandAction {
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
}

function resolveScope(options: ExtensionCommandOptions): ExtensionScope {
  const projectLike = options.project === true || options.local === true;
  const global = options.global === true;
  if (projectLike && global) {
    throw new PmCliError(
      'Options "--project/--local" and "--global" are mutually exclusive.',
      EXIT_CODE.USAGE,
    );
  }
  return global ? "global" : "project";
}
function resolveUpdateCheckResolution(
  managedEntry: ManagedExtensionRecord | undefined,
): ExtensionUpdateCheckResolution {
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
  const updateError =
    typeof managedEntry.update_error === "string"
      ? managedEntry.update_error.trim()
      : "";
  if (updateError.length > 0) {
    return {
      status: "failed",
      reason: updateError,
    };
  }
  if (
    typeof managedEntry.last_update_check_at === "string" &&
    managedEntry.last_update_check_at.trim().length > 0
  ) {
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

/**
 * Assemble a {@link ManagedExtensionSummary} from a directory's resolved identity
 * (name/version/entry/enabled state) and its managed-state record, projecting the
 * managed-source provenance and the resolved update-check status. Runtime
 * activation fields default to "not yet probed" (`runtime_active: null`,
 * `activation_status: "unknown"`) so a later runtime probe can overlay live state.
 */
function buildInstalledExtensionSummary(
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
): ManagedExtensionSummary {
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
    source: managedEntry?.source,
    update_available: managedEntry?.update_available,
    last_update_check_at: managedEntry?.last_update_check_at,
    last_update_remote_commit: managedEntry?.last_update_remote_commit,
    update_error: managedEntry?.update_error,
    update_check_status: updateCheck.status,
    update_check_reason: updateCheck.reason,
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
    managedByName.set(
      normalizeExtensionNameForMatch(managedEntry.name),
      managedEntry,
    );
    managedByDirectory.set(
      normalizeExtensionNameForMatch(managedEntry.directory),
      managedEntry,
    );
  }

  const warnings: string[] = [];
  const summaries: ManagedExtensionSummary[] = [];
  for (const directoryName of directories) {
    const extensionDirectory = path.join(extensionsRoot, directoryName);
    const manifestPath = path.join(extensionDirectory, "manifest.json");
    if (!(await pathExists(manifestPath))) {
      warnings.push(`extension_manifest_missing:${scope}:${directoryName}`);
      const managedEntry = managedByDirectory.get(
        normalizeExtensionNameForMatch(directoryName),
      );
      summaries.push(
        buildInstalledExtensionSummary(
          {
            name: managedEntry?.name ?? directoryName,
            directory: directoryName,
            version: managedEntry?.manifest_version ?? "unknown",
            entry: managedEntry?.manifest_entry ?? "unknown",
            enabled: managedEntry
              ? isExtensionEnabled(settings, managedEntry.name)
              : false,
          },
          scope,
          managedEntry,
          resolveUpdateCheckResolution(managedEntry),
        ),
      );
      continue;
    }

    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(
        await fs.readFile(manifestPath, "utf8"),
      ) as unknown;
    } catch {
      warnings.push(
        `extension_manifest_invalid_json:${scope}:${directoryName}`,
      );
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
    summaries.push(
      buildInstalledExtensionSummary(
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
    );
  }
  return {
    extensions: summaries.sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    warnings: warnings.sort((left, right) => left.localeCompare(right)),
  };
}
interface GithubUpdateStatus {
  checked_at: string;
  available: boolean | null;
  remote_commit?: string;
  error?: string;
}
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

function summarizeRuntimeCommandPathsForExtension(
  extensionName: string,
  installed: ManagedExtensionSummary[],
): { command_paths: string[]; action_paths: string[] } {
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
}

function resolveCommandDiscoveryPackageName(
  extensionName: string,
  source: ManagedExtensionSource,
): string {
  if (typeof source.package === "string" && source.package.trim().length > 0) {
    return source.package.trim();
  }
  if (
    source.kind === "builtin" &&
    typeof source.name === "string" &&
    source.name.trim().length > 0
  ) {
    return source.name.trim();
  }
  return extensionName;
}

function buildInstallCommandDiscovery(
  extensionName: string,
  source: ManagedExtensionSource,
  commandSummary: { command_paths: string[]; action_paths: string[] },
  activationFailure?: ActivationFailureDiagnostic,
): Record<string, unknown> {
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
}

function summarizeActivationFailureForDiagnostics(
  failure: ActivationFailureEntry,
): ActivationFailureDiagnostic {
  const trace = failure.trace
    ? {
        method: failure.trace.method,
        registration_index: failure.trace.registration_index,
        expected_schema: failure.trace.expected_schema,
        ...(failure.trace.command ? { command: failure.trace.command } : {}),
        ...(failure.trace.capability
          ? { capability: failure.trace.capability }
          : {}),
        ...(failure.trace.missing_capability
          ? { missing_capability: failure.trace.missing_capability }
          : {}),
        ...(failure.trace.hint ? { hint: failure.trace.hint } : {}),
      }
    : undefined;
  return {
    layer: failure.layer,
    name: failure.name,
    entry_path: failure.entry_path,
    error: failure.error,
    ...(failure.trace?.missing_capability
      ? { missing_capability: failure.trace.missing_capability }
      : {}),
    ...(failure.trace?.hint ? { hint: failure.trace.hint } : {}),
    ...(trace ? { trace } : {}),
  };
}

function collectActivationFailureDiagnostics(
  failures: ActivationFailureEntry[],
): ActivationFailureDiagnostic[] {
  return failures
    .map((failure) => summarizeActivationFailureForDiagnostics(failure))
    .sort((left, right) =>
      `${left.layer}:${left.name}`.localeCompare(
        `${right.layer}:${right.name}`,
      ),
    );
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
      entry.scope === scope &&
      normalizeExtensionNameForMatch(entry.name) ===
        normalizeExtensionNameForMatch(extensionName),
  );
  return (
    runtimeInstalledExtension?.activation_status ??
    (installActivationFailure ? "failed" : "unknown")
  );
}

async function probeRuntimeCommandPathsForInstall(
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
}> {
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
    const ref =
      source.ref && source.ref.trim().length > 0 ? source.ref.trim() : "HEAD";
    const output = await gitCommandRunner([
      "ls-remote",
      source.repository,
      ref,
    ]);
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
}

function resolveExtensionRootsForScope(
  scope: ExtensionScope,
  global: GlobalOptions,
): {
  pm_root: string;
  scope: ExtensionScope;
  settings_root: string;
  selected_root: string;
  roots: { global: string; project: string };
} {
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
}

function resolveGithubOption(
  options: ExtensionCommandOptions,
): string | undefined {
  if (
    typeof options.gh === "string" &&
    typeof options.github === "string" &&
    options.gh.trim() !== options.github.trim()
  ) {
    throw new PmCliError(
      'Options "--gh" and "--github" must match when both are provided.',
      EXIT_CODE.USAGE,
    );
  }
  if (typeof options.gh === "string" && options.gh.trim().length > 0) {
    return options.gh.trim();
  }
  if (typeof options.github === "string" && options.github.trim().length > 0) {
    return options.github.trim();
  }
  return undefined;
}

function getLifecycleActionFlag(action: ExtensionCommandAction): `--${string}` {
  return LIFECYCLE_ACTION_FLAGS[action];
}

function requireTarget(
  target: string | undefined,
  action: ExtensionCommandAction,
  options: ExtensionCommandOptions = {},
): string {
  const normalized = target?.trim();
  if (!normalized) {
    if (action === "init") {
      throw new PmCliError(
        'Action "init" requires a scaffold target path (for example: pm package init ./my-package or pm extension init ./my-extension).',
        EXIT_CODE.USAGE,
      );
    }
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
      schemaContributors.add(
        `${entry.layer}:${normalizeExtensionNameForMatch(entry.name)}`,
      );
    }
  }
  for (const entry of activationResult.registrations.item_fields) {
    if (entry.fields.length > 0) {
      schemaContributors.add(
        `${entry.layer}:${normalizeExtensionNameForMatch(entry.name)}`,
      );
    }
  }
  const warnings: string[] = [];
  for (const extension of loadResult.loaded) {
    if ((extension.activation?.commands ?? []).length === 0) {
      continue;
    }
    if (
      schemaContributors.has(
        `${extension.layer}:${normalizeExtensionNameForMatch(extension.name)}`,
      )
    ) {
      warnings.push(
        `extension_schema_narrow_activation:${extension.layer}:${extension.name}`,
      );
    }
  }
  return [...new Set(warnings)].sort((left, right) =>
    left.localeCompare(right),
  );
}

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
function assertExtensionActionOptionScope(
  action: ExtensionCommandAction,
  options: ExtensionCommandOptions,
): void {
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
  for (const guard of guards) {
    if (guard.triggered && !guard.allowed) {
      throw new PmCliError(guard.message, EXIT_CODE.USAGE);
    }
  }
}

/* c8 ignore start -- alias-normalization matrix is covered by resolveAction tests; this only rewrites positional aliases */
/** Collapse a positional target that merely repeats the action keyword (`pm extension doctor`, `reload`, `catalog`, or `init`/`scaffold`) to `undefined` so the action handlers treat it as "no target" rather than an extension name; otherwise the original target is returned unchanged. */
function resolveNormalizedExtensionTarget(
  target: string | undefined,
  action: ExtensionCommandAction,
  options: ExtensionCommandOptions,
): string | undefined {
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
}
/* c8 ignore stop */

/**
 * Entry point for the `pm extension` / `pm package` command surface. Resolves the
 * requested lifecycle action and scope, rejects out-of-scope option usage,
 * normalizes positional aliases, then dispatches to the matching action handler —
 * each of which reads and writes managed-extension state, runtime-probes, and
 * returns the canonical {@link ExtensionCommandResult}. `--doctor` results are
 * flagged for native (non-JSON-wrapped) output.
 */
export async function runExtension(
  target: string | undefined,
  options: ExtensionCommandOptions,
  global: GlobalOptions,
): Promise<ExtensionCommandResult> {
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
  const withResult = (
    details: Record<string, unknown>,
    ok = true,
  ): ExtensionCommandResult => {
    const result: ExtensionCommandResult = {
      ok,
      action,
      scope,
      roots:
        action === "catalog" &&
        typeof options.fields === "string" &&
        options.fields.trim().length > 0
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
      warnings: [...new Set(warnings)].sort((left, right) =>
        left.localeCompare(right),
      ),
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
  const ctx: ExtensionActionContext = {
    action,
    normalizedTarget,
    scope,
    resolvedRoots,
    warnings,
    options,
    global,
    withResult,
  };
  return EXTENSION_ACTION_HANDLERS[action](ctx);
}

async function runExtensionInitAction(
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> {
  const { action, normalizedTarget, options, withResult } = ctx;
  const githubOption = resolveGithubOption(options);
  if (
    githubOption !== undefined ||
    (typeof options.ref === "string" && options.ref.trim().length > 0)
  ) {
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
  const quotedTargetPath = JSON.stringify(scaffold.target_path);
  // Forward-slash the path for the copy-pasteable `cd` hint: Windows cmd.exe /
  // PowerShell reject the doubled backslashes JSON.stringify emits, while both
  // shells (and POSIX) accept forward slashes.
  const quotedShellTargetPath = JSON.stringify(
    scaffold.target_path.replace(/\\/g, "/"),
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
    next_steps: [
      // Extensions are authored AND loaded as TypeScript (ADR pm-2c28 / pm-m1uz):
      // the manifest entry is ./index.ts and pm strips types on load (Node
      // >=22.18), so there is no compile/build step — install dependencies, then
      // install the scaffold directly.
      ...(options.vocabulary === "package"
        ? [
            `Install dependencies: cd ${quotedShellTargetPath}, then run "npm install"`,
          ]
        : [
            `Install type-check dependencies: cd ${quotedShellTargetPath}, then run "npm install -D typescript @types/node @unbrained/pm-cli"`,
          ]),
      ...(options.vocabulary === "package" && options.declarative === true
        ? [
            "Ensure the target workspace can resolve @unbrained/pm-cli before installing this declarative package.",
          ]
        : []),
      `Install the scaffold: ${options.vocabulary === "package" ? "pm install --project" : "pm extension --install --project"} ${quotedTargetPath}`,
      `Smoke-test command path: pm ${scaffold.command_name}`,
      ...(options.vocabulary === "package"
        ? [
            `Validate the package: cd ${quotedShellTargetPath}, then run "npm run typecheck" and "npm test"`,
          ]
        : [
            `Type-check the source (optional): cd ${quotedShellTargetPath}, then run "npx tsc --noEmit"`,
          ]),
      `Run diagnostics: ${options.vocabulary === "package" ? "pm package doctor" : "pm extension --doctor"} --project --detail summary`,
    ],
  });
}

async function runExtensionReloadAction(
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> {
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
}

async function runExtensionCatalogAction(
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> {
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
}

/* c8 ignore start -- source-shape branch combinations are exercised in install-source focused tests */
/** Build the persisted managed-source record for an install from its resolved shape: a bundled builtin alias, a local path, an npm package, or (the default) a GitHub repository, capturing the location/commit/subpath provenance the manage and upgrade flows later read back. */
function buildInstallManagedSource(
  bundledAliasName: string | null,
  bundledPackageName: string | null,
  installSource: ReturnType<typeof parseExtensionInstallSource>,
  resolvedSource: Awaited<ReturnType<typeof resolveInstallSource>>,
): ManagedExtensionSource {
  if (bundledAliasName) {
    return {
      kind: "builtin",
      input: bundledAliasName,
      location: bundledAliasName,
      name: bundledAliasName,
      ...(bundledPackageName === null ? {} : { package: bundledPackageName }),
    };
  }
  if (installSource.kind === "local") {
    return {
      kind: "local",
      input: installSource.input,
      location: installSource.absolute_path,
    };
  }
  if (installSource.kind === "npm") {
    return {
      kind: "npm",
      input: installSource.input,
      location: resolvedSource.resolved_subpath ?? ".",
      package: resolvedSource.npm_package,
      version: resolvedSource.npm_version,
    };
  }
  return {
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
}
/* c8 ignore stop */

/** Run the install body while holding the scope-wide install lock: read settings and managed state, copy the validated extension into the scope root unless it is already installed in place, upsert the managed entry and activation state, scaffold any contributed item-type folders, runtime-probe the freshly installed command paths, and return the install result envelope. */
async function performExtensionInstallUnderLock(
  ctx: ExtensionActionContext,
  input: {
    validated: Awaited<ReturnType<typeof validateExtensionDirectory>>;
    destinationDirectoryName: string;
    bundledAliasName: string | null;
    bundledPackageName: string | null;
    installSource: ReturnType<typeof parseExtensionInstallSource>;
    resolvedSource: Awaited<ReturnType<typeof resolveInstallSource>>;
  },
): Promise<ExtensionCommandResult> {
  const { scope, resolvedRoots, warnings, global, withResult } = ctx;
  const {
    validated,
    destinationDirectoryName,
    bundledAliasName,
    bundledPackageName,
    installSource,
    resolvedSource,
  } = input;
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
  if (!installInPlace) {
    await copyExtensionDirectoryForInstall(
      validated.directory,
      destinationDirectory,
    );
  }
  await ensureExtensionModuleTypeMarker(destinationDirectory);

  const sourceRecord = buildInstallManagedSource(
    bundledAliasName,
    bundledPackageName,
    installSource,
    resolvedSource,
  );

  const now = nowIso();
  const existingManagedEntry = managedStateRead.state.entries.find(
    (entry) =>
      normalizeExtensionNameForMatch(entry.name) ===
      normalizeExtensionNameForMatch(validated.manifest.name),
  );
  const sourceUnchanged =
    existingManagedEntry !== undefined &&
    existingManagedEntry.manifest_version === validated.manifest.version &&
    managedExtensionSourcesEquivalent(
      existingManagedEntry.source,
      sourceRecord,
    );
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
    await writeSettings(
      resolvedRoots.settings_root,
      settings,
      "settings:write",
    );
  }
  const refreshedInstalled = await listInstalledExtensions(
    resolvedRoots.selected_root,
    scope,
    settings,
    managedState,
  );
  warnings.push(...refreshedInstalled.warnings);
  const runtimeProbe = await probeRuntimeCommandPathsForInstall(
    resolvedRoots.pm_root,
    settings,
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
  const installedItemTypeDefinitions = runtimeProbe.item_type_registrations
    .filter(
      (entry) =>
        normalizeExtensionNameForMatch(entry.name) ===
        normalizeExtensionNameForMatch(validated.manifest.name),
    )
    .flatMap((entry) =>
      entry.types.map((type) => ({ name: type.name, folder: type.folder })),
    );
  if (scope === "project" && installedItemTypeDefinitions.length > 0) {
    await ensureTypeFolderScaffold(
      resolvedRoots.pm_root,
      installedItemTypeDefinitions,
      warnings,
      "install:type-folder",
    );
  }
  const commandSummary = summarizeRuntimeCommandPathsForExtension(
    validated.manifest.name,
    runtimeProbe.installed,
  );
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
  const activated =
    !runtimeProbe.extensions_disabled && runtimeActivationStatus === "ok";
  if (!activated) {
    warnings.push(
      `extension_install_activation_failed:${scope}:${validated.manifest.name}:${runtimeActivationStatus}`,
    );
  }
  const verification = {
    status: activated ? "ok" : "degraded",
    target_pm_root: resolvedRoots.pm_root,
    activation_status: runtimeActivationStatus,
    activated,
    registered_commands: commandSummary.command_paths,
    registered_actions: commandSummary.action_paths,
    registered_item_types: installedItemTypeDefinitions,
    health: {
      status: activated ? "ok" : "degraded",
      blocking_failure_count: activated ? 0 : 1,
    },
  };

  return withResult(
    {
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
      activated,
      settings_changed: activationChanged,
      runtime_activation_status: runtimeActivationStatus,
      command_paths: commandSummary.command_paths,
      action_paths: commandSummary.action_paths,
      command_discovery: buildInstallCommandDiscovery(
        validated.manifest.name,
        sourceRecord,
        commandSummary,
        installActivationFailure,
      ),
      verification,
      activation_diagnostics: {
        failed_count: runtimeProbe.activation_failures.length,
        failed: runtimeProbe.activation_failures,
        installed_extension_failed: installActivationFailure ?? null,
      },
    },
    activated,
  );
}

async function runExtensionInstallAction(
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> {
  const {
    action,
    normalizedTarget,
    resolvedRoots,
    warnings,
    options,
    global,
    withResult,
  } = ctx;
  const githubOption = resolveGithubOption(options);
  const explicitSourceInput =
    githubOption ?? requireTarget(normalizedTarget, action, options);
  if (
    typeof githubOption !== "string" &&
    isBundledPackageInstallAllTarget(explicitSourceInput)
  ) {
    if (typeof options.ref === "string" && options.ref.trim().length > 0) {
      throw new PmCliError(
        'Action "install all" does not accept --ref.',
        EXIT_CODE.USAGE,
      );
    }
    const aliases = await listBundledPackageAliases();
    const packages: Array<{ alias: string; result: ExtensionCommandResult }> =
      [];
    for (const alias of aliases) {
      packages.push({
        alias,
        result: await runExtension(
          alias,
          { ...options, install: true },
          global,
        ),
      });
    }
    for (const entry of packages) {
      warnings.push(...entry.result.warnings);
    }
    const installedAll = packages.every((entry) => entry.result.ok);
    return withResult(
      {
        installed_all: installedAll,
        installed_count: packages.filter((entry) => entry.result.ok).length,
        failed_count: packages.filter((entry) => !entry.result.ok).length,
        packages: packages.map((entry) => ({
          alias: entry.alias,
          ok: entry.result.ok,
          extension: (entry.result.details as { extension?: unknown })
            .extension,
          source: (entry.result.details as { source?: unknown }).source,
          destination_path: (
            entry.result.details as { destination_path?: unknown }
          ).destination_path,
          activated: (entry.result.details as { activated?: unknown })
            .activated,
          settings_changed: (
            entry.result.details as { settings_changed?: unknown }
          ).settings_changed,
          command_paths: (entry.result.details as { command_paths?: unknown })
            .command_paths,
          action_paths: (entry.result.details as { action_paths?: unknown })
            .action_paths,
          command_discovery: (
            entry.result.details as { command_discovery?: unknown }
          ).command_discovery,
          verification: (entry.result.details as { verification?: unknown })
            .verification,
          runtime_activation_status: (
            entry.result.details as { runtime_activation_status?: unknown }
          ).runtime_activation_status,
          activation_diagnostics: (
            entry.result.details as { activation_diagnostics?: unknown }
          ).activation_diagnostics,
          warnings: entry.result.warnings,
        })),
      },
      installedAll,
    );
  }
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
    ref: options.ref,
  });
  /* c8 ignore stop */
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
}

async function runExtensionAdoptAllAction(
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> {
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
  const adoptedDetails = adoption.adopted_entries.map((entry) => {
    const refreshedEntry =
      refreshedInstalled.extensions.find(
        (candidate) =>
          normalizeExtensionNameForMatch(candidate.name) ===
            normalizeExtensionNameForMatch(entry.name) &&
          normalizeExtensionNameForMatch(candidate.directory) ===
            normalizeExtensionNameForMatch(entry.directory),
      ) ??
      /* c8 ignore next 3 -- fallback only matters if a manifest renames between adopt and refresh */
      refreshedInstalled.extensions.find(
        (candidate) =>
          normalizeExtensionNameForMatch(candidate.directory) ===
          normalizeExtensionNameForMatch(entry.directory),
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

async function runExtensionAdoptAction(
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> {
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
            throw new PmCliError(
              `Invalid GitHub shorthand "${githubOption}".`,
              EXIT_CODE.USAGE,
            );
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
    update_check_status: refreshedEntry?.update_check_status ?? null,
    update_check_reason: refreshedEntry?.update_check_reason ?? null,
  });
  /* c8 ignore stop */
}

async function resolveRequiredInstalledExtension(ctx: ExtensionActionContext) {
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
}

async function runExtensionUninstallAction(
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> {
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
}

async function runExtensionActivateDeactivateAction(
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> {
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
}

/** Assemble the doctor remediation hints: the triage remediations, vocabulary-aware advice to inspect load failures and activation failures, and a note when a managed-state fix adopted entries. Blank entries are trimmed and the list is de-duplicated. */
function buildDoctorRemediation(
  baseRemediation: string[],
  loadFailureCount: number,
  activationFailureCount: number,
  vocabulary: ExtensionCommandOptions["vocabulary"],
  managedStateFix: AdoptUnmanagedExtensionsResult | null,
  isolationHint: string | null,
): string[] {
  return [
    ...new Set(
      [
        ...baseRemediation,
        ...(isolationHint === null ? [] : [isolationHint]),
        /* c8 ignore start -- vocabulary-specific remediation branches are copy-only variants */
        ...(loadFailureCount > 0
          ? [
              vocabulary === "package"
                ? "Run pm package explore --project and pm package explore --global to inspect load failures."
                : "Run pm extension --explore --project and pm extension --explore --global to inspect load failures.",
            ]
          : []),
        ...(activationFailureCount > 0
          ? [
              vocabulary === "package"
                ? "Review activation failures in pm package doctor --detail deep output."
                : "Review activation failures in pm extension --doctor --detail deep output.",
            ]
          : []),
        /* c8 ignore stop */
        ...(managedStateFix && managedStateFix.adopted_entries.length > 0
          ? [
              `Managed-state fix adopted ${managedStateFix.adopted_entries.length} extension(s).`,
            ]
          : []),
      ]
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

function hasGlobalLayerDiagnostics(
  loadResult: Awaited<ReturnType<typeof loadExtensions>>,
): boolean {
  return (
    loadResult.loaded.some((entry) => entry.layer === "global") ||
    loadResult.failed.some((entry) => entry.layer === "global") ||
    loadResult.warnings.some((warning) => warning.includes(":global:"))
  );
}

function buildDoctorIsolationHint(
  scope: ExtensionScope,
  isolated: boolean,
  vocabulary: ExtensionCommandOptions["vocabulary"],
  loadResult: Awaited<ReturnType<typeof loadExtensions>>,
): string | null {
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
}

interface DoctorIsolationMetadata {
  isolated: boolean;
  global_extensions_included: boolean;
  global_diagnostics_present: boolean;
  rerun_command: string | null;
  pm_global_path_recipe: string | null;
}

/** Build the doctor isolation block shared by summary and details output so the over-the-wire payload stays identical for extension and package vocabulary. */
function buildDoctorIsolationMetadata(
  scope: ExtensionScope,
  isolated: boolean,
  vocabulary: ExtensionCommandOptions["vocabulary"],
  loadResult: Awaited<ReturnType<typeof loadExtensions>>,
): DoctorIsolationMetadata {
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
}

async function runExtensionDoctorAction(
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> {
  const {
    normalizedTarget,
    scope,
    resolvedRoots,
    warnings,
    options,
    global,
    withResult,
  } = ctx;
  if (normalizedTarget && normalizedTarget.trim().length > 0) {
    throw new PmCliError(
      'Action "doctor" does not accept a target argument.',
      EXIT_CODE.USAGE,
    );
  }
  const isolated = options.isolated === true || options.ignoreGlobal === true;
  if (isolated && scope === "global") {
    throw new PmCliError(
      "--isolated and --ignore-global are only valid with project-scope doctor diagnostics.",
      EXIT_CODE.USAGE,
    );
  }
  const detailMode = parseDoctorDetailMode(options.detail);
  const includeTrace = options.trace === true;
  if (includeTrace && detailMode !== "deep") {
    throw new PmCliError(
      "--trace requires --detail deep with --doctor.",
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

async function runExtensionDescribeAction(
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> {
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
}

/* c8 ignore start -- explore/manage action split is validated by dedicated command-action tests */
async function runExtensionExploreManageAction(
  ctx: ExtensionActionContext,
): Promise<ExtensionCommandResult> {
  const {
    action,
    scope,
    resolvedRoots,
    warnings,
    options,
    global,
    withResult,
  } = ctx;
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
    runtimeInstalledExtensions = applyDoctorRuntimeActivationState(
      refreshedInstalled.extensions,
      loadResult,
      activationResult,
    );
    runtimeActivationFailures = collectActivationFailureDiagnostics(
      activationResult.failed,
    );
    runtimeProbeSummary = {
      requested: true,
      executed: true,
      reason:
        action === "explore"
          ? "explore_defaults_to_runtime_probe"
          : "runtime_probe_requested",
      load_failure_count: loadResult.failed.length,
      activation_failure_count: activationResult.failed.length,
      warning_count: [
        ...new Set([...loadResult.warnings, ...activationResult.warnings]),
      ].length,
      policy: loadResult.policy,
    };
  } else if (action === "manage") {
    runtimeProbeSummary = {
      requested: false,
      executed: false,
    };
  }

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
            adopted_extensions: managedStateFix.adopted_entries.map(
              (entry) => entry.name,
            ),
            already_managed_count: managedStateFix.already_managed_count,
          }
        : {
            requested: false,
            applied: false,
            adopted_count: 0,
            adopted_extensions: [],
            already_managed_count: runtimeInstalledExtensions.filter(
              (entry) => entry.managed,
            ).length,
          };
  }
  return withResult(details);
}
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

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
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
