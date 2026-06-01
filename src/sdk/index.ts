import {
  EXTENSION_CAPABILITY_CONTRACT,
  EXTENSION_CAPABILITY_CONTRACT_VERSION,
  EXTENSION_CAPABILITY_LEGACY_ALIASES,
  KNOWN_EXTENSION_CAPABILITIES,
  KNOWN_EXTENSION_POLICY_MODES,
  KNOWN_EXTENSION_POLICY_SURFACES,
  KNOWN_EXTENSION_SANDBOX_PROFILES,
  KNOWN_EXTENSION_TRUST_MODES,
  type ExtensionApi,
  type ExtensionManifest,
} from "../core/extensions/loader.js";
export {
  PM_PACKAGE_CONVENTIONAL_RESOURCE_ROOTS,
  PM_PACKAGE_RESOURCE_KINDS,
  collectPackageExtensionDirectories,
  readPmPackageManifest,
  type PmPackageCatalogLinkMap,
  type PmPackageCatalogMediaMap,
  type PmPackageCatalogMetadata,
  type PmPackageManifest,
  type PmPackageResourceKind,
  type PmPackageResourceMap,
} from "../core/packages/manifest.js";
export * from "./cli-contracts.js";
export * from "./runtime.js";
export {
  assertRegisteredCommandContract,
  assertRegisteredExporter,
  assertRegisteredHook,
  assertRegisteredImporter,
  assertRegisteredSearchProvider,
  type RegisteredCommandContractAssertion,
  type RegisteredCommandContractExpectation,
  type RegisteredExporterExpectation,
  type RegisteredHookExpectation,
  type RegisteredHookKind,
  type RegisteredImporterExpectation,
  type RegisteredSearchProviderExpectation,
} from "./testing.js";

/**
 * Canonical extension capability names accepted by pm.
 *
 * Extension manifests should declare one or more of these values in
 * `capabilities`.
 */
export const EXTENSION_CAPABILITIES = KNOWN_EXTENSION_CAPABILITIES;
export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

/**
 * Canonical extension governance policy modes and registration surfaces.
 */
export const EXTENSION_POLICY_MODES = KNOWN_EXTENSION_POLICY_MODES;
export const EXTENSION_POLICY_SURFACES = KNOWN_EXTENSION_POLICY_SURFACES;
export const EXTENSION_TRUST_MODES = KNOWN_EXTENSION_TRUST_MODES;
export const EXTENSION_SANDBOX_PROFILES = KNOWN_EXTENSION_SANDBOX_PROFILES;
export type ExtensionPolicyMode = (typeof EXTENSION_POLICY_MODES)[number];
export type ExtensionPolicySurface = (typeof EXTENSION_POLICY_SURFACES)[number];
export type ExtensionTrustMode = (typeof EXTENSION_TRUST_MODES)[number];
export type ExtensionSandboxProfile = (typeof EXTENSION_SANDBOX_PROFILES)[number];

/**
 * Versioned capability contract metadata emitted by runtime diagnostics.
 */
export { EXTENSION_CAPABILITY_CONTRACT, EXTENSION_CAPABILITY_CONTRACT_VERSION, EXTENSION_CAPABILITY_LEGACY_ALIASES };

export interface ExtensionModule {
  /**
   * Optional in-module metadata mirror.
   *
   * The authoritative manifest remains on-disk `manifest.json`; this field is
   * useful when authors want colocated metadata for tooling/tests.
   */
  manifest?: ExtensionManifest;
  activate(api: ExtensionApi): void | Promise<void>;
}

/**
 * Typed identity helper for extension module exports.
 *
 * Use as:
 * `export default defineExtension({ activate(api) { ... } })`
 */
export function defineExtension<TModule extends ExtensionModule>(module: TModule): TModule {
  return module;
}

export type {
  AfterCommandHook,
  AfterCommandHookContext,
  BeforeCommandHook,
  BeforeCommandHookContext,
  CommandDefinition,
  ExtensionCommandArgumentDefinition,
  CommandHandler,
  CommandHandlerContext,
  CommandOverride,
  CommandOverrideContext,
  ExtensionServiceName,
  Exporter,
  ExtensionActivationResult,
  ExtensionApi,
  ExtensionCommandRegistry,
  ExtensionDiagnostic,
  ExtensionDiscoveryResult,
  ExtensionHookRegistry,
  ExtensionLoadResult,
  ExtensionManifest,
  ExtensionManifestEngines,
  ExtensionGovernancePolicy,
  ExtensionPolicyOverride,
  ExtensionProvenanceMetadata,
  ExtensionRuntimePermissionDeclaration,
  ExtensionSearchMode,
  ExtensionParserRegistry,
  ExtensionPreflightRegistry,
  ExtensionRegistrationRegistry,
  ExtensionRendererRegistry,
  ExtensionServiceRegistry,
  FlagValueType,
  FlagDefinition,
  ImportExportContext,
  ImportExportRegistrationOptions,
  Importer,
  OnIndexHook,
  OnIndexHookContext,
  OnReadHook,
  OnReadHookContext,
  OnWriteHook,
  OnWriteHookContext,
  OutputRendererFormat,
  ParserOverride,
  ParserOverrideContext,
  ParserOverrideDelta,
  PreflightOverride,
  PreflightOverrideContext,
  PreflightOverrideDelta,
  PreflightRuntimeDecision,
  RegisteredExtensionExporter,
  RegisteredExtensionHook,
  RegisteredExtensionImporter,
  RegisteredExtensionSearchProvider,
  RendererOverride,
  RendererOverrideContext,
  SchemaFieldDefinition,
  SchemaItemTypeCommandOptionPolicyDefinition,
  SchemaItemTypeOptionDefinition,
  SchemaItemTypeDefinition,
  SchemaMigrationDefinition,
  SchemaMigrationRunContext,
  SchemaMigrationRunner,
  SearchProviderEmbedBatchContext,
  SearchProviderEmbedContext,
  SearchProviderDefinition,
  SearchProviderHit,
  SearchProviderQueryContext,
  SearchProviderQueryResult,
  ServiceOverride,
  ServiceOverrideContext,
  VectorStoreAdapterDefinition,
  VectorStoreDeleteContext,
  VectorStoreQueryContext,
  VectorStoreQueryHit,
  VectorStoreUpsertContext,
  VectorStoreUpsertPoint,
} from "../core/extensions/loader.js";

export type { GlobalOptions } from "../core/shared/command-types.js";
export type { ItemDocument, ItemFrontMatter, ItemStatus, ItemType, PmSettings } from "../types/index.js";
