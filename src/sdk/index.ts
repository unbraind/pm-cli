import {
  EXTENSION_CAPABILITY_CONTRACT,
  EXTENSION_CAPABILITY_CONTRACT_VERSION,
  EXTENSION_CAPABILITY_LEGACY_ALIASES,
  KNOWN_EXTENSION_CAPABILITIES,
  type ExtensionApi,
  type ExtensionManifest,
} from "../core/extensions/loader.js";
export * from "./cli-contracts.js";

/**
 * Canonical extension capability names accepted by pm.
 *
 * Extension manifests should declare one or more of these values in
 * `capabilities`.
 */
export const EXTENSION_CAPABILITIES = KNOWN_EXTENSION_CAPABILITIES;
export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

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
  ExtensionLoadResult,
  ExtensionManifest,
  ExtensionParserRegistry,
  ExtensionPreflightRegistry,
  ExtensionRegistrationRegistry,
  ExtensionRendererRegistry,
  ExtensionServiceRegistry,
  FlagDefinition,
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
  RendererOverride,
  RendererOverrideContext,
  SchemaFieldDefinition,
  SchemaItemTypeDefinition,
  SchemaMigrationDefinition,
  SearchProviderDefinition,
  ServiceOverride,
  ServiceOverrideContext,
  VectorStoreAdapterDefinition,
} from "../core/extensions/loader.js";

export type { GlobalOptions } from "../core/shared/command-types.js";
export type { PmSettings } from "../types/index.js";
