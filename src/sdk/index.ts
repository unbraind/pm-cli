/**
 * @module sdk/index
 *
 * Defines public SDK APIs and package-author helpers for Index.
 */
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
  assertExtensionCapabilityUsage,
  assertExtensionDeactivated,
  assertPackageManifest,
  assertRegisteredCommandContract,
  assertRegisteredCommandOverride,
  assertRegisteredExporter,
  assertRegisteredFlags,
  assertRegisteredHook,
  assertRegisteredImporter,
  assertRegisteredItemField,
  assertRegisteredItemType,
  assertRegisteredMigration,
  assertRegisteredParserOverride,
  assertRegisteredPreflightOverride,
  assertRegisteredRendererOverride,
  assertRegisteredSearchProvider,
  assertRegisteredServiceOverride,
  assertRegisteredVectorStoreAdapter,
  activateExtensionForTest,
  createExtensionTestHarness,
  deactivateExtensionForTest,
  runRegisteredCommandForTest,
  runRegisteredCommandOverrideForTest,
  runRegisteredExporterForTest,
  runRegisteredHookForTest,
  runRegisteredImporterForTest,
  runRegisteredMigrationForTest,
  runRegisteredParserOverrideForTest,
  runRegisteredPreflightOverrideForTest,
  runRegisteredRendererOverrideForTest,
  runRegisteredSearchProviderForTest,
  runRegisteredServiceOverrideForTest,
  runRegisteredVectorStoreAdapterForTest,
  type ActivateExtensionForTestOptions,
  type DeactivateExtensionForTestOptions,
  type RunRegisteredCommandForTestOptions,
  type RunRegisteredExporterForTestOptions,
  type RunRegisteredHookForTestOptions,
  type RunRegisteredImporterForTestOptions,
  type RunRegisteredMigrationForTestOptions,
  type RunRegisteredSearchProviderForTestOptions,
  type RunRegisteredVectorStoreAdapterForTestOptions,
  type SearchProviderOperationContexts,
  type SearchProviderOperationResults,
  type VectorStoreAdapterOperationContexts,
  type VectorStoreAdapterOperationResults,
  type ExtensionCapabilityUsageAssertion,
  type ExtensionCapabilityUsageExpectation,
  type ExtensionDeactivationExpectation,
  type ExtensionTestHarness,
  type PackageManifestExpectation,
  type PackageManifestResourceExpectation,
  type RegisteredCommandContractAssertion,
  type RegisteredCommandContractExpectation,
  type RegisteredCommandOverrideExpectation,
  type RegisteredExporterExpectation,
  type RegisteredFlagsExpectation,
  type RegisteredHookExpectation,
  type RegisteredHookKind,
  type RegisteredImporterExpectation,
  type RegisteredItemFieldAssertion,
  type RegisteredItemFieldExpectation,
  type RegisteredItemTypeAssertion,
  type RegisteredItemTypeExpectation,
  type RegisteredMigrationExpectation,
  type RegisteredParserOverrideExpectation,
  type RegisteredPreflightOverrideExpectation,
  type RegisteredRendererOverrideExpectation,
  type RegisteredSearchProviderExpectation,
  type RegisteredServiceOverrideExpectation,
  type RegisteredVectorStoreAdapterExpectation,
} from "./testing.js";

/**
 * Canonical extension capability names accepted by pm.
 *
 * Extension manifests should declare one or more of these values in
 * `capabilities`.
 */
export const EXTENSION_CAPABILITIES = KNOWN_EXTENSION_CAPABILITIES;
/**
 * Restricts extension capability values accepted by command, SDK, and storage contracts.
 */
export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

/**
 * Canonical extension governance policy modes and registration surfaces.
 */
export const EXTENSION_POLICY_MODES = KNOWN_EXTENSION_POLICY_MODES;
export const EXTENSION_POLICY_SURFACES = KNOWN_EXTENSION_POLICY_SURFACES;
export const EXTENSION_TRUST_MODES = KNOWN_EXTENSION_TRUST_MODES;
export const EXTENSION_SANDBOX_PROFILES = KNOWN_EXTENSION_SANDBOX_PROFILES;
/**
 * Restricts extension policy mode values accepted by command, SDK, and storage contracts.
 */
export type ExtensionPolicyMode = (typeof EXTENSION_POLICY_MODES)[number];
/**
 * Restricts extension policy surface values accepted by command, SDK, and storage contracts.
 */
export type ExtensionPolicySurface = (typeof EXTENSION_POLICY_SURFACES)[number];
/**
 * Restricts extension trust mode values accepted by command, SDK, and storage contracts.
 */
export type ExtensionTrustMode = (typeof EXTENSION_TRUST_MODES)[number];
/**
 * Restricts extension sandbox profile values accepted by command, SDK, and storage contracts.
 */
export type ExtensionSandboxProfile = (typeof EXTENSION_SANDBOX_PROFILES)[number];

/**
 * Versioned capability contract metadata emitted by runtime diagnostics.
 */
export { EXTENSION_CAPABILITY_CONTRACT, EXTENSION_CAPABILITY_CONTRACT_VERSION, EXTENSION_CAPABILITY_LEGACY_ALIASES };

/**
 * Least-privilege capability reconciliation helpers: map declared capabilities
 * against the registration surfaces a package actually exercises at activation.
 */
export {
  EXTENSION_CAPABILITY_REGISTRATION_SURFACES,
  collectUsedExtensionCapabilities,
  reconcileExtensionCapabilityUsage,
  type CollectUsedExtensionCapabilitiesOptions,
  type ExtensionCapabilityUsageReconciliation,
} from "../core/extensions/capability-usage.js";

/**
 * Documents the extension module payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionModule {
  /**
   * Optional in-module metadata mirror.
   *
   * The authoritative manifest remains on-disk `manifest.json`; this field is
   * useful when authors want colocated metadata for tooling/tests.
   */
  manifest?: ExtensionManifest;
  activate(api: ExtensionApi): void | Promise<void>;
  /**
   * Optional teardown lifecycle hook (VS Code-style `deactivate`). Invoked by
   * the host on shutdown/reload to release resources opened during `activate`.
   */
  deactivate?(): void | Promise<void>;
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
  AfterCommandAffectedItem,
  AfterCommandHook,
  AfterCommandHookContext,
  BeforeCommandHook,
  BeforeCommandHookContext,
  CommandDefinition,
  ExtensionCommandArgumentDefinition,
  CommandHandler,
  CommandHandlerContext,
  CommandHandlerResult,
  CommandOverride,
  CommandOverrideContext,
  ExtensionServiceName,
  Exporter,
  ExtensionActivationResult,
  ExtensionApi,
  ExtensionCommandRegistry,
  ExtensionDeactivationFailure,
  ExtensionDeactivationOptions,
  ExtensionDeactivationResult,
  ExtensionDiagnostic,
  ExtensionDiscoveryResult,
  ExtensionHookRegistry,
  ExtensionSelfIdentity,
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
  RegisteredExtensionFlagDefinitions,
  RegisteredExtensionHook,
  RegisteredExtensionImporter,
  RegisteredExtensionSchemaMigrationDefinition,
  RegisteredExtensionSearchProvider,
  RegisteredExtensionServiceOverride,
  RegisteredExtensionVectorStoreAdapter,
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
