/**
 * @module core/extensions/manifest-parser
 * Parses manifest metadata without loading extension code.
 */
import {
  asRecordLoose
} from "../shared/primitives.js";
import { normalizeExtensionContributionInventory } from "./contribution-inventory.js";
import {
  normalizeManifestCapabilities
} from "./extension-capability-aliases.js";
import {
  normalizePolicySandboxProfile
} from "./extension-policy.js";
import { normalizeCommandName } from "./extension-runtime-helpers.js";
import {
  type ExtensionManifest,
  type ExtensionManifestEngines,
  type ExtensionSandboxProfile,
  type LegacyExtensionCapabilityAliasMapping
} from "./extension-types.js";

/** Fallback extension priority used when callers do not provide an override. */
export const DEFAULT_EXTENSION_PRIORITY = 100;

function parseOptionalManifestString(
  candidate: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = candidate[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

function parseManifestEngines(
  value: unknown,
): ExtensionManifestEngines | null | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const enginesRecord = asRecordLoose(value);
  if (!enginesRecord) {
    return null;
  }
  const engines: ExtensionManifestEngines = {};
  for (const key of Object.keys(enginesRecord).sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (key.trim().length === 0) {
      return null;
    }
    const engineValue = enginesRecord[key];
    if (typeof engineValue !== "string" || engineValue.trim().length === 0) {
      return null;
    }
    engines[key.trim()] = engineValue.trim();
  }
  return Object.keys(engines).length > 0 ? engines : undefined;
}

/** Parse a required manifest string field, returning `null` when it is absent, non-string, or blank. */
function parseRequiredManifestString(
  candidate: Record<string, unknown>,
  field: string,
): string | null {
  const value = candidate[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

/** Parse an optional integer value (`undefined` when absent, `null` when present but not an integer). */
function parseOptionalIntegerValue(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

/** Parse an optional boolean value (`undefined` when absent, `null` when present but not a boolean). */
function parseOptionalBooleanValue(value: unknown): boolean | null | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    return null;
  }
  return value;
}

/** Parse the optional integer `priority`, defaulting to {@link DEFAULT_EXTENSION_PRIORITY} when absent and rejecting (`null`) a non-integer. */
function parseManifestPriority(
  candidate: Record<string, unknown>,
): number | null {
  const value = parseOptionalIntegerValue(candidate.priority);
  return value === undefined ? DEFAULT_EXTENSION_PRIORITY : value;
}

/** Parse the optional `sandbox_profile`, rejecting (`null`) any value that does not round-trip through {@link normalizePolicySandboxProfile}. */
function parseManifestSandboxProfile(
  candidate: Record<string, unknown>,
): ExtensionSandboxProfile | null | undefined {
  const value = candidate.sandbox_profile;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalizedProfile = normalizePolicySandboxProfile(value);
  if (normalizedProfile !== value.trim().toLowerCase()) {
    return null;
  }
  return normalizedProfile;
}

/** Return the trimmed string when `value` is a non-blank string, otherwise `undefined`. */
function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Parse the optional `provenance` record (`undefined` absent, `null` malformed), keeping only the present trimmed string fields and a boolean `verified`. */
function parseManifestProvenance(
  value: unknown,
): ExtensionManifest["provenance"] | null | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const provenanceRecord = asRecordLoose(value);
  if (!provenanceRecord) {
    return null;
  }
  const source = optionalTrimmedString(provenanceRecord.source);
  const signature = optionalTrimmedString(provenanceRecord.signature);
  const attestation = optionalTrimmedString(provenanceRecord.attestation);
  const verified =
    provenanceRecord.verified === undefined ||
    provenanceRecord.verified === null
      ? undefined
      : typeof provenanceRecord.verified === "boolean"
        ? provenanceRecord.verified
        : null;
  if (verified === null) {
    return null;
  }
  return {
    ...(source ? { source } : {}),
    ...(signature ? { signature } : {}),
    ...(attestation ? { attestation } : {}),
    ...(typeof verified === "boolean" ? { verified } : {}),
  };
}

/** Parse the optional `permissions` record (`undefined` absent, `null` malformed), keeping only the boolean grants that are present. */
function parseManifestPermissions(
  value: unknown,
): ExtensionManifest["permissions"] | null | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const permissionsRecord = asRecordLoose(value);
  if (!permissionsRecord) {
    return null;
  }
  const fsRead = parseOptionalBooleanValue(permissionsRecord.fs_read);
  const fsWrite = parseOptionalBooleanValue(permissionsRecord.fs_write);
  const network = parseOptionalBooleanValue(permissionsRecord.network);
  const envRead = parseOptionalBooleanValue(permissionsRecord.env_read);
  const envWrite = parseOptionalBooleanValue(permissionsRecord.env_write);
  const processSpawn = parseOptionalBooleanValue(
    permissionsRecord.process_spawn,
  );
  if (
    [fsRead, fsWrite, network, envRead, envWrite, processSpawn].includes(null)
  ) {
    return null;
  }
  return {
    ...(typeof fsRead === "boolean" ? { fs_read: fsRead } : {}),
    ...(typeof fsWrite === "boolean" ? { fs_write: fsWrite } : {}),
    ...(typeof network === "boolean" ? { network } : {}),
    ...(typeof envRead === "boolean" ? { env_read: envRead } : {}),
    ...(typeof envWrite === "boolean" ? { env_write: envWrite } : {}),
    ...(typeof processSpawn === "boolean"
      ? { process_spawn: processSpawn }
      : {}),
  };
}

