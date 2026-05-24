import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pathExists } from "../fs/fs-utils.js";
import { isPathWithinDirectory } from "../fs/path-utils.js";
import { resolveGlobalPmRoot } from "../store/paths.js";
import type { GlobalOptions } from "../shared/command-types.js";
import { asRecordLoose } from "../shared/primitives.js";
import type { PmSettings } from "../../types/index.js";
import {
  KNOWN_EXTENSION_CAPABILITIES,
  KNOWN_EXTENSION_POLICY_MODES,
  KNOWN_EXTENSION_POLICY_SURFACES,
  KNOWN_EXTENSION_SANDBOX_PROFILES,
  KNOWN_EXTENSION_TRUST_MODES,
  EXTENSION_CAPABILITY_CONTRACT_VERSION,
  EXTENSION_CAPABILITY_LEGACY_ALIASES,
  EXTENSION_CAPABILITY_CONTRACT,
  type ExtensionCapability,
  type ExtensionPolicyMode,
  type ExtensionPolicySurface,
  type ExtensionSandboxProfile,
  type ExtensionGovernancePolicy,
  type ExtensionTrustMode,
  type ExtensionLayer,
  type ExtensionStatus,
  type ExtensionManifest,
  type ExtensionDiagnostic,
  type EffectiveExtension,
  type ExtensionDiscoveryResult,
  type LoadedExtension,
  type FailedExtensionLoad,
  type ExtensionLoadResult,
  type BeforeCommandHookContext,
  type AfterCommandHookContext,
  type OnWriteHookContext,
  type OnReadHookContext,
  type OnIndexHookContext,
  type BeforeCommandHook,
  type AfterCommandHook,
  type OnWriteHook,
  type OnReadHook,
  type OnIndexHook,
  type OutputRendererFormat,
  type CommandOverride,
  type RendererOverride,
  type CommandHandler,
  type ParserOverride,
  type PreflightOverride,
  type ServiceOverride,
  type ExtensionHookRegistry,
  type CommandOverrideContext,
  type RendererOverrideContext,
  type CommandHandlerContext,
  type ParserOverrideContext,
  type ParserOverrideDelta,
  type PreflightOverrideContext,
  type PreflightRuntimeDecision,
  type PreflightOverrideDelta,
  type ExtensionServiceName,
  type ServiceOverrideContext,
  type ExtensionCommandArgumentDefinition,
  type CommandDefinition,
  type FlagValueType,
  type FlagDefinition,
  type SchemaFieldDefinition,
  type SchemaItemTypeCommandOptionPolicyDefinition,
  type SchemaItemTypeOptionDefinition,
  type SchemaItemTypeDefinition,
  type SchemaMigrationRunContext,
  type SchemaMigrationRunner,
  type SchemaMigrationDefinition,
  type ImportExportContext,
  type Importer,
  type Exporter,
  type ExtensionSearchMode,
  type SearchProviderQueryContext,
  type SearchProviderHit,
  type SearchProviderQueryResult,
  type SearchProviderEmbedBatchContext,
  type SearchProviderEmbedContext,
  type SearchProviderDefinition,
  type VectorStoreQueryHit,
  type VectorStoreQueryContext,
  type VectorStoreUpsertPoint,
  type VectorStoreUpsertContext,
  type VectorStoreDeleteContext,
  type VectorStoreAdapterDefinition,
  type RegisteredExtensionCommandOverride,
  type RegisteredExtensionCommandHandler,
  type RegisteredExtensionParserOverride,
  type RegisteredExtensionPreflightOverride,
  type RegisteredExtensionServiceOverride,
  type RegisteredExtensionRendererOverride,
  type ExtensionCommandRegistry,
  type ExtensionParserRegistry,
  type ExtensionPreflightRegistry,
  type ExtensionServiceRegistry,
  type ExtensionRendererRegistry,
  type RegisteredExtensionFlagDefinitions,
  type RegisteredExtensionCommandDefinition,
  type RegisteredExtensionSchemaFieldDefinitions,
  type RegisteredExtensionSchemaItemTypeDefinitions,
  type RegisteredExtensionSchemaMigrationDefinition,
  type RegisteredExtensionImporter,
  type RegisteredExtensionExporter,
  type RegisteredExtensionSearchProvider,
  type RegisteredExtensionVectorStoreAdapter,
  type ExtensionRegistrationRegistry,
  type ExtensionRegistrationCounts,
  type ExtensionApi,
  type FailedExtensionActivation,
  type ExtensionActivationFailureTrace,
  type ExtensionActivationResult,
  type ExtensionCandidate,
  type ExtensionLayerScanResult,
  type ScannedExtensionDirectory,
  type LegacyExtensionCapabilityAliasMapping,
  type DiscoverExtensionsOptions,
  type ActivatableExtension,
  type ServiceOverrideResult,
  type CommandOverrideResult,
  type CommandHandlerResult,
  type ParserOverrideResult,
  type PreflightOverrideResult,
  type RendererOverrideResult,
  type UnknownExtensionCapabilityWarningDetails,
  type RegisteredExtensionHook,
} from "./extension-types.js";
export * from "./extension-types.js";

const DEFAULT_EXTENSION_PRIORITY = 100;

/* Types now in extension-types.ts - re-exported via `export * from "./extension-types.js"` above */

