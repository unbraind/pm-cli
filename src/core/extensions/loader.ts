/**
 * @module core/extensions/loader
 *
 * Implements extension runtime contracts and governance for Loader.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pathExists } from "../fs/fs-utils.js";
import { isPathWithinDirectory } from "../fs/path-utils.js";
import { resolvePmPackageRootFromModule } from "../packages/root.js";
import { resolveGlobalPmRoot } from "../store/paths.js";
import {
  asRecordLoose,
  resolveActivatablePropertyRecord,
} from "../shared/primitives.js";
import {
  flattenFlagListValue,
  isFlagDefaultValueCoercible,
  resolveFlagValueKind,
} from "./flag-value-types.js";
import {
  KNOWN_ITEM_FIELD_TYPES,
  normalizeItemFieldType,
  suggestKnownItemFieldType,
} from "./item-field-types.js";
import {
  compareComparableVersions,
  evaluatePmMaxVersionBound,
  evaluatePmMinVersionBound,
  parseComparableVersion,
  type PmVersionBoundEvaluation,
} from "./version-compat.js";
import type {
  ProjectProfileDefinition,
  ProjectProfileRegistrationInput,
} from "../profile/profile-presets.js";
// Cohesive helper groups now live in sibling modules. They are imported for the
// discovery/activation code that stays here and re-exported below so existing
// import sites (sdk/index.ts, commands/extension.ts, health.ts, tests, …) keep
// importing everything from "./loader.js" unchanged.
import {
  normalizeNames,
  isKnownExtensionCapability,
  collectUnknownExtensionCapabilities,
  normalizeManifestCapabilities,
  formatUnknownExtensionCapabilityWarning,
  formatLegacyExtensionCapabilityAliasWarning,
} from "./extension-capability-aliases.js";
import {
  normalizeExtensionPolicy,
  serializeExtensionPolicy,
  hydrateExtensionPolicy,
  normalizePolicySandboxProfile,
  evaluateExtensionPolicyForExtension,
  evaluateExtensionPolicyForCapability,
  evaluateExtensionPolicyForRegistration,
  type NormalizedExtensionPolicy,
  type PolicyExtensionRef,
} from "./extension-policy.js";
import {
  createEmptyExtensionHookRegistry,
  createEmptyExtensionCommandRegistry,
  createEmptyExtensionParserRegistry,
  createEmptyExtensionPreflightRegistry,
  createEmptyExtensionServiceRegistry,
  createEmptyExtensionRendererRegistry,
  createEmptyExtensionRegistrationRegistry,
} from "./extension-registries.js";
import {
  normalizeCommandName,
  cloneContextSnapshot,
} from "./extension-runtime-helpers.js";
export {
  parseUnknownExtensionCapabilityWarning,
  parseLegacyExtensionCapabilityAliasWarning,
} from "./extension-capability-aliases.js";
export {
  createEmptyExtensionHookRegistry,
  createEmptyExtensionCommandRegistry,
  createEmptyExtensionParserRegistry,
  createEmptyExtensionPreflightRegistry,
  createEmptyExtensionServiceRegistry,
  createEmptyExtensionRendererRegistry,
  createEmptyExtensionRegistrationRegistry,
} from "./extension-registries.js";
export {
  runBeforeCommandHooks,
  runAfterCommandHooks,
  runOnWriteHooks,
  runOnReadHooks,
  runOnIndexHooks,
  runCommandHandler,
  runParserOverride,
  runPreflightOverride,
  runServiceOverrideSync,
  runServiceOverride,
  runCommandOverride,
  runRendererOverride,
} from "./extension-hook-runtime.js";
import {
  KNOWN_EXTENSION_CAPABILITIES,
  KNOWN_EXTENSION_SERVICE_NAMES,
  createDefaultExtensionGovernancePolicy,
  type ExtensionDeactivationFailure,
  type ExtensionDeactivationOptions,
  type ExtensionDeactivationResult,
  type ExtensionSelfIdentity,
  type ExtensionCapability,
  type ExtensionPolicySurface,
  type ExtensionSandboxProfile,
  type ExtensionGovernancePolicy,
  type PmMaxVersionExceededMode,
  type ExtensionLayer,
  type ExtensionManifest,
  type ExtensionManifestEngines,
  type ExtensionDiagnostic,
  type EffectiveExtension,
  type ExtensionDiscoveryResult,
  type LoadedExtension,
  type FailedExtensionLoad,
  type ExtensionLoadResult,
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
  type ExtensionServiceName,
  type ExtensionCommandArgumentDefinition,
  type CommandDefinition,
  type FlagDefinition,
  type SchemaFieldDefinition,
  type SchemaItemTypeDefinition,
  type SchemaMigrationDefinition,
  type ImportExportRegistrationOptions,
  type Importer,
  type Exporter,
  type SearchProviderDefinition,
  type VectorStoreAdapterDefinition,
  type RegisteredExtensionParserOverride,
  type RegisteredExtensionServiceOverride,
  type RegisteredExtensionRendererOverride,
  type ExtensionCommandRegistry,
  type ExtensionParserRegistry,
  type ExtensionPreflightRegistry,
  type ExtensionServiceRegistry,
  type ExtensionRendererRegistry,
  type RegisteredExtensionCommandDefinition,
  type RegisteredExtensionSchemaMigrationDefinition,
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
} from "./extension-types.js";
export * from "./extension-types.js";

/** Fallback extension priority used when callers do not provide an override. */
export const DEFAULT_EXTENSION_PRIORITY = 100;
let currentPmCliVersionPromise: Promise<string | null> | null = null;

/* Types now in extension-types.ts - re-exported via `export * from "./extension-types.js"` above */

const DEFAULT_EXTENSION_POLICY: ExtensionGovernancePolicy = Object.freeze(
  createDefaultExtensionGovernancePolicy(),
);

let extensionReloadEpoch = 0;

/** Implements next extension reload token for the public runtime surface of this module. */
export function nextExtensionReloadToken(seed = Date.now()): string {
  extensionReloadEpoch += 1;
  return `${extensionReloadEpoch}-${seed}`;
}

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
function parseManifestCapabilities(
  value: unknown,
): {
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
  };
}

function parseManifest(raw: unknown): ExtensionManifest | null {
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
    capabilities: metadata.capabilities,
    legacy_capability_aliases:
      metadata.legacy_capability_aliases.length > 0
        ? metadata.legacy_capability_aliases
        : undefined,
  };
}

function shouldEnable(
  name: string,
  enabled: Set<string>,
  disabled: Set<string>,
): boolean {
  if (disabled.has(name)) {
    return false;
  }
  if (enabled.size === 0) {
    return true;
  }
  return enabled.has(name);
}

/** Resolve symlinks on both paths before the containment check so a link inside the directory cannot escape it. */
export async function isCanonicalPathWithinDirectory(
  directory: string,
  targetPath: string,
): Promise<boolean> {
  const [resolvedDirectory, resolvedTargetPath] = await Promise.all([
    fs.realpath(directory),
    fs.realpath(targetPath),
  ]);
  return isPathWithinDirectory(resolvedDirectory, resolvedTargetPath);
}

/** Implements resolve extension roots for the public runtime surface of this module. */
export function resolveExtensionRoots(
  pmRoot: string,
  cwd = process.cwd(),
): { global: string; project: string } {
  return {
    global: path.join(resolveGlobalPmRoot(cwd), "extensions"),
    project: path.join(pmRoot, "extensions"),
  };
}

async function listExtensionDirectories(
  extensionsRoot: string,
): Promise<string[]> {
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
  const summary: EffectiveExtension = {
    layer: candidate.layer,
    directory: candidate.directory,
    manifest_path: candidate.manifest_path,
    name: candidate.manifest.name,
    version: candidate.manifest.version,
    entry: candidate.manifest.entry,
    priority: candidate.manifest.priority,
    entry_path: candidate.entry_path,
    manifest_version: candidate.manifest.manifest_version,
    pm_min_version: candidate.manifest.pm_min_version,
    pm_max_version: candidate.manifest.pm_max_version,
    engines: candidate.manifest.engines,
    trusted: candidate.manifest.trusted,
    provenance: candidate.manifest.provenance,
    sandbox_profile: candidate.manifest.sandbox_profile,
    permissions: candidate.manifest.permissions,
    capabilities: [...candidate.manifest.capabilities],
    activation: candidate.manifest.activation
      ? {
          commands: [...(candidate.manifest.activation.commands as string[])],
        }
      : undefined,
  };
  if (candidate.source_package) {
    summary.source_package = candidate.source_package;
  }
  return summary;
}

function normalizeManagedSourcePackage(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

async function readManagedExtensionSourcePackages(
  extensionsRoot: string,
): Promise<Map<string, string>> {
  const packages = new Map<string, string>();
  try {
    const parsed = JSON.parse(
      await fs.readFile(
        path.join(extensionsRoot, ".managed-extensions.json"),
        "utf8",
      ),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      return packages;
    }
    for (const entry of (parsed as { entries: unknown[] }).entries) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const record = entry as {
        directory?: unknown;
        name?: unknown;
        source?: { package?: unknown };
      };
      const sourcePackage = normalizeManagedSourcePackage(
        record.source?.package,
      );
      if (!sourcePackage) {
        continue;
      }
      if (
        typeof record.directory === "string" &&
        record.directory.trim().length > 0
      ) {
        packages.set(`directory:${record.directory.trim()}`, sourcePackage);
      }
      if (typeof record.name === "string" && record.name.trim().length > 0) {
        packages.set(`name:${record.name.trim()}`, sourcePackage);
      }
    }
  } catch {
    return packages;
  }
  return packages;
}

