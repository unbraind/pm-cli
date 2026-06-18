/**
 * @module core/extensions/extension-policy
 *
 * Implements extension runtime contracts and governance for Extension Policy.
 */
import {
  KNOWN_EXTENSION_POLICY_MODES,
  KNOWN_EXTENSION_POLICY_SURFACES,
  KNOWN_EXTENSION_SANDBOX_PROFILES,
  KNOWN_EXTENSION_TRUST_MODES,
  KNOWN_PM_MAX_VERSION_EXCEEDED_MODES,
  type ExtensionCapability,
  type ExtensionGovernancePolicy,
  type ExtensionLayer,
  type ExtensionPolicyMode,
  type ExtensionPolicyOverride,
  type ExtensionPolicySurface,
  type ExtensionSandboxProfile,
  type ExtensionTrustMode,
  type PmMaxVersionExceededMode,
  type PmMaxVersionExceededModeSetting,
} from "./extension-types.js";
import { isKnownExtensionCapability } from "./extension-capability-aliases.js";
import { normalizeCommandName } from "./extension-runtime-helpers.js";
import type { PmSettings } from "../../types/index.js";

interface NormalizedExtensionPolicyOverride {
  name: string;
  disabled: boolean;
  requireTrusted: boolean;
  requireProvenance: boolean;
  sandboxProfile?: ExtensionSandboxProfile;
  allowedCapabilities: Set<string>;
  blockedCapabilities: Set<string>;
  allowedSurfaces: Set<string>;
  blockedSurfaces: Set<string>;
  allowedCommands: Set<string>;
  blockedCommands: Set<string>;
  allowedActions: Set<string>;
  blockedActions: Set<string>;
  allowedServices: Set<string>;
  blockedServices: Set<string>;
}

/** Concrete per-layer resolution of `pm_max_version_exceeded_mode` (default: block). */
export interface NormalizedPmMaxVersionExceededMode {
  global: PmMaxVersionExceededMode;
  project: PmMaxVersionExceededMode;
}

/**
 * Documents the normalized extension policy payload exchanged by command, SDK, and package integrations.
 */
export interface NormalizedExtensionPolicy {
  mode: ExtensionPolicyMode;
  trustMode: ExtensionTrustMode;
  pmMaxVersionExceededMode: NormalizedPmMaxVersionExceededMode;
  requireProvenance: boolean;
  trustedExtensions: Set<string>;
  defaultSandboxProfile: ExtensionSandboxProfile;
  allowedExtensions: Set<string>;
  blockedExtensions: Set<string>;
  allowedCapabilities: Set<string>;
  blockedCapabilities: Set<string>;
  allowedSurfaces: Set<string>;
  blockedSurfaces: Set<string>;
  allowedCommands: Set<string>;
  blockedCommands: Set<string>;
  allowedActions: Set<string>;
  blockedActions: Set<string>;
  allowedServices: Set<string>;
  blockedServices: Set<string>;
  overridesByName: Map<string, NormalizedExtensionPolicyOverride>;
  warnings: string[];
}

/**
 * Documents the policy extension ref payload exchanged by command, SDK, and package integrations.
 */
export interface PolicyExtensionRef {
  layer: ExtensionLayer;
  name: string;
  trusted?: boolean;
  provenanceVerified?: boolean;
  sandboxProfile?: ExtensionSandboxProfile;
  permissions?: Record<string, boolean | undefined>;
}

function normalizePolicyName(value: string | undefined): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function normalizePolicyStringSet(values: readonly string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );
}

function normalizePolicySurfaceToken(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return "";
  }
  const segments = normalized
    .split(/[.:/]/)
    .map((segment) => segment.replace(/[\s_-]+/g, ""))
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return "";
  }
  if (segments.length === 1) {
    return segments[0];
  }
  return `${segments[0]}.${segments.slice(1).join("")}`;
}

function normalizePolicySurfaceSet(values: readonly string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map((value) => normalizePolicySurfaceToken(value))
      .filter((value) => value.length > 0),
  );
}

