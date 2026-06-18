/**
 * @module cli/commands/extension/doctor
 *
 * Implements extension package-management support for Doctor.
 */
import { activateExtensions, loadExtensions } from "../../../core/extensions/index.js";
import {
  EXTENSION_CAPABILITY_CONTRACT,
  KNOWN_EXTENSION_CAPABILITIES,
  parseLegacyExtensionCapabilityAliasWarning,
  parseUnknownExtensionCapabilityWarning,
  type UnknownExtensionCapabilityWarningDetails,
} from "../../../core/extensions/loader.js";
import { EXIT_CODE } from "../../../core/shared/constants.js";
import { PmCliError } from "../../../core/shared/errors.js";
import { normalizeExtensionNameForMatch } from "./shared.js";
import type {
  ExtensionCollisionPlan,
  ExtensionCommandOptions,
  ExtensionDoctorDetailMode,
  ExtensionScope,
  ExtensionTriageSummary,
  ExtensionUpdateCheckStatus,
  ManagedExtensionSummary,
} from "../extension.js";

/**
 * Implements apply doctor runtime activation state for the public runtime surface of this module.
 */
export function applyDoctorRuntimeActivationState(
  extensions: ManagedExtensionSummary[],
  loadResult: Awaited<ReturnType<typeof loadExtensions>>,
  activationResult: Awaited<ReturnType<typeof activateExtensions>>,
): ManagedExtensionSummary[] {
  const loadedNames = new Set(loadResult.loaded.map((entry) => normalizeExtensionNameForMatch(entry.name)));
  const loadFailedNames = new Set(loadResult.failed.map((entry) => normalizeExtensionNameForMatch(entry.name)));
  const activationFailedNames = new Set(activationResult.failed.map((entry) => normalizeExtensionNameForMatch(entry.name)));
  const commandPathsByExtension = new Map<string, Set<string>>();
  const actionPathsByExtension = new Map<string, Set<string>>();

  const addCommandPath = (extensionName: string, commandPath: string): void => {
    const normalizedName = normalizeExtensionNameForMatch(extensionName);
    const normalizedCommandPath = commandPath.trim();
    if (normalizedName.length === 0 || normalizedCommandPath.length === 0) {
      return;
    }
    const existing = commandPathsByExtension.get(normalizedName) ?? new Set<string>();
    existing.add(normalizedCommandPath);
    commandPathsByExtension.set(normalizedName, existing);
  };

  const addActionPath = (extensionName: string, actionPath: string): void => {
    const normalizedName = normalizeExtensionNameForMatch(extensionName);
    const normalizedActionPath = actionPath.trim();
    if (normalizedName.length === 0 || normalizedActionPath.length === 0) {
      return;
    }
    const existing = actionPathsByExtension.get(normalizedName) ?? new Set<string>();
    existing.add(normalizedActionPath);
    actionPathsByExtension.set(normalizedName, existing);
  };

  for (const registration of activationResult.registrations.commands) {
    addCommandPath(registration.name, registration.command);
    addActionPath(registration.name, registration.action);
  }
  for (const handler of activationResult.commands.handlers) {
    addCommandPath(handler.name, handler.command);
  }
  for (const override of activationResult.commands.overrides) {
    addCommandPath(override.name, override.command);
  }

  const sortedPaths = (values: Set<string> | undefined): string[] | undefined => {
    if (!values || values.size === 0) {
      return undefined;
    }
    return [...values].sort((left, right) => left.localeCompare(right));
  };

  return extensions.map((entry) => {
    const normalizedName = normalizeExtensionNameForMatch(entry.name);
    const commandPaths = sortedPaths(commandPathsByExtension.get(normalizedName));
    const actionPaths = sortedPaths(actionPathsByExtension.get(normalizedName));
    const runtimeMetadata = {
      ...(commandPaths ? { command_paths: commandPaths } : {}),
      ...(actionPaths ? { action_paths: actionPaths } : {}),
    };

    if (!entry.enabled) {
      return {
        ...entry,
        runtime_active: false,
        activation_status: "not_loaded",
        ...runtimeMetadata,
      };
    }

    if (loadFailedNames.has(normalizedName) || activationFailedNames.has(normalizedName)) {
      return {
        ...entry,
        runtime_active: false,
        activation_status: "failed",
        ...runtimeMetadata,
      };
    }

    if (loadedNames.has(normalizedName)) {
      return {
        ...entry,
        runtime_active: true,
        activation_status: "ok",
        ...runtimeMetadata,
      };
    }

    return {
      ...entry,
      runtime_active: false,
      activation_status: "not_loaded",
      ...runtimeMetadata,
    };
  });
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

function lifecycleFlagCommand(options: ExtensionCommandOptions, action: string): string {
  return options.vocabulary === "package" ? `pm package --${action}` : `pm extension --${action}`;
}

const REGISTRATION_COLLISION_WARNING_CODES = new Set([
  "extension_command_handler_collision",
  "extension_command_override_collision",
  "extension_command_override_handler_overlap",
  "extension_parser_override_collision",
  "extension_preflight_override_collision",
  "extension_renderer_collision",
  "extension_service_override_collision",
]);

/**
 * Implements check whether registration collision warning for the public runtime surface of this module.
 */
export function isRegistrationCollisionWarning(warning: string): boolean {
  return REGISTRATION_COLLISION_WARNING_CODES.has(warningCode(warning));
}

function isExtensionLayer(value: string | undefined): value is "project" | "global" {
  return value === "project" || value === "global";
}

interface RegistrationCollisionWarningParts {
  code: string;
  surface: string;
  winner: { layer: "project" | "global"; name: string };
  displaced: { layer: "project" | "global"; name: string };
}

function parseRegistrationCollisionWarning(warning: string): RegistrationCollisionWarningParts | null {
  const parts = warning.split(":");
  const code = parts[0];
  if (!code || !REGISTRATION_COLLISION_WARNING_CODES.has(code)) {
    return null;
  }
  // Collision warnings end with winnerLayer:winnerName:displacedLayer:displacedName.
  // Surface identifiers before that suffix may contain colons, so parse from the right.
  const winnerLayer = parts.at(-4);
  const winnerName = parts.at(-3)?.trim();
  const displacedLayer = parts.at(-2);
  const displacedName = parts.at(-1)?.trim();
  if (
    !isExtensionLayer(winnerLayer) ||
    !isExtensionLayer(displacedLayer) ||
    !winnerName ||
    !displacedName
  ) {
    return null;
  }
  return {
    code,
    surface: parts.slice(1, -4).join(":") || "global",
    winner: { layer: winnerLayer, name: winnerName },
    displaced: { layer: displacedLayer, name: displacedName },
  };
}

function collectRegistrationCollisionExtensionNames(warnings: string[]): string[] {
  const names = new Set<string>();
  for (const warning of warnings) {
    const parsed = parseRegistrationCollisionWarning(warning);
    if (!parsed) {
      continue;
    }
    names.add(parsed.winner.name);
    names.add(parsed.displaced.name);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

/**
 * Implements build registration collision remediation for the public runtime surface of this module.
 */
export function buildRegistrationCollisionRemediation(
  warnings: string[],
  commands: { deactivate: string; doctor: string },
): string | null {
  const registrationCollisionWarnings = warnings.filter(isRegistrationCollisionWarning);
  if (registrationCollisionWarnings.length === 0) {
    return null;
  }
  const collisionNames = collectRegistrationCollisionExtensionNames(registrationCollisionWarnings);
  const collisionNameText = collisionNames.length > 0 ? ` Conflicting extensions: ${collisionNames.join(", ")}.` : "";
  return (
    `Extension registration collisions or handler/override overlaps detected.${collisionNameText} Single-winner surfaces can hide earlier package behavior. ` +
    `Deactivate one conflicting package with ${commands.deactivate}, ` +
    `or scope registration surfaces in extensions.policy.extension_overrides, then rerun ${commands.doctor}.`
  );
}

function buildRegistrationCollisionPlan(
  scope: ExtensionScope,
  warnings: string[],
  extensions: ManagedExtensionSummary[],
  options: ExtensionCommandOptions,
): ExtensionCollisionPlan | undefined {
  const collisions = warnings
    .map((warning) => parseRegistrationCollisionWarning(warning))
    .filter((entry): entry is RegistrationCollisionWarningParts => entry !== null)
    .sort((left, right) =>
      `${left.code}:${left.surface}:${left.winner.name}:${left.displaced.name}`.localeCompare(
        `${right.code}:${right.surface}:${right.winner.name}:${right.displaced.name}`,
      ),
    );
  if (collisions.length === 0) {
    return undefined;
  }
  const scopeFlag = scope === "global" ? "--global" : "--project";
  const deactivatePrefix = lifecycleFlagCommand(options, "deactivate");
  const doctorCommand = `${lifecycleFlagCommand(options, "doctor")} ${scopeFlag} --detail deep --trace`;
  const extensionByName = new Map(extensions.map((entry) => [normalizeExtensionNameForMatch(entry.name), entry]));
  const affectedByName = new Map<string, number>();
  for (const collision of collisions) {
    for (const name of [collision.winner.name, collision.displaced.name]) {
      const normalizedName = normalizeExtensionNameForMatch(name);
      affectedByName.set(normalizedName, (affectedByName.get(normalizedName) ?? 0) + 1);
    }
  }
  const remediationCandidates = [...affectedByName.entries()]
    .map(([normalizedName, affectedCollisions]) => {
      const extension = extensionByName.get(normalizedName);
      const extensionName = extension?.name ?? normalizedName;
      const commandPaths = extension?.command_paths ?? [];
      const actionPaths = extension?.action_paths ?? [];
      return {
        action: "deactivate" as const,
        extension: extensionName,
        command: `${deactivatePrefix} ${extensionName} ${scopeFlag}`,
        affected_collisions: affectedCollisions,
        feature_loss: {
          command_paths: [...commandPaths].sort((left, right) => left.localeCompare(right)),
          action_paths: [...actionPaths].sort((left, right) => left.localeCompare(right)),
        },
      };
    })
    .sort((left, right) => {
      const affectedDelta = right.affected_collisions - left.affected_collisions;
      if (affectedDelta !== 0) {
        return affectedDelta;
      }
      const leftSurfaceCount = left.feature_loss.command_paths.length + left.feature_loss.action_paths.length;
      const rightSurfaceCount = right.feature_loss.command_paths.length + right.feature_loss.action_paths.length;
      if (leftSurfaceCount !== rightSurfaceCount) {
        return leftSurfaceCount - rightSurfaceCount;
      }
      return left.extension.localeCompare(right.extension);
    });

  return {
    status: "conflicts_detected",
    collision_count: collisions.length,
    extension_count: affectedByName.size,
    next_best_command: doctorCommand,
    collisions,
    remediation_candidates: remediationCandidates,
  };
}

/**
 * Implements classify doctor load failure warnings for the public runtime surface of this module.
 */
export function classifyDoctorLoadFailureWarnings(loadFailures: Array<{ name: string; error: string }>): string[] {
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

/**
 * Implements classify doctor activation failure warnings for the public runtime surface of this module.
 */
export function classifyDoctorActivationFailureWarnings(
  activationFailures: Array<{ name: string; trace?: { missing_capability?: string; capability?: string } }> = [],
): string[] {
  const failures = Array.isArray(activationFailures) ? activationFailures : [];
  const warnings: string[] = [];
  for (const failure of failures) {
    if (!failure || typeof failure.name !== "string") {
      continue;
    }
    const missingCapability = failure.trace?.missing_capability ?? failure.trace?.capability;
    if (typeof missingCapability === "string" && missingCapability.trim().length > 0) {
      warnings.push(`extension_capability_missing:${failure.name}:${missingCapability.trim().toLowerCase()}`);
    }
  }
  return [...new Set(warnings)].sort((left, right) => left.localeCompare(right));
}

/**
 * Implements build extension triage summary for the public runtime surface of this module.
 */
export function buildExtensionTriageSummary(
  scope: ExtensionScope,
  warnings: string[],
  extensions: ManagedExtensionSummary[],
  options: ExtensionCommandOptions = {},
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
    const registrationCollisionRemediation = buildRegistrationCollisionRemediation(normalizedWarnings, {
      deactivate: `${lifecycleFlagCommand(options, "deactivate")} <name> ${scopeFlag}`,
      doctor: `${lifecycleFlagCommand(options, "doctor")} ${scopeFlag} --detail deep --trace`,
    });
    if (registrationCollisionRemediation) {
      remediation.push(registrationCollisionRemediation);
    }
    if (normalizedWarnings.some((warning) => warning.startsWith("extension_manifest_"))) {
      remediation.push(`Run ${lifecycleFlagCommand(options, "explore")} ${scopeFlag} to inspect discovered manifests and directories.`);
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
    if (normalizedWarnings.some((warning) => warning.startsWith("extension_capability_missing:"))) {
      remediation.push(
        `Extension activation failed because code registered a surface missing from manifest capabilities. ` +
          `Run ${lifecycleFlagCommand(options, "doctor")} ${scopeFlag} --detail deep --trace and add the reported missing_capability to manifest.json before publishing.`,
      );
    }
    if (normalizedWarnings.some((warning) => warning.startsWith("extension_command_definition_legacy_handler_alias:"))) {
      remediation.push(
        "Extension command definitions using legacy handler were auto-remapped. " +
          "Update command definitions to use run: (context) => ... for forward compatibility.",
      );
    }
    if (
      normalizedWarnings.some(
        (warning) =>
          warning.startsWith("extension_output_service_override_global:") ||
          warning.startsWith("extension_output_renderer_override_global:"),
      )
    ) {
      remediation.push(
        "Global output service/renderer overrides are active. For output_format, return context.payload/null/undefined unless the extension owns the command. For renderers, return null for unrelated payloads so pm falls back to native rendering.",
      );
    }
    if (normalizedWarnings.some((warning) => warning.startsWith("extension_load_failed_sdk_dependency_missing:"))) {
      remediation.push(
        `Detected extension load failures caused by missing SDK dependency resolution. ` +
          `Ensure extension package dependencies include "@unbrained/pm-cli" and reinstall dependencies before running ${lifecycleFlagCommand(options, "doctor")} ${scopeFlag}.`,
      );
    }
    if (normalizedWarnings.some((warning) => warning.startsWith("extension_load_failed_module_mode_mismatch:"))) {
      remediation.push(
        `Detected extension module-mode mismatches. For ESM-based extension entries/imports, set package.json "type": "module" ` +
          `or use an explicit .mjs entry and rerun ${lifecycleFlagCommand(options, "doctor")} ${scopeFlag}.`,
      );
    }
    if (
      normalizedWarnings.some(
        (warning) =>
          warning.startsWith("extension_pm_min_version_") || warning.startsWith("extension_pm_max_version_"),
      )
    ) {
      remediation.push(
        "Extension pm version-bound warnings detected. Align each package manifest's pm_min_version/pm_max_version " +
          `with the installed pm CLI version (see the warning's required/allowed=...:current=... details), or upgrade/downgrade the pm CLI to satisfy the declared bounds, then rerun ${lifecycleFlagCommand(options, "doctor")} ${scopeFlag}.`,
      );
    }
    if (updateCheckFailedTotal > 0) {
      remediation.push(`Run ${lifecycleFlagCommand(options, "manage")} ${scopeFlag} after validating network and repository access.`);
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
  const collisionPlan = buildRegistrationCollisionPlan(scope, normalizedWarnings, extensions, options);
  if (updateHealthPartial) {
    remediation.push(
      `Update-check coverage is partial because unmanaged extensions need adoption. Adopt existing installs via ${lifecycleFlagCommand(options, "manage")} ${scopeFlag} --fix-managed-state (or ${lifecycleFlagCommand(options, "adopt-all")} ${scopeFlag}, ${lifecycleFlagCommand(options, "adopt")} <name> ${scopeFlag}, or reinstall via ${lifecycleFlagCommand(options, "install")} ${scopeFlag} <source>).`,
    );
  } else if (skippedUnmanagedTotal > 0) {
    remediation.push(
      `Loaded unmanaged extensions are currently treated as informational. Use ${lifecycleFlagCommand(options, "manage")} ${scopeFlag} --fix-managed-state to adopt them for update checks.`,
    );
  }
  if (skippedNonGithubTotal > 0) {
    remediation.push(`Non-GitHub managed extensions are skipped by update checks. Use doctor output for non-update diagnostics.`);
  }
  if (updateAvailableTotal > 0) {
    remediation.push(`Update available managed extensions via ${lifecycleFlagCommand(options, "install")} ${scopeFlag} <source>.`);
  }
  if (remediation.length === 0) {
    remediation.push(`No immediate action required. Re-run ${lifecycleFlagCommand(options, "manage")} ${scopeFlag} after extension changes.`);
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
    ...(collisionPlan ? { collision_plan: collisionPlan } : {}),
  };
}

/**
 * Implements parse doctor detail mode for the public runtime surface of this module.
 */
export function parseDoctorDetailMode(raw: string | undefined): ExtensionDoctorDetailMode {
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

/**
 * Implements collect unknown capability guidance for the public runtime surface of this module.
 */
export function collectUnknownCapabilityGuidance(warnings: string[]): UnknownExtensionCapabilityWarningDetails[] {
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

/**
 * Implements build capability contract metadata for the public runtime surface of this module.
 */
export function buildCapabilityContractMetadata(): {
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

/**
 * Implements build doctor consistency summary for the public runtime surface of this module.
 */
export function buildDoctorConsistencySummary(
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
