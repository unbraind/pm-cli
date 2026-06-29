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
import type { GlobalOptions } from "../shared/command-types.js";
import { asRecordLoose } from "../shared/primitives.js";
import { flattenFlagListValue, isFlagDefaultValueCoercible, resolveFlagValueKind } from "./flag-value-types.js";
import { KNOWN_ITEM_FIELD_TYPES, normalizeItemFieldType, suggestKnownItemFieldType } from "./item-field-types.js";
import {
  compareComparableVersions,
  evaluatePmMaxVersionBound,
  evaluatePmMinVersionBound,
  parseComparableVersion,
  type PmVersionBoundEvaluation,
} from "./version-compat.js";
import type { PmSettings } from "../../types/index.js";
import type { ProjectProfileDefinition, ProjectProfileRegistrationInput } from "../profile/profile-presets.js";
// Cohesive helper groups now live in sibling modules. They are imported for the
// discovery/activation code that stays here and re-exported below so existing
// import sites (sdk/index.ts, commands/extension.ts, health.ts, tests, …) keep
// importing everything from "./loader.js" unchanged.
import {
  normalizeNames,
  isKnownExtensionCapability,
  collectUnknownExtensionCapabilities,
  resolveLegacyExtensionCapabilityAlias,
  normalizeManifestCapabilities,
  suggestKnownExtensionCapability,
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
  cloneCommandOptionsSnapshot,
  cloneGlobalOptionsSnapshot,
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
  type ExtensionPolicyMode,
  type ExtensionPolicySurface,
  type ExtensionSandboxProfile,
  type ExtensionGovernancePolicy,
  type ExtensionTrustMode,
  type PmMaxVersionExceededMode,
  type ExtensionLayer,
  type ExtensionStatus,
  type ExtensionManifest,
  type ExtensionManifestEngines,
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
  type ImportExportRegistrationOptions,
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
let currentPmCliVersionPromise: Promise<string | null> | null = null;

/* Types now in extension-types.ts - re-exported via `export * from "./extension-types.js"` above */

const DEFAULT_EXTENSION_POLICY: ExtensionGovernancePolicy = Object.freeze(createDefaultExtensionGovernancePolicy());

let extensionReloadEpoch = 0;

/**
 * Implements next extension reload token for the public runtime surface of this module.
 */
export function nextExtensionReloadToken(seed = Date.now()): string {
  extensionReloadEpoch += 1;
  return `${extensionReloadEpoch}-${seed}`;
}

function parseOptionalManifestString(candidate: Record<string, unknown>, field: string): string | null | undefined {
  const value = candidate[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

function parseManifestEngines(value: unknown): ExtensionManifestEngines | null | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const enginesRecord = asRecordLoose(value);
  if (!enginesRecord) {
    return null;
  }
  const engines: ExtensionManifestEngines = {};
  for (const key of Object.keys(enginesRecord).sort((left, right) => left.localeCompare(right))) {
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

  let activation: ExtensionManifest["activation"] | undefined;
  if ("activation" in candidate && candidate.activation !== undefined && candidate.activation !== null) {
    const activationRecord = asRecordLoose(candidate.activation);
    if (!activationRecord) {
      return null;
    }
    const rawCommands = activationRecord.commands;
    if (rawCommands !== undefined && rawCommands !== null) {
      if (!Array.isArray(rawCommands) || rawCommands.some((value) => typeof value !== "string")) {
        return null;
      }
      const commands = [
        ...new Set(
          rawCommands
            .map((value) => normalizeCommandName(value))
            .filter((value) => value.length > 0),
        ),
      ].sort((left, right) => left.localeCompare(right));
      if (commands.length > 0) {
        activation = {
          commands,
        };
      }
    }
  }

  return {
    name: candidate.name.trim(),
    version: candidate.version.trim(),
    entry: candidate.entry.trim(),
    priority,
    manifest_version: manifestVersion,
    pm_min_version: pmMinVersion,
    pm_max_version: pmMaxVersion,
    engines,
    trusted,
    provenance,
    sandbox_profile: sandboxProfile,
    permissions,
    activation,
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

/**
 * Implements resolve extension roots for the public runtime surface of this module.
 */
export function resolveExtensionRoots(pmRoot: string, cwd = process.cwd()): { global: string; project: string } {
  return {
    global: path.join(resolveGlobalPmRoot(cwd), "extensions"),
    project: path.join(pmRoot, "extensions"),
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
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

async function readManagedExtensionSourcePackages(extensionsRoot: string): Promise<Map<string, string>> {
  const packages = new Map<string, string>();
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(extensionsRoot, ".managed-extensions.json"), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { entries?: unknown }).entries)) {
      return packages;
    }
    for (const entry of (parsed as { entries: unknown[] }).entries) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const record = entry as { directory?: unknown; name?: unknown; source?: { package?: unknown } };
      const sourcePackage = normalizeManagedSourcePackage(record.source?.package);
      if (!sourcePackage) {
        continue;
      }
      if (typeof record.directory === "string" && record.directory.trim().length > 0) {
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
  pmMaxVersionExceededMode: PmMaxVersionExceededMode,
): Promise<ExtensionLayerScanResult> {
  const diagnostics: ExtensionDiagnostic[] = [];
  const warnings: string[] = [];
  const candidates: ExtensionCandidate[] = [];
  const directories = await listExtensionDirectories(extensionsRoot);
  const managedSourcePackages = await readManagedExtensionSourcePackages(extensionsRoot);

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
  const pmVersionCompatibility = await evaluatePmMinVersionCompatibility(layer, manifest);
  if (pmVersionCompatibility.warning) {
    extensionWarnings.push(pmVersionCompatibility.warning);
  }
  const pmMaxVersionCompatibility = await evaluatePmMaxVersionCompatibility(layer, manifest, pmMaxVersionExceededMode);
  if (pmMaxVersionCompatibility.warning) {
    extensionWarnings.push(pmMaxVersionCompatibility.warning);
  }
  const extensionReady =
    entryWithinDirectory &&
    entryExists &&
    pmVersionCompatibility.allowed &&
    pmMaxVersionCompatibility.allowed;
  const sourcePackage =
    managedSourcePackages.get(`directory:${directory}`) ?? managedSourcePackages.get(`name:${manifest.name}`);

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


/**
 * Implements discover extensions for the public runtime surface of this module.
 */
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
  const globalScan = await scanExtensionLayer("global", roots.global, enabled, disabled, policy.pmMaxVersionExceededMode.global);
  const projectScan = await scanExtensionLayer("project", roots.project, enabled, disabled, policy.pmMaxVersionExceededMode.project);
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

async function readCurrentPmCliVersion(): Promise<string | null> {
  try {
    const packageRoot = resolvePmPackageRootFromModule(import.meta.url, ["../../.."]);
    const raw = await fs.readFile(path.join(packageRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim().length > 0 ? parsed.version.trim() : null;
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
  const evaluation = evaluatePmMinVersionBound(manifest.pm_min_version, await resolveCurrentPmCliVersion());
  const warning = formatPmVersionCompatibilityWarning(layer, manifest, evaluation);
  return warning ? { allowed: evaluation.allowed, warning } : { allowed: evaluation.allowed };
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
  const warning = formatPmVersionCompatibilityWarning(layer, manifest, evaluation);
  return warning ? { allowed: evaluation.allowed, warning } : { allowed: evaluation.allowed };
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

/**
 * Implements load extensions for the public runtime surface of this module.
 */
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
const DEFAULT_EXTENSION_DEACTIVATE_TIMEOUT_MS = 5_000;
const MAX_EXTENSION_DEACTIVATE_TIMEOUT_MS = 2_147_483_647;

function toActivatableExtension(source: Record<string, unknown>): ActivatableExtension {
  // Bind to `source` so a module/default-export authored with methods (or a class
  // instance) keeps its `this` across both lifecycle calls — `activate` is a
  // method call on a fresh object and `deactivate` is invoked bare, so without
  // binding the two would see different (or undefined) `this`.
  const activate = source.activate as ActivatableExtension["activate"];
  const activatable: ActivatableExtension = {
    activate: activate.bind(source),
  };
  if (typeof source.deactivate === "function") {
    const deactivate = source.deactivate as NonNullable<ActivatableExtension["deactivate"]>;
    activatable.deactivate = deactivate.bind(source);
  }
  return activatable;
}

function resolveActivatableExtension(module: unknown): ActivatableExtension | null {
  const moduleRecord = asRecordLoose(module);
  if (!moduleRecord) {
    return null;
  }

  if (typeof moduleRecord.activate === "function") {
    return toActivatableExtension(moduleRecord);
  }

  const defaultExport = asRecordLoose(moduleRecord.default);
  if (defaultExport && typeof defaultExport.activate === "function") {
    return toActivatableExtension(defaultExport);
  }

  return null;
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
  const timeoutMs = normalizeExtensionDeactivateTimeout(options?.deactivate_timeout_ms);
  const failedActivationKeys = new Set(
    (activationResult?.failed ?? []).map((entry) => `${entry.layer}:${entry.name}`),
  );
  const targets: Array<{ extension: LoadedExtension; deactivate: () => void | Promise<void> }> = [];
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
        return { ok: false as const, layer: extension.layer, name: extension.name, error: formatUnknownError(error) };
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
    warnings.push(`extension_deactivate_failed:${outcome.layer}:${outcome.name}`);
    failed.push({ layer: outcome.layer, name: outcome.name, error: outcome.error });
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
  return Math.min(MAX_EXTENSION_DEACTIVATE_TIMEOUT_MS, Math.max(1, Math.floor(rawTimeout)));
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
          reject(new Error(`extension deactivate timed out after ${timeoutMs}ms`));
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

function isFlagDefaultScalar(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function assertOptionalFlagDefaultField(name: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      if (!isFlagDefaultScalar(item)) {
        throw new TypeError(`${name}[${index}] must be a string, number, or boolean`);
      }
    }
    return;
  }
  if (!isFlagDefaultScalar(value)) {
    throw new TypeError(`${name} must be a string, number, or boolean, or an array of these when provided`);
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
      definition.description = record.description.trim();
    }
    normalized.push(definition);
  }

  const variadicIndexes = normalized
    .map((argument, index) => (argument.variadic ? index : -1))
    .filter((index) => index >= 0);
  if (variadicIndexes.length > 1) {
    throw new TypeError("registerCommand definition.arguments supports at most one variadic argument");
  }
  if (variadicIndexes.length === 1 && variadicIndexes[0] !== normalized.length - 1) {
    throw new TypeError("registerCommand definition.arguments variadic argument must be the final argument");
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
    assertOptionalBooleanField(`registerFlags flags[${index}].list`, record.list);
    assertOptionalFlagDefaultField(`registerFlags flags[${index}].default`, record.default);
    if (Array.isArray(record.default) && record.list !== true) {
      throw new TypeError(`registerFlags flags[${index}].default cannot be an array unless list is true.`);
    }
    assertFlagValueTypeAndDefault(`registerFlags flags[${index}]`, record);
  }
}

/**
 * Reject a declared `value_type`/`type` that is not a known flag value kind, and
 * a `default` whose value(s) would not cleanly coerce under that kind — so the
 * typed-flag contract is enforced at registration instead of silently leaving
 * an untyped value to surface at use time.
 */
function assertFlagValueTypeAndDefault(label: string, record: Record<string, unknown>): void {
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
  const defaults = record.list === true ? flattenFlagListValue(record.default) : [record.default];
  for (const [defaultIndex, defaultValue] of defaults.entries()) {
    if (!isFlagDefaultValueCoercible(defaultValue as string | number | boolean, kind)) {
      const suffix = defaults.length > 1 ? `default[${defaultIndex}]` : "default";
      throw new TypeError(`${label}.${suffix} (${JSON.stringify(defaultValue)}) is not coercible to ${kind}.`);
    }
  }
}

function validateItemFieldDefinitions(fields: unknown): void {
  if (!Array.isArray(fields)) {
    throw new TypeError("registerItemFields fields requires an array of object definitions");
  }
  for (const [index, raw] of fields.entries()) {
    const record = asRegistrationRecord(`registerItemFields fields[${index}]`, raw);
    assertNonEmptyString(`registerItemFields fields[${index}].name`, record.name);
    const fieldType = assertNonEmptyString(`registerItemFields fields[${index}].type`, record.type);
    if (normalizeItemFieldType(fieldType) === null) {
      const suggestion = suggestKnownItemFieldType(fieldType);
      const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
      throw new TypeError(
        `registerItemFields fields[${index}].type "${fieldType}" is not a known field type ` +
          `(expected one of: ${KNOWN_ITEM_FIELD_TYPES.join(", ")}).${hint}`,
      );
    }
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

function validateProjectProfileDefinition(profile: unknown): void {
  const record = asRegistrationRecord("registerProfile profile", profile);
  assertNonEmptyString("registerProfile profile.name", record.name);
  assertNonEmptyString("registerProfile profile.title", record.title);
  if (record.summary !== undefined && typeof record.summary !== "string") {
    throw new TypeError("registerProfile profile.summary must be a string when provided");
  }
  for (const dimension of PROJECT_PROFILE_DIMENSIONS) {
    const value = record[dimension];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value)) {
      throw new TypeError(`registerProfile profile.${dimension} must be an array when provided`);
    }
    // Each dimension entry must be a non-null object: a primitive or null entry
    // (e.g. `statuses: [null]`, `types: [42]`) survives an array-only check but
    // crashes the profile planner and `pm profile show` when they read `entry.id`
    // / `entry.key` / `entry.type` later. Reject it at the registration boundary.
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new TypeError(`registerProfile profile.${dimension}[${index}] must be an object`);
      }
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
function applyProjectProfileDefaults(profile: Record<string, unknown>): ProjectProfileDefinition {
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
  const selfIdentity: ExtensionSelfIdentity = Object.freeze({
    name: extension.name,
    layer: extension.layer,
    version: extension.version,
    capabilities: Object.freeze(
      (extension.capabilities ?? []).filter((capability): capability is ExtensionCapability =>
        (KNOWN_EXTENSION_CAPABILITIES as readonly string[]).includes(capability),
      ),
    ) as readonly ExtensionCapability[],
    pm_min_version: extension.pm_min_version,
    pm_max_version: extension.pm_max_version,
    source_package: extension.source_package,
  });
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
        source_package: extension.source_package,
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
      const reason = formatUnknownError(error);
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
      throw new TypeError(`registerService service must be one of: ${KNOWN_EXTENSION_SERVICE_NAMES.join(", ")}`);
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
  const registerProfile = (profile: ProjectProfileRegistrationInput): void => {
    assertExtensionCapability(extension, "schema", "registerProfile");
    if (!allowRegistration("schema.profiles", "registerProfile", "schema")) {
      return;
    }
    // Snapshot first, then validate and default the snapshot: cloning resolves
    // any getters once into plain data decoupled from the caller's object, so
    // validation and storage operate on the same value — a getter cannot present
    // one value to validation and another to the registry. Defaults are applied
    // only after validation, so an invalid type is rejected, not silently coerced.
    const snapshot = cloneRuntimeRegistrationValue(profile);
    validateProjectProfileDefinition(snapshot);
    registrations.profiles.push({
      layer: extension.layer,
      name: extension.name,
      profile: applyProjectProfileDefaults(snapshot as Record<string, unknown>),
    });
  };
  const applyImportExportCommandMetadata = (
    method: "registerImporter" | "registerExporter",
    commandPath: string,
    options: ImportExportRegistrationOptions | undefined,
  ): void => {
    if (options === undefined) {
      return;
    }
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError(`${method} options must be an object when provided`);
    }
    assertOptionalStringField(`${method} options.action`, options.action);
    assertOptionalStringField(`${method} options.description`, options.description);
    assertOptionalStringField(`${method} options.intent`, options.intent);
    const action = resolveCommandDefinitionAction(commandPath, options.action);
    const examples = normalizeOptionalStringArrayField(`${method} options.examples`, options.examples);
    const failureHints = normalizeOptionalStringArrayField(`${method} options.failure_hints`, options.failure_hints);
    const argumentsDefinition = normalizeCommandDefinitionArguments(options.arguments);

    if (options.flags !== undefined) {
      assertExtensionCapability(extension, "schema", `${method} options.flags`);
      // Route metadata flags through the same surface-policy gate as registerFlags so
      // enforce-mode policies blocking schema.flags are honored even when importers are allowed.
      if (allowRegistration("schema.flags", `${method} options.flags`, "schema")) {
        validateFlagDefinitions(options.flags);
        registrations.flags.push({
          layer: extension.layer,
          name: extension.name,
          target_command: commandPath,
          flags: normalizeRegistrationRecordList(`${method} options.flags`, options.flags),
        });
      }
    }

    const registration: RegisteredExtensionCommandDefinition = {
      layer: extension.layer,
      name: extension.name,
      source_package: extension.source_package,
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
    registrations.commands.push(registration);
  };
  const registerImporter = (name: string, importer: Importer, options?: ImportExportRegistrationOptions): void => {
    assertExtensionCapability(extension, "importers", "registerImporter");
    if (!allowRegistration("importers.importer", "registerImporter", "importers")) {
      return;
    }
    const normalizedName = normalizeRegistrationName(assertNonEmptyString("registerImporter name", name));
    assertFunctionHandler("registerImporter importer", importer);
    const commandPath = toRegistrationCommandPath(normalizedName, "import");
    // Validate and register optional command metadata before mutating the registry
    // so an invalid options object leaves no partial importer registration.
    applyImportExportCommandMetadata("registerImporter", commandPath, options);
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
  const registerExporter = (name: string, exporter: Exporter, options?: ImportExportRegistrationOptions): void => {
    assertExtensionCapability(extension, "importers", "registerExporter");
    if (!allowRegistration("importers.exporter", "registerExporter", "importers")) {
      return;
    }
    const normalizedName = normalizeRegistrationName(assertNonEmptyString("registerExporter name", name));
    assertFunctionHandler("registerExporter exporter", exporter);
    const commandPath = toRegistrationCommandPath(normalizedName, "export");
    // Validate and register optional command metadata before mutating the registry
    // so an invalid options object leaves no partial exporter registration.
    applyImportExportCommandMetadata("registerExporter", commandPath, options);
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
    extension: selfIdentity,
    registerCommand,
    registerParser,
    registerPreflight,
    registerService,
    registerFlags,
    registerItemFields,
    registerItemTypes,
    registerMigration,
    registerProfile,
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
    profiles: registrations.profiles.length,
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

  const handlerCommands = new Set(commands.handlers.map((entry) => entry.command));
  const overlapCommands = [...new Set(commands.overrides.map((entry) => entry.command))].filter((command) =>
    handlerCommands.has(command),
  );
  overlapCommands.sort((left, right) => left.localeCompare(right));
  for (const command of overlapCommands) {
    const handlers = commands.handlers.filter((entry) => entry.command === command);
    const overrides = commands.overrides.filter((entry) => entry.command === command);
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

function collectRendererCollisionWarnings(renderers: ExtensionRendererRegistry): string[] {
  const grouped = new Map<OutputRendererFormat, RegisteredExtensionRendererOverride[]>();
  for (const entry of renderers.overrides) {
    const bucket = grouped.get(entry.format) ?? [];
    bucket.push(entry);
    grouped.set(entry.format, bucket);
  }
  const warnings: string[] = [];
  for (const format of [...grouped.keys()].sort((left, right) => left.localeCompare(right))) {
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

function collectParserCollisionWarnings(parsers: ExtensionParserRegistry): string[] {
  const warnings: string[] = [];
  const grouped = new Map<string, RegisteredExtensionParserOverride[]>();
  for (const entry of parsers.overrides) {
    const bucket = grouped.get(entry.command) ?? [];
    bucket.push(entry);
    grouped.set(entry.command, bucket);
  }
  for (const command of [...grouped.keys()].sort((left, right) => left.localeCompare(right))) {
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

/**
 * Implements activate extensions for the public runtime surface of this module.
 */
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