function normalizePolicyMode(value: string | undefined): ExtensionPolicyMode {
  const normalized = normalizePolicyName(value);
  if ((KNOWN_EXTENSION_POLICY_MODES as readonly string[]).includes(normalized)) {
    return normalized as ExtensionPolicyMode;
  }
  return "off";
}

function normalizePolicyTrustMode(value: string | undefined): ExtensionTrustMode {
  const normalized = normalizePolicyName(value);
  if ((KNOWN_EXTENSION_TRUST_MODES as readonly string[]).includes(normalized)) {
    return normalized as ExtensionTrustMode;
  }
  return "off";
}

/**
 * Implements normalize policy sandbox profile for the public runtime surface of this module.
 */
export function normalizePolicySandboxProfile(value: string | undefined): ExtensionSandboxProfile {
  const normalized = normalizePolicyName(value);
  if ((KNOWN_EXTENSION_SANDBOX_PROFILES as readonly string[]).includes(normalized)) {
    return normalized as ExtensionSandboxProfile;
  }
  return "none";
}

function normalizePmMaxVersionExceededModeValue(value: unknown): PmMaxVersionExceededMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return (KNOWN_PM_MAX_VERSION_EXCEEDED_MODES as readonly string[]).includes(normalized)
    ? (normalized as PmMaxVersionExceededMode)
    : undefined;
}

/**
 * Resolve `extensions.policy.pm_max_version_exceeded_mode` to a concrete
 * per-layer mode map. Accepts a single mode string (applied to both layers) or
 * a `{ global?, project? }` override map; anything unset or unknown defaults to
 * the safe `"block"`.
 */
export function normalizePmMaxVersionExceededMode(
  value: PmMaxVersionExceededModeSetting | undefined,
): NormalizedPmMaxVersionExceededMode {
  if (typeof value === "string") {
    const mode = normalizePmMaxVersionExceededModeValue(value) ?? "block";
    return { global: mode, project: mode };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return {
      global: normalizePmMaxVersionExceededModeValue(value.global) ?? "block",
      project: normalizePmMaxVersionExceededModeValue(value.project) ?? "block",
    };
  }
  return { global: "block", project: "block" };
}

function serializePmMaxVersionExceededMode(
  mode: NormalizedPmMaxVersionExceededMode,
): PmMaxVersionExceededModeSetting {
  return mode.global === mode.project ? mode.global : { global: mode.global, project: mode.project };
}