/** Parse the optional `capabilities` array, normalizing legacy aliases; returns empty lists when absent and `null` when the field is not a string array. */
function parseManifestCapabilities(value: unknown): {
  capabilities: string[];
  legacy_aliases: LegacyExtensionCapabilityAliasMapping[];
} | null {
  if (value === undefined || value === null) {
    return { capabilities: [], legacy_aliases: [] };
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    return null;
  }
  const normalizedCapabilities = normalizeManifestCapabilities(
    value as string[],
  );
  return {
    capabilities: normalizedCapabilities.capabilities,
    legacy_aliases: normalizedCapabilities.legacy_aliases,
  };
}

/** Parse the optional `activation` block, returning the de-duplicated sorted `commands` set, `undefined` when no command activation is declared, and `null` when the block is malformed. */
function parseManifestActivation(
  value: unknown,
): ExtensionManifest["activation"] | null | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const activationRecord = asRecordLoose(value);
  if (!activationRecord) {
    return null;
  }
  const rawCommands = activationRecord.commands;
  if (rawCommands === undefined || rawCommands === null) {
    return undefined;
  }
  if (
    !Array.isArray(rawCommands) ||
    rawCommands.some((entry) => typeof entry !== "string")
  ) {
    return null;
  }
  const commands = [
    ...new Set(
      rawCommands
        .map((entry) => normalizeCommandName(entry))
        .filter((entry) => entry.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right));
  return commands.length > 0 ? { commands } : undefined;
}

/** The optional metadata fields a manifest may declare, parsed and validated as a single bundle so {@link parseManifest} stays a thin orchestrator. */
interface ParsedManifestMetadata {
  manifest_version: number | undefined;
  pm_min_version: string | undefined;
  pm_max_version: string | undefined;
  engines: ExtensionManifestEngines | undefined;
  trusted: boolean | undefined;
  sandbox_profile: ExtensionSandboxProfile | undefined;
  provenance: ExtensionManifest["provenance"];
  permissions: ExtensionManifest["permissions"];
  capabilities: string[];
  legacy_capability_aliases: LegacyExtensionCapabilityAliasMapping[];
  activation: ExtensionManifest["activation"];
  contributions: ExtensionManifest["contributions"];
}

/** Parse every optional manifest metadata field, returning `null` as soon as any one is malformed. */
function parseManifestMetadata(
  candidate: Record<string, unknown>,
): ParsedManifestMetadata | null {
  const manifestVersion = parseOptionalIntegerValue(candidate.manifest_version);
  if (manifestVersion === null) {
    return null;
  }
  const pmMinVersion = parseOptionalManifestString(candidate, "pm_min_version");
  if (pmMinVersion === null) {
    return null;
  }
  const pmMaxVersion = parseOptionalManifestString(candidate, "pm_max_version");
  if (pmMaxVersion === null) {
    return null;
  }
  const engines = parseManifestEngines(candidate.engines);
  if (engines === null) {
    return null;
  }
  const trusted = parseOptionalBooleanValue(candidate.trusted);
  if (trusted === null) {
    return null;
  }
  const sandboxProfile = parseManifestSandboxProfile(candidate);
  if (sandboxProfile === null) {
    return null;
  }
  const provenance = parseManifestProvenance(candidate.provenance);
  if (provenance === null) {
    return null;
  }
  const permissions = parseManifestPermissions(candidate.permissions);
  if (permissions === null) {
    return null;
  }
  const capabilities = parseManifestCapabilities(candidate.capabilities);
  if (capabilities === null) {
    return null;
  }
  const activation = parseManifestActivation(candidate.activation);
  if (activation === null) {
    return null;
  }
  const contributions = normalizeExtensionContributionInventory(
    candidate.contributions,
  );
  if (contributions === null) {
    return null;
  }
  return {
    manifest_version: manifestVersion,
    pm_min_version: pmMinVersion,
    pm_max_version: pmMaxVersion,
    engines,
    trusted,
    sandbox_profile: sandboxProfile,
    provenance,
    permissions,
    capabilities: capabilities.capabilities,
    legacy_capability_aliases: capabilities.legacy_aliases,
    activation,
    contributions,
  };
}

/** Parse and normalize one complete on-disk extension manifest contract. */
export function parseExtensionManifestDocument(
  raw: unknown,
): ExtensionManifest | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  const name = parseRequiredManifestString(candidate, "name");
  if (name === null) {
    return null;
  }
  const version = parseRequiredManifestString(candidate, "version");
  if (version === null) {
    return null;
  }
  const entry = parseRequiredManifestString(candidate, "entry");
  if (entry === null) {
    return null;
  }
  const priority = parseManifestPriority(candidate);
  if (priority === null) {
    return null;
  }
  const metadata = parseManifestMetadata(candidate);
  if (metadata === null) {
    return null;
  }
  return {
    name,
    version,
    entry,
    priority,
    manifest_version: metadata.manifest_version,
    pm_min_version: metadata.pm_min_version,
    pm_max_version: metadata.pm_max_version,
    engines: metadata.engines,
    trusted: metadata.trusted,
    provenance: metadata.provenance,
    sandbox_profile: metadata.sandbox_profile,
    permissions: metadata.permissions,
    activation: metadata.activation,
    contributions: metadata.contributions,
    capabilities: metadata.capabilities,
    legacy_capability_aliases:
      metadata.legacy_capability_aliases.length > 0
        ? metadata.legacy_capability_aliases
        : undefined,
  };
}
