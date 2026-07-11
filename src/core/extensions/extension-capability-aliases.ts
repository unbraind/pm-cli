/**
 * @module core/extensions/extension-capability-aliases
 *
 * Implements extension runtime contracts and governance for Extension Capability Aliases.
 */
import {
  KNOWN_EXTENSION_CAPABILITIES,
  EXTENSION_CAPABILITY_CONTRACT_VERSION,
  EXTENSION_CAPABILITY_LEGACY_ALIASES,
  type ExtensionCapability,
  type ExtensionLayer,
  type LegacyExtensionCapabilityAliasMapping,
  type UnknownExtensionCapabilityWarningDetails,
} from "./extension-types.js";
import { levenshteinDistanceWithinLimit } from "../shared/levenshtein.js";

/** Implements normalize names for the public runtime surface of this module. */
export function normalizeNames(values: string[]): string[] {
  return [
    ...new Set(
      values.map((value) => value.trim()).filter((value) => value.length > 0),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

/** Implements check whether known extension capability for the public runtime surface of this module. */
export function isKnownExtensionCapability(
  value: string,
): value is ExtensionCapability {
  return (KNOWN_EXTENSION_CAPABILITIES as readonly string[]).includes(value);
}

/** Trim and lower-case a capability token, returning it only when it is a known canonical capability (otherwise `null`). Shared so capability normalization and known-capability filtering stay identical across the doctor and the SDK least-privilege helpers. */
export function normalizeKnownExtensionCapability(
  value: string,
): ExtensionCapability | null {
  const normalized = value.trim().toLowerCase();
  return isKnownExtensionCapability(normalized) ? normalized : null;
}

/** Implements collect unknown extension capabilities for the public runtime surface of this module. */
export function collectUnknownExtensionCapabilities(
  capabilities: readonly string[],
): string[] {
  return capabilities.filter(
    (capability) => !isKnownExtensionCapability(capability),
  );
}

/** Implements resolve legacy extension capability alias for the public runtime surface of this module. */
export function resolveLegacyExtensionCapabilityAlias(
  capability: string,
): ExtensionCapability | null {
  const normalized = capability.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }
  return EXTENSION_CAPABILITY_LEGACY_ALIASES[normalized] ?? null;
}

/** Implements normalize manifest capabilities for the public runtime surface of this module. */
export function normalizeManifestCapabilities(
  rawCapabilities: readonly string[],
): {
  capabilities: string[];
  legacy_aliases: LegacyExtensionCapabilityAliasMapping[];
} {
  const normalizedCapabilities = normalizeNames(
    [...rawCapabilities].map((value) => value.toLowerCase()),
  );
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
  const dedupedLegacyAliases = [
    ...new Map(
      legacyAliases.map((entry) => [`${entry.alias}>${entry.target}`, entry]),
    ).values(),
  ].sort((left, right) => left.alias.localeCompare(right.alias));
  return {
    capabilities: normalizeNames(remappedCapabilities),
    legacy_aliases: dedupedLegacyAliases,
  };
}

/** Implements suggest known extension capability for the public runtime surface of this module. */
export function suggestKnownExtensionCapability(
  capability: string,
): string | null {
  const normalized = capability.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }
  const legacyAlias = resolveLegacyExtensionCapabilityAlias(normalized);
  if (legacyAlias) {
    return legacyAlias;
  }
  const maxDistance = Math.max(1, Math.floor(normalized.length * 0.34));
  let bestMatch: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of KNOWN_EXTENSION_CAPABILITIES) {
    const distance = levenshteinDistanceWithinLimit(
      normalized,
      candidate,
      maxDistance,
    );
    if (distance !== null && distance < bestDistance) {
      bestDistance = distance;
      bestMatch = candidate;
    }
  }
  return bestMatch;
}

/** Implements format unknown extension capability warning for the public runtime surface of this module. */
export function formatUnknownExtensionCapabilityWarning(
  layer: ExtensionLayer,
  name: string,
  capability: string,
): string {
  const allowed = KNOWN_EXTENSION_CAPABILITIES.join(",");
  const suggested = suggestKnownExtensionCapability(capability) ?? "none";
  return `extension_capability_unknown:${layer}:${name}:${capability}:allowed=${allowed}:suggested=${suggested}`;
}

/** Implements format legacy extension capability alias warning for the public runtime surface of this module. */
export function formatLegacyExtensionCapabilityAliasWarning(
  layer: ExtensionLayer,
  name: string,
  aliases: readonly LegacyExtensionCapabilityAliasMapping[],
): string {
  const aliasesToken = aliases
    .map((entry) => `${entry.alias}>${entry.target}`)
    .join(",");
  return `extension_capability_legacy_alias:${layer}:${name}:aliases=${aliasesToken}`;
}

/** Implements parse unknown extension capability warning for the public runtime surface of this module. */
export function parseUnknownExtensionCapabilityWarning(
  warning: string,
): UnknownExtensionCapabilityWarningDetails | null {
  const match =
    /^extension_capability_unknown:(global|project):([^:]+):([^:]+):allowed=([^:]+):suggested=([^:]+)$/.exec(
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
  const suggestedFromWarning =
    suggestedRaw === "none" ? undefined : suggestedRaw;
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

/** Implements parse legacy extension capability alias warning for the public runtime surface of this module. */
export function parseLegacyExtensionCapabilityAliasWarning(
  warning: string,
): UnknownExtensionCapabilityWarningDetails[] {
  const match =
    /^extension_capability_legacy_alias:(global|project):([^:]+):aliases=(.+)$/.exec(
      warning.trim(),
    );
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
