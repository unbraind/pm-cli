import type { ExtensionApi, ExtensionManifest } from "../core/extensions/loader.js";
export * from "./cli-contracts.js";

export const EXTENSION_CAPABILITIES = [
  "commands",
  "renderers",
  "hooks",
  "schema",
  "importers",
  "search",
  "parser",
  "preflight",
  "services",
] as const;
export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

export interface ExtensionModule {
  manifest?: ExtensionManifest;
  activate(api: ExtensionApi): void | Promise<void>;
}

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