function normalizeNames(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function isKnownExtensionCapability(value: string): value is ExtensionCapability {
  return (KNOWN_EXTENSION_CAPABILITIES as readonly string[]).includes(value);
}

function collectUnknownExtensionCapabilities(capabilities: readonly string[]): string[] {
  return capabilities.filter((capability) => !isKnownExtensionCapability(capability));
}

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

interface NormalizedExtensionPolicy {
  mode: ExtensionPolicyMode;
  trustMode: ExtensionTrustMode;
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

const DEFAULT_EXTENSION_POLICY: ExtensionGovernancePolicy = Object.freeze({
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
});

let extensionReloadEpoch = 0;

export function nextExtensionReloadToken(seed = Date.now()): string {
  extensionReloadEpoch += 1;
  return `${extensionReloadEpoch}-${seed}`;
}

interface PolicyExtensionRef {
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

function normalizePolicySandboxProfile(value: string | undefined): ExtensionSandboxProfile {
  const normalized = normalizePolicyName(value);
  if ((KNOWN_EXTENSION_SANDBOX_PROFILES as readonly string[]).includes(normalized)) {
    return normalized as ExtensionSandboxProfile;
  }
  return "none";
}

function toSortedList(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeExtensionPolicy(settings: PmSettings): NormalizedExtensionPolicy {
  const policy = settings.extensions.policy;
  const mode = normalizePolicyMode(policy?.mode);
  const trustMode = normalizePolicyTrustMode(policy?.trust_mode);
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
  const overridesByName = new Map<string, NormalizedExtensionPolicyOverride>();
  for (const rawOverride of policy?.extension_overrides ?? []) {
    const name = normalizePolicyName(rawOverride.name);
    if (name.length === 0) {
      continue;
    }
    overridesByName.set(name, {
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
    });
  }

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

function serializeExtensionPolicy(policy: NormalizedExtensionPolicy): ExtensionGovernancePolicy {
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

function hydrateExtensionPolicy(policy: ExtensionGovernancePolicy): NormalizedExtensionPolicy {
  const overridesByName = new Map<string, NormalizedExtensionPolicyOverride>();
  for (const rawOverride of policy.extension_overrides ?? []) {
    const name = normalizePolicyName(rawOverride.name);
    if (name.length === 0) {
      continue;
    }
    overridesByName.set(name, {
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
    });
  }
  return {
    mode: normalizePolicyMode(policy.mode),
    trustMode: normalizePolicyTrustMode(policy.trust_mode),
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

  if (profile === "strict") {
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

function evaluateExtensionPolicyForExtension(
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

function evaluateExtensionPolicyForCapability(
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

function evaluateExtensionPolicyForRegistration(
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

function resolveLegacyExtensionCapabilityAlias(capability: string): ExtensionCapability | null {
  const normalized = capability.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }
  return EXTENSION_CAPABILITY_LEGACY_ALIASES[normalized] ?? null;
}

function normalizeManifestCapabilities(rawCapabilities: readonly string[]): {
  capabilities: string[];
  legacy_aliases: LegacyExtensionCapabilityAliasMapping[];
} {
  const normalizedCapabilities = normalizeNames([...rawCapabilities].map((value) => value.toLowerCase()));
  const remappedCapabilities: string[] = [];
  const legacyAliases: LegacyExtensionCapabilityAliasMapping[] = [];
  for (const capability of normalizedCapabilities) {
    const legacyAliasTarget = resolveLegacyExtensionCapabilityAlias(capability);
    if (legacyAliasTarget) {
      remappedCapabilities.push(legacyAliasTarget);
      legacyAliases.push({
        alias: capability,
        target: legacyAliasTarget,
      });
      continue;
    }
    remappedCapabilities.push(capability);
  }
  const dedupedLegacyAliases = [...new Map(legacyAliases.map((entry) => [`${entry.alias}>${entry.target}`, entry])).values()].sort(
    (left, right) => left.alias.localeCompare(right.alias),
  );
  return {
    capabilities: normalizeNames(remappedCapabilities),
    legacy_aliases: dedupedLegacyAliases,
  };
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }
  const previous = new Array<number>(right.length + 1);
  const current = new Array<number>(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) {
    previous[j] = j;
  }
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost,
      );
    }
    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = current[j];
    }
  }
  return previous[right.length] ?? left.length;
}

function suggestKnownExtensionCapability(capability: string): string | null {
  const normalized = capability.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }
  const legacyAlias = resolveLegacyExtensionCapabilityAlias(normalized);
  if (legacyAlias) {
    return legacyAlias;
  }
  let bestMatch: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of KNOWN_EXTENSION_CAPABILITIES) {
    const distance = levenshteinDistance(normalized, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = candidate;
    }
  }
  const maxDistance = Math.max(1, Math.floor(normalized.length * 0.34));
  return bestMatch !== null && bestDistance <= maxDistance ? bestMatch : null;
}

function formatUnknownExtensionCapabilityWarning(layer: ExtensionLayer, name: string, capability: string): string {
  const allowed = KNOWN_EXTENSION_CAPABILITIES.join(",");
  const suggested = suggestKnownExtensionCapability(capability) ?? "none";
  return `extension_capability_unknown:${layer}:${name}:${capability}:allowed=${allowed}:suggested=${suggested}`;
}

function formatLegacyExtensionCapabilityAliasWarning(
  layer: ExtensionLayer,
  name: string,
  aliases: readonly LegacyExtensionCapabilityAliasMapping[],
): string {
  const aliasesToken = aliases.map((entry) => `${entry.alias}>${entry.target}`).join(",");
  return `extension_capability_legacy_alias:${layer}:${name}:aliases=${aliasesToken}`;
}


export function parseUnknownExtensionCapabilityWarning(
  warning: string,
): UnknownExtensionCapabilityWarningDetails | null {
  const match = /^extension_capability_unknown:(global|project):([^:]+):([^:]+):allowed=([^:]+):suggested=([^:]+)$/.exec(
    warning.trim(),
  );
  if (!match) {
    return null;
  }
  const [, layerRaw, name, capability, allowedRaw, suggestedRaw] = match;
  const layer = layerRaw as ExtensionLayer;
  const allowed_capabilities = allowedRaw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const legacyAlias = resolveLegacyExtensionCapabilityAlias(capability);
  const suggestedFromWarning = suggestedRaw === "none" ? undefined : suggestedRaw;
  const suggested_capability = suggestedFromWarning ?? legacyAlias ?? undefined;
  const suggestion_source = suggested_capability
    ? legacyAlias === suggested_capability
      ? "legacy_alias"
      : "nearest_match"
    : undefined;
  return {
    layer,
    name,
    capability,
    allowed_capabilities,
    capability_contract_version: EXTENSION_CAPABILITY_CONTRACT_VERSION,
    suggested_capability,
    suggestion_source,
    legacy_alias_target: legacyAlias ?? undefined,
  };
}

export function parseLegacyExtensionCapabilityAliasWarning(warning: string): UnknownExtensionCapabilityWarningDetails[] {
  const match = /^extension_capability_legacy_alias:(global|project):([^:]+):aliases=(.+)$/.exec(warning.trim());
  if (!match) {
    return [];
  }
  const [, layerRaw, name, aliasesRaw] = match;
  const layer = layerRaw as ExtensionLayer;
  const allowedCapabilities = [...KNOWN_EXTENSION_CAPABILITIES];
  const parsed: UnknownExtensionCapabilityWarningDetails[] = [];
  for (const token of aliasesRaw.split(",")) {
    const [rawAlias, rawTarget] = token.split(">");
    const alias = rawAlias?.trim();
    const target = rawTarget?.trim().toLowerCase();
    if (!alias || !target || !isKnownExtensionCapability(target)) {
      continue;
    }
    parsed.push({
      layer,
      name,
      capability: alias,
      allowed_capabilities: allowedCapabilities,
      capability_contract_version: EXTENSION_CAPABILITY_CONTRACT_VERSION,
      suggested_capability: target,
      suggestion_source: "legacy_alias",
      legacy_alias_target: target,
    });
  }
  return parsed;
}

function parseManifest(raw: unknown): ExtensionManifest | null {
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
  if ("priority" in candidate && candidate.priority !== undefined && candidate.priority !== null) {
    if (typeof candidate.priority !== "number" || !Number.isInteger(candidate.priority)) {
      return null;
    }
    priority = candidate.priority;
  }

  let manifestVersion: number | undefined;
  if ("manifest_version" in candidate && candidate.manifest_version !== undefined && candidate.manifest_version !== null) {
    if (typeof candidate.manifest_version !== "number" || !Number.isInteger(candidate.manifest_version)) {
      return null;
    }
    manifestVersion = candidate.manifest_version;
  }

  let trusted: boolean | undefined;
  if ("trusted" in candidate && candidate.trusted !== undefined && candidate.trusted !== null) {
    if (typeof candidate.trusted !== "boolean") {
      return null;
    }
    trusted = candidate.trusted;
  }

  let sandboxProfile: ExtensionSandboxProfile | undefined;
  if ("sandbox_profile" in candidate && candidate.sandbox_profile !== undefined && candidate.sandbox_profile !== null) {
    if (typeof candidate.sandbox_profile !== "string") {
      return null;
    }
    const normalizedProfile = normalizePolicySandboxProfile(candidate.sandbox_profile);
    if (normalizedProfile !== candidate.sandbox_profile.trim().toLowerCase()) {
      return null;
    }
    sandboxProfile = normalizedProfile;
  }

  let provenance: ExtensionManifest["provenance"] | undefined;
  if ("provenance" in candidate && candidate.provenance !== undefined && candidate.provenance !== null) {
    const provenanceRecord = asRecordLoose(candidate.provenance);
    if (!provenanceRecord) {
      return null;
    }
    const source =
      typeof provenanceRecord.source === "string" && provenanceRecord.source.trim().length > 0
        ? provenanceRecord.source.trim()
        : undefined;
    const signature =
      typeof provenanceRecord.signature === "string" && provenanceRecord.signature.trim().length > 0
        ? provenanceRecord.signature.trim()
        : undefined;
    const attestation =
      typeof provenanceRecord.attestation === "string" && provenanceRecord.attestation.trim().length > 0
        ? provenanceRecord.attestation.trim()
        : undefined;
    const verified =
      provenanceRecord.verified === undefined || provenanceRecord.verified === null
        ? undefined
        : typeof provenanceRecord.verified === "boolean"
          ? provenanceRecord.verified
          : null;
    if (verified === null) {
      return null;
    }
    provenance = {
      ...(source ? { source } : {}),
      ...(signature ? { signature } : {}),
      ...(attestation ? { attestation } : {}),
      ...(typeof verified === "boolean" ? { verified } : {}),
    };
  }

  let permissions: ExtensionManifest["permissions"] | undefined;
  if ("permissions" in candidate && candidate.permissions !== undefined && candidate.permissions !== null) {
    const permissionsRecord = asRecordLoose(candidate.permissions);
    if (!permissionsRecord) {
      return null;
    }
    const parseOptionalBoolean = (value: unknown): boolean | undefined | null => {
      if (value === undefined || value === null) {
        return undefined;
      }
      if (typeof value !== "boolean") {
        return null;
      }
      return value;
    };
    const fsRead = parseOptionalBoolean(permissionsRecord.fs_read);
    const fsWrite = parseOptionalBoolean(permissionsRecord.fs_write);
    const network = parseOptionalBoolean(permissionsRecord.network);
    const envRead = parseOptionalBoolean(permissionsRecord.env_read);
    const envWrite = parseOptionalBoolean(permissionsRecord.env_write);
    const processSpawn = parseOptionalBoolean(permissionsRecord.process_spawn);
    if ([fsRead, fsWrite, network, envRead, envWrite, processSpawn].includes(null)) {
      return null;
    }
    permissions = {
      ...(typeof fsRead === "boolean" ? { fs_read: fsRead } : {}),
      ...(typeof fsWrite === "boolean" ? { fs_write: fsWrite } : {}),
      ...(typeof network === "boolean" ? { network } : {}),
      ...(typeof envRead === "boolean" ? { env_read: envRead } : {}),
      ...(typeof envWrite === "boolean" ? { env_write: envWrite } : {}),
      ...(typeof processSpawn === "boolean" ? { process_spawn: processSpawn } : {}),
    };
  }

  let capabilities: string[] = [];
  let legacyCapabilityAliases: LegacyExtensionCapabilityAliasMapping[] = [];
  if ("capabilities" in candidate && candidate.capabilities !== undefined && candidate.capabilities !== null) {
    if (!Array.isArray(candidate.capabilities) || candidate.capabilities.some((value) => typeof value !== "string")) {
      return null;
    }
    const normalizedCapabilities = normalizeManifestCapabilities(candidate.capabilities as string[]);
    capabilities = normalizedCapabilities.capabilities;
    legacyCapabilityAliases = normalizedCapabilities.legacy_aliases;
  }

  return {
    name: candidate.name.trim(),
    version: candidate.version.trim(),
    entry: candidate.entry.trim(),
    priority,
    manifest_version: manifestVersion,
    trusted,
    provenance,
    sandbox_profile: sandboxProfile,
    permissions,
    capabilities,
    legacy_capability_aliases: legacyCapabilityAliases.length > 0 ? legacyCapabilityAliases : undefined,
  };
}

function shouldEnable(name: string, enabled: Set<string>, disabled: Set<string>): boolean {
  if (disabled.has(name)) {
    return false;
  }
  if (enabled.size === 0) {
    return true;
  }
  return enabled.has(name);
}

async function isCanonicalPathWithinDirectory(directory: string, targetPath: string): Promise<boolean> {
  const [resolvedDirectory, resolvedTargetPath] = await Promise.all([fs.realpath(directory), fs.realpath(targetPath)]);
  return isPathWithinDirectory(resolvedDirectory, resolvedTargetPath);
}

export function resolveExtensionRoots(pmRoot: string, cwd = process.cwd()): { global: string; project: string } {
  return {
    global: path.join(resolveGlobalPmRoot(cwd), "extensions"),
    project: path.join(pmRoot, "extensions"),
  };
}

export function createEmptyExtensionHookRegistry(): ExtensionHookRegistry {
  return {
    beforeCommand: [],
    afterCommand: [],
    onWrite: [],
    onRead: [],
    onIndex: [],
  };
}

export function createEmptyExtensionCommandRegistry(): ExtensionCommandRegistry {
  return {
    overrides: [],
    handlers: [],
  };
}

export function createEmptyExtensionParserRegistry(): ExtensionParserRegistry {
  return {
    overrides: [],
  };
}

export function createEmptyExtensionPreflightRegistry(): ExtensionPreflightRegistry {
  return {
    overrides: [],
  };
}

export function createEmptyExtensionServiceRegistry(): ExtensionServiceRegistry {
  return {
    overrides: [],
  };
}

export function createEmptyExtensionRendererRegistry(): ExtensionRendererRegistry {
  return {
    overrides: [],
  };
}

export function createEmptyExtensionRegistrationRegistry(): ExtensionRegistrationRegistry {
  return {
    commands: [],
    flags: [],
    item_fields: [],
    item_types: [],
    migrations: [],
    importers: [],
    exporters: [],
    search_providers: [],
    vector_store_adapters: [],
  };
}

async function listExtensionDirectories(extensionsRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(extensionsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function summarizeCandidate(candidate: ExtensionCandidate): EffectiveExtension {
  return {
    layer: candidate.layer,
    directory: candidate.directory,
    manifest_path: candidate.manifest_path,
    name: candidate.manifest.name,
    version: candidate.manifest.version,
    entry: candidate.manifest.entry,
    priority: candidate.manifest.priority,
    entry_path: candidate.entry_path,
    manifest_version: candidate.manifest.manifest_version,
    trusted: candidate.manifest.trusted,
    provenance: candidate.manifest.provenance,
    sandbox_profile: candidate.manifest.sandbox_profile,
    permissions: candidate.manifest.permissions,
    capabilities: [...candidate.manifest.capabilities],
  };
}

function sortCandidates(candidates: ExtensionCandidate[]): ExtensionCandidate[] {
  return [...candidates].sort((left, right) => {
    if (left.manifest.priority !== right.manifest.priority) {
      return left.manifest.priority - right.manifest.priority;
    }
    const byName = left.manifest.name.localeCompare(right.manifest.name);
    if (byName !== 0) {
      return byName;
    }
    return left.directory.localeCompare(right.directory);
  });
}

function buildEffectiveExtensions(
  globalCandidates: ExtensionCandidate[],
  projectCandidates: ExtensionCandidate[],
): ExtensionCandidate[] {
  const ordered = [...sortCandidates(globalCandidates), ...sortCandidates(projectCandidates)];
  const effective: ExtensionCandidate[] = [];
  for (const candidate of ordered) {
    const existingIndex = effective.findIndex((entry) => entry.manifest.name === candidate.manifest.name);
    if (existingIndex >= 0) {
      effective.splice(existingIndex, 1);
    }
    effective.push(candidate);
  }
  return effective;
}

async function scanExtensionLayer(
  layer: ExtensionLayer,
  extensionsRoot: string,
  enabled: Set<string>,
  disabled: Set<string>,
): Promise<ExtensionLayerScanResult> {
  const diagnostics: ExtensionDiagnostic[] = [];
  const warnings: string[] = [];
  const candidates: ExtensionCandidate[] = [];
  const directories = await listExtensionDirectories(extensionsRoot);

  for (const directory of directories) {
    const scanned = await scanExtensionDirectory(layer, extensionsRoot, directory, enabled, disabled);
    diagnostics.push(scanned.diagnostic);
    warnings.push(...scanned.warnings);
    if (scanned.candidate) {
      candidates.push(scanned.candidate);
    }
  }

  return { diagnostics, warnings, candidates };
}

async function scanExtensionDirectory(
  layer: ExtensionLayer,
  extensionsRoot: string,
  directory: string,
  enabled: Set<string>,
  disabled: Set<string>,
): Promise<ScannedExtensionDirectory> {
  const extensionDir = path.join(extensionsRoot, directory);
  const manifestPath = path.join(extensionDir, "manifest.json");
  if (!(await pathExists(manifestPath))) {
    return {
      diagnostic: {
        layer,
        directory,
        manifest_path: manifestPath,
        name: null,
        version: null,
        entry: null,
        priority: null,
        entry_path: null,
        enabled: null,
        status: "warn",
      },
      warnings: [`extension_manifest_missing:${layer}:${directory}`],
      candidate: null,
    };
  }

  let manifest: ExtensionManifest | null = null;
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
    manifest = parseManifest(parsed);
  } catch {
    manifest = null;
  }

  if (!manifest) {
    return {
      diagnostic: {
        layer,
        directory,
        manifest_path: manifestPath,
        name: null,
        version: null,
        entry: null,
        priority: null,
        entry_path: null,
        enabled: null,
        status: "warn",
      },
      warnings: [`extension_manifest_invalid:${layer}:${directory}`],
      candidate: null,
    };
  }

  const entryPath = path.resolve(extensionDir, manifest.entry);
  const entryWithinDirectoryByPath = isPathWithinDirectory(extensionDir, entryPath);
  const entryExists = entryWithinDirectoryByPath ? await pathExists(entryPath) : false;
  const entryWithinDirectory =
    entryWithinDirectoryByPath && entryExists
      ? await isCanonicalPathWithinDirectory(extensionDir, entryPath)
      : entryWithinDirectoryByPath;
  const enabledForLoad = shouldEnable(manifest.name, enabled, disabled);
  const extensionWarnings: string[] = [];
  if (Array.isArray(manifest.legacy_capability_aliases) && manifest.legacy_capability_aliases.length > 0) {
    extensionWarnings.push(
      formatLegacyExtensionCapabilityAliasWarning(layer, manifest.name, manifest.legacy_capability_aliases),
    );
  }
  for (const capability of collectUnknownExtensionCapabilities(manifest.capabilities)) {
    extensionWarnings.push(formatUnknownExtensionCapabilityWarning(layer, manifest.name, capability));
  }
  if (!entryWithinDirectory) {
    extensionWarnings.push(`extension_entry_outside_extension:${layer}:${manifest.name}`);
  } else if (!entryExists) {
    extensionWarnings.push(`extension_entry_missing:${layer}:${manifest.name}`);
  }

  return {
    diagnostic: {
      layer,
      directory,
      manifest_path: manifestPath,
      name: manifest.name,
      version: manifest.version,
      entry: manifest.entry,
      priority: manifest.priority,
      entry_path: entryPath,
      enabled: enabledForLoad,
      status: entryWithinDirectory && entryExists ? "ok" : "warn",
    },
    warnings: extensionWarnings,
    candidate:
      entryWithinDirectory && entryExists && enabledForLoad
        ? {
            layer,
            directory,
            manifest_path: manifestPath,
            entry_path: entryPath,
            manifest,
          }
        : null,
  };
}


export async function discoverExtensions(options: DiscoverExtensionsOptions): Promise<ExtensionDiscoveryResult> {
  const roots = resolveExtensionRoots(options.pmRoot, options.cwd ?? process.cwd());
  const configured_enabled = normalizeNames(options.settings.extensions.enabled);
  const configured_disabled = normalizeNames(options.settings.extensions.disabled);
  const policy = normalizeExtensionPolicy(options.settings);
  const serializedPolicy = serializeExtensionPolicy(policy);

  if (options.noExtensions) {
    return {
      disabled_by_flag: true,
      roots,
      configured_enabled,
      configured_disabled,
      discovered: [],
      effective: [],
      warnings: [...policy.warnings],
      policy: serializedPolicy,
    };
  }

  const enabled = new Set(configured_enabled);
  const disabled = new Set(configured_disabled);
  const globalScan = await scanExtensionLayer("global", roots.global, enabled, disabled);
  const projectScan = await scanExtensionLayer("project", roots.project, enabled, disabled);
  const policyWarnings: string[] = [...policy.warnings];
  const effectiveCandidates = buildEffectiveExtensions(globalScan.candidates, projectScan.candidates);
  const effective: EffectiveExtension[] = [];
  for (const candidate of effectiveCandidates) {
    const extensionRef = {
      layer: candidate.layer,
      name: candidate.manifest.name,
      trusted: candidate.manifest.trusted === true,
      provenanceVerified: candidate.manifest.provenance?.verified === true,
      sandboxProfile: candidate.manifest.sandbox_profile,
      permissions:
        candidate.manifest.permissions && typeof candidate.manifest.permissions === "object"
          ? {
              fs_read: candidate.manifest.permissions.fs_read,
              fs_write: candidate.manifest.permissions.fs_write,
              network: candidate.manifest.permissions.network,
              env_read: candidate.manifest.permissions.env_read,
              env_write: candidate.manifest.permissions.env_write,
              process_spawn: candidate.manifest.permissions.process_spawn,
            }
          : undefined,
    };
    const extensionDecision = evaluateExtensionPolicyForExtension(policy, extensionRef);
    if (extensionDecision.warning) {
      policyWarnings.push(extensionDecision.warning);
    }
    if (!extensionDecision.allowed) {
      continue;
    }
    for (const capability of candidate.manifest.capabilities) {
      const capabilityDecision = evaluateExtensionPolicyForCapability(policy, extensionRef, capability);
      if (capabilityDecision.warning) {
        policyWarnings.push(capabilityDecision.warning);
      }
    }
    effective.push(summarizeCandidate(candidate));
  }

  return {
    disabled_by_flag: false,
    roots,
    configured_enabled,
    configured_disabled,
    discovered: [...globalScan.diagnostics, ...projectScan.diagnostics],
    effective,
    warnings: [...new Set([...globalScan.warnings, ...projectScan.warnings, ...policyWarnings])],
    policy: serializedPolicy,
  };
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

async function fingerprintPath(pathToInspect: string): Promise<string> {
  try {
    const stats = await fs.stat(pathToInspect);
    return `${Math.trunc(stats.mtimeMs)}-${stats.size}`;
  } catch {
    return "missing";
  }
}

async function resolveExtensionImportHref(
  extension: EffectiveExtension,
  options: DiscoverExtensionsOptions,
): Promise<string> {
  const baseUrl = new URL(pathToFileURL(extension.entry_path).href);
  const shouldCacheBust = options.cache_bust === true || typeof options.reload_token === "string";
  if (!shouldCacheBust) {
    return baseUrl.href;
  }
  const [entryFingerprint, manifestFingerprint] = await Promise.all([
    fingerprintPath(extension.entry_path),
    fingerprintPath(extension.manifest_path),
  ]);
  const reloadToken = options.reload_token ?? nextExtensionReloadToken();
  baseUrl.searchParams.set("pm_ext_reload", reloadToken);
  baseUrl.searchParams.set("pm_ext_entry", entryFingerprint);
  baseUrl.searchParams.set("pm_ext_manifest", manifestFingerprint);
  return baseUrl.href;
}

export async function loadExtensions(options: DiscoverExtensionsOptions): Promise<ExtensionLoadResult> {
  const discovery = await discoverExtensions(options);
  const loaded: LoadedExtension[] = [];
  const failed: FailedExtensionLoad[] = [];
  const warnings = [...discovery.warnings];

  if (discovery.disabled_by_flag) {
    return {
      ...discovery,
      warnings,
      loaded,
      failed,
    };
  }

  for (const extension of discovery.effective) {
    try {
      const importHref = await resolveExtensionImportHref(extension, options);
      const module = await import(importHref);
      loaded.push({
        ...extension,
        module,
      });
    } catch (error: unknown) {
      warnings.push(`extension_load_failed:${extension.layer}:${extension.name}`);
      failed.push({
        layer: extension.layer,
        name: extension.name,
        entry_path: extension.entry_path,
        error: formatUnknownError(error),
      });
    }
  }

  return {
    ...discovery,
    warnings,
    loaded,
    failed,
  };
}

type HookName = keyof ExtensionHookRegistry;

function resolveActivatableExtension(module: unknown): ActivatableExtension | null {
  const moduleRecord = asRecordLoose(module);
  if (!moduleRecord) {
    return null;
  }

  if (typeof moduleRecord.activate === "function") {
    return {
      activate: moduleRecord.activate as ActivatableExtension["activate"],
    };
  }

  const defaultExport = asRecordLoose(moduleRecord.default);
  if (defaultExport && typeof defaultExport.activate === "function") {
    return {
      activate: defaultExport.activate as ActivatableExtension["activate"],
    };
  }

  return null;
}

function normalizeCommandName(command: string): string {
  return command
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

function defaultGlobalOptions(): GlobalOptions {
  return {
    json: false,
    quiet: false,
    noExtensions: false,
    profile: false,
  };
}

function cloneCommandOptionsSnapshot(options: Record<string, unknown> | undefined): Record<string, unknown> {
  return options ? cloneContextSnapshot(options) : {};
}

function cloneGlobalOptionsSnapshot(options: GlobalOptions | undefined): GlobalOptions {
  return options ? cloneContextSnapshot(options) : defaultGlobalOptions();
}

function cloneContextSnapshot<T>(value: T): T {
  return structuredClone(value);
}

function isOutputRendererFormat(value: string): value is OutputRendererFormat {
  return value === "toon" || value === "json";
}

const EXTENSION_SERVICE_NAMES: readonly ExtensionServiceName[] = [
  "output_format",
  "error_format",
  "help_format",
  "lock_acquire",
  "lock_release",
  "history_append",
  "item_store_write",
  "item_store_delete",
];

function isExtensionServiceName(value: string): value is ExtensionServiceName {
  return EXTENSION_SERVICE_NAMES.includes(value as ExtensionServiceName);
}

function assertHookHandler(hookName: string, hook: unknown): void {
  if (typeof hook !== "function") {
    throw new TypeError(`api.hooks.${hookName} requires a function handler`);
  }
}

function assertNonEmptyString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} requires a non-empty string`);
  }
  return value.trim();
}

function assertFunctionHandler(name: string, value: unknown): void {
  if (typeof value !== "function") {
    throw new TypeError(`${name} requires a function handler`);
  }
}

function normalizeRegistrationName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

function toRegistrationCommandPath(name: string, action: "import" | "export"): string {
  return normalizeCommandName(`${name} ${action}`);
}

function sanitizeRegistrationValue(value: unknown): unknown {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeRegistrationValue(entry));
  }
  if (typeof value === "function") {
    return "[Function]";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    const keys = Object.keys(record).sort((left, right) => left.localeCompare(right));
    for (const key of keys) {
      normalized[key] = sanitizeRegistrationValue(record[key]);
    }
    return normalized;
  }
  return value;
}

function cloneRuntimeRegistrationValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneRuntimeRegistrationValue(entry));
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const cloned: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
      cloned[key] = cloneRuntimeRegistrationValue(record[key]);
    }
    return cloned;
  }
  return value;
}

const EXTENSION_REGISTRATION_TRACE_SYMBOL = Symbol("extension_registration_trace");

type RegistrationTraceCarrier = Error & {
  [EXTENSION_REGISTRATION_TRACE_SYMBOL]?: ExtensionActivationFailureTrace;
};

function createRegistrationValidationError(message: string, trace: ExtensionActivationFailureTrace): TypeError {
  const error = new TypeError(message) as RegistrationTraceCarrier;
  Object.defineProperty(error, EXTENSION_REGISTRATION_TRACE_SYMBOL, {
    value: trace,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return error;
}

function extractRegistrationValidationTrace(error: unknown): ExtensionActivationFailureTrace | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  return (error as RegistrationTraceCarrier)[EXTENSION_REGISTRATION_TRACE_SYMBOL];
}

function normalizeRegistrationRecord(name: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} requires an object definition`);
  }
  return sanitizeRegistrationValue(value) as Record<string, unknown>;
}

function normalizeRuntimeRegistrationRecord(name: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} requires an object definition`);
  }
  return cloneRuntimeRegistrationValue(value) as Record<string, unknown>;
}

function normalizeRegistrationRecordList(name: string, value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} requires an array of object definitions`);
  }
  return value.map((entry) => normalizeRegistrationRecord(name, entry));
}