function sortCandidates(
  candidates: ExtensionCandidate[],
): ExtensionCandidate[] {
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
  const ordered = [
    ...sortCandidates(globalCandidates),
    ...sortCandidates(projectCandidates),
  ];
  const effective: ExtensionCandidate[] = [];
  for (const candidate of ordered) {
    const existingIndex = effective.findIndex(
      (entry) => entry.manifest.name === candidate.manifest.name,
    );
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
  pmMaxVersionExceededMode: PmMaxVersionExceededMode,
): Promise<ExtensionLayerScanResult> {
  const diagnostics: ExtensionDiagnostic[] = [];
  const warnings: string[] = [];
  const candidates: ExtensionCandidate[] = [];
  const directories = await listExtensionDirectories(extensionsRoot);
  const managedSourcePackages =
    await readManagedExtensionSourcePackages(extensionsRoot);

  for (const directory of directories) {
    const scanned = await scanExtensionDirectory(
      layer,
      extensionsRoot,
      directory,
      enabled,
      disabled,
      managedSourcePackages,
      pmMaxVersionExceededMode,
    );
    diagnostics.push(scanned.diagnostic);
    warnings.push(...scanned.warnings);
    if (scanned.candidate) {
      candidates.push(scanned.candidate);
    }
  }

  return { diagnostics, warnings, candidates };
}

function emptyExtensionLayerScan(): ExtensionLayerScanResult {
  return { diagnostics: [], warnings: [], candidates: [] };
}

/** Build the `warn`-status scan result for a directory whose manifest is missing or unparseable, carrying the supplied diagnostic warning and no candidate. */
function buildUnavailableExtensionScan(
  layer: ExtensionLayer,
  directory: string,
  manifestPath: string,
  warning: string,
): ScannedExtensionDirectory {
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
    warnings: [warning],
    candidate: null,
  };
}

/** Collect the non-fatal load warnings for a parsed extension manifest, in detection order: legacy capability aliases, unknown capabilities, an entry outside or absent from the extension directory, then the pm version floor/ceiling incompatibility warnings. */
function collectScannedExtensionWarnings(
  layer: ExtensionLayer,
  manifest: ExtensionManifest,
  entryWithinDirectory: boolean,
  entryExists: boolean,
  pmVersionCompatibility: { allowed: boolean; warning?: string },
  pmMaxVersionCompatibility: { allowed: boolean; warning?: string },
): string[] {
  const extensionWarnings: string[] = [];
  if (
    Array.isArray(manifest.legacy_capability_aliases) &&
    manifest.legacy_capability_aliases.length > 0
  ) {
    extensionWarnings.push(
      formatLegacyExtensionCapabilityAliasWarning(
        layer,
        manifest.name,
        manifest.legacy_capability_aliases,
      ),
    );
  }
  for (const capability of collectUnknownExtensionCapabilities(
    manifest.capabilities,
  )) {
    extensionWarnings.push(
      formatUnknownExtensionCapabilityWarning(layer, manifest.name, capability),
    );
  }
  if (!entryWithinDirectory) {
    extensionWarnings.push(
      `extension_entry_outside_extension:${layer}:${manifest.name}`,
    );
  } else if (!entryExists) {
    extensionWarnings.push(`extension_entry_missing:${layer}:${manifest.name}`);
  }
  if (pmVersionCompatibility.warning) {
    extensionWarnings.push(pmVersionCompatibility.warning);
  }
  if (pmMaxVersionCompatibility.warning) {
    extensionWarnings.push(pmMaxVersionCompatibility.warning);
  }
  return extensionWarnings;
}

async function scanExtensionDirectory(
  layer: ExtensionLayer,
  extensionsRoot: string,
  directory: string,
  enabled: Set<string>,
  disabled: Set<string>,
  managedSourcePackages: ReadonlyMap<string, string>,
  pmMaxVersionExceededMode: PmMaxVersionExceededMode,
): Promise<ScannedExtensionDirectory> {
  const extensionDir = path.join(extensionsRoot, directory);
  const manifestPath = path.join(extensionDir, "manifest.json");
  if (!(await pathExists(manifestPath))) {
    return buildUnavailableExtensionScan(
      layer,
      directory,
      manifestPath,
      `extension_manifest_missing:${layer}:${directory}`,
    );
  }

  let manifest: ExtensionManifest | null;
  try {
    const parsed = JSON.parse(
      await fs.readFile(manifestPath, "utf8"),
    ) as unknown;
    manifest = parseManifest(parsed);
  } catch {
    manifest = null;
  }

  if (!manifest) {
    return buildUnavailableExtensionScan(
      layer,
      directory,
      manifestPath,
      `extension_manifest_invalid:${layer}:${directory}`,
    );
  }

  const entryPath = path.resolve(extensionDir, manifest.entry);
  const entryWithinDirectoryByPath = isPathWithinDirectory(
    extensionDir,
    entryPath,
  );
  const entryExists = entryWithinDirectoryByPath
    ? await pathExists(entryPath)
    : false;
  const entryWithinDirectory =
    entryWithinDirectoryByPath && entryExists
      ? await isCanonicalPathWithinDirectory(extensionDir, entryPath)
      : entryWithinDirectoryByPath;
  const enabledForLoad = shouldEnable(manifest.name, enabled, disabled);
  const pmVersionCompatibility = await evaluatePmMinVersionCompatibility(
    layer,
    manifest,
  );
  const pmMaxVersionCompatibility = await evaluatePmMaxVersionCompatibility(
    layer,
    manifest,
    pmMaxVersionExceededMode,
  );
  const extensionWarnings = collectScannedExtensionWarnings(
    layer,
    manifest,
    entryWithinDirectory,
    entryExists,
    pmVersionCompatibility,
    pmMaxVersionCompatibility,
  );
  const extensionReady =
    entryWithinDirectory &&
    entryExists &&
    pmVersionCompatibility.allowed &&
    pmMaxVersionCompatibility.allowed;
  const sourcePackage =
    managedSourcePackages.get(`directory:${directory}`) ??
    managedSourcePackages.get(`name:${manifest.name}`);

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
      status: extensionReady ? "ok" : "warn",
    },
    warnings: extensionWarnings,
    candidate:
      extensionReady && enabledForLoad
        ? {
            layer,
            directory,
            manifest_path: manifestPath,
            entry_path: entryPath,
            manifest,
            source_package: sourcePackage,
          }
        : null,
  };
}