function toSortedList(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function buildExtensionPolicyOverride(
  rawOverride: ExtensionPolicyOverride,
): { name: string; normalized: NormalizedExtensionPolicyOverride } | null {
  const name = normalizePolicyName(rawOverride.name);
  if (name.length === 0) {
    return null;
  }
  return {
    name,
    normalized: {
      name,
      disabled: rawOverride.disabled === true,
      requireTrusted: rawOverride.require_trusted === true,
      requireProvenance: rawOverride.require_provenance === true,
      sandboxProfile:
        rawOverride.sandbox_profile !== undefined
          ? normalizePolicySandboxProfile(rawOverride.sandbox_profile)
          : undefined,
      allowedCapabilities: normalizePolicyStringSet(rawOverride.allowed_capabilities),
      blockedCapabilities: normalizePolicyStringSet(rawOverride.blocked_capabilities),
      allowedSurfaces: normalizePolicySurfaceSet(rawOverride.allowed_surfaces),
      blockedSurfaces: normalizePolicySurfaceSet(rawOverride.blocked_surfaces),
      allowedCommands: normalizePolicyStringSet(rawOverride.allowed_commands),
      blockedCommands: normalizePolicyStringSet(rawOverride.blocked_commands),
      allowedActions: normalizePolicyStringSet(rawOverride.allowed_actions),
      blockedActions: normalizePolicyStringSet(rawOverride.blocked_actions),
      allowedServices: normalizePolicyStringSet(rawOverride.allowed_services),
      blockedServices: normalizePolicyStringSet(rawOverride.blocked_services),
    },
  };
}

function collectExtensionPolicyOverrides(
  rawOverrides: readonly ExtensionPolicyOverride[] | undefined,
): Map<string, NormalizedExtensionPolicyOverride> {
  const overridesByName = new Map<string, NormalizedExtensionPolicyOverride>();
  for (const rawOverride of rawOverrides ?? []) {
    const built = buildExtensionPolicyOverride(rawOverride);
    if (built) {
      overridesByName.set(built.name, built.normalized);
    }
  }
  return overridesByName;
}

/**
 * Implements normalize extension policy for the public runtime surface of this module.
 */
export function normalizeExtensionPolicy(settings: PmSettings): NormalizedExtensionPolicy {
  const policy = settings.extensions.policy as ExtensionGovernancePolicy | undefined;
  const mode = normalizePolicyMode(policy?.mode);
  const trustMode = normalizePolicyTrustMode(policy?.trust_mode);
  const pmMaxVersionExceededMode = normalizePmMaxVersionExceededMode(policy?.pm_max_version_exceeded_mode);
  const requireProvenance = policy?.require_provenance === true;
  const trustedExtensions = normalizePolicyStringSet(policy?.trusted_extensions);
  const defaultSandboxProfile = normalizePolicySandboxProfile(policy?.default_sandbox_profile);
  const allowedExtensions = normalizePolicyStringSet(policy?.allowed_extensions);
  const blockedExtensions = normalizePolicyStringSet(policy?.blocked_extensions);
  const allowedCapabilities = normalizePolicyStringSet(policy?.allowed_capabilities);
  const blockedCapabilities = normalizePolicyStringSet(policy?.blocked_capabilities);
  const allowedSurfaces = normalizePolicySurfaceSet(policy?.allowed_surfaces);
  const blockedSurfaces = normalizePolicySurfaceSet(policy?.blocked_surfaces);
  const allowedCommands = normalizePolicyStringSet(policy?.allowed_commands);
  const blockedCommands = normalizePolicyStringSet(policy?.blocked_commands);
  const allowedActions = normalizePolicyStringSet(policy?.allowed_actions);
  const blockedActions = normalizePolicyStringSet(policy?.blocked_actions);
  const allowedServices = normalizePolicyStringSet(policy?.allowed_services);
  const blockedServices = normalizePolicyStringSet(policy?.blocked_services);
  const overridesByName = collectExtensionPolicyOverrides(policy?.extension_overrides);

  const warnings: string[] = [];
  for (const capability of toSortedList([...allowedCapabilities, ...blockedCapabilities])) {
    if (!isKnownExtensionCapability(capability)) {
      warnings.push(`extension_policy_unknown_capability:${capability}`);
    }
  }
  for (const override of [...overridesByName.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    for (const capability of toSortedList([...override.allowedCapabilities, ...override.blockedCapabilities])) {
      if (!isKnownExtensionCapability(capability)) {
        warnings.push(`extension_policy_unknown_capability:${override.name}:${capability}`);
      }
    }
  }
  const knownSurfaces = new Set<string>(KNOWN_EXTENSION_POLICY_SURFACES);
  for (const surface of toSortedList([...allowedSurfaces, ...blockedSurfaces])) {
    if (!knownSurfaces.has(surface)) {
      warnings.push(`extension_policy_unknown_surface:${surface}`);
    }
  }
  for (const override of [...overridesByName.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    for (const surface of toSortedList([...override.allowedSurfaces, ...override.blockedSurfaces])) {
      if (!knownSurfaces.has(surface)) {
        warnings.push(`extension_policy_unknown_surface:${override.name}:${surface}`);
      }
    }
  }

  return {
    mode,
    trustMode,
    pmMaxVersionExceededMode,
    requireProvenance,
    trustedExtensions,
    defaultSandboxProfile,
    allowedExtensions,
    blockedExtensions,
    allowedCapabilities,
    blockedCapabilities,
    allowedSurfaces,
    blockedSurfaces,
    allowedCommands,
    blockedCommands,
    allowedActions,
    blockedActions,
    allowedServices,
    blockedServices,
    overridesByName,
    warnings: [...new Set(warnings)].sort((left, right) => left.localeCompare(right)),
  };
}

/**
 * Implements serialize extension policy for the public runtime surface of this module.
 */
export function serializeExtensionPolicy(policy: NormalizedExtensionPolicy): ExtensionGovernancePolicy {
  const overrides = [...policy.overridesByName.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((override) => ({
      name: override.name,
      ...(override.disabled ? { disabled: true } : {}),
      ...(override.requireTrusted ? { require_trusted: true } : {}),
      ...(override.requireProvenance ? { require_provenance: true } : {}),
      ...(override.sandboxProfile ? { sandbox_profile: override.sandboxProfile } : {}),
      ...(override.allowedCapabilities.size > 0 ? { allowed_capabilities: toSortedList(override.allowedCapabilities) } : {}),
      ...(override.blockedCapabilities.size > 0 ? { blocked_capabilities: toSortedList(override.blockedCapabilities) } : {}),
      ...(override.allowedSurfaces.size > 0 ? { allowed_surfaces: toSortedList(override.allowedSurfaces) } : {}),
      ...(override.blockedSurfaces.size > 0 ? { blocked_surfaces: toSortedList(override.blockedSurfaces) } : {}),
      ...(override.allowedCommands.size > 0 ? { allowed_commands: toSortedList(override.allowedCommands) } : {}),
      ...(override.blockedCommands.size > 0 ? { blocked_commands: toSortedList(override.blockedCommands) } : {}),
      ...(override.allowedActions.size > 0 ? { allowed_actions: toSortedList(override.allowedActions) } : {}),
      ...(override.blockedActions.size > 0 ? { blocked_actions: toSortedList(override.blockedActions) } : {}),
      ...(override.allowedServices.size > 0 ? { allowed_services: toSortedList(override.allowedServices) } : {}),
      ...(override.blockedServices.size > 0 ? { blocked_services: toSortedList(override.blockedServices) } : {}),
    }));
  return {
    mode: policy.mode,
    trust_mode: policy.trustMode,
    pm_max_version_exceeded_mode: serializePmMaxVersionExceededMode(policy.pmMaxVersionExceededMode),
    require_provenance: policy.requireProvenance,
    trusted_extensions: toSortedList(policy.trustedExtensions),
    default_sandbox_profile: policy.defaultSandboxProfile,
    allowed_extensions: toSortedList(policy.allowedExtensions),
    blocked_extensions: toSortedList(policy.blockedExtensions),
    allowed_capabilities: toSortedList(policy.allowedCapabilities),
    blocked_capabilities: toSortedList(policy.blockedCapabilities),
    allowed_surfaces: toSortedList(policy.allowedSurfaces),
    blocked_surfaces: toSortedList(policy.blockedSurfaces),
    allowed_commands: toSortedList(policy.allowedCommands),
    blocked_commands: toSortedList(policy.blockedCommands),
    allowed_actions: toSortedList(policy.allowedActions),
    blocked_actions: toSortedList(policy.blockedActions),
    allowed_services: toSortedList(policy.allowedServices),
    blocked_services: toSortedList(policy.blockedServices),
    extension_overrides: overrides,
  };
}

/**
 * Implements hydrate extension policy for the public runtime surface of this module.
 */
export function hydrateExtensionPolicy(policy: ExtensionGovernancePolicy): NormalizedExtensionPolicy {
  const overridesByName = collectExtensionPolicyOverrides(policy.extension_overrides);
  return {
    mode: normalizePolicyMode(policy.mode),
    trustMode: normalizePolicyTrustMode(policy.trust_mode),
    pmMaxVersionExceededMode: normalizePmMaxVersionExceededMode(policy.pm_max_version_exceeded_mode),
    requireProvenance: policy.require_provenance === true,
    trustedExtensions: normalizePolicyStringSet(policy.trusted_extensions),
    defaultSandboxProfile: normalizePolicySandboxProfile(policy.default_sandbox_profile),
    allowedExtensions: normalizePolicyStringSet(policy.allowed_extensions),
    blockedExtensions: normalizePolicyStringSet(policy.blocked_extensions),
    allowedCapabilities: normalizePolicyStringSet(policy.allowed_capabilities),
    blockedCapabilities: normalizePolicyStringSet(policy.blocked_capabilities),
    allowedSurfaces: normalizePolicySurfaceSet(policy.allowed_surfaces),
    blockedSurfaces: normalizePolicySurfaceSet(policy.blocked_surfaces),
    allowedCommands: normalizePolicyStringSet(policy.allowed_commands),
    blockedCommands: normalizePolicyStringSet(policy.blocked_commands),
    allowedActions: normalizePolicyStringSet(policy.allowed_actions),
    blockedActions: normalizePolicyStringSet(policy.blocked_actions),
    allowedServices: normalizePolicyStringSet(policy.allowed_services),
    blockedServices: normalizePolicyStringSet(policy.blocked_services),
    overridesByName,
    warnings: [],
  };
}

function resolvePolicyOverride(
  policy: NormalizedExtensionPolicy,
  extensionName: string,
): NormalizedExtensionPolicyOverride | null {
  return policy.overridesByName.get(normalizePolicyName(extensionName)) ?? null;
}

function evaluatePolicySet(
  allowed: Set<string>,
  blocked: Set<string>,
  value: string,
  notAllowlistedReason: string,
  blockedReason: string,
): string | null {
  if (blocked.has(value)) {
    return blockedReason;
  }
  if (allowed.size > 0 && !allowed.has(value)) {
    return notAllowlistedReason;
  }
  return null;
}

function resolvePolicyCapabilityReason(
  policy: NormalizedExtensionPolicy,
  extension: PolicyExtensionRef,
  capability: string,
): string | null {
  const normalizedCapability = capability.trim().toLowerCase();
  const override = resolvePolicyOverride(policy, extension.name);
  const allowed = override && override.allowedCapabilities.size > 0 ? override.allowedCapabilities : policy.allowedCapabilities;
  const blocked = new Set<string>([
    ...policy.blockedCapabilities,
    ...(override ? override.blockedCapabilities : []),
  ]);
  return evaluatePolicySet(
    allowed,
    blocked,
    normalizedCapability,
    "capability_not_allowlisted",
    "capability_blocked",
  );
}

function resolvePolicySurfaceReason(
  policy: NormalizedExtensionPolicy,
  extension: PolicyExtensionRef,
  surface: ExtensionPolicySurface,
): string | null {
  const override = resolvePolicyOverride(policy, extension.name);
  const allowed = override && override.allowedSurfaces.size > 0 ? override.allowedSurfaces : policy.allowedSurfaces;
  const blocked = new Set<string>([
    ...policy.blockedSurfaces,
    ...(override ? override.blockedSurfaces : []),
  ]);
  return evaluatePolicySet(allowed, blocked, surface, "surface_not_allowlisted", "surface_blocked");
}

function resolvePolicyCommandReason(
  policy: NormalizedExtensionPolicy,
  extension: PolicyExtensionRef,
  command: string,
): string | null {
  const normalizedCommand = normalizeCommandName(command);
  if (normalizedCommand.length === 0) {
    return null;
  }
  const override = resolvePolicyOverride(policy, extension.name);
  const allowed = override && override.allowedCommands.size > 0 ? override.allowedCommands : policy.allowedCommands;
  const blocked = new Set<string>([
    ...policy.blockedCommands,
    ...(override ? override.blockedCommands : []),
  ]);
  return evaluatePolicySet(allowed, blocked, normalizedCommand, "command_not_allowlisted", "command_blocked");
}

function resolvePolicyActionReason(
  policy: NormalizedExtensionPolicy,
  extension: PolicyExtensionRef,
  action: string,
): string | null {
  const normalizedAction = normalizePolicyName(action).replace(/\s+/g, "-");
  if (normalizedAction.length === 0) {
    return null;
  }
  const override = resolvePolicyOverride(policy, extension.name);
  const allowed = override && override.allowedActions.size > 0 ? override.allowedActions : policy.allowedActions;
  const blocked = new Set<string>([
    ...policy.blockedActions,
    ...(override ? override.blockedActions : []),
  ]);
  return evaluatePolicySet(allowed, blocked, normalizedAction, "action_not_allowlisted", "action_blocked");
}

function resolvePolicyServiceReason(
  policy: NormalizedExtensionPolicy,
  extension: PolicyExtensionRef,
  service: string,
): string | null {
  const normalizedService = normalizePolicyName(service);
  if (normalizedService.length === 0) {
    return null;
  }
  const override = resolvePolicyOverride(policy, extension.name);
  const allowed = override && override.allowedServices.size > 0 ? override.allowedServices : policy.allowedServices;
  const blocked = new Set<string>([
    ...policy.blockedServices,
    ...(override ? override.blockedServices : []),
  ]);
  return evaluatePolicySet(allowed, blocked, normalizedService, "service_not_allowlisted", "service_blocked");
}

function resolvePolicyExtensionReason(policy: NormalizedExtensionPolicy, extension: PolicyExtensionRef): string | null {
  const name = normalizePolicyName(extension.name);
  const override = resolvePolicyOverride(policy, extension.name);
  if (override?.disabled === true) {
    return "extension_override_disabled";
  }
  return evaluatePolicySet(
    policy.allowedExtensions,
    policy.blockedExtensions,
    name,
    "extension_not_allowlisted",
    "extension_blocked",
  );
}

function resolvePolicyTrustReason(policy: NormalizedExtensionPolicy, extension: PolicyExtensionRef): string | null {
  if (policy.trustMode === "off") {
    return null;
  }
  const override = resolvePolicyOverride(policy, extension.name);
  const name = normalizePolicyName(extension.name);
  const trusted = extension.trusted === true;
  const provenanceVerified = extension.provenanceVerified === true;

  if (policy.trustedExtensions.size > 0 && !policy.trustedExtensions.has(name)) {
    return "extension_not_trusted";
  }
  if ((override?.requireTrusted === true || policy.trustMode === "warn" || policy.trustMode === "enforce") && !trusted) {
    return "extension_untrusted";
  }
  if ((policy.requireProvenance || override?.requireProvenance === true) && !provenanceVerified) {
    return "provenance_missing_or_unverified";
  }
  return null;
}

function resolvePolicySandboxReason(policy: NormalizedExtensionPolicy, extension: PolicyExtensionRef): string | null {
  if (policy.mode === "off") {
    return null;
  }
  const override = resolvePolicyOverride(policy, extension.name);
  const profile = override?.sandboxProfile ?? extension.sandboxProfile ?? policy.defaultSandboxProfile;
  if (profile === "none") {
    return null;
  }
  const permissions = extension.permissions;
  if (!permissions) {
    return "sandbox_permissions_missing";
  }

  const hasPermission = (name: keyof typeof permissions): boolean => permissions[name] === true;
  if (profile === "restricted") {
    if (hasPermission("process_spawn")) {
      return "sandbox_restricted_disallows_process_spawn";
    }
    if (hasPermission("env_write")) {
      return "sandbox_restricted_disallows_env_write";
    }
    return null;
  }

  // Remaining profile branch is strict (none/restricted returned above).
  if (hasPermission("process_spawn")) {
    return "sandbox_strict_disallows_process_spawn";
  }
  if (hasPermission("network")) {
    return "sandbox_strict_disallows_network";
  }
  if (hasPermission("fs_write")) {
    return "sandbox_strict_disallows_fs_write";
  }
  if (hasPermission("env_write")) {
    return "sandbox_strict_disallows_env_write";
  }
  return null;
}

function buildPolicyWarning(
  mode: "blocked" | "violation",
  scope: "extension" | "capability" | "registration" | "trust",
  extension: PolicyExtensionRef,
  reason: string,
  details: Record<string, string> = {},
): string {
  const tokens = Object.entries(details)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join(":");
  const suffix = tokens.length > 0 ? `:${tokens}` : "";
  return `extension_policy_${mode}_${scope}:${extension.layer}:${extension.name}:reason=${reason}${suffix}`;
}

/**
 * Implements evaluate extension policy for extension for the public runtime surface of this module.
 */
export function evaluateExtensionPolicyForExtension(
  policy: NormalizedExtensionPolicy,
  extension: PolicyExtensionRef,
): { allowed: boolean; warning: string | null } {
  if (policy.mode === "off" && policy.trustMode === "off") {
    return { allowed: true, warning: null };
  }
  const reason = resolvePolicyExtensionReason(policy, extension);
  const trustReason = resolvePolicyTrustReason(policy, extension);
  const sandboxReason = resolvePolicySandboxReason(policy, extension);
  const extensionEnforced = reason && policy.mode === "enforce";
  const trustEnforced = trustReason && policy.trustMode === "enforce";
  const sandboxEnforced = sandboxReason && policy.mode === "enforce";
  if (!reason && !trustReason && !sandboxReason) {
    return { allowed: true, warning: null };
  }
  if (extensionEnforced) {
    return {
      allowed: false,
      warning: buildPolicyWarning("blocked", "extension", extension, reason),
    };
  }
  if (trustEnforced) {
    return {
      allowed: false,
      warning: buildPolicyWarning("blocked", "trust", extension, trustReason),
    };
  }
  if (sandboxEnforced) {
    return {
      allowed: false,
      warning: buildPolicyWarning("blocked", "extension", extension, sandboxReason),
    };
  }
  if (reason && policy.mode === "warn") {
    return {
      allowed: true,
      warning: buildPolicyWarning("violation", "extension", extension, reason),
    };
  }
  if (trustReason && policy.trustMode === "warn") {
    return {
      allowed: true,
      warning: buildPolicyWarning("violation", "trust", extension, trustReason),
    };
  }
  if (sandboxReason && policy.mode === "warn") {
    return {
      allowed: true,
      warning: buildPolicyWarning("violation", "extension", extension, sandboxReason),
    };
  }
  return {
    allowed: true,
    warning: null,
  };
}

/**
 * Implements evaluate extension policy for capability for the public runtime surface of this module.
 */
export function evaluateExtensionPolicyForCapability(
  policy: NormalizedExtensionPolicy,
  extension: PolicyExtensionRef,
  capability: string,
): { allowed: boolean; warning: string | null } {
  if (policy.mode === "off") {
    return { allowed: true, warning: null };
  }
  const reason = resolvePolicyCapabilityReason(policy, extension, capability);
  if (!reason) {
    return { allowed: true, warning: null };
  }
  return {
    allowed: policy.mode === "warn",
    warning: buildPolicyWarning(
    policy.mode === "warn" ? "violation" : "blocked",
    "capability",
    extension,
    reason,
    { capability: capability.trim().toLowerCase() },
    ),
  };
}

/**
 * Implements evaluate extension policy for registration for the public runtime surface of this module.
 */
export function evaluateExtensionPolicyForRegistration(
  policy: NormalizedExtensionPolicy,
  extension: PolicyExtensionRef,
  surface: ExtensionPolicySurface,
  method: string,
  capability?: ExtensionCapability,
  details?: {
    command?: string;
    action?: string;
    service?: string;
  },
): { allowed: boolean; warning: string | null } {
  if (policy.mode === "off") {
    return { allowed: true, warning: null };
  }
  const capabilityReason =
    typeof capability === "string" ? resolvePolicyCapabilityReason(policy, extension, capability) : null;
  const surfaceReason = resolvePolicySurfaceReason(policy, extension, surface);
  const commandReason = details?.command ? resolvePolicyCommandReason(policy, extension, details.command) : null;
  const actionReason = details?.action ? resolvePolicyActionReason(policy, extension, details.action) : null;
  const serviceReason = details?.service ? resolvePolicyServiceReason(policy, extension, details.service) : null;
  const reason = capabilityReason ?? surfaceReason ?? commandReason ?? actionReason ?? serviceReason;
  if (!reason) {
    return { allowed: true, warning: null };
  }
  const warningDetails: Record<string, string> = {
    method: normalizePolicyName(method).replace(/\s+/g, "_"),
    surface,
  };
  if (capability) {
    warningDetails.capability = capability;
  }
  if (details?.command) {
    warningDetails.command = normalizeCommandName(details.command);
  }
  if (details?.action) {
    warningDetails.action = normalizePolicyName(details.action).replace(/\s+/g, "-");
  }
  if (details?.service) {
    warningDetails.service = normalizePolicyName(details.service);
  }
  const warning = buildPolicyWarning(
    policy.mode === "warn" ? "violation" : "blocked",
    "registration",
    extension,
    reason,
    warningDetails,
  );
  return {
    allowed: policy.mode === "warn",
    warning,
  };
}