function asRegistrationRecord(name: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} requires an object definition`);
  }
  return value as Record<string, unknown>;
}

function assertOptionalBooleanField(name: string, value: unknown): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean when provided`);
  }
}

function assertOptionalStringField(name: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string when provided`);
  }
}

function assertOptionalStringArrayField(name: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array of non-empty strings when provided`);
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new TypeError(`${name}[${index}] must be a non-empty string`);
    }
  }
}

function normalizeOptionalStringArrayField(name: string, value: unknown): string[] {
  assertOptionalStringArrayField(name, value);
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeCommandActionName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveCommandDefinitionAction(commandPath: string, action: unknown): string {
  if (action === undefined) {
    return commandPath.replace(/\s+/g, "-");
  }
  if (typeof action !== "string" || action.trim().length === 0) {
    throw new TypeError("registerCommand definition.action must be a non-empty string when provided");
  }
  const normalized = normalizeCommandActionName(action);
  if (normalized.length === 0) {
    throw new TypeError("registerCommand definition.action must contain alphanumeric characters");
  }
  return normalized;
}

function normalizeCommandDefinitionArguments(value: unknown): ExtensionCommandArgumentDefinition[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError("registerCommand definition.arguments must be an array when provided");
  }
  const normalized: ExtensionCommandArgumentDefinition[] = [];
  for (const [index, entry] of value.entries()) {
    const record = asRegistrationRecord(`registerCommand definition.arguments[${index}]`, entry);
    const name = assertNonEmptyString(`registerCommand definition.arguments[${index}].name`, record.name);
    assertOptionalBooleanField(`registerCommand definition.arguments[${index}].required`, record.required);
    assertOptionalBooleanField(`registerCommand definition.arguments[${index}].variadic`, record.variadic);
    assertOptionalStringField(`registerCommand definition.arguments[${index}].description`, record.description);
    if (name.includes(" ")) {
      throw new TypeError(`registerCommand definition.arguments[${index}].name must not contain spaces`);
    }
    const definition: ExtensionCommandArgumentDefinition = {
      name,
    };
    if (record.required === true) {
      definition.required = true;
    }
    if (record.variadic === true) {
      definition.variadic = true;
    }
    if (typeof record.description === "string") {
      const trimmedDescription = record.description.trim();
      if (trimmedDescription.length > 0) {
        definition.description = trimmedDescription;
      }
    }
    normalized.push(definition);
  }

  let variadicCount = 0;
  for (const [index, argument] of normalized.entries()) {
    if (!argument.variadic) {
      continue;
    }
    variadicCount += 1;
    if (variadicCount > 1) {
      throw new TypeError("registerCommand definition.arguments supports at most one variadic argument");
    }
    if (index !== normalized.length - 1) {
      throw new TypeError("registerCommand definition.arguments variadic argument must be the final argument");
    }
  }

  return normalized;
}