/** Implements discover extensions for the public runtime surface of this module. */
export async function discoverExtensions(
  options: DiscoverExtensionsOptions,
): Promise<ExtensionDiscoveryResult> {
  const roots = resolveExtensionRoots(
    options.pmRoot,
    options.cwd ?? process.cwd(),
  );
  const configured_enabled = normalizeNames(
    options.settings.extensions.enabled,
  );
  const configured_disabled = normalizeNames(
    options.settings.extensions.disabled,
  );
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
  const globalScan =
    options.ignoreGlobalExtensions === true
      ? emptyExtensionLayerScan()
      : await scanExtensionLayer(
          "global",
          roots.global,
          enabled,
          disabled,
          policy.pmMaxVersionExceededMode.global,
        );
  const projectScan = await scanExtensionLayer(
    "project",
    roots.project,
    enabled,
    disabled,
    policy.pmMaxVersionExceededMode.project,
  );
  const policyWarnings: string[] = [...policy.warnings];
  const effectiveCandidates = buildEffectiveExtensions(
    globalScan.candidates,
    projectScan.candidates,
  );
  const effective: EffectiveExtension[] = [];
  for (const candidate of effectiveCandidates) {
    const extensionRef = {
      layer: candidate.layer,
      name: candidate.manifest.name,
      trusted: candidate.manifest.trusted === true,
      provenanceVerified: candidate.manifest.provenance?.verified === true,
      sandboxProfile: candidate.manifest.sandbox_profile,
      permissions:
        candidate.manifest.permissions &&
        typeof candidate.manifest.permissions === "object"
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
    const extensionDecision = evaluateExtensionPolicyForExtension(
      policy,
      extensionRef,
    );
    if (extensionDecision.warning) {
      policyWarnings.push(extensionDecision.warning);
    }
    if (!extensionDecision.allowed) {
      continue;
    }
    for (const capability of candidate.manifest.capabilities) {
      const capabilityDecision = evaluateExtensionPolicyForCapability(
        policy,
        extensionRef,
        capability,
      );
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
    warnings: [
      ...new Set([
        ...globalScan.warnings,
        ...projectScan.warnings,
        ...policyWarnings,
      ]),
    ],
    policy: serializedPolicy,
  };
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

async function readCurrentPmCliVersion(): Promise<string | null> {
  try {
    const packageRoot = resolvePmPackageRootFromModule(import.meta.url, [
      "../../..",
    ]);
    const raw = await fs.readFile(
      path.join(packageRoot, "package.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" &&
      parsed.version.trim().length > 0
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

function resolveCurrentPmCliVersion(): Promise<string | null> {
  currentPmCliVersionPromise ??= readCurrentPmCliVersion();
  return currentPmCliVersionPromise;
}

function formatPmVersionCompatibilityWarning(
  layer: ExtensionLayer,
  manifest: ExtensionManifest,
  evaluation: PmVersionBoundEvaluation,
): string | undefined {
  const current = evaluation.current ?? "unknown";
  if (evaluation.kind === "pm_min_version") {
    switch (evaluation.status) {
      case "invalid":
        return `extension_pm_min_version_invalid:${layer}:${manifest.name}:required=${evaluation.required}`;
      case "unchecked":
        return `extension_pm_min_version_unchecked:${layer}:${manifest.name}:required=${evaluation.required}:current=${current}`;
      case "unmet":
        return `extension_pm_min_version_unmet:${layer}:${manifest.name}:required=${evaluation.required}:current=${current}`;
      default:
        return undefined;
    }
  }
  switch (evaluation.status) {
    case "invalid":
      return `extension_pm_max_version_invalid:${layer}:${manifest.name}:allowed=${evaluation.required}`;
    case "unchecked":
      return `extension_pm_max_version_unchecked:${layer}:${manifest.name}:allowed=${evaluation.required}:current=${current}`;
    case "exceeded_warn":
      return `extension_pm_max_version_exceeded_warn:${layer}:${manifest.name}:allowed=${evaluation.required}:current=${current}`;
    case "exceeded":
      return `extension_pm_max_version_exceeded:${layer}:${manifest.name}:allowed=${evaluation.required}:current=${current}`;
    default:
      return undefined;
  }
}

async function evaluatePmMinVersionCompatibility(
  layer: ExtensionLayer,
  manifest: ExtensionManifest,
): Promise<{ allowed: boolean; warning?: string }> {
  // Resolve the current CLI version only when a bound is declared, so the common
  // no-bound case never reads package.json.
  if (manifest.pm_min_version === undefined) {
    return { allowed: true };
  }
  const evaluation = evaluatePmMinVersionBound(
    manifest.pm_min_version,
    await resolveCurrentPmCliVersion(),
  );
  const warning = formatPmVersionCompatibilityWarning(
    layer,
    manifest,
    evaluation,
  );
  return warning
    ? { allowed: evaluation.allowed, warning }
    : { allowed: evaluation.allowed };
}

async function evaluatePmMaxVersionCompatibility(
  layer: ExtensionLayer,
  manifest: ExtensionManifest,
  exceededMode: PmMaxVersionExceededMode,
): Promise<{ allowed: boolean; warning?: string }> {
  if (manifest.pm_max_version === undefined) {
    return { allowed: true };
  }
  const evaluation = evaluatePmMaxVersionBound(
    manifest.pm_max_version,
    await resolveCurrentPmCliVersion(),
    exceededMode,
  );
  const warning = formatPmVersionCompatibilityWarning(
    layer,
    manifest,
    evaluation,
  );
  return warning
    ? { allowed: evaluation.allowed, warning }
    : { allowed: evaluation.allowed };
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
  const shouldCacheBust =
    options.cache_bust === true || typeof options.reload_token === "string";
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

/** Implements load extensions for the public runtime surface of this module. */
export async function loadExtensions(
  options: DiscoverExtensionsOptions,
): Promise<ExtensionLoadResult> {
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

  const extensionsToLoad =
    typeof options.extensionFilter === "function"
      ? discovery.effective.filter(options.extensionFilter)
      : discovery.effective;
  for (const extension of extensionsToLoad) {
    try {
      const importHref = await resolveExtensionImportHref(extension, options);
      const module = await import(importHref);
      loaded.push({
        ...extension,
        module,
      });
    } catch (error: unknown) {
      warnings.push(
        `extension_load_failed:${extension.layer}:${extension.name}`,
      );
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

const DEFAULT_EXTENSION_DEACTIVATE_TIMEOUT_MS = 5_000;
const MAX_EXTENSION_DEACTIVATE_TIMEOUT_MS = 2_147_483_647;

function toActivatableExtension(
  source: Record<string, unknown>,
): ActivatableExtension {
  // Bind to `source` so a module/default-export authored with methods (or a class
  // instance) keeps its `this` across both lifecycle calls — `activate` is a
  // method call on a fresh object and `deactivate` is invoked bare, so without
  // binding the two would see different (or undefined) `this`.
  const activate = source.activate as ActivatableExtension["activate"];
  const activatable: ActivatableExtension = {
    activate: activate.bind(source),
  };
  if (typeof source.deactivate === "function") {
    const deactivate = source.deactivate as NonNullable<
      ActivatableExtension["deactivate"]
    >;
    activatable.deactivate = deactivate.bind(source);
  }
  return activatable;
}

function resolveActivatableExtension(
  module: unknown,
): ActivatableExtension | null {
  const activatableRecord = resolveActivatablePropertyRecord(module);
  return activatableRecord ? toActivatableExtension(activatableRecord) : null;
}

/**
 * Run the optional `deactivate` teardown hook for every loaded extension that
 * exports one. Best-effort: a throwing teardown is captured as a warning and a
 * failure entry rather than propagated, so one extension cannot block another's
 * cleanup. Hosts call this on shutdown/reload (e.g. the MCP server between
 * native-action requests) to release resources opened during `activate`.
 *
 * Pass the `activationResult` to skip extensions whose `activate` failed — they
 * never fully initialized, so (VS Code-style) their `deactivate` must not run.
 * Teardowns run concurrently and each hook has a bounded timeout by default, so
 * one slow or hanging hook cannot serialize the rest or block the host
 * indefinitely unless the host explicitly disables the timeout; the returned
 * warnings/failures preserve loaded order.
 */
export async function deactivateExtensions(
  loadResult: ExtensionLoadResult,
  activationResult?: Pick<ExtensionActivationResult, "failed">,
  options: ExtensionDeactivationOptions = {},
): Promise<ExtensionDeactivationResult> {
  const timeoutMs = normalizeExtensionDeactivateTimeout(
    options?.deactivate_timeout_ms,
  );
  const failedActivationKeys = new Set(
    (activationResult?.failed ?? []).map(
      (entry) => `${entry.layer}:${entry.name}`,
    ),
  );
  const targets: Array<{
    extension: LoadedExtension;
    deactivate: () => void | Promise<void>;
  }> = [];
  for (const extension of loadResult.loaded) {
    if (failedActivationKeys.has(`${extension.layer}:${extension.name}`)) {
      continue;
    }
    const activatable = resolveActivatableExtension(extension.module);
    if (!activatable || typeof activatable.deactivate !== "function") {
      continue;
    }
    targets.push({ extension, deactivate: activatable.deactivate });
  }
  const outcomes = await Promise.all(
    targets.map(async ({ extension, deactivate }) => {
      try {
        await runExtensionDeactivateWithTimeout(deactivate, timeoutMs);
        return { ok: true as const };
      } catch (error: unknown) {
        return {
          ok: false as const,
          layer: extension.layer,
          name: extension.name,
          error: formatUnknownError(error),
        };
      }
    }),
  );
  const warnings: string[] = [];
  const failed: ExtensionDeactivationFailure[] = [];
  let deactivated = 0;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      deactivated += 1;
      continue;
    }
    warnings.push(
      `extension_deactivate_failed:${outcome.layer}:${outcome.name}`,
    );
    failed.push({
      layer: outcome.layer,
      name: outcome.name,
      error: outcome.error,
    });
  }
  return { deactivated, warnings, failed };
}

function normalizeExtensionDeactivateTimeout(rawTimeout: unknown): number {
  if (typeof rawTimeout !== "number" || rawTimeout < 0) {
    return DEFAULT_EXTENSION_DEACTIVATE_TIMEOUT_MS;
  }
  if (rawTimeout === 0 || rawTimeout === Infinity) {
    return 0;
  }
  if (!Number.isFinite(rawTimeout)) {
    return DEFAULT_EXTENSION_DEACTIVATE_TIMEOUT_MS;
  }
  return Math.min(
    MAX_EXTENSION_DEACTIVATE_TIMEOUT_MS,
    Math.max(1, Math.floor(rawTimeout)),
  );
}

async function runExtensionDeactivateWithTimeout(
  deactivate: () => void | Promise<void>,
  timeoutMs: number,
): Promise<void> {
  if (timeoutMs === 0) {
    await deactivate();
    return;
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    // A timed-out deactivate promise may still finish later; JavaScript promises
    // are not cancellable, so the host only stops waiting and consumes any late
    // rejection from the hook.
    const deactivatePromise = Promise.resolve().then(() => deactivate());
    deactivatePromise.catch(() => {});
    await Promise.race([
      deactivatePromise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new Error(`extension deactivate timed out after ${timeoutMs}ms`),
          );
        }, timeoutMs);
        timeoutHandle.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeoutHandle as ReturnType<typeof setTimeout>);
  }
}

function isOutputRendererFormat(value: string): value is OutputRendererFormat {
  return value === "toon" || value === "json";
}

function isExtensionServiceName(value: string): value is ExtensionServiceName {
  return KNOWN_EXTENSION_SERVICE_NAMES.includes(value as ExtensionServiceName);
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

function toRegistrationCommandPath(
  name: string,
  action: "import" | "export",
): string {
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
    const keys = Object.keys(record).sort((left, right) =>
      left.localeCompare(right),
    );
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
    for (const key of Object.keys(record).sort((left, right) =>
      left.localeCompare(right),
    )) {
      cloned[key] = cloneRuntimeRegistrationValue(record[key]);
    }
    return cloned;
  }
  return value;
}

const EXTENSION_REGISTRATION_TRACE_SYMBOL = Symbol(
  "extension_registration_trace",
);

type RegistrationTraceCarrier = Error & {
  [EXTENSION_REGISTRATION_TRACE_SYMBOL]?: ExtensionActivationFailureTrace;
};

function createRegistrationValidationError(
  message: string,
  trace: ExtensionActivationFailureTrace,
): TypeError {
  const error = new TypeError(message) as RegistrationTraceCarrier;
  Object.defineProperty(error, EXTENSION_REGISTRATION_TRACE_SYMBOL, {
    value: trace,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return error;
}

function extractRegistrationValidationTrace(
  error: unknown,
): ExtensionActivationFailureTrace | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  return (error as RegistrationTraceCarrier)[
    EXTENSION_REGISTRATION_TRACE_SYMBOL
  ];
}

function normalizeRegistrationRecord(
  name: string,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} requires an object definition`);
  }
  return sanitizeRegistrationValue(value) as Record<string, unknown>;
}

function normalizeRuntimeRegistrationRecord(
  name: string,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} requires an object definition`);
  }
  return cloneRuntimeRegistrationValue(value) as Record<string, unknown>;
}

function normalizeRegistrationRecordList(
  name: string,
  value: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} requires an array of object definitions`);
  }
  return value.map((entry) => normalizeRegistrationRecord(name, entry));
}

function asRegistrationRecord(
  name: string,
  value: unknown,
): Record<string, unknown> {
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

function isFlagDefaultScalar(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function assertOptionalFlagDefaultField(name: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      if (!isFlagDefaultScalar(item)) {
        throw new TypeError(
          `${name}[${index}] must be a string, number, or boolean`,
        );
      }
    }
    return;
  }
  if (!isFlagDefaultScalar(value)) {
    throw new TypeError(
      `${name} must be a string, number, or boolean, or an array of these when provided`,
    );
  }
}

function assertOptionalStringArrayField(name: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new TypeError(
      `${name} must be an array of non-empty strings when provided`,
    );
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new TypeError(`${name}[${index}] must be a non-empty string`);
    }
  }
}

function normalizeOptionalStringArrayField(
  name: string,
  value: unknown,
): string[] {
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

function resolveCommandDefinitionAction(
  commandPath: string,
  action: unknown,
): string {
  if (action === undefined) {
    return commandPath.replace(/\s+/g, "-");
  }
  if (typeof action !== "string" || action.trim().length === 0) {
    throw new TypeError(
      "registerCommand definition.action must be a non-empty string when provided",
    );
  }
  const normalized = normalizeCommandActionName(action);
  if (normalized.length === 0) {
    throw new TypeError(
      "registerCommand definition.action must contain alphanumeric characters",
    );
  }
  return normalized;
}

function normalizeCommandDefinitionArguments(
  value: unknown,
): ExtensionCommandArgumentDefinition[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError(
      "registerCommand definition.arguments must be an array when provided",
    );
  }
  const normalized: ExtensionCommandArgumentDefinition[] = [];
  for (const [index, entry] of value.entries()) {
    const record = asRegistrationRecord(
      `registerCommand definition.arguments[${index}]`,
      entry,
    );
    const name = assertNonEmptyString(
      `registerCommand definition.arguments[${index}].name`,
      record.name,
    );
    assertOptionalBooleanField(
      `registerCommand definition.arguments[${index}].required`,
      record.required,
    );
    assertOptionalBooleanField(
      `registerCommand definition.arguments[${index}].variadic`,
      record.variadic,
    );
    assertOptionalStringField(
      `registerCommand definition.arguments[${index}].description`,
      record.description,
    );
    if (name.includes(" ")) {
      throw new TypeError(
        `registerCommand definition.arguments[${index}].name must not contain spaces`,
      );
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
      definition.description = record.description.trim();
    }
    normalized.push(definition);
  }

  const variadicIndexes = normalized
    .map((argument, index) => (argument.variadic ? index : -1))
    .filter((index) => index >= 0);
  if (variadicIndexes.length > 1) {
    throw new TypeError(
      "registerCommand definition.arguments supports at most one variadic argument",
    );
  }
  if (
    variadicIndexes.length === 1 &&
    variadicIndexes[0] !== normalized.length - 1
  ) {
    throw new TypeError(
      "registerCommand definition.arguments variadic argument must be the final argument",
    );
  }

  return normalized;
}

function validateFlagDefinitions(flags: unknown): void {
  if (!Array.isArray(flags)) {
    throw new TypeError(
      "registerFlags flags requires an array of object definitions",
    );
  }
  for (const [index, raw] of flags.entries()) {
    const record = asRegistrationRecord(`registerFlags flags[${index}]`, raw);
    const long = record.long;
    const short = record.short;
    if (long === undefined && short === undefined) {
      throw new TypeError(
        `registerFlags flags[${index}] requires at least one of long or short`,
      );
    }
    assertOptionalStringField(`registerFlags flags[${index}].long`, long);
    assertOptionalStringField(`registerFlags flags[${index}].short`, short);
    assertOptionalStringField(
      `registerFlags flags[${index}].value_name`,
      record.value_name,
    );
    assertOptionalStringField(
      `registerFlags flags[${index}].description`,
      record.description,
    );
    assertOptionalBooleanField(
      `registerFlags flags[${index}].required`,
      record.required,
    );
    assertOptionalBooleanField(
      `registerFlags flags[${index}].enabled`,
      record.enabled,
    );
    assertOptionalBooleanField(
      `registerFlags flags[${index}].visible`,
      record.visible,
    );
    assertOptionalBooleanField(
      `registerFlags flags[${index}].list`,
      record.list,
    );
    assertOptionalFlagDefaultField(
      `registerFlags flags[${index}].default`,
      record.default,
    );
    if (Array.isArray(record.default) && record.list !== true) {
      throw new TypeError(
        `registerFlags flags[${index}].default cannot be an array unless list is true.`,
      );
    }
    assertFlagValueTypeAndDefault(`registerFlags flags[${index}]`, record);
  }
}

/** Reject a declared `value_type`/`type` that is not a known flag value kind, and a `default` whose value(s) would not cleanly coerce under that kind — so the typed-flag contract is enforced at registration instead of silently leaving an untyped value to surface at use time. */
function assertFlagValueTypeAndDefault(
  label: string,
  record: Record<string, unknown>,
): void {
  const declaredType =
    (typeof record.value_type === "string" ? record.value_type : undefined) ??
    (typeof record.type === "string" ? record.type : undefined);
  if (declaredType === undefined) {
    return;
  }
  const kind = resolveFlagValueKind(declaredType);
  if (kind === null) {
    throw new TypeError(
      `${label} value_type "${declaredType}" is not a known flag value type (expected one of: string, number, boolean).`,
    );
  }
  if (record.default === undefined) {
    return;
  }
  // For list flags, validate the default exactly as the runtime will see it —
  // comma-joined strings and nested arrays are flattened first — so a valid
  // default like `value_type: "number", default: "10,20"` is not wrongly rejected.
  const defaults =
    record.list === true
      ? flattenFlagListValue(record.default)
      : [record.default];
  for (const [defaultIndex, defaultValue] of defaults.entries()) {
    if (
      !isFlagDefaultValueCoercible(
        defaultValue as string | number | boolean,
        kind,
      )
    ) {
      const suffix =
        defaults.length > 1 ? `default[${defaultIndex}]` : "default";
      throw new TypeError(
        `${label}.${suffix} (${JSON.stringify(defaultValue)}) is not coercible to ${kind}.`,
      );
    }
  }
}

function validateItemFieldDefinitions(fields: unknown): void {
  if (!Array.isArray(fields)) {
    throw new TypeError(
      "registerItemFields fields requires an array of object definitions",
    );
  }
  for (const [index, raw] of fields.entries()) {
    const record = asRegistrationRecord(
      `registerItemFields fields[${index}]`,
      raw,
    );
    assertNonEmptyString(
      `registerItemFields fields[${index}].name`,
      record.name,
    );
    const fieldType = assertNonEmptyString(
      `registerItemFields fields[${index}].type`,
      record.type,
    );
    if (normalizeItemFieldType(fieldType) === null) {
      const suggestion = suggestKnownItemFieldType(fieldType);
      const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
      throw new TypeError(
        `registerItemFields fields[${index}].type "${fieldType}" is not a known field type ` +
          `(expected one of: ${KNOWN_ITEM_FIELD_TYPES.join(", ")}).${hint}`,
      );
    }
    assertOptionalBooleanField(
      `registerItemFields fields[${index}].optional`,
      record.optional,
    );
  }
}

function validateItemTypeDefinitions(types: unknown): void {
  if (!Array.isArray(types)) {
    throw new TypeError(
      "registerItemTypes types requires an array of object definitions",
    );
  }
  for (const [typeIndex, raw] of types.entries()) {
    const record = asRegistrationRecord(
      `registerItemTypes types[${typeIndex}]`,
      raw,
    );
    assertNonEmptyString(
      `registerItemTypes types[${typeIndex}].name`,
      record.name,
    );
    assertOptionalStringField(
      `registerItemTypes types[${typeIndex}].folder`,
      record.folder,
    );
    assertOptionalStringArrayField(
      `registerItemTypes types[${typeIndex}].aliases`,
      record.aliases,
    );
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
      for (const [
        policyIndex,
        rawPolicy,
      ] of record.command_option_policies.entries()) {
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
        throw new TypeError(
          `registerItemTypes types[${typeIndex}].options must be an array when provided`,
        );
      }
      for (const [optionIndex, rawOption] of record.options.entries()) {
        const option = asRegistrationRecord(
          `registerItemTypes types[${typeIndex}].options[${optionIndex}]`,
          rawOption,
        );
        assertNonEmptyString(
          `registerItemTypes types[${typeIndex}].options[${optionIndex}].key`,
          option.key,
        );
        assertOptionalStringArrayField(
          `registerItemTypes types[${typeIndex}].options[${optionIndex}].values`,
          option.values,
        );
        assertOptionalBooleanField(
          `registerItemTypes types[${typeIndex}].options[${optionIndex}].required`,
          option.required,
        );
        assertOptionalStringArrayField(
          `registerItemTypes types[${typeIndex}].options[${optionIndex}].aliases`,
          option.aliases,
        );
      }
    }
  }
}

function validateMigrationDefinition(definition: unknown): void {
  const record = asRegistrationRecord(
    "registerMigration definition",
    definition,
  );
  if (record.id !== undefined && typeof record.id !== "string") {
    throw new TypeError(
      "registerMigration definition.id must be a string when provided",
    );
  }
  if (
    record.description !== undefined &&
    typeof record.description !== "string"
  ) {
    throw new TypeError(
      "registerMigration definition.description must be a string when provided",
    );
  }
  if (record.status !== undefined && typeof record.status !== "string") {
    throw new TypeError(
      "registerMigration definition.status must be a string when provided",
    );
  }
  assertOptionalBooleanField(
    "registerMigration definition.mandatory",
    record.mandatory,
  );
  if (record.run !== undefined && typeof record.run !== "function") {
    throw new TypeError(
      "registerMigration definition.run must be a function when provided",
    );
  }
}

/**
 * The seven array-valued dimensions a {@link ProjectProfileDefinition} stages.
 * Each is "optional-by-emptiness": an omitted dimension normalizes to an empty
 * array so the profile planner can iterate every dimension unconditionally.
 */
const PROJECT_PROFILE_DIMENSIONS = [
  "types",
  "statuses",
  "fields",
  "workflows",
  "config",
  "templates",
  "packages",
] as const;

/** Validates the field shapes the profile planner, `pm profile show/apply/lint`, and `describeProjectProfile` dereference without re-checking, so a structurally well-formed but type-violating extension entry (e.g. a workflow whose `type` is a number, or whose `allowed_transitions` is not an array) is rejected here rather than crashing a downstream consumer. Dimensions whose consumers already coerce or gracefully reject malformed values (statuses, fields, config) need no shape check. The `entry` is an already-confirmed non-null object. */
function validateProjectProfileEntryShape(
  dimension: string,
  index: number,
  entry: Record<string, unknown>,
): void {
  const at = `registerProfile profile.${dimension}[${index}]`;
  if (dimension === "types") {
    if (entry.name !== undefined && typeof entry.name !== "string") {
      throw new TypeError(`${at}.name must be a string when provided`);
    }
    return;
  }
  if (dimension === "workflows") {
    if (typeof entry.type !== "string") {
      throw new TypeError(`${at}.type must be a string`);
    }
    if (!Array.isArray(entry.allowed_transitions)) {
      throw new TypeError(`${at}.allowed_transitions must be an array`);
    }
    for (const [pairIndex, pair] of entry.allowed_transitions.entries()) {
      if (!Array.isArray(pair)) {
        throw new TypeError(
          `${at}.allowed_transitions[${pairIndex}] must be a [from, to] array`,
        );
      }
    }
    return;
  }
  if (dimension === "templates") {
    if (typeof entry.name !== "string") {
      throw new TypeError(`${at}.name must be a string`);
    }
    if (
      typeof entry.options !== "object" ||
      entry.options === null ||
      Array.isArray(entry.options)
    ) {
      throw new TypeError(`${at}.options must be an object`);
    }
    return;
  }
  if (dimension === "packages") {
    if (typeof entry.spec !== "string") {
      throw new TypeError(`${at}.spec must be a string`);
    }
  }
}

function validateProjectProfileDefinition(profile: unknown): void {
  const record = asRegistrationRecord("registerProfile profile", profile);
  assertNonEmptyString("registerProfile profile.name", record.name);
  assertNonEmptyString("registerProfile profile.title", record.title);
  if (record.summary !== undefined && typeof record.summary !== "string") {
    throw new TypeError(
      "registerProfile profile.summary must be a string when provided",
    );
  }
  for (const dimension of PROJECT_PROFILE_DIMENSIONS) {
    const value = record[dimension];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value)) {
      throw new TypeError(
        `registerProfile profile.${dimension} must be an array when provided`,
      );
    }
    // Each dimension entry must be a non-null object: a primitive or null entry
    // (e.g. `statuses: [null]`, `types: [42]`) survives an array-only check but
    // crashes the profile planner and `pm profile show` when they read `entry.id`
    // / `entry.key` / `entry.type` later. Reject it at the registration boundary.
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new TypeError(
          `registerProfile profile.${dimension}[${index}] must be an object`,
        );
      }
      // Beyond "is an object", validate the specific field shapes consumers
      // dereference so a type-violating entry can never crash the planner, the
      // `pm profile` surfaces, or describeProjectProfile downstream.
      validateProjectProfileEntryShape(
        dimension,
        index,
        entry as Record<string, unknown>,
      );
    }
  }
}

/**
 * Fills an already-validated profile snapshot's optional surfaces — an absent
 * `summary` becomes an empty string and every omitted dimension an empty array —
 * so the stored definition always has the full {@link ProjectProfileDefinition}
 * shape the profile planner and `pm profile` resolution rely on. It runs after
 * validation on the cloned snapshot, so it only ever supplies missing defaults
 * and never has to coerce an invalid type (those are already rejected).
 */
function applyProjectProfileDefaults(
  profile: Record<string, unknown>,
): ProjectProfileDefinition {
  if (profile.summary === undefined) {
    profile.summary = "";
  }
  for (const dimension of PROJECT_PROFILE_DIMENSIONS) {
    if (profile[dimension] === undefined) {
      profile[dimension] = [];
    }
  }
  return profile as unknown as ProjectProfileDefinition;
}

function attachRuntimeDefinition<
  TEntry extends { definition: Record<string, unknown> },
>(entry: TEntry, runtimeDefinition: Record<string, unknown>): TEntry {
  Object.defineProperty(entry, "runtime_definition", {
    value: runtimeDefinition,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return entry;
}

function getDeclaredExtensionCapabilities(
  extension: LoadedExtension,
): Set<ExtensionCapability> | null {
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

function assertExtensionCapability(
  extension: LoadedExtension,
  capability: ExtensionCapability,
  method: string,
): void {
  const declared = getDeclaredExtensionCapabilities(extension);
  // Keep direct unit tests that construct LoadedExtension fixtures without
  // capability metadata backwards-compatible while enforcing manifest-declared
  // capabilities for runtime-loaded extensions.
  if (declared === null) {
    return;
  }
  if (!declared.has(capability)) {
    throw createRegistrationValidationError(
      `${method} requires capability '${capability}' in extension manifest capabilities`,
      {
        method,
        registration_index: -1,
        capability,
        missing_capability: capability,
        expected_schema: `"capabilities": [..., "${capability}"]`,
        received: extension.capabilities,
        hint: `Add "${capability}" to ${extension.name} manifest capabilities, or remove the ${method} registration call.`,
      },
    );
  }
}

function buildExtensionSelfIdentity(
  extension: LoadedExtension,
): ExtensionSelfIdentity {
  return Object.freeze({
    name: extension.name,
    layer: extension.layer,
    version: extension.version,
    capabilities: Object.freeze(
      (extension.capabilities ?? []).filter(
        (capability): capability is ExtensionCapability =>
          (KNOWN_EXTENSION_CAPABILITIES as readonly string[]).includes(
            capability,
          ),
      ),
    ) as readonly ExtensionCapability[],
    pm_min_version: extension.pm_min_version,
    pm_max_version: extension.pm_max_version,
    source_package: extension.source_package,
  });
}

function buildPolicyExtensionRef(
  extension: LoadedExtension,
): PolicyExtensionRef {
  return {
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
}

interface ExtensionRegistrationPolicyDetails {
  command?: string;
  action?: string;
  service?: string;
}

class ExtensionApiRegistrar implements ExtensionApi {
  public readonly extension: ExtensionSelfIdentity;
  public readonly hooks: ExtensionApi["hooks"];
  readonly #loadedExtension: LoadedExtension;
  readonly #extensionRef: PolicyExtensionRef;
  readonly #hookRegistry: ExtensionHookRegistry;
  readonly #commandRegistry: ExtensionCommandRegistry;
  readonly #parserRegistry: ExtensionParserRegistry;
  readonly #preflightRegistry: ExtensionPreflightRegistry;
  readonly #serviceRegistry: ExtensionServiceRegistry;
  readonly #rendererRegistry: ExtensionRendererRegistry;
  readonly #registrationRegistry: ExtensionRegistrationRegistry;
  readonly #activationWarnings: string[];
  readonly #policy: NormalizedExtensionPolicy;

  public constructor(
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
  ) {
    this.#loadedExtension = extension;
    this.extension = buildExtensionSelfIdentity(extension);
    this.#extensionRef = buildPolicyExtensionRef(extension);
    this.#hookRegistry = hooks;
    this.#commandRegistry = commands;
    this.#parserRegistry = parsers;
    this.#preflightRegistry = preflight;
    this.#serviceRegistry = services;
    this.#rendererRegistry = renderers;
    this.#registrationRegistry = registrations;
    this.#activationWarnings = activationWarnings;
    this.#policy = policy;
    this.registerCommand = this.registerCommand.bind(this);
    this.registerParser = this.registerParser.bind(this);
    this.registerPreflight = this.registerPreflight.bind(this);
    this.registerService = this.registerService.bind(this);
    this.registerFlags = this.registerFlags.bind(this);
    this.registerItemFields = this.registerItemFields.bind(this);
    this.registerItemTypes = this.registerItemTypes.bind(this);
    this.registerMigration = this.registerMigration.bind(this);
    this.registerProfile = this.registerProfile.bind(this);
    this.registerRenderer = this.registerRenderer.bind(this);
    this.registerImporter = this.registerImporter.bind(this);
    this.registerExporter = this.registerExporter.bind(this);
    this.registerSearchProvider = this.registerSearchProvider.bind(this);
    this.registerVectorStoreAdapter =
      this.registerVectorStoreAdapter.bind(this);
    this.hooks = {
      beforeCommand: (hook) => this.registerBeforeCommand(hook),
      afterCommand: (hook) => this.registerAfterCommand(hook),
      onWrite: (hook) => this.registerOnWrite(hook),
      onRead: (hook) => this.registerOnRead(hook),
      onIndex: (hook) => this.registerOnIndex(hook),
    };
  }

  private allowRegistration(
    surface: ExtensionPolicySurface,
    method: string,
    capability?: ExtensionCapability,
    details?: ExtensionRegistrationPolicyDetails,
  ): boolean {
    const decision = evaluateExtensionPolicyForRegistration(
      this.#policy,
      this.#extensionRef,
      surface,
      method,
      capability,
      details,
    );
    if (decision.warning) {
      this.#activationWarnings.push(decision.warning);
    }
    return decision.allowed;
  }

  private registerCommandTrace(
    mode: "override" | "definition",
    command: string | undefined,
    expectedSchema: string,
    received: unknown,
    hint?: string,
  ): ExtensionActivationFailureTrace {
    return {
      method: "registerCommand",
      registration_index:
        mode === "override"
          ? this.#commandRegistry.overrides.length
          : this.#commandRegistry.handlers.length,
      command,
      expected_schema: expectedSchema,
      received: sanitizeRegistrationValue(received),
      hint,
    };
  }

  private registerCommandOverride(
    command: string,
    override: CommandOverride | undefined,
  ): void {
    const normalizedCommand = normalizeCommandName(command);
    if (normalizedCommand.length === 0) {
      throw createRegistrationValidationError(
        "registerCommand requires a non-empty command name",
        this.registerCommandTrace(
          "override",
          command,
          'registerCommand("<command>", (context) => unknown)',
          command,
          "Provide a non-empty command path as the first argument.",
        ),
      );
    }
    if (typeof override !== "function") {
      const trace = this.registerCommandTrace(
        "override",
        normalizedCommand,
        'registerCommand("<command>", (context) => unknown)',
        override,
        "Provide a function as the second registerCommand argument.",
      );
      throw createRegistrationValidationError(
        `registerCommand requires an override function when command name is provided (command="${normalizedCommand}", registration_index=${trace.registration_index})`,
        trace,
      );
    }
    if (
      !this.allowRegistration(
        "commands.override",
        "registerCommand",
        "commands",
        { command: normalizedCommand },
      )
    ) {
      return;
    }
    this.#commandRegistry.overrides.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      command: normalizedCommand,
      run: override,
    });
  }

  private resolveCommandDefinitionRunHandler(
    definition: CommandDefinition,
    normalizedCommand: string,
  ): CommandHandler | undefined {
    const runHandler =
      typeof definition.run === "function" ? definition.run : undefined;
    const legacyHandler =
      typeof definition.handler === "function" ? definition.handler : undefined;
    if (!runHandler && legacyHandler) {
      this.#activationWarnings.push(
        `extension_command_definition_legacy_handler_alias:${this.#loadedExtension.layer}:${this.#loadedExtension.name}:${normalizedCommand}`,
      );
    }
    return runHandler ?? legacyHandler;
  }

  private registerCommandDefinition(definition: CommandDefinition): void {
    if (typeof definition !== "object" || definition === null) {
      throw createRegistrationValidationError(
        "registerCommand requires a command definition object",
        this.registerCommandTrace(
          "definition",
          undefined,
          "{ name: string; run: (context) => unknown; }",
          definition,
          'Use registerCommand({ name: "command path", run: (context) => ... }).',
        ),
      );
    }
    if (typeof definition.name !== "string") {
      throw createRegistrationValidationError(
        "registerCommand requires a command definition name",
        this.registerCommandTrace(
          "definition",
          undefined,
          "{ name: string; run: (context) => unknown; }",
          definition,
          "Set command definition.name to a non-empty string command path.",
        ),
      );
    }

    const normalizedCommand = normalizeCommandName(definition.name);
    if (normalizedCommand.length === 0) {
      throw createRegistrationValidationError(
        "registerCommand requires a non-empty command definition name",
        this.registerCommandTrace(
          "definition",
          definition.name,
          "{ name: string; run: (context) => unknown; }",
          definition,
          "Ensure command definition.name contains a non-empty command path.",
        ),
      );
    }
    const resolvedHandler = this.resolveCommandDefinitionRunHandler(
      definition,
      normalizedCommand,
    );
    if (typeof resolvedHandler !== "function") {
      const trace = this.registerCommandTrace(
        "definition",
        normalizedCommand,
        "{ name: string; run: (context) => unknown; }",
        resolvedHandler,
        "Define command definition.run as a function.",
      );
      throw createRegistrationValidationError(
        `registerCommand requires a command definition run handler (command="${normalizedCommand}", registration_index=${trace.registration_index})`,
        trace,
      );
    }
    try {
      assertOptionalStringField(
        "registerCommand definition.action",
        definition.action,
      );
      assertOptionalStringField(
        "registerCommand definition.description",
        definition.description,
      );
      assertOptionalStringField(
        "registerCommand definition.intent",
        definition.intent,
      );
      const action = resolveCommandDefinitionAction(
        normalizedCommand,
        definition.action,
      );
      if (
        !this.allowRegistration(
          "commands.handler",
          "registerCommand",
          "commands",
          { command: normalizedCommand, action },
        )
      ) {
        return;
      }
      const description = definition.description?.trim();
      const intent = definition.intent?.trim();
      const examples = normalizeOptionalStringArrayField(
        "registerCommand definition.examples",
        definition.examples,
      );
      const failureHints = normalizeOptionalStringArrayField(
        "registerCommand definition.failure_hints",
        definition.failure_hints,
      );
      const argumentsDefinition = normalizeCommandDefinitionArguments(
        definition.arguments,
      );

      if (definition.flags !== undefined) {
        assertExtensionCapability(
          this.#loadedExtension,
          "schema",
          "registerCommand flags",
        );
        if (
          this.allowRegistration(
            "schema.flags",
            "registerCommand flags",
            "schema",
          )
        ) {
          validateFlagDefinitions(definition.flags);
          this.#registrationRegistry.flags.push({
            layer: this.#loadedExtension.layer,
            name: this.#loadedExtension.name,
            target_command: normalizedCommand,
            flags: normalizeRegistrationRecordList(
              "registerCommand definition.flags",
              definition.flags,
            ),
          });
        }
      }

      const registration: RegisteredExtensionCommandDefinition = {
        layer: this.#loadedExtension.layer,
        name: this.#loadedExtension.name,
        source_package: this.#loadedExtension.source_package,
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
      this.#registrationRegistry.commands.push(registration);
    } catch (error: unknown) {
      const reason = formatUnknownError(error);
      const trace = this.registerCommandTrace(
        "definition",
        normalizedCommand,
        "{ name: string; run: (context) => unknown; action?: string; arguments?: object[]; flags?: object[]; }",
        definition,
        reason,
      );
      throw createRegistrationValidationError(
        `registerCommand definition metadata invalid (command="${normalizedCommand}", registration_index=${trace.registration_index}): ${reason}`,
        trace,
      );
    }
    this.#commandRegistry.handlers.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      command: normalizedCommand,
      run: resolvedHandler,
    });
  }

  public registerCommand(
    commandOrDefinition: string | CommandDefinition,
    override?: CommandOverride,
  ): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "commands",
      "registerCommand",
    );
    if (typeof commandOrDefinition === "string") {
      this.registerCommandOverride(commandOrDefinition, override);
      return;
    }
    this.registerCommandDefinition(commandOrDefinition);
  }

  public registerParser(command: string, override: ParserOverride): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "parser",
      "registerParser",
    );
    if (
      !this.allowRegistration("parser.override", "registerParser", "parser")
    ) {
      return;
    }
    const normalizedCommand = normalizeCommandName(
      assertNonEmptyString("registerParser command", command),
    );
    assertFunctionHandler("registerParser override", override);
    this.#parserRegistry.overrides.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      command: normalizedCommand,
      run: override,
    });
  }

  public registerPreflight(override: PreflightOverride): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "preflight",
      "registerPreflight",
    );
    if (
      !this.allowRegistration(
        "preflight.override",
        "registerPreflight",
        "preflight",
      )
    ) {
      return;
    }
    assertFunctionHandler("registerPreflight override", override);
    this.#preflightRegistry.overrides.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      run: override,
    });
  }

  public registerService(
    service: ExtensionServiceName,
    override: ServiceOverride,
  ): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "services",
      "registerService",
    );
    const normalizedService = String(service).trim().toLowerCase();
    if (!isExtensionServiceName(normalizedService)) {
      throw new TypeError(
        `registerService service must be one of: ${KNOWN_EXTENSION_SERVICE_NAMES.join(", ")}`,
      );
    }
    if (
      !this.allowRegistration(
        "services.override",
        "registerService",
        "services",
        { service: normalizedService },
      )
    ) {
      return;
    }
    assertFunctionHandler("registerService override", override);
    this.#serviceRegistry.overrides.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      service: normalizedService as ExtensionServiceName,
      run: override,
    });
  }

  public registerRenderer(
    format: OutputRendererFormat,
    renderer: RendererOverride,
  ): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "renderers",
      "registerRenderer",
    );
    if (
      !this.allowRegistration(
        "renderers.override",
        "registerRenderer",
        "renderers",
      )
    ) {
      return;
    }
    if (typeof renderer !== "function") {
      throw new TypeError("registerRenderer requires a renderer function");
    }
    const normalizedFormat = String(format).trim().toLowerCase();
    if (!isOutputRendererFormat(normalizedFormat)) {
      throw new Error(
        `registerRenderer format must be toon|json, received: ${String(format)}`,
      );
    }
    this.#rendererRegistry.overrides.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      format: normalizedFormat,
      run: renderer,
    });
  }

  public registerFlags(targetCommand: string, flags: FlagDefinition[]): void {
    assertExtensionCapability(this.#loadedExtension, "schema", "registerFlags");
    if (!this.allowRegistration("schema.flags", "registerFlags", "schema")) {
      return;
    }
    const normalizedTargetCommand = normalizeCommandName(
      assertNonEmptyString("registerFlags targetCommand", targetCommand),
    );
    validateFlagDefinitions(flags);
    const normalizedFlags = normalizeRegistrationRecordList(
      "registerFlags flags",
      flags,
    );
    if (normalizedFlags.length === 0) {
      throw new TypeError(
        "registerFlags requires at least one flag definition",
      );
    }
    this.#registrationRegistry.flags.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      target_command: normalizedTargetCommand,
      flags: normalizedFlags,
    });
  }

  public registerItemFields(fields: SchemaFieldDefinition[]): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "schema",
      "registerItemFields",
    );
    if (
      !this.allowRegistration(
        "schema.itemfields",
        "registerItemFields",
        "schema",
      )
    ) {
      return;
    }
    validateItemFieldDefinitions(fields);
    const normalizedFields = normalizeRegistrationRecordList(
      "registerItemFields fields",
      fields,
    ) as SchemaFieldDefinition[];
    if (normalizedFields.length === 0) {
      throw new TypeError(
        "registerItemFields requires at least one field definition",
      );
    }
    this.#registrationRegistry.item_fields.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      fields: normalizedFields,
    });
  }

  public registerItemTypes(types: SchemaItemTypeDefinition[]): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "schema",
      "registerItemTypes",
    );
    if (
      !this.allowRegistration("schema.itemtypes", "registerItemTypes", "schema")
    ) {
      return;
    }
    validateItemTypeDefinitions(types);
    const normalizedTypes = normalizeRegistrationRecordList(
      "registerItemTypes types",
      types,
    ) as SchemaItemTypeDefinition[];
    if (normalizedTypes.length === 0) {
      throw new TypeError(
        "registerItemTypes requires at least one type definition",
      );
    }
    this.#registrationRegistry.item_types.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      types: normalizedTypes,
    });
  }

  public registerMigration(definition: SchemaMigrationDefinition): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "schema",
      "registerMigration",
    );
    if (
      !this.allowRegistration(
        "schema.migrations",
        "registerMigration",
        "schema",
      )
    ) {
      return;
    }
    validateMigrationDefinition(definition);
    const runtimeDefinition = normalizeRuntimeRegistrationRecord(
      "registerMigration definition",
      definition,
    );
    this.#registrationRegistry.migrations.push(
      attachRuntimeDefinition(
        {
          layer: this.#loadedExtension.layer,
          name: this.#loadedExtension.name,
          definition: normalizeRegistrationRecord(
            "registerMigration definition",
            definition,
          ),
        },
        runtimeDefinition,
      ) as RegisteredExtensionSchemaMigrationDefinition,
    );
  }

  public registerProfile(profile: ProjectProfileRegistrationInput): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "schema",
      "registerProfile",
    );
    if (
      !this.allowRegistration("schema.profiles", "registerProfile", "schema")
    ) {
      return;
    }
    // Snapshot first, then validate and default the snapshot: cloning resolves
    // any getters once into plain data decoupled from the caller's object, so
    // validation and storage operate on the same value — a getter cannot present
    // one value to validation and another to the registry. Defaults are applied
    // only after validation, so an invalid type is rejected, not silently coerced.
    const snapshot = cloneRuntimeRegistrationValue(profile);
    validateProjectProfileDefinition(snapshot);
    this.#registrationRegistry.profiles.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      profile: applyProjectProfileDefaults(snapshot as Record<string, unknown>),
    });
  }

  private applyImportExportCommandMetadata(
    method: "registerImporter" | "registerExporter",
    commandPath: string,
    options: ImportExportRegistrationOptions | undefined,
  ): void {
    if (options === undefined) {
      return;
    }
    if (
      typeof options !== "object" ||
      options === null ||
      Array.isArray(options)
    ) {
      throw new TypeError(`${method} options must be an object when provided`);
    }
    assertOptionalStringField(`${method} options.action`, options.action);
    assertOptionalStringField(
      `${method} options.description`,
      options.description,
    );
    assertOptionalStringField(`${method} options.intent`, options.intent);
    const action = resolveCommandDefinitionAction(commandPath, options.action);
    const examples = normalizeOptionalStringArrayField(
      `${method} options.examples`,
      options.examples,
    );
    const failureHints = normalizeOptionalStringArrayField(
      `${method} options.failure_hints`,
      options.failure_hints,
    );
    const argumentsDefinition = normalizeCommandDefinitionArguments(
      options.arguments,
    );

    if (options.flags !== undefined) {
      assertExtensionCapability(
        this.#loadedExtension,
        "schema",
        `${method} options.flags`,
      );
      // Route metadata flags through the same surface-policy gate as registerFlags so
      // enforce-mode policies blocking schema.flags are honored even when importers are allowed.
      if (
        this.allowRegistration(
          "schema.flags",
          `${method} options.flags`,
          "schema",
        )
      ) {
        validateFlagDefinitions(options.flags);
        this.#registrationRegistry.flags.push({
          layer: this.#loadedExtension.layer,
          name: this.#loadedExtension.name,
          target_command: commandPath,
          flags: normalizeRegistrationRecordList(
            `${method} options.flags`,
            options.flags,
          ),
        });
      }
    }

    const registration: RegisteredExtensionCommandDefinition = {
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      source_package: this.#loadedExtension.source_package,
      command: commandPath,
      action,
      examples,
      failure_hints: failureHints,
      arguments: argumentsDefinition,
    };
    const description = options.description?.trim();
    if (description) {
      registration.description = description;
    }
    const intent = options.intent?.trim();
    if (intent) {
      registration.intent = intent;
    }
    this.#registrationRegistry.commands.push(registration);
  }

  public registerImporter(
    name: string,
    importer: Importer,
    options?: ImportExportRegistrationOptions,
  ): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "importers",
      "registerImporter",
    );
    if (
      !this.allowRegistration(
        "importers.importer",
        "registerImporter",
        "importers",
      )
    ) {
      return;
    }
    const normalizedName = normalizeRegistrationName(
      assertNonEmptyString("registerImporter name", name),
    );
    assertFunctionHandler("registerImporter importer", importer);
    const commandPath = toRegistrationCommandPath(normalizedName, "import");
    // Validate and register optional command metadata before mutating the registry
    // so an invalid options object leaves no partial importer registration.
    this.applyImportExportCommandMetadata(
      "registerImporter",
      commandPath,
      options,
    );
    this.#registrationRegistry.importers.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      importer: normalizedName,
    });
    this.#commandRegistry.handlers.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
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
  }

  public registerExporter(
    name: string,
    exporter: Exporter,
    options?: ImportExportRegistrationOptions,
  ): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "importers",
      "registerExporter",
    );
    if (
      !this.allowRegistration(
        "importers.exporter",
        "registerExporter",
        "importers",
      )
    ) {
      return;
    }
    const normalizedName = normalizeRegistrationName(
      assertNonEmptyString("registerExporter name", name),
    );
    assertFunctionHandler("registerExporter exporter", exporter);
    const commandPath = toRegistrationCommandPath(normalizedName, "export");
    // Validate and register optional command metadata before mutating the registry
    // so an invalid options object leaves no partial exporter registration.
    this.applyImportExportCommandMetadata(
      "registerExporter",
      commandPath,
      options,
    );
    this.#registrationRegistry.exporters.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      exporter: normalizedName,
    });
    this.#commandRegistry.handlers.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
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
  }

  public registerSearchProvider(provider: SearchProviderDefinition): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "search",
      "registerSearchProvider",
    );
    if (
      !this.allowRegistration(
        "search.provider",
        "registerSearchProvider",
        "search",
      )
    ) {
      return;
    }
    const runtimeDefinition = normalizeRuntimeRegistrationRecord(
      "registerSearchProvider provider",
      provider,
    );
    this.#registrationRegistry.search_providers.push(
      attachRuntimeDefinition(
        {
          layer: this.#loadedExtension.layer,
          name: this.#loadedExtension.name,
          definition: normalizeRegistrationRecord(
            "registerSearchProvider provider",
            provider,
          ),
        },
        runtimeDefinition,
      ) as RegisteredExtensionSearchProvider,
    );
  }

  public registerVectorStoreAdapter(
    adapter: VectorStoreAdapterDefinition,
  ): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "search",
      "registerVectorStoreAdapter",
    );
    if (
      !this.allowRegistration(
        "search.vectorstore",
        "registerVectorStoreAdapter",
        "search",
      )
    ) {
      return;
    }
    const runtimeDefinition = normalizeRuntimeRegistrationRecord(
      "registerVectorStoreAdapter adapter",
      adapter,
    );
    this.#registrationRegistry.vector_store_adapters.push(
      attachRuntimeDefinition(
        {
          layer: this.#loadedExtension.layer,
          name: this.#loadedExtension.name,
          definition: normalizeRegistrationRecord(
            "registerVectorStoreAdapter adapter",
            adapter,
          ),
        },
        runtimeDefinition,
      ) as RegisteredExtensionVectorStoreAdapter,
    );
  }

  private registerBeforeCommand(hook: BeforeCommandHook): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "hooks",
      "api.hooks.beforeCommand",
    );
    if (
      !this.allowRegistration(
        "hooks.beforecommand",
        "api.hooks.beforeCommand",
        "hooks",
      )
    ) {
      return;
    }
    assertHookHandler("beforeCommand", hook);
    this.#hookRegistry.beforeCommand.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      run: hook,
    });
  }

  private registerAfterCommand(hook: AfterCommandHook): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "hooks",
      "api.hooks.afterCommand",
    );
    if (
      !this.allowRegistration(
        "hooks.aftercommand",
        "api.hooks.afterCommand",
        "hooks",
      )
    ) {
      return;
    }
    assertHookHandler("afterCommand", hook);
    this.#hookRegistry.afterCommand.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      run: hook,
    });
  }

  private registerOnWrite(hook: OnWriteHook): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "hooks",
      "api.hooks.onWrite",
    );
    if (
      !this.allowRegistration("hooks.onwrite", "api.hooks.onWrite", "hooks")
    ) {
      return;
    }
    assertHookHandler("onWrite", hook);
    this.#hookRegistry.onWrite.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      run: hook,
    });
  }

  private registerOnRead(hook: OnReadHook): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "hooks",
      "api.hooks.onRead",
    );
    if (!this.allowRegistration("hooks.onread", "api.hooks.onRead", "hooks")) {
      return;
    }
    assertHookHandler("onRead", hook);
    this.#hookRegistry.onRead.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      run: hook,
    });
  }

  private registerOnIndex(hook: OnIndexHook): void {
    assertExtensionCapability(
      this.#loadedExtension,
      "hooks",
      "api.hooks.onIndex",
    );
    if (
      !this.allowRegistration("hooks.onindex", "api.hooks.onIndex", "hooks")
    ) {
      return;
    }
    assertHookHandler("onIndex", hook);
    this.#hookRegistry.onIndex.push({
      layer: this.#loadedExtension.layer,
      name: this.#loadedExtension.name,
      run: hook,
    });
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
  return new ExtensionApiRegistrar(
    extension,
    hooks,
    commands,
    parsers,
    preflight,
    services,
    renderers,
    registrations,
    activationWarnings,
    policy,
  );
}

function getRegistrationCounts(
  registrations: ExtensionRegistrationRegistry,
): ExtensionRegistrationCounts {
  const commandCount = registrations.commands.length;
  const flagCount = registrations.flags.reduce(
    (total, entry) => total + entry.flags.length,
    0,
  );
  const itemFieldCount = registrations.item_fields.reduce(
    (total, entry) => total + entry.fields.length,
    0,
  );
  const itemTypeCount = registrations.item_types.reduce(
    (total, entry) => total + entry.types.length,
    0,
  );
  return {
    commands: commandCount,
    flags: flagCount,
    item_fields: itemFieldCount,
    item_types: itemTypeCount,
    migrations: registrations.migrations.length,
    profiles: registrations.profiles.length,
    importers: registrations.importers.length,
    exporters: registrations.exporters.length,
    search_providers: registrations.search_providers.length,
    vector_store_adapters: registrations.vector_store_adapters.length,
  };
}

function collectCommandCollisionWarnings(
  commands: ExtensionCommandRegistry,
): string[] {
  const warnings: string[] = [];
  const collectByCommand = <
    TEntry extends { layer: ExtensionLayer; name: string; command: string },
  >(
    entries: TEntry[],
    codePrefix: string,
  ): void => {
    const grouped = new Map<string, TEntry[]>();
    for (const entry of entries) {
      const bucket = grouped.get(entry.command) ?? [];
      bucket.push(entry);
      grouped.set(entry.command, bucket);
    }
    for (const command of [...grouped.keys()].sort((left, right) =>
      left.localeCompare(right),
    )) {
      const bucket = grouped.get(command)!;
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

  const handlerCommands = new Set(
    commands.handlers.map((entry) => entry.command),
  );
  const overlapCommands = [
    ...new Set(commands.overrides.map((entry) => entry.command)),
  ].filter((command) => handlerCommands.has(command));
  overlapCommands.sort((left, right) => left.localeCompare(right));
  for (const command of overlapCommands) {
    const handlers = commands.handlers.filter(
      (entry) => entry.command === command,
    );
    const overrides = commands.overrides.filter(
      (entry) => entry.command === command,
    );
    for (const override of overrides) {
      for (const handler of handlers) {
        warnings.push(
          `extension_command_override_handler_overlap:${command}:${override.layer}:${override.name}:${handler.layer}:${handler.name}`,
        );
      }
    }
  }

  return warnings;
}

function collectRendererCollisionWarnings(
  renderers: ExtensionRendererRegistry,
): string[] {
  const grouped = new Map<
    OutputRendererFormat,
    RegisteredExtensionRendererOverride[]
  >();
  for (const entry of renderers.overrides) {
    const bucket = grouped.get(entry.format) ?? [];
    bucket.push(entry);
    grouped.set(entry.format, bucket);
  }
  const warnings: string[] = [];
  for (const format of [...grouped.keys()].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const bucket = grouped.get(format)!;
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

function collectParserCollisionWarnings(
  parsers: ExtensionParserRegistry,
): string[] {
  const warnings: string[] = [];
  const grouped = new Map<string, RegisteredExtensionParserOverride[]>();
  for (const entry of parsers.overrides) {
    const bucket = grouped.get(entry.command) ?? [];
    bucket.push(entry);
    grouped.set(entry.command, bucket);
  }
  for (const command of [...grouped.keys()].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const bucket = grouped.get(command)!;
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

function collectPreflightCollisionWarnings(
  preflight: ExtensionPreflightRegistry,
): string[] {
  if (preflight.overrides.length <= 1) {
    return [];
  }
  const winner = preflight.overrides[preflight.overrides.length - 1];
  return preflight.overrides
    .slice(0, -1)
    .map(
      (displaced) =>
        `extension_preflight_override_collision:${winner.layer}:${winner.name}:${displaced.layer}:${displaced.name}`,
    );
}

// Services whose runtime semantics are chain/fall-through (each override gets a chance);
// for those, registering multiple overrides is by design, not a collision.
const CHAINED_SERVICE_NAMES: ReadonlySet<ExtensionServiceName> =
  new Set<ExtensionServiceName>(["output_format"]);

function collectServiceCollisionWarnings(
  services: ExtensionServiceRegistry,
): string[] {
  const warnings: string[] = [];
  const grouped = new Map<
    ExtensionServiceName,
    RegisteredExtensionServiceOverride[]
  >();
  for (const entry of services.overrides) {
    const bucket = grouped.get(entry.service) ?? [];
    bucket.push(entry);
    grouped.set(entry.service, bucket);
  }
  for (const service of [...grouped.keys()].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const bucket = grouped.get(service)!;
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

/** Implements activate extensions for the public runtime surface of this module. */
export async function activateExtensions(
  loadResult: ExtensionLoadResult,
): Promise<ExtensionActivationResult> {
  const policy = hydrateExtensionPolicy(
    loadResult.policy ?? DEFAULT_EXTENSION_POLICY,
  );
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
      warnings.push(
        `extension_activate_failed:${extension.layer}:${extension.name}`,
      );
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

/** Public contract for test only loader, shared by SDK and presentation-layer consumers. */
export const _testOnlyLoader = {
  assertFlagValueTypeAndDefault,
  assertOptionalStringField,
  compareComparableVersions,
  collectCommandCollisionWarnings,
  collectParserCollisionWarnings,
  collectRendererCollisionWarnings,
  collectServiceCollisionWarnings,
  createExtensionApi,
  createRegistrationValidationError,
  evaluatePmMaxVersionCompatibility,
  evaluatePmMinVersionCompatibility,
  extractRegistrationValidationTrace,
  fingerprintPath,
  getRegistrationCounts,
  normalizeCommandDefinitionArguments,
  normalizeExtensionDeactivateTimeout,
  normalizeOptionalStringArrayField,
  normalizeRegistrationRecord,
  normalizeRegistrationRecordList,
  normalizeRuntimeRegistrationRecord,
  parseComparableVersion,
  parseManifest,
  readCurrentPmCliVersion,
  readManagedExtensionSourcePackages,
  resolveExtensionImportHref,
  resolveCurrentPmCliVersion,
  resolveCommandDefinitionAction,
  sanitizeRegistrationValue,
  validateItemFieldDefinitions,
  resetCurrentPmCliVersionCacheForTest: () => {
    currentPmCliVersionPromise = null;
  },
};