function validateFlagDefinitions(flags: unknown): void {
  if (!Array.isArray(flags)) {
    throw new TypeError("registerFlags flags requires an array of object definitions");
  }
  for (const [index, raw] of flags.entries()) {
    const record = asRegistrationRecord(`registerFlags flags[${index}]`, raw);
    const long = record.long;
    const short = record.short;
    if (long === undefined && short === undefined) {
      throw new TypeError(`registerFlags flags[${index}] requires at least one of long or short`);
    }
    assertOptionalStringField(`registerFlags flags[${index}].long`, long);
    assertOptionalStringField(`registerFlags flags[${index}].short`, short);
    assertOptionalStringField(`registerFlags flags[${index}].value_name`, record.value_name);
    assertOptionalStringField(`registerFlags flags[${index}].description`, record.description);
    assertOptionalBooleanField(`registerFlags flags[${index}].required`, record.required);
    assertOptionalBooleanField(`registerFlags flags[${index}].enabled`, record.enabled);
    assertOptionalBooleanField(`registerFlags flags[${index}].visible`, record.visible);
  }
}

function validateItemFieldDefinitions(fields: unknown): void {
  if (!Array.isArray(fields)) {
    throw new TypeError("registerItemFields fields requires an array of object definitions");
  }
  for (const [index, raw] of fields.entries()) {
    const record = asRegistrationRecord(`registerItemFields fields[${index}]`, raw);
    assertNonEmptyString(`registerItemFields fields[${index}].name`, record.name);
    assertNonEmptyString(`registerItemFields fields[${index}].type`, record.type);
    assertOptionalBooleanField(`registerItemFields fields[${index}].optional`, record.optional);
  }
}

function validateItemTypeDefinitions(types: unknown): void {
  if (!Array.isArray(types)) {
    throw new TypeError("registerItemTypes types requires an array of object definitions");
  }
  for (const [typeIndex, raw] of types.entries()) {
    const record = asRegistrationRecord(`registerItemTypes types[${typeIndex}]`, raw);
    assertNonEmptyString(`registerItemTypes types[${typeIndex}].name`, record.name);
    assertOptionalStringField(`registerItemTypes types[${typeIndex}].folder`, record.folder);
    assertOptionalStringArrayField(`registerItemTypes types[${typeIndex}].aliases`, record.aliases);
    assertOptionalStringArrayField(
      `registerItemTypes types[${typeIndex}].required_create_fields`,
      record.required_create_fields,
    );
    assertOptionalStringArrayField(
      `registerItemTypes types[${typeIndex}].required_create_repeatables`,
      record.required_create_repeatables,
    );

    if (record.command_option_policies !== undefined) {
      if (!Array.isArray(record.command_option_policies)) {
        throw new TypeError(
          `registerItemTypes types[${typeIndex}].command_option_policies must be an array when provided`,
        );
      }
      for (const [policyIndex, rawPolicy] of record.command_option_policies.entries()) {
        const policy = asRegistrationRecord(
          `registerItemTypes types[${typeIndex}].command_option_policies[${policyIndex}]`,
          rawPolicy,
        );
        assertNonEmptyString(
          `registerItemTypes types[${typeIndex}].command_option_policies[${policyIndex}].command`,
          policy.command,
        );
        assertNonEmptyString(
          `registerItemTypes types[${typeIndex}].command_option_policies[${policyIndex}].option`,
          policy.option,
        );
        assertOptionalBooleanField(
          `registerItemTypes types[${typeIndex}].command_option_policies[${policyIndex}].enabled`,
          policy.enabled,
        );
        assertOptionalBooleanField(
          `registerItemTypes types[${typeIndex}].command_option_policies[${policyIndex}].required`,
          policy.required,
        );
        assertOptionalBooleanField(
          `registerItemTypes types[${typeIndex}].command_option_policies[${policyIndex}].visible`,
          policy.visible,
        );
      }
    }

    if (record.options !== undefined) {
      if (!Array.isArray(record.options)) {
        throw new TypeError(`registerItemTypes types[${typeIndex}].options must be an array when provided`);
      }
      for (const [optionIndex, rawOption] of record.options.entries()) {
        const option = asRegistrationRecord(`registerItemTypes types[${typeIndex}].options[${optionIndex}]`, rawOption);
        assertNonEmptyString(`registerItemTypes types[${typeIndex}].options[${optionIndex}].key`, option.key);
        assertOptionalStringArrayField(`registerItemTypes types[${typeIndex}].options[${optionIndex}].values`, option.values);
        assertOptionalBooleanField(`registerItemTypes types[${typeIndex}].options[${optionIndex}].required`, option.required);
        assertOptionalStringArrayField(
          `registerItemTypes types[${typeIndex}].options[${optionIndex}].aliases`,
          option.aliases,
        );
      }
    }
  }
}

function validateMigrationDefinition(definition: unknown): void {
  const record = asRegistrationRecord("registerMigration definition", definition);
  if (record.id !== undefined && typeof record.id !== "string") {
    throw new TypeError("registerMigration definition.id must be a string when provided");
  }
  if (record.description !== undefined && typeof record.description !== "string") {
    throw new TypeError("registerMigration definition.description must be a string when provided");
  }
  if (record.status !== undefined && typeof record.status !== "string") {
    throw new TypeError("registerMigration definition.status must be a string when provided");
  }
  assertOptionalBooleanField("registerMigration definition.mandatory", record.mandatory);
  if (record.run !== undefined && typeof record.run !== "function") {
    throw new TypeError("registerMigration definition.run must be a function when provided");
  }
}

function attachRuntimeDefinition<TEntry extends { definition: Record<string, unknown> }>(
  entry: TEntry,
  runtimeDefinition: Record<string, unknown>,
): TEntry {
  Object.defineProperty(entry, "runtime_definition", {
    value: runtimeDefinition,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return entry;
}

function getDeclaredExtensionCapabilities(extension: LoadedExtension): Set<ExtensionCapability> | null {
  if (!Array.isArray(extension.capabilities)) {
    return null;
  }
  const declared = new Set<ExtensionCapability>();
  for (const capability of extension.capabilities) {
    const normalized = capability.trim().toLowerCase();
    if (isKnownExtensionCapability(normalized)) {
      declared.add(normalized);
    }
  }
  return declared;
}

function assertExtensionCapability(extension: LoadedExtension, capability: ExtensionCapability, method: string): void {
  const declared = getDeclaredExtensionCapabilities(extension);
  // Keep direct unit tests that construct LoadedExtension fixtures without
  // capability metadata backwards-compatible while enforcing manifest-declared
  // capabilities for runtime-loaded extensions.
  if (declared === null) {
    return;
  }
  if (!declared.has(capability)) {
    throw new TypeError(
      `${method} requires capability '${capability}' in extension manifest capabilities`,
    );
  }
}

function createExtensionApi(
  extension: LoadedExtension,
  hooks: ExtensionHookRegistry,
  commands: ExtensionCommandRegistry,
  parsers: ExtensionParserRegistry,
  preflight: ExtensionPreflightRegistry,
  services: ExtensionServiceRegistry,
  renderers: ExtensionRendererRegistry,
  registrations: ExtensionRegistrationRegistry,
  activationWarnings: string[],
  policy: NormalizedExtensionPolicy,
): ExtensionApi {
  const extensionRef: PolicyExtensionRef = {
    layer: extension.layer,
    name: extension.name,
    trusted: extension.trusted === true,
    provenanceVerified: extension.provenance?.verified === true,
    sandboxProfile: extension.sandbox_profile,
    permissions:
      extension.permissions && typeof extension.permissions === "object"
        ? {
            fs_read: extension.permissions.fs_read,
            fs_write: extension.permissions.fs_write,
            network: extension.permissions.network,
            env_read: extension.permissions.env_read,
            env_write: extension.permissions.env_write,
            process_spawn: extension.permissions.process_spawn,
          }
        : undefined,
  };
  const pushPolicyWarning = (warning: string | null): void => {
    if (warning) {
      activationWarnings.push(warning);
    }
  };
  const allowRegistration = (
    surface: ExtensionPolicySurface,
    method: string,
    capability?: ExtensionCapability,
    details?: {
      command?: string;
      action?: string;
      service?: string;
    },
  ): boolean => {
    const decision = evaluateExtensionPolicyForRegistration(policy, extensionRef, surface, method, capability, details);
    pushPolicyWarning(decision.warning);
    return decision.allowed;
  };
  const registerCommandTrace = (
    mode: "override" | "definition",
    command: string | undefined,
    expectedSchema: string,
    received: unknown,
    hint?: string,
  ): ExtensionActivationFailureTrace => ({
    method: "registerCommand",
    registration_index: mode === "override" ? commands.overrides.length : commands.handlers.length,
    command,
    expected_schema: expectedSchema,
    received: sanitizeRegistrationValue(received),
    hint,
  });

  const registerCommand = (commandOrDefinition: string | CommandDefinition, override?: CommandOverride): void => {
    assertExtensionCapability(extension, "commands", "registerCommand");
    if (typeof commandOrDefinition === "string") {
      const normalizedCommand = normalizeCommandName(commandOrDefinition);
      if (normalizedCommand.length === 0) {
        throw createRegistrationValidationError(
          "registerCommand requires a non-empty command name",
          registerCommandTrace(
            "override",
            commandOrDefinition,
            'registerCommand("<command>", (context) => unknown)',
            commandOrDefinition,
            "Provide a non-empty command path as the first argument.",
          ),
        );
      }
      if (typeof override !== "function") {
        const trace = registerCommandTrace(
          "override",
          normalizedCommand,
          'registerCommand("<command>", (context) => unknown)',
          { command: commandOrDefinition, override },
          "Provide a function as the second registerCommand argument.",
        );
        throw createRegistrationValidationError(
          `registerCommand requires an override function when command name is provided (command="${normalizedCommand}", registration_index=${trace.registration_index})`,
          trace,
        );
      }
      if (!allowRegistration("commands.override", "registerCommand", "commands", { command: normalizedCommand })) {
        return;
      }
      commands.overrides.push({
        layer: extension.layer,
        name: extension.name,
        command: normalizedCommand,
        run: override,
      });
      return;
    }
    if (typeof commandOrDefinition !== "object" || commandOrDefinition === null) {
      throw createRegistrationValidationError(
        "registerCommand requires a command definition object",
        registerCommandTrace(
          "definition",
          undefined,
          "{ name: string; run: (context) => unknown; }",
          commandOrDefinition,
          "Use registerCommand({ name: \"command path\", run: (context) => ... }).",
        ),
      );
    }
    if (typeof commandOrDefinition.name !== "string") {
      throw createRegistrationValidationError(
        "registerCommand requires a command definition name",
        registerCommandTrace(
          "definition",
          undefined,
          "{ name: string; run: (context) => unknown; }",
          commandOrDefinition,
          "Set command definition.name to a non-empty string command path.",
        ),
      );
    }

    const normalizedCommand = normalizeCommandName(commandOrDefinition.name);
    if (normalizedCommand.length === 0) {
      throw createRegistrationValidationError(
        "registerCommand requires a non-empty command definition name",
        registerCommandTrace(
          "definition",
          commandOrDefinition.name,
          "{ name: string; run: (context) => unknown; }",
          commandOrDefinition,
          "Ensure command definition.name contains a non-empty command path.",
        ),
      );
    }
    const runHandler = typeof commandOrDefinition.run === "function" ? commandOrDefinition.run : undefined;
    const legacyHandler = typeof commandOrDefinition.handler === "function" ? commandOrDefinition.handler : undefined;
    if (!runHandler && legacyHandler) {
      activationWarnings.push(
        `extension_command_definition_legacy_handler_alias:${extension.layer}:${extension.name}:${normalizedCommand}`,
      );
    }
    const resolvedHandler = runHandler ?? legacyHandler;
    if (typeof resolvedHandler !== "function") {
      const trace = registerCommandTrace(
        "definition",
        normalizedCommand,
        "{ name: string; run: (context) => unknown; }",
        commandOrDefinition,
        "Define command definition.run as a function.",
      );
      throw createRegistrationValidationError(
        `registerCommand requires a command definition run handler (command="${normalizedCommand}", registration_index=${trace.registration_index})`,
        trace,
      );
    }
    try {
      assertOptionalStringField("registerCommand definition.action", commandOrDefinition.action);
      assertOptionalStringField("registerCommand definition.description", commandOrDefinition.description);
      assertOptionalStringField("registerCommand definition.intent", commandOrDefinition.intent);
      const action = resolveCommandDefinitionAction(normalizedCommand, commandOrDefinition.action);
      if (!allowRegistration("commands.handler", "registerCommand", "commands", { command: normalizedCommand, action })) {
        return;
      }
      const description = commandOrDefinition.description?.trim();
      const intent = commandOrDefinition.intent?.trim();
      const examples = normalizeOptionalStringArrayField("registerCommand definition.examples", commandOrDefinition.examples);
      const failureHints = normalizeOptionalStringArrayField(
        "registerCommand definition.failure_hints",
        commandOrDefinition.failure_hints,
      );
      const argumentsDefinition = normalizeCommandDefinitionArguments(commandOrDefinition.arguments);

      if (commandOrDefinition.flags !== undefined) {
        assertExtensionCapability(extension, "schema", "registerCommand flags");
        validateFlagDefinitions(commandOrDefinition.flags);
        registrations.flags.push({
          layer: extension.layer,
          name: extension.name,
          target_command: normalizedCommand,
          flags: normalizeRegistrationRecordList("registerCommand definition.flags", commandOrDefinition.flags),
        });
      }

      const registration: RegisteredExtensionCommandDefinition = {
        layer: extension.layer,
        name: extension.name,
        command: normalizedCommand,
        action,
        examples,
        failure_hints: failureHints,
        arguments: argumentsDefinition,
      };
      if (description) {
        registration.description = description;
      }
      if (intent) {
        registration.intent = intent;
      }
      registrations.commands.push(registration);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "registerCommand definition validation failed";
      const trace = registerCommandTrace(
        "definition",
        normalizedCommand,
        "{ name: string; run: (context) => unknown; action?: string; arguments?: object[]; flags?: object[]; }",
        commandOrDefinition,
        "Use schema-style metadata (action/arguments/flags/examples/intent) with valid values.",
      );
      throw createRegistrationValidationError(
        `registerCommand definition metadata invalid (command="${normalizedCommand}", registration_index=${trace.registration_index}): ${reason}`,
        trace,
      );
    }
    commands.handlers.push({
      layer: extension.layer,
      name: extension.name,
      command: normalizedCommand,
      run: resolvedHandler,
    });
  };
  const registerParser = (command: string, override: ParserOverride): void => {
    assertExtensionCapability(extension, "parser", "registerParser");
    if (!allowRegistration("parser.override", "registerParser", "parser")) {
      return;
    }
    const normalizedCommand = normalizeCommandName(assertNonEmptyString("registerParser command", command));
    assertFunctionHandler("registerParser override", override);
    parsers.overrides.push({
      layer: extension.layer,
      name: extension.name,
      command: normalizedCommand,
      run: override,
    });
  };
  const registerPreflight = (override: PreflightOverride): void => {
    assertExtensionCapability(extension, "preflight", "registerPreflight");
    if (!allowRegistration("preflight.override", "registerPreflight", "preflight")) {
      return;
    }
    assertFunctionHandler("registerPreflight override", override);
    preflight.overrides.push({
      layer: extension.layer,
      name: extension.name,
      run: override,
    });
  };
  const registerService = (service: ExtensionServiceName, override: ServiceOverride): void => {
    assertExtensionCapability(extension, "services", "registerService");
    const normalizedService = String(service).trim().toLowerCase();
    if (!isExtensionServiceName(normalizedService)) {
      throw new TypeError(`registerService service must be one of: ${EXTENSION_SERVICE_NAMES.join(", ")}`);
    }
    if (!allowRegistration("services.override", "registerService", "services", { service: normalizedService })) {
      return;
    }
    assertFunctionHandler("registerService override", override);
    services.overrides.push({
      layer: extension.layer,
      name: extension.name,
      service: normalizedService as ExtensionServiceName,
      run: override,
    });
  };
  const registerRenderer = (format: OutputRendererFormat, renderer: RendererOverride): void => {
    assertExtensionCapability(extension, "renderers", "registerRenderer");
    if (!allowRegistration("renderers.override", "registerRenderer", "renderers")) {
      return;
    }
    if (typeof renderer !== "function") {
      throw new TypeError("registerRenderer requires a renderer function");
    }
    const normalizedFormat = String(format).trim().toLowerCase();
    if (!isOutputRendererFormat(normalizedFormat)) {
      throw new Error(`registerRenderer format must be toon|json, received: ${String(format)}`);
    }
    renderers.overrides.push({
      layer: extension.layer,
      name: extension.name,
      format: normalizedFormat,
      run: renderer,
    });
  };
  const registerFlags = (targetCommand: string, flags: FlagDefinition[]): void => {
    assertExtensionCapability(extension, "schema", "registerFlags");
    if (!allowRegistration("schema.flags", "registerFlags", "schema")) {
      return;
    }
    const normalizedTargetCommand = normalizeCommandName(assertNonEmptyString("registerFlags targetCommand", targetCommand));
    validateFlagDefinitions(flags);
    const normalizedFlags = normalizeRegistrationRecordList("registerFlags flags", flags);
    if (normalizedFlags.length === 0) {
      throw new TypeError("registerFlags requires at least one flag definition");
    }
    registrations.flags.push({
      layer: extension.layer,
      name: extension.name,
      target_command: normalizedTargetCommand,
      flags: normalizedFlags,
    });
  };
  const registerItemFields = (fields: SchemaFieldDefinition[]): void => {
    assertExtensionCapability(extension, "schema", "registerItemFields");
    if (!allowRegistration("schema.itemfields", "registerItemFields", "schema")) {
      return;
    }
    validateItemFieldDefinitions(fields);
    const normalizedFields = normalizeRegistrationRecordList(
      "registerItemFields fields",
      fields,
    ) as SchemaFieldDefinition[];
    if (normalizedFields.length === 0) {
      throw new TypeError("registerItemFields requires at least one field definition");
    }
    registrations.item_fields.push({
      layer: extension.layer,
      name: extension.name,
      fields: normalizedFields,
    });
  };
  const registerItemTypes = (types: SchemaItemTypeDefinition[]): void => {
    assertExtensionCapability(extension, "schema", "registerItemTypes");
    if (!allowRegistration("schema.itemtypes", "registerItemTypes", "schema")) {
      return;
    }
    validateItemTypeDefinitions(types);
    const normalizedTypes = normalizeRegistrationRecordList(
      "registerItemTypes types",
      types,
    ) as SchemaItemTypeDefinition[];
    if (normalizedTypes.length === 0) {
      throw new TypeError("registerItemTypes requires at least one type definition");
    }
    registrations.item_types.push({
      layer: extension.layer,
      name: extension.name,
      types: normalizedTypes,
    });
  };
  const registerMigration = (definition: SchemaMigrationDefinition): void => {
    assertExtensionCapability(extension, "schema", "registerMigration");
    if (!allowRegistration("schema.migrations", "registerMigration", "schema")) {
      return;
    }
    validateMigrationDefinition(definition);
    const runtimeDefinition = normalizeRuntimeRegistrationRecord("registerMigration definition", definition);
    registrations.migrations.push(
      attachRuntimeDefinition(
        {
          layer: extension.layer,
          name: extension.name,
          definition: normalizeRegistrationRecord("registerMigration definition", definition),
        },
        runtimeDefinition,
      ) as RegisteredExtensionSchemaMigrationDefinition,
    );
  };
  const registerImporter = (name: string, importer: Importer): void => {
    assertExtensionCapability(extension, "importers", "registerImporter");
    if (!allowRegistration("importers.importer", "registerImporter", "importers")) {
      return;
    }
    const normalizedName = normalizeRegistrationName(assertNonEmptyString("registerImporter name", name));
    assertFunctionHandler("registerImporter importer", importer);
    const commandPath = toRegistrationCommandPath(normalizedName, "import");
    registrations.importers.push({
      layer: extension.layer,
      name: extension.name,
      importer: normalizedName,
    });
    commands.handlers.push({
      layer: extension.layer,
      name: extension.name,
      command: commandPath,
      run: async (context) =>
        importer({
          registration: normalizedName,
          action: "import",
          command: context.command,
          args: cloneContextSnapshot(context.args),
          options: cloneContextSnapshot(context.options),
          global: cloneContextSnapshot(context.global),
          pm_root: context.pm_root,
        }),
    });
  };
  const registerExporter = (name: string, exporter: Exporter): void => {
    assertExtensionCapability(extension, "importers", "registerExporter");
    if (!allowRegistration("importers.exporter", "registerExporter", "importers")) {
      return;
    }
    const normalizedName = normalizeRegistrationName(assertNonEmptyString("registerExporter name", name));
    assertFunctionHandler("registerExporter exporter", exporter);
    const commandPath = toRegistrationCommandPath(normalizedName, "export");
    registrations.exporters.push({
      layer: extension.layer,
      name: extension.name,
      exporter: normalizedName,
    });
    commands.handlers.push({
      layer: extension.layer,
      name: extension.name,
      command: commandPath,
      run: async (context) =>
        exporter({
          registration: normalizedName,
          action: "export",
          command: context.command,
          args: cloneContextSnapshot(context.args),
          options: cloneContextSnapshot(context.options),
          global: cloneContextSnapshot(context.global),
          pm_root: context.pm_root,
        }),
    });
  };
  const registerSearchProvider = (provider: SearchProviderDefinition): void => {
    assertExtensionCapability(extension, "search", "registerSearchProvider");
    if (!allowRegistration("search.provider", "registerSearchProvider", "search")) {
      return;
    }
    const runtimeDefinition = normalizeRuntimeRegistrationRecord("registerSearchProvider provider", provider);
    registrations.search_providers.push(
      attachRuntimeDefinition(
        {
          layer: extension.layer,
          name: extension.name,
          definition: normalizeRegistrationRecord("registerSearchProvider provider", provider),
        },
        runtimeDefinition,
      ) as RegisteredExtensionSearchProvider,
    );
  };
  const registerVectorStoreAdapter = (adapter: VectorStoreAdapterDefinition): void => {
    assertExtensionCapability(extension, "search", "registerVectorStoreAdapter");
    if (!allowRegistration("search.vectorstore", "registerVectorStoreAdapter", "search")) {
      return;
    }
    const runtimeDefinition = normalizeRuntimeRegistrationRecord("registerVectorStoreAdapter adapter", adapter);
    registrations.vector_store_adapters.push(
      attachRuntimeDefinition(
        {
          layer: extension.layer,
          name: extension.name,
          definition: normalizeRegistrationRecord("registerVectorStoreAdapter adapter", adapter),
        },
        runtimeDefinition,
      ) as RegisteredExtensionVectorStoreAdapter,
    );
  };
  const registerBeforeCommand = (hook: BeforeCommandHook): void => {
    assertExtensionCapability(extension, "hooks", "api.hooks.beforeCommand");
    if (!allowRegistration("hooks.beforecommand", "api.hooks.beforeCommand", "hooks")) {
      return;
    }
    assertHookHandler("beforeCommand", hook);
    hooks.beforeCommand.push({
      layer: extension.layer,
      name: extension.name,
      run: hook,
    });
  };
  const registerAfterCommand = (hook: AfterCommandHook): void => {
    assertExtensionCapability(extension, "hooks", "api.hooks.afterCommand");
    if (!allowRegistration("hooks.aftercommand", "api.hooks.afterCommand", "hooks")) {
      return;
    }
    assertHookHandler("afterCommand", hook);
    hooks.afterCommand.push({
      layer: extension.layer,
      name: extension.name,
      run: hook,
    });
  };
  const registerOnWrite = (hook: OnWriteHook): void => {
    assertExtensionCapability(extension, "hooks", "api.hooks.onWrite");
    if (!allowRegistration("hooks.onwrite", "api.hooks.onWrite", "hooks")) {
      return;
    }
    assertHookHandler("onWrite", hook);
    hooks.onWrite.push({
      layer: extension.layer,
      name: extension.name,
      run: hook,
    });
  };
  const registerOnRead = (hook: OnReadHook): void => {
    assertExtensionCapability(extension, "hooks", "api.hooks.onRead");
    if (!allowRegistration("hooks.onread", "api.hooks.onRead", "hooks")) {
      return;
    }
    assertHookHandler("onRead", hook);
    hooks.onRead.push({
      layer: extension.layer,
      name: extension.name,
      run: hook,
    });
  };
  const registerOnIndex = (hook: OnIndexHook): void => {
    assertExtensionCapability(extension, "hooks", "api.hooks.onIndex");
    if (!allowRegistration("hooks.onindex", "api.hooks.onIndex", "hooks")) {
      return;
    }
    assertHookHandler("onIndex", hook);
    hooks.onIndex.push({
      layer: extension.layer,
      name: extension.name,
      run: hook,
    });
  };

  return {
    registerCommand,
    registerParser,
    registerPreflight,
    registerService,
    registerFlags,
    registerItemFields,
    registerItemTypes,
    registerMigration,
    registerRenderer,
    registerImporter,
    registerExporter,
    registerSearchProvider,
    registerVectorStoreAdapter,
    hooks: {
      beforeCommand: registerBeforeCommand,
      afterCommand: registerAfterCommand,
      onWrite: registerOnWrite,
      onRead: registerOnRead,
      onIndex: registerOnIndex,
    },
  };
}

async function executeRegisteredHooks<TContext>(
  entries: Array<RegisteredExtensionHook<(context: TContext) => Promise<void> | void>>,
  hookName: HookName,
  context: TContext,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const entry of entries) {
    try {
      await entry.run(cloneContextSnapshot(context));
    } catch {
      warnings.push(`extension_hook_failed:${entry.layer}:${entry.name}:${hookName}`);
    }
  }
  return warnings;
}

function getRegistrationCounts(registrations: ExtensionRegistrationRegistry): ExtensionRegistrationCounts {
  const commandCount = registrations.commands.length;
  const flagCount = registrations.flags.reduce((total, entry) => total + entry.flags.length, 0);
  const itemFieldCount = registrations.item_fields.reduce((total, entry) => total + entry.fields.length, 0);
  const itemTypeCount = registrations.item_types.reduce((total, entry) => total + entry.types.length, 0);
  return {
    commands: commandCount,
    flags: flagCount,
    item_fields: itemFieldCount,
    item_types: itemTypeCount,
    migrations: registrations.migrations.length,
    importers: registrations.importers.length,
    exporters: registrations.exporters.length,
    search_providers: registrations.search_providers.length,
    vector_store_adapters: registrations.vector_store_adapters.length,
  };
}

function collectCommandCollisionWarnings(commands: ExtensionCommandRegistry): string[] {
  const warnings: string[] = [];
  const collectByCommand = <TEntry extends { layer: ExtensionLayer; name: string; command: string }>(
    entries: TEntry[],
    codePrefix: string,
  ): void => {
    const grouped = new Map<string, TEntry[]>();
    for (const entry of entries) {
      const bucket = grouped.get(entry.command) ?? [];
      bucket.push(entry);
      grouped.set(entry.command, bucket);
    }
    for (const command of [...grouped.keys()].sort((left, right) => left.localeCompare(right))) {
      const bucket = grouped.get(command) ?? [];
      if (bucket.length <= 1) {
        continue;
      }
      const winner = bucket[bucket.length - 1];
      for (const displaced of bucket.slice(0, -1)) {
        warnings.push(
          `${codePrefix}:${command}:${winner.layer}:${winner.name}:${displaced.layer}:${displaced.name}`,
        );
      }
    }
  };

  collectByCommand(commands.handlers, "extension_command_handler_collision");
  collectByCommand(commands.overrides, "extension_command_override_collision");

  const handlerCommands = new Set(commands.handlers.map((entry) => entry.command));
  const overlapCommands = [...new Set(commands.overrides.map((entry) => entry.command))]
    .filter((command) => handlerCommands.has(command))
    .sort((left, right) => left.localeCompare(right));
  for (const command of overlapCommands) {
    warnings.push(`extension_command_override_handler_overlap:${command}`);
  }

  return warnings;
}

function collectRendererCollisionWarnings(renderers: ExtensionRendererRegistry): string[] {
  const grouped = new Map<OutputRendererFormat, RegisteredExtensionRendererOverride[]>();
  for (const entry of renderers.overrides) {
    const bucket = grouped.get(entry.format) ?? [];
    bucket.push(entry);
    grouped.set(entry.format, bucket);
  }
  const warnings: string[] = [];
  for (const format of [...grouped.keys()].sort((left, right) => left.localeCompare(right))) {
    const bucket = grouped.get(format) ?? [];
    if (bucket.length <= 1) {
      continue;
    }
    const winner = bucket[bucket.length - 1];
    for (const displaced of bucket.slice(0, -1)) {
      warnings.push(
        `extension_renderer_collision:${format}:${winner.layer}:${winner.name}:${displaced.layer}:${displaced.name}`,
      );
    }
  }
  return warnings;
}

function collectParserCollisionWarnings(parsers: ExtensionParserRegistry): string[] {
  const warnings: string[] = [];
  const grouped = new Map<string, RegisteredExtensionParserOverride[]>();
  for (const entry of parsers.overrides) {
    const bucket = grouped.get(entry.command) ?? [];
    bucket.push(entry);
    grouped.set(entry.command, bucket);
  }
  for (const command of [...grouped.keys()].sort((left, right) => left.localeCompare(right))) {
    const bucket = grouped.get(command) ?? [];
    if (bucket.length <= 1) {
      continue;
    }
    const winner = bucket[bucket.length - 1];
    for (const displaced of bucket.slice(0, -1)) {
      warnings.push(
        `extension_parser_override_collision:${command}:${winner.layer}:${winner.name}:${displaced.layer}:${displaced.name}`,
      );
    }
  }
  return warnings;
}

function collectPreflightCollisionWarnings(preflight: ExtensionPreflightRegistry): string[] {
  if (preflight.overrides.length <= 1) {
    return [];
  }
  const winner = preflight.overrides[preflight.overrides.length - 1];
  return preflight.overrides.slice(0, -1).map(
    (displaced) =>
      `extension_preflight_override_collision:${winner.layer}:${winner.name}:${displaced.layer}:${displaced.name}`,
  );
}

// Services whose runtime semantics are chain/fall-through (each override gets a chance);
// for those, registering multiple overrides is by design, not a collision.
const CHAINED_SERVICE_NAMES: ReadonlySet<ExtensionServiceName> = new Set<ExtensionServiceName>([
  "output_format",
]);

function collectServiceCollisionWarnings(services: ExtensionServiceRegistry): string[] {
  const warnings: string[] = [];
  const grouped = new Map<ExtensionServiceName, RegisteredExtensionServiceOverride[]>();
  for (const entry of services.overrides) {
    const bucket = grouped.get(entry.service) ?? [];
    bucket.push(entry);
    grouped.set(entry.service, bucket);
  }
  for (const service of [...grouped.keys()].sort((left, right) => left.localeCompare(right))) {
    const bucket = grouped.get(service) ?? [];
    if (bucket.length <= 1) {
      continue;
    }
    if (CHAINED_SERVICE_NAMES.has(service)) {
      continue;
    }
    const winner = bucket[bucket.length - 1];
    for (const displaced of bucket.slice(0, -1)) {
      warnings.push(
        `extension_service_override_collision:${service}:${winner.layer}:${winner.name}:${displaced.layer}:${displaced.name}`,
      );
    }
  }
  return warnings;
}

export async function activateExtensions(loadResult: ExtensionLoadResult): Promise<ExtensionActivationResult> {
  const policy = hydrateExtensionPolicy(loadResult.policy ?? DEFAULT_EXTENSION_POLICY);
  const hooks = createEmptyExtensionHookRegistry();
  const commands = createEmptyExtensionCommandRegistry();
  const parsers = createEmptyExtensionParserRegistry();
  const preflight = createEmptyExtensionPreflightRegistry();
  const services = createEmptyExtensionServiceRegistry();
  const renderers = createEmptyExtensionRendererRegistry();
  const registrations = createEmptyExtensionRegistrationRegistry();
  const failed: FailedExtensionActivation[] = [];
  const warnings: string[] = [];

  for (const extension of loadResult.loaded) {
    const activatable = resolveActivatableExtension(extension.module);
    if (!activatable) {
      continue;
    }

    try {
      await activatable.activate(
        createExtensionApi(
          extension,
          hooks,
          commands,
          parsers,
          preflight,
          services,
          renderers,
          registrations,
          warnings,
          policy,
        ),
      );
    } catch (error: unknown) {
      warnings.push(`extension_activate_failed:${extension.layer}:${extension.name}`);
      const trace = extractRegistrationValidationTrace(error);
      failed.push({
        layer: extension.layer,
        name: extension.name,
        entry_path: extension.entry_path,
        error: formatUnknownError(error),
        trace,
      });
    }
  }

  const collisionWarnings = [
    ...collectCommandCollisionWarnings(commands),
    ...collectParserCollisionWarnings(parsers),
    ...collectPreflightCollisionWarnings(preflight),
    ...collectServiceCollisionWarnings(services),
    ...collectRendererCollisionWarnings(renderers),
  ];
  const mergedWarnings = [...new Set([...warnings, ...collisionWarnings])];

  return {
    hooks,
    commands,
    parsers,
    preflight,
    services,
    renderers,
    registrations,
    failed,
    warnings: mergedWarnings,
    hook_counts: {
      before_command: hooks.beforeCommand.length,
      after_command: hooks.afterCommand.length,
      on_write: hooks.onWrite.length,
      on_read: hooks.onRead.length,
      on_index: hooks.onIndex.length,
    },
    command_override_count: commands.overrides.length,
    command_handler_count: commands.handlers.length,
    parser_override_count: parsers.overrides.length,
    preflight_override_count: preflight.overrides.length,
    service_override_count: services.overrides.length,
    renderer_override_count: renderers.overrides.length,
    registration_counts: getRegistrationCounts(registrations),
  };
}

export async function runBeforeCommandHooks(
  hooks: ExtensionHookRegistry,
  context: BeforeCommandHookContext,
): Promise<string[]> {
  return executeRegisteredHooks(hooks.beforeCommand, "beforeCommand", context);
}

export async function runAfterCommandHooks(
  hooks: ExtensionHookRegistry,
  context: AfterCommandHookContext,
): Promise<string[]> {
  return executeRegisteredHooks(hooks.afterCommand, "afterCommand", context);
}

export async function runOnWriteHooks(hooks: ExtensionHookRegistry, context: OnWriteHookContext): Promise<string[]> {
  return executeRegisteredHooks(hooks.onWrite, "onWrite", context);
}

export async function runOnReadHooks(hooks: ExtensionHookRegistry, context: OnReadHookContext): Promise<string[]> {
  return executeRegisteredHooks(hooks.onRead, "onRead", context);
}

export async function runOnIndexHooks(hooks: ExtensionHookRegistry, context: OnIndexHookContext): Promise<string[]> {
  return executeRegisteredHooks(hooks.onIndex, "onIndex", context);
}



export async function runCommandHandler(
  commands: ExtensionCommandRegistry,
  context: CommandHandlerContext,
): Promise<CommandHandlerResult> {
  const command = normalizeCommandName(context.command);
  if (command.length === 0) {
    return {
      handled: false,
      result: null,
      warnings: [],
    };
  }

  const matched = [...commands.handlers].reverse().find((entry) => entry.command === command);
  if (!matched) {
    return {
      handled: false,
      result: null,
      warnings: [],
    };
  }

  try {
    const result = await matched.run({
      command,
      args: cloneContextSnapshot(context.args),
      options: cloneContextSnapshot(context.options),
      global: cloneContextSnapshot(context.global),
      pm_root: context.pm_root,
    });
    return {
      handled: true,
      result,
      warnings: [],
    };
  } catch (error: unknown) {
    const exitCode =
      typeof error === "object" && error !== null && "exitCode" in error
        ? (error as { exitCode?: unknown }).exitCode
        : undefined;
    if (typeof exitCode === "number" && Number.isFinite(exitCode)) {
      throw error;
    }
    return {
      handled: false,
      result: null,
      warnings: [`extension_command_handler_failed:${matched.layer}:${matched.name}:${matched.command}`],
    };
  }
}


export async function runParserOverride(
  parsers: ExtensionParserRegistry,
  context: ParserOverrideContext,
): Promise<ParserOverrideResult> {
  const command = normalizeCommandName(context.command);
  if (command.length === 0) {
    return {
      overridden: false,
      context: {
        command,
        args: cloneContextSnapshot(context.args),
        options: cloneCommandOptionsSnapshot(context.options),
        global: cloneGlobalOptionsSnapshot(context.global),
        pm_root: context.pm_root,
      },
      warnings: [],
    };
  }

  const matched = [...parsers.overrides].reverse().find((entry) => entry.command === command);
  if (!matched) {
    return {
      overridden: false,
      context: {
        command,
        args: cloneContextSnapshot(context.args),
        options: cloneCommandOptionsSnapshot(context.options),
        global: cloneGlobalOptionsSnapshot(context.global),
        pm_root: context.pm_root,
      },
      warnings: [],
    };
  }

  try {
    const delta = (await Promise.resolve(
      matched.run({
        command,
        args: cloneContextSnapshot(context.args),
        options: cloneCommandOptionsSnapshot(context.options),
        global: cloneGlobalOptionsSnapshot(context.global),
        pm_root: context.pm_root,
      }),
    )) ?? {};
    const nextArgs = Array.isArray(delta.args) ? cloneContextSnapshot(delta.args) : cloneContextSnapshot(context.args);
    const nextOptions = delta.options ? cloneCommandOptionsSnapshot(delta.options) : cloneCommandOptionsSnapshot(context.options);
    const nextGlobal = delta.global ? cloneGlobalOptionsSnapshot(delta.global) : cloneGlobalOptionsSnapshot(context.global);
    return {
      overridden: true,
      context: {
        command,
        args: nextArgs,
        options: nextOptions,
        global: nextGlobal,
        pm_root: context.pm_root,
      },
      warnings: [],
    };
  } catch {
    return {
      overridden: false,
      context: {
        command,
        args: cloneContextSnapshot(context.args),
        options: cloneCommandOptionsSnapshot(context.options),
        global: cloneGlobalOptionsSnapshot(context.global),
        pm_root: context.pm_root,
      },
      warnings: [`extension_parser_override_failed:${matched.layer}:${matched.name}:${matched.command}`],
    };
  }
}


export async function runPreflightOverride(
  preflight: ExtensionPreflightRegistry,
  context: PreflightOverrideContext,
): Promise<PreflightOverrideResult> {
  const matched = [...preflight.overrides].reverse()[0];
  const baseContext: CommandHandlerContext = {
    command: normalizeCommandName(context.command),
    args: cloneContextSnapshot(context.args),
    options: cloneCommandOptionsSnapshot(context.options),
    global: cloneGlobalOptionsSnapshot(context.global),
    pm_root: context.pm_root,
  };
  const baseDecision: PreflightRuntimeDecision = cloneContextSnapshot(context.decision);
  if (!matched) {
    return {
      overridden: false,
      context: baseContext,
      decision: baseDecision,
      warnings: [],
    };
  }

  try {
    const delta = (await Promise.resolve(
      matched.run({
        command: baseContext.command,
        args: cloneContextSnapshot(baseContext.args),
        options: cloneCommandOptionsSnapshot(baseContext.options),
        global: cloneGlobalOptionsSnapshot(baseContext.global),
        pm_root: baseContext.pm_root,
        decision: cloneContextSnapshot(baseDecision),
      }),
    )) ?? {};
    const nextContext: CommandHandlerContext = {
      command: baseContext.command,
      args: Array.isArray(delta.args) ? cloneContextSnapshot(delta.args) : baseContext.args,
      options: delta.options ? cloneCommandOptionsSnapshot(delta.options) : baseContext.options,
      global: delta.global ? cloneGlobalOptionsSnapshot(delta.global) : baseContext.global,
      pm_root: baseContext.pm_root,
    };
    const nextDecision: PreflightRuntimeDecision = {
      enforce_item_format_gate:
        typeof delta.enforce_item_format_gate === "boolean"
          ? delta.enforce_item_format_gate
          : baseDecision.enforce_item_format_gate,
      run_preflight_item_format_sync:
        typeof delta.run_preflight_item_format_sync === "boolean"
          ? delta.run_preflight_item_format_sync
          : baseDecision.run_preflight_item_format_sync,
      run_extension_migrations:
        typeof delta.run_extension_migrations === "boolean"
          ? delta.run_extension_migrations
          : baseDecision.run_extension_migrations,
      enforce_mandatory_migration_gate:
        typeof delta.enforce_mandatory_migration_gate === "boolean"
          ? delta.enforce_mandatory_migration_gate
          : baseDecision.enforce_mandatory_migration_gate,
    };
    return {
      overridden: true,
      context: nextContext,
      decision: nextDecision,
      warnings: [],
    };
  } catch {
    return {
      overridden: false,
      context: baseContext,
      decision: baseDecision,
      warnings: [`extension_preflight_override_failed:${matched.layer}:${matched.name}`],
    };
  }
}


function resolveDefaultServiceResult(context: ServiceOverrideContext): ServiceOverrideResult {
  return {
    handled: false,
    result: context.payload,
    warnings: [],
  };
}

export function runServiceOverrideSync(
  services: ExtensionServiceRegistry,
  context: ServiceOverrideContext,
): ServiceOverrideResult {
  const matches = [...services.overrides].reverse().filter((entry) => entry.service === context.service);
  if (matches.length === 0) {
    return resolveDefaultServiceResult(context);
  }

  const warnings: string[] = [];
  for (const matched of matches) {
    try {
      const serviceContext = {
        service: context.service,
        command: context.command ? normalizeCommandName(context.command) : undefined,
        args: context.args ? cloneContextSnapshot(context.args) : undefined,
        options: context.options ? cloneCommandOptionsSnapshot(context.options) : undefined,
        global: context.global ? cloneGlobalOptionsSnapshot(context.global) : undefined,
        pm_root: context.pm_root,
        payload: cloneContextSnapshot(context.payload),
      };
      const result = matched.run(serviceContext);
      if (result instanceof Promise) {
        warnings.push(`extension_service_override_async_unsupported:${matched.layer}:${matched.name}:${matched.service}`);
        continue;
      }
      if (context.service === "output_format" && (result === null || result === undefined || result === serviceContext.payload)) {
        continue;
      }
      return {
        handled: true,
        result,
        warnings,
      };
    } catch {
      warnings.push(`extension_service_override_failed:${matched.layer}:${matched.name}:${matched.service}`);
    }
  }
  return {
    handled: false,
    result: context.payload,
    warnings,
  };
}

export async function runServiceOverride(
  services: ExtensionServiceRegistry,
  context: ServiceOverrideContext,
): Promise<ServiceOverrideResult> {
  const matches = [...services.overrides].reverse().filter((entry) => entry.service === context.service);
  if (matches.length === 0) {
    return resolveDefaultServiceResult(context);
  }

  const warnings: string[] = [];
  for (const matched of matches) {
    try {
      const serviceContext = {
        service: context.service,
        command: context.command ? normalizeCommandName(context.command) : undefined,
        args: context.args ? cloneContextSnapshot(context.args) : undefined,
        options: context.options ? cloneCommandOptionsSnapshot(context.options) : undefined,
        global: context.global ? cloneGlobalOptionsSnapshot(context.global) : undefined,
        pm_root: context.pm_root,
        payload: cloneContextSnapshot(context.payload),
      };
      const result = await Promise.resolve(matched.run(serviceContext));
      if (context.service === "output_format" && (result === null || result === undefined || result === serviceContext.payload)) {
        continue;
      }
      return {
        handled: true,
        result,
        warnings,
      };
    } catch {
      warnings.push(`extension_service_override_failed:${matched.layer}:${matched.name}:${matched.service}`);
    }
  }
  return {
    handled: false,
    result: context.payload,
    warnings,
  };
}

export function runCommandOverride(
  commands: ExtensionCommandRegistry,
  context: CommandOverrideContext,
): CommandOverrideResult {
  const command = normalizeCommandName(context.command);
  if (command.length === 0) {
    return {
      overridden: false,
      result: context.result,
      warnings: [],
    };
  }

  const matched = [...commands.overrides].reverse().find((entry) => entry.command === command);
  if (!matched) {
    return {
      overridden: false,
      result: context.result,
      warnings: [],
    };
  }

  try {
    const overrideOptions = cloneCommandOptionsSnapshot(context.options);
    const overrideGlobal = cloneGlobalOptionsSnapshot(context.global);
    const overrideResult = matched.run({
      command,
      args: cloneContextSnapshot(context.args),
      options: overrideOptions,
      global: overrideGlobal,
      pm_root: context.pm_root,
      result: cloneContextSnapshot(context.result),
    });
    if (overrideResult instanceof Promise) {
      return {
        overridden: false,
        result: context.result,
        warnings: [`extension_command_override_async_unsupported:${matched.layer}:${matched.name}:${matched.command}`],
      };
    }
    return {
      overridden: true,
      result: overrideResult,
      warnings: [],
    };
  } catch {
    return {
      overridden: false,
      result: context.result,
      warnings: [`extension_command_override_failed:${matched.layer}:${matched.name}:${matched.command}`],
    };
  }
}


export function runRendererOverride(
  renderers: ExtensionRendererRegistry,
  context: RendererOverrideContext,
): RendererOverrideResult {
  const matched = [...renderers.overrides].reverse().find((entry) => entry.format === context.format);
  if (!matched) {
    return {
      overridden: false,
      rendered: null,
      warnings: [],
    };
  }

  try {
    const rendererCommand = typeof context.command === "string" ? normalizeCommandName(context.command) : "";
    const rendererArgs = Array.isArray(context.args) ? cloneContextSnapshot(context.args) : [];
    const rendererOptions = cloneCommandOptionsSnapshot(context.options);
    const rendererGlobal = cloneGlobalOptionsSnapshot(context.global);
    const rendererPmRoot = typeof context.pm_root === "string" ? context.pm_root : "";
    const rendered = matched.run({
      format: context.format,
      command: rendererCommand,
      args: rendererArgs,
      options: rendererOptions,
      global: rendererGlobal,
      pm_root: rendererPmRoot,
      result: cloneContextSnapshot(context.result),
    });
    if (typeof rendered !== "string") {
      return {
        overridden: false,
        rendered: null,
        warnings: [`extension_renderer_invalid_result:${matched.layer}:${matched.name}:${matched.format}`],
      };
    }
    return {
      overridden: true,
      rendered,
      warnings: [],
    };
  } catch {
    return {
      overridden: false,
      rendered: null,
      warnings: [`extension_renderer_failed:${matched.layer}:${matched.name}:${matched.format}`],
    };
  }
}
